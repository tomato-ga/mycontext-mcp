import { describe, expect, it } from "vitest";
import type {
  AuthorStyleSection,
  LoadedAuthorStyleDocument
} from "../src/authorStyle.js";
import { compareAuthorStyleNotionMigration } from "../src/authorStyleNotionPreflight.js";
import type {
  AuthorStyleDocumentRow,
  AuthorStyleSectionRow
} from "../src/tidb.js";

describe("author-style Notion migration preflight", () => {
  it("allows an ownership-only migration when source and AI read model are exact", () => {
    const notion = document();
    const result = compareAuthorStyleNotionMigration({
      notion,
      tidbDocument: documentRow(notion),
      tidbSections: notion.sections.map(sectionRow)
    });

    expect(result).toMatchObject({
      status: "exact_match",
      ownership_change_only: true,
      source_markdown_matches: true,
      context_matches: true,
      ai_read_model_matches: true
    });
  });

  it("reports changed sections without exposing their content", () => {
    const notion = document();
    const rows = notion.sections.map(sectionRow);
    rows[0] = { ...rows[0]!, delivery_markdown: "changed" };
    const result = compareAuthorStyleNotionMigration({
      notion,
      tidbDocument: { ...documentRow(notion), source_markdown_sha256: "different" },
      tidbSections: rows
    });

    expect(result).toMatchObject({
      status: "content_change_required",
      ownership_change_only: false,
      source_markdown_matches: false,
      ai_read_model_matches: false,
      changed_section_ids: ["section"]
    });
    expect(JSON.stringify(result)).not.toContain("Direct Markdown");
  });
});

function document(): LoadedAuthorStyleDocument {
  const section = baseSection();
  return {
    documentId: "ore-body-style",
    authorKey: "ore",
    styleScope: "body",
    displayName: "Body style",
    sourcePathKey: "notion:page",
    sourceMarkdown: "# Body style",
    sourceMarkdownSha256: "source-hash",
    sourceBytes: 12,
    sourceLineCount: 1,
    sourceMtimeMs: 0,
    revisionSha256: "revision-hash",
    parserVersion: "parser",
    sectioningVersion: "sectioning",
    routingVersion: "routing",
    routingManifest: {},
    outline: {},
    sectionCount: 1,
    deliverySectionCount: 1,
    searchSpanCount: 0,
    sections: [section]
  };
}

function baseSection(): AuthorStyleSection {
  return {
    documentId: "ore-body-style",
    revisionSha256: "revision-hash",
    sectionId: "section",
    contextKey: "ore-body/section",
    parentSectionId: null,
    deliverySectionId: "section",
    sectionType: "delivery",
    contentLayer: "runtime",
    contextPriority: 10,
    headingLevel: 2,
    title: "Section",
    headingPath: ["Body style", "Section"],
    aliases: ["Section"],
    ordinal: 1,
    sourceLineStart: 1,
    sourceLineEnd: 2,
    contentChars: 15,
    estimatedTokens: null,
    directMarkdown: "## Direct Markdown",
    deliveryMarkdown: "## Direct Markdown",
    retrievalText: "Section Direct Markdown",
    contentSha256: "content-hash",
    isSearchable: true
  };
}

function documentRow(document: LoadedAuthorStyleDocument): AuthorStyleDocumentRow {
  return {
    document_id: document.documentId,
    author_key: document.authorKey,
    style_scope: document.styleScope,
    display_name: document.displayName,
    source_path_key: document.sourcePathKey,
    context_sha256: document.revisionSha256,
    source_markdown: document.sourceMarkdown,
    source_markdown_sha256: document.sourceMarkdownSha256,
    source_bytes: document.sourceBytes,
    source_line_count: document.sourceLineCount,
    source_mtime_ms: document.sourceMtimeMs,
    parser_version: document.parserVersion,
    sectioning_version: document.sectioningVersion,
    routing_version: document.routingVersion,
    routing_manifest_json: document.routingManifest,
    outline_json: document.outline,
    section_count: document.sectionCount,
    delivery_section_count: document.deliverySectionCount,
    search_span_count: document.searchSpanCount,
    status: "active",
    last_synced_at: "2026-07-22T00:00:00.000Z"
  } as AuthorStyleDocumentRow;
}

function sectionRow(section: AuthorStyleSection): AuthorStyleSectionRow {
  return {
    document_id: section.documentId,
    section_id: section.sectionId,
    context_key: section.contextKey,
    parent_section_id: section.parentSectionId,
    delivery_section_id: section.deliverySectionId,
    section_type: section.sectionType,
    content_layer: section.contentLayer,
    context_priority: section.contextPriority,
    heading_level: section.headingLevel,
    title: section.title,
    heading_path_json: section.headingPath,
    aliases_json: section.aliases,
    ordinal: section.ordinal,
    source_line_start: section.sourceLineStart,
    source_line_end: section.sourceLineEnd,
    content_chars: section.contentChars,
    estimated_tokens: section.estimatedTokens,
    direct_markdown: section.directMarkdown,
    delivery_markdown: section.deliveryMarkdown,
    retrieval_text: section.retrievalText,
    content_sha256: section.contentSha256,
    is_searchable: section.isSearchable
  } as AuthorStyleSectionRow;
}
