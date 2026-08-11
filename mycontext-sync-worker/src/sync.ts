import {
  AUTHOR_STYLE_SOURCES,
  parseAuthorStyleMarkdown,
  type LoadedAuthorStyleDocument
} from "../../mycontext-sync/src/authorStyle.js";
import {
  BUSINESS_KNOWLEDGE_PARSER_VERSION,
  BUSINESS_KNOWLEDGE_SECTIONING_VERSION,
  type LoadedBusinessKnowledgeDocument
} from "../../mycontext-sync/src/businessKnowledge.js";
import {
  isEditorKnowledgeSectionedDocumentId,
  parseEditorKnowledgeSectionedMarkdown,
  type LoadedEditorKnowledgeSectionedDocument
} from "../../mycontext-sync/src/editorKnowledge.js";
import { sha256 } from "./hash.js";
import type { AuthorStylePageIds } from "./config.js";
import {
  SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID,
  parseSmallCompanySellingSystemMarkdown
} from "./smallCompanySellingSystem.js";
import { SyncStateTrace } from "./stateLog.js";
import { tidbTablesForDocument } from "./tidbTables.js";
import {
  SyncFailure,
  type ManagedNotionDocument,
  type NotionGateway,
  type NotionMarkdown,
  type SyncMessage,
  type SyncOutcome,
  type SyncRepository
} from "./types.js";

export interface SyncDependencies {
  notion: NotionGateway;
  repository: SyncRepository;
  parseAuthorStyle?: (input: {
    managed: ManagedNotionDocument;
    markdown: string;
  }) => LoadedAuthorStyleDocument;
  parseEditorKnowledge?: (input: {
    managed: ManagedNotionDocument;
    markdown: string;
  }) => LoadedEditorKnowledgeSectionedDocument;
  parseBusinessKnowledge?: (input: {
    managed: ManagedNotionDocument;
    markdown: string;
  }) => LoadedBusinessKnowledgeDocument;
  now?: () => Date;
  deliveryAttempt?: number;
  authorStylePageIds?: AuthorStylePageIds;
}

const EXPECTED_SCHEMA_VERSION = {
  "Personal Context": "personal-context-v1",
  "AI Skill": "ai-skill-v1",
  "Author Style": "author-style-v1",
  "Business Knowledge": "business-knowledge-v1",
  "Editor Knowledge": "editor-knowledge-v1",
  "Metaskill": "metaskill-v1"
} as const;

type PreparedContent =
  | { kind: "author-style"; document: LoadedAuthorStyleDocument }
  | { kind: "business-knowledge"; document: LoadedBusinessKnowledgeDocument }
  | { kind: "editor-knowledge"; document: LoadedEditorKnowledgeSectionedDocument }
  | null;

export async function processSyncMessage(
  message: SyncMessage,
  dependencies: SyncDependencies
): Promise<SyncOutcome> {
  const trace = new SyncStateTrace(
    message,
    dependencies.repository,
    dependencies.deliveryAttempt ?? 1,
    dependencies.now
  );
  await trace.record("received");
  try {
    return await handleNotionChange(message.pageId, dependencies, trace);
  } catch (error) {
    const failure = normalizeFailure(error);
    await trace.recordFailure(failure);
    throw failure;
  }
}

