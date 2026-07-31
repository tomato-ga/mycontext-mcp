import { describe, expect, it } from "vitest";

import {
  CUTOVER,
  assertFrozenLegacySnapshot,
  parseStrictJsonWithUniqueKeys,
  validateFilesystemInventory,
  validateMigrationBaseline,
  validateModuleIsolation,
  validatePackageConfig,
  validateSourceConfiguration,
  validateWranglerConfig
} from "../scripts/verify-cutover-config.mjs";

const legacyWrangler = {
  name: CUTOVER.workerName,
  main: "src/index.ts",
  compatibility_date: "2026-07-06",
  compatibility_flags: ["nodejs_compat"],
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
    { binding: "OAUTH_KV", id: CUTOVER.kvBindings.OAUTH_KV },
    { binding: "AUTH_KV", id: CUTOVER.kvBindings.AUTH_KV }
  ],
  triggers: { crons: [CUTOVER.cron] }
};

function targetWrangler() {
  return {
    ...structuredClone(legacyWrangler),
    account_id: CUTOVER.accountId,
    workers_dev: true,
    preview_urls: false,
    secrets: { required: [...CUTOVER.requiredSecrets] }
  };
}

function packageFixture() {
  return {
    name: CUTOVER.packageName,
    scripts: {
      dev: `wrangler dev --config ./wrangler.jsonc --name ${CUTOVER.workerName}`,
      tail: `wrangler tail --config ./wrangler.jsonc --name ${CUTOVER.workerName}`
    },
    dependencies: { agents: "0.20.1" },
    devDependencies: { typescript: "^5.7.2" }
  };
}

const constantsSource =
  `export const PUBLIC_ORIGIN = "${CUTOVER.origin}";\n`
  + 'export const MCP_ROUTE = "/mcp";\n'
  + "export const MCP_RESOURCE = `${PUBLIC_ORIGIN}${MCP_ROUTE}`;\n";
const indexSource =
  'import { McpServer } from "@modelcontextprotocol/server";\n'
  + 'import { PUBLIC_ORIGIN } from "./constants.js";\n'
  + `const server = new McpServer({ name: "${CUTOVER.mcpName}", version: "${CUTOVER.mcpVersion}" });\n`
  + `const metadata = { resource_name: "${CUTOVER.mcpName}", authorization_servers: [PUBLIC_ORIGIN] };\n`;

function sourceFixture(overrides = {}) {
  return {
    "src/constants.ts": constantsSource,
    "src/index.ts": indexSource,
    ...overrides
  };
}

function baselineFixture() {
  return {
    schemaVersion: 1,
    provenanceStatus: "proven-byte-exact",
    legacy: {
      workerTree: CUTOVER.frozenLegacyTree,
      worker: {
        accountId: CUTOVER.accountId,
        name: CUTOVER.workerName,
        origin: CUTOVER.origin,
        kvNamespaces: [
          {
            binding: "OAUTH_KV",
            title: "OAUTH_KV",
            id: CUTOVER.kvBindings.OAUTH_KV
          },
          {
            binding: "AUTH_KV",
            title: "AUTH_KV",
            id: CUTOVER.kvBindings.AUTH_KV
          }
        ]
      }
    },
    target: {
      accountId: CUTOVER.accountId,
      packageName: CUTOVER.packageName,
      workerName: CUTOVER.workerName,
      origin: CUTOVER.origin,
      mcpApplicationName: CUTOVER.mcpName,
      mcpApplicationVersion: CUTOVER.mcpVersion,
      deploymentMode: "in-place-version-cutover",
      cron: CUTOVER.cron,
      kvNamespaces: [
        {
          binding: "OAUTH_KV",
          title: "OAUTH_KV",
          id: CUTOVER.kvBindings.OAUTH_KV
        },
        {
          binding: "AUTH_KV",
          title: "AUTH_KV",
          id: CUTOVER.kvBindings.AUTH_KV
        }
      ]
    },
    preservedV1: {
      accountId: CUTOVER.accountId,
      workerName: CUTOVER.preservedV1WorkerName,
      origin: CUTOVER.preservedV1Origin,
      kvNamespaces: [
        { binding: "OAUTH_KV", id: "a".repeat(32) },
        { binding: "AUTH_KV", id: "b".repeat(32) }
      ]
    }
  };
}

describe("canonical in-place Wrangler configuration", () => {
  it("accepts only the existing Worker, legacy KVs, five secrets, and unchanged runtime policy", () => {
    expect(() => validateWranglerConfig(targetWrangler(), legacyWrangler)).not.toThrow();

    const wrongAccount = targetWrangler();
    wrongAccount.account_id = "00000000000000000000000000000000";
    expect(() => validateWranglerConfig(wrongAccount, legacyWrangler)).toThrow(
      /account_id/
    );
  });

  it("rejects alternate Workers, KV replacement, preview URLs, and secret drift", () => {
    const wrongWorker = targetWrangler();
    wrongWorker.name = "mycontext-mcp-v2";
    expect(() => validateWranglerConfig(wrongWorker, legacyWrangler)).toThrow(/Worker name/);

    const wrongKv = targetWrangler();
    wrongKv.kv_namespaces[0].id = "f".repeat(32);
    expect(() => validateWranglerConfig(wrongKv, legacyWrangler)).toThrow(/canonical legacy/);

    const previews = targetWrangler();
    previews.preview_urls = true;
    expect(() => validateWranglerConfig(previews, legacyWrangler)).toThrow(/preview_urls/);

    const missingSecret = targetWrangler();
    missingSecret.secrets.required.pop();
    expect(() => validateWranglerConfig(missingSecret, legacyWrangler)).toThrow(
      /secrets.required/
    );
  });

  it("rejects cron and observability drift", () => {
    const cronDrift = targetWrangler();
    cronDrift.triggers.crons = ["0 0 * * *"];
    expect(() => validateWranglerConfig(cronDrift, legacyWrangler)).toThrow(/cron/);

    const telemetryDrift = targetWrangler();
    telemetryDrift.observability.traces.head_sampling_rate = 1;
    expect(() => validateWranglerConfig(telemetryDrift, legacyWrangler)).toThrow(
      /observability/
    );
  });
});

