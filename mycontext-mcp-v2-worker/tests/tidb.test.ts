import { describe, expect, it, vi } from "vitest";
import type { PersonalSynonymConfig } from "../src/searchQuery.js";
import {
  buildDocumentReadModelSql,
  buildKeywordSearchParams,
  buildKeywordSearchSql,
  buildLikePattern,
  buildSearchSql,
  checkHealth,
  escapeLikePattern,
  getBusinessKnowledgeSection,
  getDocument,
  getEditorKnowledgeSection,
  listDocuments,
  searchContext,
  TopKValidationError,
  type TidbClient,
  validateTopK
} from "../src/tidb.js";

describe("validateTopK", () => {
  it("allows integers from 1 to 20", () => {
    expect(validateTopK(1)).toBe(1);
    expect(validateTopK(5)).toBe(5);
    expect(validateTopK(20)).toBe(20);
  });

  it("rejects values outside the allowed range", () => {
    expect(() => validateTopK(0)).toThrow(TopKValidationError);
    expect(() => validateTopK(21)).toThrow(TopKValidationError);
  });

  it("rejects non-integers", () => {
    expect(() => validateTopK(1.5)).toThrow(TopKValidationError);
  });
});

describe("LIKE pattern escaping", () => {
  it("escapes SQL LIKE wildcards and the escape character", () => {
    expect(escapeLikePattern("100%_\\done")).toBe("100\\%\\_\\\\done");
    expect(buildLikePattern("100%_\\done")).toBe("%100\\%\\_\\\\done%");
  });
});

