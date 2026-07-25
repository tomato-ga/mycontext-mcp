import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoadedAuthorStyleDocument } from "../../mycontext-sync/src/authorStyle.js";
import { parseEditorKnowledgeSectionedMarkdown } from "../../mycontext-sync/src/editorKnowledge.js";
import { sha256 } from "../src/hash.js";
import {
  canonicalAuthorStyleMarkdown,
  processSyncMessage,
  syncFingerprint
} from "../src/sync.js";
import type {
  AuthorStyleState,
  ManagedNotionDocument,
  NotionGateway,
  SyncMessage,
  SyncRepository
} from "../src/types.js";
import { SyncFailure } from "../src/types.js";

const pageId = "11111111-1111-1111-1111-111111111111";
const now = new Date("2026-07-22T12:00:00.000Z");

describe("Notion-managed context synchronization", () => {
  let notion: NotionGateway;
  let repository: SyncRepository;
  let currentManaged: ManagedNotionDocument;

  beforeEach(() => {
    currentManaged = managedDocument();
    notion = {
      getManagedDocument: vi.fn().mockImplementation(async () => ({ ...currentManaged })),
      getMarkdown: vi.fn().mockResolvedValue(markdown("# Profile\n\nBody")),
      updateWorkflow: vi.fn().mockImplementation(async (_pageId, update) => {
        currentManaged = {
          ...currentManaged,
          status: update.status,
          syncedHash: update.syncedHash === undefined
            ? currentManaged.syncedHash
            : update.syncedHash,
          activeRevision: update.activeRevision === undefined
            ? currentManaged.activeRevision
            : update.activeRevision
        };
      }),
      findByDocumentId: vi.fn()
    };
    vi.mocked(notion.findByDocumentId).mockImplementation(async () => [{ ...currentManaged }]);
    repository = {
      appendSyncStateLog: vi.fn(),
      syncNotionPage: vi.fn(),
      getAuthorStyleState: vi.fn().mockResolvedValue(null),
      activateAuthorStyle: vi.fn(),
      getEditorKnowledgeSectionedState: vi.fn().mockResolvedValue(null),
      activateEditorKnowledgeSectioned: vi.fn()
    };
  });

  it("syncs a Ready personal-context page and marks it Synced", async () => {
    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      now: () => now
    });

    expect(result.status).toBe("synced");
    expect(repository.syncNotionPage).toHaveBeenCalledWith(expect.objectContaining({
      pageId,
      originalPageId: null,
      title: "Profile",
      markdown: "# Profile\n\nBody"
    }));
    expect(notion.updateWorkflow).toHaveBeenNthCalledWith(1, pageId, {
      status: "Syncing",
      validationError: null
    });
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Synced",
      syncedHash: syncFingerprint(managedDocument(), "# Profile\n\nBody"),
      lastSyncedAt: now.toISOString()
    }));
    expect(vi.mocked(repository.appendSyncStateLog).mock.calls.map(([entry]) => entry.state))
      .toEqual([
        "received",
        "eligible",
        "syncing",
        "source_verified",
        "content_validated",
        "persisted",
        "synced"
      ]);
  });

  it("syncs a Ready AI Skill through the generic Notion read model", async () => {
    currentManaged = managedDocument({
      documentId: "resolution-diagnose",
      name: "resolution-diagnose: 解像度診断",
      category: "AI Skill",
      schemaVersion: "ai-skill-v1"
    });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      now: () => now
    });

    expect(result.status).toBe("synced");
    expect(repository.syncNotionPage).toHaveBeenCalledWith(expect.objectContaining({
      pageId,
      title: "resolution-diagnose: 解像度診断"
    }));
  });

  it("keeps a Metaskill snapshot read-only when someone sets it Ready", async () => {
    currentManaged = managedDocument({
      documentId: "ai-self-strategy",
      name: "メタスキル — キャプチャ文字起こし",
      category: "Metaskill",
      schemaVersion: "metaskill-v1",
      syncSource: "TiDB"
    });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toMatchObject({ status: "failed", reason: "metaskill_snapshot_read_only" });
    expect(repository.syncNotionPage).not.toHaveBeenCalled();
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Conflict"
    }));
  });

  it("surfaces an invalid Notion management schema on the page", async () => {
    vi.mocked(notion.getManagedDocument).mockRejectedValue(new SyncFailure(
      "notion_property_missing",
      "Document ID must not be empty"
    ));

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toEqual({ pageId, status: "failed", reason: "notion_property_missing" });
    expect(notion.updateWorkflow).toHaveBeenCalledWith(pageId, expect.objectContaining({
      status: "Error",
      validationError: expect.stringContaining("Document ID")
    }));
  });

  it("ignores pages outside the configured data source without modifying them", async () => {
    vi.mocked(notion.getManagedDocument).mockRejectedValue(new SyncFailure(
      "notion_data_source_mismatch",
      "outside data source",
      { workflowStatus: "Conflict" }
    ));

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toEqual({ pageId, status: "ignored", reason: "notion_data_source_mismatch" });
    expect(notion.updateWorkflow).not.toHaveBeenCalled();
  });

  it("ignores a self-generated property event when the Notion fingerprint is unchanged", async () => {
    currentManaged = managedDocument({
      status: "Synced",
      syncedHash: syncFingerprint(managedDocument(), "# Profile\n\nBody")
    });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result.status).toBe("ignored");
    expect(repository.syncNotionPage).not.toHaveBeenCalled();
  });

  it("reports Conflict when Document ID is duplicated", async () => {
    vi.mocked(notion.findByDocumentId).mockResolvedValue([
      managedDocument(),
      managedDocument({ pageId: "duplicate-page" })
    ]);

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toMatchObject({ status: "failed", reason: "notion_document_id_duplicate" });
    expect(repository.syncNotionPage).not.toHaveBeenCalled();
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Conflict"
    }));
  });

  it("resumes an idempotent retry from Syncing", async () => {
    currentManaged = managedDocument({ status: "Syncing" });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result.status).toBe("synced");
    expect(notion.updateWorkflow).not.toHaveBeenCalledWith(pageId, expect.objectContaining({
      status: "Syncing"
    }));
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Synced"
    }));
  });

  it("activates a Notion revision when adopting an existing local author style", async () => {
    const sourceMarkdown = "# Style";
    const document = authorStyleDocument(sourceMarkdown, "new-revision");
    currentManaged = managedDocument({
      documentId: "ore-body-style",
      name: "Body style",
      category: "Author Style",
      schemaVersion: "author-style-v1"
    });
    vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(sourceMarkdown));
    vi.mocked(repository.getAuthorStyleState).mockResolvedValue({
      activeRevisionSha256: "existing-revision",
      activeSourceMarkdownSha256: sha256("# Existing local style"),
      sourcePathKey: "knowledge/ore-body-style-analysis.md"
    } satisfies AuthorStyleState);

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      parseAuthorStyle: () => document
    });

    expect(result).toMatchObject({ status: "synced", revisionSha256: "new-revision" });
    expect(repository.activateAuthorStyle).toHaveBeenCalledWith({
      document,
      notionPageId: pageId,
      expectedState: expect.objectContaining({ sourcePathKey: "knowledge/ore-body-style-analysis.md" })
    });
  });

  it("reports Conflict when another Notion page already owns an author style", async () => {
    const document = authorStyleDocument("# Notion style", "notion-revision");
    currentManaged = managedDocument({
      documentId: "ore-body-style",
      name: "Body style",
      category: "Author Style",
      schemaVersion: "author-style-v1"
    });
    vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(document.sourceMarkdown));
    vi.mocked(repository.getAuthorStyleState).mockResolvedValue({
      activeRevisionSha256: "existing-revision",
      activeSourceMarkdownSha256: sha256("# Existing style"),
      sourcePathKey: "notion:another-page"
    });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      parseAuthorStyle: () => document
    });

    expect(result).toMatchObject({ status: "failed", reason: "author_style_owned_by_another_notion_page" });
    expect(repository.activateAuthorStyle).not.toHaveBeenCalled();
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Conflict"
    }));
  });

  it("activates a changed author style after Notion already owns it", async () => {
    const document = authorStyleDocument("# Updated style", "updated-revision");
    const state: AuthorStyleState = {
      activeRevisionSha256: "old-revision",
      activeSourceMarkdownSha256: sha256("# Old style"),
      sourcePathKey: `notion:${pageId}`
    };
    currentManaged = managedDocument({
      documentId: "ore-body-style",
      name: "Body style",
      category: "Author Style",
      schemaVersion: "author-style-v1"
    });
    vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(document.sourceMarkdown));
    vi.mocked(repository.getAuthorStyleState).mockResolvedValue(state);

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      parseAuthorStyle: () => document
    });

    expect(result).toMatchObject({ status: "synced", revisionSha256: "updated-revision" });
    expect(repository.activateAuthorStyle).toHaveBeenCalledWith({
      document,
      notionPageId: pageId,
      expectedState: state
    });
  });

  it("does not write if Notion content changes during synchronization", async () => {
    vi.mocked(notion.getMarkdown)
      .mockResolvedValueOnce(markdown("# First"))
      .mockResolvedValueOnce(markdown("# Second"));

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toMatchObject({ status: "failed", reason: "notion_content_changed_during_sync" });
    expect(repository.syncNotionPage).not.toHaveBeenCalled();
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Conflict"
    }));
  });

  it("keeps the active revision when Notion Markdown is incomplete", async () => {
    vi.mocked(notion.getMarkdown).mockResolvedValue({
      markdown: "# Partial",
      truncated: true,
      unknownBlockIds: ["block-1"]
    });

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository
    });

    expect(result).toMatchObject({ status: "failed", reason: "notion_markdown_incomplete" });
    expect(repository.syncNotionPage).not.toHaveBeenCalled();
    expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
      status: "Error"
    }));
  });

  it("keeps reproducible evidence when the historical chapter mapping error occurs", async () => {
    currentManaged = managedDocument({
      documentId: "ore-body-style",
      name: "Body style",
      category: "Author Style",
      schemaVersion: "author-style-v1"
    });
    vi.mocked(notion.getMarkdown).mockResolvedValue(markdown("## 21. Longform\n\n### 21.9 Contract\n\nBody\n\n## 22. References"));

    const result = await processSyncMessage(message("page.properties_updated"), {
      notion,
      repository,
      now: () => now,
      parseAuthorStyle: () => {
        throw new SyncFailure(
          "author_style_validation_failed",
          "expected H3 delivery sections under 22. References"
        );
      }
    });

    expect(result).toMatchObject({ status: "failed", reason: "author_style_validation_failed" });
    const entries = vi.mocked(repository.appendSyncStateLog).mock.calls.map(([entry]) => entry);
    expect(entries.at(-1)).toMatchObject({
      state: "failed",
      documentId: "ore-body-style",
      validationStatus: "failed",
      parserVersion: "author-style-parser-v2",
      errorCode: "author_style_validation_failed",
      errorMessage: "expected H3 delivery sections under 22. References",
      retryable: false,
      nextAction: "review_notion_and_set_ready"
    });
    expect(entries.at(-1)?.sourceMarkdownSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entries.at(-1)?.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(entries.some((entry) => entry.state === "content_validated")).toBe(false);
  });

  it("restores an H1 from the Notion page title for author-style parsing", () => {
    expect(canonicalAuthorStyleMarkdown(
      managedDocument({ name: "山田太郎 タイトル再現ガイド" }),
      "## 使い方\n\n本文"
    )).toBe("# 山田太郎 タイトル再現ガイド\n\n## 使い方\n\n本文");
    expect(canonicalAuthorStyleMarkdown(
      managedDocument({ name: "Ignored" }),
      "# Existing title\n\nBody"
    )).toBe("# Existing title\n\nBody");
  });

  describe("Editor Knowledge (kikaku) synchronization", () => {
    it("restores the H1 from the Notion page Name when the page body has none, like Author Style", async () => {
      // Notion page bodies hold only the content blocks; the title lives in the Name
      // property, never as an H1 block in the body. This mirrors
      // canonicalAuthorStyleMarkdown's normalization exactly.
      const bodyWithoutH1 = [
        "## 1. 企画の立て方",
        "第1章の本文。",
        "",
        "## 2. 構成の作り方",
        "第2章の本文。",
        ""
      ].join("\n");
      currentManaged = managedDocument({
        documentId: "kikaku-composition-playbook",
        name: "企画構成プレイブック",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(bodyWithoutH1));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "synced" });
      const activated = vi.mocked(repository.activateEditorKnowledgeSectioned).mock.calls[0]?.[0];
      expect(activated?.document.title).toBe("企画構成プレイブック");
      expect(activated?.document.markdown.startsWith("# 企画構成プレイブック\n\n## 1. 企画の立て方")).toBe(true);
    });

    it("restores the H1 for kikaku-db-catalog from its Name too", async () => {
      const bodyWithoutH1 = [
        "## テーマ群A｜EC×D2C戦略",
        "グループAの概要文。",
        "",
        "### No.1 ｜ 最初の企画",
        "企画1の本文。",
        ""
      ].join("\n");
      currentManaged = managedDocument({
        documentId: "kikaku-db-catalog",
        name: "コンテンツ企画案カタログ（全424件）",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(bodyWithoutH1));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "synced" });
      const activated = vi.mocked(repository.activateEditorKnowledgeSectioned).mock.calls[0]?.[0];
      expect(activated?.document.title).toBe("コンテンツ企画案カタログ（全424件）");
    });

    it("syncs a Ready kikaku-composition-playbook page and marks it Synced", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-composition-playbook",
        name: "企画構成プレイブック",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(KIKAKU_PLAYBOOK_MARKDOWN));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "synced", documentId: "kikaku-composition-playbook" });
      expect(repository.activateEditorKnowledgeSectioned).toHaveBeenCalledOnce();
      const activated = vi.mocked(repository.activateEditorKnowledgeSectioned).mock.calls[0]?.[0];
      expect(activated?.document).toMatchObject({
        documentId: "kikaku-composition-playbook",
        sectionCount: 2,
        searchSpanCount: 2
      });
      expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
        status: "Synced"
      }));
      const entries = vi.mocked(repository.appendSyncStateLog).mock.calls.map(([entry]) => entry);
      expect(entries.at(-1)).toMatchObject({
        state: "synced",
        parserVersion: "section-parser-v1",
        sectioningVersion: "section-first-v1",
        routingVersion: null
      });
    });

    it("syncs a Ready kikaku-db-catalog page, preserving No.N ｜ Title and group headings", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-db-catalog",
        name: "企画カタログ427",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(KIKAKU_CATALOG_MARKDOWN));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "synced", documentId: "kikaku-db-catalog" });
      const activated = vi.mocked(repository.activateEditorKnowledgeSectioned).mock.calls[0]?.[0];
      expect(activated?.document.sections.map((section) => section.sectionId)).toEqual([
        "group-a",
        "no-001",
        "no-002"
      ]);
      const entry = activated?.document.sections.find((section) => section.sectionId === "no-001");
      // the exact Markdown text Notion is expected to hand back for an entry heading — this
      // is the round-trip fidelity the format contract depends on: the full-width pipe "｜",
      // the "### No.N" prefix, and no flattening to a different heading level survive intact
      expect(entry?.retrievalText).toBe("### No.1 ｜ 最初の企画\n企画1の本文。");
      expect(entry?.title).toBe("No.1 ｜ 最初の企画");
    });

    it("skips re-activation when the section revision is unchanged", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-composition-playbook",
        name: "企画構成プレイブック",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(KIKAKU_PLAYBOOK_MARKDOWN));
      const parsed = parseEditorKnowledgeSectionedMarkdown({
        documentId: "kikaku-composition-playbook",
        markdown: KIKAKU_PLAYBOOK_MARKDOWN,
        sourcePathKey: `notion:${pageId}`
      });
      vi.mocked(repository.getEditorKnowledgeSectionedState).mockResolvedValue({
        activeSectionRevisionSha256: parsed.sectionRevisionSha256
      });

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "skipped" });
      expect(repository.activateEditorKnowledgeSectioned).not.toHaveBeenCalled();
    });

    it("fails with a validation error and sets Notion to Error when the format contract is violated", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-composition-playbook",
        name: "企画構成プレイブック",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      // no ## chapter headings at all — violates the format contract
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown("# 企画構成プレイブック\n\n本文のみ。\n"));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository
      });

      expect(result).toMatchObject({ status: "failed", reason: "editor_knowledge_validation_failed" });
      expect(repository.activateEditorKnowledgeSectioned).not.toHaveBeenCalled();
      expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
        status: "Error",
        validationError: expect.stringContaining("editor_knowledge_validation_failed")
      }));
    });

    it("fails with Error when the Document ID is not a known kikaku document", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-unknown-doc",
        name: "不明な企画文書",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(KIKAKU_PLAYBOOK_MARKDOWN));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository
      });

      expect(result).toMatchObject({ status: "failed", reason: "editor_knowledge_document_id_invalid" });
      expect(repository.activateEditorKnowledgeSectioned).not.toHaveBeenCalled();
      expect(notion.updateWorkflow).toHaveBeenLastCalledWith(pageId, expect.objectContaining({
        status: "Error"
      }));
    });

    it("does not touch Editor Knowledge repository methods when syncing other categories", async () => {
      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result.status).toBe("synced");
      expect(repository.getEditorKnowledgeSectionedState).not.toHaveBeenCalled();
      expect(repository.activateEditorKnowledgeSectioned).not.toHaveBeenCalled();
    });

    it("routes a kikaku-fulltext-* Document ID to the fulltext parser, keeping other headings as body text", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-fulltext-3",
        name: "企画ノウハウ全文集 3（No.97〜No.144）",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown(KIKAKU_FULLTEXT_MARKDOWN));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository,
        now: () => now
      });

      expect(result).toMatchObject({ status: "synced", documentId: "kikaku-fulltext-3" });
      const activated = vi.mocked(repository.activateEditorKnowledgeSectioned).mock.calls[0]?.[0];
      expect(activated?.document.sections.map((section) => section.sectionId)).toEqual([
        "preamble",
        "no-097",
        "no-098",
        "x-01"
      ]);
      const entry = activated?.document.sections.find((section) => section.sectionId === "no-097");
      expect(entry?.sectionMarkdown).toContain("### 根拠ノート全文（マスキング済み）");
      expect(entry?.sectionMarkdown).toContain("## No.9 ｜ dummy"); // fenced, not a real boundary
    });

    it("fails when a kikaku-fulltext-* page violates the entry heading contract via a duplicate No.", async () => {
      currentManaged = managedDocument({
        documentId: "kikaku-fulltext-9",
        name: "企画ノウハウ全文集 9",
        category: "Editor Knowledge",
        schemaVersion: "editor-knowledge-v1"
      });
      vi.mocked(notion.getMarkdown).mockResolvedValue(markdown([
        "## No.1 ｜ 一つ目",
        "本文",
        "",
        "## No.1 ｜ 重複",
        "本文",
        ""
      ].join("\n")));

      const result = await processSyncMessage(message("page.properties_updated"), {
        notion,
        repository
      });

      expect(result).toMatchObject({ status: "failed", reason: "editor_knowledge_validation_failed" });
      expect(repository.activateEditorKnowledgeSectioned).not.toHaveBeenCalled();
    });
  });

});