async function handleReadyPage(
  pageId: string,
  dependencies: SyncDependencies,
  trace: SyncStateTrace,
  initialManaged?: ManagedNotionDocument
): Promise<SyncOutcome> {
  let managed: ManagedNotionDocument;
  try {
    managed = initialManaged ?? await dependencies.notion.getManagedDocument(pageId);
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.retryable) throw failure;
    if (failure.code === "notion_data_source_mismatch") {
      await trace.record("ignored", {
        validationStatus: "not_applicable",
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: false,
        nextAction: "none"
      });
      return { pageId, status: "ignored", reason: failure.code };
    }
    await dependencies.notion.updateWorkflow(pageId, {
      status: failure.workflowStatus,
      validationError: `${failure.code}: ${failure.message}`
    });
    await trace.recordFailure(failure);
    return { pageId, status: "failed", reason: failure.code };
  }
  trace.captureManaged(managed);
  if (managed.status !== "Ready" && managed.status !== "Syncing") {
    await trace.record("ignored", {
      validationStatus: "not_applicable",
      nextAction: "none",
      details: { reason: managed.status }
    });
    return { pageId, documentId: managed.documentId, status: "ignored", reason: managed.status };
  }

  try {
    validateManagedDocument(managed);
    validateAuthorStylePage(managed, dependencies.authorStylePageIds);
    const owners = await dependencies.notion.findByDocumentId(managed.documentId);
    if (!isUniqueDocumentOwnerOrDeclaredAuthorStyleMigration(managed, owners)) {
      throw new SyncFailure(
        "notion_document_id_duplicate",
        `Document ID must identify exactly one page: ${managed.documentId}`,
        { workflowStatus: "Conflict" }
      );
    }
    await trace.record("eligible", {
      validationStatus: "passed",
      nextAction: "load_and_verify_source",
      details: {
        schemaVersion: managed.schemaVersion,
        lastEditedTime: managed.lastEditedTime
      }
    });
    if (managed.status === "Ready") {
      await dependencies.notion.updateWorkflow(pageId, {
        status: "Syncing",
        tidbTables: tidbTablesForDocument(managed),
        validationError: null
      });
    }
    await trace.record("syncing", {
      workflowStatus: "Syncing",
      nextAction: "load_and_verify_source",
      details: { resumed: managed.status === "Syncing" }
    });

    const first = await dependencies.notion.getMarkdown(pageId);
    validateMarkdown(first);
    const firstFingerprint = syncFingerprint(managed, first.markdown);

    const second = await dependencies.notion.getMarkdown(pageId);
    validateMarkdown(second);
    const refreshed = await dependencies.notion.getManagedDocument(pageId);
    validateManagedDocument(refreshed);
    validateAuthorStylePage(refreshed, dependencies.authorStylePageIds);
    if (refreshed.status !== "Syncing") {
      throw new SyncFailure(
        "notion_status_changed_during_sync",
        `Notion Status changed to ${refreshed.status} while synchronization was running`,
        { workflowStatus: "Conflict" }
      );
    }
    const secondFingerprint = syncFingerprint(refreshed, second.markdown);
    const secondHash = sha256(second.markdown);
    if (firstFingerprint !== secondFingerprint) {
      throw new SyncFailure(
        "notion_content_changed_during_sync",
        "Notion content or management properties changed while synchronization was running; review it and set Ready again",
        { workflowStatus: "Conflict" }
      );
    }
    trace.captureManaged(refreshed);
    trace.captureSource({
      inputFingerprint: secondFingerprint,
      sourceMarkdownSha256: secondHash
    });
    await trace.record("source_verified", {
      workflowStatus: "Syncing",
      validationStatus: "passed",
      nextAction: "validate_content",
      details: {
        markdownBytes: new TextEncoder().encode(second.markdown).byteLength,
        unknownBlockCount: second.unknownBlockIds.length
      }
    });

    const prepared: PreparedContent = refreshed.category === "Author Style"
      ? {
          kind: "author-style",
          document: (dependencies.parseAuthorStyle ?? defaultParseAuthorStyle)({
            managed: refreshed,
            markdown: second.markdown
          })
        }
      : refreshed.category === "Business Knowledge"
        ? {
            kind: "business-knowledge",
            document: (dependencies.parseBusinessKnowledge ?? defaultParseBusinessKnowledge)({
              managed: refreshed,
              markdown: second.markdown
            })
          }
        : refreshed.category === "Editor Knowledge"
        ? {
            kind: "editor-knowledge",
            document: (dependencies.parseEditorKnowledge ?? defaultParseEditorKnowledge)({
              managed: refreshed,
              markdown: second.markdown
            })
          }
        : null;

    if (prepared !== null) {
      const deliverySectionCount = prepared.kind === "author-style"
        ? prepared.document.deliverySectionCount
        : new Set(prepared.document.sections.map((section) => section.deliverySectionId)).size;
      trace.captureCandidate({
        candidateRevisionSha256: prepared.kind === "author-style"
          ? prepared.document.revisionSha256
          : prepared.document.sectionRevisionSha256,
        parserVersion: prepared.kind === "author-style"
          ? prepared.document.parserVersion
          : prepared.kind === "business-knowledge"
            ? prepared.document.parserVersion
            : BUSINESS_KNOWLEDGE_PARSER_VERSION,
        sectioningVersion: prepared.kind === "author-style"
          ? prepared.document.sectioningVersion
          : prepared.kind === "business-knowledge"
            ? prepared.document.sectioningVersion
            : BUSINESS_KNOWLEDGE_SECTIONING_VERSION,
        routingVersion: prepared.kind === "author-style" ? prepared.document.routingVersion : undefined
      });
      await trace.record("content_validated", {
        validationStatus: "passed",
        nextAction: "persist_read_model",
        details: {
          sectionCount: prepared.document.sectionCount,
          deliverySectionCount,
          searchSpanCount: prepared.document.searchSpanCount
        }
      });
    } else {
      trace.captureCandidate({ candidateRevisionSha256: secondHash });
      await trace.record("content_validated", {
        validationStatus: "passed",
        nextAction: "persist_read_model",
        details: {
          documentKind: refreshed.category === "AI Skill"
            ? "ai_skill"
            : "personal_context"
        }
      });
    }

    const outcome = refreshed.category === "Author Style"
      ? await syncAuthorStyle(refreshed, requirePreparedAuthorStyle(prepared), dependencies.repository)
      : refreshed.category === "Business Knowledge"
        ? await syncBusinessKnowledge(
            refreshed,
            requirePreparedBusinessKnowledge(prepared),
            dependencies.repository
          )
        : refreshed.category === "Editor Knowledge"
        ? await syncEditorKnowledgeSectioned(
            refreshed,
            requirePreparedEditorKnowledge(prepared),
            dependencies.repository
          )
        : await syncPersonalContext(refreshed, second.markdown, secondHash, dependencies.repository);

    if (outcome.status === "synced") {
      await trace.record("persisted", {
        nextAction: "update_notion_workflow",
        details: { resultStatus: outcome.status }
      });
    }

    await dependencies.notion.updateWorkflow(pageId, {
      status: "Synced",
      tidbTables: tidbTablesForDocument(refreshed),
      syncedHash: secondFingerprint,
      activeRevision: refreshed.category === "Author Style"
        ? null
        : outcome.revisionSha256 ?? secondHash,
      validationError: null,
      lastSyncedAt: (dependencies.now?.() ?? new Date()).toISOString()
    });
    await trace.record(outcome.status === "skipped" ? "skipped" : "synced", {
      workflowStatus: "Synced",
      validationStatus: "passed",
      retryable: false,
      nextAction: "none",
      details: { resultStatus: outcome.status }
    });
    return outcome;
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.retryable) throw failure;
    await dependencies.notion.updateWorkflow(pageId, {
      status: failure.workflowStatus,
      tidbTables: tidbTablesForDocument(managed),
      validationError: `${failure.code}: ${failure.message}`
    });
    await trace.recordFailure(failure);
    return {
      pageId,
      documentId: managed.documentId,
      status: "failed",
      reason: failure.code
    };
  }
}

