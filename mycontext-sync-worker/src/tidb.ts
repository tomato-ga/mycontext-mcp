import { connect, type Connection, type Row, type Tx } from "@tidbcloud/serverless";
import type {
  AuthorStyleSection,
  LoadedAuthorStyleDocument
} from "../../mycontext-sync/src/authorStyle.js";
import type {
  EditorKnowledgeSection,
  LoadedEditorKnowledgeSectionedDocument
} from "../../mycontext-sync/src/editorKnowledge.js";
import {
  SyncFailure,
  type AuthorStyleState,
  type EditorKnowledgeSectionedState,
  type SyncStateLogEntry,
  type SyncRepository
} from "./types.js";

export class TidbSyncRepository implements SyncRepository {
  private readonly connection: Connection<{ url: string }>;

  constructor(databaseUrl: string, connection?: Connection<{ url: string }>) {
    this.connection = connection ?? connect({ url: databaseUrl });
  }

  async appendSyncStateLog(entry: SyncStateLogEntry): Promise<void> {
    await this.execute(
      `INSERT IGNORE INTO context_sync_state_log
        (log_id, run_id, sequence_no, event_id, event_type, delivery_attempt,
         triggered_at, recorded_at, page_id, document_id, category, state,
         workflow_status, validation_status, input_fingerprint,
         source_markdown_sha256, active_revision_before,
         candidate_revision_sha256, parser_version, sectioning_version,
         routing_version, error_code, error_message, retryable, next_action,
         details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.logId,
        entry.runId,
        entry.sequenceNo,
        entry.eventId,
        entry.eventType,
        entry.deliveryAttempt,
        entry.triggeredAt,
        entry.recordedAt,
        entry.pageId,
        entry.documentId,
        entry.category,
        entry.state,
        entry.workflowStatus,
        entry.validationStatus,
        entry.inputFingerprint,
        entry.sourceMarkdownSha256,
        entry.activeRevisionBefore,
        entry.candidateRevisionSha256,
        entry.parserVersion,
        entry.sectioningVersion,
        entry.routingVersion,
        entry.errorCode,
        entry.errorMessage,
        entry.retryable,
        entry.nextAction,
        JSON.stringify(entry.details)
      ]
    );
  }

  async syncNotionPage(input: {
    pageId: string;
    originalPageId: string | null;
    title: string;
    markdown: string;
    markdownSha256: string;
  }): Promise<void> {
    const tx = await this.connection.begin();
    try {
      const ids = input.originalPageId === null || input.originalPageId === input.pageId
        ? [input.pageId]
        : [input.pageId, input.originalPageId];
      const placeholders = ids.map(() => "?").join(", ");
      const rows = await tx.execute(
        `SELECT page_id
         FROM notion_pages
         WHERE page_id IN (${placeholders})
         FOR UPDATE`,
        ids
      );
      const existingIds = new Set(rows.map((row) => requiredString(record(row).page_id, "page_id")));
      const targetExists = existingIds.has(input.pageId);
      const originalExists = input.originalPageId !== null
        && input.originalPageId !== input.pageId
        && existingIds.has(input.originalPageId);

      if (targetExists && originalExists) {
        throw new SyncFailure(
          "notion_page_migration_conflict",
          `Both the managed page and its Original Page ID already exist in notion_pages: ${input.pageId}`,
          { workflowStatus: "Conflict" }
        );
      }

      if (originalExists && input.originalPageId !== null) {
        await tx.execute(
          `UPDATE notion_pages
           SET page_id = ?, title = ?, markdown = ?, markdown_sha256 = ?,
               truncated = FALSE, unknown_block_ids = JSON_ARRAY(), last_synced_at = NOW(3)
           WHERE page_id = ?`,
          [
            input.pageId,
            input.title,
            input.markdown,
            input.markdownSha256,
            input.originalPageId
          ]
        );
      } else if (targetExists) {
        await tx.execute(
          `UPDATE notion_pages
           SET title = ?, markdown = ?, markdown_sha256 = ?,
               truncated = FALSE, unknown_block_ids = JSON_ARRAY(), last_synced_at = NOW(3)
           WHERE page_id = ?`,
          [input.title, input.markdown, input.markdownSha256, input.pageId]
        );
      } else {
        await tx.execute(
          `INSERT INTO notion_pages
            (page_id, title, markdown, markdown_sha256, truncated, unknown_block_ids, last_synced_at)
           VALUES (?, ?, ?, ?, FALSE, JSON_ARRAY(), NOW(3))`,
          [input.pageId, input.title, input.markdown, input.markdownSha256]
        );
      }
      await tx.commit();
    } catch (error) {
      await safeRollback(tx);
      throw databaseFailure(error);
    }
  }

  async getAuthorStyleState(documentId: string): Promise<AuthorStyleState | null> {
    const rows = await this.execute(
      `SELECT d.active_revision_sha256, d.source_path_key,
              r.source_markdown_sha256 AS active_source_markdown_sha256
       FROM author_style_documents AS d
       LEFT JOIN author_style_revisions AS r
         ON r.document_id = d.document_id
        AND r.revision_sha256 = d.active_revision_sha256
       WHERE d.document_id = ?
       LIMIT 1`,
      [documentId]
    );
    return rows[0] === undefined ? null : stateFromRow(rows[0]);
  }

  async activateAuthorStyle(input: {
    document: LoadedAuthorStyleDocument;
    notionPageId: string;
    expectedState: AuthorStyleState | null;
  }): Promise<void> {
    const tx = await this.connection.begin();
    try {
      const current = await lockedAuthorStyleState(tx, input.document.documentId);
      assertExpectedState(current, input.expectedState, input.document.documentId);
      if (current === null) {
        await tx.execute(
          `INSERT INTO author_style_documents
            (document_id, author_key, style_scope, display_name, source_path_key,
             active_revision_sha256, status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'active', NULL)`,
          [
            input.document.documentId,
            input.document.authorKey,
            input.document.styleScope,
            input.document.displayName,
            notionSourceKey(input.notionPageId)
          ]
        );
      } else {
        await tx.execute(
          `UPDATE author_style_documents
           SET author_key = ?, style_scope = ?, display_name = ?, source_path_key = ?,
               status = 'active'
           WHERE document_id = ?`,
          [
            input.document.authorKey,
            input.document.styleScope,
            input.document.displayName,
            notionSourceKey(input.notionPageId),
            input.document.documentId
          ]
        );
      }
      await insertAuthorStyleRevision(tx, input.document);
      for (const section of input.document.sections) {
        await upsertAuthorStyleSection(tx, section);
      }
      await tx.execute(
        `UPDATE author_style_documents
         SET active_revision_sha256 = ?, last_synced_at = NOW(3)
         WHERE document_id = ?`,
        [input.document.revisionSha256, input.document.documentId]
      );
      await tx.commit();
    } catch (error) {
      await safeRollback(tx);
      throw databaseFailure(error);
    }
  }

  async getEditorKnowledgeSectionedState(
    documentId: string
  ): Promise<EditorKnowledgeSectionedState | null> {
    const rows = await this.execute(
      `SELECT COALESCE(section_revision_sha256, markdown_sha256) AS active_revision_sha256
       FROM editor_knowledge_documents
       WHERE document_id = ?
       LIMIT 1`,
      [documentId]
    );
    if (rows[0] === undefined) return null;
    return {
      activeSectionRevisionSha256: optionalString(record(rows[0]).active_revision_sha256)
    };
  }

  async activateEditorKnowledgeSectioned(input: {
    document: LoadedEditorKnowledgeSectionedDocument;
  }): Promise<void> {
    const tx = await this.connection.begin();
    try {
      const wholeDocument = input.document.storageMode === "whole_document";
      await tx.execute(
        `INSERT INTO editor_knowledge_documents
          (document_id, title, markdown, markdown_sha256,
           section_revision_sha256, section_count, search_span_count, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          markdown = VALUES(markdown),
          markdown_sha256 = VALUES(markdown_sha256),
          section_revision_sha256 = VALUES(section_revision_sha256),
          section_count = VALUES(section_count),
          search_span_count = VALUES(search_span_count),
          last_synced_at = NOW(3)`,
        [
          input.document.documentId,
          input.document.title,
          input.document.markdown,
          input.document.markdownSha256,
          wholeDocument ? null : input.document.sectionRevisionSha256,
          wholeDocument ? null : input.document.sectionCount,
          wholeDocument ? null : input.document.searchSpanCount
        ]
      );

      if (wholeDocument) {
        // A compact playbook is one TiDB content record. Remove any chapter rows left by the
        // former sectioned design so MCP search cannot return stale #chapter-* IDs.
        await tx.execute(
          "DELETE FROM editor_knowledge_sections WHERE document_id = ?",
          [input.document.documentId]
        );
      } else {
        for (const section of input.document.sections) {
          await upsertEditorKnowledgeSection(tx, section);
        }
      }
      await tx.commit();
    } catch (error) {
      await safeRollback(tx);
      throw databaseFailure(error);
    }
  }

  private async execute(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
    try {
      return await this.connection.execute(sql, [...params]);
    } catch (error) {
      throw databaseFailure(error);
    }
  }
}

async function lockedAuthorStyleState(
  tx: Tx<{ url: string }>,
  documentId: string
): Promise<AuthorStyleState | null> {
  const rows = await tx.execute(
    `SELECT d.active_revision_sha256, d.source_path_key,
            r.source_markdown_sha256 AS active_source_markdown_sha256
     FROM author_style_documents AS d
     LEFT JOIN author_style_revisions AS r
       ON r.document_id = d.document_id
      AND r.revision_sha256 = d.active_revision_sha256
     WHERE d.document_id = ?
     LIMIT 1
     FOR UPDATE`,
    [documentId]
  );
  return rows[0] === undefined ? null : stateFromRow(rows[0]);
}

function assertExpectedState(
  current: AuthorStyleState | null,
  expected: AuthorStyleState | null,
  documentId: string
): void {
  if (
    current?.activeRevisionSha256 !== expected?.activeRevisionSha256
    || current?.activeSourceMarkdownSha256 !== expected?.activeSourceMarkdownSha256
    || current?.sourcePathKey !== expected?.sourcePathKey
  ) {
    throw new SyncFailure(
      "author_style_concurrent_update",
      `${documentId} changed in TiDB while the Notion revision was being prepared`,
      { workflowStatus: "Conflict" }
    );
  }
}

async function insertAuthorStyleRevision(
  tx: Tx<{ url: string }>,
  document: LoadedAuthorStyleDocument
): Promise<void> {
  await tx.execute(
    `INSERT INTO author_style_revisions
      (document_id, revision_sha256, source_markdown, source_markdown_sha256,
       source_bytes, source_line_count, source_mtime_ms, parser_version,
       sectioning_version, routing_version, routing_manifest_json, outline_json,
       section_count, delivery_section_count, search_span_count, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE revision_sha256 = VALUES(revision_sha256)`,
    [
      document.documentId,
      document.revisionSha256,
      document.sourceMarkdown,
      document.sourceMarkdownSha256,
      document.sourceBytes,
      document.sourceLineCount,
      document.sourceMtimeMs,
      document.parserVersion,
      document.sectioningVersion,
      document.routingVersion,
      JSON.stringify(document.routingManifest),
      JSON.stringify(document.outline),
      document.sectionCount,
      document.deliverySectionCount,
      document.searchSpanCount
    ]
  );
}

async function upsertEditorKnowledgeSection(
  tx: Tx<{ url: string }>,
  section: EditorKnowledgeSection
): Promise<void> {
  await tx.execute(
    `INSERT INTO editor_knowledge_sections
      (document_id, section_id, section_revision_sha256, parent_section_id,
       delivery_section_id, section_type, heading_level, section_number, title,
       heading_path_json, content_layer, ordinal, source_line_start,
       source_line_end, direct_markdown, section_markdown, retrieval_text,
       content_sha256, is_searchable, related_source_path, freshness_class,
       last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE
      parent_section_id = VALUES(parent_section_id),
      delivery_section_id = VALUES(delivery_section_id),
      section_type = VALUES(section_type),
      heading_level = VALUES(heading_level),
      section_number = VALUES(section_number),
      title = VALUES(title),
      heading_path_json = VALUES(heading_path_json),
      content_layer = VALUES(content_layer),
      ordinal = VALUES(ordinal),
      source_line_start = VALUES(source_line_start),
      source_line_end = VALUES(source_line_end),
      direct_markdown = VALUES(direct_markdown),
      section_markdown = VALUES(section_markdown),
      retrieval_text = VALUES(retrieval_text),
      content_sha256 = VALUES(content_sha256),
      is_searchable = VALUES(is_searchable),
      related_source_path = VALUES(related_source_path),
      freshness_class = VALUES(freshness_class),
      last_synced_at = NOW(3)`,
    [
      section.documentId,
      section.sectionId,
      section.sectionRevisionSha256,
      section.parentSectionId,
      section.deliverySectionId,
      section.sectionType,
      section.headingLevel,
      section.sectionNumber,
      section.title,
      JSON.stringify(section.headingPath),
      section.contentLayer,
      section.ordinal,
      section.sourceLineStart,
      section.sourceLineEnd,
      section.directMarkdown,
      section.sectionMarkdown,
      section.retrievalText,
      section.contentSha256,
      section.isSearchable,
      section.relatedSourcePath,
      section.freshnessClass
    ]
  );
}

async function upsertAuthorStyleSection(
  tx: Tx<{ url: string }>,
  section: AuthorStyleSection
): Promise<void> {
  await tx.execute(
    `INSERT INTO author_style_sections
      (document_id, revision_sha256, section_id, context_key, parent_section_id,
       delivery_section_id, section_type, content_layer, context_priority,
       heading_level, title, heading_path_json, aliases_json, ordinal,
       source_line_start, source_line_end, content_chars, estimated_tokens,
       direct_markdown, delivery_markdown, retrieval_text, content_sha256,
       is_searchable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       context_key = VALUES(context_key),
       parent_section_id = VALUES(parent_section_id),
       delivery_section_id = VALUES(delivery_section_id),
       section_type = VALUES(section_type),
       content_layer = VALUES(content_layer),
       context_priority = VALUES(context_priority),
       heading_level = VALUES(heading_level),
       title = VALUES(title),
       heading_path_json = VALUES(heading_path_json),
       aliases_json = VALUES(aliases_json),
       ordinal = VALUES(ordinal),
       source_line_start = VALUES(source_line_start),
       source_line_end = VALUES(source_line_end),
       content_chars = VALUES(content_chars),
       estimated_tokens = VALUES(estimated_tokens),
       direct_markdown = VALUES(direct_markdown),
       delivery_markdown = VALUES(delivery_markdown),
       retrieval_text = VALUES(retrieval_text),
       content_sha256 = VALUES(content_sha256),
       is_searchable = VALUES(is_searchable)`,
    [
      section.documentId,
      section.revisionSha256,
      section.sectionId,
      section.contextKey,
      section.parentSectionId,
      section.deliverySectionId,
      section.sectionType,
      section.contentLayer,
      section.contextPriority,
      section.headingLevel,
      section.title,
      JSON.stringify(section.headingPath),
      JSON.stringify(section.aliases),
      section.ordinal,
      section.sourceLineStart,
      section.sourceLineEnd,
      section.contentChars,
      section.estimatedTokens,
      section.directMarkdown,
      section.deliveryMarkdown,
      section.retrievalText,
      section.contentSha256,
      section.isSearchable
    ]
  );
}

function stateFromRow(value: Row): AuthorStyleState {
  const row = record(value);
  return {
    activeRevisionSha256: optionalString(row.active_revision_sha256),
    activeSourceMarkdownSha256: optionalString(row.active_source_markdown_sha256),
    sourcePathKey: requiredString(row.source_path_key, "source_path_key")
  };
}

function notionSourceKey(pageId: string): string {
  return `notion:${pageId}`;
}

function databaseFailure(error: unknown): SyncFailure {
  if (error instanceof SyncFailure) return error;
  return new SyncFailure(
    "tidb_operation_failed",
    `TiDB operation failed: ${error instanceof Error ? error.message : String(error)}`,
    { retryable: true }
  );
}

async function safeRollback(tx: Tx<{ url: string }>): Promise<void> {
  try {
    await tx.rollback();
  } catch {
    // Preserve the original database error.
  }
}

function record(value: Row | undefined): Record<string, unknown> {
  return value !== undefined && !Array.isArray(value) ? value : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncFailure("tidb_shape_invalid", `${name} must be a non-empty string`);
  }
  return value;
}
