import fs from "node:fs/promises";
import path from "node:path";
import {
  AUTHOR_STYLE_SOURCES,
  parseAuthorStyleMarkdown,
  type LoadedAuthorStyleDocument
} from "./authorStyle.js";
import { AppError } from "./types.js";

export interface EmergencySnapshotMetadata {
  document_id: string;
  source: "tidb-current-snapshot" | "tidb-active-revision";
  source_path_key: string;
  revision_sha256: string;
  markdown_sha256: string;
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
  const source = AUTHOR_STYLE_SOURCES.find((candidate) => candidate.documentId === input.documentId);
  if (source === undefined) {
    throw new AppError(
      "emergency_document_id_invalid",
      "document-id must be ore-title-style or ore-body-style",
      3
    );
  }
  const inputPath = path.resolve(input.inputPath);
  let markdown: string;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [markdown, stat] = await Promise.all([fs.readFile(inputPath, "utf8"), fs.stat(inputPath)]);
  } catch (error) {
    throw new AppError(
      "emergency_markdown_read_failed",
      `failed to read emergency Markdown: ${inputPath}`,
      3,
      error
    );
  }
  return parseAuthorStyleMarkdown({
    source,
    markdown,
    sourcePathKey: `emergency:${inputPath}`,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    sourceBytes: stat.size
  });
}
