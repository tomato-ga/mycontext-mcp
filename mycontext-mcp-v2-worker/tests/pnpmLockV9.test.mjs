import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareLockMigration,
  parsePnpmLockV9,
  rootClosure
} from "../scripts/pnpm-lock-v9.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerDirectory = path.resolve(testDirectory, "..");
const repositoryRoot = path.resolve(workerDirectory, "..");
const baseline = JSON.parse(
  readFileSync(
    path.join(workerDirectory, "verification", "migration-baseline.json"),
    "utf8"
  )
);
const legacyLock = execFileSync(
  "git",
  [
    "show",
    `${baseline.legacy.sourceCommit}:mycontext-mcp-worker/pnpm-lock.yaml`
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  }
);
const targetLock = readFileSync(
  path.join(workerDirectory, "pnpm-lock.yaml"),
  "utf8"
);
const legacyAllowedRoots = ["@modelcontextprotocol/sdk", "agents"];
const targetAllowedRoots = [
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/client",
  "@modelcontextprotocol/sdk",
  "agents"
];
const expectedTargetVersions = {
  ...baseline.target.dependencies,
  ...baseline.target.devDependencies
};
const expectedTargetRoots = {
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
    specifier: baseline.target.devDependencies["@modelcontextprotocol/client"]
  },
  "@modelcontextprotocol/sdk": {
    group: "devDependencies",
    specifier: baseline.target.devDependencies["@modelcontextprotocol/sdk"]
  }
};

function compareLocks(legacyContents = legacyLock, targetContents = targetLock) {
  const legacyGraph = parsePnpmLockV9(legacyContents, "test legacy lock");
  const targetGraph = parsePnpmLockV9(targetContents, "test target lock");
  const frozenRoots = [...legacyGraph.roots.keys()]
    .filter((name) => !legacyAllowedRoots.includes(name))
    .sort();
  return {
    legacyGraph,
    targetGraph,
    result: compareLockMigration({
      legacyGraph,
      targetGraph,
      legacyAllowedRoots,
      targetAllowedRoots,
      frozenRoots,
      expectedTargetVersions,
      expectedTargetRoots
    })
  };
}

function replaceRecord(contents, sectionName, recordKey, transform) {
  const sectionStart = contents.indexOf(`\n${sectionName}:\n`);
  if (sectionStart < 0) {
    throw new Error(`missing section ${sectionName}`);
  }
  const recordMarkers = [
    `\n  ${recordKey}:`,
    `\n  '${recordKey.replaceAll("'", "''")}':`
  ];
  const recordStart = recordMarkers
    .map((marker) => contents.indexOf(marker, sectionStart))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (recordStart < 0) {
    throw new Error(`missing ${sectionName} record ${recordKey}`);
  }
  const remainder = contents.slice(recordStart + 1);
  const nextRecordMatch = /\n  \S/gu.exec(remainder);
  const nextRecord =
    nextRecordMatch === null
      ? -1
      : recordStart + 1 + nextRecordMatch.index;
  const nextSectionMatch = /\n[a-zA-Z][A-Za-z]*:\n/gu;
  nextSectionMatch.lastIndex = recordStart + 1;
  const nextSection = nextSectionMatch.exec(contents)?.index ?? contents.length;
  const recordEnd =
    nextRecord >= 0 && nextRecord < nextSection ? nextRecord : nextSection;
  const record = contents.slice(recordStart, recordEnd);
  const changed = transform(record);
  if (changed === record) {
    throw new Error(`transform did not change ${sectionName} record ${recordKey}`);
  }
  return contents.slice(0, recordStart) + changed + contents.slice(recordEnd);
}

function changeIntegrity(contents, packageKey) {
  return replaceRecord(contents, "packages", packageKey, (record) =>
    record.replace(/integrity: sha512-([A-Za-z0-9+/])/u, (_match, first) => {
      const replacement = first === "A" ? "B" : "A";
      return `integrity: sha512-${replacement}`;
    })
  );
}

const peerFixture = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      root-a:
        specifier: 1.0.0
        version: 1.0.0
      root-b:
        specifier: 1.0.0
        version: 1.0.0

packages:

  foo@1.0.0:
    resolution: {integrity: sha512-foo}

  peer@1.0.0:
    resolution: {integrity: sha512-peer-one}

  peer@2.0.0:
    resolution: {integrity: sha512-peer-two}

  root-a@1.0.0:
    resolution: {integrity: sha512-root-a}

  root-b@1.0.0:
    resolution: {integrity: sha512-root-b}

snapshots:

  foo@1.0.0(peer@1.0.0):
    dependencies:
      peer: 1.0.0

  foo@1.0.0(peer@2.0.0):
    dependencies:
      peer: 2.0.0

  peer@1.0.0: {}

  peer@2.0.0: {}

  root-a@1.0.0:
    dependencies:
      foo: 1.0.0(peer@1.0.0)

  root-b@1.0.0:
    optionalDependencies:
      foo: 1.0.0(peer@2.0.0)
