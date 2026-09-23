import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  McpServer,
  originValidationResponse
} from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import {
  MCP_RESOURCE,
  MCP_ROUTE,
  MCP_SCOPE,
  OFFLINE_ACCESS_SCOPE,
  PUBLIC_ORIGIN
} from "./constants.js";
import { ConfigError, loadConfig, type AppConfig, type Env } from "./config.js";
import { jsonResponse, withSecurityHeaders } from "./http.js";
import { inspectMcpRequest, withOpenAiToolDescriptors } from "./mcpCompatibility.js";
import { defaultHandler } from "./oauth.js";
import { registerBusinessKnowledgeResources } from "./resources/businessKnowledge.js";
import { registerEditorKnowledgeResources } from "./resources/editorKnowledge.js";
import { registerAuthorStyleResources } from "./resources/authorStyle.js";
import { registerMetaskillResources } from "./resources/metaskill.js";
import { createTidbClient } from "./tidb.js";
import { registerPublicTools } from "./tools/register.js";

function createServer(config: AppConfig): McpServer {
  const server = new McpServer({ name: "mycontext-mcp", version: "0.8.0" });
  const client = createTidbClient(config.tidbDatabaseUrl);

  registerPublicTools(server, client, config.personalSynonyms);
  registerBusinessKnowledgeResources(server, client);
  registerEditorKnowledgeResources(server, client);
  registerAuthorStyleResources(server, client);
  registerMetaskillResources(server, client);

  return server;
}

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const inspection = await inspectMcpRequest(request);
    let config: AppConfig;
    try {
      config = loadConfig(env);
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: "server_misconfigured" }, 500);
      }
      throw error;
    }

    const response = await createMcpHandler(() => createServer(config), {
      route: MCP_ROUTE,
      responseMode: "json",
      legacy: "stateless",
      // Origin syntax is validated by mcpEndpointValidationResponse. OAuth,
      // rather than a browser-origin allowlist, is the access-control boundary.
      allowedOriginHostnames: "*"
    })(request, env, ctx);
    const finalResponse = withSecurityHeaders(
      await withOpenAiToolDescriptors(response, inspection.includesToolsList)
    );
    console.log("mcp_request", JSON.stringify({
      request_id: requestId,
      cf_ray: request.headers.get("cf-ray"),
      jsonrpc_method: inspection.methods.join(",") || null,
      tool_name: inspection.toolName,
      total_duration_ms: Date.now() - startedAt,
      status_code: finalResponse.status
    }));
    return finalResponse;
  }
};

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: MCP_ROUTE,
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: [MCP_SCOPE, OFFLINE_ACCESS_SCOPE],
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  allowTokenExchangeGrant: false,
  disallowPublicClientRegistration: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 60 * 60 * 24 * 30,
  clientRegistrationTTL: 60 * 60 * 24 * 90,
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [PUBLIC_ORIGIN],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "mycontext-mcp"
  },
  onError(error) {
    console.error("oauth_provider_error", error.code, error.status);
  }
});

const publicHostname = new URL(PUBLIC_ORIGIN).hostname;
const allowedMcpHostnames = [
  ...localhostAllowedHostnames(),
  publicHostname
];

function originSyntaxValidationResponse(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    return undefined;
  }

  let parsedOrigin: URL | undefined;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    // The SDK helper below returns the protocol-compliant JSON-RPC 403 shape.
  }

  const isCanonicalHttpOrigin = parsedOrigin !== undefined
    && (parsedOrigin.protocol === "https:" || parsedOrigin.protocol === "http:")
    && parsedOrigin.hostname !== ""
    && parsedOrigin.origin === origin;

  return originValidationResponse(
    request,
    isCanonicalHttpOrigin && parsedOrigin !== undefined ? [parsedOrigin.hostname] : []
  );
}

function withMcpCorsHeaders(request: Request, response: Response): Response {
  if (new URL(request.url).pathname !== MCP_ROUTE) {
    return response;
  }
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID, X-OpenAI-Session"
  );
  headers.set("access-control-expose-headers", "Mcp-Session-Id, WWW-Authenticate");
  const vary = headers.get("vary");
  if (vary === null || !vary.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary === null ? "Origin" : `${vary}, Origin`);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function mcpEndpointValidationResponse(request: Request): Response | undefined {
  if (new URL(request.url).pathname !== MCP_ROUTE) {
    return undefined;
  }

  return hostHeaderValidationResponse(request, allowedMcpHostnames)
    ?? originSyntaxValidationResponse(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const validationResponse = mcpEndpointValidationResponse(request);
    if (validationResponse !== undefined) {
      return withSecurityHeaders(validationResponse);
    }
    return withSecurityHeaders(
      withMcpCorsHeaders(request, await oauthProvider.fetch(request, env, ctx))
    );
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const result = await oauthProvider.purgeExpiredData(env, { batchSize: 100 });
    console.log("oauth_kv_purge", result);
  }
} satisfies ExportedHandler<Env>;
