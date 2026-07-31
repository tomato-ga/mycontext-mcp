import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerMetaskillResources } from "../src/resources/metaskill.js";
import { createTidbClient } from "../src/tidb.js";
import { registerGetMetaskillContextTool } from "../src/tools/getMetaskillContext.js";
import { registerSearchMetaskillEvidenceTool } from "../src/tools/searchMetaskillEvidence.js";

const liveIt = process.env.LIVE_METASKILL_SMOKE === "1" ? it : it.skip;

describe("live metaskill MCP smoke", () => {
  liveIt("lists and calls both tools and resources through the read-only TiDB connection", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "live-metaskill-smoke", version: "1.0.0" });
    const tidb = createTidbClient(databaseUrl);
    registerGetMetaskillContextTool(server, tidb);
    registerSearchMetaskillEvidenceTool(server, tidb);
    registerMetaskillResources(server, tidb);
    const client = new Client({ name: "live-metaskill-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_metaskill_context",
        "search_metaskill_evidence"
      ]);

      const context = await client.callTool({
        name: "get_metaskill_context",
        arguments: {
          documentId: "ai-self-strategy",
          topic: "structuring",
          intent: "apply",
          depth: "standard"
        }
      });
      expect(context.isError).not.toBe(true);
      expect(context.content).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("メタスキル1 構造化")
        })
      ]));
      expect(context.structuredContent).toMatchObject({
        document_id: "ai-self-strategy",
        selectors: { topic: "structuring", intent: "apply", depth: "standard" }
      });

      const evidence = await client.callTool({
        name: "search_metaskill_evidence",
        arguments: { documentId: "ai-self-strategy", query: "事前検死", topK: 2 }
      });
      expect(evidence.isError).not.toBe(true);
      expect(evidence.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("プレモータム") })
      ]));

      const resources = await client.listResources();
      expect(resources.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ uri: "mycontext://metaskill/ai-self-strategy" })
      ]));
      const fullSource = await client.readResource({ uri: "mycontext://metaskill/ai-self-strategy" });
      expect(fullSource.contents).toEqual(expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining("努力の価値が変わる時代") })
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
