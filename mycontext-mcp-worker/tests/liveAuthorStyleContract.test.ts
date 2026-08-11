import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_STYLE_PROFILES,
  BODY_MODES,
  BODY_OPERATIONS,
  LENGTH_BANDS,
  TITLE_MODES,
  TITLE_OPERATIONS
} from "../src/authorStyle.js";
import { createTidbClient } from "../src/tidb.js";
import { registerGetAuthorStyleContextTool } from "../src/tools/getAuthorStyleContext.js";

const liveIt = process.env.LIVE_AUTHOR_STYLE_CONTRACT === "1" ? it : it.skip;

describe("live author style compatibility contract", () => {
  liveIt("hashes every supported selector response", async () => {
    const databaseUrl = await readDevVar("TIDB_DATABASE_URL");
    const server = new McpServer({ name: "contract-baseline", version: "1.0.0" });
    registerGetAuthorStyleContextTool(server, createTidbClient(databaseUrl));
    const client = new Client({ name: "contract-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === "get_author_style_context"
      );
      expect(tool).toBeDefined();

      const titleResponses = [];
      for (const operation of TITLE_OPERATIONS) {
        for (const mode of TITLE_MODES) {
          for (const profile of AUTHOR_STYLE_PROFILES.slice(0, 3)) {
            titleResponses.push(await client.callTool({
              name: "get_author_style_context",
              arguments: { documentId: "ore-title-style", operation, mode, profile }
            }));
          }
        }
      }

      const bodyResponses = [];
      for (const operation of BODY_OPERATIONS) {
        for (const mode of BODY_MODES) {
          for (const lengthBand of LENGTH_BANDS) {
            for (const profile of AUTHOR_STYLE_PROFILES) {
              bodyResponses.push(await client.callTool({
                name: "get_author_style_context",
                arguments: {
                  documentId: "ore-body-style",
                  operation,
                  mode,
                  lengthBand,
                  profile
                }
              }));
            }
          }
        }
      }

      const contract = {
        tool_schema_sha256: hash(tool),
        title_count: titleResponses.length,
        title_sha256: hash(titleResponses),
        body_count: bodyResponses.length,
        body_sha256: hash(bodyResponses),
        all_sha256: hash({ tool, titleResponses, bodyResponses })
      };
      console.log("AUTHOR_STYLE_CONTRACT", JSON.stringify(contract));
      expect(contract.title_count).toBe(48);
      expect(contract.body_count).toBe(320);
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)])
    );
  }
  return value;
}

async function readDevVar(name: string): Promise<string> {
  const contents = await readFirstExisting([".dev.vars", "../mycontext-mcp-worker/.dev.vars"]);
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

async function readFirstExisting(paths: readonly string[]): Promise<string> {
  for (const candidate of paths) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`none of the dev vars files exist: ${paths.join(", ")}`);
}
