import type { TidbClient } from "./tidb.js";

export const SKILL_CONTEXT_IDS = [
  "marketing-lean-canvas",
  "resolution-diagnose",
  "resolution-experiment",
  "resolution-future",
  "resolution-issue-depth",
  "resolution-issue-map",
  "resolution-solution",
  "issue-driven-diagnose",
  "issue-driven-identify",
  "issue-driven-message",
  "issue-driven-output",
  "issue-driven-storyboard",
  "issue-driven-storyline"
] as const;

export type SkillContextId = typeof SKILL_CONTEXT_IDS[number];

export const MAX_SKILL_CONTEXT_CHARS = 24_000;
const SOURCE_BOUNDARY = "<!-- mycontext:source-boundary reference.md -->";

export const SKILL_CONTEXT_SELECTION_GUIDE =
  "Map the requested method to one ID: Lean Canvas/lean canvas/リーンキャンバス -> " +
  "marketing-lean-canvas; 解像度を診断/解像度を上げる -> resolution-diagnose; " +
  "課題を深掘り/なぜなぜ -> resolution-issue-depth; 課題の全体像/課題を選ぶ -> " +
  "resolution-issue-map; 解決策/MVPを設計 -> resolution-solution; 検証計画/実験 -> " +
  "resolution-experiment; 未来/ビジョン -> resolution-future; イシューから始める/仕事の価値を診断 -> " +
  "issue-driven-diagnose; イシューを特定 -> issue-driven-identify; イシューを分解/ストーリーライン -> " +
  "issue-driven-storyline; 分析設計/絵コンテ -> issue-driven-storyboard; 分析実行/結果還流 -> " +
  "issue-driven-output; 報告/メッセージを磨く -> issue-driven-message.";

export interface SkillContextDocument {
  skill_id: SkillContextId;
  family: string;
  title: string;
  description: string;
  markdown: string;
  markdown_sha256: string;
  merge_version: string;
  context_chars: number;
  source_manifest: Record<string, unknown>;
  relationships: Record<string, unknown>;
  last_synced_at: string;
}

export class SkillContextDataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SkillContextDataError";
  }
}

export async function getSkillContextDocument(
  client: TidbClient,
  skillId: SkillContextId
): Promise<SkillContextDocument | null> {
  const rows = await client.execute(
    `SELECT
        skill_id,
        family,
        title,
        description,
        source_manifest_json,
        relationships_json,
        markdown,
        markdown_sha256,
        merge_version,
        last_synced_at
      FROM skill_context_documents
      WHERE skill_id = ?
      LIMIT 1`,
    [skillId]
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  try {
    const storedSkillId = requiredString(row.skill_id, "skill_id");
    if (storedSkillId !== skillId || !isSkillContextId(storedSkillId)) {
      throw new SkillContextDataError(`unexpected skill_id: ${storedSkillId}`);
    }
    const markdown = requiredString(row.markdown, "markdown");
    if (markdown.length > MAX_SKILL_CONTEXT_CHARS) {
      throw new SkillContextDataError(
        `skill context ${skillId} is ${markdown.length} chars; maximum is ` +
        `${MAX_SKILL_CONTEXT_CHARS}; no truncation was applied`
      );
    }
    if (countOccurrences(markdown, SOURCE_BOUNDARY) !== 1) {
      throw new SkillContextDataError(
        `skill context ${skillId} must contain exactly one source boundary`
      );
    }
    const mergeVersion = requiredString(row.merge_version, "merge_version");
    if (mergeVersion !== "skill-reference-v1") {
      throw new SkillContextDataError(
        `unsupported skill context merge_version: ${mergeVersion}`
      );
    }

    return {
      skill_id: storedSkillId,
      family: requiredString(row.family, "family"),
      title: requiredString(row.title, "title"),
      description: requiredString(row.description, "description"),
      markdown,
      markdown_sha256: requiredString(row.markdown_sha256, "markdown_sha256"),
      merge_version: mergeVersion,
      context_chars: markdown.length,
      source_manifest: jsonObject(row.source_manifest_json, "source_manifest_json"),
      relationships: jsonObject(row.relationships_json, "relationships_json"),
      last_synced_at: dateToIsoString(row.last_synced_at)
    };
  } catch (error) {
    if (error instanceof SkillContextDataError) {
      throw error;
    }
    throw new SkillContextDataError(
      `skill context ${skillId} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

function isSkillContextId(value: string): value is SkillContextId {
  return SKILL_CONTEXT_IDS.some((skillId) => skillId === value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillContextDataError(`${name} must be a non-empty string`);
  }
  return value;
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SkillContextDataError(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function dateToIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new SkillContextDataError("last_synced_at must be a date or non-empty string");
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
