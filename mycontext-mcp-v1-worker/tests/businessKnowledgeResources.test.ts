import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
  BUSINESS_KNOWLEDGE_SECTION_URI_TEMPLATE,
  registerBusinessKnowledgeResources
} from "../src/resources/businessKnowledge.js";
import type { TidbClient } from "../src/tidb.js";

describe("business knowledge MCP resources", () => {
  it("lists the two source documents and active delivery sections, then reads a section", async () => {
    const execute = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("sections.section_id = sections.delivery_section_id")) {
        return [sectionRow(), marketingSectionRow()];
      }
      if (sql.includes("WHERE sections.document_id = ?")) {
        return [sectionRow()];
      }
      if (sql.includes("WHERE document_id = ?")) {
        return [params?.[0] === "business-knowledge:marketing-wisdom"
          ? marketingDocumentRow()
          : documentRow()];
      }
      return [];
    });
    const tidbClient: TidbClient = { execute };
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerBusinessKnowledgeResources(server, tidbClient);

    const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdkClient.connect(clientTransport);
    try {
      const listed = await sdkClient.listResources();
      expect(listed.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
        "mycontext://business-knowledge/startup-science",
        "mycontext://business-knowledge/marketing-wisdom",
        "mycontext://business-knowledge/startup-science/sections/detail-18",
        "mycontext://business-knowledge/marketing-wisdom/sections/section-25"
      ]));
      expect(listed.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          uri: "mycontext://business-knowledge/marketing-wisdom/sections/section-25",
          _meta: expect.objectContaining({
            contentLayer: "index",
            ingestScope: "index_only",
            sourceDeclaredAt: "2026-02-20",
            detailAvailable: false,
            relatedSourcePath: "sections/10-ai-agent-aeo.md"
          })
        })
      ]));
      const listSql = execute.mock.calls
        .map(([sql]) => sql)
        .find((sql) => sql.includes("sections.section_id = sections.delivery_section_id"));
      expect(listSql).toContain("OCTET_LENGTH(sections.section_markdown) AS size_bytes");
      expect(listSql).not.toMatch(/sections\.section_markdown\s*,/);

      const templates = await sdkClient.listResourceTemplates();
      expect(templates.resourceTemplates).toEqual(expect.arrayContaining([
        expect.objectContaining({ uriTemplate: BUSINESS_KNOWLEDGE_SECTION_URI_TEMPLATE })
      ]));

      const read = await sdkClient.readResource({
        uri: "mycontext://business-knowledge/startup-science/sections/detail-18"
      });
      expect(read.contents).toEqual([
        expect.objectContaining({
          uri: "mycontext://business-knowledge/startup-science/sections/detail-18",
          mimeType: "text/markdown",
          text: "## 18. Interview\n\nFull parent section"
        })
      ]);
      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining("documents.section_revision_sha256 = sections.section_revision_sha256"),
        ["startup-science", "detail-18"]
      );

      const marketingDocument = await sdkClient.readResource({
        uri: "mycontext://business-knowledge/marketing-wisdom"
      });
      expect(marketingDocument.contents).toEqual([
        expect.objectContaining({
          _meta: expect.objectContaining({
            sourceKind: "web_export_index",
            ingestScope: "index_only",
            sourceDeclaredAt: "2026-02-20",
            detailAvailable: false
          })
        })
      ]);
    } finally {
      await sdkClient.close();
      await server.close();
    }
  });
});

function sectionRow(): Record<string, unknown> {
  return {
    document_id: "startup-science",
    section_id: "detail-18",
    title: "18. Interview",
    heading_path_json: ["起業の科学", "18. Interview"],
    content_layer: "detail",
    size_bytes: 48,
    section_markdown: "## 18. Interview\n\nFull parent section",
    source_line_start: 1241,
    source_line_end: 1300,
    related_source_path: null,
    freshness_class: "static_framework",
    source_kind: "book_summary",
    ingest_scope: "full_summary",
    source_declared_at: null,
    detail_available: null
  };
}

function marketingSectionRow(): Record<string, unknown> {
  return {
    document_id: "marketing-wisdom",
    section_id: "section-25",
    title: "AEO",
    heading_path_json: ["Wisdom Evolution Marketing", "AEO"],
    content_layer: "index",
    size_bytes: 36,
    section_markdown: "**§25 AEO** — answer engines",
    source_line_start: 82,
    source_line_end: 82,
    related_source_path: "sections/10-ai-agent-aeo.md",
    freshness_class: "time_sensitive",
    source_kind: "web_export_index",
    ingest_scope: "index_only",
    source_declared_at: "2026-02-20",
    detail_available: false
  };
}

function documentRow(): Record<string, unknown> {
  return {
    document_id: "business-knowledge:startup-science",
    source: "business_knowledge",
    source_id: "startup-science",
    title: "起業の科学",
    markdown: "# 起業の科学",
    markdown_sha256: "a".repeat(64),
    source_kind: "book_summary",
    ingest_scope: "full_summary",
    source_declared_at: null,
    detail_available: null,
    section_revision_sha256: "b".repeat(64),
    section_count: 279,
    search_span_count: 241,
    source_truncated: false,
    unknown_block_ids: [],
    last_synced_at: null
  };
}

function marketingDocumentRow(): Record<string, unknown> {
  return {
    document_id: "business-knowledge:marketing-wisdom",
    source: "business_knowledge",
    source_id: "marketing-wisdom",
    title: "Wisdom Evolution Marketing",
    markdown: "# Wisdom Evolution Marketing",
    markdown_sha256: "c".repeat(64),
    source_kind: "web_export_index",
    ingest_scope: "index_only",
    source_declared_at: "2026-02-20",
    detail_available: false,
    section_revision_sha256: "d".repeat(64),
    section_count: 46,
    search_span_count: 46,
    source_truncated: false,
    unknown_block_ids: [],
    last_synced_at: null
  };
}
