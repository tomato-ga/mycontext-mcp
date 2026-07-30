import { describe, expect, it, vi } from "vitest";

import {
  API_REQUEST_TIMEOUT_MS,
  CloudflareInvariantError,
  assertLegacyMatchesPrivateBaseline,
  assertPostdeployState,
  assertPredeployStateUnchanged,
  assertTrafficDeploymentState,
  assertUploadPreservedInvariants,
  assertUploadReadyState,
  captureCloudflareState,
  findUniqueTargetVersionByTagAndMessage,
  listAllTargetVersions,
  parsePrivateBaseline,
  serializeCanonicalPrivateBaseline,
  validateCloudflareEnvironment
} from "../scripts/verify-cloudflare.mjs";

const accountId = "a".repeat(32);
const legacyDeploymentId = "10000000-0000-4000-8000-000000000001";
const legacyVersionId = "20000000-0000-4000-8000-000000000001";
const targetDeploymentId = "30000000-0000-4000-8000-000000000001";
const targetVersionId = "40000000-0000-4000-8000-000000000001";
const secondTargetVersionId = "40000000-0000-4000-8000-000000000002";
const legacyKvIds = ["1".repeat(32), "2".repeat(32)];
const targetKvIds = ["3".repeat(32), "4".repeat(32)];
const legacyEtag = "legacy-script-etag";
const targetEtag = "target-script-etag";
const legacyVersionEtag = "legacy-version-etag";
const targetVersionEtag = "target-version-etag";

const environment = {
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "private-api-token",
  CLOUDFLARE_API_KEY: "",
  CLOUDFLARE_EMAIL: ""
};

const migrationBaseline = {
  legacy: {
    worker: {
      name: "mycontext-mcp",
      kvNamespaceIds: legacyKvIds,
      kvNamespaces: [
        { binding: "OAUTH_KV", title: "legacy oauth", id: legacyKvIds[0] },
        { binding: "AUTH_KV", title: "legacy auth", id: legacyKvIds[1] }
      ]
    }
  },
  target: {
    workerName: "mycontext-mcp-v2",
    kvNamespaces: [
      { binding: "OAUTH_KV", title: "v2 oauth", id: targetKvIds[0] },
      { binding: "AUTH_KV", title: "v2 auth", id: targetKvIds[1] }
    ]
  }
};

const wranglerConfig = {
  name: "mycontext-mcp-v2",
  workers_dev: true,
  preview_urls: false,
  observability: {
    logs: {
      enabled: true,
      head_sampling_rate: 1,
      invocation_logs: true
    },
    traces: {
      enabled: true,
      head_sampling_rate: 0.2
    }
  },
  kv_namespaces: [
    { binding: "OAUTH_KV", id: targetKvIds[0] },
    { binding: "AUTH_KV", id: targetKvIds[1] }
  ]
};

const remoteObservability = {
  enabled: true,
  logs: {
    enabled: true,
    head_sampling_rate: 1,
    invocation_logs: true,
    destinations: []
  },
  traces: {
    enabled: true,
    head_sampling_rate: 0.2,
    destinations: []
  }
};

const legacyObservability = {
  enabled: true,
  logs: {
    enabled: true,
    invocation_logs: true
  },
  traces: null
};

function privateBaseline(overrides = {}) {
  return {
    schemaVersion: 1,
    accountId,
    legacy: {
      scriptEtag: legacyEtag,
      activeDeployment: {
        id: legacyDeploymentId,
        versions: [
          {
            versionId: legacyVersionId,
            percentage: 100,
            etag: legacyVersionEtag
          }
        ]
      },
      crons: ["17 4 * * *"],
      observability: legacyObservability,
      subdomain: { enabled: true, previewsEnabled: false },
      ...overrides
    }
  };
}

function success(result, resultInfo) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo })
    })
  };
}

function deployment(id, versionId) {
  return {
    id,
    versions: [{ version_id: versionId, percentage: 100 }]
  };
}

