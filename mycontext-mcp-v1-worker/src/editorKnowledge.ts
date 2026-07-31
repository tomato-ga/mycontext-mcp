/**
 * kikaku-composition-playbook and kikaku-db-catalog are Editor Knowledge documents that carry
 * a "document + section table + search span" shape, mirroring Business Knowledge. This module
 * mirrors businessKnowledge.ts's URI/reference helpers for that sectioned subset only; the
 * other 8 Editor Knowledge documents (overview, lesson-01..07) are not sectioned and are not
 * covered by these IDs.
 */
export const EDITOR_KNOWLEDGE_SECTIONED_DOCUMENT_IDS = [
  "kikaku-composition-playbook",
  "kikaku-db-catalog"
] as const;

export type EditorKnowledgeSectionedDocumentId =
  typeof EDITOR_KNOWLEDGE_SECTIONED_DOCUMENT_IDS[number];

const EDITOR_KNOWLEDGE_PREFIX = "editor-knowledge:";
const SECTION_REFERENCE_PATTERN =
  /^editor-knowledge:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)#([A-Za-z0-9._~-]+)$/;

export interface EditorKnowledgeSectionReference {
  documentId: string;
  sectionId: string;
}

export function isEditorKnowledgeSectionedDocumentId(
  value: string
): value is EditorKnowledgeSectionedDocumentId {
  return EDITOR_KNOWLEDGE_SECTIONED_DOCUMENT_IDS.some((documentId) => documentId === value);
}

export function toEditorKnowledgeDocumentId(documentId: string): string {
  return `${EDITOR_KNOWLEDGE_PREFIX}${documentId}`;
}

export function buildEditorKnowledgeDocumentUri(documentId: string): string {
  return `mycontext://editor-knowledge/${encodeURIComponent(documentId)}`;
}

export function buildEditorKnowledgeSectionUri(documentId: string, sectionId: string): string {
  return `${buildEditorKnowledgeDocumentUri(documentId)}/sections/${encodeURIComponent(sectionId)}`;
}

export function parseEditorKnowledgeSectionReference(
  value: string
): EditorKnowledgeSectionReference | null {
  const match = SECTION_REFERENCE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return {
    documentId: match[1],
    sectionId: match[2]
  };
}
