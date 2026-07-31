import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createTidbClient } from "../src/tidb.js";
import { registerPublicTools } from "../src/tools/register.js";

const liveIt = process.env.LIVE_PLANNING_PLAYBOOK_SMOKE === "1" ? it : it.skip;

describe("live planning playbook MCP smoke", () => {
  liveIt("returns the active full playbook through the MCP tool", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "live-planning-smoke", version: "1.0.0" });
    const tidb = createTidbClient(databaseUrl);
    registerPublicTools(server, tidb);
    const client = new Client({ name: "live-smoke-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name))
        .toContain("get_planning_playbook_context");

      const result = await client.callTool({
        name: "get_planning_playbook_context",
        arguments: {}
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{
        type: "text",
        text: expect.stringMatching(
          /^# 企画構成プレイブック[\s\S]*## 1\. 企画の立て方[\s\S]*## 8\. コンテンツ本文の構成の作り方（最重要）/
        )
      }]);
      expect(result.structuredContent).toMatchObject({
        document_id: "editor-knowledge:kikaku-composition-playbook",
        section_count: 8,
        search_span_count: 8,
        retrieval_mode: "full_playbook",
        truncated: false
      });
      expect((result.structuredContent as Record<string, unknown>).context_chars)
        .toBeGreaterThan(7_000);
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
