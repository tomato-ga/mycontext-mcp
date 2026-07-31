import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  METASKILL_DOCUMENT_IDS,
  buildMetaskillDocumentUri,
  buildMetaskillSectionUri,
  toMetaskillDocumentId
} from "../metaskill.js";
import {
  getMetaskillDocumentResource,
  getMetaskillSectionResource,
  listMetaskillResources,
  type TidbClient
} from "../tidb.js";

export const METASKILL_SECTION_URI_TEMPLATE =
  "mycontext://metaskill/{documentId}/sections/{sectionId}";

export function registerMetaskillResources(server: McpServer, client: TidbClient): void {
  for (const documentId of METASKILL_DOCUMENT_IDS) {
    server.registerResource(
      `metaskill-${documentId}`,
      buildMetaskillDocumentUri(documentId),
      {
        title: "メタスキル 努力の価値が変わる時代の『AI×自分』戦略（全文）",
        description: "Audit-only full OCR transcription. For normal work use get_metaskill_context.",
        mimeType: "text/markdown"
      },
      async (requestedUri) => {
        const document = await getMetaskillDocumentResource(client, documentId);
        if (document === null) throw resourceNotFound(requestedUri.toString());
        return {
          contents: [{
            uri: requestedUri.toString(),
            mimeType: "text/markdown",
            text: document.markdown,
            _meta: {
              documentId: document.document_id,
              displayName: document.display_name,
              revisionSha256: document.revision_sha256,
              sourceMarkdownSha256: document.source_markdown_sha256,
              normalRetrievalTool: "get_metaskill_context"
            }
          }]
        };
      }
    );
  }

  const template = new ResourceTemplate(METASKILL_SECTION_URI_TEMPLATE, {
    list: async () => {
      const sections = await listMetaskillResources(client);
      return {
        resources: sections.map((section) => ({
          uri: section.resource_uri,
          name: `${section.document_id}#${section.section_id}`,
          title: section.title,
          description: `${section.context_key} — ${section.heading_path.join(" > ")}`,
          mimeType: "text/markdown",
          size: section.size_bytes,
          _meta: {
            documentId: section.document_id,
            revisionSha256: section.revision_sha256,
            contextKey: section.context_key,
            contentLayer: section.content_layer
          }
        }))
      };
    }
  });

  server.registerResource(
    "metaskill-section",
    template,
    {
      title: "Metaskill semantic section",
      description: "One complete delivery section from the active metaskill revision.",
      mimeType: "text/markdown"
    },
    async (requestedUri, variables) => {
      const documentId = toMetaskillDocumentId(decodeVariable(variables.documentId, "documentId"));
      const sectionId = decodeVariable(variables.sectionId, "sectionId");
      if (requestedUri.toString() !== buildMetaskillSectionUri(documentId, sectionId)) {
        throw resourceNotFound(requestedUri.toString());
      }
      const section = await getMetaskillSectionResource(client, documentId, sectionId);
      if (section === null) throw resourceNotFound(requestedUri.toString());
      return {
        contents: [{
          uri: requestedUri.toString(),
          mimeType: "text/markdown",
          text: section.markdown,
          _meta: {
            documentId: section.document_id,
            revisionSha256: section.revision_sha256,
            sectionId: section.section_id,
            contextKey: section.context_key,
            headingPath: section.heading_path,
            contentLayer: section.content_layer,
            sourceLineStart: section.source_line_start,
            sourceLineEnd: section.source_line_end
          }
        }]
      };
    }
  );
}

function decodeVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid metaskill resource ${name}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid metaskill resource ${name}`);
  }
}

function resourceNotFound(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
}
