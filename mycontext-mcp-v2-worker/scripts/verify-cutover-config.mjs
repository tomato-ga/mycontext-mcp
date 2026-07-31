#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const CUTOVER = Object.freeze({
  accountId: "1f7287ca0dc182ac70db5e77dcd5f3ce",
  workerName: "mycontext-mcp",
  origin: "https://mycontext-mcp.servicedake.workers.dev",
  packageName: "mycontext-mcp-v2-worker",
  mcpName: "mycontext-mcp",
  mcpVersion: "0.8.0",
  frozenLegacyTree: "33ba9ceecf6dfe15025ef8e8d3662f87bfdbccd9",
  legacyDirectoryName: "mycontext-mcp-worker",
  preservedV1DirectoryName: "mycontext-mcp-v1-worker",
  preservedV1WorkerName: "mycontext-mcp-v1",
  preservedV1Origin: "https://mycontext-mcp-v1.servicedake.workers.dev",
  cron: "17 4 * * *",
  kvBindings: Object.freeze({
    OAUTH_KV: "88cc0f72224947fc818c0520207164de",
    AUTH_KV: "3c6429869d7e41b19f3423670f2c1c90"
  }),
  requiredSecrets: Object.freeze([
    "TIDB_DATABASE_URL",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_ALLOWED_USER_ID",
    "PERSONAL_SYNONYMS"
  ])
});

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const skippedRuntimeDirectories = new Set(["node_modules", ".wrangler"]);
const forbiddenOriginAliases =
  /\b(?:PRIVATE|PREVIEW|STAGING|LEGACY|V1|V2|WORKER|TARGET)_ORIGIN\b/u;
