import type {
  AuthorStyleSection,
  LoadedAuthorStyleDocument
} from "./authorStyle.js";
import type {
  AuthorStyleDocumentRow,
  AuthorStyleSectionRow
} from "./tidb.js";

export interface AuthorStyleNotionPreflightResult {
  status: "exact_match" | "content_change_required";
  ownership_change_only: boolean;
  source_markdown_matches: boolean;
  context_matches: boolean;
  ai_read_model_matches: boolean;
  notion_context_sha256: string;
  tidb_context_sha256: string;
  notion_source_markdown_sha256: string;
  tidb_source_markdown_sha256: string;
  notion_sections: number;
  tidb_sections: number;
  missing_section_ids: string[];
  extra_section_ids: string[];
  changed_section_ids: string[];
}

export function compareAuthorStyleNotionMigration(input: {
  notion: LoadedAuthorStyleDocument;
  tidbDocument: AuthorStyleDocumentRow;
  tidbSections: AuthorStyleSectionRow[];
}): AuthorStyleNotionPreflightResult {
  const tidbById = new Map(input.tidbSections.map((section) => [section.section_id, section]));
  const notionById = new Map(input.notion.sections.map((section) => [section.sectionId, section]));
  const missingSectionIds = [...tidbById.keys()].filter((id) => !notionById.has(id)).sort();
  const extraSectionIds = [...notionById.keys()].filter((id) => !tidbById.has(id)).sort();
  const changedSectionIds = input.notion.sections
    .filter((section) => {
      const stored = tidbById.get(section.sectionId);
      return stored !== undefined && !sectionMatches(section, stored);
    })
    .map((section) => section.sectionId)
    .sort();
  const sourceMarkdownMatches = input.notion.sourceMarkdownSha256
    === input.tidbDocument.source_markdown_sha256;
  const contextMatches = input.notion.revisionSha256 === input.tidbDocument.context_sha256;
  const aiReadModelMatches = missingSectionIds.length === 0
    && extraSectionIds.length === 0
    && changedSectionIds.length === 0;
  const ownershipChangeOnly = sourceMarkdownMatches && contextMatches && aiReadModelMatches;

  return {
    status: ownershipChangeOnly ? "exact_match" : "content_change_required",
    ownership_change_only: ownershipChangeOnly,
    source_markdown_matches: sourceMarkdownMatches,
    context_matches: contextMatches,
    ai_read_model_matches: aiReadModelMatches,
    notion_context_sha256: input.notion.revisionSha256,
    tidb_context_sha256: input.tidbDocument.context_sha256,
    notion_source_markdown_sha256: input.notion.sourceMarkdownSha256,
    tidb_source_markdown_sha256: input.tidbDocument.source_markdown_sha256,
    notion_sections: input.notion.sections.length,
    tidb_sections: input.tidbSections.length,
    missing_section_ids: missingSectionIds,
    extra_section_ids: extraSectionIds,
    changed_section_ids: changedSectionIds
  };
}

function sectionMatches(
  notion: AuthorStyleSection,
  tidb: AuthorStyleSectionRow
): boolean {
  return notion.contextKey === tidb.context_key
    && notion.parentSectionId === tidb.parent_section_id
    && notion.deliverySectionId === tidb.delivery_section_id
    && notion.sectionType === tidb.section_type
    && notion.contentLayer === tidb.content_layer
    && notion.contextPriority === Number(tidb.context_priority)
    && notion.headingLevel === nullableNumber(tidb.heading_level)
    && notion.title === tidb.title
    && JSON.stringify(notion.headingPath) === JSON.stringify(jsonStringArray(tidb.heading_path_json))
    && JSON.stringify(notion.aliases) === JSON.stringify(jsonStringArray(tidb.aliases_json))
    && notion.ordinal === Number(tidb.ordinal)
    && notion.sourceLineStart === Number(tidb.source_line_start)
    && notion.sourceLineEnd === Number(tidb.source_line_end)
    && notion.contentChars === Number(tidb.content_chars)
    && notion.estimatedTokens === nullableNumber(tidb.estimated_tokens)
    && notion.directMarkdown === tidb.direct_markdown
    && notion.deliveryMarkdown === tidb.delivery_markdown
    && notion.retrievalText === tidb.retrieval_text
    && notion.contentSha256 === tidb.content_sha256
    && notion.isSearchable === booleanLike(tidb.is_searchable);
}

function jsonStringArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : JSON.parse(value) as string[];
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function booleanLike(value: number | boolean): boolean {
  return value === true || value === 1;
}
