import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import {
  Client as ModernClient,
  ProtocolErrorCode,
  StreamableHTTPClientTransport as ModernHttpTransport
} from "@modelcontextprotocol/client";
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport as LegacyHttpTransport
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  MCP_RESOURCE,
  MCP_ROUTE,
  MCP_SCOPE,
  PUBLIC_ORIGIN
} from "../src/constants.js";
import type { Env } from "../src/config.js";

const testTidb = vi.hoisted(() => ({
  execute: vi.fn()
}));

vi.mock("../src/tidb.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tidb.js")>();
  return {
    ...actual,
    createTidbClient: () => ({ execute: testTidb.execute })
  };
});

import worker from "../src/index.js";

const SERVER_URL = new URL(MCP_RESOURCE);
const SERVER_HOST = SERVER_URL.hostname;
const CLIENT_REDIRECT_URI = "https://client.example/callback";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const EDITING_MARKDOWN = "# Editing fixture\n\nProduction-entrypoint integration.";
const AUTHOR_STYLE_MARKDOWN = "# Author style fixture\n\nComplete source.";
const EXPECTED_TOOL_NAMES = [
  "get_analysis_skill_context",
  "get_author_style_context",
  "get_editing_playbook_context",
  "get_media_playbook_context",
  "get_metaskill_context",
  "get_planning_playbook_context",
  "read_context",
  "search_author_style_evidence",
  "search_metaskill_evidence",
  "search_personal_context"
].sort();

class MemoryKv {
  private readonly entries = new Map<string, {
    value: string;
    expiresAt?: number;
  }>();

  async get(
    key: string,
    options?: string | { type?: string }
  ): Promise<unknown> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }

    const type = typeof options === "string" ? options : options?.type;
    if (type === "json") {
      return JSON.parse(entry.value) as unknown;
    }
    if (type === "arrayBuffer") {
      return new TextEncoder().encode(entry.value).buffer;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: { expiration?: number; expirationTtl?: number }
  ): Promise<void> {
    const stringValue = typeof value === "string"
      ? value
      : new TextDecoder().decode(
        value instanceof ArrayBuffer
          ? value
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      );
    const expirationSeconds = options?.expiration
      ?? (
        options?.expirationTtl === undefined
          ? undefined
          : Math.floor(Date.now() / 1000) + options.expirationTtl
      );
    this.entries.set(key, {
      value: stringValue,
      ...(expirationSeconds === undefined
        ? {}
        : { expiresAt: expirationSeconds * 1000 })
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async list(options: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor: string;
  }> {
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    const matching = [...this.entries.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ""))
      .sort();
    const limit = options.limit ?? 1000;
    const page = matching.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: nextOffset >= matching.length,
      cursor: nextOffset >= matching.length ? "" : String(nextOffset)
    };
  }
}

interface Exchange {
  method: string;
  requestHeaders: Headers;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
}

let env: Env;
let accessToken: string;
let wrongAudienceToken: string;

beforeAll(async () => {
  testTidb.execute.mockImplementation(
    async (sql: string, params?: readonly unknown[]) => {
      if (
        sql.includes("FROM editor_knowledge_documents")
        && params?.[0] === "henshu-editing-playbook"
      ) {
        return [{
          document_id: "henshu-editing-playbook",
          title: "Editing fixture",
          markdown: EDITING_MARKDOWN,
          markdown_sha256: "e".repeat(64),
          section_revision_sha256: null,
          section_count: null,
          search_span_count: null,
          last_synced_at: "2026-07-28T00:00:00.000Z"
        }];
      }
      if (
        sql.includes("FROM author_style_documents AS documents")
        && sql.includes("documents.source_markdown")
        && params?.[0] === "ore-title-style"
      ) {
        return [{
          document_id: "ore-title-style",
          display_name: "Title style fixture",
          revision_sha256: "r".repeat(64),
          source_markdown_sha256: "s".repeat(64),
          source_markdown: AUTHOR_STYLE_MARKDOWN
        }];
      }
      return [];
    }
  );

  env = createEnvironment();
  const rootResponse = await productionFetch(
    new Request(`${PUBLIC_ORIGIN}/`, {
      headers: { host: SERVER_HOST }
    }),
    env
  );
  expect(rootResponse.status).toBe(200);
  expect(env.OAUTH_PROVIDER).toBeDefined();

  accessToken = await issueAccessToken(env, MCP_RESOURCE);
  wrongAudienceToken = await issueAccessToken(
    env,
    "https://wrong-resource.example/mcp"
  );
});

