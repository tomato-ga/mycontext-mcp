import type { Connection, Tx } from "@tidbcloud/serverless";
import { describe, expect, it, vi } from "vitest";
import type { LoadedAuthorStyleDocument } from "../../mycontext-sync/src/authorStyle.js";
import { parseEditorKnowledgeSectionedMarkdown } from "../../mycontext-sync/src/editorKnowledge.js";
import { TidbSyncRepository } from "../src/tidb.js";
import type { AuthorStyleState } from "../src/types.js";
import type { SyncStateLogEntry } from "../src/types.js";

describe("TiDB sync writer", () => {
  it("appends an idempotent state-log event without updating history", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repository = new TidbSyncRepository("unused", {
      execute
    } as unknown as Connection<{ url: string }>);

    await repository.appendSyncStateLog(stateLogEntry());

    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0] ?? [];
    expect(String(sql)).toContain("INSERT IGNORE INTO context_sync_state_log");
    expect(String(sql)).not.toMatch(/\b(?:UPDATE|DELETE)\b/i);
    expect(params).toHaveLength(26);
    expect(params?.[0]).toBe("l".repeat(64));
    expect(params?.[1]).toBe("r".repeat(64));
  });

  it("moves an existing personal-context row to its managed Notion page id", async () => {
    const tx = transaction([[{ page_id: "legacy-page" }]]);
    const repository = new TidbSyncRepository("unused", connection(tx));

    await repository.syncNotionPage({
      pageId: "managed-page",
      originalPageId: "legacy-page",
      title: "Profile",
      markdown: "# Profile",
      markdownSha256: "hash"
    });

    const statements = vi.mocked(tx.execute).mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("SET page_id = ?"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO notion_pages"))).toBe(false);
    expect(tx.commit).toHaveBeenCalledOnce();
  });

  it("rejects a personal-context migration when both page ids already exist", async () => {
    const tx = transaction([[
      { page_id: "managed-page" },
      { page_id: "legacy-page" }
    ]]);
    const repository = new TidbSyncRepository("unused", connection(tx));

    await expect(repository.syncNotionPage({
      pageId: "managed-page",
      originalPageId: "legacy-page",
      title: "Profile",
      markdown: "# Profile",
      markdownSha256: "hash"
    })).rejects.toMatchObject({ code: "notion_page_migration_conflict", retryable: false });
    expect(tx.rollback).toHaveBeenCalledOnce();
    expect(tx.commit).not.toHaveBeenCalled();
  });

  it("updates the managed personal-context row without inserting a duplicate", async () => {
    const tx = transaction([[{ page_id: "managed-page" }]]);
    const repository = new TidbSyncRepository("unused", connection(tx));

    await repository.syncNotionPage({
      pageId: "managed-page",
      originalPageId: "legacy-page",
      title: "Profile",
      markdown: "# Profile",
      markdownSha256: "hash"
    });

    const statements = vi.mocked(tx.execute).mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("UPDATE notion_pages"))).toBe(true);
    expect(statements.some((sql) => sql.includes("INSERT INTO notion_pages"))).toBe(false);
    expect(tx.commit).toHaveBeenCalledOnce();
  });

  it("writes a new immutable revision and switches active inside one transaction", async () => {
    const tx = transaction([[]]);
    const repository = new TidbSyncRepository("unused", connection(tx));

    await repository.activateAuthorStyle({
      document: document(),
      notionPageId: "page-1",
      expectedState: null
    });

    const statements = vi.mocked(tx.execute).mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("INSERT INTO author_style_revisions"))).toBe(true);
    expect(statements.some((sql) => sql.includes("active_revision_sha256 = ?"))).toBe(true);
    expect(tx.commit).toHaveBeenCalledOnce();
  });

  it("rolls back instead of overwriting a concurrently changed active revision", async () => {
    const expected: AuthorStyleState = {
      activeRevisionSha256: "old",
      activeSourceMarkdownSha256: "source",
      sourcePathKey: "notion:page-1"
    };
    const tx = transaction([stateRow({ ...expected, activeRevisionSha256: "new" })]);
    const repository = new TidbSyncRepository("unused", connection(tx));

    await expect(repository.activateAuthorStyle({
      document: document(),
      notionPageId: "page-1",
      expectedState: expected
    })).rejects.toMatchObject({ code: "author_style_concurrent_update", retryable: false });
    expect(tx.rollback).toHaveBeenCalledOnce();
    expect(tx.commit).not.toHaveBeenCalled();
  });

  it("stores a compact playbook in the document row and removes former chapter rows", async () => {
    const tx = transaction([]);
    const repository = new TidbSyncRepository("unused", connection(tx));
    const document = parseEditorKnowledgeSectionedMarkdown({
      documentId: "knowhow-media-design",
      sourcePathKey: "notion:media",
      markdown: "# メディア運営プレイブック\n\n## 1. 方針\n本文"
    });

    await repository.activateEditorKnowledgeSectioned({ document });

    const calls = vi.mocked(tx.execute).mock.calls;
    const upsert = calls.find(([sql]) => String(sql).includes("INSERT INTO editor_knowledge_documents"));
    expect(upsert?.[1]).toEqual([
      "knowhow-media-design",
      "メディア運営プレイブック",
      document.markdown,
      document.markdownSha256,
      null,
      null,
      null
    ]);
    expect(calls).toEqual(expect.arrayContaining([[
      expect.stringContaining("DELETE FROM editor_knowledge_sections"),
      ["knowhow-media-design"]
    ]]));
    expect(calls.some(([sql]) => String(sql).includes("INSERT INTO editor_knowledge_sections")))
      .toBe(false);
    expect(tx.commit).toHaveBeenCalledOnce();
  });
});

