export const BUSINESS_KNOWLEDGE_DOCUMENT_IDS = [
  "startup-science",
  "marketing-wisdom"
] as const;

export type BusinessKnowledgeDocumentId = typeof BUSINESS_KNOWLEDGE_DOCUMENT_IDS[number];

const BUSINESS_KNOWLEDGE_PREFIX = "business-knowledge:";
const SECTION_REFERENCE_PATTERN =
  /^business-knowledge:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)#([A-Za-z0-9._~-]+)$/;

export interface BusinessKnowledgeSectionReference {
  documentId: string;
  sectionId: string;
}

export function isBusinessKnowledgeDocumentId(value: string): value is BusinessKnowledgeDocumentId {
  return BUSINESS_KNOWLEDGE_DOCUMENT_IDS.some((documentId) => documentId === value);
}

export function toBusinessKnowledgeDocumentId(documentId: string): string {
  return `${BUSINESS_KNOWLEDGE_PREFIX}${documentId}`;
}

export function buildBusinessKnowledgeDocumentUri(documentId: string): string {
  return `mycontext://business-knowledge/${encodeURIComponent(documentId)}`;
}

export function buildBusinessKnowledgeSectionUri(documentId: string, sectionId: string): string {
  return `${buildBusinessKnowledgeDocumentUri(documentId)}/sections/${encodeURIComponent(sectionId)}`;
}

export function parseBusinessKnowledgeSectionReference(
  value: string
): BusinessKnowledgeSectionReference | null {
  const match = SECTION_REFERENCE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return {
    documentId: match[1],
    sectionId: match[2]
  };
}