describe("buildSearchSql", () => {
  it("keeps full-document search and adds active-revision Small2Big section search", () => {
    const sql = buildSearchSql(5);

    expect(sql).toContain("LIMIT 5");
    expect(sql).not.toContain("LIMIT ?");
    expect(sql).toContain("FROM notion_pages");
    expect(sql).toContain("FROM editor_knowledge_documents");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("CONCAT('notion:', page_id)");
    expect(sql).toContain("CONCAT('editor-knowledge:', document_id)");
    expect(sql).toContain("JOIN business_knowledge_sections AS matched_sections");
    expect(sql).toContain("matched_sections.section_revision_sha256 = documents.section_revision_sha256");
    expect(sql).toContain("delivery_sections.section_id = matched_sections.delivery_section_id");
    expect(sql).toContain("matched_sections.is_searchable = TRUE");
    expect(sql).toContain("ROW_NUMBER() OVER");
    expect(sql).toContain("PARTITION BY source_id, delivery_section_id");
    expect(sql).toContain("WHERE delivery_match_rank = 1");
    expect(sql).toContain("delivery_sections.section_markdown AS markdown");
    expect(sql).toContain("LOCATE(?, delivery_sections.section_markdown) AS match_position");
    expect(sql).toContain("LOCATE(?, matched_sections.retrieval_text) AS matched_span_position");
    expect(sql).toContain("ORDER BY matched_span_position ASC");
    expect(sql).toContain("matched_sections.content_layer AS matched_content_layer");
    expect(sql).toContain("delivery_sections.content_layer AS delivery_content_layer");
    expect(sql).toContain("documents.source_declared_at");
    expect(sql).toContain("'$.detailAvailable'");
    expect(sql).toContain("documents.markdown LIKE ? ESCAPE '\\\\'");
    expect(sql).toContain("LOCATE(?, documents.markdown) AS match_position");
    expect(sql).not.toContain("VEC_COSINE_DISTANCE");
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it("mirrors the business span match with an editor span match, excluding it from the whole-document fallback", () => {
    const sql = buildSearchSql(5);

    expect(sql).toContain("CONCAT('editor-knowledge:', documents.document_id)");
    expect(sql).toContain("'editor_knowledge' AS source");
    expect(sql).toContain("JOIN editor_knowledge_sections AS matched_sections");
    expect(sql).toContain("FROM editor_knowledge_documents AS documents");
    expect(sql).toContain("ranked_editor_matches");
    expect(sql).toContain("FROM ranked_editor_matches");
    // the whole-document fallback is skipped for ANY sectioned document (business or editor),
    // not just business ones by name, so non-sectioned editor lessons are still found by it
    expect(sql).toContain("WHERE documents.section_count IS NULL");
    expect(sql).not.toContain("documents.source <> 'business_knowledge'");
  });
});

describe("keyword fallback SQL", () => {
  it("builds a bounded OR search with title-weighted ranking", () => {
    const sql = buildKeywordSearchSql(3, 5);
    expect(sql).toContain("matched_sections.retrieval_text LIKE ?");
    expect(sql).toContain("documents.markdown LIKE ?");
    expect(sql).toContain("documents.title LIKE ?");
    expect(sql).toContain("THEN 5 ELSE 0 END");
    expect(sql).toContain("ORDER BY search_score DESC");
    expect(sql).toContain("LIMIT 5");
    expect(sql).not.toContain("VEC_COSINE_DISTANCE");
    expect(buildKeywordSearchParams(["個人開発", "AIエージェント", "収益化"]))
      .toHaveLength(36);
  });

  it("rejects unbounded fallback term counts", () => {
    expect(() => buildKeywordSearchSql(0, 3)).toThrow(RangeError);
    expect(() => buildKeywordSearchSql(9, 3)).toThrow(RangeError);
  });

  it("also ranks editor knowledge sections and excludes them from the document fallback", () => {
    const sql = buildKeywordSearchSql(3, 5);
    expect(sql).toContain("FROM editor_knowledge_documents AS documents");
    expect(sql).toContain("ranked_editor_matches");
    expect(sql).toContain("WHERE documents.section_count IS NULL");
  });
});

describe("unified document read model", () => {
  it("uses fixed table names and normalized source fields", () => {
    const sql = buildDocumentReadModelSql();

    expect(sql).toContain("'notion' AS source");
    expect(sql).toContain("'editor_knowledge' AS source");
    expect(sql).toContain("'business_knowledge' AS source");
    expect(sql).toContain("FROM business_knowledge_documents");
    expect(sql).toContain("truncated AS source_truncated");
    expect(sql).toContain("FALSE AS source_truncated");
    expect(sql).toContain("JSON_ARRAY() AS unknown_block_ids");
    // editor_knowledge now surfaces its own section_revision_sha256/section_count/
    // search_span_count instead of always NULL, so sectioned kikaku documents (which have
    // them) are distinguishable from the 8 non-sectioned lessons (which stay NULL)
    const editorBranch = sql.slice(
      sql.indexOf("FROM notion_pages"),
      sql.indexOf("FROM business_knowledge_documents")
    );
    expect(editorBranch).toContain("FROM editor_knowledge_documents");
    expect(editorBranch).not.toContain("NULL AS section_revision_sha256");
    expect(editorBranch).not.toContain("NULL AS section_count");
    expect(editorBranch).not.toContain("NULL AS search_span_count");
    expect(editorBranch).toMatch(/\bsection_revision_sha256,/);
    expect(editorBranch).toMatch(/\bsection_count,/);
    expect(editorBranch).toMatch(/\bsearch_span_count,/);
  });

  it("maps both source rows to namespaced list output", async () => {
    const client = clientReturning([
      {
        document_id: "notion:page-1",
        source: "notion",
        source_id: "page-1",
        title: "Profile",
        markdown_sha256: "a".repeat(64),
        source_kind: null,
        ingest_scope: null,
        source_declared_at: null,
        detail_available: null,
        source_truncated: 0,
        last_synced_at: "2026-07-10T00:00:00.000Z"
      },
      {
        document_id: "editor-knowledge:lesson-04",
        source: "editor_knowledge",
        source_id: "lesson-04",
        title: "第4回: 編集作業",
        markdown_sha256: "b".repeat(64),
        source_kind: null,
        ingest_scope: null,
        source_declared_at: null,
        detail_available: null,
        source_truncated: false,
        last_synced_at: "2026-07-10T01:00:00.000Z"
      }
    ]);

    await expect(listDocuments(client)).resolves.toEqual([
      {
        document_id: "notion:page-1",
        source: "notion",
        source_id: "page-1",
        title: "Profile",
        markdown_sha256: "a".repeat(64),
        source_kind: null,
        ingest_scope: null,
        source_declared_at: null,
        detail_available: null,
        section_revision_sha256: null,
        section_count: null,
        search_span_count: null,
        source_truncated: false,
        last_synced_at: "2026-07-10T00:00:00.000Z"
      },
      {
        document_id: "editor-knowledge:lesson-04",
        source: "editor_knowledge",
        source_id: "lesson-04",
        title: "第4回: 編集作業",
        markdown_sha256: "b".repeat(64),
        source_kind: null,
        ingest_scope: null,
        source_declared_at: null,
        detail_available: null,
        section_revision_sha256: null,
        section_count: null,
        search_span_count: null,
        source_truncated: false,
        last_synced_at: "2026-07-10T01:00:00.000Z"
      }
    ]);
  });

  it("gets an editor knowledge document by unified ID", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "editor-knowledge:lesson-04",
      source: "editor_knowledge",
      source_id: "lesson-04",
      title: "第4回: 編集作業",
      markdown: "# 第4回: 編集作業",
      markdown_sha256: "b".repeat(64),
      source_truncated: 0,
      unknown_block_ids: "[]",
      last_synced_at: null
    }]);
    const client: TidbClient = { execute };

    await expect(getDocument(client, "editor-knowledge:lesson-04")).resolves.toMatchObject({
      document_id: "editor-knowledge:lesson-04",
      source: "editor_knowledge",
      unknown_block_ids: []
    });
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("WHERE document_id = ?"), [
      "editor-knowledge:lesson-04"
    ]);
  });

  it("reports notion, editor knowledge, and total health counts", async () => {
    const execute = vi.fn().mockResolvedValue([{
      notion_documents_count: "3",
      editor_knowledge_documents_count: "8",
      business_knowledge_documents_count: "2",
      business_knowledge_sections_count: "325",
      business_knowledge_search_spans_count: "287",
      author_style_documents_count: "2",
      author_style_sections_count: "201",
      author_style_search_spans_count: "141",
      metaskill_documents_count: "1",
      metaskill_sections_count: "270",
      metaskill_search_spans_count: "230",
      documents_count: "13",
      latest_synced_at: "2026-07-10T01:00:00.000Z"
    }]);
    const client: TidbClient = { execute };

    await expect(checkHealth(client)).resolves.toEqual({
      ok: true,
      db: "ok",
      notion_documents_count: 3,
      editor_knowledge_documents_count: 8,
      business_knowledge_documents_count: 2,
      business_knowledge_sections_count: 325,
      business_knowledge_search_spans_count: 287,
      author_style_documents_count: 2,
      author_style_sections_count: 201,
      author_style_search_spans_count: 141,
      metaskill_documents_count: 1,
      metaskill_sections_count: 270,
      metaskill_search_spans_count: 230,
      documents_count: 13,
      latest_synced_at: "2026-07-10T01:00:00.000Z"
    });
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("active_business_section_health AS");
    expect(sql).toContain("COUNT(*) AS business_knowledge_sections_count");
    expect(sql).toContain("sections.is_searchable = TRUE");
    expect(sql).toContain("sections.section_revision_sha256 = documents.section_revision_sha256");
    expect(sql).toContain("active_author_style_health AS");
    expect(sql).toContain("active_metaskill_health AS");
    expect(sql).toContain("sections.revision_sha256 = documents.active_revision_sha256");
    expect(sql).not.toContain("THEN section_count");
    expect(sql).not.toContain("THEN search_span_count");
  });

  it("reports db:error when active section rows cannot be queried", async () => {
    const client: TidbClient = {
      execute: vi.fn().mockRejectedValue(new Error("SELECT denied on business_knowledge_sections"))
    };
    await expect(checkHealth(client)).resolves.toEqual({ ok: false, db: "error" });
  });

  it("maps business knowledge document metadata without changing existing source fields", async () => {
    const client = clientReturning([{
      document_id: "business-knowledge:startup-science",
      source: "business_knowledge",
      source_id: "startup-science",
      title: "起業の科学",
      markdown_sha256: "c".repeat(64),
      source_kind: "book_summary",
      ingest_scope: "full_summary",
      source_declared_at: null,
      detail_available: null,
      section_revision_sha256: "d".repeat(64),
      section_count: "279",
      search_span_count: 241,
      source_truncated: 0,
      last_synced_at: null
    }]);

    await expect(listDocuments(client)).resolves.toEqual([{
      document_id: "business-knowledge:startup-science",
      source: "business_knowledge",
      source_id: "startup-science",
      title: "起業の科学",
      markdown_sha256: "c".repeat(64),
      source_kind: "book_summary",
      ingest_scope: "full_summary",
      source_declared_at: null,
      detail_available: null,
      section_revision_sha256: "d".repeat(64),
      section_count: 279,
      search_span_count: 241,
      source_truncated: false,
      last_synced_at: null
    }]);
  });
});