function managedDocument(
  overrides: Partial<ManagedNotionDocument> = {}
): ManagedNotionDocument {
  return {
    pageId,
    dataSourceId: "data-source",
    documentId: "profile",
    name: "Profile",
    category: "Personal Context",
    status: "Ready",
    active: true,
    schemaVersion: "personal-context-v1",
    syncSource: "Notion",
    originalPageId: null,
    syncedHash: null,
    activeRevision: null,
    lastEditedTime: "2026-07-22T11:59:00.000Z",
    ...overrides
  } as ManagedNotionDocument;
}

function markdown(value: string) {
  return { markdown: value, truncated: false, unknownBlockIds: [] };
}

function message(eventType: SyncMessage["eventType"] = "page.properties_updated"): SyncMessage {
  return { eventId: "event-1", eventType, pageId, timestamp: now.toISOString() };
}

function authorStyleDocument(
  sourceMarkdown: string,
  revisionSha256: string
): LoadedAuthorStyleDocument {
  return {
    documentId: "ore-body-style",
    authorKey: "ore",
    styleScope: "body",
    displayName: "Body style",
    sourcePathKey: `notion:${pageId}`,
    sourceMarkdown,
    sourceMarkdownSha256: sha256(sourceMarkdown),
    sourceBytes: new TextEncoder().encode(sourceMarkdown).byteLength,
    sourceLineCount: 1,
    sourceMtimeMs: 1,
    revisionSha256,
    parserVersion: "parser-v1",
    sectioningVersion: "sectioning-v1",
    routingVersion: "routing-v1",
    routingManifest: {},
    outline: {},
    sectionCount: 0,
    deliverySectionCount: 0,
    searchSpanCount: 0,
    sections: []
  };
}

