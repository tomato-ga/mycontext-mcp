import fs from "node:fs/promises";
import path from "node:path";
import { requireEnv } from "./config.js";
import { sha256 } from "./hash.js";
import { AppError } from "./types.js";

export const BUSINESS_KNOWLEDGE_PARSER_VERSION = "section-parser-v1";
export const BUSINESS_KNOWLEDGE_SECTIONING_VERSION = "section-first-v1";

const MEDIUMTEXT_MAX_BYTES = 16_777_215;

export const BUSINESS_KNOWLEDGE_DOCUMENT_IDS = [
  "startup-science",
  "marketing-wisdom"
] as const;

export type BusinessKnowledgeDocumentId = typeof BUSINESS_KNOWLEDGE_DOCUMENT_IDS[number];
export type BusinessKnowledgeContentLayer = "summary" | "detail" | "index";

export interface BusinessKnowledgeSource {
  documentId: BusinessKnowledgeDocumentId;
  relativePath: string;
  sourceKind: "book_summary" | "web_export_index";
  ingestScope: "full_summary" | "index_only";
  sourceDeclaredAt: string | null;
}

export interface BusinessKnowledgeSection {
  documentId: BusinessKnowledgeDocumentId;
  sectionId: string;
  sectionRevisionSha256: string;
  parentSectionId: string | null;
  deliverySectionId: string;
  sectionType: "markdown_heading" | "numbered_section";
  headingLevel: number | null;
  sectionNumber: string | null;
  title: string;
  headingPath: string[];
  contentLayer: BusinessKnowledgeContentLayer;
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

export interface LoadedBusinessKnowledgeDocument {
  documentId: BusinessKnowledgeDocumentId;
  title: string;
  sourcePathKey: string;
  sourceKind: BusinessKnowledgeSource["sourceKind"];
  ingestScope: BusinessKnowledgeSource["ingestScope"];
  sourceDeclaredAt: string | null;
  sourceBytes: number;
  sourceLineCount: number;
  sourceMtimeMs: number;
  markdown: string;
  markdownSha256: string;
  sectionRevisionSha256: string;
  parserVersion: string;
  sectioningVersion: string;
  sectionCount: number;
  searchSpanCount: number;
  outline: Record<string, unknown>;
  routingMetadata: Record<string, unknown>;
  sections: BusinessKnowledgeSection[];
}

export interface ParsedSectionInput extends Omit<
  BusinessKnowledgeSection,
  "documentId" | "sectionRevisionSha256" | "ordinal" | "contentSha256"
> {}

export interface ParsedDocumentSections {
  sections: ParsedSectionInput[];
  outline: Record<string, unknown>;
  routingMetadata: Record<string, unknown>;
}

interface MarkdownHeading {
  level: number;
  title: string;
  line: number;
}

export const BUSINESS_KNOWLEDGE_SOURCES: readonly BusinessKnowledgeSource[] = [
  {
    documentId: "startup-science",
    relativePath: "startup-science/startup-science-summary.md",
    sourceKind: "book_summary",
    ingestScope: "full_summary",
    sourceDeclaredAt: null
  },
  {
    documentId: "marketing-wisdom",
    relativePath: "marketing-wisdom/wisdom-evolution-marketing-summary.md",
    sourceKind: "web_export_index",
    ingestScope: "index_only",
    sourceDeclaredAt: "2026-02-20"
  }
];

const STARTUP_CHAPTERS = [
  { key: "overview", title: "総論", start: 1, end: 1 },
  { key: "idea-verification", title: "第1章 IDEA VERIFICATION", start: 2, end: 13 },
  { key: "customer-problem-fit", title: "第2章 CUSTOMER PROBLEM FIT", start: 14, end: 20 },
  { key: "problem-solution-fit", title: "第3章 PROBLEM SOLUTION FIT", start: 21, end: 26 },
  { key: "product-market-fit", title: "第4章 PRODUCT MARKET FIT", start: 27, end: 34 },
  { key: "transition-to-scale", title: "第5章 TRANSITION TO SCALE", start: 35, end: 40 },
  { key: "appendix", title: "付録", start: 41, end: 45 }
] as const;

const MARKETING_CATEGORIES = [
  { key: "theory-frameworks", title: "理論・フレームワーク編", start: 1, end: 15, path: "sections/01-who-what-how.md" },
  { key: "ai-era", title: "AI時代編", start: 16, end: 29, path: "sections/10-ai-agent-aeo.md" },
  { key: "case-practice", title: "ケーススタディ・実践編", start: 30, end: 36, path: "sections/11-case-studies.md" },
  { key: "appendix", title: "付録", start: 37, end: 45, path: "sections/12-appendix.md" }
] as const;

export function businessKnowledgeSourceRootFromEnv(): string {
  const sourceRoot = requireEnv("BUSINESS_KNOWLEDGE_SOURCE_ROOT");
  if (!path.isAbsolute(sourceRoot)) {
    throw new AppError(
      "invalid_business_knowledge_source_root",
      "BUSINESS_KNOWLEDGE_SOURCE_ROOT must be an absolute path",
      3
    );
  }
  return path.resolve(sourceRoot);
}

export async function loadBusinessKnowledgeDocument(
  sourceRoot: string,
  source: BusinessKnowledgeSource
): Promise<LoadedBusinessKnowledgeDocument> {
  const absoluteRoot = path.resolve(sourceRoot);
  const sourcePath = path.resolve(absoluteRoot, source.relativePath);
  const relative = path.relative(absoluteRoot, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(
      "business_knowledge_path_escape",
      `source path escapes configured root for ${source.documentId}`,
      3
    );
  }

  let bytes: Buffer;
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [bytes, stat] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
  } catch (error) {
    throw new AppError(
      "business_knowledge_read_failed",
      `failed to read business knowledge source: ${source.documentId}`,
      3,
      error
    );
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new AppError(
      "business_knowledge_invalid_utf8",
      `business knowledge source is not valid UTF-8: ${source.documentId}`,
      3,
      error
    );
  }
  if (markdown.trim().length === 0 || markdown.includes("\0")) {
    throw new AppError(
      "business_knowledge_invalid_markdown",
      `business knowledge source is empty or contains NUL: ${source.documentId}`,
      3
    );
  }

