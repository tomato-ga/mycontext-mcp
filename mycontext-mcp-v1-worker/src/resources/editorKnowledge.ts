import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildEditorKnowledgeDocumentUri,
  buildEditorKnowledgeSectionUri,
  toEditorKnowledgeDocumentId
} from "../editorKnowledge.js";
import {
  getDocument,
  getEditorKnowledgeSection,
  listEditorKnowledgeDocuments,
  listEditorKnowledgeResources,
  type TidbClient
} from "../tidb.js";

export const EDITOR_KNOWLEDGE_DOCUMENT_URI_TEMPLATE = "mycontext://editor-knowledge/{documentId}";
export const EDITOR_KNOWLEDGE_SECTION_URI_TEMPLATE =
  "mycontext://editor-knowledge/{documentId}/sections/{sectionId}";

export function registerEditorKnowledgeResources(server: McpServer, client: TidbClient): void {
  // A ResourceTemplate (not a fixed per-ID registerResource loop) so that any Editor Knowledge
  // document — including every kikaku-fulltext-* split, not just the two originally sectioned
  // documents — is listable and readable purely from what is in TiDB, with no code-level
  // allowlist to keep in sync as new documents are added.
  const documentTemplate = new ResourceTemplate(
    EDITOR_KNOWLEDGE_DOCUMENT_URI_TEMPLATE,
    {
      list: async () => {
        const documents = await listEditorKnowledgeDocuments(client);
        return {
          resources: documents.map((document) => ({
            uri: buildEditorKnowledgeDocumentUri(document.document_id),
            name: document.document_id,
            title: document.title,
            description: "Full source Markdown retained for audit and section regeneration.",
            mimeType: "text/markdown"
          }))
        };
      }
    }
  );

  server.registerResource(
    "editor-knowledge-document",
    documentTemplate,
    {
      title: "Editor knowledge document",
      description: "Full source Markdown retained for audit and section regeneration.",
      mimeType: "text/markdown"
    },
    async (requestedUri, variables) => {
      const documentId = decodeVariable(variables.documentId, "documentId");
      const expectedUri = buildEditorKnowledgeDocumentUri(documentId);
      if (requestedUri.toString() !== expectedUri) {
        throw resourceNotFound(requestedUri.toString());
      }

      const document = await getDocument(client, toEditorKnowledgeDocumentId(documentId));
      if (document === null || document.source !== "editor_knowledge") {
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
            sectionRevisionSha256: document.section_revision_sha256
          }
        }]
      };
    }
  );

  const template = new ResourceTemplate(
    EDITOR_KNOWLEDGE_SECTION_URI_TEMPLATE,
    {
      list: async () => {
        const sections = await listEditorKnowledgeResources(client);
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
              freshnessClass: section.freshness_class
            }
          }))
        };
      }
    }
  );

  server.registerResource(
    "editor-knowledge-section",
    template,
    {
      title: "Editor knowledge section",
      description: "A semantic section of editor knowledge, addressable without loading the full source document.",
      mimeType: "text/markdown"
    },
    async (requestedUri, variables) => {
      const documentId = decodeVariable(variables.documentId, "documentId");
      const sectionId = decodeVariable(variables.sectionId, "sectionId");
      const expectedUri = buildEditorKnowledgeSectionUri(documentId, sectionId);
      if (requestedUri.toString() !== expectedUri) {
        throw resourceNotFound(requestedUri.toString());
      }

      const section = await getEditorKnowledgeSection(client, documentId, sectionId);
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
            freshnessClass: section.freshness_class
          }
        }]
      };
    }
  );
}

function decodeVariable(value: string | string[] | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid editor knowledge resource ${name}`);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid editor knowledge resource ${name}`);
  }
}

function resourceNotFound(uri: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
}
