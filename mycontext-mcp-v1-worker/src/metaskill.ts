export const METASKILL_DOCUMENT_IDS = ["ai-self-strategy"] as const;
export type MetaskillDocumentId = typeof METASKILL_DOCUMENT_IDS[number];

export const METASKILL_TOPICS = [
  "overview",
  "ai-era-shift",
  "structuring",
  "game-shifting",
  "self-modularization",
  "question-verbalization",
  "ai-team",
  "life-strategy",
  "human-redefinition"
] as const;
export const METASKILL_INTENTS = ["understand", "apply", "prompt"] as const;
export const METASKILL_DEPTHS = ["brief", "standard", "deep"] as const;

export type MetaskillTopic = typeof METASKILL_TOPICS[number];
export type MetaskillIntent = typeof METASKILL_INTENTS[number];
export type MetaskillDepth = typeof METASKILL_DEPTHS[number];

export interface MetaskillSelectors {
  documentId: MetaskillDocumentId;
  topic: MetaskillTopic;
  intent: MetaskillIntent;
  depth: MetaskillDepth;
}

export interface MetaskillRoutingManifest {
  schemaVersion: string;
  selectorSchema: {
    topics: string[];
    intents: string[];
    depths: string[];
  };
  routes: Record<string, string[]>;
  maxContextCharsByDepth: Record<string, number>;
  overflowPolicy: "error_no_truncation";
}

export class MetaskillRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetaskillRoutingError";
  }
}

export class MetaskillContextTooLargeError extends RangeError {
  constructor(actual: number, maximum: number) {
    super(`resolved context is ${actual} chars; maximum is ${maximum}; no truncation was applied`);
    this.name = "MetaskillContextTooLargeError";
  }
}

export function toMetaskillDocumentId(value: string): MetaskillDocumentId {
  if (METASKILL_DOCUMENT_IDS.includes(value as MetaskillDocumentId)) {
    return value as MetaskillDocumentId;
  }
  throw new MetaskillRoutingError(`unsupported metaskill document: ${value}`);
}

export function validateMetaskillSelectors(selectors: MetaskillSelectors): void {
  toMetaskillDocumentId(selectors.documentId);
  assertAllowed(METASKILL_TOPICS, selectors.topic, "topic");
  assertAllowed(METASKILL_INTENTS, selectors.intent, "intent");
  assertAllowed(METASKILL_DEPTHS, selectors.depth, "depth");
}

export function parseMetaskillRoutingManifest(value: unknown): MetaskillRoutingManifest {
  const root = requireRecord(value, "routing manifest");
  const selector = requireRecord(root.selectorSchema, "selectorSchema");
  const manifest: MetaskillRoutingManifest = {
    schemaVersion: requireString(root.schemaVersion, "schemaVersion"),
    selectorSchema: {
      topics: requireStringArray(selector.topics, "selectorSchema.topics"),
      intents: requireStringArray(selector.intents, "selectorSchema.intents"),
      depths: requireStringArray(selector.depths, "selectorSchema.depths")
    },
    routes: requireStringArrayMap(root.routes, "routes"),
    maxContextCharsByDepth: requirePositiveIntegerMap(
      root.maxContextCharsByDepth,
      "maxContextCharsByDepth"
    ),
    overflowPolicy: requireOverflowPolicy(root.overflowPolicy)
  };
  return manifest;
}

export function resolveMetaskillContextKeys(
  manifest: MetaskillRoutingManifest,
  selectors: MetaskillSelectors
): string[] {
  validateMetaskillSelectors(selectors);
  assertAllowed(manifest.selectorSchema.topics, selectors.topic, "topic");
  assertAllowed(manifest.selectorSchema.intents, selectors.intent, "intent");
  assertAllowed(manifest.selectorSchema.depths, selectors.depth, "depth");
  const key = `${selectors.topic}:${selectors.intent}:${selectors.depth}`;
  const contextKeys = manifest.routes[key];
  if (contextKeys === undefined || contextKeys.length === 0) {
    throw new MetaskillRoutingError(`unsupported metaskill selector combination: ${key}`);
  }
  return [...new Set(contextKeys)];
}

export function maxMetaskillContextChars(
  manifest: MetaskillRoutingManifest,
  depth: MetaskillDepth
): number {
  const maximum = manifest.maxContextCharsByDepth[depth];
  if (maximum === undefined) throw new MetaskillRoutingError(`depth context limit missing: ${depth}`);
  return maximum;
}

export function buildMetaskillDocumentUri(documentId: string): string {
  return `mycontext://metaskill/${encodeURIComponent(documentId)}`;
}

export function buildMetaskillSectionUri(documentId: string, sectionId: string): string {
  return `${buildMetaskillDocumentUri(documentId)}/sections/${encodeURIComponent(sectionId)}`;
}

function assertAllowed(allowed: readonly string[], value: string, name: string): void {
  if (!allowed.includes(value)) {
    throw new MetaskillRoutingError(`${name} must be one of: ${allowed.join(", ")}`);
  }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MetaskillRoutingError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetaskillRoutingError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new MetaskillRoutingError(`${name} must be a string array`);
  }
  return [...new Set(value as string[])];
}

function requireStringArrayMap(value: unknown, name: string): Record<string, string[]> {
  const record = requireRecord(value, name);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    requireStringArray(item, `${name}.${key}`)
  ]));
}

function requirePositiveIntegerMap(value: unknown, name: string): Record<string, number> {
  const record = requireRecord(value, name);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    if (!Number.isInteger(item) || Number(item) <= 0) {
      throw new MetaskillRoutingError(`${name}.${key} must be a positive integer`);
    }
    return [key, Number(item)];
  }));
}

function requireOverflowPolicy(value: unknown): "error_no_truncation" {
  if (value !== "error_no_truncation") {
    throw new MetaskillRoutingError("overflowPolicy must be error_no_truncation");
  }
  return value;
}
