import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SCOPE } from "../constants.js";
import {
  PlanningPlaybookContextError,
  PlanningPlaybookContextTooLargeError
} from "../planningPlaybook.js";
import { getPlanningPlaybookContext, type TidbClient } from "../tidb.js";

export function registerGetPlanningPlaybookContextTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "get_planning_playbook_context",
    {
      title: "Get full planning playbook context",
      description:
        "Use this first, before search_personal_context, whenever creating, reviewing, or revising an article 企画案, 構成案, H2/H3見出し構成, or 本文構成. Returns the entire 企画構成プレイブック without truncation. After reading it, use search_personal_context only for supporting examples or evidence.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] }
    },
    async () => {
      try {
        const context = await getPlanningPlaybookContext(client);
        if (context === null) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "Planning playbook not found: kikaku-composition-playbook"
            }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return {
          content: [{ type: "text" as const, text: context.markdown }],
          structuredContent: metadata
        };
      } catch (error) {
        if (
          error instanceof PlanningPlaybookContextError
          || error instanceof PlanningPlaybookContextTooLargeError
        ) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: error.message }]
          };
        }
        throw error;
      }
    }
  );
}