const workersDevOriginPattern =
  /https?:\/\/[a-z0-9.-]+\.workers\.dev(?=[:/ "'`\s]|$)/giu;

export class CutoverConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "CutoverConfigError";
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new CutoverConfigError(message);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function propertyNameText(name) {
  if (
    ts.isIdentifier(name)
    || ts.isStringLiteralLike(name)
    || ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

export function parseStrictJsonWithUniqueKeys(contents, label) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CutoverConfigError(`${label} must be strict JSON: ${detail}`);
  }

  const sourceFile = ts.parseJsonText(label, contents);
  assert(
    sourceFile.parseDiagnostics.length === 0,
    `${label} could not be parsed as an unambiguous JSON document`
  );

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set();
      for (const property of node.properties) {
        assert(
          ts.isPropertyAssignment(property),
          `${label} contains an unsupported JSON object member`
        );
        const key = propertyNameText(property.name);
        assert(key !== undefined, `${label} contains an unsupported JSON key`);
        assert(!keys.has(key), `${label} contains duplicate key ${JSON.stringify(key)}`);
        keys.add(key);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return parsed;
}

function assertExactStringSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(
    actual.every((entry) => typeof entry === "string"),
    `${label} must contain only strings`
  );
  assert(new Set(actual).size === actual.length, `${label} must not contain duplicates`);
  assert(
    actual.length === expected.length
      && expected.every((entry) => actual.includes(entry)),
    `${label} must contain exactly: ${expected.join(", ")}`
  );
}

function normalizeKvBindings(bindings, label) {
  assert(Array.isArray(bindings), `${label} must be an array`);
  assert(bindings.length === 2, `${label} must contain exactly two bindings`);
  const normalized = {};
  for (const binding of bindings) {
    assert(isPlainObject(binding), `${label} contains a non-object binding`);
    assert(
      Object.keys(binding).length === 2
        && Object.hasOwn(binding, "binding")
        && Object.hasOwn(binding, "id"),
      `${label} entries may contain only binding and id`
    );
    assert(
      binding.binding === "OAUTH_KV" || binding.binding === "AUTH_KV",
      `${label} contains unexpected binding ${String(binding.binding)}`
    );
    assert(
      !Object.hasOwn(normalized, binding.binding),
      `${label} repeats binding ${binding.binding}`
    );
    assert(
      typeof binding.id === "string" && /^[a-f0-9]{32}$/u.test(binding.id),
      `${label}.${binding.binding} must be a lowercase 32-character namespace ID`
    );
    normalized[binding.binding] = binding.id;
  }
  return normalized;
}

function normalizeBaselineKvBindings(bindings, label) {
  assert(Array.isArray(bindings), `${label} must be an array`);
  const projected = bindings.map((binding) => ({
    binding: binding?.binding,
    id: binding?.id
  }));
  return normalizeKvBindings(projected, label);
}

export function validateWranglerConfig(config, legacyConfig) {
  assert(isPlainObject(config), "v2 wrangler config must be an object");
  assert(isPlainObject(legacyConfig), "frozen legacy wrangler config must be an object");
  assert(config.name === CUTOVER.workerName, `Worker name must be ${CUTOVER.workerName}`);
  assert(
    config.account_id === CUTOVER.accountId,
    `Cloudflare account_id must be ${CUTOVER.accountId}`
  );
  assert(config.main === legacyConfig.main, "Worker entry point drifted from frozen v1");
  assert(
    config.compatibility_date === legacyConfig.compatibility_date,
    "compatibility_date drifted from frozen v1"
  );
  assert(
    sameJson(config.compatibility_flags, legacyConfig.compatibility_flags),
    "compatibility_flags drifted from frozen v1"
  );
  assert(config.workers_dev === true, "workers_dev must be explicitly true");
  assert(config.preview_urls === false, "preview_urls must be explicitly false");
  assert(!Object.hasOwn(config, "env"), "wrangler env overrides are forbidden for cutover");
  assert(!Object.hasOwn(config, "route"), "wrangler route overrides are forbidden for cutover");
  assert(!Object.hasOwn(config, "routes"), "wrangler routes are forbidden for cutover");
  assert(
    sameJson(config.observability, legacyConfig.observability),
    "observability must remain byte-semantically identical to frozen v1"
  );
  assert(
    sameJson(config.triggers?.crons, legacyConfig.triggers?.crons)
      && sameJson(config.triggers?.crons, [CUTOVER.cron]),
    `cron must remain exactly ${CUTOVER.cron}`
  );

  const actualKv = normalizeKvBindings(config.kv_namespaces, "kv_namespaces");
  assert(
    sameJson(actualKv, CUTOVER.kvBindings),
    "v2 must reuse the canonical legacy OAUTH_KV and AUTH_KV namespace IDs"
  );

  assert(isPlainObject(config.secrets), "secrets.required must be declared");
  assert(
    Object.keys(config.secrets).length === 1 && Object.hasOwn(config.secrets, "required"),
    "secrets may contain only the required declaration"
  );
  assertExactStringSet(
    config.secrets.required,
    CUTOVER.requiredSecrets,
    "secrets.required"
  );
  for (const secretName of CUTOVER.requiredSecrets) {
    assert(
      !Object.hasOwn(config.vars ?? {}, secretName),
      `${secretName} must not be stored in wrangler vars`
    );
  }
}

export function validateMigrationBaseline(baseline) {
  assert(isPlainObject(baseline), "migration baseline must be an object");
  assert(baseline.schemaVersion === 1, "migration baseline schemaVersion must be 1");
  assert(
    baseline.provenanceStatus === "proven-byte-exact",
    "migration baseline provenance must remain proven-byte-exact"
  );
  assert(
    baseline.legacy?.workerTree === CUTOVER.frozenLegacyTree,
    `migration baseline must pin frozen v1 tree ${CUTOVER.frozenLegacyTree}`
  );
  assert(
    baseline.legacy?.worker?.name === CUTOVER.workerName,
    "migration baseline legacy Worker name drifted"
  );
  assert(
    baseline.legacy?.worker?.accountId === CUTOVER.accountId,
    "migration baseline legacy account drifted"
  );
  assert(
    baseline.legacy?.worker?.origin === CUTOVER.origin,
    "migration baseline legacy origin drifted"
  );
  assert(
    sameJson(
      normalizeBaselineKvBindings(
        baseline.legacy?.worker?.kvNamespaces,
        "baseline legacy kvNamespaces"
      ),
      CUTOVER.kvBindings
    ),
    "migration baseline legacy KV bindings drifted"
  );

  assert(
    baseline.target?.workerName === CUTOVER.workerName,
    "migration baseline target Worker must be mycontext-mcp"
  );
  assert(
    baseline.target?.accountId === CUTOVER.accountId,
    "migration baseline target account drifted"
  );
  assert(
    baseline.target?.origin === CUTOVER.origin,
    "migration baseline target origin must remain canonical"
  );
  assert(
    baseline.target?.packageName === CUTOVER.packageName,
    "migration baseline target package name drifted"
  );
  assert(
    baseline.target?.mcpApplicationName === CUTOVER.mcpName
      && baseline.target?.mcpApplicationVersion === CUTOVER.mcpVersion,
    `migration baseline MCP identity must be ${CUTOVER.mcpName}@${CUTOVER.mcpVersion}`
  );
  assert(
    baseline.target?.deploymentMode === "in-place-version-cutover",
    "migration baseline must declare in-place-version-cutover"
  );
  assert(baseline.target?.cron === CUTOVER.cron, "migration baseline target cron drifted");
  assert(
    sameJson(
      normalizeBaselineKvBindings(
        baseline.target?.kvNamespaces,
        "baseline target kvNamespaces"
      ),
      CUTOVER.kvBindings
    ),
    "migration baseline target must reuse canonical legacy KV bindings"
  );

  assert(
    baseline.preservedV1?.workerName === CUTOVER.preservedV1WorkerName,
    "migration baseline must preserve Worker mycontext-mcp-v1"
  );
  assert(
    baseline.preservedV1?.accountId === CUTOVER.accountId,
    "migration baseline preserved-v1 account drifted"
  );
  assert(
    baseline.preservedV1?.origin === CUTOVER.preservedV1Origin,
    "migration baseline preserved-v1 origin drifted"
  );
  const preservedKv = normalizeBaselineKvBindings(
    baseline.preservedV1?.kvNamespaces,
    "baseline preserved-v1 kvNamespaces"
  );
  for (const id of Object.values(preservedKv)) {
    assert(
      !Object.values(CUTOVER.kvBindings).includes(id),
      "preserved v1 clone must not share a KV namespace with the v2 cutover target"
    );
  }
}

function extractMcpIdentities(indexSource, label) {
  const sourceFile = ts.createSourceFile(
    label,
    indexSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  assert(
    sourceFile.parseDiagnostics.length === 0,
    `${label} contains TypeScript parse errors`
  );
  const identities = [];
  const resourceNames = [];

  function visit(node) {
    if (
      ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "McpServer"
    ) {
      const options = node.arguments?.[0];
      assert(
        options !== undefined && ts.isObjectLiteralExpression(options),
        "McpServer identity must be an inline object literal"
      );
      const identity = {};
      for (const property of options.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyNameText(property.name);
        if (
          (key === "name" || key === "version")
          && ts.isStringLiteralLike(property.initializer)
        ) {
          identity[key] = property.initializer.text;
        }
      }
      identities.push(identity);
    }
    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === "resource_name") {
      assert(
        ts.isStringLiteralLike(node.initializer),
        "resource_name must be a string literal"
      );
      resourceNames.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { identities, resourceNames };
}

export function collectModuleReferences(source, label) {
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  assert(
    sourceFile.parseDiagnostics.length === 0,
    `${label} contains TypeScript parse errors`
  );
  const references = [];

  function record(kind, expression) {
    references.push({
      kind,
      specifier: ts.isStringLiteralLike(expression) ? expression.text : null
    });
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

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function containsV1DirectoryReference(specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  return [
    CUTOVER.legacyDirectoryName,
    CUTOVER.preservedV1DirectoryName
  ].some((directoryName) =>
    new RegExp(`(?:^|/)${directoryName}(?:/|$)`, "u")
      .test(normalized)
  );
}

export function validateModuleIsolation(sourceFiles, workerDirectory) {
  assert(isPlainObject(sourceFiles), "sourceFiles must be an object");
  for (const [relativePath, source] of Object.entries(sourceFiles)) {
    assert(typeof source === "string", `${relativePath} source must be text`);
    for (const reference of collectModuleReferences(source, relativePath)) {
      assert(
        reference.specifier !== null,
        `${relativePath} uses a non-literal ${reference.kind}; cutover imports must be statically auditable`
      );
      const specifier = reference.specifier;
      assert(
        !containsV1DirectoryReference(specifier),
        `${relativePath} cross-imports v1 via ${reference.kind}: ${specifier}`
      );
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(
        workerDirectory,
        path.dirname(relativePath),
        specifier
      );
      assert(
        isInside(workerDirectory, resolved),
        `${relativePath} ${reference.kind} escapes the v2 Worker: ${specifier}`
      );
    }
  }
}

function assertCanonicalWorkersDevOrigins(source, label) {
  const origins = source.match(workersDevOriginPattern) ?? [];
  for (const origin of origins) {
    assert(
      origin === CUTOVER.origin,
      `${label} contains a non-canonical Worker origin: ${origin}`
    );
  }
}

export function validateSourceConfiguration({
  constantsSource,
  indexSource,
  sourceFiles,
  workerDirectory
}) {
  assert(typeof constantsSource === "string", "src/constants.ts must be text");
  assert(typeof indexSource === "string", "src/index.ts must be text");
  assert(isPlainObject(sourceFiles), "sourceFiles must be an object");

  const declarationMatches = [
    ...constantsSource.matchAll(
      /\bexport\s+const\s+PUBLIC_ORIGIN\s*=\s*(["'])([^"']+)\1\s*;/gu
    )
  ];
  assert(
    declarationMatches.length === 1
      && declarationMatches[0][2] === CUTOVER.origin,
    `PUBLIC_ORIGIN must be one literal declaration of ${CUTOVER.origin}`
  );

  let publicOriginDeclarations = 0;
  for (const [relativePath, source] of Object.entries(sourceFiles)) {
    assert(
      !forbiddenOriginAliases.test(source),
      `${relativePath} declares or references a forbidden alternate origin`
    );
    forbiddenOriginAliases.lastIndex = 0;
    assert(
      !/\b(?:process\.env|env)\s*(?:\.|\[[^\]]*\])\s*[A-Z0-9_]*(?:ORIGIN|HOST)\b/u
        .test(source),
      `${relativePath} may not derive the public Worker origin from runtime environment`
    );
    assertCanonicalWorkersDevOrigins(source, relativePath);
    publicOriginDeclarations += (
      source.match(/\b(?:const|let|var)\s+PUBLIC_ORIGIN\b/gu) ?? []
    ).length;
  }
  assert(
    publicOriginDeclarations === 1,
    "PUBLIC_ORIGIN must be declared exactly once across deployable source"
  );

  const { identities, resourceNames } = extractMcpIdentities(
    indexSource,
    "src/index.ts"
  );
  assert(identities.length === 1, "src/index.ts must construct exactly one McpServer");
  assert(
    identities[0].name === CUTOVER.mcpName
      && identities[0].version === CUTOVER.mcpVersion,
    `MCP identity must remain ${CUTOVER.mcpName}@${CUTOVER.mcpVersion}`
  );
  assert(
    resourceNames.length === 1 && resourceNames[0] === CUTOVER.mcpName,
    `OAuth resource_name must be exactly ${CUTOVER.mcpName}`
  );

  validateModuleIsolation(sourceFiles, workerDirectory);
}

export function validatePackageConfig(packageJson) {
  assert(isPlainObject(packageJson), "package.json must be an object");
  assert(packageJson.name === CUTOVER.packageName, `package name must be ${CUTOVER.packageName}`);

  for (const sectionName of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies"
  ]) {
    const dependencies = packageJson[sectionName] ?? {};
    assert(isPlainObject(dependencies), `${sectionName} must be an object`);
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      assert(
        !containsV1DirectoryReference(dependencyName),
        `${sectionName} must not depend on v1 package ${dependencyName}`
      );
      if (typeof specifier !== "string") continue;
      assert(
        !/^(?:file|link|workspace):/u.test(specifier),
        `${sectionName}.${dependencyName} must not cross-link another workspace`
      );
      assert(
        !containsV1DirectoryReference(specifier),
        `${sectionName}.${dependencyName} cross-links a v1 directory`
      );
    }
  }

  const scripts = packageJson.scripts ?? {};
  assert(isPlainObject(scripts), "package scripts must be an object");
  for (const [scriptName, command] of Object.entries(scripts)) {
    assert(typeof command === "string", `script ${scriptName} must be text`);
    assertCanonicalWorkersDevOrigins(command, `package script ${scriptName}`);
    assert(
      !containsV1DirectoryReference(command),
      `package script ${scriptName} cross-references a v1 directory`
    );
    for (const match of command.matchAll(
      /--name(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/gu
    )) {
      const target = match[1] ?? match[2] ?? match[3];
      assert(
        target === CUTOVER.workerName,
        `package script ${scriptName} targets Worker ${target}`
      );
    }
    assert(
      !(
        /\bwrangler\s+deploy\b/u.test(command)
        && !/--dry-run\b/u.test(command)
      ),
      `package script ${scriptName} exposes an unqualified live wrangler deploy`
    );
  }
}

function isForbiddenSecretFile(relativePath) {
  const name = path.posix.basename(relativePath.replaceAll("\\", "/")).toLowerCase();
  if (name.endsWith(".example") || name.endsWith(".template")) return false;
  return (
    name === ".env"
    || name.startsWith(".env.")
    || name === ".dev.vars"
    || name.startsWith(".dev.vars.")
    || name === "secrets.json"
    || name.endsWith(".secrets.json")
    || name === "secret.json"
    || name === "credentials.json"
    || name.endsWith(".pem")
    || name.endsWith(".key")
    || name === "id_rsa"
    || name === "id_ed25519"
  );
}

export function validateFilesystemInventory(entries) {
  assert(Array.isArray(entries), "filesystem inventory must be an array");
  for (const entry of entries) {
    assert(isPlainObject(entry), "filesystem inventory contains an invalid entry");
    assert(
      entry.type !== "symlink",
      `symlink is forbidden in v2 cutover source: ${entry.relativePath}`
    );
    if (entry.type === "file") {
      assert(
        !isForbiddenSecretFile(entry.relativePath),
        `secret-bearing file is forbidden in v2 cutover source: ${entry.relativePath}`
      );
    }
  }
}

export function assertFrozenLegacySnapshot(snapshot) {
  assert(isPlainObject(snapshot), "frozen legacy snapshot must be an object");
  assert(snapshot.objectType === "tree", "frozen legacy object must remain a Git tree");
  assert(
    snapshot.committedTree === CUTOVER.frozenLegacyTree,
    `committed v1 tree changed: expected ${CUTOVER.frozenLegacyTree}, got ${String(snapshot.committedTree)}`
  );
  assert(
    snapshot.changedFiles.trim() === "",
    `tracked v1 worktree changed:\n${snapshot.changedFiles.trim()}`
  );
  assert(
    snapshot.untrackedFiles.trim() === "",
    `untracked files exist under frozen v1:\n${snapshot.untrackedFiles.trim()}`
  );
}

async function collectFilesystemInventory(rootDirectory) {
  const rootStat = await lstat(rootDirectory);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "v2 Worker root must be a real directory");
  const entries = [];

  async function visit(directory, relativeDirectory = "") {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = path.posix.join(relativeDirectory, child.name);
      const absolutePath = path.join(directory, child.name);
      const status = await lstat(absolutePath);
      const type = status.isSymbolicLink()
        ? "symlink"
        : status.isDirectory()
          ? "directory"
          : status.isFile()
            ? "file"
            : "other";
      entries.push({ relativePath, type });
      if (
        type === "directory"
        && !(relativeDirectory === "" && skippedRuntimeDirectories.has(child.name))
      ) {
        await visit(absolutePath, relativePath);
      }
    }
  }

  await visit(rootDirectory);
  return entries;
}

function runGit(repositoryRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CutoverConfigError(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export async function verifyCutoverRepository({
  workerDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  )
} = {}) {
  const repositoryRoot = path.resolve(workerDirectory, "..");
  const inventory = await collectFilesystemInventory(workerDirectory);
  validateFilesystemInventory(inventory);

  const snapshot = {
    objectType: runGit(repositoryRoot, [
      "cat-file",
      "-t",
      CUTOVER.frozenLegacyTree
    ]),
    committedTree: runGit(repositoryRoot, [
      "rev-parse",
      `HEAD:${CUTOVER.legacyDirectoryName}`
    ]),
    changedFiles: runGit(repositoryRoot, [
      "diff",
      "--name-only",
      "--no-renames",
      "HEAD",
      "--",
      CUTOVER.legacyDirectoryName
    ]),
    untrackedFiles: runGit(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      CUTOVER.legacyDirectoryName
    ])
  };
  assertFrozenLegacySnapshot(snapshot);

  const legacyWrangler = parseStrictJsonWithUniqueKeys(
    runGit(repositoryRoot, [
      "show",
      `${CUTOVER.frozenLegacyTree}:wrangler.jsonc`
    ]),
    "frozen v1 wrangler.jsonc"
  );
  const wrangler = parseStrictJsonWithUniqueKeys(
    await readFile(path.join(workerDirectory, "wrangler.jsonc"), "utf8"),
    "v2 wrangler.jsonc"
  );
  validateWranglerConfig(wrangler, legacyWrangler);

  const packageJson = parseStrictJsonWithUniqueKeys(
    await readFile(path.join(workerDirectory, "package.json"), "utf8"),
    "v2 package.json"
  );
  validatePackageConfig(packageJson);

  const migrationBaseline = parseStrictJsonWithUniqueKeys(
    await readFile(
      path.join(workerDirectory, "verification", "migration-baseline.json"),
      "utf8"
    ),
    "migration baseline"
  );
  validateMigrationBaseline(migrationBaseline);

  const sourceFiles = {};
  for (const entry of inventory) {
    if (
      entry.type === "file"
      && entry.relativePath.startsWith("src/")
      && sourceExtensions.has(path.extname(entry.relativePath))
    ) {
      sourceFiles[entry.relativePath] = await readFile(
        path.join(workerDirectory, entry.relativePath),
        "utf8"
      );
    }
  }
  const constantsSource = sourceFiles["src/constants.ts"];
  const indexSource = sourceFiles["src/index.ts"];
  validateSourceConfiguration({
    constantsSource,
    indexSource,
    sourceFiles,
    workerDirectory
  });

  return Object.freeze({
    workerName: CUTOVER.workerName,
    origin: CUTOVER.origin,
    frozenLegacyTree: CUTOVER.frozenLegacyTree,
    sourceFileCount: Object.keys(sourceFiles).length
  });
}

const isDirectExecution =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    const result = await verifyCutoverRepository();
    console.log(
      `MCP v2 cutover config verified (${result.workerName}, ${result.origin}, frozen v1 ${result.frozenLegacyTree}).`
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`MCP v2 cutover config verification failed: ${detail}`);
    process.exitCode = 1;
  }
}
