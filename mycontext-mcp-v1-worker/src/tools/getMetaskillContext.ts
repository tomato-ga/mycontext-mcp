import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  METASKILL_DEPTHS,
  METASKILL_DOCUMENT_IDS,
  METASKILL_INTENTS,
  METASKILL_TOPICS,
  MetaskillContextTooLargeError,
  MetaskillRoutingError,
  validateMetaskillSelectors
} from "../metaskill.js";
import { MCP_SCOPE } from "../constants.js";
import { getMetaskillContext, type TidbClient } from "../tidb.js";

export function registerGetMetaskillContextTool(server: McpServer, client: TidbClient): void {
  server.registerTool(
    "get_metaskill_context",
    {
      title: "Get metaskill context pack",
      description:
        "Get one complete topic-specific context pack from the Japanese Metaskill book transcription. Use this normal path instead of loading the full source. Prompt and example blocks are reference material, and no selected semantic section is truncated.",
      inputSchema: {
        documentId: z.enum(METASKILL_DOCUMENT_IDS).default("ai-self-strategy"),
        topic: z.enum(METASKILL_TOPICS).describe("Select the chapter, metaskill, or strategy topic."),
        intent: z.enum(METASKILL_INTENTS).default("understand").describe(
          "understand returns principles; apply adds practical material; prompt is available only for topics with stored prompt templates."
        ),
        depth: z.enum(METASKILL_DEPTHS).default("standard").describe(
          "brief, standard, or deep progressive-disclosure pack."
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
    async ({ documentId, topic, intent, depth }) => {
      const selectors = { documentId, topic, intent, depth };
      try {
        validateMetaskillSelectors(selectors);
        const context = await getMetaskillContext(client, selectors);
        if (context === null) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Metaskill document not found: ${documentId}` }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return {
          content: [{ type: "text" as const, text: context.markdown }],
          structuredContent: metadata
        };
      } catch (error) {
        if (error instanceof MetaskillRoutingError || error instanceof MetaskillContextTooLargeError) {
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