async function handleNotionChange(
  pageId: string,
  dependencies: SyncDependencies,
  trace: SyncStateTrace
): Promise<SyncOutcome> {
  let managed: ManagedNotionDocument;
  try {
    managed = await dependencies.notion.getManagedDocument(pageId);
  } catch (error) {
    const failure = normalizeFailure(error);
    if (failure.retryable) throw failure;
    if (failure.code === "notion_data_source_mismatch") {
      await trace.record("ignored", {
        validationStatus: "not_applicable",
        errorCode: failure.code,
        errorMessage: failure.message,
        retryable: false,
        nextAction: "none"
      });
      return { pageId, status: "ignored", reason: failure.code };
    }
    await dependencies.notion.updateWorkflow(pageId, {
      status: failure.workflowStatus,
      validationError: `${failure.code}: ${failure.message}`
    });
    await trace.recordFailure(failure);
    return { pageId, status: "failed", reason: failure.code };
  }
  trace.captureManaged(managed);
  if (managed.status !== "Ready" && managed.status !== "Syncing") {
    await trace.record("ignored", {
      validationStatus: "not_applicable",
      nextAction: "none",
      details: { reason: managed.status }
    });
    return { pageId, documentId: managed.documentId, status: "ignored", reason: managed.status };
  }
  return handleReadyPage(pageId, dependencies, trace, managed);
}

