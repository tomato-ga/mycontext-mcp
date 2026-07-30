import { buildEditorKnowledgeDocumentUri, toEditorKnowledgeDocumentId } from "./editorKnowledge.js";

export const PLANNING_PLAYBOOK_SOURCE_ID = "kikaku-composition-playbook";
export const PLANNING_PLAYBOOK_DOCUMENT_ID =
  toEditorKnowledgeDocumentId(PLANNING_PLAYBOOK_SOURCE_ID);
export const MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS = 20_000;

export interface PlanningPlaybookContext {
  document_id: typeof PLANNING_PLAYBOOK_DOCUMENT_ID;
  title: string;
  markdown_sha256: string;
  revision_sha256: string;
  section_count: number;
  search_span_count: number;
  context_chars: number;
  retrieval_mode: "full_playbook";
  truncated: false;
  last_synced_at: string | null;
  source_resource_uri: string;
  markdown: string;
}

export class PlanningPlaybookContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningPlaybookContextError";
  }
}

export class PlanningPlaybookContextTooLargeError extends RangeError {
  constructor(actual: number, maximum: number) {
    super(
      `planning playbook is ${actual} chars; maximum is ${maximum}; no truncation was applied`
    );
    this.name = "PlanningPlaybookContextTooLargeError";
  }
}

export function buildPlanningPlaybookResourceUri(): string {
  return buildEditorKnowledgeDocumentUri(PLANNING_PLAYBOOK_SOURCE_ID);
}
