#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareLockMigration,
  parsePnpmLockV9
} from "./pnpm-lock-v9.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(workerDirectory, "..");
const legacyDirectoryName = "mycontext-mcp-worker";
const baseline = JSON.parse(
  await readFile(path.join(workerDirectory, "verification", "migration-baseline.json"), "utf8")
);
const errors = [];

function fail(message) {
  errors.push(message);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function readBaselineFile(relativePath, encoding = "utf8") {
  try {
    return execFileSync(
      "git",
      [
        "show",
        `${baseline.legacy.sourceCommit}:${legacyDirectoryName}/${relativePath}`
      ],
      {
        cwd: repositoryRoot,
        encoding,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read baseline ${relativePath}: ${detail}`);
    return "";
  }
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

const legacyPackage = JSON.parse(readBaselineFile("package.json"));
const targetPackage = JSON.parse(
  await readFile(path.join(workerDirectory, "package.json"), "utf8")
);

const allowedTopLevelChanges = new Set([
  "name",
  "scripts",
  "dependencies",
  "devDependencies"
]);
for (const key of new Set([...Object.keys(legacyPackage), ...Object.keys(targetPackage)])) {
  if (!allowedTopLevelChanges.has(key) && !sameJson(legacyPackage[key], targetPackage[key])) {
    fail(`package.json top-level field ${key} changed`);
  }
}

if (targetPackage.name !== baseline.target.packageName) {
  fail(`package name must be ${baseline.target.packageName}`);
}

const expectedDependencies = {
  ...legacyPackage.dependencies
};
delete expectedDependencies["@modelcontextprotocol/sdk"];
expectedDependencies["@modelcontextprotocol/server"] =
  baseline.target.dependencies["@modelcontextprotocol/server"];
expectedDependencies.agents = baseline.target.dependencies.agents;

const expectedDevDependencies = {
  ...legacyPackage.devDependencies,
  "@modelcontextprotocol/client":
    baseline.target.devDependencies["@modelcontextprotocol/client"],
  "@modelcontextprotocol/sdk":
    baseline.target.devDependencies["@modelcontextprotocol/sdk"]
};

if (!sameJson(targetPackage.dependencies, expectedDependencies)) {
  fail("runtime dependencies changed outside the MCP/Agents allowlist");
}
if (!sameJson(targetPackage.devDependencies, expectedDevDependencies)) {
  fail("devDependencies changed outside the MCP client/legacy compatibility allowlist");
}

const identityScopedScripts = {
  dev: `wrangler dev --config ./wrangler.jsonc --name ${baseline.target.workerName}`,
  tail: `wrangler tail --config ./wrangler.jsonc --name ${baseline.target.workerName}`
};
for (const [scriptName, legacyCommand] of Object.entries(legacyPackage.scripts ?? {})) {
  if (scriptName === "deploy" || scriptName in identityScopedScripts) {
    continue;
  }
  if (targetPackage.scripts?.[scriptName] !== legacyCommand) {
    fail(`existing package script ${scriptName} changed`);
  }
}
for (const [scriptName, expectedCommand] of Object.entries(identityScopedScripts)) {
  if (targetPackage.scripts?.[scriptName] !== expectedCommand) {
    fail(`identity-scoped package script ${scriptName} must be: ${expectedCommand}`);
  }
}
if (targetPackage.scripts?.deploy !== undefined) {
  fail("unqualified deploy script must be removed from the v2 package");
}
if (
  targetPackage.scripts?.["deploy:dry-run"] !==
  "node ./scripts/verify-dry-run.mjs"
) {
  fail("deploy:dry-run must invoke only the local no-upload verifier");
}
if (
  targetPackage.scripts?.["release:gate"] !==
  "node ./scripts/release-cutover-gate.mjs"
) {
  fail("release:gate must invoke only the reviewed live cutover gate");
}
for (const scriptName of Object.keys(targetPackage.scripts ?? {})) {
  if (
    !(scriptName in (legacyPackage.scripts ?? {})) &&
    scriptName !== "deploy:dry-run" &&
    scriptName !== "release:gate" &&
    !/^verify(?::|$)/.test(scriptName) &&
    !/^test:(?:contract|protocol|modern|legacy)(?::|$)/.test(scriptName)
  ) {
    fail(`new package script is outside the verification allowlist: ${scriptName}`);
  }
}

const workspaceContents = await readFile(
  path.join(workerDirectory, "pnpm-workspace.yaml")
);
const expectedWorkspaceHash = baseline.legacy.frozenFileSha256["pnpm-workspace.yaml"];
if (sha256(workspaceContents) !== expectedWorkspaceHash) {
  fail("pnpm-workspace.yaml changed, including allowBuilds policy");
}
const baselineWorkspaceHash = sha256(
  Buffer.from(readBaselineFile("pnpm-workspace.yaml"))
);
if (baselineWorkspaceHash !== expectedWorkspaceHash) {
  fail("baseline pnpm-workspace.yaml hash does not match the manifest");
}

const baselineLockContents = readBaselineFile("pnpm-lock.yaml");
const expectedBaselineLockHash =
  baseline.legacy.frozenFileSha256["pnpm-lock.yaml"];
if (sha256(Buffer.from(baselineLockContents)) !== expectedBaselineLockHash) {
  fail("baseline pnpm-lock.yaml hash does not match the manifest");
}

let lockStats;
try {
  const legacyGraph = parsePnpmLockV9(
    baselineLockContents,
    "legacy pnpm-lock.yaml"
  );
  const targetGraph = parsePnpmLockV9(
    await readFile(path.join(workerDirectory, "pnpm-lock.yaml"), "utf8"),
    "v2 pnpm-lock.yaml"
  );
  const changedLegacyRoots = ["@modelcontextprotocol/sdk", "agents"];
  const changedTargetRoots = [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/sdk",
    "agents"
  ];
  const frozenRoots = [...legacyGraph.roots.keys()]
    .filter((name) => !changedLegacyRoots.includes(name))
    .sort();
  const comparison = compareLockMigration({
    legacyGraph,
    targetGraph,
    legacyAllowedRoots: changedLegacyRoots,
    targetAllowedRoots: changedTargetRoots,
    frozenRoots,
    expectedTargetVersions: {
      ...baseline.target.dependencies,
      ...baseline.target.devDependencies
    },
    expectedTargetRoots: {
      "@modelcontextprotocol/server": {
        group: "dependencies",
        specifier: baseline.target.dependencies["@modelcontextprotocol/server"]
      },
      agents: {
        group: "dependencies",
        specifier: baseline.target.dependencies.agents
      },
      "@modelcontextprotocol/client": {
        group: "devDependencies",
        specifier:
          baseline.target.devDependencies["@modelcontextprotocol/client"]
      },
      "@modelcontextprotocol/sdk": {
        group: "devDependencies",
        specifier: baseline.target.devDependencies["@modelcontextprotocol/sdk"]
      }
    }
  });
  for (const error of comparison.errors) {
    fail(error);
  }
  lockStats = comparison.stats;
} catch (error) {
  fail(
    `pnpm lockfile verification could not be completed: ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}

if (errors.length > 0) {
  console.error("MCP v2 dependency drift verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v2 dependency drift verification passed (direct lockfile v9 comparison; ` +
      `${String(lockStats.legacySnapshots)} -> ${String(lockStats.targetSnapshots)} snapshots, ` +
      `${String(lockStats.frozenRoots)} frozen roots).`
  );
}