  const title = extractMarkdownTitle(markdown, source.documentId);
  const normalizedForParsing = markdown.replace(/\r\n/g, "\n");
  const lines = splitContentLines(normalizedForParsing);
  const markdownSha256 = sha256(markdown);
  const sectionRevisionSha256 = sha256(
    `${markdownSha256}\0${BUSINESS_KNOWLEDGE_PARSER_VERSION}\0${BUSINESS_KNOWLEDGE_SECTIONING_VERSION}`
  );
  const parsed = source.documentId === "startup-science"
    ? parseStartupScience(title, lines)
    : parseMarketingWisdom(title, lines);
  const sections = parsed.sections.map((section, index) => ({
    ...section,
    documentId: source.documentId,
    sectionRevisionSha256,
    ordinal: index + 1,
    contentSha256: sha256(section.sectionMarkdown)
  }));

  assertStorageLimits(markdown, sections);

  const expectedSectionCount = source.documentId === "startup-science" ? 279 : 46;
  const expectedSearchSpanCount = source.documentId === "startup-science" ? 241 : 46;
  const searchSpanCount = sections.filter((section) => section.isSearchable).length;
  if (sections.length !== expectedSectionCount || searchSpanCount !== expectedSearchSpanCount) {
    throw new AppError(
      "business_knowledge_section_contract_mismatch",
      `${source.documentId} expected ${expectedSectionCount}/${expectedSearchSpanCount} sections/search spans, got ${sections.length}/${searchSpanCount}`,
      3
    );
  }

  assertUniqueSectionIds(sections);
  return {
    documentId: source.documentId,
    title,
    sourcePathKey: source.relativePath,
    sourceKind: source.sourceKind,
    ingestScope: source.ingestScope,
    sourceDeclaredAt: source.sourceDeclaredAt,
    sourceBytes: bytes.byteLength,
    sourceLineCount: lines.length,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    markdown,
    markdownSha256,
    sectionRevisionSha256,
    parserVersion: BUSINESS_KNOWLEDGE_PARSER_VERSION,
    sectioningVersion: BUSINESS_KNOWLEDGE_SECTIONING_VERSION,
    sectionCount: sections.length,
    searchSpanCount,
    outline: parsed.outline,
    routingMetadata: parsed.routingMetadata,
    sections
  };
}

