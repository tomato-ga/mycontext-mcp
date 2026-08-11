import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { registerPublicTools } from "../src/tools/register.js";
import type { TidbClient } from "../src/tidb.js";

describe("public MCP tool surface", () => {
  it("exposes focused conversational tools and removes duplicate/admin tools", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    const tidbClient: TidbClient = { execute: vi.fn() };
    registerPublicTools(server, tidbClient);
    const sdkClient = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await sdkClient.connect(clientTransport);
    try {
      const tools = await sdkClient.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "search_personal_context",
        "read_context",
        "get_planning_playbook_context",
        "get_editing_playbook_context",
        "get_media_playbook_context",
        "get_analysis_skill_context",
        "get_author_style_context",
        "search_author_style_evidence",
        "get_metaskill_context",
        "search_metaskill_evidence"
      ]);
      expect(tools.tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
        "search_text",
        "search_context",
        "get_document",
        "health_check",
        "list_documents"
      ]));
      expect(tools.tools.find((tool) => tool.name === "search_personal_context"))
        .toMatchObject({
          description: expect.stringContaining("call get_analysis_skill_context first"),
          inputSchema: {
            properties: {
              query: { maxLength: 300 },
              topK: { minimum: 1, maximum: 5, default: 3 }
            }
          }
        });
      expect(tools.tools.find((tool) => tool.name === "read_context"))
        .toMatchObject({
          inputSchema: {
            required: expect.arrayContaining(["id"])
          }
        });
      expect(tools.tools.find((tool) => tool.name === "get_planning_playbook_context"))
        .toMatchObject({
          description: expect.stringContaining("Use this first"),
          inputSchema: {
            properties: {}
          }
        });
      expect(tools.tools.find((tool) => tool.name === "get_editing_playbook_context"))
        .toMatchObject({
          description: expect.stringContaining("Use this first"),
          inputSchema: {
            properties: {}
          }
        });
      expect(tools.tools.find((tool) => tool.name === "get_media_playbook_context"))
        .toMatchObject({
          description: expect.stringContaining("single TiDB record"),
          inputSchema: {
            properties: {}
          }
        });
      expect(tools.tools.find((tool) => tool.name === "get_analysis_skill_context"))
        .toMatchObject({
          description: expect.stringContaining("lean canvas使って"),
          inputSchema: {
            required: ["skillId"],
            properties: {
              skillId: {
                enum: expect.arrayContaining([
                  "marketing-lean-canvas",
                  "resolution-diagnose",
                  "issue-driven-identify"
                ])
              }
            }
          }
        });
    } finally {
      await sdkClient.close();
      await server.close();
    }
  });
});
