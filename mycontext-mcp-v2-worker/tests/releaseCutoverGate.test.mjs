import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  realpath,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CutoverGateError,
  EXPECTED_ACCOUNT_ID,
  EXPECTED_CRON,
  EXPECTED_KV_NAMESPACES,
  EXPECTED_PRIMARY_V1_DEPLOYMENT_ID,
  EXPECTED_PRIMARY_V1_VERSION_ETAG,
  EXPECTED_PRIMARY_V1_VERSION_ID,
  REQUIRED_SECRET_KEYS,
  assertBaselineState,
  assertCandidatePreStageState,
  assertCandidateVersion,
  assertNoCloudflareEnvironmentOverrides,
  assertPreservedV1Ready,
  assertPromotedState,
  assertRolledBackState,
  assertSmokeEvidence,
  assertStagedState,
  inspectSecretsFile,
  parseManifestEnvelope,
  parseSecretsJson,
  readPrivateManifest,
  writePrivateManifest
} from "../scripts/release-cutover-gate.mjs";

const oldVersionId = EXPECTED_PRIMARY_V1_VERSION_ID;
const newVersionId = "22222222-2222-4222-8222-222222222222";
const oldDeploymentId = EXPECTED_PRIMARY_V1_DEPLOYMENT_ID;
const stagedDeploymentId = "44444444-4444-4444-8444-444444444444";
const newDeploymentId = "55555555-5555-4555-8555-555555555555";
const temporaryDirectories = [];