function createEnvironment(): Env {
  return {
    TIDB_DATABASE_URL: "mysql://test.invalid/mycontext",
    GITHUB_CLIENT_ID: "test-github-client",
    GITHUB_CLIENT_SECRET: "test-github-secret",
    GITHUB_ALLOWED_USER_ID: "1",
    OAUTH_KV: new MemoryKv() as unknown as KVNamespace,
    AUTH_KV: new MemoryKv() as unknown as KVNamespace,
    OAUTH_PROVIDER: undefined as unknown as OAuthHelpers
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    props: {},
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext;
}

async function productionFetch(request: Request, targetEnv = env): Promise<Response> {
  return worker.fetch(request, targetEnv, createExecutionContext());
}

async function issueAccessToken(
  targetEnv: Env,
  resource: string
): Promise<string> {
  const client = await targetEnv.OAUTH_PROVIDER.createClient({
    clientName: "MCP HTTP integration test",
    redirectUris: [CLIENT_REDIRECT_URI],
    tokenEndpointAuthMethod: "none"
  });
  const verifier = `mcp-current-${"v".repeat(48)}`;
  const verifierHash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  const challenge = Buffer.from(verifierHash).toString("base64url");
  const { redirectTo } = await targetEnv.OAUTH_PROVIDER.completeAuthorization({
    request: {
      responseType: "code",
      clientId: client.clientId,
      redirectUri: CLIENT_REDIRECT_URI,
      scope: [MCP_SCOPE],
      state: "integration-state",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      resource
    },
    userId: `integration-${crypto.randomUUID()}`,
    metadata: { source: "mcpHttp.test.ts" },
    scope: [MCP_SCOPE],
    props: { userId: "integration-user" },
    revokeExistingGrants: false
  });
  const code = new URL(redirectTo).searchParams.get("code");
  if (code === null) {
    throw new Error("OAuthProvider did not return an authorization code");
  }

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: client.clientId,
    redirect_uri: CLIENT_REDIRECT_URI,
    code_verifier: verifier
  });
  const tokenResponse = await productionFetch(
    new Request(`${PUBLIC_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        host: SERVER_HOST
      },
      body: form
    }),
    targetEnv
  );
  const payload = await tokenResponse.json() as { access_token?: string };
  if (tokenResponse.status !== 200 || payload.access_token === undefined) {
    throw new Error(`OAuth token exchange failed with ${tokenResponse.status}`);
  }
  return payload.access_token;
}

function createInProcessFetch(
  exchanges: Exchange[]
): typeof fetch {
  const inProcessFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const original = new Request(input, init);
    const headers = new Headers(original.headers);
    headers.set("host", new URL(original.url).hostname);
    const request = new Request(original, { headers });
    const requestBody = request.method === "POST"
      && request.headers.get("content-type")?.includes("application/json")
      ? await request.clone().json()
      : null;
    const response = await productionFetch(request);
    const responseBody = response.headers.get("content-type")?.includes("application/json")
      ? await response.clone().json()
      : await response.clone().text();
    exchanges.push({
      method: request.method,
      requestHeaders: new Headers(request.headers),
      requestBody,
      responseStatus: response.status,
      responseBody
    });
    return response;
  };
  return inProcessFetch as typeof fetch;
}

function modernEnvelope(version = MODERN_PROTOCOL_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": {
      name: "mycontext-http-test",
      version: "1.0.0"
    },
    "io.modelcontextprotocol/clientCapabilities": {}
  };
}

function discoverRequest({
  version = MODERN_PROTOCOL_VERSION,
  headerVersion = version,
  host = SERVER_HOST,
  origin,
  bearer = accessToken,
  method = "POST"
}: {
  version?: string;
  headerVersion?: string;
  host?: string | null;
  origin?: string;
  bearer?: string | null;
  method?: "POST" | "OPTIONS";
} = {}): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-method": "server/discover",
    "mcp-protocol-version": headerVersion
  });
  if (host !== null) {
    headers.set("host", host);
  }
  if (origin !== undefined) {
    headers.set("origin", origin);
  }
  if (bearer !== null) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  return new Request(SERVER_URL, {
    method,
    headers,
    ...(method === "POST"
      ? {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: modernEnvelope(version) }
        })
      }
      : {})
  });
}

async function assertSuccessfulSurface(
  client: ModernClient | LegacyClient
): Promise<void> {
  const tools = await client.listTools();
  const resources = await client.listResources();
  const templates = await client.listResourceTemplates();
  const call = await client.callTool({
    name: "get_editing_playbook_context",
    arguments: {}
  });
  const uri = "mycontext://author-style/ore-title-style";
  const read = await client.readResource({ uri });

  expect(tools.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
  expect(resources.resources).toHaveLength(6);
  expect(templates.resourceTemplates).toHaveLength(5);
  expect(call.isError).not.toBe(true);
  expect(call.content).toEqual([{ type: "text", text: EDITING_MARKDOWN }]);
  expect(call.structuredContent).toMatchObject({
    document_id: "editor-knowledge:henshu-editing-playbook",
    retrieval_mode: "full_playbook",
    truncated: false
  });
  expect(read.contents).toEqual([expect.objectContaining({
    uri,
    mimeType: "text/markdown",
    text: AUTHOR_STYLE_MARKDOWN
  })]);
}

describe("MCP stable 2026-07-28 production HTTP entrypoint", () => {
  it("keeps refresh support at the authorization server but not as a resource scope", async () => {
    const resourceResponse = await productionFetch(
      new Request(
        `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${MCP_ROUTE}`,
        { headers: { host: SERVER_HOST } }
      )
    );
    expect(resourceResponse.status).toBe(200);
    const resourceMetadata = await resourceResponse.json() as {
      resource?: string;
      scopes_supported?: string[];
    };
    expect(resourceMetadata.resource).toBe(MCP_RESOURCE);
    expect(resourceMetadata.scopes_supported).toEqual([MCP_SCOPE]);

    const authorizationResponse = await productionFetch(
      new Request(`${PUBLIC_ORIGIN}/.well-known/oauth-authorization-server`, {
        headers: { host: SERVER_HOST }
      })
    );
    expect(authorizationResponse.status).toBe(200);
    const authorizationMetadata = await authorizationResponse.json() as {
      scopes_supported?: string[];
    };
    expect(authorizationMetadata.scopes_supported).toContain(MCP_SCOPE);
    expect(authorizationMetadata.scopes_supported).toContain("offline_access");
  });

  it("serves authorized 2026-07-28 traffic through OAuthProvider", async () => {
    const exchanges: Exchange[] = [];
    const client = new ModernClient(
      { name: "mycontext-modern-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: MODERN_PROTOCOL_VERSION }
        }
      }
    );
    const transport = new ModernHttpTransport(SERVER_URL, {
      authProvider: { token: async () => accessToken },
      fetch: createInProcessFetch(exchanges)
    });

    await client.connect(transport);
    await assertSuccessfulSurface(client);

    const discover = exchanges.find((exchange) => {
      const body = exchange.requestBody as { method?: string };
      return body?.method === "server/discover";
    });
    expect(discover?.requestHeaders.get("authorization"))
      .toBe(`Bearer ${accessToken}`);
    expect(discover?.requestHeaders.get("mcp-protocol-version"))
      .toBe(MODERN_PROTOCOL_VERSION);
    expect(discover?.responseBody).toMatchObject({
      result: {
        supportedVersions: [MODERN_PROTOCOL_VERSION],
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private"
      }
    });

    const toolsList = exchanges.find((exchange) => {
      const body = exchange.requestBody as { method?: string };
      return body?.method === "tools/list";
    });
    const listedTools = (
      toolsList?.responseBody as {
        result?: { tools?: Array<Record<string, unknown>> };
      }
    ).result?.tools ?? [];
    expect(listedTools).toHaveLength(10);
    for (const tool of listedTools) {
      expect(tool.securitySchemes).toEqual([{
        type: "oauth2",
        scopes: [MCP_SCOPE]
      }]);
    }

    const toolCall = exchanges.find((exchange) => {
      const body = exchange.requestBody as { method?: string };
      return body?.method === "tools/call";
    });
    expect(toolCall?.requestHeaders.get("mcp-method")).toBe("tools/call");
    expect(toolCall?.requestHeaders.get("mcp-name"))
      .toBe("get_editing_playbook_context");

    await client.close();
  });

  it("keeps authorized SDK 1.30 stateless client compatibility", async () => {
    const exchanges: Exchange[] = [];
    const client = new LegacyClient({
      name: "mycontext-legacy-compatibility-test",
      version: "1.0.0"
    });
    const transport = new LegacyHttpTransport(SERVER_URL, {
      fetch: createInProcessFetch(exchanges),
      requestInit: {
        headers: { authorization: `Bearer ${accessToken}` }
      }
    });

    await client.connect(transport);
    await assertSuccessfulSurface(client);
    expect(exchanges.some((exchange) => {
      const body = exchange.requestBody as { method?: string };
      return body?.method === "initialize";
    })).toBe(true);
    expect(exchanges.every((exchange) =>
      exchange.requestHeaders.get("authorization") === `Bearer ${accessToken}`
    )).toBe(true);

    await client.close();
  });

  it("rejects invalid Host and Origin before the OAuth challenge", async () => {
    for (const method of ["POST", "OPTIONS"] as const) {
      const missingHost = await productionFetch(discoverRequest({
        method,
        host: null,
        bearer: null
      }));
      expect(missingHost.status).toBe(403);

      const invalidHost = await productionFetch(discoverRequest({
        method,
        host: "invalid.example",
        bearer: null
      }));
      expect(invalidHost.status).toBe(403);

      const invalidOrigin = await productionFetch(discoverRequest({
        method,
        origin: "https://invalid.example",
        bearer: null
      }));
      expect(invalidOrigin.status).toBe(403);
      expect(invalidOrigin.headers.get("x-content-type-options")).toBe("nosniff");
    }

    const validOrigin = await productionFetch(discoverRequest({
      origin: PUBLIC_ORIGIN,
      bearer: null
    }));
    expect(validOrigin.status).toBe(401);
    expect(validOrigin.headers.get("www-authenticate")).toContain(
      `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${MCP_ROUTE}`
    );

    const validPreflight = await productionFetch(discoverRequest({
      method: "OPTIONS",
      origin: PUBLIC_ORIGIN,
      bearer: null
    }));
    expect(validPreflight.status).toBe(204);
  });

  it("rejects missing, invalid, and wrong-audience bearer tokens", async () => {
    const missing = await productionFetch(discoverRequest({ bearer: null }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain(
      'error="invalid_token"'
    );

    const invalid = await productionFetch(discoverRequest({
      bearer: "not-a-valid-token"
    }));
    expect(invalid.status).toBe(401);

    const wrongAudience = await productionFetch(discoverRequest({
      bearer: wrongAudienceToken
    }));
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.headers.get("www-authenticate"))
      .toContain('error_description="Invalid audience"');
  });

  it("returns 405 for authenticated session methods in stateless mode", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await productionFetch(new Request(SERVER_URL, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          host: SERVER_HOST
        }
      }));
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: "Method not allowed." }
      });
    }
  });

  it("rejects unsupported and mismatched protocol claims after OAuth", async () => {
    const unsupported = await productionFetch(discoverRequest({
      version: "2099-01-01"
    }));
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({
      error: {
        code: ProtocolErrorCode.UnsupportedProtocolVersion,
        data: {
          supported: [MODERN_PROTOCOL_VERSION],
          requested: "2099-01-01"
        }
      }
    });

    const mismatch = await productionFetch(discoverRequest({
      headerVersion: "2099-01-01"
    }));
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: -32020 }
    });
  });

  it("emits the 2026 resource-not-found shape through OAuthProvider", async () => {
    const client = new ModernClient(
      { name: "mycontext-resource-test", version: "1.0.0" },
      {
        versionNegotiation: {
          mode: { pin: MODERN_PROTOCOL_VERSION }
        }
      }
    );
    const transport = new ModernHttpTransport(SERVER_URL, {
      authProvider: { token: async () => accessToken },
      fetch: createInProcessFetch([])
    });
    await client.connect(transport);

    const uri = "mycontext://author-style/ore-title-style/sections/missing";
    await expect(client.readResource({ uri })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      data: { uri }
    });

    await client.close();
  });
});