describe("business knowledge section retrieval", () => {
  it("maps the smallest matched span to its full delivery section and stable resource URI", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "business-knowledge:startup-science",
      source: "business_knowledge",
      source_id: "startup-science",
      title: "起業の科学",
      markdown: "## 18. エバンジェリストカスタマー\n\n親セクション全文",
      match_position: 4,
      matched_span_position: 7,
      matched_section_id: "detail-18-problem-interview",
      matched_section_title: "プロブレムインタビューの5つのポイント",
      matched_content_layer: "detail",
      delivery_section_id: "detail-18",
      delivery_section_title: "18. エバンジェリストカスタマー",
      delivery_content_layer: "detail",
      heading_path_json: JSON.stringify(["起業の科学", "18. エバンジェリストカスタマー"]),
      source_line_start: "1248",
      source_line_end: 1260,
      delivery_line_start: 1241,
      delivery_line_end: 1300,
      related_source_path: null,
      freshness_class: "static_framework",
      source_kind: "book_summary",
      ingest_scope: "full_summary",
      source_declared_at: null,
      detail_available: null
    }]);
    const client: TidbClient = { execute };

    await expect(searchContext(client, "インタビュー", 5)).resolves.toEqual([{
      document_id: "business-knowledge:startup-science",
      source: "business_knowledge",
      title: "起業の科学",
      text: "## 18. エバンジェリストカスタマー\n\n親セクション全文",
      match_position: 4,
      matched_terms: ["インタビュー"],
      score: 100,
      search_stage: "phrase",
      matched_span_position: 7,
      matched_section_id: "detail-18-problem-interview",
      matched_section_title: "プロブレムインタビューの5つのポイント",
      matched_content_layer: "detail",
      delivery_section_id: "detail-18",
      delivery_section_title: "18. エバンジェリストカスタマー",
      delivery_content_layer: "detail",
      heading_path: ["起業の科学", "18. エバンジェリストカスタマー"],
      source_line_start: 1248,
      source_line_end: 1260,
      delivery_line_start: 1241,
      delivery_line_end: 1300,
      related_source_path: null,
      freshness_class: "static_framework",
      source_kind: "book_summary",
      ingest_scope: "full_summary",
      source_declared_at: null,
      detail_available: null,
      resource_uri: "mycontext://business-knowledge/startup-science/sections/detail-18"
    }]);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("delivery_match_rank = 1"), [
      "インタビュー",
      "インタビュー",
      "%インタビュー%",
      "インタビュー",
      "インタビュー",
      "%インタビュー%",
      "インタビュー",
      "%インタビュー%"
    ]);
  });

  it("reads only a section from the document's active section revision", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "marketing-wisdom",
      section_id: "section-25",
      title: "AEO",
      heading_path_json: ["Wisdom Evolution Marketing", "AEO"],
      content_layer: "index",
      section_markdown: "**§25 AEO** — answer engines",
      source_line_start: 82,
      source_line_end: 82,
      related_source_path: "sections/10-ai-agent-aeo.md",
      freshness_class: "time_sensitive",
      source_kind: "web_export_index",
      ingest_scope: "index_only",
      source_declared_at: "2026-02-20",
      detail_available: "false"
    }]);
    const client: TidbClient = { execute };

    await expect(getBusinessKnowledgeSection(client, "marketing-wisdom", "section-25"))
      .resolves.toMatchObject({
        document_id: "marketing-wisdom",
        section_id: "section-25",
        content_layer: "index",
        source_kind: "web_export_index",
        ingest_scope: "index_only",
        source_declared_at: "2026-02-20",
        detail_available: false,
        related_source_path: "sections/10-ai-agent-aeo.md",
        resource_uri: "mycontext://business-knowledge/marketing-wisdom/sections/section-25"
      });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("documents.section_revision_sha256 = sections.section_revision_sha256"),
      ["marketing-wisdom", "section-25"]
    );
  });

  it("exposes Marketing Wisdom as a dated index-only result with no stored detail", async () => {
    const client = clientReturning([{
      document_id: "business-knowledge:marketing-wisdom",
      source: "business_knowledge",
      source_id: "marketing-wisdom",
      title: "Wisdom Evolution Marketing",
      markdown: "**§25 AEO** — answer engines",
      match_position: 5,
      matched_span_position: 12,
      matched_section_id: "section-25",
      matched_section_title: "AEO",
      matched_content_layer: "index",
      delivery_section_id: "section-25",
      delivery_section_title: "AEO",
      delivery_content_layer: "index",
      heading_path_json: ["Wisdom Evolution Marketing", "AEO"],
      source_line_start: 82,
      source_line_end: 82,
      delivery_line_start: 82,
      delivery_line_end: 82,
      related_source_path: "sections/10-ai-agent-aeo.md",
      freshness_class: "time_sensitive",
      source_kind: "web_export_index",
      ingest_scope: "index_only",
      source_declared_at: new Date("2026-02-20T00:00:00.000Z"),
      detail_available: 0
    }]);

    await expect(searchContext(client, "AEO", 5)).resolves.toEqual([expect.objectContaining({
      document_id: "business-knowledge:marketing-wisdom",
      matched_content_layer: "index",
      delivery_content_layer: "index",
      source_kind: "web_export_index",
      ingest_scope: "index_only",
      source_declared_at: "2026-02-20",
      detail_available: false,
      related_source_path: "sections/10-ai-agent-aeo.md"
    })]);
  });
});

