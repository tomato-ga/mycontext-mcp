import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMMAND_TIMEOUT_MS,
  CRON_TRIGGER,
  EXPECTED_PNPM_VERSION,
  EXPECTED_WRANGLER_VERSION,
  REPOSITORY_ROOT,
  WORKER_DIRECTORY,
  WORKER_NAME,
  WRANGLER_CONFIG,
  buildDeployCommands,
  buildUploadCommand,
  createReleaseManifest,
  deriveReleaseIdentity,
  executeRelease,
  expectedVersionResourcesFromConfig,
  inspectManifestDestination,
  inspectManifestFile,
  inspectPrivateBaselineFile,
  inspectSecretsFile,
  parseCliArguments,
  parseSecretsJson,
  rejectExistingReleaseTag,
  reserveReleaseManifest,
  staticReleasePlan,
  validateManifestAgainstPreflight,
  validateReleaseEnvironment,
  validateVersionMetadata,
  validateVersionResources,
  writePendingReleaseReservation,
  writeReleaseManifest
} from "../scripts/release-version.mjs";

const requiredSecrets = {
  TIDB_DATABASE_URL: "mysql://example.invalid/database",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_ALLOWED_USER_ID: "12345"
};
const accountId = "1".repeat(32);
const headCommit = "a".repeat(40);
const legacySourceCommit = "d".repeat(40);
const legacyWorkerTree = "b".repeat(40);
const newWorkerTree = "c".repeat(40);
const lockContents = Buffer.from("frozen lock contents");
const lockSha256 = createHash("sha256").update(lockContents).digest("hex");
const runId = "12345678-1234-4abc-8def-1234567890ab";
const otherRunId = "22345678-1234-4abc-8def-1234567890ab";
const versionId = "32345678-1234-4abc-8def-1234567890ab";
const otherVersionId = "42345678-1234-4abc-8def-1234567890ab";
const legacyDeploymentId = "52345678-1234-4abc-8def-1234567890ab";
const legacyVersionId = "62345678-1234-4abc-8def-1234567890ab";
const etag = "candidate-etag";
const provenance = Object.freeze({
  headCommit,
  legacySourceCommit,
  legacyWorkerTree,
  newWorkerTree,
  lockSha256
});
const identity = deriveReleaseIdentity({ ...provenance, runId });
const privateBaseline = Object.freeze({
  schemaVersion: 1,
  accountId,
  legacy: {
    scriptEtag: "legacy-script-etag",
    activeDeployment: {
      id: legacyDeploymentId,
      versions: [
        {
          versionId: legacyVersionId,
          percentage: 100,
          etag: "legacy-version-etag"
        }
      ]
    },
    crons: [CRON_TRIGGER],
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        invocationLogs: true
      },
      traces: null
    },
    subdomain: {
      enabled: true,
      previewsEnabled: false
    }
  }
});
const canonicalPrivateBaseline = JSON.stringify(privateBaseline);
const legacyBaselineSha256 = createHash("sha256")
  .update(canonicalPrivateBaseline)
  .digest("hex");

const preState = Object.freeze({
  schemaVersion: 1,
  accountId,
  phase: "pre",
  target: { exists: false }
});
const postState = Object.freeze({
  schemaVersion: 1,
  accountId,
  phase: "post",
  target: { exists: true }
});
const trafficState = Object.freeze({
  schemaVersion: 1,
  accountId,
  phase: "traffic",
  target: { exists: true }
});
const finalState = Object.freeze({
  schemaVersion: 1,
  accountId,
  phase: "final",
  target: { exists: true }
});
const driftState = Object.freeze({
  schemaVersion: 1,
  accountId,
  phase: "drift",
  target: { exists: true }
});

function fakeBaseline() {
  return {
    provenanceStatus: "proven-byte-exact",
    legacy: {
      sourceCommit: legacySourceCommit,
      workerTree: legacyWorkerTree,
      bundle: { wranglerVersion: EXPECTED_WRANGLER_VERSION }
    },
    target: { workerName: WORKER_NAME }
  };
}

