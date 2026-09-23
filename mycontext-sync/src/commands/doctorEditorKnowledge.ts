import {
  EDITOR_KNOWLEDGE_SOURCES,
  editorKnowledgeSourceRootFromEnv,
  loadEditorKnowledgeDocument
} from "../editorKnowledge.js";
import { createTidbClientFromEnv } from "../tidb.js";
import { errorMessage, type CliFlags, type EditorKnowledgeDocumentId } from "../types.js";

type DoctorStatus =
  | "ok"
  | "source_invalid"
  | "missing_tidb_document"
  | "empty_markdown"
  | "hash_mismatch"
  | "title_mismatch";

interface DoctorEditorKnowledgeResult {
  documentId: EditorKnowledgeDocumentId;
  title: string | null;
  status: DoctorStatus;
  sourceMarkdownSha256: string | null;
  tidbMarkdownSha256: string | null;
  markdownChars: number;
  warnings: string[];
}

export async function runDoctorEditorKnowledge(_flags: CliFlags): Promise<void> {
  const sourceRoot = editorKnowledgeSourceRootFromEnv();
  const client = createTidbClientFromEnv();
  const results: DoctorEditorKnowledgeResult[] = [];

  try {
    await client.ping();
    for (const source of EDITOR_KNOWLEDGE_SOURCES) {
      try {
        const local = await loadEditorKnowledgeDocument(sourceRoot, source);
        const row = await client.getEditorKnowledgeDocument(source.documentId);
        const status: DoctorStatus = row === null
          ? "missing_tidb_document"
          : row.markdown.length === 0
            ? "empty_markdown"
            : row.markdown_sha256 !== local.markdownSha256
              ? "hash_mismatch"
              : row.title !== local.title
                ? "title_mismatch"
                : "ok";
        results.push({
          documentId: source.documentId,
          title: local.title,
          status,
          sourceMarkdownSha256: local.markdownSha256,
          tidbMarkdownSha256: row?.markdown_sha256 ?? null,
          markdownChars: row?.markdown.length ?? 0,
          warnings: []
        });
      } catch (error) {
        results.push({
          documentId: source.documentId,
          title: null,
          status: "source_invalid",
          sourceMarkdownSha256: null,
          tidbMarkdownSha256: null,
          markdownChars: 0,
          warnings: [errorMessage(error)]
        });
      }
    }
  } finally {
    await client.close();
  }

  const failed = results.some((result) => result.status !== "ok");
  console.log(JSON.stringify(
    { status: failed ? "failed" : "ok", documents: results },
    null,
    2
  ));
  if (failed) {
    process.exitCode = 2;
  }
}
