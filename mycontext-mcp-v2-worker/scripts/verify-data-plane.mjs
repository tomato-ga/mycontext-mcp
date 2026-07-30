#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function readBaselineFile(relativePath) {
  try {
    return execFileSync(
      "git",
      [
        "show",
        `${baseline.legacy.sourceCommit}:${legacyDirectoryName}/${relativePath}`
      ],
      {
        cwd: repositoryRoot,
        encoding: null,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`cannot read baseline ${relativePath}: ${detail}`);
    return Buffer.alloc(0);
  }
}

async function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(absolutePath);
    }
  }
  return files;
}

const frozenDataFiles = ["src/tidb.ts", "src/skillContext.ts"];
for (const relativePath of frozenDataFiles) {
  const expectedHash = baseline.legacy.frozenFileSha256[relativePath];
  if (typeof expectedHash !== "string") {
    fail(`baseline is missing the frozen hash for ${relativePath}`);
    continue;
  }

  const baselineContents = readBaselineFile(relativePath);
  const baselineHash = sha256(baselineContents);
  if (baselineHash !== expectedHash) {
    fail(`baseline manifest hash is invalid for ${relativePath}: expected ${expectedHash}, got ${baselineHash}`);
  }

  const targetContents = await readFile(path.join(workerDirectory, relativePath));
  const targetHash = sha256(targetContents);
  if (targetHash !== expectedHash) {
    fail(`data-plane file drifted from the proven baseline: ${relativePath}`);
  }
}

const sourceDirectory = path.join(workerDirectory, "src");
const sourceFiles = await collectTypeScriptFiles(sourceDirectory);
const expectedExecuteFiles = new Set(baseline.legacy.dataPlane.executeFiles);
const expectedDriverImportFiles = new Set(baseline.legacy.dataPlane.tidbDriverImportFiles);
let executeCallsiteCount = 0;

for (const sourceFile of sourceFiles) {
  const relativePath = path.relative(workerDirectory, sourceFile).split(path.sep).join("/");
  const source = await readFile(sourceFile, "utf8");
  const executeMatches = [
    ...source.matchAll(/\.\s*execute\s*\(/g),
    ...source.matchAll(/\[\s*["']execute["']\s*\]\s*\(/g)
  ];

  if (executeMatches.length > 0 && !expectedExecuteFiles.has(relativePath)) {
    fail(`new database execute callsite is outside the frozen data plane: ${relativePath}`);
  }
  executeCallsiteCount += executeMatches.length;

  const importsTidbDriver =
    /\bfrom\s+["']@tidbcloud\/serverless["']/.test(source) ||
    /\bimport\s*\(\s*["']@tidbcloud\/serverless["']\s*\)/.test(source);
  if (importsTidbDriver && !expectedDriverImportFiles.has(relativePath)) {
    fail(`TiDB driver import is outside the frozen data plane: ${relativePath}`);
  }

  if (
    /\bfrom\s+["'](?:mysql2(?:\/promise)?|mysql|pg|postgres|@planetscale\/database)["']/.test(source) ||
    /\bimport\s*\(\s*["'](?:mysql2(?:\/promise)?|mysql|pg|postgres|@planetscale\/database)["']\s*\)/.test(source)
  ) {
    fail(`unapproved database driver import found: ${relativePath}`);
  }

  if (source.includes("TIDB_DATABASE_URL") && relativePath !== "src/config.ts") {
    fail(`TIDB_DATABASE_URL is referenced outside the frozen configuration boundary: ${relativePath}`);
  }
}

if (executeCallsiteCount !== baseline.legacy.dataPlane.executeCallsiteCount) {
  fail(
    `database execute callsite count changed: expected ${baseline.legacy.dataPlane.executeCallsiteCount}, got ${executeCallsiteCount}`
  );
}

for (const expectedFile of expectedExecuteFiles) {
  if (!sourceFiles.some(
    (sourceFile) => path.relative(workerDirectory, sourceFile).split(path.sep).join("/") === expectedFile
  )) {
    fail(`expected frozen execute file is missing: ${expectedFile}`);
  }
}

if (errors.length > 0) {
  console.error("MCP v2 data-plane verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v2 data-plane verification passed (${frozenDataFiles.length} frozen files, ${executeCallsiteCount} execute callsites).`
  );
}