describe("editor knowledge section retrieval", () => {
  it("enriches a sectioned kikaku hit with an editor-knowledge resource URI and no business-only fields", async () => {
    const client = clientReturning([{
      document_id: "editor-knowledge:kikaku-db-catalog",
      source: "editor_knowledge",
      source_id: "kikaku-db-catalog",
      title: "企画カタログ427",
      markdown: "### No.1 ｜ 最初の企画\n\n企画1の本文。",
      match_position: 1,
      matched_span_position: 1,
      matched_section_id: "no-001",
      matched_section_title: "### No.1 ｜ 最初の企画",
      matched_content_layer: "detail",
      delivery_section_id: "no-001",
      delivery_section_title: "### No.1 ｜ 最初の企画",
      delivery_content_layer: "detail",
      heading_path_json: ["企画カタログ427", "テーマ群A", "### No.1 ｜ 最初の企画"],
      source_line_start: 6,
      source_line_end: 8,
      delivery_line_start: 6,
      delivery_line_end: 8,
      related_source_path: null,
      freshness_class: "dated_example",
      source_kind: null,
      ingest_scope: null,
      source_declared_at: null,
      detail_available: null
    }]);

    await expect(searchContext(client, "企画1", 5)).resolves.toEqual([expect.objectContaining({
      document_id: "editor-knowledge:kikaku-db-catalog",
      source: "editor_knowledge",
      delivery_section_id: "no-001",
      matched_content_layer: "detail",
      freshness_class: "dated_example",
      resource_uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001"
    })]);
    const hit = (await searchContext(client, "企画1", 5))[0];
    expect(hit).not.toHaveProperty("source_kind");
    expect(hit).not.toHaveProperty("ingest_scope");
    expect(hit).not.toHaveProperty("source_declared_at");
    expect(hit).not.toHaveProperty("detail_available");
  });

  it("reads only a section from the document's active section revision via getEditorKnowledgeSection", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "kikaku-db-catalog",
      section_id: "no-001",
      title: "### No.1 ｜ 最初の企画",
      heading_path_json: ["企画カタログ427", "テーマ群A", "### No.1 ｜ 最初の企画"],
      content_layer: "detail",
      section_markdown: "### No.1 ｜ 最初の企画\n\n企画1の本文。",
      source_line_start: 6,
      source_line_end: 8,
      related_source_path: null,
      freshness_class: "dated_example"
    }]);
    const client: TidbClient = { execute };

    await expect(getEditorKnowledgeSection(client, "kikaku-db-catalog", "no-001"))
      .resolves.toMatchObject({
        document_id: "kikaku-db-catalog",
        section_id: "no-001",
        content_layer: "detail",
        freshness_class: "dated_example",
        resource_uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001"
      });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("documents.section_revision_sha256 = sections.section_revision_sha256"),
      ["kikaku-db-catalog", "no-001"]
    );
  });
});

