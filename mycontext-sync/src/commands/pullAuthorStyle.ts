import {
  AUTHOR_STYLE_LOCAL_SOURCES,
  authorStyleSourceRootFromEnv
} from "../authorStyle.js";
import {
  syncAuthorStyleDocument,
  type AuthorStyleSyncResult
} from "../syncAuthorStyle.js";
import { createTidbClientFromEnv } from "../tidb.js";
import { AppError, errorMessage, type CliFlags } from "../types.js";

export async function runPullAuthorStyle(flags: CliFlags): Promise<void> {
  const sourceRoot = authorStyleSourceRootFromEnv();
  const client = flags.dryRun ? null : createTidbClientFromEnv();
  const results: AuthorStyleSyncResult[] = [];

  try {
    for (const source of AUTHOR_STYLE_LOCAL_SOURCES) {
      try {
        const result = await syncAuthorStyleDocument({
          sourceRoot,
          source,
          tidbClient: client,
          dryRun: flags.dryRun,
          reindex: flags.reindex
        });
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (error) {
        const result: AuthorStyleSyncResult = {
          documentId: source.documentId,
          displayName: null,
          status: "failed",
          sourceMarkdownSha256: "",
          revisionSha256: "",
          sectionCount: 0,
          deliverySectionCount: 0,
          searchSpanCount: 0,
          dbIndexed: false,
          warnings: [errorMessage(error)]
        };
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } finally {
    await client?.close();
  }

  const failedCount = results.filter((result) => result.status === "failed").length;
  console.log(JSON.stringify({
    status: failedCount === 0 ? "ok" : "failed",
    documents_total: results.length,
    documents_synced: results.filter((result) => result.status === "synced").length,
    documents_skipped: results.filter((result) => result.status === "skipped").length,
    documents_failed: failedCount,
    sections_total: results.reduce((sum, result) => sum + result.sectionCount, 0),
    delivery_sections_total: results.reduce(
      (sum, result) => sum + result.deliverySectionCount,
      0
    ),
    search_spans_total: results.reduce((sum, result) => sum + result.searchSpanCount, 0)
  }, null, 2));

  if (failedCount > 0) {
    throw new AppError(
      "pull_author_style_failed",
      `${failedCount} author style document(s) failed`,
      1
    );
  }
}