function parseStartupScience(documentTitle: string, lines: string[]): ParsedDocumentSections {
  const headings = scanMarkdownHeadings(lines);
  const h2s = headings.filter((heading) => heading.level === 2);
  const keyPointsHeading = requireHeading(h2s, "起業の科学の最重要ポイント");
  const outlineHeading = requireHeading(h2s, "目次");
  const keyPointHeadings = h2s.filter((heading) => {
    return heading.line > keyPointsHeading.line
      && heading.line < outlineHeading.line
      && /^\d+\)\s/.test(heading.title);
  });
  const detailHeadings = h2s.filter((heading) => {
    return heading.line > outlineHeading.line && /^\d+\.\s/.test(heading.title);
  });
  assertNumberedHeadings(keyPointHeadings, /^(\d+)\)\s/, 45, "startup key points");
  assertNumberedHeadings(detailHeadings, /^(\d+)\.\s/, 45, "startup details");

  const sections: ParsedSectionInput[] = [];
  for (let index = 0; index < keyPointHeadings.length; index += 1) {
    const heading = keyPointHeadings[index];
    const nextLine = keyPointHeadings[index + 1]?.line ?? outlineHeading.line;
    const number = Number(/^(\d+)\)/.exec(heading.title)?.[1]);
    const markdown = sliceLines(lines, heading.line, nextLine - 1);
    const sectionId = `key-point-${twoDigits(number)}`;
    const headingPath = [documentTitle, "起業の科学の最重要ポイント", heading.title];
    sections.push({
      sectionId,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "markdown_heading",
      headingLevel: 2,
      sectionNumber: String(number),
      title: heading.title,
      headingPath,
      contentLayer: "summary",
      sourceLineStart: heading.line,
      sourceLineEnd: nextLine - 1,
      directMarkdown: markdown,
      sectionMarkdown: markdown,
      retrievalText: contextualize(headingPath, markdown),
      isSearchable: true,
      relatedSourcePath: null,
      freshnessClass: "static_framework"
    });
  }

  for (let index = 0; index < detailHeadings.length; index += 1) {
    const heading = detailHeadings[index];
    const nextLine = detailHeadings[index + 1]?.line ?? lines.length + 1;
    const number = Number(/^(\d+)\./.exec(heading.title)?.[1]);
    const chapter = chapterForStartupSection(number);
    const parentId = `detail-${twoDigits(number)}`;
    const childHeadings = headings.filter((candidate) => {
      return candidate.level === 3 && candidate.line > heading.line && candidate.line < nextLine;
    });
    const directEnd = childHeadings[0]?.line ? childHeadings[0].line - 1 : nextLine - 1;
    const directMarkdown = sliceLines(lines, heading.line, directEnd);
    const sectionMarkdown = sliceLines(lines, heading.line, nextLine - 1);
    const headingPath = [documentTitle, chapter.title, heading.title];
    const hasDirectBody = hasMeaningfulBody(directMarkdown);
    sections.push({
      sectionId: parentId,
      parentSectionId: null,
      deliverySectionId: parentId,
      sectionType: "markdown_heading",
      headingLevel: 2,
      sectionNumber: String(number),
      title: heading.title,
      headingPath,
      contentLayer: "detail",
      sourceLineStart: heading.line,
      sourceLineEnd: nextLine - 1,
      directMarkdown,
      sectionMarkdown,
      retrievalText: contextualize(headingPath, directMarkdown),
      isSearchable: hasDirectBody || childHeadings.length === 0,
      relatedSourcePath: null,
      freshnessClass: number >= 5 && number <= 8 ? "dated_example" : "static_framework"
    });

    const usedChildIds = new Set<string>();
    for (let childIndex = 0; childIndex < childHeadings.length; childIndex += 1) {
      const child = childHeadings[childIndex];
      const childNextLine = childHeadings[childIndex + 1]?.line ?? nextLine;
      const childMarkdown = sliceLines(lines, child.line, childNextLine - 1);
      const childId = uniqueChildSectionId(parentId, child.title, usedChildIds);
      const childPath = [...headingPath, child.title];
      sections.push({
        sectionId: childId,
        parentSectionId: parentId,
        deliverySectionId: parentId,
        sectionType: "markdown_heading",
        headingLevel: 3,
        sectionNumber: null,
        title: child.title,
        headingPath: childPath,
        contentLayer: "detail",
        sourceLineStart: child.line,
        sourceLineEnd: childNextLine - 1,
        directMarkdown: childMarkdown,
        sectionMarkdown: childMarkdown,
        retrievalText: contextualize(childPath, childMarkdown),
        isSearchable: true,
        relatedSourcePath: null,
        freshnessClass: number >= 5 && number <= 8 ? "dated_example" : "static_framework"
      });
    }
  }

  return {
    sections,
    outline: {
      keyPoints: { count: 45, sourceLineStart: keyPointsHeading.line, sourceLineEnd: outlineHeading.line - 1 },
      outlineMarkdown: sliceLines(lines, outlineHeading.line, detailHeadings[0].line - 1),
      chapters: STARTUP_CHAPTERS
    },
    routingMetadata: {
      defaultRetrieval: "small_to_big",
      matchedChildExpandsTo: "delivery_section_id"
    }
  };
}

