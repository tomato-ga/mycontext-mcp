import path from "node:path";
import { writeEmergencyAuthorStyleSnapshot } from "../emergencyAuthorStyle.js";
import { createTidbClientFromEnv } from "../tidb.js";
import { AppError, toAppError, type CliFlags } from "../types.js";

export async function runExportAuthorStyleMarkdown(flags: CliFlags): Promise<void> {
  const documentId = requiredFlag(flags.documentId, "--document-id");
  const client = createTidbClientFromEnv();
  try {
    const document = await client.getAuthorStyleDocument(documentId);
    if (document === null) {
      throw new AppError(
        "author_style_current_snapshot_missing",
        `current author-style snapshot not found: ${documentId}`,
        3
      );
    }
    const outputPath = flags.outputPath === undefined
      ? path.join(
          flags.outputDir ?? path.join("private-exports", "mycontext", isoDate(new Date())),
          `${documentId}-${document.context_sha256.slice(0, 12)}.md`
        )
      : flags.outputPath;
    const result = await writeEmergencyAuthorStyleSnapshot({
      outputPath,
      markdown: document.source_markdown,
      metadata: {
        document_id: documentId,
        source: "tidb-current-snapshot",
        source_path_key: document.source_path_key,
        revision_sha256: document.context_sha256,
        markdown_sha256: document.source_markdown_sha256,
        exported_at: new Date().toISOString(),
        emergency_snapshot: true
      }
    });
    console.log(JSON.stringify({ status: "ok", ...result }, null, 2));
  } catch (error) {
    throw toAppError(error, "export_author_style_failed", "author-style export failed", 3);
  } finally {
    await client.close();
  }
}

function requiredFlag(value: string | undefined, name: string): string {
  if (!value) throw new AppError("missing_flag", `${name} is required`, 3);
  return value;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
