import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTHOR_STYLE_DOCUMENTS,
  parseAuthorStyleMarkdown,
  type LoadedAuthorStyleDocument
} from "./authorStyle.js";
import { sha256 } from "./hash.js";
import { AppError } from "./types.js";

export interface EmergencySnapshotMetadata {
  document_id: string;
  source: "tidb-current-snapshot";
  source_path_key: string;
  revision_sha256: string;
  markdown_sha256: string;
  source_bytes: number;
  source_line_count: number;
  source_mtime_ms: number;
  parser_version: string;
  sectioning_version: string;
  routing_version: string;
  routing_manifest_sha256: string;
  outline_sha256: string;
  section_count: number;
  delivery_section_count: number;
  search_span_count: number;
  exported_at: string;
  emergency_snapshot: true;
}

export async function writeEmergencyAuthorStyleSnapshot(input: {
  outputPath: string;
  markdown: string;
  metadata: EmergencySnapshotMetadata;
}): Promise<{ markdownPath: string; metadataPath: string }> {
  const markdownPath = path.resolve(input.outputPath);
  if (!markdownPath.endsWith(".md")) {
    throw new AppError("emergency_output_invalid", "emergency output path must end in .md", 3);
  }
  const metadataPath = `${markdownPath}.json`;
  await fs.mkdir(path.dirname(markdownPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(markdownPath, input.markdown, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(metadataPath, `${JSON.stringify(input.metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return { markdownPath, metadataPath };
}

export async function loadEmergencyAuthorStyle(input: {
  inputPath: string;
  documentId: string;
}): Promise<LoadedAuthorStyleDocument> {
  const source = AUTHOR_STYLE_DOCUMENTS.find(
    (candidate) => candidate.documentId === input.documentId
  );
  if (source === undefined) {
    throw new AppError(
      "emergency_document_id_invalid",
      "document-id must be ore-title-style or ore-body-style",
      3
    );
  }
  const inputPath = path.resolve(input.inputPath);
  const metadataPath = `${inputPath}.json`;
  let markdown: string;
  let metadata: EmergencySnapshotMetadata;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    const [metadataJson, loadedMarkdown, loadedStat] = await Promise.all([
      fs.readFile(metadataPath, "utf8"),
      fs.readFile(inputPath, "utf8"),
      fs.stat(inputPath)
    ]);
    metadata = parseEmergencySnapshotMetadata(metadataJson);
    markdown = loadedMarkdown;
    stat = loadedStat;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "emergency_markdown_read_failed",
      `failed to read emergency Markdown and metadata: ${inputPath}`,
      3,
      error
    );
  }

  assertSnapshot(metadata.document_id === input.documentId, "document_id does not match");
  assertSnapshot(metadata.source === "tidb-current-snapshot", "source must be tidb-current-snapshot");
  assertSnapshot(metadata.source_path_key.startsWith("notion:"), "source_path_key must be notion-owned");
  assertSnapshot(metadata.markdown_sha256 === sha256(markdown), "Markdown SHA-256 does not match");
  assertSnapshot(metadata.source_bytes === stat.size, "source byte count does not match");

  const document = parseAuthorStyleMarkdown({
    source,
    markdown,
    sourcePathKey: metadata.source_path_key,
    sourceMtimeMs: metadata.source_mtime_ms,
    sourceBytes: stat.size
  });
  assertSnapshot(document.revisionSha256 === metadata.revision_sha256, "revision SHA-256 does not match");
  assertSnapshot(document.parserVersion === metadata.parser_version, "parser version does not match");
  assertSnapshot(
    document.sectioningVersion === metadata.sectioning_version,
    "sectioning version does not match"
  );
  assertSnapshot(document.routingVersion === metadata.routing_version, "routing version does not match");
  assertSnapshot(
    stableJsonSha256(document.routingManifest) === metadata.routing_manifest_sha256,
    "routing manifest does not match"
  );
  assertSnapshot(stableJsonSha256(document.outline) === metadata.outline_sha256, "outline does not match");
  assertSnapshot(document.sourceLineCount === metadata.source_line_count, "source line count does not match");
  assertSnapshot(document.sectionCount === metadata.section_count, "section count does not match");
  assertSnapshot(
    document.deliverySectionCount === metadata.delivery_section_count,
    "delivery section count does not match"
  );
  assertSnapshot(
    document.searchSpanCount === metadata.search_span_count,
    "search span count does not match"
  );
  return document;
}

export function stableJsonSha256(value: unknown): string {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return sha256(JSON.stringify(stableValue(parsed)));
}

function parseEmergencySnapshotMetadata(value: string): EmergencySnapshotMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new AppError("emergency_metadata_invalid", "emergency metadata is not valid JSON", 3, error);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("emergency_metadata_invalid", "emergency metadata must be an object", 3);
  }
  const metadata = parsed as Record<string, unknown>;
  for (const name of [
    "document_id",
    "source",
    "source_path_key",
    "revision_sha256",
    "markdown_sha256",
    "parser_version",
    "sectioning_version",
    "routing_version",
    "routing_manifest_sha256",
    "outline_sha256",
    "exported_at"
  ]) {
    if (typeof metadata[name] !== "string" || metadata[name] === "") {
      throw new AppError("emergency_metadata_invalid", `${name} must be a non-empty string`, 3);
    }
  }
  for (const name of [
    "source_bytes",
    "source_line_count",
    "source_mtime_ms",
    "section_count",
    "delivery_section_count",
    "search_span_count"
  ]) {
    if (!Number.isInteger(metadata[name]) || Number(metadata[name]) < 0) {
      throw new AppError("emergency_metadata_invalid", `${name} must be a non-negative integer`, 3);
    }
  }
  if (metadata.emergency_snapshot !== true) {
    throw new AppError("emergency_metadata_invalid", "emergency_snapshot must be true", 3);
  }
  return metadata as unknown as EmergencySnapshotMetadata;
}

function assertSnapshot(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AppError("emergency_snapshot_mismatch", message, 3);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}
