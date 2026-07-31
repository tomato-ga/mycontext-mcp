import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MCP_SCOPE } from "../constants.js";
import {
  getSkillContextDocument,
  SKILL_CONTEXT_IDS,
  SKILL_CONTEXT_SELECTION_GUIDE,
  SkillContextDataError
} from "../skillContext.js";
import type { TidbClient } from "../tidb.js";

const inputSchema = {
  skillId: z
    .enum(SKILL_CONTEXT_IDS)
    .describe(SKILL_CONTEXT_SELECTION_GUIDE)
};

export function registerGetAnalysisSkillContextTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "get_analysis_skill_context",
    {
      title: "Get analysis framework skill context",
      description:
        "Call this before answering whenever the user explicitly asks to use Lean Canvas, " +
        "リーンキャンバス, 解像度を上げる, or イシューからはじめよ methods. This includes phrases " +
        "such as 「lean canvas使って」「解像度を診断して」「イシューを特定して」. Select the " +
        "matching skillId and use the returned complete SKILL.md + reference.md context; do not " +
        "answer from general memory first. " +
        SKILL_CONTEXT_SELECTION_GUIDE,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] }
    },
    async ({ skillId }) => {
      try {
        const context = await getSkillContextDocument(client, skillId);
        if (context === null) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Analysis skill context not found: ${skillId}`
            }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return {
          content: [{ type: "text" as const, text: context.markdown }],
          structuredContent: {
            ...metadata,
            retrieval_mode: "full_skill_and_reference",
            truncated: false
          }
        };
      } catch (error) {
        if (error instanceof SkillContextDataError) {
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
