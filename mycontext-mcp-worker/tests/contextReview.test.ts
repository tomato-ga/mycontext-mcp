import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/config.js";
import { MCP_RESOURCE } from "../src/constants.js";
import { CONTEXT_QUERY_BUDGET_MS } from "../src/queryDeadline.js";
import { registerReadContextTool } from "../src/tools/readContext.js";
import { buildTextToolResult } from "../src/tools/textResult.js";

const database = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/tidb.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/tidb.js")>(),
  createTidbClient: () => database
}));

// Isolate authentication in this file, not the HTTP handler, MCP transport,
// query deadline, or document readers. mcpHttp.test.ts separately exercises
// the real OAuthProvider with both supported client generations.
vi.mock("@cloudflare/workers-oauth-provider", () => ({
  OAuthProvider: class {
    constructor(private readonly options: {
      apiHandler: {
        fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
      };
    }) {}
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      return this.options.apiHandler.fetch(request, env, ctx);
    }
  }
}));
import worker from "../src/index.js";

const BODY = "# Synthetic playbook 😀\n" + "本文を省略しない。\n".repeat(1_400) + "END_OF_CONTEXT";
const SOURCE_IDS = [
  "kikaku-composition-playbook", "henshu-editing-playbook", "knowhow-media-design"
] as const;

function row(id: string): Record<string, unknown> {
  const planning = id === "kikaku-composition-playbook";
  return {
    document_id: id,
    title: "Synthetic fixture",
    markdown: BODY,
    markdown_sha256: "m".repeat(64),
    section_revision_sha256: planning ? "r".repeat(64) : null,
    section_count: planning ? 8 : null,
    search_span_count: planning ? 8 : null,
    last_synced_at: "2026-01-01T00:00:00.000Z"
  };
}

beforeEach(() => {
  database.execute.mockReset().mockImplementation(async (_sql: string, params?: readonly unknown[]) => {
    const id = params?.[0];
    return typeof id === "string" ? [row(id)] : [];
  });
});
afterEach(() => vi.useRealTimers());

async function readPlaybook(sourceId: string) {
  const server = new McpServer({ name: "review-test", version: "1.0.0" });
  registerReadContextTool(server, database);
  const client = new Client({ name: "review-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await client.callTool({
      name: "read_context",
      arguments: { id: `editor-knowledge:${sourceId}` }
    });
  } finally {
    await client.close();
    await server.close();
  }
}

describe("pre-merge context delivery regressions", () => {
  it.each(SOURCE_IDS)("preserves the legacy metadata contract for %s", async (sourceId) => {
    expect(BODY.length).toBeGreaterThan(12_000);
    const result = await readPlaybook(sourceId);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      markdown: BODY,
      returned_chars: BODY.length,
      context: {
        id: `editor-knowledge:${sourceId}`,
        source: "editor_knowledge",
        sourceId,
        sourceKind: null,
        ingestScope: null,
        sourceDeclaredAt: null,
        detailAvailable: null,
        sourceTruncated: false,
        contextChars: BODY.length,
        returnedChars: BODY.length,
        truncatedOutput: false
      }
    });
    expect(database.execute).toHaveBeenCalledOnce();
  });

  it("rejects a short body falsely labelled as a complete nested context", () => {
    const result = buildTextToolResult("partial", {
      context: { contextChars: 100, returnedChars: 7, truncatedOutput: false }
    });
    expect(result.isError).toBe(true);
  });

  it("does not let a correct top-level count hide an incorrect nested count", () => {
    const result = buildTextToolResult("partial", {
      context_chars: 7,
      context: { contextChars: 7, returnedChars: 100, truncatedOutput: false }
    });
    expect(result.isError).toBe(true);
  });

  it("enables incoming request cancellation in the deployed Workers config", () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.compatibility_flags).toContain("enable_request_signal");
    expect(config.compatibility_flags).not.toContain("disable_request_signal");
  });
});

function httpCall(): Promise<Response> {
  const url = new URL(MCP_RESOURCE);
  const request = new Request(url, {
    method: "POST",
    headers: {
      host: url.hostname,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "get_editing_playbook_context"
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "get_editing_playbook_context", arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "review-http", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  });
  return worker.fetch(request, {
    TIDB_DATABASE_URL: "mysql://test.invalid/mycontext",
    GITHUB_CLIENT_ID: "test-client",
    GITHUB_CLIENT_SECRET: "test-secret",
    GITHUB_ALLOWED_USER_ID: "1"
  } as Env, {
    props: {}, waitUntil() {}, passThroughOnException() {}
  } as unknown as ExecutionContext);
}

interface RpcResponse {
  result?: {
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
  };
  error?: unknown;
}

describe("production HTTP delivery boundary (authentication isolated)", () => {
  it("preserves the complete body after the real HTTP response serialization", async () => {
    const response = await httpCall();
    expect(response.status).toBe(200);
    const payload = await response.json() as RpcResponse;
    expect(payload.error).toBeUndefined();
    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.structuredContent).toMatchObject({
      markdown: BODY, returned_chars: BODY.length, truncated: false
    });
    expect(payload.result?.content).toEqual([{ type: "text", text: BODY }]);
  });

  it("returns a tool error for a stalled DB query and gives the next HTTP request a fresh budget", async () => {
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    database.execute.mockImplementationOnce(() => {
      started();
      return new Promise<Record<string, unknown>[]>(() => {});
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const pending = httpCall();
    await queryStarted;
    await vi.advanceTimersByTimeAsync(CONTEXT_QUERY_BUDGET_MS);
    const response = await pending;
    expect(response.status).toBe(200);
    const payload = await response.json() as RpcResponse;
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content).toEqual([{
      type: "text",
      text: expect.stringContaining("request deadline")
    }]);
    expect(payload.result?.structuredContent).not.toHaveProperty("markdown");

    const next = await httpCall();
    const recovered = await next.json() as RpcResponse;
    expect(recovered.result?.isError).not.toBe(true);
    expect(recovered.result?.structuredContent).toMatchObject({ markdown: BODY });
    expect(database.execute).toHaveBeenCalledTimes(2);
  }, 15_000);
});
