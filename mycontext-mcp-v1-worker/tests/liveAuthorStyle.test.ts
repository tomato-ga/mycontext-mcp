import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { createTidbClient } from "../src/tidb.js";
import { registerGetAuthorStyleContextTool } from "../src/tools/getAuthorStyleContext.js";
import { registerSearchAuthorStyleEvidenceTool } from "../src/tools/searchAuthorStyleEvidence.js";

const liveIt = process.env.LIVE_AUTHOR_STYLE_SMOKE === "1" ? it : it.skip;

describe("live author style MCP smoke", () => {
  liveIt("lists and calls both tools against the read-only TiDB connection", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "live-smoke", version: "1.0.0" });
    const tidb = createTidbClient(databaseUrl);
    registerGetAuthorStyleContextTool(server, tidb);
    registerSearchAuthorStyleEvidenceTool(server, tidb);
    const client = new Client({ name: "live-smoke-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_author_style_context",
        "search_author_style_evidence"
      ]);

      const title = await client.callTool({
        name: "get_author_style_context",
        arguments: {
          documentId: "ore-title-style",
          operation: "generate",
          mode: "news",
          profile: "neutral"
        }
      });
      expect(title.isError).not.toBe(true);
      expect(title.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("AI context pack") })
      ]));
      expect(title.structuredContent).toMatchObject({
        document_id: "ore-title-style",
        selectors: { operation: "generate", mode: "news", profile: "neutral" }
      });
      expect((title.structuredContent as Record<string, unknown>).markdown).toBeUndefined();

      const body = await client.callTool({
        name: "get_author_style_context",
        arguments: {
          documentId: "ore-body-style",
          operation: "generate",
          mode: "explanatory",
          lengthBand: "le600",
          profile: "neutral"
        }
      });
      expect(body.isError).not.toBe(true);
      expect(body.structuredContent).toMatchObject({ document_id: "ore-body-style" });

      const evidence = await client.callTool({
        name: "search_author_style_evidence",
        arguments: { documentId: "ore-title-style", query: "482本", topK: 2 }
      });
      expect(evidence.isError).not.toBe(true);
      expect(evidence.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("主要統計") })
      ]));
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
