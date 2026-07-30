#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(workerDirectory, "..");
const legacyDirectory = path.join(repositoryRoot, "mycontext-mcp-worker");
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

function dependencyGraph(directory, label) {
  const result = spawnSync(
    "pnpm",
    ["list", "--lockfile-only", "--json", "--depth", "Infinity"],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" }
    }
  );
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    fail(`${label} lock graph could not be read: ${detail}`);
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) {
      fail(`${label} pnpm graph must contain exactly one importer`);
      return null;
    }
    return parsed[0];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`${label} pnpm graph is not valid JSON: ${detail}`);
    return null;
  }
}

function nodeIdentity(node, dependencyName) {
  const packageName = typeof node.from === "string" ? node.from : dependencyName;
  const version = typeof node.version === "string" ? node.version : "<missing>";
  const resolved = typeof node.resolved === "string" ? node.resolved : "";
  let virtualPath = "";
  if (typeof node.path === "string") {
    const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
    const markerIndex = node.path.indexOf(marker);
    if (markerIndex >= 0) {
      virtualPath = node.path.slice(markerIndex + marker.length).split(path.sep).join("/");
    }
  }
  return `${packageName}@${version}|${resolved}|${virtualPath}`;
}

function childDependencies(node) {
  return {
    ...(node.dependencies ?? {}),
    ...(node.optionalDependencies ?? {})
  };
}

function collectClosure(node, dependencyName) {
  const nodes = new Set();
  const edges = new Set();
  const visited = new Set();

  function visit(currentNode, currentName) {
    const currentIdentity = nodeIdentity(currentNode, currentName);
    nodes.add(currentIdentity);
    if (visited.has(currentIdentity)) {
      return;
    }
    visited.add(currentIdentity);
    for (const [childName, childNode] of Object.entries(childDependencies(currentNode))) {
      const childIdentity = nodeIdentity(childNode, childName);
      edges.add(`${currentIdentity} -> ${childName}:${childIdentity}`);
      visit(childNode, childName);
    }
  }

  visit(node, dependencyName);
  return { nodes, edges };
}

function mergeClosures(closures) {
  const merged = { nodes: new Set(), edges: new Set() };
  for (const closure of closures) {
    for (const node of closure.nodes) merged.nodes.add(node);
    for (const edge of closure.edges) merged.edges.add(edge);
  }
  return merged;
}

function setDifference(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

function rootDependencies(graph) {
  return {
    ...(graph?.dependencies ?? {}),
    ...(graph?.devDependencies ?? {})
  };
}

function rootClosure(graph, dependencyNames, label) {
  const roots = rootDependencies(graph);
  const closures = [];
  for (const dependencyName of dependencyNames) {
    const rootNode = roots[dependencyName];
    if (rootNode === undefined) {
      fail(`${label} lock graph is missing direct dependency ${dependencyName}`);
      continue;
    }
    closures.push(collectClosure(rootNode, dependencyName));
  }
  return mergeClosures(closures);
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
for (const scriptName of Object.keys(targetPackage.scripts ?? {})) {
  if (
    !(scriptName in (legacyPackage.scripts ?? {})) &&
    scriptName !== "deploy:dry-run" &&
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

const legacyGraph = dependencyGraph(legacyDirectory, "legacy");
const targetGraph = dependencyGraph(workerDirectory, "v2");
if (legacyGraph !== null && targetGraph !== null) {
  const changedLegacyRoots = ["@modelcontextprotocol/sdk", "agents"];
  const changedTargetRoots = [
    "@modelcontextprotocol/server",
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/sdk",
    "agents"
  ];
  const frozenLegacyRoots = Object.keys(rootDependencies(legacyGraph))
    .filter((name) => !changedLegacyRoots.includes(name))
    .sort();
  const frozenTargetRoots = Object.keys(rootDependencies(targetGraph))
    .filter((name) => !changedTargetRoots.includes(name))
    .sort();

  if (JSON.stringify(frozenLegacyRoots) !== JSON.stringify(frozenTargetRoots)) {
    fail(
      `frozen direct dependency set changed: expected ${frozenLegacyRoots.join(", ")}, got ${frozenTargetRoots.join(", ")}`
    );
  }

  for (const dependencyName of frozenLegacyRoots) {
    const legacyClosure = rootClosure(legacyGraph, [dependencyName], "legacy");
    const targetClosure = rootClosure(targetGraph, [dependencyName], "v2");
    const removedNodes = setDifference(legacyClosure.nodes, targetClosure.nodes);
    const addedNodes = setDifference(targetClosure.nodes, legacyClosure.nodes);
    const removedEdges = setDifference(legacyClosure.edges, targetClosure.edges);
    const addedEdges = setDifference(targetClosure.edges, legacyClosure.edges);
    if (
      removedNodes.length > 0 ||
      addedNodes.length > 0 ||
      removedEdges.length > 0 ||
      addedEdges.length > 0
    ) {
      fail(`transitive closure drifted for frozen dependency ${dependencyName}`);
    }
  }

  const legacyAll = rootClosure(
    legacyGraph,
    Object.keys(rootDependencies(legacyGraph)),
    "legacy"
  );
  const targetAll = rootClosure(
    targetGraph,
    Object.keys(rootDependencies(targetGraph)),
    "v2"
  );
  const legacyAllowed = rootClosure(legacyGraph, changedLegacyRoots, "legacy");
  const targetAllowed = rootClosure(targetGraph, changedTargetRoots, "v2");

  for (const removedNode of setDifference(legacyAll.nodes, targetAll.nodes)) {
    if (!legacyAllowed.nodes.has(removedNode)) {
      fail(`lockfile removed a package outside the changed dependency closure: ${removedNode}`);
    }
  }
  for (const addedNode of setDifference(targetAll.nodes, legacyAll.nodes)) {
    if (!targetAllowed.nodes.has(addedNode)) {
      fail(`lockfile added a package outside the changed dependency closure: ${addedNode}`);
    }
  }
  for (const removedEdge of setDifference(legacyAll.edges, targetAll.edges)) {
    if (!legacyAllowed.edges.has(removedEdge)) {
      fail(`lockfile removed an edge outside the changed dependency closure: ${removedEdge}`);
    }
  }
  for (const addedEdge of setDifference(targetAll.edges, legacyAll.edges)) {
    if (!targetAllowed.edges.has(addedEdge)) {
      fail(`lockfile added an edge outside the changed dependency closure: ${addedEdge}`);
    }
  }

  const targetRoots = rootDependencies(targetGraph);
  for (const [dependencyName, expectedVersion] of Object.entries({
    ...baseline.target.dependencies,
    ...baseline.target.devDependencies
  })) {
    const actualVersion = targetRoots[dependencyName]?.version;
    if (actualVersion !== expectedVersion) {
      fail(
        `resolved ${dependencyName} version must be ${expectedVersion}, got ${actualVersion ?? "<missing>"}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error("MCP v2 dependency drift verification failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "MCP v2 dependency drift verification passed (direct allowlist and frozen dependency closures)."
  );
}
