type JsonObject = Record<string, unknown>;

export interface McpRequestInspection {
  methods: string[];
  toolName: string | null;
  includesToolsList: boolean;
}

/**
 * OpenAI Apps require OAuth security schemes on the top-level tool descriptor.
 * MCP SDK 1.29 keeps the same data only in `_meta`, so promote it in the
 * serialized tools/list response until the SDK exposes the field directly.
 */
export async function withOpenAiToolDescriptors(
  response: Response,
  enabled: boolean
): Promise<Response> {
  if (!enabled) {
    return response;
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (!promoteSecuritySchemes(payload)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export async function inspectMcpRequest(request: Request): Promise<McpRequestInspection> {
  if (request.method !== "POST" || !request.headers.get("content-type")?.includes("application/json")) {
    return { methods: [], toolName: null, includesToolsList: false };
  }

  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return { methods: [], toolName: null, includesToolsList: false };
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  const methods: string[] = [];
  let toolName: string | null = null;
  for (const item of requests) {
    if (!isObject(item)) continue;
    if (typeof item.method === "string") {
      methods.push(item.method);
    }
    if (
      item.method === "tools/call" &&
      isObject(item.params) &&
      typeof item.params.name === "string"
    ) {
      toolName = item.params.name;
    }
  }
  return {
    methods,
    toolName,
    includesToolsList: methods.includes("tools/list")
  };
}

export function promoteSecuritySchemes(payload: unknown): boolean {
  const responses = Array.isArray(payload) ? payload : [payload];
  let changed = false;

  for (const response of responses) {
    if (!isObject(response) || !isObject(response.result) || !Array.isArray(response.result.tools)) {
      continue;
    }

    for (const tool of response.result.tools) {
      if (!isObject(tool) || tool.securitySchemes !== undefined || !isObject(tool._meta)) {
        continue;
      }
      const schemes = tool._meta.securitySchemes;
      if (!Array.isArray(schemes)) {
        continue;
      }
      tool.securitySchemes = schemes;
      changed = true;
    }
  }

  return changed;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
