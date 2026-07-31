import { normalizeSearchText } from "./searchQuery.js";

export interface EditorTrainingSearchIntent {
  documentId: string;
  sourceId: string;
  canonicalTitle: string;
  resourceUri: string;
}

function buildEditorTrainingIntent(
  sourceId: string,
  canonicalTitle: string
): EditorTrainingSearchIntent {
  return {
    documentId: `editor-knowledge:${sourceId}`,
    sourceId,
    canonicalTitle,
    resourceUri: `mycontext://editor-knowledge/${sourceId}`
  };
}

/**
 * Routes explicit editor-training topics to their canonical lesson documents.
 *
 * These short training documents otherwise compete with newer, much larger knowledge
 * collections that repeat common words such as 企画, 方法, and 編集. The route is intentionally
 * narrow: it requires a distinctive lesson topic, while generic queries continue through the
 * ranked search path.
 */
export function resolveEditorTrainingSearchIntent(
  query: string
): EditorTrainingSearchIntent | null {
  const compactQuery = normalizeSearchText(query)
    .toLocaleLowerCase("ja")
    .replace(/[\s　_-]+/gu, "");

  if (compactQuery.includes("編集会議")) {
    return buildEditorTrainingIntent("lesson-06", "第6回: 編集会議");
  }

  const mentionsWebMedia =
    compactQuery.includes("ウェブメディア") ||
    compactQuery.includes("webメディア");
  const asksForFundamentals = ["基礎", "基本", "仕組み"].some((term) =>
    compactQuery.includes(term)
  );
  if (mentionsWebMedia && asksForFundamentals) {
    return buildEditorTrainingIntent("lesson-01", "第1回: ウェブメディアの基礎知識");
  }

  return null;
}
