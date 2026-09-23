// @ts-check

export const DEFAULT_MCP_PUBLIC_ORIGIN = "https://mycontext-mcp.servicedake.workers.dev";
export const DEFAULT_WEB_CLIENT_ORIGINS = Object.freeze([
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://arbitrary-mcp-client.example"
]);

const MCP_ROUTE = "/mcp";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const MCP_SCOPE = "context:read";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const REQUIRED_CORS_HEADERS = Object.freeze([
  "authorization",
  "content-type",
  "accept",
  "mcp-protocol-version",
  "mcp-session-id",
  "mcp-method",
  "mcp-name",
  "last-event-id",
  "x-openai-session"
]);
const MALFORMED_ORIGINS = Object.freeze([
  "null",
  "ftp://invalid.example",
  "https://invalid.example/path"
]);

/** @typedef {typeof globalThis.fetch} FetchLike */

/**
 * @typedef PublicMcpVerificationOptions
 * @property {string=} baseUrl
 * @property {FetchLike=} fetchImpl
 * @property {readonly string[]=} clientOrigins
 * @property {string=} accessToken
 * @property {string=} versionId
 * @property {string=} workerName
 * @property {number=} requestTimeoutMs
 * @property {boolean=} requireVersionHeader
 */

/**
 * @typedef PublicMcpVerificationResult
 * @property {string} baseUrl
 * @property {number} checks
 * @property {readonly string[]} clientOrigins
 * @property {boolean} authenticated
 */

