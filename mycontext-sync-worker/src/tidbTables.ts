import { isEditorKnowledgeWholeDocumentId } from "../../mycontext-sync/src/editorKnowledge.js";
import type {
  ManagedNotionDocument,
  SyncCategory,
  TidbTableName
} from "./types.js";

export const TIDB_TABLES_BY_CATEGORY = {
  "Personal Context": ["notion_pages"],
  "AI Skill": ["notion_pages"],
  "Author Style": [
    "author_style_documents",
    "author_style_current_sections"
  ],
  "Editor Knowledge": [
    "editor_knowledge_documents",
    "editor_knowledge_sections"
  ],
  "Metaskill": [
    "metaskill_documents",
    "metaskill_revisions",
    "metaskill_sections"
  ]
} as const satisfies Record<SyncCategory, readonly TidbTableName[]>;

export const TIDB_TABLES_BY_SCHEMA_VERSION = {
  "personal-context-v1": TIDB_TABLES_BY_CATEGORY["Personal Context"],
  "ai-skill-v1": TIDB_TABLES_BY_CATEGORY["AI Skill"],
  "author-style-v1": TIDB_TABLES_BY_CATEGORY["Author Style"],
  "editor-knowledge-v1": TIDB_TABLES_BY_CATEGORY["Editor Knowledge"],
  "metaskill-v1": TIDB_TABLES_BY_CATEGORY.Metaskill
} as const satisfies Record<string, readonly TidbTableName[]>;

export function tidbTablesForDocument(
  managed: Pick<ManagedNotionDocument, "documentId" | "category" | "schemaVersion">
): readonly TidbTableName[] {
  if (
    managed.schemaVersion === "editor-knowledge-v1"
    && isEditorKnowledgeWholeDocumentId(managed.documentId)
  ) {
    return ["editor_knowledge_documents"];
  }
  return TIDB_TABLES_BY_SCHEMA_VERSION[
    managed.schemaVersion as keyof typeof TIDB_TABLES_BY_SCHEMA_VERSION
  ] ?? TIDB_TABLES_BY_CATEGORY[managed.category];
}