function bindings(scope) {
  return [
    ...EXPECTED_KV_NAMESPACES.filter((entry) => entry.scope === scope).map(
      (entry) => ({
        name: entry.binding,
        type: "kv_namespace",
        namespaceId: entry.id
      })
    ),
    ...REQUIRED_SECRET_KEYS.map((name) => ({ name, type: "secret_text" }))
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function worker({
  scope,
  versionId,
  etag,
  percentage = 100,
  deploymentId = oldDeploymentId,
  previewsEnabled = false,
  tag = "alias-tag",
  message = "alias message"
}) {
  return {
    exists: true,
    activeDeployment: {
      id: deploymentId,
      versions: [
        {
          id: versionId,
          etag,
          percentage,
          number: 1,
          annotations: {
            "workers/message": message,
            "workers/tag": tag
          },
          hasPreview: previewsEnabled,
          handlers: ["fetch", "scheduled"],
          runtime: {
            compatibilityDate: "2026-07-06",
            compatibilityFlags: ["nodejs_compat"]
          },
          bindings: bindings(scope)
        }
      ]
    },
    crons: [EXPECTED_CRON],
    observability: {
      logs: {
        enabled: true,
        headSamplingRate: 1,
        invocationLogs: true
      },
      traces: {
        enabled: true,
        headSamplingRate: 0.2
      }
    },
    subdomain: {
      enabled: true,
      previewsEnabled
    }
  };
}

function missingWorker() {
  return {
    exists: false,
    activeDeployment: null,
    crons: [],
    observability: null,
    subdomain: null
  };
}

function baselineState() {
  return {
    accountId: EXPECTED_ACCOUNT_ID,
    primary: worker({
      scope: "primary",
      versionId: oldVersionId,
      etag: EXPECTED_PRIMARY_V1_VERSION_ETAG,
      previewsEnabled: true
    }),
    preservedV1: missingWorker(),
    kvNamespaces: EXPECTED_KV_NAMESPACES,
    preservedV1KvEmpty: true
  };
}

function candidateVersion() {
  return {
    id: newVersionId,
    etag: "new-etag",
    number: 39,
    annotations: {
      "workers/message": "candidate message",
      "workers/tag": "candidate-tag"
    },
    hasPreview: false,
    handlers: ["fetch", "scheduled"],
    runtime: {
      compatibilityDate: "2026-07-06",
      compatibilityFlags: ["nodejs_compat"]
    },
    bindings: bindings("primary")
  };
}

function candidatePayload() {
  const primaryBaseline = baselineState().primary;
  const primaryCandidateState = structuredClone(primaryBaseline);
  primaryCandidateState.subdomain.previewsEnabled = false;
  return {
    primaryBaseline,
    primaryCandidateState,
    primaryV1Version: {
      id: oldVersionId,
      etag: EXPECTED_PRIMARY_V1_VERSION_ETAG
    },
    preservedV1: worker({
      scope: "preserved-v1",
      versionId: "66666666-6666-4666-8666-666666666666",
      etag: "alias-etag",
      deploymentId: "77777777-7777-4777-8777-777777777777"
    }),
    kvNamespaces: EXPECTED_KV_NAMESPACES,
    candidateVersion: candidateVersion()
  };
}

function candidateCurrent() {
  const payload = candidatePayload();
  return {
    accountId: EXPECTED_ACCOUNT_ID,
    primary: payload.primaryCandidateState,
    preservedV1: payload.preservedV1,
    kvNamespaces: EXPECTED_KV_NAMESPACES
  };
}

function stagedCurrent() {
  const current = candidateCurrent();
  current.primary = {
    ...current.primary,
    activeDeployment: {
      id: stagedDeploymentId,
      versions: [
        {
          id: oldVersionId,
          etag: EXPECTED_PRIMARY_V1_VERSION_ETAG,
          percentage: 100,
          bindings: bindings("primary")
        },
        {
          id: newVersionId,
          etag: "new-etag",
          percentage: 0,
          bindings: bindings("primary")
        }
      ]
    }
  };
  return current;
}

function promotedCurrent() {
  const current = candidateCurrent();
  current.primary = worker({
    scope: "primary",
    versionId: newVersionId,
    etag: "new-etag",
    deploymentId: newDeploymentId
  });
  return current;
}

function secretsObject() {
  return Object.fromEntries(
    REQUIRED_SECRET_KEYS.map((key) => [key, `${key.toLowerCase()}-value`])
  );
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mycontext-cutover-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("live cutover state assertions", () => {
  it("rejects Cloudflare credential or account environment overrides", () => {
    expect(assertNoCloudflareEnvironmentOverrides({})).toBe(true);
    expect(() =>
      assertNoCloudflareEnvironmentOverrides({
        CLOUDFLARE_ACCOUNT_ID: "different-account"
      })
    ).toThrow(/must be unset/);
  });

  it("accepts only a canonical v1 baseline with the alias absent", () => {
    expect(assertBaselineState(baselineState())).toBe(true);
    const drifted = baselineState();
    drifted.primary.activeDeployment.versions[0].etag = "changed";
    expect(() => assertBaselineState(drifted)).toThrow(/ETag/);
    const aliasPresent = baselineState();
    aliasPresent.preservedV1 = worker({
      scope: "preserved-v1",
      versionId: newVersionId,
      etag: "alias"
    });
    expect(() =>
      assertBaselineState(aliasPresent)
    ).toThrow(/must not exist/);
  });

  it("requires the v1 alias to keep exact bindings, cron, and runtime settings", () => {
    const alias = candidatePayload().preservedV1;
    expect(
      assertPreservedV1Ready(alias, {
        tag: "alias-tag",
        message: "alias message"
      })
    ).toBe(true);
    const wrongBinding = structuredClone(alias);
    wrongBinding.activeDeployment.versions[0].bindings[0].namespaceId =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(() =>
      assertPreservedV1Ready(wrongBinding, {
        tag: "alias-tag",
        message: "alias message"
      })
    ).toThrow(/bindings/);
  });

  it("pins candidate tag, message, ETag, bindings, runtime, and preview state", () => {
    const version = candidateVersion();
    expect(
      assertCandidateVersion(version, {
        tag: "candidate-tag",
        message: "candidate message"
      })
    ).toBe(true);
    const changed = structuredClone(version);
    changed.bindings.pop();
    expect(() =>
      assertCandidateVersion(changed, {
        tag: "candidate-tag",
        message: "candidate message"
      })
    ).toThrow(/bindings/);
  });

  it("rejects active deployment drift before staging", () => {
    const current = candidateCurrent();
    expect(
      assertCandidatePreStageState(current, candidatePayload())
    ).toBe(true);
    current.primary.activeDeployment.id =
      "88888888-8888-4888-8888-888888888888";
    expect(() =>
      assertCandidatePreStageState(current, candidatePayload())
    ).toThrow(/state changed/);
  });

  it("accepts only the captured old version at 100 and candidate at zero", () => {
    const current = stagedCurrent();
    expect(assertStagedState(current, candidatePayload())).toBe(true);
    current.primary.activeDeployment.versions[1].etag = "wrong-etag";
    expect(() => assertStagedState(current, candidatePayload())).toThrow(/ETag/);
  });

  it("pins promotion and rollback to exact captured version IDs and ETags", () => {
    expect(assertPromotedState(promotedCurrent(), candidatePayload())).toBe(true);
    const wrongPromotion = promotedCurrent();
    wrongPromotion.primary.activeDeployment.versions[0].id = oldVersionId;
    expect(() =>
      assertPromotedState(wrongPromotion, candidatePayload())
    ).toThrow(/not exactly/);

    const rollback = candidateCurrent();
    rollback.primary = candidatePayload().primaryBaseline;
    expect(assertRolledBackState(rollback, candidatePayload())).toBe(true);
    rollback.primary.activeDeployment.versions[0].etag = "wrong-etag";
    expect(() => assertRolledBackState(rollback, candidatePayload())).toThrow(
      /did not return/
    );
  });

  it("requires fresh 0% response-differential evidence for the pinned candidate", () => {
    const candidateEnvelope = {
      integritySha256: "candidate-integrity",
      payload: candidatePayload()
    };
    const now = Date.parse("2026-07-31T01:00:00.000Z");
    const smoke = {
      candidateIntegritySha256: "candidate-integrity",
      candidateVersionId: newVersionId,
      candidateVersionEtag: "new-etag",
      evidence: {
        checkedAt: "2026-07-31T00:55:00.000Z",
        overrideHeader: {
          name: "Cloudflare-Workers-Version-Overrides",
          value: `mycontext-mcp="${newVersionId}"`
        },
        statuses: {
          normalHealth: 200,
          overrideHealth: 200,
          normalInvalidOriginMcp: 401,
          overrideInvalidOriginMcp: 403
        }
      }
    };
    expect(
      assertSmokeEvidence(smoke, candidateEnvelope, { now })
    ).toBe(true);
    smoke.evidence.statuses.overrideInvalidOriginMcp = 401;
    expect(() =>
      assertSmokeEvidence(smoke, candidateEnvelope, { now })
    ).toThrow(/does not prove/);
  });
});

describe("private release files", () => {
  it("parses exactly five unique non-empty secret strings", () => {
    const valid = JSON.stringify(secretsObject());
    expect(Object.keys(parseSecretsJson(valid)).sort()).toEqual(
      [...REQUIRED_SECRET_KEYS].sort()
    );
    expect(() =>
      parseSecretsJson(valid.replace(
        `"${REQUIRED_SECRET_KEYS[0]}":`,
        `"${REQUIRED_SECRET_KEYS[0]}":"duplicate","${REQUIRED_SECRET_KEYS[0]}":`
      ))
    ).toThrow(/duplicate/);
    expect(() =>
      parseSecretsJson(
        JSON.stringify({ ...secretsObject(), EXTRA_SECRET: "blocked" })
      )
    ).toThrow(/exactly/);
  });

  it("requires the v1 secrets file to be external, regular, owner-only 0600", async () => {
    const directory = await temporaryDirectory();
    const secretsPath = path.join(directory, "v1-secrets.json");
    await writeFile(secretsPath, JSON.stringify(secretsObject()), {
      mode: 0o600
    });
    const inspected = await inspectSecretsFile(secretsPath);
    expect(inspected.path).toBe(await realpath(secretsPath));
    await chmod(secretsPath, 0o644);
    await expect(inspectSecretsFile(secretsPath)).rejects.toThrow(/0600/);
  });

  it("detects manifest content tampering even when mode is restored", async () => {
    const directory = await temporaryDirectory();
    const manifestPath = path.join(directory, "baseline.json");
    await writePrivateManifest(manifestPath, "baseline", {
      repository: { headCommit: "a".repeat(40) },
      remote: { primary: "captured" }
    });
    const valid = await readPrivateManifest(manifestPath, "baseline");
    expect(valid.envelope.kind).toBe("baseline");

    await chmod(manifestPath, 0o600);
    const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    parsed.payload.remote.primary = "tampered";
    await writeFile(manifestPath, `${JSON.stringify(parsed)}\n`);
    await chmod(manifestPath, 0o400);
    await expect(readPrivateManifest(manifestPath, "baseline")).rejects.toThrow(
      /integrity/
    );
  });

  it("rejects a manifest with a wrong phase", () => {
    expect(() =>
      parseManifestEnvelope(
        {
          schemaVersion: 1,
          kind: "alias",
          payload: {},
          integritySha256: "0".repeat(64)
        },
        "candidate"
      )
    ).toThrow(CutoverGateError);
  });
});
