import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { MAX_SKILL_CONTEXT_CHARS } from "../src/skillContext.js";
import { registerGetAnalysisSkillContextTool } from "../src/tools/getAnalysisSkillContext.js";
import type { TidbClient } from "../src/tidb.js";

const MARKDOWN = [
  "---",
  "name: marketing-lean-canvas",
  "description: リーンキャンバス",
  "---",
  "",
  "# marketing-lean-canvas",
  "skill body",
  "",
  "<!-- mycontext:source-boundary reference.md -->",
  "",
  "# marketing-lean-canvas reference",
  "reference body"
].join("\n");

describe("get_analysis_skill_context", () => {
  it("returns the complete merged Lean Canvas context without truncation", async () => {
    const execute = vi.fn().mockResolvedValue([skillRow()]);
    const result = await callTool({ execute }, "marketing-lean-canvas");

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: MARKDOWN }]);
    expect(result.structuredContent).toMatchObject({
      skill_id: "marketing-lean-canvas",
      family: "marketing",
      context_chars: MARKDOWN.length,
      markdown: MARKDOWN,
      returned_chars: MARKDOWN.length,
      retrieval_mode: "full_skill_and_reference",
      truncated: false
    });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("FROM skill_context_documents"),
      ["marketing-lean-canvas"]
    );
  });

  it("returns an explicit not-found error", async () => {
    const result = await callTool(
      { execute: vi.fn().mockResolvedValue([]) },
      "resolution-diagnose"
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "Analysis skill context not found: resolution-diagnose"
    }]);
  });

  it("rejects an oversized context instead of returning a truncated prefix", async () => {
    const markdown =
      `${"あ".repeat(MAX_SKILL_CONTEXT_CHARS + 1)}\n` +
      "<!-- mycontext:source-boundary reference.md -->";
    const result = await callTool(
      {
        execute: vi.fn().mockResolvedValue([
          skillRow({ skill_id: "resolution-diagnose", family: "resolution", markdown })
        ])
      },
      "resolution-diagnose"
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: expect.stringContaining("no truncation was applied")
    }]);
  });

  it("rejects a row with a missing source boundary", async () => {
    const result = await callTool(
      {
        execute: vi.fn().mockResolvedValue([
          skillRow({
            skill_id: "issue-driven-identify",
            family: "issue-driven",
            markdown: "# issue-driven-identify"
          })
        ])
      },
      "issue-driven-identify"
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{
      type: "text",
      text: "skill context issue-driven-identify must contain exactly one source boundary"
    }]);
  });
});

function skillRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill_id: "marketing-lean-canvas",
    family: "marketing",
    title: "marketing-lean-canvas",
    description: "リーンキャンバス",
    source_manifest_json: JSON.stringify({ files: [] }),
    relationships_json: JSON.stringify({ shared_context_skill_ids: [] }),
    markdown: MARKDOWN,
    markdown_sha256: "markdown-hash",
    merge_version: "skill-reference-v1",
    last_synced_at: "2026-07-26T01:00:00.000Z",
    ...overrides
  };
}

async function callTool(
  tidbClient: TidbClient,
  skillId:
    | "marketing-lean-canvas"
    | "resolution-diagnose"
    | "issue-driven-identify"
) {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerGetAnalysisSkillContextTool(server, tidbClient);
  const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdkClient.connect(clientTransport);
  try {
    return await sdkClient.callTool({
      name: "get_analysis_skill_context",
      arguments: { skillId }
    });
  } finally {
    await sdkClient.close();
    await server.close();
  }
}