function parseMarketingWisdom(documentTitle: string, lines: string[]): ParsedDocumentSections {
  const sections: ParsedSectionInput[] = [];
  const numberedPattern = /^\*\*§(\d+)\s+(.+?)\*\*\s+—\s+(.+)$/;
  const numberedLines = lines.flatMap((line, index) => {
    const match = numberedPattern.exec(line);
    return match === null ? [] : [{ line: index + 1, number: Number(match[1]), title: match[2] }];
  });
  if (numberedLines.length !== 45 || numberedLines.some((item, index) => item.number !== index + 1)) {
    throw new AppError(
      "marketing_wisdom_section_contract_mismatch",
      `marketing wisdom expected numbered sections 1-45, got ${numberedLines.length}`,
      3
    );
  }

  for (const item of numberedLines) {
    const category = categoryForMarketingSection(item.number);
    const sectionId = `section-${twoDigits(item.number)}`;
    const markdown = lines[item.line - 1];
    const title = `§${item.number} ${item.title}`;
    const headingPath = [documentTitle, category.title, title];
    sections.push({
      sectionId,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "numbered_section",
      headingLevel: null,
      sectionNumber: String(item.number),
      title,
      headingPath,
      contentLayer: "index",
      sourceLineStart: item.line,
      sourceLineEnd: item.line,
      directMarkdown: markdown,
      sectionMarkdown: markdown,
      retrievalText: contextualize(headingPath, markdown),
      isSearchable: true,
      relatedSourcePath: relatedPathForMarketingSection(item.number),
      freshnessClass: item.number >= 16 && item.number <= 29
        ? "time_sensitive"
        : item.number >= 30
          ? "dated_example"
          : "static_framework"
    });
  }

  const headings = scanMarkdownHeadings(lines);
  const coreHeading = requireHeading(
    headings.filter((heading) => heading.level === 2),
    "全体を貫く一貫したメッセージ"
  );
  const guideHeading = requireHeading(
    headings.filter((heading) => heading.level === 2),
    "読み込みガイド"
  );
  const coreMarkdown = sliceLines(lines, coreHeading.line, guideHeading.line - 1);
  const corePath = [documentTitle, coreHeading.title];
  sections.push({
    sectionId: "core-message",
    parentSectionId: null,
    deliverySectionId: "core-message",
    sectionType: "markdown_heading",
    headingLevel: 2,
    sectionNumber: null,
    title: coreHeading.title,
    headingPath: corePath,
    contentLayer: "index",
    sourceLineStart: coreHeading.line,
    sourceLineEnd: guideHeading.line - 1,
    directMarkdown: coreMarkdown,
    sectionMarkdown: coreMarkdown,
    retrievalText: contextualize(corePath, coreMarkdown),
    isSearchable: true,
    relatedSourcePath: null,
    freshnessClass: "static_framework"
  });

  const relatedMapHeading = requireHeading(
    headings.filter((heading) => heading.level === 2),
    "セクションファイル一覧"
  );
  const overviewHeading = requireHeading(
    headings.filter((heading) => heading.level === 2),
    "全45セクション概要"
  );
  return {
    sections,
    outline: {
      categories: MARKETING_CATEGORIES,
      sectionCount: 45
    },
    routingMetadata: {
      detailAvailable: false,
      relatedSourceMapMarkdown: sliceLines(lines, relatedMapHeading.line, overviewHeading.line - 1),
      readingGuideMarkdown: sliceLines(lines, guideHeading.line, lines.length)
    }
  };
}

/**
 * Shared with editorKnowledge.ts: the kikaku composition playbook and kikaku DB catalog are
 * modeled as sectioned Editor Knowledge documents, not Business Knowledge documents, but they
 * reuse this exact parsing/validation/error-code machinery unchanged.
 */
