#!/usr/bin/env node

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const baseline = JSON.parse(
  await readFile(path.join(workerDirectory, "verification", "migration-baseline.json"), "utf8")
);
const errors = [];
let bundleByteCount = 0;
let metafileInputCount = 0;
let wranglerAvailable = true;

function fail(message) {
  errors.push(message);
}

function sanitizedEnvironment() {
  const environment = { ...process.env, WRANGLER_SEND_METRICS: "false" };
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_EMAIL",
    "TIDB_DATABASE_URL",
    "PERSONAL_SYNONYMS",
    "GITHUB_ALLOWED_USER_ID",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET"
  ]) {
    delete environment[name];
  }
  return environment;
}

function redactDiagnostic(value) {
  return value
    .replace(/mysql:\/\/[^@\s]+@/gi, "mysql://<redacted>@")
    .replace(
      /\b(?:[g]ho_|github[_]pat_|s[k]-)[A-Za-z0-9_-]{8,}\b/g,
      "<redacted-token>"
    )
    .slice(0, 6000);
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

const wranglerVersionResult = spawnSync(
  "pnpm",
  ["exec", "wrangler", "--version"],
  {
    cwd: workerDirectory,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: sanitizedEnvironment()
  }
);
if (wranglerVersionResult.status !== 0) {
  wranglerAvailable = false;
  fail(
    `cannot resolve the project-local Wrangler: ${redactDiagnostic(
      wranglerVersionResult.stderr || wranglerVersionResult.stdout
    )}`
  );
} else {
  const versionMatch = wranglerVersionResult.stdout.match(/\b(\d+\.\d+\.\d+)\b/);
  if (versionMatch?.[1] !== baseline.legacy.bundle.wranglerVersion) {
    fail(
      `Wrangler version must remain ${baseline.legacy.bundle.wranglerVersion}, got ${versionMatch?.[1] ?? "<unknown>"}`
    );
  }
}

let wranglerConfig = {};
try {
  wranglerConfig = JSON.parse(
    await readFile(path.join(workerDirectory, "wrangler.jsonc"), "utf8")
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail(`wrangler.jsonc is not strict JSON: ${detail}`);
}
if (wranglerConfig.name !== baseline.target.workerName) {
  fail(`dry-run config must target ${baseline.target.workerName}`);
}
const kvBindings = Array.isArray(wranglerConfig.kv_namespaces)
  ? wranglerConfig.kv_namespaces
  : [];
const kvIds = kvBindings.map((binding) => binding?.id);
if (
  kvBindings.length !== 2 ||
  !kvBindings.some((binding) => binding?.binding === "OAUTH_KV") ||
  !kvBindings.some((binding) => binding?.binding === "AUTH_KV")
) {
  fail("dry-run config must contain exactly the OAUTH_KV and AUTH_KV bindings");
}
if (kvIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))) {
  fail("dry-run config contains a placeholder or invalid KV namespace ID");
}
if (new Set(kvIds).size !== kvIds.length) {
  fail("dry-run config reuses one KV namespace for both bindings");
}
if (kvIds.some((id) => baseline.legacy.worker.kvNamespaceIds.includes(id))) {
  fail("dry-run config contains a legacy KV namespace ID");
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "mycontext-mcp-v2-dry-run-")
);
const outputDirectory = path.join(temporaryDirectory, "bundle");
const metafilePath = path.join(temporaryDirectory, "bundle-meta.json");

try {
  if (wranglerAvailable) {
    const dryRunResult = spawnSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--strict",
        "--config",
        "./wrangler.jsonc",
        "--name",
        baseline.target.workerName,
        "--outdir",
        outputDirectory,
        "--metafile",
        metafilePath
      ],
      {
        cwd: workerDirectory,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: sanitizedEnvironment()
      }
    );

    if (dryRunResult.status !== 0) {
      fail(
        `Wrangler dry-run failed: ${redactDiagnostic(
          dryRunResult.stderr || dryRunResult.stdout || `exit ${String(dryRunResult.status)}`
        )}`
      );
    }
  }

  let metafile;
  try {
    metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  } catch (error) {
    if (errors.length === 0) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`Wrangler did not produce a readable metafile: ${detail}`);
    }
  }

  if (metafile !== undefined) {
    const inputs = Object.keys(metafile.inputs ?? {});
    metafileInputCount = inputs.length;
    if (inputs.length === 0) {
      fail("Wrangler metafile contains no bundle inputs");
    }
    if (!inputs.some((input) => input.replaceAll("\\", "/").endsWith("src/index.ts"))) {
      fail("Wrangler metafile does not include src/index.ts");
    }
    for (const input of inputs) {
      const normalized = input.replaceAll("\\", "/");
      if (
        /(?:^|\/)mycontext-mcp-worker\/src\//.test(normalized) ||
        normalized.startsWith("../mycontext-mcp-worker/src/")
      ) {
        fail(`dry-run bundle imports legacy Worker source: ${normalized}`);
      }
    }
  }

  try {
    const bundleFiles = await collectFiles(outputDirectory);
    const scriptFiles = bundleFiles.filter((filePath) =>
      [".js", ".mjs", ".cjs"].includes(path.extname(filePath))
    );
    if (scriptFiles.length === 0) {
      fail("Wrangler dry-run produced no JavaScript bundle");
    }
    let combinedBundle = "";
    for (const scriptFile of scriptFiles) {
      const fileStat = await stat(scriptFile);
      bundleByteCount += fileStat.size;
      combinedBundle += await readFile(scriptFile, "utf8");
    }

    if (!combinedBundle.includes(baseline.target.origin)) {
      fail("dry-run bundle does not contain the v2 public origin");
    }
    if (combinedBundle.includes(baseline.legacy.worker.origin)) {
      fail("dry-run bundle contains the legacy public origin");
    }
    for (const legacyKvId of baseline.legacy.worker.kvNamespaceIds) {
      if (combinedBundle.includes(legacyKvId)) {
        fail("dry-run bundle contains a legacy KV namespace ID");
      }
    }
    if (
      /(?:\/Users\/[^/\s"'`]+|\/Volumes\/[^/\s"'`]+)/.test(combinedBundle) ||
      /mysql:\/\/[^<\s"']+:[^<\s"']+@/i.test(combinedBundle)
    ) {
      fail("dry-run bundle contains a local path or database credential-shaped value");
    }
  } catch (error) {
    if (errors.length === 0) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`cannot inspect Wrangler dry-run output: ${detail}`);
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error("MCP v2 Wrangler dry-run verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v2 Wrangler dry-run verification passed (${bundleByteCount} bundle bytes, ${metafileInputCount} inputs, no upload).`
  );
}
