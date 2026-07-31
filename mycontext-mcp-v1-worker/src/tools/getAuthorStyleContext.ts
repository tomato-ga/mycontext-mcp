import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AUTHOR_STYLE_DOCUMENT_IDS,
  AUTHOR_STYLE_PROFILES,
  BODY_MODES,
  BODY_OPERATIONS,
  LENGTH_BANDS,
  TITLE_MODES,
  TITLE_OPERATIONS,
  AuthorStyleContextTooLargeError,
  AuthorStyleRoutingError,
  validateAuthorStyleSelectors
} from "../authorStyle.js";
import { MCP_SCOPE } from "../constants.js";
import { getAuthorStyleContext, type TidbClient } from "../tidb.js";

const allOperations = [...new Set([...TITLE_OPERATIONS, ...BODY_OPERATIONS])] as [
  string,
  ...string[]
];
const allModes = [...new Set([...TITLE_MODES, ...BODY_MODES])] as [string, ...string[]];

export function registerGetAuthorStyleContextTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "get_author_style_context",
    {
      title: "Get author style context pack",
      description:
        "Get one complete, selector-specific context pack for reproducing or evaluating ore's title/body style. Use this normal path instead of loading the full source document. No selected section is truncated.",
      inputSchema: {
        documentId: z.enum(AUTHOR_STYLE_DOCUMENT_IDS).describe(
          "ore-title-style for titles; ore-body-style for article bodies"
        ),
        operation: z.enum(allOperations).describe(
          "Title supports generate/evaluate. Body also supports edit-voice/edit-structure."
        ),
        mode: z.enum(allModes).describe(
          "Select the article/title archetype; valid values depend on documentId."
        ),
        lengthBand: z.enum(LENGTH_BANDS).optional().describe(
          "Required only for ore-body-style; omit for ore-title-style."
        ),
        profile: z.enum(AUTHOR_STYLE_PROFILES).default("neutral").describe(
          "media-specific is supported only for ore-body-style."
        )
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] }
    },
    async ({ documentId, operation, mode, lengthBand, profile }) => {
      const selectors = { documentId, operation, mode, lengthBand, profile };
      try {
        validateAuthorStyleSelectors(selectors);
        const context = await getAuthorStyleContext(client, selectors);
        if (context === null) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Author style not found: ${documentId}` }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return {
          content: [{ type: "text" as const, text: context.markdown }],
          structuredContent: metadata
        };
      } catch (error) {
        if (error instanceof AuthorStyleRoutingError || error instanceof AuthorStyleContextTooLargeError) {
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
