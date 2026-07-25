import fs from "node:fs/promises";
import path from "node:path";
import {
  BUSINESS_KNOWLEDGE_PARSER_VERSION,
  BUSINESS_KNOWLEDGE_SECTIONING_VERSION,
  assertStorageLimits,
  assertUniqueSectionIds,
  parseKikakuCatalog,
  parseKikakuFulltext,
  parseKikakuPlaybook,
  splitContentLines
} from "./businessKnowledge.js";
import { requireEnv } from "./config.js";
import { sha256 } from "./hash.js";
import { AppError, type EditorKnowledgeDocumentId } from "./types.js";

export interface EditorKnowledgeSource {
  documentId: EditorKnowledgeDocumentId;
  relativePath: string;
}

export interface LoadedEditorKnowledgeDocument {
  documentId: EditorKnowledgeDocumentId;
  title: string;
  markdown: string;
  markdownSha256: string;
}

export const EDITOR_KNOWLEDGE_SOURCES: readonly EditorKnowledgeSource[] = [
  { documentId: "overview", relativePath: "knowledge/editor-training-knowledge.md" },
  { documentId: "lesson-01", relativePath: "knowledge/editor-training/01-web-media-basics.md" },
  { documentId: "lesson-02", relativePath: "knowledge/editor-training/02-editorial-thinking.md" },
  { documentId: "lesson-03", relativePath: "knowledge/editor-training/03-planning-and-ideation.md" },
  { documentId: "lesson-04", relativePath: "knowledge/editor-training/04-editorial-work.md" },
  { documentId: "lesson-05", relativePath: "knowledge/editor-training/05-editorial-skills.md" },
  { documentId: "lesson-06", relativePath: "knowledge/editor-training/06-editorial-meeting.md" },
  { documentId: "lesson-07", relativePath: "knowledge/editor-training/07-editor-in-chief.md" }
];

/**
 * kikaku-composition-playbook, kikaku-db-catalog, and the kikaku-fulltext-* family are Editor
 * Knowledge documents (not Business Knowledge), but they need the "document + section table +
 * search span" shape that Business Knowledge already has. They are kept in a separate source
 * list from EDITOR_KNOWLEDGE_SOURCES (which stays a fixed 8-document, non-sectioned allowlist)
 * and are loaded through loadEditorKnowledgeSectionedDocument below, which reuses the Business
 * Knowledge parsers/validators unchanged. kikaku-fulltext-* is an open-ended family (one
 * document per split of the full-text collection) rather than a single fixed ID, so it is
 * modeled as a template literal type instead of a third literal alternative.
 */
export type EditorKnowledgeSectionedDocumentId =
  | "kikaku-composition-playbook"
  | "kikaku-db-catalog"
  | `kikaku-fulltext-${string}`;

export interface EditorKnowledgeSectionedSource {
  documentId: EditorKnowledgeSectionedDocumentId;
  relativePath: string;
}

/**
 * Empty: kikaku-composition-playbook and kikaku-db-catalog are no longer synced from local
 * files. Per the "every document syncs through the Notion MyContext Documents database" rule,
 * they are Notion-managed pages with Category "Editor Knowledge", synced by
 * mycontext-sync-worker via parseEditorKnowledgeSectionedMarkdown below (the same pattern
 * Author Style already uses: mycontext-sync-worker imports the parser directly rather than
 * this package's file-loading CLI path). This list, and loadEditorKnowledgeSectionedDocument,
 * are kept only as reusable local-testing infrastructure over the same parsers/section
 * generation/TiDB schema — pull-editor-knowledge and doctor-editor-knowledge simply iterate
 * zero sectioned sources now.
 */
export const EDITOR_KNOWLEDGE_SECTIONED_SOURCES: readonly EditorKnowledgeSectionedSource[] = [];

export function isEditorKnowledgeSectionedDocumentId(
  value: string
): value is EditorKnowledgeSectionedDocumentId {
  return value === "kikaku-composition-playbook"
    || value === "kikaku-db-catalog"
    || value.startsWith("kikaku-fulltext-");
}

export type EditorKnowledgeContentLayer = "summary" | "detail" | "index";

export interface EditorKnowledgeSection {
  documentId: EditorKnowledgeSectionedDocumentId;
  sectionId: string;
  sectionRevisionSha256: string;
  parentSectionId: string | null;
  deliverySectionId: string;
  sectionType: "markdown_heading" | "numbered_section";
  headingLevel: number | null;
  sectionNumber: string | null;
  title: string;
  headingPath: string[];
  contentLayer: EditorKnowledgeContentLayer;
  ordinal: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  directMarkdown: string;
  sectionMarkdown: string;
  retrievalText: string;
  contentSha256: string;
  isSearchable: boolean;
  relatedSourcePath: string | null;
  freshnessClass: "static_framework" | "dated_example" | "time_sensitive";
}

export interface LoadedEditorKnowledgeSectionedDocument {
  documentId: EditorKnowledgeSectionedDocumentId;
  title: string;
  sourcePathKey: string;
  markdown: string;
  markdownSha256: string;
  sectionRevisionSha256: string;
  sectionCount: number;
  searchSpanCount: number;
  sections: EditorKnowledgeSection[];
}