`;

describe("pnpm lock v9 dependency migration verifier", () => {
  it("accepts the real baseline-to-v2 migration without node_modules input", () => {
    const { result } = compareLocks();
    expect(result.errors).toEqual([]);
    expect(result.stats).toMatchObject({
      legacySnapshots: 330,
      targetSnapshots: 330,
      legacyEdges: 496,
      targetEdges: 503,
      legacyAllowedExclusive: 163,
      targetAllowedExclusive: 163,
      frozenRoots: 9
    });
  });

  it("normalizes CRLF without changing the graph", () => {
    const lf = parsePnpmLockV9(targetLock, "lf");
    const crlf = parsePnpmLockV9(
      targetLock.replaceAll("\n", "\r\n"),
      "crlf"
    );
    expect(crlf.settings.digest).toBe(lf.settings.digest);
    expect([...crlf.roots.entries()]).toEqual([...lf.roots.entries()]);
    expect(crlf.snapshots.size).toBe(lf.snapshots.size);
  });

  it("keeps peer variants distinct and traverses optional edges", () => {
    const graph = parsePnpmLockV9(peerFixture, "peer fixture");
    expect(graph.ownership.get("foo@1.0.0")).toEqual(
      new Set([
        "foo@1.0.0(peer@1.0.0)",
        "foo@1.0.0(peer@2.0.0)"
      ])
    );
    const closure = rootClosure(graph, ["root-b"]);
    expect(closure.nodes).toContain("foo@1.0.0(peer@2.0.0)");
    expect([...closure.edges]).toContain(
      "root-b@1.0.0 -> optionalDependency:foo:foo@1.0.0(peer@2.0.0)"
    );
  });

  it("rejects frozen package integrity drift", () => {
    const changed = changeIntegrity(targetLock, "zod@4.4.3");
    const { result } = compareLocks(legacyLock, changed);
    expect(result.errors).toContain(
      "lockfile changed protected package metadata zod@4.4.3"
    );
  });

  it("rejects a changed edge shared by allowed and frozen roots", () => {
    const targetGraph = parsePnpmLockV9(targetLock, "target");
    const viteSnapshot = `vite@${targetGraph.roots.get("vite").version}`;
    const changed = replaceRecord(
      targetLock,
      "snapshots",
      viteSnapshot,
      (record) =>
        record.replace(
          "    dependencies:\n",
          "    dependencies:\n      zod: 4.4.3\n"
        )
    );
    const comparison = compareLocks(legacyLock, changed);
    expect(comparison.result.errors).toContain(
      `lockfile changed protected snapshot ${viteSnapshot}`
    );
  });

  it("allows record changes confined to the target MCP-only closure", () => {
    const changed = changeIntegrity(
      targetLock,
      "@modelcontextprotocol/core@2.0.0"
    );
    expect(compareLocks(legacyLock, changed).result.errors).toEqual([]);
  });

  it("rejects an allowed root moved to the wrong importer group", () => {
    const serverEntry = `      '@modelcontextprotocol/server':
        specifier: 2.0.0
        version: 2.0.0
`;
    const changed = targetLock
      .replace(serverEntry, "")
      .replace(
        "    devDependencies:\n",
        `    devDependencies:\n${serverEntry}`
      );
    expect(compareLocks(legacyLock, changed).result.errors).toContain(
      "target direct dependency @modelcontextprotocol/server must be dependencies 2.0.0"
    );
  });

  it("rejects an allowed root with an unexpected importer specifier", () => {
    const changed = targetLock.replace(
      `      '@modelcontextprotocol/server':
        specifier: 2.0.0`,
      `      '@modelcontextprotocol/server':
        specifier: '*'`
    );
    expect(compareLocks(legacyLock, changed).result.errors).toContain(
      "target direct dependency @modelcontextprotocol/server must be dependencies 2.0.0"
    );
  });

  it("rejects orphan package and snapshot records", () => {
    const withPackage = targetLock.replace(
      "\nsnapshots:\n",
      `
  orphan@1.0.0:
    resolution: {integrity: sha512-orphan}

snapshots:
`
    );
    const changed = `${withPackage.trimEnd()}

  orphan@1.0.0: {}
