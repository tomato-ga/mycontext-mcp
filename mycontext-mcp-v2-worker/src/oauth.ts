import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { constantTimeEqual } from "./auth.js";
import {
  GITHUB_CALLBACK_URL,
  MCP_RESOURCE,
  MCP_ROUTE,
  MCP_SCOPE,
  OFFLINE_ACCESS_SCOPE,
  PUBLIC_ORIGIN
} from "./constants.js";
import { ConfigError, loadAuthConfig, type Env } from "./config.js";
import { jsonResponse, withSecurityHeaders } from "./http.js";

const AUTH_SESSION_PREFIX = "github-oauth-state:";
const AUTH_SESSION_TTL_SECONDS = 600;
const CSRF_COOKIE_NAME = "__Host-mycontext_oauth_csrf";
const GITHUB_AUTHORIZE_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const GITHUB_USER_ENDPOINT = "https://api.github.com/user";

interface AuthSession {
  oauthRequest: AuthRequest;
  clientName: string;
}

interface GitHubUser {
  id: number;
  login: string;
}

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
}

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/authorize") {
        return request.method === "GET"
          ? await showAuthorizationPage(request, env)
          : request.method === "POST"
            ? await beginGitHubAuthorization(request, env)
            : new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
      }

      if (url.pathname === "/oauth/github/callback" && request.method === "GET") {
        return await finishGitHubAuthorization(request, env);
      }

      if (url.pathname === "/healthz") {
        return new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      }

      if (url.pathname === "/") {
        return jsonResponse({
          name: "mycontext-mcp",
          mcp: MCP_RESOURCE,
          authentication: "OAuth 2.1"
        }, 200);
      }

      if (url.pathname === MCP_ROUTE) {
        return oauthChallengeResponse();
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ConfigError) {
        return jsonResponse({ error: "server_misconfigured" }, 500);
      }

      console.error("oauth_handler_error", error instanceof Error ? error.name : "unknown");
      return jsonResponse({ error: "authorization_failed" }, 500);
    }
  }
};

async function showAuthorizationPage(request: Request, env: Env): Promise<Response> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  validateRequestedScope(oauthRequest);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (client === null) {
    return oauthErrorPage("Unknown OAuth client", 400);
  }

  const csrfToken = randomToken();
  const html = renderConsentPage(oauthRequest, client, csrfToken);
  return htmlResponse(html, 200, {
    "set-cookie": csrfCookie(csrfToken, AUTH_SESSION_TTL_SECONDS)
  });
}

async function beginGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const submittedCsrf = getFormString(form, "csrf_token");
  const cookieCsrf = readCookie(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  if (submittedCsrf === null || cookieCsrf === null || !constantTimeEqual(submittedCsrf, cookieCsrf)) {
    return oauthErrorPage("Authorization session expired. Start the connection again.", 400);
  }

  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  validateRequestedScope(oauthRequest);
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
  if (client === null) {
    return oauthErrorPage("Unknown OAuth client", 400);
  }

  const config = loadAuthConfig(env);
  const state = randomToken();
  const session: AuthSession = {
    oauthRequest,
    clientName: safeClientName(client)
  };
  await env.AUTH_KV.put(`${AUTH_SESSION_PREFIX}${state}`, JSON.stringify(session), {
    expirationTtl: AUTH_SESSION_TTL_SECONDS
  });

  const location = buildGitHubAuthorizeUrl(config.githubClientId, state);
  return htmlResponse(renderGitHubRedirectPage(location), 200, {
    "set-cookie": csrfCookie("", 0)
  });
}

async function finishGitHubAuthorization(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null || !/^[a-f0-9]{64}$/.test(state)) {
    return oauthErrorPage("GitHub did not return a valid authorization response.", 400);
  }

  const sessionKey = `${AUTH_SESSION_PREFIX}${state}`;
  const session = await env.AUTH_KV.get<AuthSession>(sessionKey, "json");
  if (session === null) {
    return oauthErrorPage("Authorization session expired. Start the connection again.", 400);
  }
  await env.AUTH_KV.delete(sessionKey);

  const config = loadAuthConfig(env);
  const upstreamToken = await exchangeGitHubCode(code, config.githubClientId, config.githubClientSecret);
  const user = await fetchGitHubUser(upstreamToken);
  if (!isAllowedGitHubUser(user.id, config.githubAllowedUserId)) {
    return oauthErrorPage("This GitHub account is not allowed to access mycontext-mcp.", 403);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: session.oauthRequest,
    userId: `github-${user.id}`,
    metadata: {
      identityProvider: "github",
      userId: user.id,
      login: user.login,
      clientName: session.clientName
    },
    scope: session.oauthRequest.scope.filter((scope) => ALLOWED_SCOPES.has(scope)),
    props: {
      identityProvider: "github",
      userId: user.id,
      login: user.login
    }
  });

  return new Response(null, {
    status: 302,
    headers: { location: redirectTo, "cache-control": "no-store" }
  });
}

async function exchangeGitHubCode(code: string, clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "mycontext-mcp"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: GITHUB_CALLBACK_URL
    })
  });
  if (!response.ok) {
    throw new Error("GitHub token exchange failed");
  }

  const tokenResult = await response.json<GitHubTokenResponse>();
  if (tokenResult.access_token === undefined) {
    throw new Error(`GitHub token exchange rejected: ${tokenResult.error ?? "unknown"}`);
  }
  return tokenResult.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_ENDPOINT, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "mycontext-mcp",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (!response.ok) {
    throw new Error("GitHub user lookup failed");
  }

  const data = await response.json<Partial<GitHubUser>>();
  if (typeof data.id !== "number" || typeof data.login !== "string") {
    throw new Error("GitHub user response was invalid");
  }
  return { id: data.id, login: data.login };
}

