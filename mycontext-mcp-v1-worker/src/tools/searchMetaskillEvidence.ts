import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { METASKILL_DOCUMENT_IDS } from "../metaskill.js";
import { MCP_SCOPE } from "../constants.js";
import {
  searchMetaskillEvidence,
  TopKValidationError,
  validateTopK,
  type TidbClient
} from "../tidb.js";

export function registerSearchMetaskillEvidenceTool(server: McpServer, client: TidbClient): void {
  server.registerTool(
    "search_metaskill_evidence",
    {
      title: "Search metaskill evidence",
      description:
        "Search fine-grained spans in the Metaskill transcription, then return each complete semantic delivery section. Use for a specific term, example, prompt, or supporting passage.",
      inputSchema: {
        documentId: z.enum(METASKILL_DOCUMENT_IDS).default("ai-self-strategy"),
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
        const hits = await searchMetaskillEvidence(client, documentId, query, limitedTopK);
        const metadata = hits.map(({ markdown: _markdown, ...hit }) => hit);
        const text = hits.length === 0
          ? `No metaskill evidence found for: ${query}`
          : hits.map((hit, index) => [
              `# Metaskill result ${index + 1}: ${hit.delivery_section_title}`,
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
