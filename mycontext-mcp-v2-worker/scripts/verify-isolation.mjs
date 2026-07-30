#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(workerDirectory, "..");
const legacyDirectoryName = "mycontext-mcp-worker";
const legacySdkPackage = "@modelcontextprotocol/sdk";
const baseline = JSON.parse(
  await readFile(path.join(workerDirectory, "verification", "migration-baseline.json"), "utf8")
);
const errors = [];

function fail(message) {
  errors.push(message);
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`git ${args.join(" ")} failed: ${detail}`);
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

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function collectFiles(directory, options = {}) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (options.skip?.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, options));
    } else {
      files.push(absolutePath);
    }
  }
  return files;
}

function parseStrictJson(contents, label) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} must remain strict JSON despite its .jsonc extension: ${detail}`);
    return {};
  }
}

function collectModuleReferences(source, filePath) {
  const references = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  function record(kind, moduleSpecifier) {
    if (ts.isStringLiteralLike(moduleSpecifier)) {
      references.push({ kind, specifier: moduleSpecifier.text });
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      record("static import", node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      record("static re-export", node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression !== undefined
    ) {
      record("require import", node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record("dynamic import", node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        record("require import", node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function isLegacySdkSpecifier(specifier) {
  return specifier === legacySdkPackage || specifier.startsWith(`${legacySdkPackage}/`);
}

for (const [kind, fixture] of [
  ["static import", `import { Client } from "${legacySdkPackage}/client/index.js";`],
  ["side-effect import", `import "${legacySdkPackage}";`],
  ["static re-export", `export * from "${legacySdkPackage}/types.js";`],
  ["dynamic import", `await import("${legacySdkPackage}/client/index.js");`],
  ["require import", `require("${legacySdkPackage}/server/index.js");`],
  ["TypeScript require import", `import sdk = require("${legacySdkPackage}");`]
]) {
  const detected = collectModuleReferences(fixture, `<legacy-sdk-${kind}-fixture>`)
    .some(({ specifier }) => isLegacySdkSpecifier(specifier));
  if (!detected) {
    fail(`legacy v1 SDK detector did not reject its ${kind} fixture`);
  }
}

if (baseline.schemaVersion !== 1) {
  fail(`unsupported baseline schemaVersion: ${String(baseline.schemaVersion)}`);
}
if (baseline.provenanceStatus !== "proven-byte-exact") {
  fail(`baseline provenance is not deployable: ${String(baseline.provenanceStatus)}`);
}

const baselineCommit = baseline.legacy.sourceCommit;
const expectedLegacyTree = baseline.legacy.workerTree;
const actualBaselineTree = runGit(["rev-parse", `${baselineCommit}:${legacyDirectoryName}`]);
if (actualBaselineTree !== expectedLegacyTree) {
  fail(`baseline Worker tree mismatch: expected ${expectedLegacyTree}, got ${actualBaselineTree || "<missing>"}`);
}

const actualBaselineSrcTree = runGit(["rev-parse", `${baselineCommit}:${legacyDirectoryName}/src`]);
if (actualBaselineSrcTree !== baseline.legacy.srcTree) {
  fail(`baseline src tree mismatch: expected ${baseline.legacy.srcTree}, got ${actualBaselineSrcTree || "<missing>"}`);
}

const currentLegacyTree = runGit(["rev-parse", `HEAD:${legacyDirectoryName}`]);
if (currentLegacyTree !== expectedLegacyTree) {
  fail(`current committed legacy Worker tree changed: expected ${expectedLegacyTree}, got ${currentLegacyTree || "<missing>"}`);
}

const legacyWorktreeChanges = runGit([
  "diff",
  "--name-only",
  "--no-renames",
  baselineCommit,
  "--",
  legacyDirectoryName
]);
if (legacyWorktreeChanges !== "") {
  fail(`legacy Worker has staged or unstaged changes:\n${legacyWorktreeChanges}`);
}

const legacyUntracked = runGit([
  "ls-files",
  "--others",
  "--exclude-standard",
  "--",
  legacyDirectoryName
]);
if (legacyUntracked !== "") {
  fail(`legacy Worker has non-ignored untracked files:\n${legacyUntracked}`);
}

for (const privateName of [".dev.vars", ".env", ".env.local"]) {
  try {
    await lstat(path.join(workerDirectory, privateName));
    fail(`${privateName} must not exist in the isolated source tree`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

const allEntries = await collectFiles(workerDirectory, {
  skip: new Set(["node_modules", ".wrangler"])
});
for (const entryPath of allEntries) {
  const status = await lstat(entryPath);
  if (status.isSymbolicLink()) {
    fail(`symlink is not allowed in the isolated Worker: ${path.relative(workerDirectory, entryPath)}`);
  }
}

const sourceFiles = (await collectFiles(path.join(workerDirectory, "src")))
  .filter((filePath) => filePath.endsWith(".ts"));
for (const sourceFile of sourceFiles) {
  const source = await readFile(sourceFile, "utf8");
  for (const { kind, specifier } of collectModuleReferences(source, sourceFile)) {
    if (isLegacySdkSpecifier(specifier)) {
      fail(
        `application source imports the legacy v1 SDK via ${kind}: `
        + `${path.relative(workerDirectory, sourceFile)} -> ${specifier}`
      );
    }
    if (!specifier.startsWith(".")) {
      continue;
    }
    const resolvedImport = path.resolve(path.dirname(sourceFile), specifier);
    if (!isInside(workerDirectory, resolvedImport)) {
      fail(
        `relative import escapes the v2 Worker: ${path.relative(workerDirectory, sourceFile)} -> ${specifier}`
      );
    }
  }
}

const packageJson = JSON.parse(await readFile(path.join(workerDirectory, "package.json"), "utf8"));
if (packageJson.name !== baseline.target.packageName) {
  fail(`package name must be ${baseline.target.packageName}, got ${String(packageJson.name)}`);
}
for (const sectionName of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  if (Object.hasOwn(packageJson[sectionName] ?? {}, legacySdkPackage)) {
    fail(
      `${sectionName}.${legacySdkPackage} is forbidden; `
      + "the legacy v1 SDK may only be a devDependency for compatibility tests"
    );
  }
}
for (const [sectionName, dependencies] of Object.entries({
  dependencies: packageJson.dependencies ?? {},
  devDependencies: packageJson.devDependencies ?? {}
})) {
  for (const [dependencyName, specifier] of Object.entries(dependencies)) {
    if (typeof specifier === "string" && /^(?:file|link|workspace):/.test(specifier)) {
      fail(`${sectionName}.${dependencyName} must not link to another workspace: ${specifier}`);
    }
  }
}
if (
  typeof packageJson.scripts?.deploy === "string" &&
  /\bwrangler\s+deploy\b/.test(packageJson.scripts.deploy) &&
  !/--dry-run\b/.test(packageJson.scripts.deploy)
) {
  fail("package.json must not expose an unqualified live `wrangler deploy` script");
}

const newWranglerContents = await readFile(path.join(workerDirectory, "wrangler.jsonc"), "utf8");
const newWrangler = parseStrictJson(newWranglerContents, "v2 wrangler.jsonc");
const legacyWranglerContents = runGit([
  "show",
  `${baselineCommit}:${legacyDirectoryName}/wrangler.jsonc`
]);
const legacyWrangler = parseStrictJson(legacyWranglerContents, "legacy wrangler.jsonc");

if (newWrangler.name !== baseline.target.workerName) {
  fail(`Worker name must be ${baseline.target.workerName}, got ${String(newWrangler.name)}`);
}
if (newWrangler.main !== legacyWrangler.main) {
  fail(`Worker entry point changed: expected ${String(legacyWrangler.main)}, got ${String(newWrangler.main)}`);
}
if (newWrangler.compatibility_date !== legacyWrangler.compatibility_date) {
  fail("compatibility_date must be inherited from the legacy Worker");
}
if (!sameJson(newWrangler.compatibility_flags, legacyWrangler.compatibility_flags)) {
  fail("compatibility_flags must be inherited from the legacy Worker");
}
if (newWrangler.workers_dev !== true) {
  fail("workers_dev must be explicitly true");
}
if (newWrangler.preview_urls !== false) {
  fail("preview_urls must be explicitly false");
}
if (!sameJson(newWrangler.observability, legacyWrangler.observability)) {
  fail("observability configuration drifted from the legacy Worker");
}
if (
  !sameJson(newWrangler.triggers?.crons, [baseline.target.cron]) ||
  newWrangler.triggers?.crons?.length !== 1
) {
  fail(`v2 Worker must declare exactly one cron: ${baseline.target.cron}`);
}

const expectedBindings = new Set(["OAUTH_KV", "AUTH_KV"]);
const kvBindings = Array.isArray(newWrangler.kv_namespaces) ? newWrangler.kv_namespaces : [];
if (kvBindings.length !== expectedBindings.size) {
  fail("v2 Worker must contain exactly OAUTH_KV and AUTH_KV bindings");
}
const newKvIds = [];
for (const binding of kvBindings) {
  if (!expectedBindings.delete(binding?.binding)) {
    fail(`unexpected or duplicate KV binding: ${String(binding?.binding)}`);
  }
  if (typeof binding?.id !== "string" || !/^[a-f0-9]{32}$/.test(binding.id)) {
    fail(`KV binding ${String(binding?.binding)} must use a real 32-character lowercase hex namespace ID`);
  } else {
    newKvIds.push(binding.id);
  }
}
if (expectedBindings.size > 0) {
  fail(`missing KV binding(s): ${Array.from(expectedBindings).join(", ")}`);
}
if (new Set(newKvIds).size !== newKvIds.length) {
  fail("OAUTH_KV and AUTH_KV must use different namespace IDs");
}
for (const newKvId of newKvIds) {
  if (baseline.legacy.worker.kvNamespaceIds.includes(newKvId)) {
    fail("v2 Worker reuses a legacy KV namespace ID");
  }
}

const constantsSource = await readFile(path.join(workerDirectory, "src", "constants.ts"), "utf8");
const originMatch = constantsSource.match(
  /export\s+const\s+PUBLIC_ORIGIN\s*=\s*["']([^"']+)["']\s*;/
);
if (originMatch?.[1] !== baseline.target.origin) {
  fail(`PUBLIC_ORIGIN must be ${baseline.target.origin}, got ${originMatch?.[1] ?? "<missing>"}`);
}

const indexSource = await readFile(path.join(workerDirectory, "src", "index.ts"), "utf8");
const serverIdentityPattern = new RegExp(
  `new\\s+McpServer\\s*\\(\\s*\\{\\s*name:\\s*["']${baseline.target.mcpApplicationName}["']\\s*,\\s*version:\\s*["']${baseline.target.mcpApplicationVersion}["']`
);
if (!serverIdentityPattern.test(indexSource)) {
  fail(
    `MCP application identity must remain ${baseline.target.mcpApplicationName} with version ${baseline.target.mcpApplicationVersion}`
  );
}

for (const sourceFile of sourceFiles) {
  const source = await readFile(sourceFile, "utf8");
  if (source.includes(baseline.legacy.worker.origin)) {
    fail(`deployable v2 source contains the legacy origin: ${path.relative(workerDirectory, sourceFile)}`);
  }
}
if (newWranglerContents.includes(baseline.legacy.worker.name) && newWrangler.name !== baseline.target.workerName) {
  fail("wrangler config targets the legacy Worker");
}
for (const legacyKvId of baseline.legacy.worker.kvNamespaceIds) {
  if (newWranglerContents.includes(legacyKvId)) {
    fail("wrangler config contains a legacy KV namespace ID");
  }
}

if (errors.length > 0) {
  console.error("MCP v2 isolation verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v2 isolation verification passed (legacy tree ${expectedLegacyTree}, target ${baseline.target.workerName}).`
  );
}
