import {
  AUTHOR_STYLE_SOURCES,
  parseAuthorStyleMarkdown
} from "../authorStyle.js";
import { compareAuthorStyleNotionMigration } from "../authorStyleNotionPreflight.js";
import { createNotionClientFromEnv } from "../notionClient.js";
import { createTidbClientFromEnv } from "../tidb.js";
import { AppError, toAppError, type CliFlags } from "../types.js";

export async function runPreflightAuthorStyleNotion(flags: CliFlags): Promise<void> {
  const documentId = requiredFlag(flags.documentId, "--document-id");
  const pageId = requiredFlag(flags.pageId, "--page-id");
  const source = AUTHOR_STYLE_SOURCES.find((candidate) => candidate.documentId === documentId);
  if (source === undefined) {
    throw new AppError(
      "preflight_document_id_invalid",
      "document-id must be ore-title-style or ore-body-style",
      3
    );
  }

  const notion = createNotionClientFromEnv();
  const client = createTidbClientFromEnv();
  try {
    const fetched = await notion.fetchNotionMarkdown(pageId);
    if (fetched.truncated || fetched.unknown_block_ids.length > 0) {
      console.log(JSON.stringify({
        status: "notion_markdown_incomplete",
        document_id: documentId,
        page_id: pageId,
        truncated: fetched.truncated,
        unknown_block_ids_count: fetched.unknown_block_ids.length,
        tidb_writes: false,
        notion_writes: false
      }, null, 2));
      return;
    }
    const parsed = parseAuthorStyleMarkdown({
      source,
      markdown: fetched.markdown,
      sourcePathKey: `notion:${pageId}`,
      sourceMtimeMs: 0
    });
    const storedDocument = await client.getAuthorStyleDocument(documentId);
    if (storedDocument === null) {
      console.log(JSON.stringify({
        status: "tidb_current_snapshot_missing",
        document_id: documentId,
        page_id: pageId,
        tidb_writes: false,
        notion_writes: false
      }, null, 2));
      return;
    }
    const sections = await client.listAuthorStyleSections(documentId);
    console.log(JSON.stringify({
      ...compareAuthorStyleNotionMigration({
        notion: parsed,
        tidbDocument: storedDocument,
        tidbSections: sections
      }),
      document_id: documentId,
      page_id: pageId,
      tidb_writes: false,
      notion_writes: false
    }, null, 2));
  } catch (error) {
    throw toAppError(error, "preflight_author_style_failed", "author-style preflight failed", 3);
  } finally {
    await client.close();
  }
}

function requiredFlag(value: string | undefined, name: string): string {
  if (!value) throw new AppError("missing_flag", `${name} is required`, 3);
  return value;
}