export function parseKikakuPlaybook(documentTitle: string, lines: string[]): ParsedDocumentSections {
  const headings = scanMarkdownHeadings(lines);
  const chapterHeadings = headings.filter((heading) => heading.level === 2);
  if (chapterHeadings.length === 0) {
    throw new AppError(
      "kikaku_playbook_no_chapters",
      "kikaku composition playbook must contain at least one ## chapter heading",
      3
    );
  }
  assertNumberedHeadings(chapterHeadings, /^(\d+)\.\s/, chapterHeadings.length, "kikaku playbook chapters");

  const sections: ParsedSectionInput[] = [];
  const outlineChapters: Array<{ key: string; title: string; number: number }> = [];
  for (let index = 0; index < chapterHeadings.length; index += 1) {
    const heading = chapterHeadings[index];
    const nextLine = chapterHeadings[index + 1]?.line ?? lines.length + 1;
    const number = Number(/^(\d+)\./.exec(heading.title)?.[1]);
    const sectionId = `chapter-${twoDigits(number)}`;
    const headingPath = [documentTitle, heading.title];
    const markdown = sliceLines(lines, heading.line, nextLine - 1);
    outlineChapters.push({ key: sectionId, title: heading.title, number });
    sections.push({
      sectionId,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "markdown_heading",
      headingLevel: 2,
      sectionNumber: String(number),
      title: heading.title,
      headingPath,
      contentLayer: "detail",
      sourceLineStart: heading.line,
      sourceLineEnd: nextLine - 1,
      directMarkdown: markdown,
      sectionMarkdown: markdown,
      retrievalText: contextualize(headingPath, markdown),
      isSearchable: true,
      relatedSourcePath: null,
      freshnessClass: "static_framework"
    });
  }

  return {
    sections,
    outline: { chapters: outlineChapters },
    routingMetadata: { defaultRetrieval: "direct", detailAvailable: false }
  };
}

const KIKAKU_CATALOG_MAX_GROUPS = 10;
const KIKAKU_CATALOG_GROUP_LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] as const;
const KIKAKU_CATALOG_ENTRY_PATTERN = /^No\.(?:(\d+)|なし-(\d+))\s*｜\s*(.+)$/;

