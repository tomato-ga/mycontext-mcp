import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS } from "../src/mediaPlaybook.js";
import { registerGetMediaPlaybookContextTool } from "../src/tools/getMediaPlaybookContext.js";
import type { TidbClient } from "../src/tidb.js";

const PLAYBOOK = [
  "# メディア運営プレイブック",
  "",
  "## 1. メディアを持つ前に決めること",
  "方針の本文。",
  "",
  "## 7. KPIを設計する",
  "KPIの本文。"
].join("\n");

describe("get_media_playbook_context", () => {
  it("returns the single-record playbook once without truncation", async () => {
    const execute = vi.fn().mockResolvedValue([playbookRow()]);
    const result = await callTool({ execute });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: PLAYBOOK }]);
    expect(result.structuredContent).toMatchObject({
      document_id: "editor-knowledge:knowhow-media-design",
      title: "メディア運営プレイブック",
      revision_sha256: "markdown-hash",
      storage_mode: "whole_document",
      record_count: 1,
      section_count: 0,
      search_span_count: 1,
      context_chars: PLAYBOOK.length,
      retrieval_mode: "full_playbook",
      truncated: false,
      source_resource_uri: "mycontext://editor-knowledge/knowhow-media-design"
    });
    expect((result.structuredContent as Record<string, unknown>).markdown).toBeUndefined();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM editor_knowledge_documents"),
      ["knowhow-media-design"]
    );
  });

  it("returns an explicit not-found error", async () => {
    const result = await callTool({ execute: vi.fn().mockResolvedValue([]) });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "Media playbook not found: knowhow-media-design"
    }]);
  });

  it("rejects an oversized playbook instead of truncating it", async () => {
    const markdown = "あ".repeat(MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS + 1);
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ markdown })])
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: `media playbook is ${markdown.length} chars; maximum is ${MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS}; no truncation was applied`
    }]);
  });
});

function playbookRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: "knowhow-media-design",
    title: "メディア運営プレイブック",
    markdown: PLAYBOOK,
    markdown_sha256: "markdown-hash",
    section_revision_sha256: null,
    section_count: null,
    search_span_count: null,
    last_synced_at: "2026-07-26T09:00:00.000+09:00",
    ...overrides
  };
}

async function callTool(tidbClient: TidbClient) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerGetMediaPlaybookContextTool(server, tidbClient);
  const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdkClient.connect(clientTransport);
  try {
    return await sdkClient.callTool({
      name: "get_media_playbook_context",
      arguments: {}
    });
  } finally {
    await sdkClient.close();
    await server.close();
  }
}