async function syncPersonalContext(
  managed: ManagedNotionDocument,
  markdown: string,
  markdownSha256: string,
  repository: SyncRepository
): Promise<SyncOutcome> {
  await repository.syncNotionPage({
    pageId: managed.pageId,
    originalPageId: managed.originalPageId,
    title: managed.name,
    markdown,
    markdownSha256
  });
  return {
    pageId: managed.pageId,
    documentId: managed.documentId,
    status: "synced",
    revisionSha256: markdownSha256
  };
}

async function syncAuthorStyle(
  managed: ManagedNotionDocument,
  document: LoadedAuthorStyleDocument,
  repository: SyncRepository
): Promise<SyncOutcome> {
  const state = await repository.getAuthorStyleState(managed.documentId);
  const expectedSourceKey = `notion:${managed.pageId}`;

  if (state !== null && state.sourcePathKey.startsWith("notion:")
    && state.sourcePathKey !== expectedSourceKey) {
    const declaredPreviousSourceKey = managed.originalPageId === null
      ? null
      : `notion:${managed.originalPageId}`;
    if (state.sourcePathKey !== declaredPreviousSourceKey) {
      throw new SyncFailure(
        "author_style_owned_by_another_notion_page",
        `${managed.documentId} is already owned by another Notion page`,
        { workflowStatus: "Conflict" }
      );
    }
  }

  if (
    state?.contextSha256 === document.revisionSha256
    && state.sourcePathKey === expectedSourceKey
  ) {
    return {
      pageId: managed.pageId,
      documentId: managed.documentId,
      status: "skipped",
      revisionSha256: document.revisionSha256
    };
  }

  await repository.activateAuthorStyle({
    document,
    notionPageId: managed.pageId,
    expectedState: state
  });
  return {
    pageId: managed.pageId,
    documentId: managed.documentId,
    status: "synced",
    revisionSha256: document.revisionSha256
  };
}

function isUniqueDocumentOwnerOrDeclaredAuthorStyleMigration(
  managed: ManagedNotionDocument,
  owners: ManagedNotionDocument[]
): boolean {
  if (owners.length === 1 && owners[0]?.pageId === managed.pageId) return true;
  if (managed.category !== "Author Style" || managed.originalPageId === null) return false;
  if (managed.originalPageId === managed.pageId || owners.length !== 2) return false;
  const ownerIds = new Set(owners.map((owner) => owner.pageId));
  return ownerIds.has(managed.pageId) && ownerIds.has(managed.originalPageId);
}

async function syncEditorKnowledgeSectioned(
  managed: ManagedNotionDocument,
  document: LoadedEditorKnowledgeSectionedDocument,
  repository: SyncRepository
): Promise<SyncOutcome> {
  // editor_knowledge_documents has no source_path_key / ownership-conflict concept (unlike
  // author_style_documents): the local-file-direct route for these two Document IDs has been
  // abolished, so Notion via this sync-worker is the only writer, and a simple
  // skip-if-unchanged check (mirroring syncAuthorStyle's) is sufficient.
  const state = await repository.getEditorKnowledgeSectionedState(managed.documentId);
  if (state?.activeSectionRevisionSha256 === document.sectionRevisionSha256) {
    return {
      pageId: managed.pageId,
      documentId: managed.documentId,
      status: "skipped",
      revisionSha256: document.sectionRevisionSha256
    };
  }

  await repository.activateEditorKnowledgeSectioned({ document });
  return {
    pageId: managed.pageId,
    documentId: managed.documentId,
    status: "synced",
    revisionSha256: document.sectionRevisionSha256
  };
}