const ALLOWED_SCOPES = new Set([MCP_SCOPE, OFFLINE_ACCESS_SCOPE]);

export function validateRequestedScope(request: AuthRequest): void {
  if (
    !request.scope.includes(MCP_SCOPE) ||
    request.scope.some((scope) => !ALLOWED_SCOPES.has(scope))
  ) {
    throw new Error("Unsupported OAuth scope");
  }
}

function renderConsentPage(request: AuthRequest, client: ClientInfo, csrfToken: string): string {
  const clientName = escapeHtml(safeClientName(client));
  const clientLink = safeHttpsUrl(client.clientUri);
  const clientLabel = clientLink === null
    ? clientName
    : `<a href="${escapeHtml(clientLink)}" rel="noreferrer">${clientName}</a>`;
  const action = buildAuthorizationFormAction(request);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize mycontext-mcp</title>
  <style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#111827}.card{width:min(420px,calc(100% - 32px));box-sizing:border-box;padding:28px;border-radius:16px;background:white;box-shadow:0 12px 40px #11182718}h1{font-size:22px;margin:0 0 12px}p{line-height:1.55;color:#4b5563}.scope{padding:12px 14px;border-radius:10px;background:#f3f4f6;color:#111827}.actions{display:flex;gap:10px;margin-top:22px}button,a.cancel{border:0;border-radius:9px;padding:11px 15px;font:inherit;text-decoration:none;cursor:pointer}button{background:#111827;color:white}a.cancel{background:#e5e7eb;color:#111827}a{color:#2563eb}@media(prefers-color-scheme:dark){body{background:#111827;color:#f9fafb}.card{background:#1f2937}.card p{color:#d1d5db}.scope{background:#374151;color:#f9fafb}button{background:#f9fafb;color:#111827}}
  </style>
</head>
<body>
  <main class="card">
    <h1>Connect ${clientLabel}</h1>
    <p>Sign in with the approved GitHub account to let this client read your synced mycontext documents.</p>
    <p class="scope"><strong>Permission:</strong> Read context only</p>
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      <div class="actions"><button type="submit">Continue with GitHub</button><a class="cancel" href="${PUBLIC_ORIGIN}">Cancel</a></div>
    </form>
  </main>
</body>
</html>`;
}

function renderGitHubRedirectPage(location: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Continue to GitHub</title>
  <style>
    :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f5f7;color:#111827}.card{width:min(420px,calc(100% - 32px));box-sizing:border-box;padding:28px;border-radius:16px;background:white;box-shadow:0 12px 40px #11182718}h1{font-size:22px;margin:0 0 12px}p{line-height:1.55;color:#4b5563}a{display:inline-block;margin-top:12px;border-radius:9px;padding:11px 15px;background:#111827;color:white;text-decoration:none}@media(prefers-color-scheme:dark){body{background:#111827;color:#f9fafb}.card{background:#1f2937}.card p{color:#d1d5db}a{background:#f9fafb;color:#111827}}
  </style>
</head>
<body>
  <main class="card">
    <h1>Continue to GitHub</h1>
    <p>Complete sign-in with the approved GitHub account.</p>
    <a href="${escapeHtml(location)}" rel="noreferrer">Open GitHub authorization</a>
  </main>
</body>
</html>`;
}

export function buildAuthorizationFormAction(request: AuthRequest): string {
  const parameters = new URLSearchParams({
    response_type: request.responseType,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scope.join(" "),
    state: request.state,
    ...(request.codeChallenge === undefined ? {} : { code_challenge: request.codeChallenge }),
    ...(request.codeChallengeMethod === undefined ? {} : { code_challenge_method: request.codeChallengeMethod })
  });

  const resources = request.resource === undefined
    ? []
    : Array.isArray(request.resource) ? request.resource : [request.resource];
  for (const resource of resources) {
    parameters.append("resource", resource);
  }

  return `/authorize?${parameters.toString()}`;
}

function htmlResponse(html: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return withSecurityHeaders(new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      ...extraHeaders
    }
  }));
}

function oauthErrorPage(message: string, status: number): Response {
  return htmlResponse(`<!doctype html><meta charset="utf-8"><title>Authorization error</title><p>${escapeHtml(message)}</p>`, status);
}

function oauthChallengeResponse(): Response {
  return withSecurityHeaders(new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource${MCP_ROUTE}", scope="${MCP_SCOPE}"`
    }
  }));
}

function csrfCookie(value: string, maxAge: number): string {
  return `${CSRF_COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function getFormString(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function safeClientName(client: ClientInfo): string {
  return (client.clientName?.trim() || "an MCP client").slice(0, 120);
}

function safeHttpsUrl(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (cookieHeader === null) {
    return null;
  }
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator !== -1 && cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return null;
}

export function buildGitHubAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL(GITHUB_AUTHORIZE_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: GITHUB_CALLBACK_URL,
    scope: "read:user",
    state,
    allow_signup: "false"
  }).toString();
  return url.toString();
}

export function isAllowedGitHubUser(actualId: number, allowedId: number): boolean {
  return Number.isSafeInteger(actualId) && actualId === allowedId;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}
