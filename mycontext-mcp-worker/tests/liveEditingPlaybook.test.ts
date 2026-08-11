import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { createTidbClient } from "../src/tidb.js";
import { registerPublicTools } from "../src/tools/register.js";

const liveIt = process.env.LIVE_EDITING_PLAYBOOK_SMOKE === "1" ? it : it.skip;

describe("live editing playbook MCP smoke", () => {
  liveIt("returns the active full playbook through the MCP tool", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "live-editing-smoke", version: "1.0.0" });
    const tidb = createTidbClient(databaseUrl);
    registerPublicTools(server, tidb);
    const client = new Client({ name: "live-smoke-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name))
        .toContain("get_editing_playbook_context");

      const result = await client.callTool({
        name: "get_editing_playbook_context",
        arguments: {}
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{
        type: "text",
        text: expect.stringMatching(
          /^# 編集プレイブック[\s\S]*## 1\. このプレイブックの使い方[\s\S]*## 11\. 公開判断と公開後の編集/
        )
      }]);
      expect(result.structuredContent).toMatchObject({
        document_id: "editor-knowledge:henshu-editing-playbook",
        storage_mode: "whole_document",
        record_count: 1,
        section_count: 0,
        search_span_count: 1,
        retrieval_mode: "full_playbook",
        truncated: false
      });
      expect((result.structuredContent as Record<string, unknown>).context_chars)
        .toBeGreaterThan(5_000);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function readDevVar(name: string): Promise<string> {
  const contents = await fs.readFile(".dev.vars", "utf8");
  const prefix = `${name}=`;
  const line = contents.split(/\r?\n/).find((value) => value.startsWith(prefix));
  if (line === undefined) throw new Error(`${name} is missing from .dev.vars`);
  const raw = line.slice(prefix.length).trim();
  if ((raw.startsWith("\"") && raw.endsWith("\""))
    || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}