async function syncBusinessKnowledge(
  managed: ManagedNotionDocument,
  document: LoadedBusinessKnowledgeDocument,
  repository: SyncRepository
): Promise<SyncOutcome> {
  const state = await repository.getBusinessKnowledgeState(managed.documentId);
  const expectedSourceKey = `notion:${managed.pageId}`;
  if (state !== null && state.sourcePathKey.startsWith("notion:")
    && state.sourcePathKey !== expectedSourceKey) {
    const declaredPreviousSourceKey = managed.originalPageId === null
      ? null
      : `notion:${managed.originalPageId}`;
    if (state.sourcePathKey !== declaredPreviousSourceKey) {
      throw new SyncFailure(
        "business_knowledge_owned_by_another_notion_page",
        `${managed.documentId} is already owned by another Notion page`,
        { workflowStatus: "Conflict" }
      );
    }
  }
  if (
    state?.activeSectionRevisionSha256 === document.sectionRevisionSha256
    && state.sourcePathKey === expectedSourceKey
  ) {
    return {
      pageId: managed.pageId,
      documentId: managed.documentId,
      status: "skipped",
      revisionSha256: document.sectionRevisionSha256
    };
  }
  await repository.activateBusinessKnowledge({ document });
  return {
    pageId: managed.pageId,
    documentId: managed.documentId,
    status: "synced",
    revisionSha256: document.sectionRevisionSha256
  };
}

function validateManagedDocument(managed: ManagedNotionDocument): void {
  if (!managed.active) {
    throw new SyncFailure("notion_document_inactive", "Active must be enabled before syncing");
  }
  const expected = EXPECTED_SCHEMA_VERSION[managed.category];
  if (managed.schemaVersion !== expected) {
    throw new SyncFailure(
      "notion_schema_version_invalid",
      `${managed.category} requires Schema Version ${expected}`
    );
  }
  if (managed.category === "Metaskill") {
    throw new SyncFailure(
      "metaskill_snapshot_read_only",
      "Metaskill pages are TiDB-managed snapshots and cannot be synchronized from Notion",
      { workflowStatus: "Conflict" }
    );
  }
  if (managed.syncSource !== "Notion") {
    throw new SyncFailure(
      "notion_sync_source_invalid",
      "Sync Source must be Notion for automatic synchronization",
      { workflowStatus: "Conflict" }
    );
  }
}

function validateAuthorStylePage(
  managed: ManagedNotionDocument,
  pageIds: AuthorStylePageIds | undefined
): void {
  if (managed.category !== "Author Style" || pageIds === undefined) return;
  const expectedPageId = pageIds[managed.documentId as keyof AuthorStylePageIds];
  if (expectedPageId === undefined || managed.pageId !== expectedPageId) {
    throw new SyncFailure(
      "author_style_page_not_allowed",
      `Author Style sync is not allowed for ${managed.documentId} from page ${managed.pageId}`,
      { workflowStatus: "Conflict" }
    );
  }
}

function validateMarkdown(value: NotionMarkdown): void {
  if (value.markdown.trim().length === 0 || value.markdown.includes("\0")) {
    throw new SyncFailure("notion_markdown_invalid", "Notion Markdown is empty or contains NUL");
  }
  if (value.truncated || value.unknownBlockIds.length > 0) {
    throw new SyncFailure(
      "notion_markdown_incomplete",
      `Notion Markdown is incomplete (truncated=${value.truncated}, unknown_blocks=${value.unknownBlockIds.length})`
    );
  }
}