/** Shared with editorKnowledge.ts, see parseKikakuPlaybook. */
export function parseKikakuCatalog(documentTitle: string, lines: string[]): ParsedDocumentSections {
  const headings = scanMarkdownHeadings(lines);
  const structuralHeadings = headings.filter((heading) => heading.level === 2 || heading.level === 3);
  const disallowed = headings.find((heading) => {
    return heading.level !== 1 && heading.level !== 2 && heading.level !== 3;
  });
  if (disallowed !== undefined) {
    throw new AppError(
      "kikaku_catalog_heading_level_invalid",
      `kikaku db catalog only allows ## group and ### entry headings, found level ${disallowed.level} heading "${disallowed.title}"`,
      3
    );
  }
  if (structuralHeadings.length === 0) {
    throw new AppError(
      "kikaku_catalog_no_entries",
      "kikaku db catalog must contain at least one ### entry heading",
      3
    );
  }
  if (structuralHeadings[0].level !== 2) {
    throw new AppError(
      "kikaku_catalog_orphan_entry",
      "kikaku db catalog must begin with a ## group heading before any ### entry",
      3
    );
  }

  const groupHeadings = structuralHeadings.filter((heading) => heading.level === 2);
  if (groupHeadings.length > KIKAKU_CATALOG_MAX_GROUPS) {
    throw new AppError(
      "kikaku_catalog_too_many_groups",
      `kikaku db catalog expected at most ${KIKAKU_CATALOG_MAX_GROUPS} group headings, got ${groupHeadings.length}`,
      3
    );
  }
  const entryHeadings = structuralHeadings.filter((heading) => heading.level === 3);

  const sections: ParsedSectionInput[] = [];
  const outlineGroups: Array<{ key: string; title: string; entryCount: number }> = [];
  let totalEntries = 0;

  for (let groupIndex = 0; groupIndex < groupHeadings.length; groupIndex += 1) {
    const groupHeading = groupHeadings[groupIndex];
    const groupEnd = groupHeadings[groupIndex + 1]?.line ?? lines.length + 1;
    const groupKey = `group-${KIKAKU_CATALOG_GROUP_LETTERS[groupIndex]}`;
    const groupPath = [documentTitle, groupHeading.title];
    const childEntryHeadings = entryHeadings.filter((heading) => {
      return heading.line > groupHeading.line && heading.line < groupEnd;
    });
    const firstChildLine = childEntryHeadings[0]?.line ?? groupEnd;
    const groupDirectMarkdown = sliceLines(lines, groupHeading.line, firstChildLine - 1);
    const groupSectionMarkdown = sliceLines(lines, groupHeading.line, groupEnd - 1);

    sections.push({
      sectionId: groupKey,
      parentSectionId: null,
      deliverySectionId: groupKey,
      sectionType: "markdown_heading",
      headingLevel: 2,
      sectionNumber: null,
      title: groupHeading.title,
      headingPath: groupPath,
      contentLayer: "index",
      sourceLineStart: groupHeading.line,
      sourceLineEnd: groupEnd - 1,
      directMarkdown: groupDirectMarkdown,
      sectionMarkdown: groupSectionMarkdown,
      retrievalText: contextualize(groupPath, groupDirectMarkdown),
      isSearchable: false,
      relatedSourcePath: null,
      freshnessClass: "static_framework"
    });

    for (let entryIndex = 0; entryIndex < childEntryHeadings.length; entryIndex += 1) {
      const entryHeading = childEntryHeadings[entryIndex];
      const entryEnd = childEntryHeadings[entryIndex + 1]?.line ?? groupEnd;
      const parsedEntry = parseKikakuCatalogEntryHeading(entryHeading.title);
      const sectionId = parsedEntry.numbered
        ? `no-${threeDigits(parsedEntry.number)}`
        : `x-${twoDigits(parsedEntry.number)}`;
      const entryPath = [...groupPath, entryHeading.title];
      const entryMarkdown = sliceLines(lines, entryHeading.line, entryEnd - 1);
      sections.push({
        sectionId,
        parentSectionId: null,
        deliverySectionId: sectionId,
        sectionType: "markdown_heading",
        headingLevel: 3,
        sectionNumber: parsedEntry.numbered ? String(parsedEntry.number) : null,
        title: entryHeading.title,
        headingPath: entryPath,
        contentLayer: "detail",
        sourceLineStart: entryHeading.line,
        sourceLineEnd: entryEnd - 1,
        directMarkdown: entryMarkdown,
        sectionMarkdown: entryMarkdown,
        retrievalText: entryMarkdown,
        isSearchable: true,
        relatedSourcePath: null,
        freshnessClass: "dated_example"
      });
      totalEntries += 1;
    }

    outlineGroups.push({ key: groupKey, title: groupHeading.title, entryCount: childEntryHeadings.length });
  }

  if (totalEntries === 0) {
    throw new AppError(
      "kikaku_catalog_no_entries",
      "kikaku db catalog must contain at least one ### entry heading",
      3
    );
  }

  return {
    sections,
    outline: { groups: outlineGroups, entryCount: totalEntries },
    routingMetadata: { defaultRetrieval: "direct", detailAvailable: true }
  };
}

const KIKAKU_FULLTEXT_ENTRY_PATTERN = /^No\.(?:(\d{1,3})|なし-(\d{1,2})) ｜ (.+)$/;

/**
 * Shared with editorKnowledge.ts, see parseKikakuPlaybook. Unlike parseKikakuCatalog, this
 * document has no catalog-style structural constraints (no "#### forbidden", no required
 * groups, no required sequential numbering): the only thing that matters is finding the entry
 * boundaries. Every other heading in the source — H2 or deeper — is left untouched as ordinary
 * section body text, because the source is a verbatim (masking-only) reproduction of Notion
 * note bodies that may contain their own heading-shaped lines.
 */