function wranglerConfig() {
  return {
    name: WORKER_NAME,
    compatibility_date: "2026-07-06",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    observability: {
      logs: { enabled: true, invocation_logs: true },
      traces: { enabled: true }
    },
    kv_namespaces: [
      { binding: "OAUTH_KV", id: "1".repeat(32) },
      { binding: "AUTH_KV", id: "2".repeat(32) }
    ]
  };
}

function fakePreflight() {
  return {
    accountId,
    baseline: fakeBaseline(),
    provenance,
    wranglerConfig: wranglerConfig(),
    expectedVersionResources: expectedVersionResourcesFromConfig(
      wranglerConfig()
    )
  };
}

function releaseManifest(overrides = {}) {
  return {
    ...createReleaseManifest({
      accountId,
      preflight: fakePreflight(),
      runId,
      versionId,
      etag,
      legacyBaselineSha256,
      privateBaseline,
      cloudflarePredeployState: postState
    }),
    ...overrides
  };
}

function apiVersion(overrides = {}) {
  return {
    id: versionId,
    tag: identity.tag,
    message: identity.message,
    etag,
    ...overrides
  };
}

function versionView(overrides = {}) {
  return {
    id: versionId,
    annotations: {
      "workers/tag": identity.tag,
      "workers/message": identity.message
    },
    resources: {
      bindings: [
        {
          name: "OAUTH_KV",
          type: "kv_namespace",
          namespace_id: "1".repeat(32)
        },
        {
          name: "AUTH_KV",
          type: "kv_namespace",
          namespace_id: "2".repeat(32)
        },
        ...Object.keys(requiredSecrets).map((name) => ({
          name,
          type: "secret_text"
        }))
      ],
      script: { etag, handlers: ["fetch", "scheduled"] },
      script_runtime: {
        compatibility_date: "2026-07-06",
        compatibility_flags: ["nodejs_compat"]
      }
    },
    ...overrides
  };
}

function assertPhase(state, expected, label) {
  if (state?.phase !== expected) {
    throw new Error(`${label} mismatch`);
  }
}