describe("natural-language search fallback", () => {
  // Entirely fictional stand-in for a PERSONAL_SYNONYMS secret, injected explicitly. No real
  // names or personal facts belong in this file — see searchQuery.ts for how the real map is
  // loaded from an env-provided secret at runtime.
  const FICTIONAL_SYNONYMS: PersonalSynonymConfig = {
    termAliases: {
      "たろう": { aliases: ["山田太郎"], suppressOriginalTerm: true }
    },
    synonymGroups: [
      ["たろう", "太郎", "山田太郎"],
      ["収益化", "事業化", "マネタイズ", "収益"]
    ]
  };

  it("routes the exact ChatGPT media-playbook prompt to one canonical document", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{
      document_id: "editor-knowledge:knowhow-media-design",
      source: "editor_knowledge",
      source_id: "knowhow-media-design",
      title: "メディア運営プレイブック",
      markdown: "# メディア運営プレイブック\n\n全文",
      markdown_sha256: "f".repeat(64),
      source_truncated: 0,
      unknown_block_ids: "[]",
      last_synced_at: null
    }]);
    const client: TidbClient = { execute };

    await expect(searchContext(
      client,
      "MCPこれのmedia playbook 読み込んでみて",
      5
    )).resolves.toEqual([expect.objectContaining({
      document_id: "editor-knowledge:knowhow-media-design",
      title: "メディア運営プレイブック",
      text: "# メディア運営プレイブック\n\n全文",
      matched_terms: ["メディア運営プレイブック"],
      score: 1000,
      search_stage: "intent",
      resource_uri: "mycontext://editor-knowledge/knowhow-media-design"
    })]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("WHERE document_id = ?"), [
      "editor-knowledge:knowhow-media-design"
    ]);
  });

  it("routes distinctive editor-training queries before generic ranking", async () => {
    const execute = vi.fn().mockResolvedValueOnce([{
      document_id: "editor-knowledge:lesson-06",
      source: "editor_knowledge",
      source_id: "lesson-06",
      title: "第6回: 編集会議",
      markdown: "# 第6回: 編集会議\n\n全文",
      markdown_sha256: "lesson-06-sha",
      source_truncated: false,
      last_synced_at: "2026-07-09T22:54:48.786Z"
    }]);
    const client: TidbClient = { execute };

    await expect(searchContext(
      client,
      "企画を検討する編集会議の進行方法を知りたい",
      5
    )).resolves.toEqual([expect.objectContaining({
      document_id: "editor-knowledge:lesson-06",
      matched_terms: ["第6回: 編集会議"],
      score: 1000,
      search_stage: "intent",
      resource_uri: "mycontext://editor-knowledge/lesson-06"
    })]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("falls back from an absent full phrase to ranked keyword search", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        document_id: "notion:profile",
        source: "notion",
        source_id: "profile",
        title: "山田太郎キャリア・編集スキル",
        markdown: "現在はAIエージェント構築と個人開発に取り組み、事業化を目指している。",
        match_position: 1,
        search_score: "6"
      }]);
    const client: TidbClient = { execute };

    const hits = await searchContext(
      client,
      "たろうの個人開発・AIエージェント活用・月20万円の収益化目標に関する背景と強み",
      3,
      FICTIONAL_SYNONYMS
    );

    expect(hits).toEqual([expect.objectContaining({
      document_id: "notion:profile",
      matched_terms: expect.arrayContaining([
        "個人開発",
        "AIエージェント",
        "山田太郎"
      ]),
      score: 6,
      search_stage: "keywords"
    })]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toContain("ORDER BY search_score DESC");
  });

  it("uses synonyms only after phrase and keyword searches both miss", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        document_id: "notion:business",
        source: "notion",
        source_id: "business",
        title: "事業計画",
        markdown: "プロダクトの事業化を進める。",
        match_position: 1,
        search_score: 1
      }]);
    const client: TidbClient = { execute };

    const hits = await searchContext(client, "収益化について教えて", 3, FICTIONAL_SYNONYMS);
    expect(hits[0]).toMatchObject({
      matched_terms: ["事業化"],
      search_stage: "synonyms"
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("performs no synonym fallback when no config is injected (the safe default)", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const client: TidbClient = { execute };

    const hits = await searchContext(client, "収益化について教えて", 3);
    expect(hits).toEqual([]);
    // no third (synonym-fallback) query is issued, since expandSynonyms has nothing to expand
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function clientReturning(rows: Record<string, unknown>[]): TidbClient {
  return { execute: vi.fn().mockResolvedValue(rows) };
}