function makeRemote({
  targetExists = true,
  legacyScriptCount = 1,
  targetScriptCount = targetExists ? 1 : 0,
  legacyActive = deployment(legacyDeploymentId, legacyVersionId),
  targetActive = null,
  legacyCrons = ["17 4 * * *"],
  targetCrons = [],
  kvRecords,
  targetObservability = remoteObservability,
  targetSubdomain = { enabled: true, previews_enabled: false }
} = {}) {
  const calls = [];
  const namespaces =
    kvRecords ??
    [
      { id: legacyKvIds[0], title: "legacy oauth" },
      { id: legacyKvIds[1], title: "legacy auth" },
      { id: targetKvIds[0], title: "v2 oauth" },
      { id: targetKvIds[1], title: "v2 auth" },
      { id: "f".repeat(32), title: "unrelated" }
    ];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    if (pathname.endsWith("/workers/scripts")) {
      return success([
        ...Array.from({ length: legacyScriptCount }, () => ({
          id: "mycontext-mcp",
          etag: legacyEtag
        })),
        ...Array.from({ length: targetScriptCount }, () => ({
          id: "mycontext-mcp-v2",
          etag: targetEtag
        }))
      ]);
    }
    if (pathname.endsWith("/storage/kv/namespaces")) {
      return success(namespaces, {
        page: 1,
        per_page: 1000,
        total_count: namespaces.length
      });
    }
    const role = pathname.includes("/mycontext-mcp-v2/") ? "target" : "legacy";
    if (pathname.endsWith("/deployments")) {
      const active = role === "target" ? targetActive : legacyActive;
      return success({ deployments: active === null ? [] : [active] });
    }
    if (pathname.endsWith("/schedules")) {
      const crons = role === "target" ? targetCrons : legacyCrons;
      return success({ schedules: crons.map((cron) => ({ cron })) });
    }
    if (pathname.endsWith("/settings")) {
      return success({
        observability:
          role === "target" ? targetObservability : legacyObservability
      });
    }
      if (pathname.endsWith("/subdomain")) {
      return success(
        role === "target"
          ? targetSubdomain
          : { enabled: true, previews_enabled: false }
      );
    }
    if (pathname.includes("/versions/")) {
      return success({
        resources: {
          script: {
            etag: role === "target" ? targetVersionEtag : legacyVersionEtag
          }
        }
      });
    }
    throw new Error("unexpected endpoint");
  });
  return { calls, fetchImpl };
}

async function capture(options = {}) {
  const remote = makeRemote(options);
  const state = await captureCloudflareState({
    privateBaseline: privateBaseline(),
    migrationBaseline,
    wranglerConfig,
    environment,
    fetchImpl: remote.fetchImpl,
    allowTargetMissing: options.targetExists === false
  });
  return { ...remote, state };
}

describe("private baseline and Cloudflare authentication", () => {
  it("canonicalizes the private baseline for hashing", () => {
    const parsed = parsePrivateBaseline(
      privateBaseline({
        crons: ["z", "a"],
        activeDeployment: {
          id: legacyDeploymentId,
          versions: [
            {
              versionId: secondTargetVersionId,
              percentage: 25,
              etag: "second-version-etag"
            },
            {
              versionId: legacyVersionId,
              percentage: 75,
              etag: legacyVersionEtag
            }
          ]
        }
      })
    );
    expect(parsed.legacy.crons).toEqual(["a", "z"]);
    expect(parsed.legacy.activeDeployment.versions.map((entry) => entry.versionId)).toEqual([
      legacyVersionId,
      secondTargetVersionId
    ]);
    expect(serializeCanonicalPrivateBaseline(parsed)).toBe(JSON.stringify(parsed));
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects a baseline without the exact legacy script ETag", () => {
    const invalid = privateBaseline();
    delete invalid.legacy.scriptEtag;
    expect(() => parsePrivateBaseline(invalid)).toThrow(CloudflareInvariantError);
    const missingVersionEtag = privateBaseline();
    delete missingVersionEtag.legacy.activeDeployment.versions[0].etag;
    expect(() => parsePrivateBaseline(missingVersionEtag)).toThrow(
      CloudflareInvariantError
    );
  });

  it("requires legacy observability and subdomain evidence", () => {
    const missingObservability = privateBaseline();
    delete missingObservability.legacy.observability;
    expect(() => parsePrivateBaseline(missingObservability)).toThrow(
      CloudflareInvariantError
    );

    const missingSubdomain = privateBaseline();
    delete missingSubdomain.legacy.subdomain;
    expect(() => parsePrivateBaseline(missingSubdomain)).toThrow(
      CloudflareInvariantError
    );
  });

  it("supports API-token authentication without placing credentials in URLs", async () => {
    const { calls } = await capture();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.headers.Authorization).toBe("Bearer private-api-token");
      expect(call.url).not.toContain("private-api-token");
    }
  });

  it("supports global API key plus email authentication", async () => {
    const remote = makeRemote();
    await captureCloudflareState({
      privateBaseline: privateBaseline(),
      migrationBaseline,
      wranglerConfig,
      environment: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_API_KEY: "private-global-key",
        CLOUDFLARE_EMAIL: "operator@example.invalid"
      },
      fetchImpl: remote.fetchImpl
    });
    expect(remote.calls[0].init.headers).toMatchObject({
      "X-Auth-Key": "private-global-key",
      "X-Auth-Email": "operator@example.invalid"
    });
    expect(remote.calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("rejects account mismatch, ambiguous auth, and partial global-key auth", () => {
    expect(() =>
      validateCloudflareEnvironment(
        { ...environment, CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) },
        { expectedAccountId: accountId }
      )
    ).toThrow(/account does not match/);
    expect(() =>
      validateCloudflareEnvironment({
        ...environment,
        CLOUDFLARE_API_KEY: "key",
        CLOUDFLARE_EMAIL: "operator@example.invalid"
      })
    ).toThrow(/exactly one/);
    expect(() =>
      validateCloudflareEnvironment({
        ...environment,
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_API_KEY: "key",
        CLOUDFLARE_EMAIL: ""
      })
    ).toThrow(/both key and email/);
  });
});