`;
    expect(() => parsePnpmLockV9(changed, "orphan")).toThrow(
      /orphan snapshot orphan@1\.0\.0/u
    );
  });

  it("rejects already-complete alias or scoped depPath references", () => {
    const changed = replaceRecord(
      targetLock,
      "snapshots",
      "@modelcontextprotocol/core@2.0.0",
      (record) => record.replace("      zod: 4.4.3", "      alias: zod@4.4.3")
    );
    expect(() => parsePnpmLockV9(changed, "alias reference")).toThrow(
      /unsupported dependency reference zod@4\.4\.3/u
    );
  });

  it.each([
    [
      "an extra flow close",
      (record) => record.replace("}\n", "}}\n"),
      /content after a flow collection|unmatched flow delimiter/u
    ],
    [
      "content after a flow collection",
      (record) => record.replace("}\n", "}junk\n"),
      /content after a flow collection/u
    ],
    [
      "an empty flow mapping entry",
      (record) =>
        record.replace(
          "resolution: {integrity: ",
          "resolution: {integrity: placeholder,, second: "
        ),
      /empty flow mapping entry/u
    ],
    [
      "an empty flow sequence entry",
      (record) => `${record}\n    cpu: [x64,,arm64]`,
      /empty flow sequence entry/u
    ],
    [
      "an invalid quoted flow value",
      (record) =>
        record.replace(
          /resolution: \{integrity: [^}]+\}/u,
          'resolution: {integrity: "bad\\q"}'
        ),
      /invalid double-quoted scalar/u
    ],
    [
      "an unterminated flow sequence",
      (record) => `${record}\n    cpu: [x64`,
      /unterminated flow delimiter/u
    ],
    [
      "a second plain mapping separator",
      (record) => `${record}\n    deprecated: foo: bar`,
      /ambiguous plain-scalar mapping separator/u
    ],
    [
      "an invalid single-quoted scalar",
      (record) => `${record}\n    deprecated: 'foo' 'bar'`,
      /invalid single-quoted scalar/u
    ],
    [
      "an explicit YAML tag",
      (record) => `${record}\n    deprecated: !!str foo`,
      /unsupported YAML anchor, alias, or tag/u
    ],
    [
      "a Unicode YAML anchor and alias",
      (record) => `${record}\n    deprecated: &é value\n    name: *é`,
      /unsupported YAML anchor, alias, or tag/u
    ]
  ])("rejects allowed-only package metadata with %s", (_name, mutate, expected) => {
    const changed = replaceRecord(
      targetLock,
      "packages",
      "@modelcontextprotocol/core@2.0.0",
      mutate
    );
    expect(() => parsePnpmLockV9(changed, "ambiguous package metadata")).toThrow(
      expected
    );
  });

  it("rejects implicit-type dependency keys instead of modeling YAML coercion", () => {
    const changed = replaceRecord(
      targetLock,
      "snapshots",
      "@modelcontextprotocol/core@2.0.0",
      (record) =>
        record.replace(
          "    dependencies:\n",
          "    dependencies:\n      1: 1.0.0\n      01: 1.0.0\n"
        )
    );
    expect(() => parsePnpmLockV9(changed, "implicit key")).toThrow(
      /uses implicit-type mapping key 1/u
    );
  });

  it("rejects peer suffixes on package metadata keys", () => {
    const changed = peerFixture.replace(
      "  foo@1.0.0:\n",
      "  foo@1.0.0(peer@1.0.0):\n"
    );
    expect(() => parsePnpmLockV9(changed, "peer package key")).toThrow(
      /package metadata key foo@1\.0\.0\(peer@1\.0\.0\) must not contain a peer suffix/u
    );
  });

  it.each(["evil@x", "..", "_hidden", "Upper"])(
    "rejects dependency-map key %s because it is not an npm package name",
    (dependencyName) => {
    const changed = replaceRecord(
      targetLock,
      "snapshots",
      "@modelcontextprotocol/core@2.0.0",
      (record) =>
        record.replace(
          "    dependencies:\n",
            `    dependencies:\n      '${dependencyName}': 1.0.0\n`
        )
    );
    expect(() => parsePnpmLockV9(changed, "bad dependency name")).toThrow(
        `has unsupported package name ${dependencyName}`
    );
    }
  );

  it.each([
    [
      "unsupported lock version",
      targetLock.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'"),
      /lockfileVersion must be 9\.0/u
    ],
    [
      "duplicate top-level key",
      `${targetLock}\nsettings:\n`,
      /repeats mapping key settings|repeats top-level key settings/u
    ],
    [
      "unknown top-level key",
      `${targetLock}\nmystery:\n`,
      /unknown top-level key mystery/u
    ],
    [
      "YAML anchor",
      targetLock.replace("settings:\n", "settings: &shared\n"),
      /unsupported YAML anchor/u
    ],
    [
      "non-registry dependency reference",
      targetLock.replace(
        "        version: 2.0.0\n",
        "        version: link:../server\n"
      ),
      /unsupported dependency reference/u
    ],
    [
      "YAML comment",
      targetLock.replace(
        "  autoInstallPeers: true",
        "  autoInstallPeers: true # override"
      ),
      /contains a YAML comment/u
    ],
    [
      "duplicate flow mapping key",
      targetLock.replace(
        "resolution: {integrity: sha512-",
        "resolution: {integrity: sha512-placeholder, integrity: sha512-"
      ),
      /repeats flow mapping key integrity/u
    ],
    [
      "children below an inline empty record",
      targetLock.replace(
        "  zod@4.4.3: {}",
        "  zod@4.4.3: {}\n    dependencies:\n      zod: 4.4.3"
      ),
      /inline empty record zod@4\.4\.3 cannot have children/u
    ],
    [
      "non-scalar transitive peer dependency",
      targetLock.replace(
        "      - supports-color",
        "      - [supports-color]"
      ),
      /unsupported block sequence item/u
    ]
  ])("fails closed for %s", (_name, contents, expected) => {
    expect(() => parsePnpmLockV9(contents, "invalid")).toThrow(expected);
  });
});
