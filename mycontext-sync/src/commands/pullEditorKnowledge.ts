import {
  EDITOR_KNOWLEDGE_SOURCES,
  editorKnowledgeSourceRootFromEnv
} from "../editorKnowledge.js";
import { syncEditorKnowledgeDocument } from "../syncEditorKnowledge.js";
import { createTidbClientFromEnv } from "../tidb.js";
import {
  AppError,
  errorMessage,
  type CliFlags,
  type EditorKnowledgeDocumentId,
  type EditorKnowledgeSyncResult
} from "../types.js";

export async function runPullEditorKnowledge(flags: CliFlags): Promise<void> {
  const sourceRoot = editorKnowledgeSourceRootFromEnv();
  const tidbClient = flags.dryRun ? null : createTidbClientFromEnv();
  const results: EditorKnowledgeSyncResult[] = [];

  try {
    for (const source of EDITOR_KNOWLEDGE_SOURCES) {
      try {
        const result = await syncEditorKnowledgeDocument({
          sourceRoot,
          source,
          tidbClient,
          dryRun: flags.dryRun,
          reindex: flags.reindex
        });
        results.push(result);
        console.log(JSON.stringify(result));
      } catch (error) {
        const result = failedResult(source.documentId, error);
        results.push(result);
        console.log(JSON.stringify(result));
      }
    }
  } finally {
    await tidbClient?.close();
  }

  const allStatuses = results.map((result) => result.status);
  const failedCount = allStatuses.filter((status) => status === "failed").length;
  console.log(
    JSON.stringify(
      {
        status: failedCount > 0 ? "failed" : "ok",
        documents_total: results.length,
        documents_synced: countStatus(allStatuses, "synced"),
        documents_skipped: countStatus(allStatuses, "skipped"),
        documents_failed: failedCount
      },
      null,
      2
    )
  );

  if (failedCount > 0) {
    throw new AppError("pull_editor_knowledge_failed", `${failedCount} document(s) failed`, 1);
  }
}

function failedResult(documentId: EditorKnowledgeDocumentId, error: unknown): EditorKnowledgeSyncResult {
  const appError = error instanceof AppError
    ? error
    : new AppError("editor_knowledge_sync_failed", errorMessage(error), 1, error);
  return {
    documentId,
    title: null,
    status: "failed",
    markdownSha256: "",
    dbIndexed: false,
    warnings: [`${appError.code}: ${appError.message}`]
  };
}

function countStatus(
  statuses: EditorKnowledgeSyncResult["status"][],
  status: EditorKnowledgeSyncResult["status"]
): number {
  return statuses.filter((candidate) => candidate === status).length;
}
