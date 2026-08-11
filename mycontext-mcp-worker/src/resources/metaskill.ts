import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer
} from "@modelcontextprotocol/server";
import {
  MetaskillRoutingError,
  METASKILL_DOCUMENT_IDS,
  buildMetaskillDocumentUri,
  buildMetaskillSectionUri,
  toMetaskillDocumentId,
  type MetaskillDocumentId
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
      const uri = requestedUri.toString();
      const documentId = toResourceDocumentId(
        decodeVariable(variables.documentId, "documentId"),
        uri
      );
      const sectionId = decodeVariable(variables.sectionId, "sectionId");
      if (uri !== buildMetaskillSectionUri(documentId, sectionId)) {
        throw resourceNotFound(uri);
      }
      const section = await getMetaskillSectionResource(client, documentId, sectionId);
      if (section === null) throw resourceNotFound(uri);
      return {
        contents: [{
          uri,
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

function toResourceDocumentId(value: string, uri: string): MetaskillDocumentId {
  try {
    return toMetaskillDocumentId(value);
  } catch (error) {
    if (error instanceof MetaskillRoutingError) {
      throw resourceNotFound(uri);
    }
    throw error;
  }
}

function decodeVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid metaskill resource ${name}`
    );
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Invalid metaskill resource ${name}`
    );
  }
}

function resourceNotFound(uri: string): ResourceNotFoundError {
  return new ResourceNotFoundError(uri);
}