export class PublicMcpVerificationError extends Error {
  /** @param {readonly string[]} failures */
  constructor(failures) {
    super(`Public MCP verification failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    this.name = "PublicMcpVerificationError";
    this.failures = failures;
  }
}

/**
 * Verify the public, read-only HTTP boundary used by browser and backend MCP
 * clients. This intentionally stops at the OAuth challenge unless a short-lived
 * access token is explicitly provided by the caller.
 *
 * @param {PublicMcpVerificationOptions=} options
 * @returns {Promise<PublicMcpVerificationResult>}
 */
export async function verifyPublicMcp(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_MCP_PUBLIC_ORIGIN);
  const endpoint = `${baseUrl}${MCP_ROUTE}`;
  const protectedResourceUrl = `${baseUrl}/.well-known/oauth-protected-resource${MCP_ROUTE}`;
  const authorizationMetadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clientOrigins = options.clientOrigins ?? [
    ...DEFAULT_WEB_CLIENT_ORIGINS,
    randomClientOrigin()
  ];
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
  const versionHeaders = versionOverrideHeaders(options.versionId, options.workerName);

  /** @type {Array<[string, () => Promise<void>] >} */
  const checks = [
    ["healthz", async () => {
      const response = await request(fetchImpl, `${baseUrl}/healthz`, {
        headers: versionHeaders
      }, requestTimeoutMs);
      await assertStatus(response, 200, "healthz");
      const body = await response.text();
      assert(body === "ok", `healthz: expected body \"ok\", received ${JSON.stringify(body)}`);
      if (options.versionId !== undefined
        && options.versionId !== ""
        && options.requireVersionHeader !== false) {
        assert(response.headers.get("x-worker-version-id") === options.versionId,
          `healthz: version override did not execute expected Worker version ${options.versionId}`);
      }
    }],
    ["protected resource metadata", async () => {
      const response = await request(fetchImpl, protectedResourceUrl, {
        headers: versionHeaders
      }, requestTimeoutMs);
      await assertStatus(response, 200, "protected resource metadata");
      const metadata = await jsonObject(response, "protected resource metadata");
      assert(metadata.resource === endpoint,
        `protected resource metadata: expected resource ${endpoint}`);
      assert(stringArray(metadata.authorization_servers).includes(baseUrl),
        `protected resource metadata: expected authorization server ${baseUrl}`);
      assert(stringArray(metadata.scopes_supported).includes(MCP_SCOPE),
        `protected resource metadata: expected scope ${MCP_SCOPE}`);
      assert(stringArray(metadata.bearer_methods_supported).includes("header"),
        "protected resource metadata: expected header bearer method");
    }],
    ["authorization server metadata", async () => {
      const response = await request(fetchImpl, authorizationMetadataUrl, {
        headers: versionHeaders
      }, requestTimeoutMs);
      await assertStatus(response, 200, "authorization server metadata");
      const metadata = await jsonObject(response, "authorization server metadata");
      assert(metadata.issuer === baseUrl,
        `authorization server metadata: expected issuer ${baseUrl}`);
      assert(metadata.authorization_endpoint === `${baseUrl}/authorize`,
        "authorization server metadata: unexpected authorization endpoint");
      assert(metadata.token_endpoint === `${baseUrl}/oauth/token`,
        "authorization server metadata: unexpected token endpoint");
      assert(metadata.registration_endpoint === `${baseUrl}/oauth/register`,
        "authorization server metadata: unexpected registration endpoint");
      assert(stringArray(metadata.response_types_supported).includes("code"),
        "authorization server metadata: authorization code flow is missing");
      for (const grant of ["authorization_code", "refresh_token"]) {
        assert(stringArray(metadata.grant_types_supported).includes(grant),
          `authorization server metadata: grant ${grant} is missing`);
      }
      assert(stringArray(metadata.code_challenge_methods_supported).includes("S256"),
        "authorization server metadata: PKCE S256 is missing");
      for (const scope of [MCP_SCOPE, OFFLINE_ACCESS_SCOPE]) {
        assert(stringArray(metadata.scopes_supported).includes(scope),
          `authorization server metadata: scope ${scope} is missing`);
      }
    }],
    ["backend client without Origin", async () => {
      const response = await discover(fetchImpl, endpoint, {
        versionHeaders,
        requestTimeoutMs
      });
      await assertOAuthChallenge(response, protectedResourceUrl, "backend client without Origin");
      assert(response.headers.get("access-control-allow-origin") === null,
        "backend client without Origin: unexpected CORS origin response");
    }]
  ];

  for (const origin of clientOrigins) {
    checks.push(
      [`${origin} preflight`, async () => {
        const response = await preflight(
          fetchImpl,
          endpoint,
          origin,
          versionHeaders,
          requestTimeoutMs
        );
        await assertStatus(response, 204, `${origin} preflight`);
        assertCors(response, origin, `${origin} preflight`);
      }],
      [`${origin} OAuth challenge`, async () => {
        const response = await discover(fetchImpl, endpoint, {
          origin,
          versionHeaders,
          requestTimeoutMs
        });
        await assertOAuthChallenge(response, protectedResourceUrl, `${origin} OAuth challenge`);
        assertCors(response, origin, `${origin} OAuth challenge`);
      }]
    );
  }

  for (const origin of MALFORMED_ORIGINS) {
    checks.push([`malformed Origin ${origin}`, async () => {
      const response = await discover(fetchImpl, endpoint, {
        origin,
        versionHeaders,
        requestTimeoutMs
      });
      await assertStatus(response, 403, `malformed Origin ${origin}`);
      assert(response.headers.get("access-control-allow-origin") === null,
        `malformed Origin ${origin}: must not emit Access-Control-Allow-Origin`);
    }]);
  }

  if (options.accessToken !== undefined && options.accessToken !== "") {
    checks.push(["authenticated ChatGPT Origin", async () => {
      const origin = clientOrigins[0] ?? "https://chatgpt.com";
      const response = await discover(fetchImpl, endpoint, {
        origin,
        bearer: options.accessToken,
        versionHeaders,
        requestTimeoutMs
      });
      await assertStatus(response, 200, "authenticated ChatGPT Origin");
      assertCors(response, origin, "authenticated ChatGPT Origin");
      const body = await jsonObject(response, "authenticated ChatGPT Origin");
      const result = objectValue(body.result);
      assert(stringArray(result.supportedVersions).includes(MCP_PROTOCOL_VERSION),
        `authenticated ChatGPT Origin: server/discover does not support ${MCP_PROTOCOL_VERSION}`);
    }]);
  }

  /** @type {string[]} */
  const failures = [];
  await Promise.all(checks.map(async ([label, check]) => {
    try {
      await check();
    } catch (error) {
      failures.push(`${label}: ${errorMessage(error)}`);
    }
  }));

  if (failures.length > 0) {
    throw new PublicMcpVerificationError(failures.sort());
  }

  return {
    baseUrl,
    checks: checks.length,
    clientOrigins: [...clientOrigins],
    authenticated: options.accessToken !== undefined && options.accessToken !== ""
  };
}

/**
 * @param {PublicMcpVerificationOptions & {
 *   attempts?: number,
 *   retryDelayMs?: number,
 *   sleep?: (milliseconds: number) => Promise<void>
 * }=} options
 */
