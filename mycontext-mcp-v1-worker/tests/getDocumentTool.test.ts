import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { registerReadContextTool } from "../src/tools/readContext.js";
import type { TidbClient } from "../src/tidb.js";

describe("read_context", () => {
  it("returns semantic Markdown once for a stable section ID", async () => {
    const tidbClient: TidbClient = {
      execute: vi.fn().mockResolvedValue([{
        document_id: "startup-science",
        section_id: "detail-18",
        title: "18. Interview",
        heading_path_json: ["起業の科学", "18. Interview"],
        content_layer: "detail",
        section_markdown: "## 18. Interview\n\nFull parent section",
        source_line_start: 1241,
        source_line_end: 1300,
        related_source_path: null,
        freshness_class: "static_framework",
        source_kind: "book_summary",
        ingest_scope: "full_summary",
        source_declared_at: null,
        detail_available: null
      }])
    };
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerReadContextTool(server, tidbClient);
    const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdkClient.connect(clientTransport);
    try {
      const result = await sdkClient.callTool({
        name: "read_context",
        arguments: { id: "business-knowledge:startup-science#detail-18" }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        context: {
          id: "business-knowledge:startup-science#detail-18",
          documentId: "business-knowledge:startup-science",
          contentLayer: "detail",
          sourceKind: "book_summary",
          ingestScope: "full_summary",
          sourceDeclaredAt: null,
          detailAvailable: null,
          contextChars: "## 18. Interview\n\nFull parent section".length,
          returnedChars: "## 18. Interview\n\nFull parent section".length,
          truncatedOutput: false
        }
      });
      expect(result.content).toEqual([
        { type: "text", text: "## 18. Interview\n\nFull parent section" }
      ]);
    } finally {
      await sdkClient.close();
      await server.close();
    }
  });

  it("returns semantic Markdown once for a stable editor knowledge section ID", async () => {
    const tidbClient: TidbClient = {
      execute: vi.fn().mockResolvedValue([{
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
      }])
    };
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerReadContextTool(server, tidbClient);
    const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdkClient.connect(clientTransport);
    try {
      const result = await sdkClient.callTool({
        name: "read_context",
        arguments: { id: "editor-knowledge:kikaku-db-catalog#no-001" }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        context: {
          id: "editor-knowledge:kikaku-db-catalog#no-001",
          documentId: "editor-knowledge:kikaku-db-catalog",
          source: "editor_knowledge",
          contentLayer: "detail",
          freshnessClass: "dated_example",
          contextChars: "### No.1 ｜ 最初の企画\n\n企画1の本文。".length,
          returnedChars: "### No.1 ｜ 最初の企画\n\n企画1の本文。".length,
          truncatedOutput: false
        }
      });
      expect(result.content).toEqual([
        { type: "text", text: "### No.1 ｜ 最初の企画\n\n企画1の本文。" }
      ]);
    } finally {
      await sdkClient.close();
      await server.close();
    }
  });
});
