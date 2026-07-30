import { describe, expect, it } from "vitest";
import { buildSearchToolResult } from "../src/tools/searchResult.js";

describe("buildSearchToolResult", () => {
  it("returns compact results with stable IDs and no duplicated resources", () => {
    const longNotionText = `before-${"x".repeat(2_000)}-needle-after`;
    const deliveryMarkdown = "## Parent section\n\nThe complete semantic section.";
    const result = buildSearchToolResult([
      {
        document_id: "notion:page-1",
        source: "notion",
        title: "Profile",
        text: longNotionText,
        match_position: longNotionText.indexOf("needle") + 1,
        matched_terms: ["needle"],
        score: 100,
        search_stage: "phrase"
      },
      {
        document_id: "business-knowledge:startup-science",
        source: "business_knowledge",
        title: "起業の科学",
        text: deliveryMarkdown,
        match_position: 1,
        matched_terms: ["semantic"],
        score: 7,
        search_stage: "keywords",
        matched_span_position: 4,
        matched_section_id: "detail-18-interview",
        matched_section_title: "Interview",
        matched_content_layer: "detail",
        delivery_section_id: "detail-18",
        delivery_section_title: "Parent section",
        delivery_content_layer: "detail",
        heading_path: ["起業の科学", "Parent section", "Interview"],
        source_line_start: 10,
        source_line_end: 12,
        delivery_line_start: 8,
        delivery_line_end: 20,
        related_source_path: null,
        freshness_class: "static_framework",
        source_kind: "book_summary",
        ingest_scope: "full_summary",
        source_declared_at: null,
        detail_available: null,
        resource_uri: "mycontext://business-knowledge/startup-science/sections/detail-18"
      },
      {
        document_id: "editor-knowledge:kikaku-db-catalog",
        source: "editor_knowledge",
        title: "企画カタログ427",
        text: "### No.1 ｜ 最初の企画\n\n企画1の本文。",
        match_position: 1,
        matched_terms: ["企画1"],
        score: 5,
        search_stage: "keywords",
        matched_span_position: 1,
        matched_section_id: "no-001",
        matched_section_title: "### No.1 ｜ 最初の企画",
        matched_content_layer: "detail",
        delivery_section_id: "no-001",
        delivery_section_title: "### No.1 ｜ 最初の企画",
        delivery_content_layer: "detail",
        heading_path: ["企画カタログ427", "テーマ群A", "### No.1 ｜ 最初の企画"],
        source_line_start: 6,
        source_line_end: 8,
        delivery_line_start: 6,
        delivery_line_end: 8,
        related_source_path: null,
        freshness_class: "dated_example",
        resource_uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001"
      }
    ]);

    const structured = result.structuredContent as {
      results: Array<{ id: string; snippet: string; matchedTerms: string[] }>
    };
    expect(structured.results[0].snippet.length).toBeLessThan(longNotionText.length);
    expect(structured.results[0].snippet).toContain("needle");
    expect(structured.results[0].id).toBe("notion:page-1");
    expect(structured.results[1]).toMatchObject({
      id: "business-knowledge:startup-science#detail-18",
      matchedTerms: ["semantic"]
    });
    // editor knowledge sectioned hits get the same "#deliverySectionId" stable ID treatment
    // as business knowledge ones, since stableResultId no longer special-cases the source
    expect(structured.results[2]).toMatchObject({
      id: "editor-knowledge:kikaku-db-catalog#no-001",
      matchedTerms: ["企画1"]
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(result)).not.toContain("\"type\":\"resource\"");
  });

  it("returns a complete exact-ID analysis skill record through the legacy search tool", () => {
    const markdown = `# Resolution Diagnose\n\n${"framework ".repeat(1_000)}`;
    const result = buildSearchToolResult([{
      document_id: "skill-context:resolution-diagnose",
      source: "skill_context",
      title: "resolution-diagnose",
      text: markdown,
      match_position: 1,
      matched_terms: ["resolution-diagnose"],
      score: 1000,
      search_stage: "intent"
    }]);
    expect(result.structuredContent).toMatchObject({
      results: [{
        id: "skill-context:resolution-diagnose",
        source: "skill_context",
        contextChars: markdown.length,
        retrievalMode: "full_skill_and_reference",
        truncated: false
      }]
    });
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining(markdown)
    }]);
  });

  it("returns a complete bounded document for an explicit intent or exact phrase", () => {
    const playbook = "# メディア運営プレイブック\n\n全文";
    const exactNotion = "# ガジェットプロフィール\n\n全文";
    const result = buildSearchToolResult([
      {
        document_id: "editor-knowledge:knowhow-media-design",
        source: "editor_knowledge",
        title: "メディア運営プレイブック",
        text: playbook,
        match_position: 1,
        matched_terms: ["メディア運営プレイブック"],
        score: 1000,
        search_stage: "intent"
      },
      {
        document_id: "notion:gadget-profile",
        source: "notion",
        title: "ガジェットプロフィール",
        text: exactNotion,
        match_position: 1,
        matched_terms: ["ガジェットプロフィール"],
        score: 100,
        search_stage: "phrase"
      }
    ]);
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          contextChars: playbook.length,
          retrievalMode: "full_exact_document",
          truncated: false
        },
        {
          contextChars: exactNotion.length,
          retrievalMode: "full_exact_document",
          truncated: false
        }
      ]
    });
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringMatching(/メディア運営プレイブック[\s\S]*ガジェットプロフィール/u)
    }]);
  });
});