export async function verifyPublicMcpWithRetry(options = {}) {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  assert(Number.isInteger(attempts) && attempts >= 1 && attempts <= 10,
    "attempts must be an integer between 1 and 10");

  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verifyPublicMcp(options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(retryDelayMs * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} endpoint
 * @param {{
 *   origin?: string,
 *   bearer?: string,
 *   versionHeaders: Headers,
 *   requestTimeoutMs: number
 * }} options
 */
function discover(fetchImpl, endpoint, options) {
  const headers = new Headers(options.versionHeaders);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("mcp-method", "server/discover");
  headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  if (options.origin !== undefined) {
    headers.set("origin", options.origin);
  }
  if (options.bearer !== undefined) {
    headers.set("authorization", `Bearer ${options.bearer}`);
  }
  return request(fetchImpl, endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "mycontext-release-verifier",
            version: "1.0.0"
          },
          "io.modelcontextprotocol/clientCapabilities": {}
        }
      }
    })
  }, options.requestTimeoutMs);
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} endpoint
 * @param {string} origin
 * @param {Headers} versionHeaders
 * @param {number} requestTimeoutMs
 */
function preflight(fetchImpl, endpoint, origin, versionHeaders, requestTimeoutMs) {
  const headers = new Headers(versionHeaders);
  headers.set("origin", origin);
  headers.set("access-control-request-method", "POST");
  headers.set("access-control-request-headers", REQUIRED_CORS_HEADERS.join(", "));
  return request(fetchImpl, endpoint, {
    method: "OPTIONS",
    headers
  }, requestTimeoutMs);
}

/**
 * @param {FetchLike} fetchImpl
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
function request(fetchImpl, url, init, timeoutMs) {
  return fetchImpl(new Request(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs)
  }));
}

/** @param {Response} response @param {string} origin @param {string} label */
function assertCors(response, origin, label) {
  assert(response.headers.get("access-control-allow-origin") === origin,
    `${label}: Access-Control-Allow-Origin must echo ${origin}`);
  assert(headerTokens(response, "vary").includes("origin"),
    `${label}: Vary must include Origin`);
  assert(headerTokens(response, "access-control-allow-methods").includes("post"),
    `${label}: Access-Control-Allow-Methods must include POST`);
  const allowedHeaders = headerTokens(response, "access-control-allow-headers");
  for (const header of REQUIRED_CORS_HEADERS) {
    assert(allowedHeaders.includes(header),
      `${label}: Access-Control-Allow-Headers must include ${header}`);
  }
  const exposedHeaders = headerTokens(response, "access-control-expose-headers");
  for (const header of ["mcp-session-id", "www-authenticate"]) {
    assert(exposedHeaders.includes(header),
      `${label}: Access-Control-Expose-Headers must include ${header}`);
  }
}

/** @param {Response} response @param {string} metadataUrl @param {string} label */
async function assertOAuthChallenge(response, metadataUrl, label) {
  await assertStatus(response, 401, label);
  const challenge = response.headers.get("www-authenticate") ?? "";
  assert(/^Bearer\b/i.test(challenge), `${label}: Bearer challenge is missing`);
  assert(challenge.includes(`resource_metadata="${metadataUrl}"`),
    `${label}: resource_metadata challenge is missing or incorrect`);
  assert(challenge.includes('error="invalid_token"'),
    `${label}: invalid_token challenge is missing`);
}

/** @param {Response} response @param {number} expected @param {string} label */
async function assertStatus(response, expected, label) {
  if (response.status === expected) {
    return;
  }
  const body = (await response.clone().text()).slice(0, 240);
  throw new Error(`${label}: expected HTTP ${expected}, received ${response.status}${body === "" ? "" : ` (${body})`}`);
}

/** @param {Response} response @param {string} label */
async function jsonObject(response, label) {
  /** @type {unknown} */
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${label}: response is not valid JSON`);
  }
  const object = objectValue(value);
  assert(Object.keys(object).length > 0, `${label}: expected a JSON object`);
  return object;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {unknown} value @returns {string[]} */
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

/** @param {Response} response @param {string} name */
function headerTokens(response, name) {
  return (response.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** @param {string=} versionId @param {string=} workerName */
function versionOverrideHeaders(versionId, workerName) {
  const headers = new Headers();
  if (versionId === undefined || versionId === "") {
    return headers;
  }
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(versionId),
    "versionId must be a UUID");
  const name = workerName ?? "mycontext-mcp";
  assert(/^[a-z0-9-]+$/.test(name), "workerName contains unsupported characters");
  headers.set("cloudflare-workers-version-overrides", `${name}="${versionId}"`);
  return headers;
}

function randomClientOrigin() {
  return `https://${crypto.randomUUID()}.mcp-client.invalid`;
}

/** @param {string} value */
function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  assert((parsed.protocol === "https:" || parsed.protocol === "http:")
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === "",
  "baseUrl must be a canonical HTTP(S) origin without path, query, credentials, or fragment");
  return parsed.origin;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
