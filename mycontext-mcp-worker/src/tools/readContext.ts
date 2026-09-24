import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  parseBusinessKnowledgeSectionReference,
  toBusinessKnowledgeDocumentId
} from "../businessKnowledge.js";
import { MCP_SCOPE } from "../constants.js";
import {
  parseEditorKnowledgeSectionReference,
  toEditorKnowledgeDocumentId
} from "../editorKnowledge.js";
import {
  getBusinessKnowledgeSection,
  getDocument,
  getEditorKnowledgeSection,
  getEditingPlaybookContext,
  getMediaPlaybookContext,
  getPlanningPlaybookContext,
  type TidbClient
} from "../tidb.js";
import {
  getSkillContextDocument,
  SKILL_CONTEXT_IDS,
  type SkillContextId
} from "../skillContext.js";
import { buildTextToolResult } from "./textResult.js";

const DEFAULT_MAX_CHARS = 6_000;
const MAX_CHARS = 12_000;

const inputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(512)
    .describe(
      "Stable ID returned by search_personal_context. Copy it exactly; do not guess or rewrite it."
    ),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(MAX_CHARS)
    .default(DEFAULT_MAX_CHARS)
    .describe("Maximum characters for ordinary documents/sections: default 6000, maximum 12000. Canonical playbooks and analysis skills always return their complete validated context; this limit does not truncate them.")
});

export type ReadContextTarget =
  | { kind: "document"; id: string }
  | { kind: "skill-context"; id: string; skillId: SkillContextId }
  | { kind: "section"; id: string; documentId: string; sectionId: string };

