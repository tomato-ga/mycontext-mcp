import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  AUTHOR_STYLE_DOCUMENT_IDS,
  buildAuthorStyleDocumentUri,
  buildAuthorStyleSectionUri,
  toAuthorStyleDocumentId
} from "../authorStyle.js";
import {
  getAuthorStyleDocumentResource,
  getAuthorStyleSectionResource,
  listAuthorStyleResources,
  type TidbClient
} from "../tidb.js";

export const AUTHOR_STYLE_SECTION_URI_TEMPLATE =
  "mycontext://author-style/{documentId}/sections/{sectionId}";

export function registerAuthorStyleResources(server: McpServer, client: TidbClient): void {
  for (const documentId of AUTHOR_STYLE_DOCUMENT_IDS) {
    server.registerResource(
      `author-style-${documentId}`,
      buildAuthorStyleDocumentUri(documentId),
      {
        title: documentId === "ore-title-style"
          ? "ore title style guide (full source)"
          : "oreアカウント本文スタイル分析（全文）",
        description:
          "Audit-only full source. For normal generation/editing use get_author_style_context.",
        mimeType: "text/markdown"
      },
      async (requestedUri) => {
        const document = await getAuthorStyleDocumentResource(client, documentId);
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
              normalRetrievalTool: "get_author_style_context"
            }
          }]
        };
      }
    );
  }

  const template = new ResourceTemplate(AUTHOR_STYLE_SECTION_URI_TEMPLATE, {
    list: async () => {
      const sections = await listAuthorStyleResources(client);
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
    "author-style-section",
    template,
    {
      title: "Author style semantic section",
      description: "One complete delivery section from an active author-style revision.",
      mimeType: "text/markdown"
    },
    async (requestedUri, variables) => {
      const documentId = toAuthorStyleDocumentId(decodeVariable(variables.documentId, "documentId"));
      const sectionId = decodeVariable(variables.sectionId, "sectionId");
      if (requestedUri.toString() !== buildAuthorStyleSectionUri(documentId, sectionId)) {
        throw resourceNotFound(requestedUri.toString());
      }
      const section = await getAuthorStyleSectionResource(client, documentId, sectionId);
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
    throw new McpError(ErrorCode.InvalidParams, `Invalid author style resource ${name}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid author style resource ${name}`);
  }
}

function resourceNotFound(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
}
