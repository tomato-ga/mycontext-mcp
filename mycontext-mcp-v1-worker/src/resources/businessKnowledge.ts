import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUSINESS_KNOWLEDGE_DOCUMENT_IDS,
  buildBusinessKnowledgeDocumentUri,
  buildBusinessKnowledgeSectionUri,
  toBusinessKnowledgeDocumentId,
  type BusinessKnowledgeDocumentId
} from "../businessKnowledge.js";
import {
  getBusinessKnowledgeSection,
  getDocument,
  listBusinessKnowledgeResources,
  type TidbClient
} from "../tidb.js";

export const BUSINESS_KNOWLEDGE_SECTION_URI_TEMPLATE =
  "mycontext://business-knowledge/{documentId}/sections/{sectionId}";

const BUSINESS_KNOWLEDGE_DOCUMENT_TITLES: Record<BusinessKnowledgeDocumentId, string> = {
  "startup-science": "起業の科学",
  "marketing-wisdom": "Wisdom Evolution Marketing"
};

export function registerBusinessKnowledgeResources(server: McpServer, client: TidbClient): void {
  for (const documentId of BUSINESS_KNOWLEDGE_DOCUMENT_IDS) {
    const uri = buildBusinessKnowledgeDocumentUri(documentId);
    server.registerResource(
      `business-knowledge-${documentId}`,
      uri,
      {
        title: BUSINESS_KNOWLEDGE_DOCUMENT_TITLES[documentId],
        description: "Full source Markdown retained for audit and section regeneration.",
        mimeType: "text/markdown"
      },
      async (requestedUri) => {
        const document = await getDocument(client, toBusinessKnowledgeDocumentId(documentId));
        if (document === null || document.source !== "business_knowledge") {
          throw resourceNotFound(requestedUri.toString());
        }
        return {
          contents: [{
            uri: requestedUri.toString(),
            mimeType: "text/markdown",
            text: document.markdown,
            _meta: {
              documentId,
              markdownSha256: document.markdown_sha256,
              sectionRevisionSha256: document.section_revision_sha256,
              sourceKind: document.source_kind,
              ingestScope: document.ingest_scope,
              sourceDeclaredAt: document.source_declared_at,
              detailAvailable: document.detail_available
            }
          }]
        };
      }
    );
  }

  const template = new ResourceTemplate(
    BUSINESS_KNOWLEDGE_SECTION_URI_TEMPLATE,
    {
      list: async () => {
        const sections = await listBusinessKnowledgeResources(client);
        return {
          resources: sections.map((section) => ({
            uri: section.resource_uri,
            name: `${section.document_id}#${section.section_id}`,
            title: section.title,
            description: section.heading_path.join(" > "),
            mimeType: "text/markdown",
            size: section.size_bytes,
            _meta: {
              contentLayer: section.content_layer,
              relatedSourcePath: section.related_source_path,
              freshnessClass: section.freshness_class,
              sourceKind: section.source_kind,
              ingestScope: section.ingest_scope,
              sourceDeclaredAt: section.source_declared_at,
              detailAvailable: section.detail_available
            }
          }))
        };
      }
    }
  );

  server.registerResource(
    "business-knowledge-section",
    template,
    {
      title: "Business knowledge section",
      description: "A semantic section of business knowledge, addressable without loading the full source document.",
      mimeType: "text/markdown"
    },
    async (requestedUri, variables) => {
      const documentId = decodeVariable(variables.documentId, "documentId");
      const sectionId = decodeVariable(variables.sectionId, "sectionId");
      const expectedUri = buildBusinessKnowledgeSectionUri(documentId, sectionId);
      if (requestedUri.toString() !== expectedUri) {
        throw resourceNotFound(requestedUri.toString());
      }

      const section = await getBusinessKnowledgeSection(client, documentId, sectionId);
      if (section === null) {
        throw resourceNotFound(requestedUri.toString());
      }
      return {
        contents: [{
          uri: requestedUri.toString(),
          mimeType: "text/markdown",
          text: section.markdown,
          _meta: {
            documentId,
            sectionId,
            headingPath: section.heading_path,
            contentLayer: section.content_layer,
            sourceLineStart: section.source_line_start,
            sourceLineEnd: section.source_line_end,
            relatedSourcePath: section.related_source_path,
            freshnessClass: section.freshness_class,
            sourceKind: section.source_kind,
            ingestScope: section.ingest_scope,
            sourceDeclaredAt: section.source_declared_at,
            detailAvailable: section.detail_available
          }
        }]
      };
    }
  );
}

function decodeVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid business knowledge resource ${name}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid business knowledge resource ${name}`);
  }
}

function resourceNotFound(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
}
