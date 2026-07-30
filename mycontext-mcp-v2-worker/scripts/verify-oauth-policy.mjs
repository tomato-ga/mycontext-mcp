#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
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

function readBaselineFile(relativePath, encoding = null) {
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
    return encoding === null ? Buffer.alloc(0) : "";
  }
}

function findMatchingDelimiter(source, startIndex, openCharacter, closeCharacter) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function extractOAuthProviderObject(source, label) {
  const constructorIndex = source.indexOf("new OAuthProvider");
  if (constructorIndex < 0) {
    fail(`${label} does not construct OAuthProvider`);
    return "{}";
  }
  const objectStart = source.indexOf("{", constructorIndex);
  if (objectStart < 0) {
    fail(`${label} OAuthProvider options object is missing`);
    return "{}";
  }
  const objectEnd = findMatchingDelimiter(source, objectStart, "{", "}");
  if (objectEnd < 0) {
    fail(`${label} OAuthProvider options object is unbalanced`);
    return "{}";
  }
  return source.slice(objectStart, objectEnd + 1);
}

function splitTopLevel(source) {
  const segments = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && nextCharacter === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && nextCharacter === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && nextCharacter === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (
      character === "," &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      segments.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const finalSegment = source.slice(start).trim();
  if (finalSegment !== "") {
    segments.push(finalSegment);
  }
  return segments;
}

function findTopLevelColon(segment) {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (
      character === ":" &&
      braces === 0 &&
      brackets === 0 &&
      parentheses === 0
    ) {
      return index;
    }
  }
  return -1;
}

function propertyMap(objectSource, label) {
  const inner = objectSource.startsWith("{") && objectSource.endsWith("}")
    ? objectSource.slice(1, -1)
    : objectSource;
  const properties = new Map();
  for (const segment of splitTopLevel(inner)) {
    const colonIndex = findTopLevelColon(segment);
    let key;
    let value;
    if (colonIndex >= 0) {
      key = segment.slice(0, colonIndex).trim().replace(/^["']|["']$/g, "");
      value = segment.slice(colonIndex + 1).trim();
    } else {
      const methodMatch = segment.match(/^([A-Za-z_$][\w$]*)\s*\(/);
      const shorthandMatch = segment.match(/^([A-Za-z_$][\w$]*)$/);
      key = methodMatch?.[1] ?? shorthandMatch?.[1];
      value = segment;
    }
    if (key === undefined) {
      fail(`${label} contains an unrecognized OAuthProvider property`);
      continue;
    }
    if (properties.has(key)) {
      fail(`${label} contains duplicate OAuthProvider property ${key}`);
    }
    properties.set(key, value);
  }
  return properties;
}

function normalizeSource(value) {
  return value.replace(/\s+/g, " ").trim();
}

const policyFiles = ["src/oauth.ts", "src/auth.ts", "src/config.ts", "src/http.ts"];
for (const relativePath of policyFiles) {
  const expectedHash = baseline.legacy.frozenFileSha256[relativePath];
  const baselineContents = readBaselineFile(relativePath);
  const baselineHash = sha256(baselineContents);
  if (baselineHash !== expectedHash) {
    fail(`baseline manifest hash is invalid for ${relativePath}`);
  }
  const targetContents = await readFile(path.join(workerDirectory, relativePath));
  if (sha256(targetContents) !== expectedHash) {
    fail(`OAuth policy file drifted from the proven baseline: ${relativePath}`);
  }
}

const legacyIndexSource = readBaselineFile("src/index.ts", "utf8");
const targetIndexSource = await readFile(path.join(workerDirectory, "src", "index.ts"), "utf8");
const legacyOptions = propertyMap(
  extractOAuthProviderObject(legacyIndexSource, "legacy index.ts"),
  "legacy index.ts"
);
const targetOptions = propertyMap(
  extractOAuthProviderObject(targetIndexSource, "v2 index.ts"),
  "v2 index.ts"
);

const ignoredAdapterProperties = new Set(["apiHandler"]);
const legacyKeys = [...legacyOptions.keys()]
  .filter((key) => !ignoredAdapterProperties.has(key))
  .sort();
const targetKeys = [...targetOptions.keys()]
  .filter((key) => !ignoredAdapterProperties.has(key))
  .sort();
if (JSON.stringify(legacyKeys) !== JSON.stringify(targetKeys)) {
  fail(
    `OAuthProvider option keys changed outside the MCP adapter: expected ${legacyKeys.join(", ")}, got ${targetKeys.join(", ")}`
  );
}

for (const key of legacyKeys) {
  const legacyValue = legacyOptions.get(key);
  const targetValue = targetOptions.get(key);
  if (targetValue === undefined) {
    continue;
  }
  if (key === "resourceMetadata") {
    const legacyMetadata = propertyMap(legacyValue, "legacy resourceMetadata");
    const targetMetadata = propertyMap(targetValue, "v2 resourceMetadata");
    const legacyMetadataKeys = [...legacyMetadata.keys()].sort();
    const targetMetadataKeys = [...targetMetadata.keys()].sort();
    if (JSON.stringify(legacyMetadataKeys) !== JSON.stringify(targetMetadataKeys)) {
      fail("OAuth resourceMetadata keys changed");
      continue;
    }
    for (const metadataKey of legacyMetadataKeys) {
      if (
        normalizeSource(legacyMetadata.get(metadataKey)) !==
        normalizeSource(targetMetadata.get(metadataKey))
      ) {
        fail(`OAuth resourceMetadata.${metadataKey} changed`);
      }
    }
  } else if (normalizeSource(legacyValue) !== normalizeSource(targetValue)) {
    fail(`OAuthProvider option ${key} changed`);
  }
}

if (
  !/purgeExpiredData\s*\(\s*env\s*,\s*\{\s*batchSize\s*:\s*100\s*\}\s*\)/s.test(
    targetIndexSource
  )
) {
  fail("OAuth purge policy must remain purgeExpiredData(env, { batchSize: 100 })");
}
if (/clientIdMetadataDocumentEnabled\s*:\s*true/.test(targetIndexSource)) {
  fail("CIMD must remain disabled");
}

const targetWranglerSource = await readFile(
  path.join(workerDirectory, "wrangler.jsonc"),
  "utf8"
);
if (targetWranglerSource.includes("global_fetch_strictly_public")) {
  fail("global_fetch_strictly_public must not be introduced in this migration");
}

const legacyPackage = JSON.parse(readBaselineFile("package.json", "utf8"));
const targetPackage = JSON.parse(
  await readFile(path.join(workerDirectory, "package.json"), "utf8")
);
if (
  targetPackage.dependencies?.["@cloudflare/workers-oauth-provider"] !==
  legacyPackage.dependencies?.["@cloudflare/workers-oauth-provider"]
) {
  fail("@cloudflare/workers-oauth-provider specifier changed");
}

if (errors.length > 0) {
  console.error("MCP v2 OAuth policy verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `MCP v2 OAuth policy verification passed (${policyFiles.length} frozen policy files, ${legacyKeys.length} provider options).`
  );
}
