export const AUTHOR_STYLE_DOCUMENT_IDS = ["ore-title-style", "ore-body-style"] as const;
export type AuthorStyleDocumentId = typeof AUTHOR_STYLE_DOCUMENT_IDS[number];

export const TITLE_OPERATIONS = ["generate", "evaluate"] as const;
export const BODY_OPERATIONS = ["generate", "edit-voice", "edit-structure", "evaluate"] as const;
export const TITLE_MODES = [
  "news",
  "reaction-explanation",
  "uncertainty",
  "experience",
  "interview",
  "practical",
  "sale",
  "narrative"
] as const;
export const BODY_MODES = ["short-news", "explanatory", "review", "interview", "translation"] as const;
export const LENGTH_BANDS = ["le600", "601-1000", "1001-2000", "2001plus"] as const;
export const AUTHOR_STYLE_PROFILES = ["neutral", "classic", "modern", "media-specific"] as const;

export interface AuthorStyleSelectors {
  documentId: AuthorStyleDocumentId;
  operation: string;
  mode: string;
  lengthBand?: string;
  profile: string;
}

export interface AuthorStyleRoutingManifest {
  schemaVersion: string;
  selectorSchema: {
    operations: string[];
    modes: string[];
    lengthBands?: string[];
    profiles: string[];
  };
  modeMap: Record<string, string[]>;
  operations: Record<string, { base: string[] }>;
  lengthBandMap?: Record<string, string[]>;
  profileMap: Record<string, string[]>;
  maxContextChars: number;
  overflowPolicy: "error_no_truncation";
}

export class AuthorStyleRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorStyleRoutingError";
  }
}

export class AuthorStyleContextTooLargeError extends RangeError {
  constructor(actual: number, maximum: number) {
    super(`resolved context is ${actual} chars; maximum is ${maximum}; no truncation was applied`);
    this.name = "AuthorStyleContextTooLargeError";
  }
}

export function toAuthorStyleDocumentId(value: string): AuthorStyleDocumentId {
  if (AUTHOR_STYLE_DOCUMENT_IDS.includes(value as AuthorStyleDocumentId)) {
    return value as AuthorStyleDocumentId;
  }
  throw new AuthorStyleRoutingError(`unsupported author style document: ${value}`);
}

export function validateAuthorStyleSelectors(selectors: AuthorStyleSelectors): void {
  const isTitle = selectors.documentId === "ore-title-style";
  assertAllowed(
    isTitle ? TITLE_OPERATIONS : BODY_OPERATIONS,
    selectors.operation,
    "operation"
  );
  assertAllowed(isTitle ? TITLE_MODES : BODY_MODES, selectors.mode, "mode");
  assertAllowed(
    isTitle ? AUTHOR_STYLE_PROFILES.slice(0, 3) : AUTHOR_STYLE_PROFILES,
    selectors.profile,
    "profile"
  );
  if (isTitle && selectors.lengthBand !== undefined) {
    throw new AuthorStyleRoutingError("lengthBand is not supported for ore-title-style");
  }
  if (!isTitle) {
    if (selectors.lengthBand === undefined) {
      throw new AuthorStyleRoutingError("lengthBand is required for ore-body-style");
    }
    assertAllowed(LENGTH_BANDS, selectors.lengthBand, "lengthBand");
  }
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
  return manifest;
}

export function resolveAuthorStyleContextKeys(
  manifest: AuthorStyleRoutingManifest,
  selectors: AuthorStyleSelectors
): string[] {
  validateAuthorStyleSelectors(selectors);
  assertAllowed(manifest.selectorSchema.operations, selectors.operation, "operation");
  assertAllowed(manifest.selectorSchema.modes, selectors.mode, "mode");
  assertAllowed(manifest.selectorSchema.profiles, selectors.profile, "profile");
  const base = requireMapValue(manifest.operations, selectors.operation, "operation").base;
  const mode = requireMapValue(manifest.modeMap, selectors.mode, "mode");
  const profile = requireMapValue(manifest.profileMap, selectors.profile, "profile");
  let lengthBand: string[] = [];
  if (manifest.selectorSchema.lengthBands !== undefined) {
    if (selectors.lengthBand === undefined) {
      throw new AuthorStyleRoutingError("lengthBand is required by the stored routing manifest");
    }
    assertAllowed(manifest.selectorSchema.lengthBands, selectors.lengthBand, "lengthBand");
    lengthBand = requireMapValue(
      manifest.lengthBandMap ?? {},
      selectors.lengthBand,
      "lengthBand"
    );
  }
  return [...new Set([...base, ...mode, ...lengthBand, ...profile])];
}

export function buildAuthorStyleDocumentUri(documentId: string): string {
  return `mycontext://author-style/${encodeURIComponent(documentId)}`;
}

export function buildAuthorStyleSectionUri(documentId: string, sectionId: string): string {
  return `${buildAuthorStyleDocumentUri(documentId)}/sections/${encodeURIComponent(sectionId)}`;
}

function assertAllowed(allowed: readonly string[], value: string, name: string): void {
  if (!allowed.includes(value)) {
    throw new AuthorStyleRoutingError(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function requireMapValue<T>(map: Record<string, T>, key: string, name: string): T {
  const value = map[key];
  if (value === undefined) throw new AuthorStyleRoutingError(`${name} map missing ${key}`);
  return value;
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
    throw new AuthorStyleRoutingError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AuthorStyleRoutingError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new AuthorStyleRoutingError(`${name} must be a string array`);
  }
  return [...new Set(value as string[])];
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new AuthorStyleRoutingError(`${name} must be a positive integer`);
  }
  return Number(value);
}

function requireOverflowPolicy(value: unknown): "error_no_truncation" {
  if (value !== "error_no_truncation") {
    throw new AuthorStyleRoutingError("overflowPolicy must be error_no_truncation");
  }
  return value;
}
