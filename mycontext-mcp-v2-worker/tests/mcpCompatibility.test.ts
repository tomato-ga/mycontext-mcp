import { describe, expect, it } from "vitest";
import {
  inspectMcpRequest,
  promoteSecuritySchemes,
  withOpenAiToolDescriptors
} from "../src/mcpCompatibility.js";

describe("OpenAI tool descriptor compatibility", () => {
  it("promotes OAuth security schemes from _meta to tools/list descriptors", () => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [{
          name: "health_check",
          _meta: { securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }] }
        }]
      }
    };

    expect(promoteSecuritySchemes(payload)).toBe(true);
    expect(payload.result.tools[0]).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }]
    });
  });

  it("does not overwrite an SDK-provided top-level descriptor", () => {
    const payload = {
      result: {
        tools: [{
          name: "health_check",
          securitySchemes: [{ type: "noauth" }],
          _meta: { securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }] }
        }]
      }
    };

    expect(promoteSecuritySchemes(payload)).toBe(false);
    expect(payload.result.tools[0].securitySchemes).toEqual([{ type: "noauth" }]);
  });

  it("rewrites JSON responses and leaves other responses untouched", async () => {
    const response = new Response(JSON.stringify({
      result: {
        tools: [{
          name: "health_check",
          _meta: { securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }] }
        }]
      }
    }), { headers: { "content-type": "application/json" } });

    const rewritten = await withOpenAiToolDescriptors(response, true);
    await expect(rewritten.json()).resolves.toMatchObject({
      result: {
        tools: [{ securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }] }]
      }
    });

    const text = new Response("ok", { headers: { "content-type": "text/plain" } });
    expect(await withOpenAiToolDescriptors(text, true)).toBe(text);
  });

  it("does not parse or rewrite non-tools/list responses", async () => {
    const response = new Response(JSON.stringify({
      result: {
        tools: [{
          name: "health_check",
          _meta: { securitySchemes: [{ type: "oauth2", scopes: ["context:read"] }] }
        }]
      }
    }), { headers: { "content-type": "application/json" } });
    expect(await withOpenAiToolDescriptors(response, false)).toBe(response);
  });

  it("inspects tools/list and tools/call request metadata", async () => {
    await expect(inspectMcpRequest(new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    }))).resolves.toEqual({
      methods: ["tools/list"],
      toolName: null,
      includesToolsList: true
    });

    await expect(inspectMcpRequest(new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "search_personal_context", arguments: {} }
      })
    }))).resolves.toEqual({
      methods: ["tools/call"],
      toolName: "search_personal_context",
      includesToolsList: false
    });
  });
});