export function parseKikakuFulltext(documentTitle: string, lines: string[]): ParsedDocumentSections {
  const headings = scanMarkdownHeadings(lines);
  const entryHeadings = headings.flatMap((heading) => {
    if (heading.level !== 2) return [];
    const match = KIKAKU_FULLTEXT_ENTRY_PATTERN.exec(heading.title);
    if (match === null) return [];
    const numbered = match[1] !== undefined;
    return [{ ...heading, numbered, number: Number(numbered ? match[1] : match[2]) }];
  });

  const sections: ParsedSectionInput[] = [];
  const outlineEntries: Array<{ key: string; title: string; sectionNumber: string | null }> = [];

  const firstEntryLine = entryHeadings[0]?.line ?? lines.length + 1;
  const preambleMarkdown = sliceLines(lines, 2, firstEntryLine - 1);
  if (preambleMarkdown.trim().length > 0) {
    const preamblePath = [documentTitle, "前書き"];
    sections.push({
      sectionId: "preamble",
      parentSectionId: null,
      deliverySectionId: "preamble",
      sectionType: "markdown_heading",
      headingLevel: null,
      sectionNumber: null,
      title: "前書き",
      headingPath: preamblePath,
      contentLayer: "index",
      sourceLineStart: 2,
      sourceLineEnd: firstEntryLine - 1,
      directMarkdown: preambleMarkdown,
      sectionMarkdown: preambleMarkdown,
      retrievalText: contextualize(preamblePath, preambleMarkdown),
      isSearchable: false,
      relatedSourcePath: null,
      freshnessClass: "static_framework"
    });
  }

  for (let index = 0; index < entryHeadings.length; index += 1) {
    const heading = entryHeadings[index];
    const entryEnd = entryHeadings[index + 1]?.line ?? lines.length + 1;
    const sectionId = heading.numbered
      ? `no-${threeDigits(heading.number)}`
      : `x-${twoDigits(heading.number)}`;
    const entryPath = [documentTitle, heading.title];
    const entryMarkdown = sliceLines(lines, heading.line, entryEnd - 1);
    const sectionNumber = heading.numbered ? String(heading.number) : null;
    sections.push({
      sectionId,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "markdown_heading",
      headingLevel: 2,
      sectionNumber,
      title: heading.title,
      headingPath: entryPath,
      contentLayer: "detail",
      sourceLineStart: heading.line,
      sourceLineEnd: entryEnd - 1,
      directMarkdown: entryMarkdown,
      sectionMarkdown: entryMarkdown,
      retrievalText: entryMarkdown,
      isSearchable: true,
      relatedSourcePath: null,
      freshnessClass: "dated_example"
    });
    outlineEntries.push({ key: sectionId, title: heading.title, sectionNumber });
  }

  return {
    sections,
    outline: { hasPreamble: preambleMarkdown.trim().length > 0, entryCount: entryHeadings.length, entries: outlineEntries },
    routingMetadata: { defaultRetrieval: "direct", detailAvailable: true }
  };
}

function parseKikakuCatalogEntryHeading(title: string): { numbered: boolean; number: number } {
  const match = KIKAKU_CATALOG_ENTRY_PATTERN.exec(title);
  if (match === null) {
    throw new AppError(
      "kikaku_catalog_entry_heading_invalid",
      `kikaku db catalog entry heading must match "No.<n> ｜ title" or "No.なし-<n> ｜ title", got "${title}"`,
      3
    );
  }
  if (match[1] !== undefined) {
    return { numbered: true, number: Number(match[1]) };
  }
  return { numbered: false, number: Number(match[2]) };
}

function scanMarkdownHeadings(lines: string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fenceMarker: "```" | "~~~" | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    const fence = /^(\`\`\`|~~~)/.exec(trimmed)?.[1] as "```" | "~~~" | undefined;
    if (fence !== undefined) {
      fenceMarker = fenceMarker === null ? fence : fenceMarker === fence ? null : fenceMarker;
      continue;
    }
    if (fenceMarker !== null) {
      continue;
    }
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match !== null) {
      headings.push({ level: match[1].length, title: match[2].trim(), line: index + 1 });
    }
  }
  return headings;
}

export function splitContentLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join("\n").trimEnd();
}

function contextualize(headingPath: string[], markdown: string): string {
  return `${headingPath.join(" > ")}\n${markdown}`;
}

function hasMeaningfulBody(markdown: string): boolean {
  const bodyLines = markdown.split("\n").slice(1);
  return bodyLines.some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !/^[-*_]{3,}$/.test(trimmed);
  });
}

function extractMarkdownTitle(markdown: string, documentId: string): string {
  const firstLine = markdown.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const title = /^#\s+(.+)$/.exec(firstLine)?.[1]?.trim() ?? "";
  if (title.length === 0) {
    throw new AppError(
      "business_knowledge_title_missing",
      `business knowledge source must start with an H1 title: ${documentId}`,
      3
    );
  }
  return title;
}

function requireHeading(headings: MarkdownHeading[], title: string): MarkdownHeading {
  const matches = headings.filter((heading) => heading.title === title);
  if (matches.length !== 1) {
    throw new AppError(
      "business_knowledge_heading_contract_mismatch",
      `expected exactly one heading named ${title}, got ${matches.length}`,
      3
    );
  }
  return matches[0];
}

