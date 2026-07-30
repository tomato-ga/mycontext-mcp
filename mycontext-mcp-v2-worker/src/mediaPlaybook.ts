import { buildEditorKnowledgeDocumentUri, toEditorKnowledgeDocumentId } from "./editorKnowledge.js";

export const MEDIA_PLAYBOOK_SOURCE_ID = "knowhow-media-design";
export const MEDIA_PLAYBOOK_DOCUMENT_ID =
  toEditorKnowledgeDocumentId(MEDIA_PLAYBOOK_SOURCE_ID);
export const MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS = 20_000;

export interface MediaPlaybookContext {
  document_id: typeof MEDIA_PLAYBOOK_DOCUMENT_ID;
  title: string;
  markdown_sha256: string;
  revision_sha256: string;
  storage_mode: "whole_document";
  record_count: 1;
  section_count: 0;
  search_span_count: 1;
  context_chars: number;
  retrieval_mode: "full_playbook";
  truncated: false;
  last_synced_at: string | null;
  source_resource_uri: string;
  markdown: string;
}

export class MediaPlaybookContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaPlaybookContextError";
  }
}

export class MediaPlaybookContextTooLargeError extends RangeError {
  constructor(actual: number, maximum: number) {
    super(
      `media playbook is ${actual} chars; maximum is ${maximum}; no truncation was applied`
    );
    this.name = "MediaPlaybookContextTooLargeError";
  }
}

export function buildMediaPlaybookResourceUri(): string {
  return buildEditorKnowledgeDocumentUri(MEDIA_PLAYBOOK_SOURCE_ID);
}