describe("canonical source identity and isolation", () => {
  it("accepts the canonical origin and MCP 0.8.0 identity", () => {
    const sourceFiles = sourceFixture();
    expect(() =>
      validateSourceConfiguration({
        constantsSource: sourceFiles["src/constants.ts"],
        indexSource: sourceFiles["src/index.ts"],
        sourceFiles,
        workerDirectory: "/repo/mycontext-mcp-v2-worker"
      })
    ).not.toThrow();
  });

  it("rejects PRIVATE_ORIGIN, alternate origins, and a downgraded MCP identity", () => {
    const privateOrigin = sourceFixture({
      "src/override.ts": 'export const PRIVATE_ORIGIN = "https://private.invalid";'
    });
    expect(() =>
      validateSourceConfiguration({
        constantsSource: privateOrigin["src/constants.ts"],
        indexSource: privateOrigin["src/index.ts"],
        sourceFiles: privateOrigin,
        workerDirectory: "/repo/mycontext-mcp-v2-worker"
      })
    ).toThrow(/alternate origin/);

    const alternateOrigin = constantsSource.replace(
      CUTOVER.origin,
      "https://mycontext-mcp-v2.servicedake.workers.dev"
    );
    expect(() =>
      validateSourceConfiguration({
        constantsSource: alternateOrigin,
        indexSource,
        sourceFiles: sourceFixture({ "src/constants.ts": alternateOrigin }),
        workerDirectory: "/repo/mycontext-mcp-v2-worker"
      })
    ).toThrow(/PUBLIC_ORIGIN/);

    const downgradedIndex = indexSource.replace(CUTOVER.mcpVersion, "0.7.0");
    expect(() =>
      validateSourceConfiguration({
        constantsSource,
        indexSource: downgradedIndex,
        sourceFiles: sourceFixture({ "src/index.ts": downgradedIndex }),
        workerDirectory: "/repo/mycontext-mcp-v2-worker"
      })
    ).toThrow(/MCP identity/);
  });

  it("rejects imports from both frozen v1 and the preserved v1 clone", () => {
    expect(() =>
      validateModuleIsolation(
        {
          "src/bad.ts":
            'export * from "../../mycontext-mcp-worker/src/auth.js";'
        },
        "/repo/mycontext-mcp-v2-worker"
      )
    ).toThrow(/cross-imports v1/);

    expect(() =>
      validateModuleIsolation(
        {
          "src/bad.ts":
            'const clone = await import("../../mycontext-mcp-v1-worker/src/index.js");'
        },
        "/repo/mycontext-mcp-v2-worker"
      )
    ).toThrow(/cross-imports v1/);

    expect(() =>
      validateModuleIsolation(
        { "src/bad.ts": "const location = './module.js'; await import(location);" },
        "/repo/mycontext-mcp-v2-worker"
      )
    ).toThrow(/non-literal dynamic import/);
  });
});

describe("repository and release metadata fail closed", () => {
  it("pins the frozen original v1 tree and rejects dirty state", () => {
    const clean = {
      objectType: "tree",
      committedTree: CUTOVER.frozenLegacyTree,
      changedFiles: "",
      untrackedFiles: ""
    };
    expect(() => assertFrozenLegacySnapshot(clean)).not.toThrow();
    expect(() =>
      assertFrozenLegacySnapshot({ ...clean, changedFiles: "mycontext-mcp-worker/src/index.ts" })
    ).toThrow(/tracked v1 worktree changed/);
  });

  it("rejects symlinks and local secret files while allowing templates", () => {
    expect(() =>
      validateFilesystemInventory([
        { relativePath: "src/index.ts", type: "file" },
        { relativePath: ".dev.vars.example", type: "file" }
      ])
    ).not.toThrow();
    expect(() =>
      validateFilesystemInventory([
        { relativePath: "src/shared.ts", type: "symlink" }
      ])
    ).toThrow(/symlink/);
    expect(() =>
      validateFilesystemInventory([
        { relativePath: ".dev.vars", type: "file" }
      ])
    ).toThrow(/secret-bearing file/);
  });

  it("rejects duplicate JSON keys and v1 package links", () => {
    expect(() =>
      parseStrictJsonWithUniqueKeys('{"name":"safe","name":"wrong"}', "fixture")
    ).toThrow(/duplicate key/);

    const linkedPackage = packageFixture();
    linkedPackage.dependencies.legacy = "file:../mycontext-mcp-worker";
    expect(() => validatePackageConfig(linkedPackage)).toThrow(/cross-link/);
  });

  it("requires the baseline to describe the in-place target and isolated preserved v1", () => {
    expect(() => validateMigrationBaseline(baselineFixture())).not.toThrow();

    const wrongTarget = baselineFixture();
    wrongTarget.target.origin = CUTOVER.preservedV1Origin;
    expect(() => validateMigrationBaseline(wrongTarget)).toThrow(/target origin/);

    const sharedKv = baselineFixture();
    sharedKv.preservedV1.kvNamespaces[0].id = CUTOVER.kvBindings.OAUTH_KV;
    expect(() => validateMigrationBaseline(sharedKv)).toThrow(/must not share/);
  });
});