describe("remote capture invariants", () => {
  it("captures only canonical required state and allows a missing pre-upload target", async () => {
    const { state } = await capture({ targetExists: false });
    expect(state.target).toEqual({
      exists: false,
      scriptEtag: null,
      activeDeployment: null,
      crons: [],
      observability: null,
      subdomain: null
    });
    expect(state.kvNamespaces).toHaveLength(4);
    expect(state.legacy).not.toHaveProperty("author_email");
    expect(() =>
      assertUploadReadyState(state, {
        privateBaseline: privateBaseline(),
        wranglerConfig
      })
    ).not.toThrow();
  });

  it("rejects missing and duplicate Workers", async () => {
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({ legacyScriptCount: 0 }).fetchImpl,
        allowTargetMissing: true
      })
    ).rejects.toThrow(/legacy Worker is missing/);
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({ targetScriptCount: 2 }).fetchImpl
      })
    ).rejects.toThrow(/target Worker is duplicated/);
  });

  it("rejects missing and duplicate required KV namespaces", async () => {
    const baseRecords = [
      { id: legacyKvIds[0], title: "legacy oauth" },
      { id: legacyKvIds[1], title: "legacy auth" },
      { id: targetKvIds[0], title: "v2 oauth" },
      { id: targetKvIds[1], title: "v2 auth" }
    ];
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({ kvRecords: baseRecords.slice(1) }).fetchImpl
      })
    ).rejects.toThrow(/missing or duplicated/);
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({
          kvRecords: baseRecords.map((record, index) =>
            index === 0 ? { ...record, title: "renamed namespace" } : record
          )
        }).fetchImpl
      })
    ).rejects.toThrow(/title changed/);
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({
          kvRecords: [...baseRecords, baseRecords[0]]
        }).fetchImpl
      })
    ).rejects.toThrow(/missing or duplicated/);
  });

  it("rejects changed legacy code, traffic, and cron state", async () => {
    const good = (await capture()).state;
    const changedCode = structuredClone(good);
    changedCode.legacy.scriptEtag = "changed-etag";
    expect(() =>
      assertLegacyMatchesPrivateBaseline(changedCode, privateBaseline())
    ).toThrow(/script changed/);
    const changedTraffic = structuredClone(good);
    changedTraffic.legacy.activeDeployment.id =
      "10000000-0000-4000-8000-000000000002";
    expect(() =>
      assertLegacyMatchesPrivateBaseline(changedTraffic, privateBaseline())
    ).toThrow(/deployment changed/);
    const changedCron = structuredClone(good);
    changedCron.legacy.crons = [];
    expect(() =>
      assertLegacyMatchesPrivateBaseline(changedCron, privateBaseline())
    ).toThrow(/cron triggers changed/);
  });

  it("rejects target observability drift and enabled previews", async () => {
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({
          targetObservability: {
            ...remoteObservability,
            traces: { ...remoteObservability.traces, enabled: false }
          }
        }).fetchImpl
      })
    ).rejects.toThrow(/observability/);
    await expect(
      captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl: makeRemote({
          targetSubdomain: { enabled: true, previews_enabled: true }
        }).fetchImpl
      })
    ).rejects.toThrow(/subdomain|preview/);
  });

  it("redacts API bodies and credentials from errors", async () => {
    const rawSecret = "raw-body-private-secret";
    const token = "request-private-token";
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        errors: [{ message: rawSecret }]
      })
    }));
    let thrown;
    try {
      await captureCloudflareState({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment: { ...environment, CLOUDFLARE_API_TOKEN: token },
        fetchImpl
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CloudflareInvariantError);
    expect(thrown.message).not.toContain(rawSecret);
    expect(thrown.message).not.toContain(token);
    expect(thrown.message).not.toContain(accountId);
  });
});

