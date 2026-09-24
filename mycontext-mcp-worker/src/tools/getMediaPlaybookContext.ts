import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MCP_SCOPE } from "../constants.js";
import {
  MediaPlaybookContextError,
  MediaPlaybookContextTooLargeError
} from "../mediaPlaybook.js";
import { getMediaPlaybookContext, type TidbClient } from "../tidb.js";
import { buildTextToolResult } from "./textResult.js";

export function registerGetMediaPlaybookContextTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "get_media_playbook_context",
    {
      title: "Get full media operations playbook context",
      description:
        "Use this first for media strategy, positioning, operating model, production workflow, KPI, distribution, or monetization questions. Returns the entire メディア運営プレイブック from its single TiDB record without truncation. Use search_personal_context afterward only for supporting examples or evidence.",
      inputSchema: z.object({}),
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
        const context = await getMediaPlaybookContext(client);
        if (context === null) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: "Media playbook not found: knowhow-media-design"
            }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return buildTextToolResult(context.markdown, metadata);
      } catch (error) {
        if (
          error instanceof MediaPlaybookContextError
          || error instanceof MediaPlaybookContextTooLargeError
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
