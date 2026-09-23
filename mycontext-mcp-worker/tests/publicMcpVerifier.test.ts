import { describe, expect, it, vi } from "vitest";
import {
  PublicMcpVerificationError,
  verifyPublicMcp
} from "../scripts/public-mcp-verifier.mjs";
import { parseVerifyArguments } from "../scripts/verify-public-mcp.mjs";

const BASE_URL = "https://mycontext-mcp.servicedake.workers.dev";
const PROTECTED_RESOURCE = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;
const VERSION_ID = "11111111-2222-4333-8444-555555555555";

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function isCanonicalHttpOrigin(origin: string): boolean {
  if (origin === "null") {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.hostname !== ""
      && parsed.origin === origin;
  } catch {
    return false;
  }
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": [
      "Authorization",
      "Content-Type",
      "Accept",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
      "Mcp-Method",
      "Mcp-Name",
      "Last-Event-ID",
      "X-OpenAI-Session"
    ].join(", "),
    "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate",
    vary: "Accept-Encoding, Origin"
  };
}

function healthyFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const override = request.headers.get("cloudflare-workers-version-overrides");
    if (override !== null) {
      expect(override).toBe(`mycontext-mcp="${VERSION_ID}"`);
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", {
        headers: override === null ? {} : { "x-worker-version-id": VERSION_ID }
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: `${BASE_URL}/mcp`,
        authorization_servers: [BASE_URL],
        scopes_supported: ["context:read"],
        bearer_methods_supported: ["header"]
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: BASE_URL,
        authorization_endpoint: `${BASE_URL}/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        registration_endpoint: `${BASE_URL}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["context:read", "offline_access"]
      });
    }
    if (url.pathname !== "/mcp") {
      return new Response("not found", { status: 404 });
    }

    const origin = request.headers.get("origin");
    if (origin !== null && !isCanonicalHttpOrigin(origin)) {
      return json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Origin" },
        id: null
      }, 403);
    }
    const cors = origin === null ? {} : corsHeaders(origin);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.headers.get("authorization") === "Bearer valid-token") {
      return json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          supportedVersions: ["2026-07-28"],
          resultType: "complete"
        }
      }, 200, cors);
    }
    return json({
      error: "invalid_token",
      error_description: "Missing or invalid access token"
    }, 401, {
      ...cors,
      "www-authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE}", error="invalid_token"`
    });
  }) as typeof fetch;
}

describe("public MCP release verifier", () => {
  it("accepts pnpm's argument separator for manual version verification", () => {
    expect(parseVerifyArguments([
      "--",
      "--version-id",
      VERSION_ID,
      "--allow-legacy-version-header"
    ])).toMatchObject({ versionId: VERSION_ID, requireVersionHeader: false });
  });

  it("proves the browser, backend, OAuth metadata, and malformed-Origin contract", async () => {
    const fetchImpl = healthyFetch();
    const result = await verifyPublicMcp({
      baseUrl: BASE_URL,
      fetchImpl,
      accessToken: "valid-token",
      versionId: VERSION_ID,
      workerName: "mycontext-mcp"
    });

    expect(result.authenticated).toBe(true);
    expect(result.clientOrigins).toContain("https://chatgpt.com");
    expect(result.clientOrigins.some((origin) => origin.endsWith(".mcp-client.invalid")))
      .toBe(true);
    expect(result.checks).toBeGreaterThanOrEqual(16);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("fails against the exact old regression that rejected external Web Origins", async () => {
    const baseFetch = healthyFetch();
    const regressedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const origin = request.headers.get("origin");
      if (new URL(request.url).pathname === "/mcp"
        && origin !== null
        && isCanonicalHttpOrigin(origin)) {
        return json({
          jsonrpc: "2.0",
          error: { code: -32000, message: `Invalid Origin: ${new URL(origin).hostname}` },
          id: null
        }, 403);
      }
      return baseFetch(request);
    }) as typeof fetch;

    await expect(verifyPublicMcp({
      baseUrl: BASE_URL,
      fetchImpl: regressedFetch
    })).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PublicMcpVerificationError);
      expect(String(error)).toContain("https://chatgpt.com preflight");
      expect(String(error)).toContain("expected HTTP 204, received 403");
      expect(String(error)).toContain("OAuth challenge");
      return true;
    });
  });

  it("fails if Cloudflare silently ignores the requested Worker version override", async () => {
    const baseFetch = healthyFetch();
    const fallbackFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await baseFetch(request);
      if (new URL(request.url).pathname !== "/healthz") {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete("x-worker-version-id");
      return new Response(response.body, { status: response.status, headers });
    }) as typeof fetch;

    await expect(verifyPublicMcp({
      baseUrl: BASE_URL,
      fetchImpl: fallbackFetch,
      versionId: VERSION_ID
    })).rejects.toThrow(`version override did not execute expected Worker version ${VERSION_ID}`);
  });

  it("fails when CORS looks successful but does not echo the requesting Origin", async () => {
    const baseFetch = healthyFetch();
    const missingCorsFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.headers.get("origin") === "https://chatgpt.com") {
        return new Response(null, { status: request.method === "OPTIONS" ? 204 : 401 });
      }
      return baseFetch(request);
    }) as typeof fetch;

    await expect(verifyPublicMcp({
      baseUrl: BASE_URL,
      fetchImpl: missingCorsFetch
    })).rejects.toThrow("Access-Control-Allow-Origin");
  });

  it("fails if a malformed Origin reaches OAuth instead of returning 403", async () => {
    const baseFetch = healthyFetch();
    const permissiveFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.headers.get("origin") === "https://invalid.example/path") {
        return json({ error: "invalid_token" }, 401, {
          "www-authenticate": `Bearer resource_metadata="${PROTECTED_RESOURCE}", error="invalid_token"`
        });
      }
      return baseFetch(request);
    }) as typeof fetch;

    await expect(verifyPublicMcp({
      baseUrl: BASE_URL,
      fetchImpl: permissiveFetch
    })).rejects.toThrow("expected HTTP 403, received 401");
  });
});