// Representative of what the Notion "page markdown" API is expected to hand back for a kikaku
// page's blocks: heading text (including the format contract's literal "## N." prefix and the
// full-width "｜" delimiter) preserved verbatim as plain heading text, not reinterpreted into
// something else (e.g. an ordered list). These fixtures stand in for that external conversion
// boundary — see notion.ts's getMarkdown, which calls Notion's own /markdown endpoint.
const KIKAKU_PLAYBOOK_MARKDOWN = [
  "# 企画構成プレイブック",
  "",
  "## 1. 企画の立て方",
  "第1章の本文。",
  "",
  "## 2. 構成の作り方",
  "第2章の本文。",
  ""
].join("\n");

const KIKAKU_CATALOG_MARKDOWN = [
  "# 企画カタログ427",
  "",
  "## テーマ群A｜EC×D2C戦略",
  "グループAの概要文。",
  "",
  "### No.1 ｜ 最初の企画",
  "企画1の本文。",
  "",
  "### No.2 ｜ 二つ目の企画",
  "企画2の本文。",
  ""
].join("\n");

// kikaku-fulltext-* has no group/sequence contract: entry boundaries are only H2 lines matching
// "No.N ｜ Title" / "No.なし-N ｜ Title" exactly, and everything else (other heading levels,
// fenced code) survives verbatim as body text.
const KIKAKU_FULLTEXT_MARKDOWN = [
  "# 企画ノウハウ全文集 3（No.97〜No.144）",
  "",
  "コンテンツ企画案DBの根拠ノート本文を無加工（機微情報マスキングのみ）で収録した全文集。",
  "",
  "## No.97 ｜ 最初の企画",
  "- **索引**: editor-knowledge:kikaku-db-catalog#no-097",
  "",
  "### 根拠ノート全文（マスキング済み）",
  "",
  "本文1。コードフェンス内のダミー見出しはエントリ境界にならない:",
  "```",
  "## No.9 ｜ dummy",
  "```",
  "",
  "## No.98 ｜ 二つ目の企画",
  "- **索引**: editor-knowledge:kikaku-db-catalog#no-098",
  "",
  "### 根拠ノート全文（マスキング済み）",
  "",
  "本文2。",
  "",
  "## No.なし-1 ｜ 番号なしの企画",
  "根拠ノート本文はDB上に存在しない（本文取得状態: 未特定）。索引の要旨を参照。",
  ""
].join("\n");