describe("phase assertions", () => {
  it("allows target creation during upload while preserving traffic and cron state", async () => {
    const before = (await capture({ targetExists: false })).state;
    const after = (await capture({ targetExists: true })).state;
    expect(() =>
      assertUploadPreservedInvariants(before, after, {
        privateBaseline: privateBaseline(),
        wranglerConfig
      })
    ).not.toThrow();
    expect(() =>
      assertUploadPreservedInvariants(before, before, {
        privateBaseline: privateBaseline(),
        wranglerConfig
      })
    ).toThrow(/not present after upload/);
  });

  it("detects any changed target predeploy state", async () => {
    const saved = (await capture()).state;
    const changed = structuredClone(saved);
    changed.target.scriptEtag = "different-target-etag";
    expect(() =>
      assertPredeployStateUnchanged(changed, saved, {
        privateBaseline: privateBaseline(),
        wranglerConfig
      })
    ).toThrow(/predeploy Cloudflare state changed/);
  });

  it("accepts traffic deployment before cron and final deployment after cron", async () => {
    const predeployState = (await capture()).state;
    const trafficState = (
      await capture({
        targetActive: deployment(targetDeploymentId, targetVersionId)
      })
    ).state;
    expect(() =>
      assertTrafficDeploymentState(trafficState, {
        privateBaseline: privateBaseline(),
        wranglerConfig,
        selectedVersionId: targetVersionId,
        selectedVersionEtag: targetVersionEtag,
        predeployState
      })
    ).not.toThrow();
    const finalState = (
      await capture({
        targetActive: deployment(targetDeploymentId, targetVersionId),
        targetCrons: ["17 4 * * *"]
      })
    ).state;
    expect(() =>
      assertPostdeployState(finalState, {
        privateBaseline: privateBaseline(),
        wranglerConfig,
        selectedVersionId: targetVersionId,
        selectedVersionEtag: targetVersionEtag,
        predeployState
      })
    ).not.toThrow();
  });

  it("rejects split traffic, the wrong version, early cron, and wrong final cron", async () => {
    const predeployState = (await capture()).state;
    const split = (
      await capture({
        targetActive: {
          id: targetDeploymentId,
          versions: [
            { version_id: targetVersionId, percentage: 50 },
            { version_id: secondTargetVersionId, percentage: 50 }
          ]
        }
      })
    ).state;
    expect(() =>
      assertTrafficDeploymentState(split, {
        privateBaseline: privateBaseline(),
        wranglerConfig,
        selectedVersionId: targetVersionId,
        selectedVersionEtag: targetVersionEtag,
        predeployState
      })
    ).toThrow(/selected version/);
    const earlyCron = (
      await capture({
        targetActive: deployment(targetDeploymentId, targetVersionId),
        targetCrons: ["17 4 * * *"]
      })
    ).state;
    expect(() =>
      assertTrafficDeploymentState(earlyCron, {
        privateBaseline: privateBaseline(),
        wranglerConfig,
        selectedVersionId: targetVersionId,
        selectedVersionEtag: targetVersionEtag,
        predeployState
      })
    ).toThrow(/cron changed/);
    const wrongFinal = (
      await capture({
        targetActive: deployment(targetDeploymentId, secondTargetVersionId),
        targetCrons: ["0 0 * * *"]
      })
    ).state;
    expect(() =>
      assertPostdeployState(wrongFinal, {
        privateBaseline: privateBaseline(),
        wranglerConfig,
        selectedVersionId: targetVersionId,
        selectedVersionEtag: targetVersionEtag,
        predeployState
      })
    ).toThrow();
  });
});

