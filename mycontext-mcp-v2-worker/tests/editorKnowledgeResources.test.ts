import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_KNOWLEDGE_DOCUMENT_URI_TEMPLATE,
  EDITOR_KNOWLEDGE_SECTION_URI_TEMPLATE,
  registerEditorKnowledgeResources
} from "../src/resources/editorKnowledge.js";
import type { TidbClient } from "../src/tidb.js";

describe("editor knowledge MCP resources", () => {
  it("lists every editor knowledge document (including an open-ended kikaku-fulltext-* one) and active delivery sections, then reads a section", async () => {
    const execute = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("SELECT document_id, title FROM editor_knowledge_documents")) {
        return [
          { document_id: "kikaku-composition-playbook", title: "企画構成プレイブック" },
          { document_id: "kikaku-db-catalog", title: "企画カタログ427" },
          { document_id: "kikaku-fulltext-3", title: "企画ノウハウ全文集 3（No.97〜No.144）" }
        ];
      }
      if (sql.includes("sections.section_id = sections.delivery_section_id")) {
        return [groupRow(), entryRow()];
      }
      if (sql.includes("WHERE sections.document_id = ?")) {
        return [entryRow()];
      }
      if (sql.includes("WHERE document_id = ?")) {
        if (params?.[0] === "editor-knowledge:kikaku-composition-playbook") return [playbookDocumentRow()];
        if (params?.[0] === "editor-knowledge:kikaku-fulltext-3") return [fulltextDocumentRow()];
        return [catalogDocumentRow()];
      }
      return [];
    });
    const tidbClient: TidbClient = { execute };
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerEditorKnowledgeResources(server, tidbClient);

    const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdkClient.connect(clientTransport);
    try {
      const listed = await sdkClient.listResources();
      expect(listed.resources.map((resource) => resource.uri)).toEqual(expect.arrayContaining([
        "mycontext://editor-knowledge/kikaku-composition-playbook",
        "mycontext://editor-knowledge/kikaku-db-catalog",
        "mycontext://editor-knowledge/kikaku-fulltext-3",
        "mycontext://editor-knowledge/kikaku-db-catalog/sections/group-a",
        "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001"
      ]));
      expect(listed.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({
          uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001",
          _meta: expect.objectContaining({
            contentLayer: "detail",
            freshnessClass: "dated_example"
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
        expect.objectContaining({ uriTemplate: EDITOR_KNOWLEDGE_DOCUMENT_URI_TEMPLATE }),
        expect.objectContaining({ uriTemplate: EDITOR_KNOWLEDGE_SECTION_URI_TEMPLATE })
      ]));

      const read = await sdkClient.readResource({
        uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001"
      });
      expect(read.contents).toEqual([
        expect.objectContaining({
          uri: "mycontext://editor-knowledge/kikaku-db-catalog/sections/no-001",
          mimeType: "text/markdown",
          text: "### No.1 ｜ 最初の企画\n\n企画1の本文。"
        })
      ]);
      expect(execute).toHaveBeenCalledWith(
        expect.stringContaining("documents.section_revision_sha256 = sections.section_revision_sha256"),
        ["kikaku-db-catalog", "no-001"]
      );

      const playbookDocument = await sdkClient.readResource({
        uri: "mycontext://editor-knowledge/kikaku-composition-playbook"
      });
      expect(playbookDocument.contents).toEqual([
        expect.objectContaining({
          _meta: expect.objectContaining({
            documentId: "kikaku-composition-playbook",
            sectionRevisionSha256: "e".repeat(64)
          })
        })
      ]);

      // kikaku-fulltext-3 has no dedicated code-level registration anywhere in this module — it
      // is readable purely because a matching row exists in editor_knowledge_documents.
      const fulltextDocument = await sdkClient.readResource({
        uri: "mycontext://editor-knowledge/kikaku-fulltext-3"
      });
      expect(fulltextDocument.contents).toEqual([
        expect.objectContaining({
          _meta: expect.objectContaining({
            documentId: "kikaku-fulltext-3",
            sectionRevisionSha256: "b".repeat(64)
          })
        })
      ]);
    } finally {
      await sdkClient.close();
      await server.close();
    }
  });
});

function groupRow(): Record<string, unknown> {
  return {
    document_id: "kikaku-db-catalog",
    section_id: "group-a",
    title: "テーマ群A｜EC×D2C戦略",
    heading_path_json: ["企画カタログ427", "テーマ群A｜EC×D2C戦略"],
    content_layer: "index",
    size_bytes: 20,
    section_markdown: "## テーマ群A｜EC×D2C戦略\n\nグループAの概要文。",
    source_line_start: 3,
    source_line_end: 4,
    related_source_path: null,
    freshness_class: "static_framework"
  };
}

function entryRow(): Record<string, unknown> {
  return {
    document_id: "kikaku-db-catalog",
    section_id: "no-001",
    title: "### No.1 ｜ 最初の企画",
    heading_path_json: ["企画カタログ427", "テーマ群A｜EC×D2C戦略", "### No.1 ｜ 最初の企画"],
    content_layer: "detail",
    size_bytes: 36,
    section_markdown: "### No.1 ｜ 最初の企画\n\n企画1の本文。",
    source_line_start: 6,
    source_line_end: 8,
    related_source_path: null,
    freshness_class: "dated_example"
  };
}

function playbookDocumentRow(): Record<string, unknown> {
  return {
    document_id: "editor-knowledge:kikaku-composition-playbook",
    source: "editor_knowledge",
    source_id: "kikaku-composition-playbook",
    title: "企画構成プレイブック",
    markdown: "# 企画構成プレイブック",
    markdown_sha256: "d".repeat(64),
    section_revision_sha256: "e".repeat(64),
    section_count: 3,
    search_span_count: 3,
    source_truncated: false,
    unknown_block_ids: [],
    last_synced_at: null
  };
}

function catalogDocumentRow(): Record<string, unknown> {
  return {
    document_id: "editor-knowledge:kikaku-db-catalog",
    source: "editor_knowledge",
    source_id: "kikaku-db-catalog",
    title: "企画カタログ427",
    markdown: "# 企画カタログ427",
    markdown_sha256: "f".repeat(64),
    section_revision_sha256: "a".repeat(64),
    section_count: 6,
    search_span_count: 4,
    source_truncated: false,
    unknown_block_ids: [],
    last_synced_at: null
  };
}

function fulltextDocumentRow(): Record<string, unknown> {
  return {
    document_id: "editor-knowledge:kikaku-fulltext-3",
    source: "editor_knowledge",
    source_id: "kikaku-fulltext-3",
    title: "企画ノウハウ全文集 3（No.97〜No.144）",
    markdown: "# 企画ノウハウ全文集 3（No.97〜No.144）",
    markdown_sha256: "c".repeat(64),
    section_revision_sha256: "b".repeat(64),
    section_count: 4,
    search_span_count: 3,
    source_truncated: false,
    unknown_block_ids: [],
    last_synced_at: null
  };
}
