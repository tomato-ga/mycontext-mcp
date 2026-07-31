#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const cloneDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(cloneDirectory, "..");
const baselineDirectoryName = "mycontext-mcp-worker";
const baselineTree = "33ba9ceecf6dfe15025ef8e8d3662f87bfdbccd9";
const oldOrigin = "https://mycontext-mcp.servicedake.workers.dev";
const newOrigin = "https://mycontext-mcp-v1.servicedake.workers.dev";
const expectedAccountId = "1f7287ca0dc182ac70db5e77dcd5f3ce";
const expectedKvIds = Object.freeze({
  OAUTH_KV: "a0616be361fb4a65bd12e1fe35ec1101",
  AUTH_KV: "3bb6082de7ba4730b759c3e6e8322027"
});
const expectedSecrets = Object.freeze([
  "TIDB_DATABASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_ALLOWED_USER_ID",
  "PERSONAL_SYNONYMS"
]);
const mutableCloneFiles = new Set([
  "README.md",
  "package.json",
  "src/constants.ts",
  "tests/oauth.test.ts",
  "wrangler.jsonc"
]);
const cloneOnlyFiles = new Set(["scripts/verify-v1-clone.mjs"]);
const forbiddenNames = new Set([
  ".dev.vars",
  ".env",
  ".env.local",
  "MEMORY.md"
]);
const ignoredRuntimeDirectories = new Set([".wrangler", "node_modules"]);
const errors = [];