function cloudflareMocks({ captureStates, versionLists }) {
  const captures = [...captureStates];
  const lists = versionLists.map((versions) => [...versions]);
  return {
    captureCloudflareState: vi.fn(async () => {
      if (captures.length === 0) throw new Error("unexpected capture");
      const next = captures.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    listAllTargetVersions: vi.fn(async () => {
      if (lists.length === 0) throw new Error("unexpected version list");
      const next = lists.shift();
      if (next instanceof Error) throw next;
      return next;
    }),
    findUniqueTargetVersionByTagAndMessage: vi.fn(
      (versions, { tag, message }) => {
        const matches = versions.filter(
          (version) => version.tag === tag && version.message === message
        );
        if (matches.length !== 1) throw new Error("identity is not unique");
        return matches[0];
      }
    ),
    assertUploadReadyState: vi.fn((state) => {
      if (state?.phase !== "pre") throw new Error("not upload ready");
    }),
    assertUploadPreservedInvariants: vi.fn((before, after) => {
      assertPhase(before, "pre", "upload before");
      assertPhase(after, "post", "upload after");
    }),
    assertPredeployStateUnchanged: vi.fn((current, persisted) => {
      if (current?.phase !== persisted?.phase) {
        throw new Error("predeploy drift");
      }
    }),
    assertTrafficDeploymentState: vi.fn((current, options) => {
      assertPhase(current, "traffic", "traffic");
      assertPhase(options.predeployState, "post", "persisted predeploy");
    }),
    assertPostdeployState: vi.fn((current, options) => {
      assertPhase(current, "final", "final");
      assertPhase(options.predeployState, "post", "persisted predeploy");
    })
  };
}

function commandKey(command, args) {
  return `${command} ${args.join(" ")}`;
}

function successfulRuntime({
  flow = "upload",
  captureStates,
  versionLists,
  uploadStatus = 0,
  uploadTimeout = false,
  deployStatus = 0,
  triggerStatus = 0,
  view = versionView(),
  manifest = releaseManifest(),
  manifestChanges = false,
  pnpmVersion = EXPECTED_PNPM_VERSION
} = {}) {
  const defaultCaptures =
    flow === "upload"
      ? [preState, preState, postState]
      : [postState, postState, trafficState, trafficState, finalState];
  const defaultLists =
    flow === "upload" ? [[], [], [apiVersion()]] : [[apiVersion()]];
  const cloudflare = cloudflareMocks({
    captureStates: captureStates ?? defaultCaptures,
    versionLists: versionLists ?? defaultLists
  });
  const calls = [];
  const outputs = [];
  const errors = [];
  let manifestReadCount = 0;
  const runCommand = vi.fn((command, args) => {
    calls.push({ command, args: [...args] });
    const key = commandKey(command, args);
    if (key === "git rev-parse --show-toplevel") {
      return { status: 0, stdout: `${REPOSITORY_ROOT}\n`, stderr: "" };
    }
    if (key === "git rev-parse --verify HEAD^{commit}") {
      return { status: 0, stdout: `${headCommit}\n`, stderr: "" };
    }
    if (key === "git status --porcelain=v1 --untracked-files=all") {
      return { status: 0, stdout: "", stderr: "" };
    }
    if (key === `git rev-parse ${legacySourceCommit}:mycontext-mcp-worker`) {
      return { status: 0, stdout: `${legacyWorkerTree}\n`, stderr: "" };
    }
    if (key === "git rev-parse HEAD:mycontext-mcp-worker") {
      return { status: 0, stdout: `${legacyWorkerTree}\n`, stderr: "" };
    }
    if (key === "git rev-parse HEAD:mycontext-mcp-v2-worker") {
      return { status: 0, stdout: `${newWorkerTree}\n`, stderr: "" };
    }
    if (key === "pnpm --version") {
      return { status: 0, stdout: `${pnpmVersion}\n`, stderr: "" };
    }
    if (key === "pnpm exec wrangler --version") {
      return {
        status: 0,
        stdout: `${EXPECTED_WRANGLER_VERSION}\n`,
        stderr: ""
      };
    }
    if (command === process.execPath && args[0]?.startsWith("./scripts/verify-")) {
      return { status: 0, stdout: "verified\n", stderr: "" };
    }
    if (args.includes("view")) {
      return { status: 0, stdout: JSON.stringify(view), stderr: "" };
    }
    if (args.includes("upload")) {
      if (uploadTimeout) {
        return {
          status: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
        };
      }
      return { status: uploadStatus, stdout: "remote output\n", stderr: "" };
    }
    if (args.includes("triggers")) {
      return { status: triggerStatus, stdout: "remote output\n", stderr: "" };
    }
    if (args.includes("versions") && args.includes("deploy")) {
      return { status: deployStatus, stdout: "remote output\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  const inspectSecrets = vi.fn(async () => ({
    path: "/private/secrets.json",
    secrets: requiredSecrets,
    fingerprint: {
      device: "1",
      inode: "2",
      size: 10,
      modifiedAt: 20,
      mode: 0o600,
      sha256: "e".repeat(64)
    }
  }));
  const inspectBaseline = vi.fn(async () => ({
    path: "/private/baseline.json",
    privateBaseline,
    canonical: canonicalPrivateBaseline,
    sha256: legacyBaselineSha256,
    fingerprint: {
      device: "1",
      inode: "3",
      size: 10,
      modifiedAt: 20,
      mode: 0o400,
      sha256: legacyBaselineSha256
    }
  }));
  const inspectManifest = vi.fn(async () => {
    manifestReadCount += 1;
    return {
      path: "/private/manifest.json",
      manifest,
      fingerprint: {
        device: "1",
        inode: "4",
        size: manifestChanges && manifestReadCount > 1 ? 11 : 10,
        modifiedAt: 20,
        mode: 0o400,
        sha256: "f".repeat(64)
      }
    };
  });
  const reserveManifest = vi.fn(async () => ({
    path: "/private/manifest.json",
    closed: false
  }));
  const writeManifest = vi.fn(async (reservation) => {
    reservation.closed = true;
  });
  const writePending = vi.fn(async (reservation) => {
    reservation.closed = true;
  });

  return {
    calls,
    outputs,
    errors,
    cloudflare,
    inspectManifest,
    reserveManifest,
    writeManifest,
    writePending,
    overrides: {
      cwd: WORKER_DIRECTORY,
      workerDirectory: WORKER_DIRECTORY,
      repositoryRoot: REPOSITORY_ROOT,
      environment: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "cloudflare-test-token",
        CLOUDFLARE_API_KEY: "",
        CLOUDFLARE_EMAIL: ""
      },
      runCommand,
      readFile: vi.fn(async (filePath) => {
        if (String(filePath).endsWith("migration-baseline.json")) {
          return JSON.stringify(fakeBaseline());
        }
        if (String(filePath).endsWith("pnpm-lock.yaml")) return lockContents;
        if (String(filePath).endsWith("wrangler.jsonc")) {
          return JSON.stringify(wranglerConfig());
        }
        throw new Error(`unexpected read: ${String(filePath)}`);
      }),
      realpath: vi.fn(async (value) => value),
      inspectSecretsFile: inspectSecrets,
      inspectPrivateBaselineFile: inspectBaseline,
      inspectManifestDestination: vi.fn(async () => ({
        path: "/private/manifest.json"
      })),
      inspectManifestFile: inspectManifest,
      reserveReleaseManifest: reserveManifest,
      writeReleaseManifest: writeManifest,
      writePendingReleaseReservation: writePending,
      discardReleaseManifestReservation: vi.fn(),
      cloudflare,
      verifyScripts: ["./scripts/verify-data-plane.mjs"],
      writeOutput: (value) => outputs.push(value),
      writeError: (value) => errors.push(value)
    }
  };
}

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("private input and immutable manifest files", () => {
  it("keeps strict secret JSON parsing and external 0600 secret inspection", async () => {
    expect(parseSecretsJson(JSON.stringify(requiredSecrets))).toEqual(
      requiredSecrets
    );
    expect(() =>
      parseSecretsJson(
        `{"TIDB_DATABASE_URL":"a","TIDB_DATABASE_URL":"b","GITHUB_CLIENT_ID":"c","GITHUB_CLIENT_SECRET":"d","GITHUB_ALLOWED_USER_ID":"e"}`
      )
    ).toThrow(/duplicate key/);
    const stat = {
      dev: 1,
      ino: 2,
      size: 100,
      mtimeMs: 50,
      mode: 0o100600,
      nlink: 1,
      isSymbolicLink: () => false,
      isFile: () => true
    };
    await expect(
      inspectSecretsFile("/private/secrets.json", {
        repositoryRoot: "/repo",
        lstatFile: async () => stat,
        realpathFile: async (value) => value,
        openFile: async () => ({
          stat: async () => stat,
          readFile: async () => JSON.stringify(requiredSecrets),
          close: async () => {}
        })
      })
    ).resolves.toMatchObject({ path: "/private/secrets.json" });
  });

  it("parses an owner-only 0400 private baseline and hashes canonical bytes", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-release-"));
    temporaryDirectories.push(temporaryRoot);
    const repositoryRoot = path.join(temporaryRoot, "repo");
    const privateRoot = path.join(temporaryRoot, "private");
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(privateRoot, { mode: 0o700 });
    await chmod(repositoryRoot, 0o700);
    await chmod(privateRoot, 0o700);
    const baselinePath = path.join(privateRoot, "baseline.json");
    await writeFile(
      baselinePath,
      JSON.stringify(privateBaseline, null, 2),
      { mode: 0o400 }
    );
    await chmod(baselinePath, 0o400);

    const inspected = await inspectPrivateBaselineFile(baselinePath, {
      repositoryRoot
    });
    expect(inspected.privateBaseline).toEqual(privateBaseline);
    expect(inspected.sha256).toBe(legacyBaselineSha256);
    expect(inspected.canonical).toBe(canonicalPrivateBaseline);

    const invalidManifestPath = path.join(privateRoot, "invalid-manifest.json");
    await writeFile(
      invalidManifestPath,
      JSON.stringify(
        releaseManifest({ legacyBaselineSha256: "0".repeat(64) })
      ),
      { mode: 0o400 }
    );
    await chmod(invalidManifestPath, 0o400);
    await expect(
      inspectManifestFile(invalidManifestPath, { repositoryRoot })
    ).rejects.toThrow(/does not match its SHA-256/);
  });

  it("reserves before writing, seals a complete extensible manifest 0400, and leaves pending 0600", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-release-"));
    temporaryDirectories.push(temporaryRoot);
    const repositoryRoot = path.join(temporaryRoot, "repo");
    const privateRoot = path.join(temporaryRoot, "private");
    await mkdir(repositoryRoot, { mode: 0o700 });
    await mkdir(privateRoot, { mode: 0o700 });
    await chmod(repositoryRoot, 0o700);
    await chmod(privateRoot, 0o700);
    const destination = path.join(privateRoot, "manifest.json");
    const inspected = await inspectManifestDestination(destination, {
      repositoryRoot
    });
    const reservation = await reserveReleaseManifest(inspected.path);
    await writeReleaseManifest(reservation, {
      ...releaseManifest(),
      futureRemoteState: { schemaVersion: 2 }
    });
    expect((await lstat(destination)).mode & 0o777).toBe(0o400);
    await expect(
      inspectManifestFile(destination, { repositoryRoot })
    ).resolves.toMatchObject({
      manifest: {
        legacyBaselineSha256,
        privateBaseline,
        cloudflarePredeployState: postState
      }
    });
    await expect(reserveReleaseManifest(inspected.path)).rejects.toMatchObject({
      code: "EEXIST"
    });

    const pendingPath = path.join(privateRoot, "pending.json");
    const pendingReservation = await reserveReleaseManifest(pendingPath);
    await writePendingReleaseReservation(pendingReservation, {
      status: "UNKNOWN",
      runId,
      tag: identity.tag,
      legacyBaselineSha256,
      privateBaseline,
      cloudflarePreUploadState: preState
    });
    expect((await lstat(pendingPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(pendingPath, "utf8"))).toMatchObject({
      state: "pending-recovery",
      status: "UNKNOWN",
      runId
    });
  });
});

describe("identity, CLI, commands, and manifest binding", () => {
  it("requires a lowercase UUID v4 and produces a unique <=100-byte tag", () => {
    const first = deriveReleaseIdentity({ ...provenance, runId });
    const second = deriveReleaseIdentity({ ...provenance, runId: otherRunId });
    expect(first.tag).not.toBe(second.tag);
    expect(Buffer.byteLength(first.tag)).toBeLessThanOrEqual(100);
    expect(first.message).toBe(second.message);
    expect(() =>
      deriveReleaseIdentity({
        ...provenance,
        runId: "12345678-1234-1abc-8def-1234567890ab"
      })
    ).toThrow(/UUID v4/);
    expect(() =>
      deriveReleaseIdentity({
        ...provenance,
        runId: "12345678-1234-4ABC-8DEF-1234567890AB"
      })
    ).toThrow(/UUID v4/);
  });

  it("accepts baseline-bound upload and manifest-only deploy CLI", () => {
    expect(
      parseCliArguments([
        "upload",
        "--run-id",
        runId,
        "--manifest-file",
        "/private/manifest.json",
        "--secrets-file",
        "/private/secrets.json",
        "--cloudflare-baseline-file",
        "/private/baseline.json"
      ])
    ).toMatchObject({
      command: "upload",
      runId,
      cloudflareBaselineFile: "/private/baseline.json"
    });
    expect(
      parseCliArguments([
        "deploy",
        "--manifest-file",
        "/private/manifest.json"
      ])
    ).toEqual({
      command: "deploy",
      planOnly: false,
      manifestFile: "/private/manifest.json"
    });
    expect(() =>
      parseCliArguments([
        "deploy",
        "--manifest-file",
        "/private/manifest.json",
        "--version-id",
        versionId
      ])
    ).toThrow(/unknown option/);
    expect(() =>
      parseCliArguments([
        "upload",
        "--run-id",
        runId,
        "--manifest-file",
        "/private/manifest.json",
        "--secrets-file",
        "/private/secrets.json"
      ])
    ).toThrow(/cloudflare-baseline-file/);
  });

  it("keeps only qualified upload, view, traffic, and trigger mutation commands", () => {
    const upload = buildUploadCommand({
      secretsFile: "/private/secrets.json",
      tag: identity.tag,
      message: identity.message
    });
    expect(upload.args).toContain(identity.tag);
    expect(upload.args.join(" ")).not.toContain("secret put");
    const deploy = buildDeployCommands({ versionId });
    expect(deploy.view.mutation).toBe(false);
    expect(deploy.deploy.args).toContain(versionId);
    expect(deploy.triggers.args).toContain(CRON_TRIGGER);
    expect(deploy).not.toHaveProperty("list");
  });

  it("binds embedded canonical baseline digest, account, local identity, and predeploy state", () => {
    expect(() =>
      validateManifestAgainstPreflight({
        manifest: releaseManifest(),
        accountId,
        preflight: fakePreflight()
      })
    ).not.toThrow();
    expect(() =>
      validateManifestAgainstPreflight({
        manifest: releaseManifest({ accountId: "2".repeat(32) }),
        accountId,
        preflight: fakePreflight()
      })
    ).toThrow(/accountId/);
    expect(() =>
      validateManifestAgainstPreflight({
        manifest: releaseManifest({ newWorkerTree: "e".repeat(40) }),
        accountId,
        preflight: fakePreflight()
      })
    ).toThrow(/newWorkerTree/);
  });

  it("validates exact API/view identity, resources, and ETag", () => {
    expect(() =>
      validateVersionMetadata({
        view: versionView(),
        apiVersion: apiVersion(),
        versionId,
        expectedTag: identity.tag,
        expectedMessage: identity.message
      })
    ).not.toThrow();
    expect(
      validateVersionResources(
        versionView(),
        fakePreflight().expectedVersionResources
      )
    ).toEqual({ etag });
    expect(() =>
      validateVersionMetadata({
        view: versionView(),
        apiVersion: apiVersion({ id: otherVersionId }),
        versionId,
        expectedTag: identity.tag,
        expectedMessage: identity.message
      })
    ).toThrow(/different version ID/);
    expect(() =>
      rejectExistingReleaseTag([apiVersion()], identity.tag)
    ).toThrow(/already exists/);
  });

  it("documents timeout, complete API history, baseline hash, and sanitized paths", async () => {
    const plan = staticReleasePlan();
    expect(plan.commandTimeoutMs).toBe(COMMAND_TIMEOUT_MS);
    expect(plan.verifyUploadIdentity).toContain("paginated");
    expect(plan.privateBaseline).toMatchObject({
      digest: "sha256(canonical-private-baseline)",
      deployRereadsInput: false
    });
    expect(JSON.stringify(plan)).not.toContain(WORKER_DIRECTORY);
    const output = [];
    const result = await executeRelease(["plan"], {
      cwd: WORKER_DIRECTORY,
      realpath: async (value) => value,
      runCommand: vi.fn(),
      writeOutput: (value) => output.push(value)
    });
    expect(result.executedMutations).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual(plan);
  });

  it("requires account ID and one auth method", () => {
    expect(
      validateReleaseEnvironment({
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "token"
      }).accountId
    ).toBe(accountId);
    expect(() =>
      validateReleaseEnvironment({
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_API_KEY: "key",
        CLOUDFLARE_EMAIL: "person@example.com"
      })
    ).toThrow(/exactly one/);
  });
});

describe("upload reconciliation", () => {
  const uploadArgs = [
    "upload",
    "--run-id",
    runId,
    "--manifest-file",
    "/private/manifest.json",
    "--secrets-file",
    "/private/secrets.json",
    "--cloudflare-baseline-file",
    "/private/baseline.json"
  ];

  it.each([
    ["zero exit", 0, "uploaded"],
    ["nonzero but reconciled", 1, "reconciled"]
  ])("seals the exact post-upload manifest on %s", async (_label, status, expected) => {
    const runtime = successfulRuntime({ uploadStatus: status });
    const result = await executeRelease(uploadArgs, runtime.overrides);
    expect(result).toEqual({
      command: "upload",
      status: expected,
      executedMutations: 1
    });
    expect(runtime.reserveManifest).toHaveBeenCalledOnce();
    expect(runtime.writeManifest).toHaveBeenCalledOnce();
    const manifest = runtime.writeManifest.mock.calls[0][1];
    expect(manifest).toMatchObject({
      legacyBaselineSha256,
      privateBaseline,
      cloudflarePredeployState: postState,
      versionId,
      etag
    });
    expect(runtime.writePending).not.toHaveBeenCalled();
    const output = runtime.outputs.join("");
    for (const sensitive of [
      accountId,
      versionId,
      etag,
      "/private/",
      requiredSecrets.GITHUB_CLIENT_SECRET
    ]) {
      expect(output).not.toContain(sensitive);
    }
    expect(
      runtime.calls.some(({ args }) => args.includes("list"))
    ).toBe(false);
  });

  it("treats a command timeout as reconciled when the complete remote state is exact", async () => {
    const runtime = successfulRuntime({ uploadTimeout: true });
    const result = await executeRelease(uploadArgs, runtime.overrides);
    expect(result).toEqual({
      command: "upload",
      status: "reconciled",
      executedMutations: 1
    });
    expect(runtime.writeManifest).toHaveBeenCalledOnce();
    expect(runtime.writePending).not.toHaveBeenCalled();
  });

  it("blocks duplicate tags found anywhere in the complete API result", async () => {
    const duplicate = apiVersion({ id: otherVersionId });
    const runtime = successfulRuntime({
      versionLists: [[], [], [apiVersion(), duplicate]]
    });
    await expect(executeRelease(uploadArgs, runtime.overrides)).rejects.toThrow(
      /^UNKNOWN:/
    );
    expect(runtime.writeManifest).not.toHaveBeenCalled();
    expect(runtime.writePending).toHaveBeenCalledOnce();
  });

  it("retains canonical pending recovery on nonzero/timeout or partial post-state", async () => {
    const runtime = successfulRuntime({
      uploadStatus: 1,
      captureStates: [preState, preState, driftState]
    });
    await expect(executeRelease(uploadArgs, runtime.overrides)).rejects.toThrow(
      /^UNKNOWN:/
    );
    expect(runtime.writePending).toHaveBeenCalledOnce();
    expect(runtime.writePending.mock.calls[0][1]).toMatchObject({
      status: "UNKNOWN",
      runId,
      tag: identity.tag,
      legacyBaselineSha256,
      privateBaseline,
      cloudflarePreUploadState: preState,
      uploadOutcome: "nonzero"
    });
    expect(runtime.writeManifest).not.toHaveBeenCalled();
  });

  it("does not mutate if immediate remote state differs from the stable pre-state", async () => {
    const runtime = successfulRuntime({
      captureStates: [preState, driftState],
      versionLists: [[], []]
    });
    await expect(executeRelease(uploadArgs, runtime.overrides)).rejects.toThrow(
      /predeploy drift/
    );
    expect(
      runtime.calls.some(({ args }) => args.includes("upload"))
    ).toBe(false);
    expect(runtime.writePending).not.toHaveBeenCalled();
  });

  it("upload plan validates local inputs but performs no API or mutation", async () => {
    const runtime = successfulRuntime();
    const result = await executeRelease(
      [...uploadArgs, "--plan"],
      runtime.overrides
    );
    expect(result.executedMutations).toBe(0);
    expect(runtime.cloudflare.captureCloudflareState).not.toHaveBeenCalled();
    expect(runtime.cloudflare.listAllTargetVersions).not.toHaveBeenCalled();
    expect(runtime.reserveManifest).not.toHaveBeenCalled();
  });

  it("excludes the networked verify-cloudflare module from local verifier discovery", async () => {
    const runtime = successfulRuntime();
    delete runtime.overrides.verifyScripts;
    runtime.overrides.readdir = vi.fn(async () => [
      { name: "verify-cloudflare.mjs", isFile: () => true },
      { name: "verify-data-plane.mjs", isFile: () => true }
    ]);
    await executeRelease([...uploadArgs, "--plan"], runtime.overrides);
    const verifierCalls = runtime.calls
      .filter(({ command }) => command === process.execPath)
      .map(({ args }) => args[0]);
    expect(verifierCalls).toEqual(["./scripts/verify-data-plane.mjs"]);
  });
});

describe("resumable deploy state machine", () => {
  const deployArgs = [
    "deploy",
    "--manifest-file",
    "/private/manifest.json"
  ];

  it("reconciles nonzero traffic and trigger commands when each remote state is exact", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      deployStatus: 1,
      triggerStatus: 1
    });
    const result = await executeRelease(deployArgs, runtime.overrides);
    expect(result).toEqual({
      command: "deploy",
      status: "final",
      executedMutations: 2
    });
    expect(runtime.outputs.join("")).toContain("Deploy reconciled");
    for (const sensitive of [accountId, versionId, etag, "/private/"]) {
      expect(runtime.outputs.join("")).not.toContain(sensitive);
    }
  });

  it("resumes from the exact traffic-selected/cron-empty intermediate state", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      captureStates: [trafficState, trafficState, finalState]
    });
    const result = await executeRelease(deployArgs, runtime.overrides);
    expect(result.executedMutations).toBe(1);
    expect(
      runtime.calls.some(
        ({ args }) => args.includes("versions") && args.includes("deploy")
      )
    ).toBe(false);
    expect(
      runtime.calls.some(({ args }) => args.includes("triggers"))
    ).toBe(true);
    expect(runtime.outputs.join("")).toContain("resumed");
  });

  it("is idempotent when the exact final state already exists", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      captureStates: [finalState]
    });
    const result = await executeRelease(deployArgs, runtime.overrides);
    expect(result).toEqual({
      command: "deploy",
      status: "already-final",
      executedMutations: 0
    });
    expect(
      runtime.calls.some(({ args }) => args.includes("deploy"))
    ).toBe(false);
  });

  it("blocks unrecognized drift before any mutation", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      captureStates: [driftState]
    });
    await expect(executeRelease(deployArgs, runtime.overrides)).rejects.toThrow(
      /^PARTIAL:/
    );
    expect(
      runtime.calls.some(({ args }) => args.includes("deploy"))
    ).toBe(false);
  });

  it("blocks partial traffic reconciliation and never attempts cron", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      captureStates: [postState, postState, driftState]
    });
    await expect(executeRelease(deployArgs, runtime.overrides)).rejects.toThrow(
      /traffic mutation/
    );
    expect(
      runtime.calls.some(({ args }) => args.includes("triggers"))
    ).toBe(false);
  });

  it("blocks partial trigger reconciliation without rollback", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      captureStates: [trafficState, trafficState, driftState]
    });
    await expect(executeRelease(deployArgs, runtime.overrides)).rejects.toThrow(
      /cron mutation/
    );
    expect(
      runtime.calls.filter(({ args }) => args.includes("triggers"))
    ).toHaveLength(1);
    expect(
      runtime.calls.some(
        ({ args }) =>
          args.includes("versions") &&
          args.includes("deploy") &&
          args.includes("0")
      )
    ).toBe(false);
  });

  it("blocks API ID/ETag or view ETag mismatch before mutation", async () => {
    const wrongApi = successfulRuntime({
      flow: "deploy",
      versionLists: [[apiVersion({ etag: "wrong-etag" })]],
      captureStates: []
    });
    await expect(
      executeRelease(deployArgs, wrongApi.overrides)
    ).rejects.toThrow(/manifest ETag/);
    expect(
      wrongApi.calls.some(({ args }) => args.includes("deploy"))
    ).toBe(false);

    const wrongViewRecord = versionView();
    wrongViewRecord.resources.script.etag = "wrong-etag";
    const wrongView = successfulRuntime({
      flow: "deploy",
      view: wrongViewRecord,
      captureStates: []
    });
    await expect(
      executeRelease(deployArgs, wrongView.overrides)
    ).rejects.toThrow(/versions view ETag/);
    expect(
      wrongView.calls.some(({ args }) => args.includes("deploy"))
    ).toBe(false);
  });

  it("deploy plan reads only the immutable manifest and does no API/mutation", async () => {
    const runtime = successfulRuntime({ flow: "deploy" });
    const result = await executeRelease(
      [...deployArgs, "--plan"],
      runtime.overrides
    );
    expect(result.executedMutations).toBe(0);
    expect(runtime.cloudflare.captureCloudflareState).not.toHaveBeenCalled();
    expect(runtime.cloudflare.listAllTargetVersions).not.toHaveBeenCalled();
  });

  it("blocks a replaced manifest before mutation", async () => {
    const runtime = successfulRuntime({
      flow: "deploy",
      manifestChanges: true,
      captureStates: []
    });
    await expect(executeRelease(deployArgs, runtime.overrides)).rejects.toThrow(
      /manifest file changed/
    );
    expect(
      runtime.calls.some(({ args }) => args.includes("deploy"))
    ).toBe(false);
  });
});
