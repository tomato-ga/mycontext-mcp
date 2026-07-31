import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_SCOPE } from "../constants.js";
import {
  EditingPlaybookContextError,
  EditingPlaybookContextTooLargeError
} from "../editingPlaybook.js";
import { getEditingPlaybookContext, type TidbClient } from "../tidb.js";

export function registerGetEditingPlaybookContextTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "get_editing_playbook_context",
    {
      title: "Get full editing playbook context",
      description:
        "Use this first, before search_personal_context, whenever editing, reviewing, red-lining, or deciding whether to publish a completed draft (原稿の編集, 赤入れ, 校正・校閲, 公開前チェック, リライト). Returns the entire 編集プレイブック from its single TiDB record without truncation. For designing a new 企画案 or 構成案 use get_planning_playbook_context instead; after reading this playbook, use search_personal_context only for supporting examples or evidence.",
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
        const context = await getEditingPlaybookContext(client);
        if (context === null) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "Editing playbook not found: henshu-editing-playbook"
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
          error instanceof EditingPlaybookContextError
          || error instanceof EditingPlaybookContextTooLargeError
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