function fail(message) {
  errors.push(message);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed`);
    return "";
  }
  return result.stdout.trimEnd();
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (ignoredRuntimeDirectories.has(entry.name)) {
      const runtimePath = path.join(directory, entry.name);
      const runtimeStatus = await lstat(runtimePath);
      if (runtimeStatus.isSymbolicLink() || !runtimeStatus.isDirectory()) {
        fail(`runtime cache must be a regular directory: ${relativePath}`);
      }
      continue;
    }
    if (forbiddenNames.has(entry.name)) {
      fail(`forbidden clone entry exists: ${relativePath}`);
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    const status = await lstat(absolutePath);
    if (status.isSymbolicLink()) {
      fail(`symlink is not allowed in the v1 clone: ${relativePath}`);
      continue;
    }
    if (status.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
    } else if (status.isFile()) {
      files.push(relativePath);
    } else {
      fail(`non-regular clone entry is not allowed: ${relativePath}`);
    }
  }
  return files;
}

function parseJson(contents, label) {
  try {
    return JSON.parse(contents);
  } catch {
    fail(`${label} must be strict JSON`);
    return {};
  }
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function expectedPackage(baseline) {
  const value = parseJson(baseline, "baseline package.json");
  value.name = "mycontext-mcp-v1-worker";
  value.scripts = {
    ...value.scripts,
    dev: "wrangler dev --config ./wrangler.jsonc --name mycontext-mcp-v1",
    "deploy:dry-run":
      "wrangler deploy --dry-run --strict --config ./wrangler.jsonc --name mycontext-mcp-v1",
    "verify:clone": "node ./scripts/verify-v1-clone.mjs",
    tail: "wrangler tail --config ./wrangler.jsonc --name mycontext-mcp-v1"
  };
  delete value.scripts.deploy;
  return value;
}

function expectedWrangler(baseline) {
  const value = parseJson(baseline, "baseline wrangler.jsonc");
  value.name = "mycontext-mcp-v1";
  value.account_id = expectedAccountId;
  value.workers_dev = true;
  value.preview_urls = false;
  value.kv_namespaces = value.kv_namespaces.map((binding) => ({
    ...binding,
    id: expectedKvIds[binding.binding]
  }));
  value.secrets = { required: [...expectedSecrets] };
  return value;
}

const actualBaselineTree = runGit(["rev-parse", `HEAD:${baselineDirectoryName}`]);
if (actualBaselineTree !== baselineTree) {
  fail(
    `committed v1 baseline tree changed: expected ${baselineTree}, got `
      + `${actualBaselineTree || "<missing>"}`
  );
}

const baselineChanges = runGit([
  "diff",
  "--name-only",
  "--no-renames",
  "HEAD",
  "--",
  baselineDirectoryName
]);
if (baselineChanges !== "") {
  fail(`v1 baseline has staged or unstaged changes:\n${baselineChanges}`);
}

const baselineFiles = runGit([
  "ls-tree",
  "-r",
  "--name-only",
  "HEAD",
  baselineDirectoryName
])
  .split("\n")
  .filter(Boolean)
  .map((file) => file.slice(`${baselineDirectoryName}/`.length))
  .sort();
const expectedFiles = [...baselineFiles, ...cloneOnlyFiles].sort();
const actualFiles = (await collectFiles(cloneDirectory)).sort();

for (const file of expectedFiles) {
  if (!actualFiles.includes(file)) {
    fail(`v1 clone is missing expected file: ${file}`);
  }
}
for (const file of actualFiles) {
  if (!expectedFiles.includes(file)) {
    fail(`v1 clone contains unexpected file: ${file}`);
  }
}

for (const file of baselineFiles) {
  if (mutableCloneFiles.has(file)) {
    continue;
  }
  const baseline = runGit(["show", `HEAD:${baselineDirectoryName}/${file}`]);
  const clone = await readFile(path.join(cloneDirectory, file), "utf8");
  if (`${baseline}\n` !== clone && baseline !== clone) {
    fail(`v1 application contract drifted from the frozen baseline: ${file}`);
  }
}

const cloneReadme = await readFile(path.join(cloneDirectory, "README.md"), "utf8");
if (
  !cloneReadme.startsWith("# mycontext-mcp-v1-worker\n") ||
  !cloneReadme.includes(`${newOrigin}/mcp`) ||
  !cloneReadme.includes(`${newOrigin}/oauth/github/callback`) ||
  cloneReadme.includes(`${oldOrigin}/mcp`)
) {
  fail("README.md does not describe the isolated, bulk-secret v1 release");
}

const baselineConstants = runGit([
  "show",
  `HEAD:${baselineDirectoryName}/src/constants.ts`
]);
const cloneConstants = await readFile(
  path.join(cloneDirectory, "src", "constants.ts"),
  "utf8"
);
if (`${baselineConstants}\n`.replaceAll(oldOrigin, newOrigin) !== cloneConstants) {
  fail("src/constants.ts contains changes outside PUBLIC_ORIGIN");
}

const baselineOauthTest = runGit([
  "show",
  `HEAD:${baselineDirectoryName}/tests/oauth.test.ts`
]);
const cloneOauthTest = await readFile(
  path.join(cloneDirectory, "tests", "oauth.test.ts"),
  "utf8"
);
if (`${baselineOauthTest}\n`.replaceAll(oldOrigin, newOrigin) !== cloneOauthTest) {
  fail("tests/oauth.test.ts contains changes outside the v1 origin");
}

const baselinePackage = runGit([
  "show",
  `HEAD:${baselineDirectoryName}/package.json`
]);
const clonePackage = parseJson(
  await readFile(path.join(cloneDirectory, "package.json"), "utf8"),
  "clone package.json"
);
if (!sameJson(clonePackage, expectedPackage(baselinePackage))) {
  fail("package.json contains changes outside the allowlisted v1 release scripts");
}

const baselineWrangler = runGit([
  "show",
  `HEAD:${baselineDirectoryName}/wrangler.jsonc`
]);
const cloneWrangler = parseJson(
  await readFile(path.join(cloneDirectory, "wrangler.jsonc"), "utf8"),
  "clone wrangler.jsonc"
);
if (!sameJson(cloneWrangler, expectedWrangler(baselineWrangler))) {
  fail("wrangler.jsonc contains unexpected v1 deployment configuration");
}

if (errors.length > 0) {
  console.error("MCP v1 clone verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v1 clone verification passed (frozen tree ${baselineTree}, `
      + `${baselineFiles.length} inherited files, origin-only runtime drift).`
  );
}