export function editorKnowledgeSourceRootFromEnv(): string {
  const sourceRoot = requireEnv("EDITOR_KNOWLEDGE_SOURCE_ROOT");
  if (!path.isAbsolute(sourceRoot)) {
    throw new AppError(
      "invalid_editor_knowledge_source_root",
      "EDITOR_KNOWLEDGE_SOURCE_ROOT must be an absolute path",
      3
    );
  }
  return path.resolve(sourceRoot);
}

async function readEditorKnowledgeSourceFile(
  sourceRoot: string,
  source: { documentId: string; relativePath: string }
): Promise<{ markdown: string; bytes: Buffer }> {
  const absoluteRoot = path.resolve(sourceRoot);
  const sourcePath = path.resolve(absoluteRoot, source.relativePath);
  if (!sourcePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new AppError(
      "editor_knowledge_path_escape",
      `source path escapes configured root for ${source.documentId}`,
      3
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch (error) {
    throw new AppError(
      "editor_knowledge_read_failed",
      `failed to read editor knowledge source: ${source.documentId}`,
      3,
      error
    );
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new AppError(
      "editor_knowledge_invalid_utf8",
      `editor knowledge source is not valid UTF-8: ${source.documentId}`,
      3,
      error
    );
  }

  if (markdown.trim().length === 0 || markdown.includes("\0")) {
    throw new AppError(
      "editor_knowledge_invalid_markdown",
      `editor knowledge source is empty or contains NUL: ${source.documentId}`,
      3
    );
  }

  return { markdown, bytes };
}

export async function loadEditorKnowledgeDocument(
  sourceRoot: string,
  source: EditorKnowledgeSource
): Promise<LoadedEditorKnowledgeDocument> {
  const { markdown } = await readEditorKnowledgeSourceFile(sourceRoot, source);
  const title = extractMarkdownTitle(markdown, source.documentId);
  return {
    documentId: source.documentId,
    title,
    markdown,
    markdownSha256: sha256(markdown)
  };
}

export interface EditorKnowledgeSectionedMarkdownInput {
  documentId: EditorKnowledgeSectionedDocumentId;
  markdown: string;
  sourcePathKey: string;
}

/**
 * Core text-based parser: takes already-fetched Markdown directly (no file I/O), so it works
 * equally for a local file's contents (see loadEditorKnowledgeSectionedDocument below, a thin
 * wrapper around this) and for Markdown fetched from a Notion page by mycontext-sync-worker
 * (see sync.ts's defaultParseEditorKnowledge, which mirrors authorStyle.ts's
 * parseAuthorStyleMarkdown / loadAuthorStyleDocument split exactly).
 */
export function parseEditorKnowledgeSectionedMarkdown(
  input: EditorKnowledgeSectionedMarkdownInput
): LoadedEditorKnowledgeSectionedDocument {
  const { documentId, markdown, sourcePathKey } = input;
  if (markdown.trim().length === 0 || markdown.includes("\0")) {
    throw new AppError(
      "editor_knowledge_invalid_markdown",
      `editor knowledge source is empty or contains NUL: ${documentId}`,
      3
    );
  }

  const title = extractMarkdownTitle(markdown, documentId);
  const normalizedForParsing = markdown.replace(/\r\n/g, "\n");
  const lines = splitContentLines(normalizedForParsing);
  const markdownSha256 = sha256(markdown);
  const sectionRevisionSha256 = sha256(
    `${markdownSha256}\0${BUSINESS_KNOWLEDGE_PARSER_VERSION}\0${BUSINESS_KNOWLEDGE_SECTIONING_VERSION}`
  );

  const parsed = documentId === "kikaku-composition-playbook"
    ? parseKikakuPlaybook(title, lines)
    : documentId === "kikaku-db-catalog"
      ? parseKikakuCatalog(title, lines)
      : parseKikakuFulltext(title, lines);
  const sections: EditorKnowledgeSection[] = parsed.sections.map((section, index) => ({
    ...section,
    documentId,
    sectionRevisionSha256,
    ordinal: index + 1,
    contentSha256: sha256(section.sectionMarkdown)
  }));

  assertStorageLimits(markdown, sections);
  assertUniqueSectionIds(sections);

  const searchSpanCount = sections.filter((section) => section.isSearchable).length;
  return {
    documentId,
    title,
    sourcePathKey,
    markdown,
    markdownSha256,
    sectionRevisionSha256,
    sectionCount: sections.length,
    searchSpanCount,
    sections
  };
}

export async function loadEditorKnowledgeSectionedDocument(
  sourceRoot: string,
  source: EditorKnowledgeSectionedSource
): Promise<LoadedEditorKnowledgeSectionedDocument> {
  const { markdown } = await readEditorKnowledgeSourceFile(sourceRoot, source);
  return parseEditorKnowledgeSectionedMarkdown({
    documentId: source.documentId,
    markdown,
    sourcePathKey: source.relativePath
  });
}

function extractMarkdownTitle(markdown: string, documentId: string): string {
  const firstLine = markdown.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const match = /^#\s+(.+)$/.exec(firstLine);
  const title = match?.[1]?.trim() ?? "";
  if (title.length === 0) {
    throw new AppError(
      "editor_knowledge_title_missing",
      `editor knowledge source must start with an H1 title: ${documentId}`,
      3
    );
  }
  return title;
}