function transaction(firstResults: unknown[]): Tx<{ url: string }> {
  const results = [...firstResults];
  return {
    execute: vi.fn().mockImplementation(async () => results.shift() ?? []),
    commit: vi.fn().mockResolvedValue([]),
    rollback: vi.fn().mockResolvedValue([])
  } as unknown as Tx<{ url: string }>;
}

function connection(tx: Tx<{ url: string }>): Connection<{ url: string }> {
  return {
    begin: vi.fn().mockResolvedValue(tx)
  } as unknown as Connection<{ url: string }>;
}

function stateRow(state: AuthorStyleState) {
  return [{
    active_revision_sha256: state.activeRevisionSha256,
    active_source_markdown_sha256: state.activeSourceMarkdownSha256,
    source_path_key: state.sourcePathKey
  }];
}

function document(): LoadedAuthorStyleDocument {
  return {
    documentId: "ore-body-style",
    authorKey: "ore",
    styleScope: "body",
    displayName: "Body style",
    sourcePathKey: "notion:page-1",
    sourceMarkdown: "# Body style",
    sourceMarkdownSha256: "source",
    sourceBytes: 12,
    sourceLineCount: 1,
    sourceMtimeMs: 1,
    revisionSha256: "revision",
    parserVersion: "parser",
    sectioningVersion: "sectioning",
    routingVersion: "routing",
    routingManifest: {},
    outline: {},
    sectionCount: 0,
    deliverySectionCount: 0,
    searchSpanCount: 0,
    sections: []
  };
}

function stateLogEntry(): SyncStateLogEntry {
  return {
    logId: "l".repeat(64),
    runId: "r".repeat(64),
    sequenceNo: 1,
    eventId: "event-1",
    eventType: "page.properties_updated",
    deliveryAttempt: 1,
    triggeredAt: "2026-07-22T12:00:00.000Z",
    recordedAt: "2026-07-22T12:00:01.000Z",
    pageId: "page-1",
    documentId: "ore-body-style",
    category: "Author Style",
    state: "failed",
    workflowStatus: "Error",
    validationStatus: "failed",
    inputFingerprint: "f".repeat(64),
    sourceMarkdownSha256: "s".repeat(64),
    activeRevisionBefore: "a".repeat(64),
    candidateRevisionSha256: null,
    parserVersion: "author-style-parser-v2",
    sectioningVersion: "semantic-delivery-v1",
    routingVersion: "single-context-pack-v1",
    errorCode: "author_style_validation_failed",
    errorMessage: "expected H3 delivery sections under 22",
    retryable: false,
    nextAction: "review_notion_and_set_ready",
    details: { traceVersion: 1 }
  };
}