function defaultParseAuthorStyle(input: {
  managed: ManagedNotionDocument;
  markdown: string;
}): LoadedAuthorStyleDocument {
  const source = AUTHOR_STYLE_SOURCES.find(
    (candidate) => candidate.documentId === input.managed.documentId
  );
  if (source === undefined) {
    throw new SyncFailure(
      "author_style_document_id_invalid",
      "Author Style Document ID must be ore-title-style or ore-body-style"
    );
  }
  try {
    const canonicalMarkdown = canonicalAuthorStyleMarkdown(input.managed, input.markdown);
    return parseAuthorStyleMarkdown({
      source,
      markdown: canonicalMarkdown,
      sourcePathKey: `notion:${input.managed.pageId}`,
      sourceMtimeMs: Date.parse(input.managed.lastEditedTime)
    });
  } catch (error) {
    throw new SyncFailure(
      "author_style_validation_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function defaultParseEditorKnowledge(input: {
  managed: ManagedNotionDocument;
  markdown: string;
}): LoadedEditorKnowledgeSectionedDocument {
  if (!isEditorKnowledgeSectionedDocumentId(input.managed.documentId)) {
    throw new SyncFailure(
      "editor_knowledge_document_id_invalid",
      "Editor Knowledge Document ID must be kikaku-composition-playbook, henshu-editing-playbook, kikaku-db-catalog, knowhow-media-design, or start with kikaku-fulltext-"
    );
  }
  try {
    const canonicalMarkdown = canonicalEditorKnowledgeMarkdown(input.managed, input.markdown);
    return parseEditorKnowledgeSectionedMarkdown({
      documentId: input.managed.documentId,
      markdown: canonicalMarkdown,
      sourcePathKey: `notion:${input.managed.pageId}`
    });
  } catch (error) {
    throw new SyncFailure(
      "editor_knowledge_validation_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
}

function defaultParseBusinessKnowledge(input: {
  managed: ManagedNotionDocument;
  markdown: string;
}): LoadedBusinessKnowledgeDocument {
  if (input.managed.documentId !== SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID) {
    throw new SyncFailure(
      "business_knowledge_document_id_invalid",
      `Business Knowledge Document ID must be ${SMALL_COMPANY_SELLING_SYSTEM_DOCUMENT_ID}`
    );
  }
  try {
    return parseSmallCompanySellingSystemMarkdown({
      title: input.managed.name,
      markdown: input.markdown,
      sourcePathKey: `notion:${input.managed.pageId}`,
      sourceMtimeMs: Date.parse(input.managed.lastEditedTime)
    });
  } catch (error) {
    throw new SyncFailure(
      "business_knowledge_validation_failed",
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function syncFingerprint(
  managed: ManagedNotionDocument,
  markdown: string
): string {
  return sha256(JSON.stringify({
    fingerprintVersion: 1,
    pageId: managed.pageId,
    documentId: managed.documentId,
    name: managed.name,
    category: managed.category,
    active: managed.active,
    schemaVersion: managed.schemaVersion,
    syncSource: managed.syncSource,
    originalPageId: managed.originalPageId,
    markdown: stableMarkdownForFingerprint(markdown)
  }));
}

function stableMarkdownForFingerprint(markdown: string): string {
  return markdown.replace(
    /https:\/\/prod-files-secure\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com\/[^?\s)]+\?[^\s)]+/gi,
    (signedUrl) => signedUrl.slice(0, signedUrl.indexOf("?"))
  );
}

export function canonicalAuthorStyleMarkdown(
  managed: Pick<ManagedNotionDocument, "name">,
  markdown: string
): string {
  if (/^#(?!#)\s+\S/m.test(markdown)) return markdown;
  return `# ${managed.name}\n\n${markdown}`;
}

/**
 * Editor Knowledge pages, like Author Style pages, hold the Notion page title only in the
 * Name property, not as an H1 block in the page body (parseEditorKnowledgeSectionedMarkdown
 * requires the source to start with "# <title>"). Mirrors canonicalAuthorStyleMarkdown exactly:
 * if the body already contains an H1 line, it's left alone; otherwise "# <Name>" is prepended.
 */
export function canonicalEditorKnowledgeMarkdown(
  managed: Pick<ManagedNotionDocument, "name">,
  markdown: string
): string {
  if (/^#(?!#)\s+\S/m.test(markdown)) return markdown;
  return `# ${managed.name}\n\n${markdown}`;
}

function requirePreparedAuthorStyle(value: PreparedContent): LoadedAuthorStyleDocument {
  if (value === null || value.kind !== "author-style") {
    throw new SyncFailure("author_style_not_prepared", "Author Style was not parsed");
  }
  return value.document;
}

function requirePreparedEditorKnowledge(
  value: PreparedContent
): LoadedEditorKnowledgeSectionedDocument {
  if (value === null || value.kind !== "editor-knowledge") {
    throw new SyncFailure("editor_knowledge_not_prepared", "Editor Knowledge was not parsed");
  }
  return value.document;
}

function requirePreparedBusinessKnowledge(
  value: PreparedContent
): LoadedBusinessKnowledgeDocument {
  if (value === null || value.kind !== "business-knowledge") {
    throw new SyncFailure("business_knowledge_not_prepared", "Business Knowledge was not parsed");
  }
  return value.document;
}

function normalizeFailure(error: unknown): SyncFailure {
  if (error instanceof SyncFailure) return error;
  return new SyncFailure(
    "sync_unexpected_failure",
    error instanceof Error ? error.message : String(error),
    { retryable: true }
  );
}
