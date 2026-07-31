import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { MAX_EDITING_PLAYBOOK_CONTEXT_CHARS } from "../src/editingPlaybook.js";
import { registerGetEditingPlaybookContextTool } from "../src/tools/getEditingPlaybookContext.js";
import type { TidbClient } from "../src/tidb.js";

const PLAYBOOK = [
  "# 編集プレイブック",
  "",
  "## 1. このプレイブックの使い方",
  "使い方の本文。",
  "",
  "## 11. 公開判断と公開後の編集",
  "公開判断の本文。"
].join("\n");

describe("get_editing_playbook_context", () => {
  it("returns the complete playbook once without truncation", async () => {
    const execute = vi.fn().mockResolvedValue([playbookRow()]);
    const result = await callTool({ execute });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: PLAYBOOK }]);
    expect(result.structuredContent).toMatchObject({
      document_id: "editor-knowledge:henshu-editing-playbook",
      title: "編集プレイブック",
      revision_sha256: "markdown-hash",
      storage_mode: "whole_document",
      record_count: 1,
      section_count: 0,
      search_span_count: 1,
      context_chars: PLAYBOOK.length,
      retrieval_mode: "full_playbook",
      truncated: false,
      source_resource_uri:
        "mycontext://editor-knowledge/henshu-editing-playbook"
    });
    expect((result.structuredContent as Record<string, unknown>).markdown).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM editor_knowledge_documents"),
      ["henshu-editing-playbook"]
    );
  });

  it("returns an explicit not-found error instead of falling back", async () => {
    const result = await callTool({ execute: vi.fn().mockResolvedValue([]) });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "Editing playbook not found: henshu-editing-playbook"
    }]);
  });

  it("rejects an oversized playbook without returning a truncated prefix", async () => {
    const markdown = "あ".repeat(MAX_EDITING_PLAYBOOK_CONTEXT_CHARS + 1);
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ markdown })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: `editing playbook is ${markdown.length} chars; maximum is ${MAX_EDITING_PLAYBOOK_CONTEXT_CHARS}; no truncation was applied`
    }]);
  });

  it("rejects stale section metadata left by the former chapter design", async () => {
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ section_count: 11 })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "whole-document playbook must not have section revision/count metadata"
    }]);
  });

  it("returns an explicit invalid-state error for a missing Markdown hash", async () => {
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ markdown_sha256: null })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "editing playbook state is invalid: markdown_sha256 must be a non-empty string"
    }]);
  });
});

function playbookRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: "henshu-editing-playbook",
    title: "編集プレイブック",
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
  registerGetEditingPlaybookContextTool(server, tidbClient);
  const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdkClient.connect(clientTransport);
  try {
    return await sdkClient.callTool({
      name: "get_editing_playbook_context",
      arguments: {}
    });
  } finally {
    await sdkClient.close();
    await server.close();
  }
}
