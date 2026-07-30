import { buildEditorKnowledgeDocumentUri, toEditorKnowledgeDocumentId } from "./editorKnowledge.js";

export const EDITING_PLAYBOOK_SOURCE_ID = "henshu-editing-playbook";
export const EDITING_PLAYBOOK_DOCUMENT_ID =
  toEditorKnowledgeDocumentId(EDITING_PLAYBOOK_SOURCE_ID);
export const MAX_EDITING_PLAYBOOK_CONTEXT_CHARS = 20_000;

export interface EditingPlaybookContext {
  document_id: typeof EDITING_PLAYBOOK_DOCUMENT_ID;
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

export class EditingPlaybookContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditingPlaybookContextError";
  }
}

export class EditingPlaybookContextTooLargeError extends RangeError {
  constructor(actual: number, maximum: number) {
    super(
      `editing playbook is ${actual} chars; maximum is ${maximum}; no truncation was applied`
    );
    this.name = "EditingPlaybookContextTooLargeError";
  }
}

export function buildEditingPlaybookResourceUri(): string {
  return buildEditorKnowledgeDocumentUri(EDITING_PLAYBOOK_SOURCE_ID);
}
