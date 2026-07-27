import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createTidbClient } from "../src/tidb.js";
import { registerPublicTools } from "../src/tools/register.js";

const liveIt = process.env.LIVE_ANALYSIS_SKILL_SMOKE === "1" ? it : it.skip;

describe("live analysis skill context MCP smoke", () => {
  liveIt("returns the complete Lean Canvas skill and reference from TiDB", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "live-analysis-skill-smoke", version: "1.0.0" });
    const tidb = createTidbClient(databaseUrl);
    registerPublicTools(server, tidb);
    const client = new Client({ name: "live-smoke-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((item) => item.name === "get_analysis_skill_context");
      expect(tool?.description).toContain("lean canvas使って");

      const result = await client.callTool({
        name: "get_analysis_skill_context",
        arguments: { skillId: "marketing-lean-canvas" }
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([{
        type: "text",
        text: expect.stringMatching(
          /^---\nname: marketing-lean-canvas[\s\S]*<!-- mycontext:source-boundary reference\.md -->[\s\S]*# marketing-lean-canvas reference/
        )
      }]);
      expect(result.structuredContent).toMatchObject({
        skill_id: "marketing-lean-canvas",
        family: "marketing",
        retrieval_mode: "full_skill_and_reference",
        truncated: false
      });
      expect((result.structuredContent as Record<string, unknown>).context_chars)
        .toBeGreaterThan(18_000);
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