export function registerReadContextTool(server: McpServer, client: TidbClient): void {
  server.registerTool(
    "read_context",
    {
      title: "Read personal context",
      description:
        "Read one personal-context result in detail. Only call this with an exact ID returned by search_personal_context. Returns Markdown in both text content and structuredContent.markdown. Canonical planning/editing/media playbooks and analysis skills are returned in full; other documents/sections honor maxChars and report truncatedOutput.",
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }] }
    },
    async ({ id, maxChars }) => {
      const target = resolveReadContextId(id);
      if (target === null) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Invalid context ID. Use the exact id returned by search_personal_context."
          }]
        };
      }

      if (target.kind === "skill-context") {
        const context = await getSkillContextDocument(client, target.skillId);
        if (context === null) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Context not found: ${target.id}` }]
          };
        }
        return buildTextToolResult(context.markdown, {
          context: {
            id: target.id,
            skillId: context.skill_id,
            title: context.title,
            source: "skill_context",
            contextChars: context.context_chars,
            returnedChars: context.markdown.length,
            markdownSha256: context.markdown_sha256,
            mergeVersion: context.merge_version,
            lastSyncedAt: context.last_synced_at,
            retrievalMode: "full_skill_and_reference",
            truncatedOutput: false
          }
        });
      }

      if (target.kind === "section") {
        // The section-reference regex only matches "business-knowledge:...#..." or
        // "editor-knowledge:...#...", so this prefix check is sufficient to route to the
        // correct backing table without widening ReadContextTarget's shape.
        if (target.id.startsWith("editor-knowledge:")) {
          const section = await getEditorKnowledgeSection(client, target.documentId, target.sectionId);
          if (section === null) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `Context not found: ${target.id}` }]
            };
          }
          const markdown = truncateText(section.markdown, maxChars);
          return buildTextToolResult(markdown, {
            context: {
              id: target.id,
              documentId: toEditorKnowledgeDocumentId(section.document_id),
              title: section.title,
              source: "editor_knowledge",
              headingPath: section.heading_path,
              contentLayer: section.content_layer,
              sourceLineStart: section.source_line_start,
              sourceLineEnd: section.source_line_end,
              relatedSourcePath: section.related_source_path,
              freshnessClass: section.freshness_class,
              contextChars: section.markdown.length,
              returnedChars: markdown.length,
              truncatedOutput: markdown.length < section.markdown.length
            }
          });
        }

        const section = await getBusinessKnowledgeSection(
          client,
          target.documentId,
          target.sectionId
        );
        if (section === null) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Context not found: ${target.id}` }]
          };
        }
        const markdown = truncateText(section.markdown, maxChars);
        return buildTextToolResult(markdown, {
          context: {
            id: target.id,
            documentId: toBusinessKnowledgeDocumentId(section.document_id),
            title: section.title,
            source: "business_knowledge",
            headingPath: section.heading_path,
            contentLayer: section.content_layer,
            sourceLineStart: section.source_line_start,
            sourceLineEnd: section.source_line_end,
            relatedSourcePath: section.related_source_path,
            freshnessClass: section.freshness_class,
            sourceKind: section.source_kind,
            ingestScope: section.ingest_scope,
            sourceDeclaredAt: section.source_declared_at,
            detailAvailable: section.detail_available,
            contextChars: section.markdown.length,
            returnedChars: markdown.length,
            truncatedOutput: markdown.length < section.markdown.length
          }
        });
      }

      // Search promises a whole-playbook fallback. Reuse the validated readers
      // directly: no generic 6k/12k slicing and no extra database/Notion lookup.
      const playbookReader = target.id === "editor-knowledge:kikaku-composition-playbook"
        ? getPlanningPlaybookContext
        : target.id === "editor-knowledge:henshu-editing-playbook"
          ? getEditingPlaybookContext
          : target.id === "editor-knowledge:knowhow-media-design"
            ? getMediaPlaybookContext
            : undefined;
      if (playbookReader !== undefined) {
        const context = await playbookReader(client);
        if (context === null) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Context not found: ${target.id}` }]
          };
        }
        const { markdown: _markdown, ...metadata } = context;
        return buildTextToolResult(context.markdown, {
          ...metadata,
          context: {
            id: target.id,
            title: context.title,
            source: "editor_knowledge",
            markdownSha256: context.markdown_sha256,
            lastSyncedAt: context.last_synced_at,
            contextChars: context.context_chars,
            returnedChars: context.markdown.length,
            retrievalMode: "full_playbook",
            truncatedOutput: false
          }
        });
      }

      const document = await getDocument(client, target.id);
      if (document === null) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Context not found: ${target.id}` }]
        };
      }
      const markdown = truncateText(document.markdown, maxChars);
      return buildTextToolResult(markdown, {
        context: {
          id: document.document_id,
          title: document.title,
          source: document.source,
          sourceId: document.source_id,
          markdownSha256: document.markdown_sha256,
          sourceKind: document.source_kind,
          ingestScope: document.ingest_scope,
          sourceDeclaredAt: document.source_declared_at,
          detailAvailable: document.detail_available,
          sourceTruncated: document.source_truncated,
          lastSyncedAt: document.last_synced_at,
          contextChars: document.markdown.length,
          returnedChars: markdown.length,
          truncatedOutput: markdown.length < document.markdown.length
        }
      });
    }
  );
}

export function resolveReadContextId(id: string): ReadContextTarget | null {
  if (id.startsWith("skill-context:")) {
    const skillId = id.slice("skill-context:".length);
    if (SKILL_CONTEXT_IDS.some((candidate) => candidate === skillId)) {
      return {
        kind: "skill-context",
        id,
        skillId: skillId as SkillContextId
      };
    }
    return null;
  }

  const parsedBusinessSection = parseBusinessKnowledgeSectionReference(id);
  if (parsedBusinessSection !== null) {
    return {
      kind: "section",
      id,
      documentId: parsedBusinessSection.documentId,
      sectionId: parsedBusinessSection.sectionId
    };
  }

  const parsedEditorSection = parseEditorKnowledgeSectionReference(id);
  if (parsedEditorSection !== null) {
    return {
      kind: "section",
      id,
      documentId: parsedEditorSection.documentId,
      sectionId: parsedEditorSection.sectionId
    };
  }

  if (/^(?:notion|editor-knowledge|business-knowledge):[^#\s]+$/u.test(id)) {
    return { kind: "document", id };
  }
  return null;
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}
