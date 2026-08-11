import {
  AUTHOR_STYLE_SECTIONING_VERSION,
  BODY_PARSER_VERSION,
  BODY_ROUTING_VERSION,
  TITLE_PARSER_VERSION,
  TITLE_ROUTING_VERSION
} from "../../mycontext-sync/src/authorStyle.js";
import {
  BUSINESS_KNOWLEDGE_PARSER_VERSION,
  BUSINESS_KNOWLEDGE_SECTIONING_VERSION
} from "../../mycontext-sync/src/businessKnowledge.js";
import { sha256 } from "./hash.js";
import {
  SMALL_COMPANY_SELLING_SYSTEM_PARSER_VERSION,
  SMALL_COMPANY_SELLING_SYSTEM_SECTIONING_VERSION
} from "./smallCompanySellingSystem.js";
import type {
  ManagedNotionDocument,
  SyncFailure,
  SyncMessage,
  SyncRepository,
  SyncStateLogEntry,
  SyncTraceState,
  SyncValidationStatus,
  WorkflowStatus
} from "./types.js";

type TracePatch = Partial<Pick<SyncStateLogEntry,
  | "documentId"
  | "category"
  | "workflowStatus"
  | "validationStatus"
  | "inputFingerprint"
  | "sourceMarkdownSha256"
  | "activeRevisionBefore"
  | "candidateRevisionSha256"
  | "parserVersion"
  | "sectioningVersion"
  | "routingVersion"
  | "errorCode"
  | "errorMessage"
  | "retryable"
  | "nextAction"
>> & { details?: Record<string, unknown> };

const TRACE_VERSION = 1;

export class SyncStateTrace {
  readonly runId: string;
  private sequenceNo = 0;
  private readonly snapshot: Omit<SyncStateLogEntry,
    "logId" | "sequenceNo" | "state" | "recordedAt" | "details"
  >;

  constructor(
    private readonly message: SyncMessage,
    private readonly repository: SyncRepository,
    deliveryAttempt: number,
    private readonly now: () => Date = () => new Date(),
    phase = "sync"
  ) {
    this.runId = syncRunId(message, deliveryAttempt, phase);
    this.snapshot = {
      runId: this.runId,
      eventId: message.eventId,
      eventType: message.eventType,
      deliveryAttempt,
      triggeredAt: message.timestamp,
      pageId: message.pageId,
      documentId: null,
      category: null,
      workflowStatus: null,
      validationStatus: "not_started",
      inputFingerprint: null,
      sourceMarkdownSha256: null,
      activeRevisionBefore: null,
      candidateRevisionSha256: null,
      parserVersion: null,
      sectioningVersion: null,
      routingVersion: null,
      errorCode: null,
      errorMessage: null,
      retryable: null,
      nextAction: "load_notion_document"
    };
  }

  captureManaged(managed: ManagedNotionDocument): void {
    this.snapshot.documentId = managed.documentId;
    this.snapshot.category = managed.category;
    this.snapshot.workflowStatus = managed.status;
    this.snapshot.activeRevisionBefore = managed.activeRevision;
    if (managed.category === "Author Style") {
      const isBody = managed.documentId === "ore-body-style";
      this.snapshot.parserVersion = isBody
        ? BODY_PARSER_VERSION
        : TITLE_PARSER_VERSION;
      this.snapshot.sectioningVersion = AUTHOR_STYLE_SECTIONING_VERSION;
      this.snapshot.routingVersion = isBody
        ? BODY_ROUTING_VERSION
        : TITLE_ROUTING_VERSION;
    } else if (managed.category === "Business Knowledge") {
      this.snapshot.parserVersion = SMALL_COMPANY_SELLING_SYSTEM_PARSER_VERSION;
      this.snapshot.sectioningVersion = SMALL_COMPANY_SELLING_SYSTEM_SECTIONING_VERSION;
    } else if (managed.category === "Editor Knowledge") {
      // Editor Knowledge (kikaku-*) sections reuse the Business Knowledge parser/sectioning
      // machinery unchanged; there is no routing-manifest concept for it, so routingVersion
      // stays null.
      this.snapshot.parserVersion = BUSINESS_KNOWLEDGE_PARSER_VERSION;
      this.snapshot.sectioningVersion = BUSINESS_KNOWLEDGE_SECTIONING_VERSION;
    }
  }

  captureSource(input: {
    inputFingerprint: string;
    sourceMarkdownSha256: string;
  }): void {
    this.snapshot.inputFingerprint = input.inputFingerprint;
    this.snapshot.sourceMarkdownSha256 = input.sourceMarkdownSha256;
  }

  captureCandidate(input: {
    candidateRevisionSha256: string;
    parserVersion?: string;
    sectioningVersion?: string;
    routingVersion?: string;
  }): void {
    this.snapshot.candidateRevisionSha256 = input.candidateRevisionSha256;
    this.snapshot.parserVersion = input.parserVersion ?? this.snapshot.parserVersion;
    this.snapshot.sectioningVersion = input.sectioningVersion ?? this.snapshot.sectioningVersion;
    this.snapshot.routingVersion = input.routingVersion ?? this.snapshot.routingVersion;
  }

  async record(state: SyncTraceState, patch: TracePatch = {}): Promise<void> {
    const { details = {}, ...snapshotPatch } = patch;
    Object.assign(this.snapshot, snapshotPatch);
    this.sequenceNo += 1;
    const entry: SyncStateLogEntry = {
      ...this.snapshot,
      logId: sha256(`${this.runId}\0${this.sequenceNo}`),
      sequenceNo: this.sequenceNo,
      state,
      recordedAt: this.now().toISOString(),
      details: {
        traceVersion: TRACE_VERSION,
        ...details
      }
    };
    await this.repository.appendSyncStateLog(entry);
    console.log(JSON.stringify({
      event: "context_sync_state_recorded",
      runId: this.runId,
      sequenceNo: this.sequenceNo,
      pageId: this.message.pageId,
      documentId: entry.documentId,
      state,
      errorCode: entry.errorCode
    }));
  }

  async recordFailure(failure: SyncFailure): Promise<void> {
    await this.record(failure.retryable ? "retryable_failure" : "failed", {
      workflowStatus: failure.retryable ? this.snapshot.workflowStatus : failure.workflowStatus,
      validationStatus: "failed",
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, 4000),
      retryable: failure.retryable,
      nextAction: failure.retryable
        ? "automatic_retry"
        : failure.workflowStatus === "Conflict"
          ? "resolve_conflict_and_set_ready"
          : "review_notion_and_set_ready"
    });
  }
}

export function syncRunId(
  message: SyncMessage,
  deliveryAttempt: number,
  phase = "sync"
): string {
  return sha256(JSON.stringify({
    traceVersion: TRACE_VERSION,
    phase,
    eventId: message.eventId,
    eventType: message.eventType,
    pageId: message.pageId,
    deliveryAttempt
  }));
}

export async function recordDeadLetterState(input: {
  message: SyncMessage;
  deliveryAttempt: number;
  repository: SyncRepository;
  workflowStatus?: WorkflowStatus;
  now?: () => Date;
}): Promise<void> {
  const trace = new SyncStateTrace(
    input.message,
    input.repository,
    input.deliveryAttempt,
    input.now,
    "dead-letter"
  );
  await trace.record("dead_lettered", {
    workflowStatus: input.workflowStatus ?? "Error",
    validationStatus: "failed",
    errorCode: "sync_retry_exhausted",
    errorMessage: "Automatic retries were exhausted",
    retryable: false,
    nextAction: "human_review_required"
  });
}
