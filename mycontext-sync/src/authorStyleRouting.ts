import { AppError } from "./types.js";

export interface AuthorStyleSelectorSchema {
  operations: string[];
  modes: string[];
  lengthBands?: string[];
  profiles: string[];
}

export interface AuthorStyleRoutingManifest {
  schemaVersion: string;
  selectorSchema: AuthorStyleSelectorSchema;
  modeMap: Record<string, string[]>;
  operations: Record<string, { base: string[] }>;
  lengthBandMap?: Record<string, string[]>;
  profileMap: Record<string, string[]>;
  maxContextChars: number;
  overflowPolicy: "error_no_truncation";
}

export interface AuthorStyleSelectors {
  operation: string;
  mode: string;
  lengthBand?: string;
  profile: string;
}

export interface AuthorStyleContextSection {
  contextKey: string;
  title: string;
  markdown: string;
}

export interface BuiltAuthorStyleContext {
  contextKeys: string[];
  markdown: string;
  contextChars: number;
}

export function parseAuthorStyleRoutingManifest(value: unknown): AuthorStyleRoutingManifest {
  const root = requireRecord(value, "routing manifest");
  const selector = requireRecord(root.selectorSchema, "selectorSchema");
  const manifest: AuthorStyleRoutingManifest = {
    schemaVersion: requireString(root.schemaVersion, "schemaVersion"),
    selectorSchema: {
      operations: requireStringArray(selector.operations, "selectorSchema.operations"),
      modes: requireStringArray(selector.modes, "selectorSchema.modes"),
      profiles: requireStringArray(selector.profiles, "selectorSchema.profiles"),
      ...(selector.lengthBands === undefined
        ? {}
        : { lengthBands: requireStringArray(selector.lengthBands, "selectorSchema.lengthBands") })
    },
    modeMap: requireStringArrayMap(root.modeMap, "modeMap"),
    operations: requireOperationMap(root.operations),
    profileMap: requireStringArrayMap(root.profileMap, "profileMap"),
    maxContextChars: requirePositiveInteger(root.maxContextChars, "maxContextChars"),
    overflowPolicy: requireOverflowPolicy(root.overflowPolicy)
  };
  if (root.lengthBandMap !== undefined) {
    manifest.lengthBandMap = requireStringArrayMap(root.lengthBandMap, "lengthBandMap");
  }
  assertManifestMapCoverage(manifest);
  return manifest;
}

export function resolveAuthorStyleContextKeys(
  manifest: AuthorStyleRoutingManifest,
  selectors: AuthorStyleSelectors,
  includeProfileRouting = true
): string[] {
  assertSelector(manifest.selectorSchema.operations, selectors.operation, "operation");
  assertSelector(manifest.selectorSchema.modes, selectors.mode, "mode");
  assertSelector(manifest.selectorSchema.profiles, selectors.profile, "profile");

  const base = manifest.operations[selectors.operation]?.base;
  const mode = manifest.modeMap[selectors.mode];
  const profile = manifest.profileMap[selectors.profile];
  if (base === undefined || mode === undefined || profile === undefined) {
    throw new AppError("author_style_routing_incomplete", "author style routing map is incomplete", 3);
  }

  let lengthBand: string[] = [];
  const configuredLengthBands = manifest.selectorSchema.lengthBands;
  if (configuredLengthBands !== undefined) {
    if (selectors.lengthBand === undefined) {
      throw new AppError(
        "author_style_selector_missing",
        "lengthBand is required for this author style document",
        3
      );
    }
    assertSelector(configuredLengthBands, selectors.lengthBand, "lengthBand");
    lengthBand = manifest.lengthBandMap?.[selectors.lengthBand] ?? [];
  } else if (selectors.lengthBand !== undefined) {
    throw new AppError(
      "author_style_selector_unsupported",
      "lengthBand is not supported for this author style document",
      3
    );
  }

  return [...new Set([
    ...base,
    ...mode,
    ...lengthBand,
    ...(includeProfileRouting ? profile : [])
  ])];
}

export function enumerateAuthorStyleSelectors(
  manifest: AuthorStyleRoutingManifest
): AuthorStyleSelectors[] {
  const lengthBands = manifest.selectorSchema.lengthBands ?? [undefined];
  const combinations: AuthorStyleSelectors[] = [];
  for (const operation of manifest.selectorSchema.operations) {
    for (const mode of manifest.selectorSchema.modes) {
      for (const lengthBand of lengthBands) {
        for (const profile of manifest.selectorSchema.profiles) {
          combinations.push({
            operation,
            mode,
            profile,
            ...(lengthBand === undefined ? {} : { lengthBand })
          });
        }
      }
    }
  }
  return combinations;
}

