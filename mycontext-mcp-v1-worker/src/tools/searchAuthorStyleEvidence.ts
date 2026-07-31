import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AUTHOR_STYLE_DOCUMENT_IDS } from "../authorStyle.js";
import { MCP_SCOPE } from "../constants.js";
import {
  searchAuthorStyleEvidence,
  TopKValidationError,
  validateTopK,
  type TidbClient
} from "../tidb.js";

export function registerSearchAuthorStyleEvidenceTool(
  server: McpServer,
  client: TidbClient
): void {
  server.registerTool(
    "search_author_style_evidence",
    {
      title: "Search author style evidence",
      description:
        "Audit path for searching evidence, profile, and maintenance sections in ore's title/body style sources. Returns each complete semantic delivery section, not arbitrary text chunks.",
      inputSchema: {
        documentId: z.enum(AUTHOR_STYLE_DOCUMENT_IDS),
        query: z.string().trim().min(1).max(1_000),
        topK: z.number().optional().describe("Integer from 1 to 5; defaults to 3.")
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] }
    },
    async ({ documentId, query, topK }) => {
      try {
        const limitedTopK = validateTopK(topK ?? 3, 5);
        const hits = await searchAuthorStyleEvidence(client, documentId, query, limitedTopK);
        const metadata = hits.map(({ markdown: _markdown, ...hit }) => hit);
        const text = hits.length === 0
          ? `No author style evidence found for: ${query}`
          : hits.map((hit, index) => [
              `# Evidence result ${index + 1}: ${hit.delivery_section_title}`,
              "",
              `- matched: ${hit.matched_section_title}`,
              `- layer: ${hit.matched_content_layer}`,
              `- context-key: ${hit.delivery_context_key ?? "(none)"}`,
              `- resource: ${hit.resource_uri}`,
              "",
              hit.markdown
            ].join("\n")).join("\n\n---\n\n");
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { query, document_id: documentId, hits: metadata }
        };
      } catch (error) {
        if (error instanceof TopKValidationError) {
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