describe("complete target version enumeration", () => {
  function versionsFetch() {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/workers/workers")) {
        const page = Number(parsed.searchParams.get("page"));
        return success(
          page === 1
            ? [{ id: "9".repeat(32), name: "mycontext-mcp-v2" }]
            : [{ id: "8".repeat(32), name: "unrelated" }],
          { page, per_page: 100, total_pages: 2, total_count: 2 }
        );
      }
      if (parsed.pathname.endsWith("/versions")) {
        const page = Number(parsed.searchParams.get("page"));
        return success(
          page === 1
            ? [
                {
                  id: targetVersionId,
                  annotations: {
                    "workers/tag": "release-tag",
                    "workers/message": "release-message"
                  }
                }
              ]
            : [
                {
                  id: secondTargetVersionId,
                  annotations: {
                    "workers/tag": "older-tag",
                    "workers/message": "older-message"
                  },
                  etag: "etag-from-list"
                }
              ],
          { page, per_page: 100, total_pages: 2, total_count: 2 }
        );
      }
      if (parsed.pathname.includes(`/versions/${targetVersionId}`)) {
        return success({
          resources: { script: { etag: "etag-from-detail" } }
        });
      }
      throw new Error("unexpected endpoint");
    });
    return { calls, fetchImpl };
  }

  it("walks every Worker/version page, fills missing ETags, and finds one identity", async () => {
    const remote = versionsFetch();
    const versions = await listAllTargetVersions({
      privateBaseline: privateBaseline(),
      migrationBaseline,
      wranglerConfig,
      environment,
      fetchImpl: remote.fetchImpl
    });
    expect(versions).toEqual([
      {
        id: targetVersionId,
        tag: "release-tag",
        message: "release-message",
        etag: "etag-from-detail"
      },
      {
        id: secondTargetVersionId,
        tag: "older-tag",
        message: "older-message",
        etag: "etag-from-list"
      }
    ]);
    expect(
      findUniqueTargetVersionByTagAndMessage(versions, {
        tag: "release-tag",
        message: "release-message"
      })
    ).toMatchObject({ id: targetVersionId, etag: "etag-from-detail" });
    expect(remote.calls.every((call) => call.init.method === "GET")).toBe(true);
  });

  it("rejects absent and duplicate release identities", () => {
    const version = {
      id: targetVersionId,
      tag: "release-tag",
      message: "release-message",
      etag: "etag"
    };
    expect(() =>
      findUniqueTargetVersionByTagAndMessage([], {
        tag: "release-tag",
        message: "release-message"
      })
    ).toThrow(/not unique/);
    expect(() =>
      findUniqueTargetVersionByTagAndMessage([version, { ...version }], {
        tag: "release-tag",
        message: "release-message"
      })
    ).toThrow(/not unique/);
  });

  it.each([
    [
      "fetch",
      (_url, init, observeSignal) => {
        observeSignal(init.signal);
        return new Promise(() => {});
      }
    ],
    [
      "response body",
      async (_url, init, observeSignal) => {
        observeSignal(init.signal);
        return {
          ok: true,
          status: 200,
          json: () => new Promise(() => {})
        };
      }
    ]
  ])("bounds a never-resolving %s and aborts it without leaking details", async (
    _stage,
    implementation
  ) => {
    vi.useFakeTimers();
    try {
      let observedSignal;
      const fetchImpl = vi.fn((url, init) =>
        implementation(url, init, (signal) => {
          observedSignal = signal;
        })
      );
      const pending = listAllTargetVersions({
        privateBaseline: privateBaseline(),
        migrationBaseline,
        wranglerConfig,
        environment,
        fetchImpl,
        apiRequestTimeoutMs: 50
      });
      const observed = pending.then(
        () => new Error("Cloudflare API timeout test unexpectedly resolved"),
        (caught) => caught
      );
      await vi.advanceTimersByTimeAsync(50);
      const error = await observed;
      expect(error).toBeInstanceOf(CloudflareInvariantError);
      expect(error.message).toBe("beta Worker list request timed out");
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal.aborted).toBe(true);
      expect(API_REQUEST_TIMEOUT_MS).toBe(30_000);
      for (const sensitive of [accountId, environment.CLOUDFLARE_API_TOKEN]) {
        expect(error.message).not.toContain(sensitive);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