export function buildAuthorStyleContext(input: {
  documentId: string;
  displayName: string;
  revisionSha256: string;
  manifest: AuthorStyleRoutingManifest;
  selectors: AuthorStyleSelectors;
  sections: ReadonlyMap<string, AuthorStyleContextSection>;
}): BuiltAuthorStyleContext {
  const contextKeys = resolveAuthorStyleContextKeys(
    input.manifest,
    input.selectors,
    input.documentId === "ore-title-style"
  );
  const selected = contextKeys.map((contextKey) => {
    const section = input.sections.get(contextKey);
    if (section === undefined) {
      throw new AppError(
        "author_style_context_key_missing",
        `missing routed context key: ${contextKey}`,
        3
      );
    }
    return section;
  });
  const selectorSummary = [
    `operation=${input.selectors.operation}`,
    `mode=${input.selectors.mode}`,
    ...(input.selectors.lengthBand === undefined
      ? []
      : [`lengthBand=${input.selectors.lengthBand}`]),
    `profile=${input.selectors.profile}`
  ].join(", ");
  const header = [
    `# ${input.displayName} — AI context pack`,
    "",
    `- document: ${input.documentId}`,
    `- revision: ${input.revisionSha256}`,
    `- selectors: ${selectorSummary}`,
    "- policy: selected semantic sections are complete; no section is truncated"
  ].join("\n");
  const markdown = [header, ...selected.map((section) => section.markdown)].join("\n\n");
  if (markdown.length > input.manifest.maxContextChars) {
    throw new AppError(
      "author_style_context_too_large",
      `resolved context is ${markdown.length} chars; maximum is ${input.manifest.maxContextChars}`,
      3
    );
  }
  return { contextKeys, markdown, contextChars: markdown.length };
}

function assertManifestMapCoverage(manifest: AuthorStyleRoutingManifest): void {
  for (const operation of manifest.selectorSchema.operations) {
    if (manifest.operations[operation] === undefined) {
      throw new AppError("author_style_manifest_invalid", `operation map missing ${operation}`, 3);
    }
  }
  for (const mode of manifest.selectorSchema.modes) {
    if (manifest.modeMap[mode] === undefined) {
      throw new AppError("author_style_manifest_invalid", `mode map missing ${mode}`, 3);
    }
  }
  for (const profile of manifest.selectorSchema.profiles) {
    if (manifest.profileMap[profile] === undefined) {
      throw new AppError("author_style_manifest_invalid", `profile map missing ${profile}`, 3);
    }
  }
  for (const lengthBand of manifest.selectorSchema.lengthBands ?? []) {
    if (manifest.lengthBandMap?.[lengthBand] === undefined) {
      throw new AppError("author_style_manifest_invalid", `length band map missing ${lengthBand}`, 3);
    }
  }
}

function assertSelector(allowed: string[], value: string, name: string): void {
  if (!allowed.includes(value)) {
    throw new AppError(
      "author_style_selector_invalid",
      `${name} must be one of: ${allowed.join(", ")}`,
      3
    );
  }
}

function requireOperationMap(value: unknown): Record<string, { base: string[] }> {
  const record = requireRecord(value, "operations");
  return Object.fromEntries(Object.entries(record).map(([key, operation]) => {
    const parsed = requireRecord(operation, `operations.${key}`);
    return [key, { base: requireStringArray(parsed.base, `operations.${key}.base`) }];
  }));
}

function requireStringArrayMap(value: unknown, name: string): Record<string, string[]> {
  const record = requireRecord(value, name);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    requireStringArray(item, `${name}.${key}`)
  ]));
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("author_style_manifest_invalid", `${name} must be an object`, 3);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AppError("author_style_manifest_invalid", `${name} must be a string`, 3);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new AppError("author_style_manifest_invalid", `${name} must be a string array`, 3);
  }
  return [...new Set(value as string[])];
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new AppError("author_style_manifest_invalid", `${name} must be a positive integer`, 3);
  }
  return Number(value);
}

function requireOverflowPolicy(value: unknown): "error_no_truncation" {
  if (value !== "error_no_truncation") {
    throw new AppError(
      "author_style_manifest_invalid",
      "overflowPolicy must be error_no_truncation",
      3
    );
  }
  return value;
}
