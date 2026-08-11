import type { LoadedAuthorStyleDocument } from "../../mycontext-sync/src/authorStyle.js";
import type { LoadedBusinessKnowledgeDocument } from "../../mycontext-sync/src/businessKnowledge.js";
import type { LoadedEditorKnowledgeSectionedDocument } from "../../mycontext-sync/src/editorKnowledge.js";

export type WorkflowStatus =
  | "Draft"
  | "Review"
  | "Ready"
  | "Syncing"
  | "Synced"
  | "Error"
  | "Conflict"
  | "Archived";

export type SyncCategory =
  | "Personal Context"
  | "AI Skill"
  | "Author Style"
  | "Business Knowledge"
  | "Editor Knowledge"
  | "Metaskill";

export type TidbTableName =
  | "notion_pages"
  | "author_style_documents"
  | "author_style_current_sections"
  | "business_knowledge_documents"
  | "business_knowledge_sections"
  | "editor_knowledge_documents"
  | "editor_knowledge_sections"
  | "metaskill_documents"
  | "metaskill_revisions"
  | "metaskill_sections";

export interface ManagedNotionDocument {
  pageId: string;
  dataSourceId: string;
  documentId: string;
  name: string;
  category: SyncCategory;
  status: WorkflowStatus;
  active: boolean;
  schemaVersion: string;
  syncSource: string;
  originalPageId: string | null;
  syncedHash: string | null;
  activeRevision: string | null;
  lastEditedTime: string;
}

export interface NotionMarkdown {
  markdown: string;
  truncated: boolean;
  unknownBlockIds: string[];
}

export interface WorkflowUpdate {
  status: WorkflowStatus;
  tidbTables?: readonly TidbTableName[];
  syncedHash?: string | null;
  activeRevision?: string | null;
  validationError?: string | null;
  lastSyncedAt?: string | null;
}

export interface NotionGateway {
  getManagedDocument(pageId: string): Promise<ManagedNotionDocument>;
  getMarkdown(pageId: string): Promise<NotionMarkdown>;
  updateWorkflow(pageId: string, update: WorkflowUpdate): Promise<void>;
  findByDocumentId(documentId: string): Promise<ManagedNotionDocument[]>;
}

export interface AuthorStyleState {
  contextSha256: string;
  sourceMarkdownSha256: string;
  sourcePathKey: string;
}

export interface EditorKnowledgeSectionedState {
  activeSectionRevisionSha256: string | null;
}

export interface BusinessKnowledgeState {
  activeSectionRevisionSha256: string;
  sourcePathKey: string;
}

export interface SyncRepository {
  appendSyncStateLog(entry: SyncStateLogEntry): Promise<void>;
  syncNotionPage(input: {
    pageId: string;
    originalPageId: string | null;
    title: string;
    markdown: string;
    markdownSha256: string;
  }): Promise<void>;
  getAuthorStyleState(documentId: string): Promise<AuthorStyleState | null>;
  activateAuthorStyle(input: {
    document: LoadedAuthorStyleDocument;
    notionPageId: string;
    expectedState: AuthorStyleState | null;
  }): Promise<void>;
  getEditorKnowledgeSectionedState(documentId: string): Promise<EditorKnowledgeSectionedState | null>;
  activateEditorKnowledgeSectioned(input: {
    document: LoadedEditorKnowledgeSectionedDocument;
  }): Promise<void>;
  getBusinessKnowledgeState(documentId: string): Promise<BusinessKnowledgeState | null>;
  activateBusinessKnowledge(input: {
    document: LoadedBusinessKnowledgeDocument;
  }): Promise<void>;
}

export type SyncTraceState =
  | "received"
  | "eligible"
  | "syncing"
  | "source_verified"
  | "content_validated"
  | "persisted"
  | "synced"
  | "skipped"
  | "ignored"
  | "failed"
  | "retryable_failure"
  | "dead_lettered";

export type SyncValidationStatus =
  | "not_started"
  | "not_applicable"
  | "passed"
  | "failed";

export interface SyncStateLogEntry {
  logId: string;
  runId: string;
  sequenceNo: number;
  eventId: string;
  eventType: SyncMessage["eventType"];
  deliveryAttempt: number;
  triggeredAt: string;
  recordedAt: string;
  pageId: string;
  documentId: string | null;
  category: SyncCategory | null;
  state: SyncTraceState;
  workflowStatus: WorkflowStatus | null;
  validationStatus: SyncValidationStatus;
  inputFingerprint: string | null;
  sourceMarkdownSha256: string | null;
  activeRevisionBefore: string | null;
  candidateRevisionSha256: string | null;
  parserVersion: string | null;
  sectioningVersion: string | null;
  routingVersion: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  nextAction: string;
  details: Record<string, unknown>;
}

export interface SyncMessage {
  eventId: string;
  eventType: "page.properties_updated" | "page.content_updated";
  pageId: string;
  timestamp: string;
}

export type SyncOutcomeStatus =
  | "ignored"
  | "skipped"
  | "synced"
  | "failed";

export interface SyncOutcome {
  pageId: string;
  documentId?: string;
  status: SyncOutcomeStatus;
  revisionSha256?: string;
  reason?: string;
}

export class SyncFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly workflowStatus: "Error" | "Conflict";

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; workflowStatus?: "Error" | "Conflict" } = {}
  ) {
    super(message);
    this.name = "SyncFailure";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.workflowStatus = options.workflowStatus ?? "Error";
  }
}
