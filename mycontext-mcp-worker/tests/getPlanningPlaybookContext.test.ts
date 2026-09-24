import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS } from "../src/planningPlaybook.js";
import { registerGetPlanningPlaybookContextTool } from "../src/tools/getPlanningPlaybookContext.js";
import type { TidbClient } from "../src/tidb.js";

const PLAYBOOK = [
  "# 企画構成プレイブック",
  "",
  "## 1. 企画の立て方",
  "企画の本文。",
  "",
  "## 8. コンテンツ本文の構成の作り方（最重要）",
  "本文構成の本文。"
].join("\n");

describe("get_planning_playbook_context", () => {
  it("returns the complete playbook through both delivery channels without truncation", async () => {
    const execute = vi.fn().mockResolvedValue([playbookRow()]);
    const result = await callTool({ execute });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: PLAYBOOK }]);
    expect(result.structuredContent).toMatchObject({
      document_id: "editor-knowledge:kikaku-composition-playbook",
      title: "企画構成プレイブック",
      revision_sha256: "section-revision",
      section_count: 8,
      search_span_count: 8,
      context_chars: PLAYBOOK.length,
      markdown: PLAYBOOK,
      returned_chars: PLAYBOOK.length,
      retrieval_mode: "full_playbook",
      truncated: false,
      source_resource_uri:
        "mycontext://editor-knowledge/kikaku-composition-playbook"
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM editor_knowledge_documents"),
      ["kikaku-composition-playbook"]
    );
  });

  it("returns an explicit not-found error instead of falling back", async () => {
    const result = await callTool({ execute: vi.fn().mockResolvedValue([]) });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "Planning playbook not found: kikaku-composition-playbook"
    }]);
  });

  it("rejects an oversized playbook without returning a truncated prefix", async () => {
    const markdown = "あ".repeat(MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS + 1);
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ markdown })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: `planning playbook is ${markdown.length} chars; maximum is ${MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS}; no truncation was applied`
    }]);
  });

  it("rejects a revision whose chapters are not all searchable", async () => {
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ search_span_count: 7 })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "planning playbook must make every chapter searchable: section_count=8, search_span_count=7"
    }]);
  });

  it("returns an explicit invalid-state error for an inactive revision", async () => {
    const result = await callTool({
      execute: vi.fn().mockResolvedValue([playbookRow({ section_revision_sha256: null })])
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "planning playbook state is invalid: section_revision_sha256 must be a non-empty string"
    }]);
  });
});

function playbookRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document_id: "kikaku-composition-playbook",
    title: "企画構成プレイブック",
    markdown: PLAYBOOK,
    markdown_sha256: "markdown-hash",
    section_revision_sha256: "section-revision",
    section_count: 8,
    search_span_count: 8,
    last_synced_at: "2026-07-25T01:13:11.626+09:00",
    ...overrides
  };
}

async function callTool(tidbClient: TidbClient) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerGetPlanningPlaybookContextTool(server, tidbClient);
  const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdkClient.connect(clientTransport);
  try {
    return await sdkClient.callTool({
      name: "get_planning_playbook_context",
      arguments: {}
    });
  } finally {
    await sdkClient.close();
    await server.close();
  }
}