function assertNumberedHeadings(
  headings: MarkdownHeading[],
  pattern: RegExp,
  expectedCount: number,
  label: string
): void {
  if (headings.length !== expectedCount) {
    throw new AppError(
      "business_knowledge_heading_count_mismatch",
      `${label} expected ${expectedCount}, got ${headings.length}`,
      3
    );
  }
  for (let index = 0; index < headings.length; index += 1) {
    const actual = Number(pattern.exec(headings[index].title)?.[1]);
    if (actual !== index + 1) {
      throw new AppError(
        "business_knowledge_heading_sequence_mismatch",
        `${label} expected ${index + 1}, got ${String(actual)}`,
        3
      );
    }
  }
}

function chapterForStartupSection(sectionNumber: number) {
  const chapter = STARTUP_CHAPTERS.find((candidate) => {
    return sectionNumber >= candidate.start && sectionNumber <= candidate.end;
  });
  if (chapter === undefined) {
    throw new AppError("startup_chapter_missing", `no chapter for startup section ${sectionNumber}`, 3);
  }
  return chapter;
}

function categoryForMarketingSection(sectionNumber: number) {
  const category = MARKETING_CATEGORIES.find((candidate) => {
    return sectionNumber >= candidate.start && sectionNumber <= candidate.end;
  });
  if (category === undefined) {
    throw new AppError("marketing_category_missing", `no category for marketing section ${sectionNumber}`, 3);
  }
  return category;
}

function relatedPathForMarketingSection(sectionNumber: number): string {
  if (sectionNumber === 1) return "sections/00-knowledge-structure.md";
  if (sectionNumber <= 3) return "sections/01-who-what-how.md";
  if (sectionNumber === 4) return "sections/02-5segs-9segs.md";
  if (sectionNumber === 5) return "sections/03-n1-analysis.md";
  if (sectionNumber <= 7) return "sections/04-customer-dynamics.md";
  if (sectionNumber <= 9) return "sections/05-marketing-process.md";
  if (sectionNumber <= 11) return "sections/06-115methods-branding.md";
  if (sectionNumber <= 13) return "sections/07-psychology.md";
  if (sectionNumber <= 15) return "sections/08-btob-roi.md";
  if (sectionNumber <= 19) return "sections/09-ai-marketing.md";
  if (sectionNumber <= 29) return "sections/10-ai-agent-aeo.md";
  if (sectionNumber <= 36) return "sections/11-case-studies.md";
  return "sections/12-appendix.md";
}

function uniqueChildSectionId(parentId: string, title: string, used: Set<string>): string {
  const ascii = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\x00-\x7F]+/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = sha256(title).slice(0, 10);
  const base = `${parentId}--${ascii.length > 0 ? `${ascii}-${suffix}` : `h-${suffix}`}`;
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function threeDigits(value: number): string {
  return String(value).padStart(3, "0");
}

/** Structural subset shared with editorKnowledge.ts, see parseKikakuPlaybook. */
export interface SectionIdentity {
  documentId: string;
  sectionId: string;
}

/** Structural subset shared with editorKnowledge.ts, see parseKikakuPlaybook. */
export interface SectionStorageContent extends SectionIdentity {
  directMarkdown: string;
  sectionMarkdown: string;
  retrievalText: string;
}

export function assertUniqueSectionIds(sections: SectionIdentity[]): void {
  const ids = new Set<string>();
  for (const section of sections) {
    if (ids.has(section.sectionId)) {
      throw new AppError(
        "duplicate_business_knowledge_section_id",
        `duplicate section id: ${section.documentId}#${section.sectionId}`,
        3
      );
    }
    ids.add(section.sectionId);
  }
}

export function assertStorageLimits(
  markdown: string,
  sections: SectionStorageContent[]
): void {
  assertMediumText("document markdown", markdown);
  for (const section of sections) {
    assertMediumText(`${section.documentId}#${section.sectionId} direct_markdown`, section.directMarkdown);
    assertMediumText(`${section.documentId}#${section.sectionId} section_markdown`, section.sectionMarkdown);
    assertMediumText(`${section.documentId}#${section.sectionId} retrieval_text`, section.retrievalText);
  }
}

function assertMediumText(label: string, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MEDIUMTEXT_MAX_BYTES) {
    throw new AppError(
      "business_knowledge_storage_limit_exceeded",
      `${label} is ${bytes} bytes; semantic sections are never character-split, so the source must be revised or the database column widened`,
      3
    );
  }
}
