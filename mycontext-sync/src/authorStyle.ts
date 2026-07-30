import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./hash.js";
import { parseAuthorStyleRoutingManifest } from "./authorStyleRouting.js";
import { AppError } from "./types.js";

export const AUTHOR_STYLE_PARSER_VERSION = "author-style-parser-v2";
export const AUTHOR_STYLE_SECTIONING_VERSION = "semantic-delivery-v1";
export const AUTHOR_STYLE_ROUTING_VERSION = "single-context-pack-v1";
const COMPACT_BODY_PARSER_VERSION = "author-style-parser-v3";
const COMPACT_BODY_ROUTING_VERSION = "single-context-pack-v2";

const MEDIUMTEXT_MAX_BYTES = 16_777_215;

export const AUTHOR_STYLE_DOCUMENT_IDS = ["ore-title-style", "ore-body-style"] as const;
export type AuthorStyleDocumentId = typeof AUTHOR_STYLE_DOCUMENT_IDS[number];
export type AuthorStyleScope = "title" | "body";
export type AuthorStyleContentLayer = "runtime" | "profile" | "evaluation" | "evidence" | "ops";

export interface AuthorStyleSource {
  documentId: AuthorStyleDocumentId;
  authorKey: "ore";
  styleScope: AuthorStyleScope;
  relativePath: string;
}

export interface AuthorStyleSection {
  documentId: AuthorStyleDocumentId;
  revisionSha256: string;
  sectionId: string;
  contextKey: string | null;
  parentSectionId: string | null;
  deliverySectionId: string;
  sectionType: "delivery" | "search_span";
  contentLayer: AuthorStyleContentLayer;
  contextPriority: number;
  headingLevel: number | null;
  title: string;
  headingPath: string[];
  aliases: string[];
  ordinal: number;
  sourceLineStart: number;
  sourceLineEnd: number;
  contentChars: number;
  estimatedTokens: number | null;
  directMarkdown: string;
  deliveryMarkdown: string;
  retrievalText: string;
  contentSha256: string;
  isSearchable: boolean;
}

export interface LoadedAuthorStyleDocument {
  documentId: AuthorStyleDocumentId;
  authorKey: "ore";
  styleScope: AuthorStyleScope;
  displayName: string;
  sourcePathKey: string;
  sourceMarkdown: string;
  sourceMarkdownSha256: string;
  sourceBytes: number;
  sourceLineCount: number;
  sourceMtimeMs: number;
  revisionSha256: string;
  parserVersion: string;
  sectioningVersion: string;
  routingVersion: string;
  routingManifest: Record<string, unknown>;
  outline: Record<string, unknown>;
  sectionCount: number;
  deliverySectionCount: number;
  searchSpanCount: number;
  sections: AuthorStyleSection[];
}

export interface AuthorStyleMarkdownInput {
  source: AuthorStyleSource;
  markdown: string;
  sourcePathKey: string;
  sourceMtimeMs: number;
  sourceBytes?: number;
}

interface Heading {
  level: number;
  title: string;
  line: number;
}

interface ParsedSection extends Omit<
  AuthorStyleSection,
  "documentId" | "revisionSha256" | "ordinal" | "contentSha256"
> {}

interface BodyDefinition {
  contextKey: string;
  contentLayer: AuthorStyleContentLayer;
  priority: number;
}

type BodyLayout = "legacy-analysis" | "compact-v2";

export const AUTHOR_STYLE_SOURCES: readonly AuthorStyleSource[] = [
  {
    documentId: "ore-title-style",
    authorKey: "ore",
    styleScope: "title",
    relativePath: "knowledge/ore-title-reproduction-guide.md"
  },
  {
    documentId: "ore-body-style",
    authorKey: "ore",
    styleScope: "body",
    relativePath: "knowledge/ore-body-style-analysis-20260713.md"
  }
];

const TITLE_MODE_KEYS = {
  news: ["ore-title/mode/news"],
  "reaction-explanation": ["ore-title/mode/reaction-explanation"],
  uncertainty: ["ore-title/mode/uncertainty"],
  experience: ["ore-title/mode/experience"],
  interview: ["ore-title/mode/interview"],
  practical: ["ore-title/mode/practical"],
  sale: ["ore-title/mode/sale"],
  narrative: ["ore-title/mode/narrative"]
} as const;

const BODY_MODE_KEYS = {
  "short-news": ["ore-body/composition/short-news", "ore-body/mode/classic-short-news"],
  explanatory: ["ore-body/composition/explanatory", "ore-body/mode/modern-explanatory"],
  review: ["ore-body/composition/review", "ore-body/mode/review"],
  interview: ["ore-body/composition/interview", "ore-body/mode/interview"],
  translation: ["ore-body/composition/translation", "ore-body/mode/translation"]
} as const;

const COMPACT_BODY_MODE_KEYS = {
  "short-news": ["ore-body/composition/short-news"],
  explanatory: ["ore-body/composition/explanatory"],
  review: ["ore-body/composition/review"],
  interview: ["ore-body/composition/interview"],
  translation: ["ore-body/composition/translation"]
} as const;

export function authorStyleSourceRootFromEnv(): string {
  const sourceRoot = process.env.AUTHOR_STYLE_SOURCE_ROOT;
  if (!sourceRoot) {
    throw new AppError("missing_env", "missing required env var: AUTHOR_STYLE_SOURCE_ROOT", 3);
  }
  if (!path.isAbsolute(sourceRoot)) {
    throw new AppError(
      "invalid_author_style_source_root",
      "AUTHOR_STYLE_SOURCE_ROOT must be an absolute path",
      3
    );
  }
  return path.resolve(sourceRoot);
}

export async function loadAuthorStyleDocument(
  sourceRoot: string,
  source: AuthorStyleSource
): Promise<LoadedAuthorStyleDocument> {
  const absoluteRoot = path.resolve(sourceRoot);
  const sourcePath = path.resolve(absoluteRoot, source.relativePath);
  const relative = path.relative(absoluteRoot, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(
      "author_style_path_escape",
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
      "author_style_read_failed",
      `failed to read author style source: ${source.documentId}`,
      3,
      error
    );
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch (error) {
    throw new AppError(
      "author_style_invalid_utf8",
      `author style source is not valid UTF-8: ${source.documentId}`,
      3,
      error
    );
  }
  return parseAuthorStyleMarkdown({
    source,
    markdown,
    sourcePathKey: source.relativePath,
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    sourceBytes: bytes.byteLength
  });
}

export function parseAuthorStyleMarkdown(
  input: AuthorStyleMarkdownInput
): LoadedAuthorStyleDocument {
  const { source, markdown } = input;
  if (!Number.isFinite(input.sourceMtimeMs) || input.sourceMtimeMs < 0) {
    throw new AppError(
      "author_style_invalid_source_mtime",
      `author style source mtime is invalid: ${source.documentId}`,
      3
    );
  }
  if (markdown.trim().length === 0 || markdown.includes("\0")) {
    throw new AppError(
      "author_style_invalid_markdown",
      `author style source is empty or contains NUL: ${source.documentId}`,
      3
    );
  }

  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = splitContentLines(normalized);
  const headings = scanMarkdownHeadings(lines);
  const displayName = requireDocumentTitle(headings, source.documentId);
  const bodyLayout = source.styleScope === "body" ? detectBodyLayout(headings) : null;
  const parsed = source.styleScope === "title"
    ? parseTitleStyle(displayName, lines, headings)
    : bodyLayout === "compact-v2"
      ? parseCompactBodyStyle(displayName, lines, headings)
      : parseBodyStyle(displayName, lines, headings);
  const parserVersion = bodyLayout === "compact-v2"
    ? COMPACT_BODY_PARSER_VERSION
    : AUTHOR_STYLE_PARSER_VERSION;
  const routingVersion = bodyLayout === "compact-v2"
    ? COMPACT_BODY_ROUTING_VERSION
    : AUTHOR_STYLE_ROUTING_VERSION;
  const routingManifest = source.styleScope === "title"
    ? titleRoutingManifest()
    : bodyLayout === "compact-v2"
      ? compactBodyRoutingManifest()
      : bodyRoutingManifest();
  parseAuthorStyleRoutingManifest(routingManifest);
  assertRoutingReferences(parsed, routingManifest, source.documentId);

  const sourceMarkdownSha256 = sha256(markdown);
  const revisionSha256 = sha256([
    sourceMarkdownSha256,
    parserVersion,
    AUTHOR_STYLE_SECTIONING_VERSION,
    routingVersion,
    JSON.stringify(routingManifest)
  ].join("\0"));
  const sections = parsed.map((section, index) => ({
    ...section,
    documentId: source.documentId,
    revisionSha256,
    ordinal: index + 1,
    contentSha256: sha256(section.directMarkdown)
  }));
  assertSections(sections, source.documentId);
  assertStorageLimits(markdown, sections);

  const deliverySectionCount = sections.filter((section) => section.sectionType === "delivery").length;
  const searchSpanCount = sections.filter((section) => section.sectionType === "search_span").length;
  return {
    documentId: source.documentId,
    authorKey: source.authorKey,
    styleScope: source.styleScope,
    displayName,
    sourcePathKey: input.sourcePathKey,
    sourceMarkdown: markdown,
    sourceMarkdownSha256,
    sourceBytes: input.sourceBytes ?? new TextEncoder().encode(markdown).byteLength,
    sourceLineCount: lines.length,
    sourceMtimeMs: Math.trunc(input.sourceMtimeMs),
    revisionSha256,
    parserVersion,
    sectioningVersion: AUTHOR_STYLE_SECTIONING_VERSION,
    routingVersion,
    routingManifest,
    outline: {
      headings: headings.map((heading) => ({
        level: heading.level,
        title: heading.title,
        line: heading.line
      }))
    },
    sectionCount: sections.length,
    deliverySectionCount,
    searchSpanCount,
    sections
  };
}

function parseTitleStyle(documentTitle: string, lines: string[], headings: Heading[]): ParsedSection[] {
  const h2s = headings.filter((heading) => heading.level === 2);
  const sections: ParsedSection[] = [];
  const foundKeys: string[] = [];

  for (let index = 0; index < h2s.length; index += 1) {
    const h2 = h2s[index];
    const nextLine = h2s[index + 1]?.line ?? lines.length + 1;
    const children = headings.filter((heading) => {
      return heading.level === 3 && heading.line > h2.line && heading.line < nextLine;
    });
    const directEnd = children[0]?.line ? children[0].line - 1 : nextLine - 1;
    const directMarkdown = sliceLines(lines, h2.line, directEnd);
    const deliveryMarkdown = sliceLines(lines, h2.line, nextLine - 1);
    const contextKey = extractContextKey(directMarkdown, h2.title);
    const sectionId = sectionIdFromContextKey(contextKey);
    const classification = classifyTitleContextKey(contextKey);
    foundKeys.push(contextKey);
    sections.push(buildParsedSection({
      sectionId,
      contextKey,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "delivery",
      contentLayer: classification.layer,
      contextPriority: classification.priority,
      headingLevel: 2,
      title: h2.title,
      headingPath: [documentTitle, h2.title],
      aliases: [h2.title, contextKey],
      sourceLineStart: h2.line,
      sourceLineEnd: nextLine - 1,
      directMarkdown,
      deliveryMarkdown,
      isSearchable: true
    }));

    const usedChildIds = new Set<string>();
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      const childNextLine = children[childIndex + 1]?.line ?? nextLine;
      const childMarkdown = sliceLines(lines, child.line, childNextLine - 1);
      const childId = uniqueChildId(sectionId, child.title, usedChildIds);
      sections.push(buildParsedSection({
        sectionId: childId,
        contextKey: null,
        parentSectionId: sectionId,
        deliverySectionId: sectionId,
        sectionType: "search_span",
        contentLayer: classification.layer,
        contextPriority: classification.priority,
        headingLevel: 3,
        title: child.title,
        headingPath: [documentTitle, h2.title, child.title],
        aliases: [child.title],
        sourceLineStart: child.line,
        sourceLineEnd: childNextLine - 1,
        directMarkdown: childMarkdown,
        deliveryMarkdown,
        isSearchable: true
      }));
    }
  }

  const expected = [
    "ore-title/bootstrap",
    "ore-title/core",
    "ore-title/input-contract",
    "ore-title/router",
    ...Object.values(TITLE_MODE_KEYS).flat(),
    "ore-title/notation",
    "ore-title/anti-patterns",
    "ore-title/evaluator",
    "ore-title/output-contract",
    "ore-title/retrieval-ops",
    "ore-title/maintenance",
    "ore-title/evidence"
  ];
  if (JSON.stringify(foundKeys) !== JSON.stringify(expected)) {
    throw new AppError(
      "author_style_title_context_contract_mismatch",
      `ore-title-style context keys changed; expected ${expected.join(", ")}, got ${foundKeys.join(", ")}`,
      3
    );
  }
  return sections;
}

function parseBodyStyle(documentTitle: string, lines: string[], headings: Heading[]): ParsedSection[] {
  const h2s = headings.filter((heading) => heading.level === 2);
  const sections: ParsedSection[] = [];

  for (let index = 0; index < h2s.length; index += 1) {
    const h2 = h2s[index];
    const nextLine = h2s[index + 1]?.line ?? lines.length + 1;
    const chapter = bodyChapterNumber(h2.title);
    const children = headings.filter((heading) => {
      return heading.level === 3 && heading.line > h2.line && heading.line < nextLine;
    });

    if (chapter === 10 || chapter === 18 || chapter === 21) {
      parseBodyChildDeliveries(documentTitle, lines, h2, nextLine, children, chapter, sections);
      continue;
    }

    const definition = bodyH2Definition(h2.title, chapter);
    const sectionId = sectionIdFromContextKey(definition.contextKey);
    const deliveryMarkdown = sliceLines(lines, h2.line, nextLine - 1);
    const directEnd = children[0]?.line ? children[0].line - 1 : nextLine - 1;
    sections.push(buildParsedSection({
      sectionId,
      contextKey: definition.contextKey,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "delivery",
      contentLayer: definition.contentLayer,
      contextPriority: definition.priority,
      headingLevel: 2,
      title: h2.title,
      headingPath: [documentTitle, h2.title],
      aliases: [h2.title, definition.contextKey],
      sourceLineStart: h2.line,
      sourceLineEnd: nextLine - 1,
      directMarkdown: sliceLines(lines, h2.line, directEnd),
      deliveryMarkdown,
      isSearchable: true
    }));

    const usedChildIds = new Set<string>();
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      const childNextLine = children[childIndex + 1]?.line ?? nextLine;
      const childMarkdown = sliceLines(lines, child.line, childNextLine - 1);
      const childId = uniqueChildId(sectionId, child.title, usedChildIds);
      sections.push(buildParsedSection({
        sectionId: childId,
        contextKey: null,
        parentSectionId: sectionId,
        deliverySectionId: sectionId,
        sectionType: "search_span",
        contentLayer: definition.contentLayer,
        contextPriority: definition.priority,
        headingLevel: 3,
        title: child.title,
        headingPath: [documentTitle, h2.title, child.title],
        aliases: [child.title],
        sourceLineStart: child.line,
        sourceLineEnd: childNextLine - 1,
        directMarkdown: childMarkdown,
        deliveryMarkdown,
        isSearchable: true
      }));
    }
  }

  return sections;
}

function detectBodyLayout(headings: Heading[]): BodyLayout {
  const h2Titles = headings
    .filter((heading) => heading.level === 2)
    .map((heading) => heading.title);
  return h2Titles[0] === "1. 基本リズム" ? "compact-v2" : "legacy-analysis";
}

function parseCompactBodyStyle(
  documentTitle: string,
  lines: string[],
  headings: Heading[]
): ParsedSection[] {
  const h2s = headings.filter((heading) => heading.level === 2);
  const expectedTitles = [
    "1. 基本リズム",
    "2. 文体・語尾",
    "3. 会話性と人称",
    "4. 接続と論理の運び方",
    "5. 不確実性・評価・感情",
    "6. 疑問・感嘆・記号",
    "7. 冒頭の作り方",
    "8. 本論の組み立て",
    "9. 結びの作り方",
    "10. 導線・流れを自然に見せる編集技法",
    "11. 読者への距離",
    "12. 公開本文の構造要素",
    "13. 本文生成のスタイル契約",
    "14. 本文評価チェックリスト",
    "15. 長文記事の特長"
  ];
  const actualTitles = h2s.map((heading) => heading.title);
  if (JSON.stringify(actualTitles) !== JSON.stringify(expectedTitles)) {
    throw new AppError(
      "author_style_compact_body_outline_mismatch",
      `compact ore-body-style H2 outline changed; expected ${expectedTitles.join(", ")}, got ${actualTitles.join(", ")}`,
      3
    );
  }

  const definitions: Record<number, BodyDefinition> = {
    1: { contextKey: "ore-body/core/rhythm", contentLayer: "runtime", priority: 95 },
    2: { contextKey: "ore-body/core/tone", contentLayer: "runtime", priority: 95 },
    3: { contextKey: "ore-body/core/person", contentLayer: "runtime", priority: 90 },
    4: { contextKey: "ore-body/core/logic", contentLayer: "runtime", priority: 95 },
    5: { contextKey: "ore-body/core/certainty-emotion", contentLayer: "runtime", priority: 95 },
    6: { contextKey: "ore-body/core/notation", contentLayer: "runtime", priority: 90 },
    7: { contextKey: "ore-body/structure/opening", contentLayer: "runtime", priority: 95 },
    9: { contextKey: "ore-body/structure/closing", contentLayer: "runtime", priority: 95 },
    10: { contextKey: "ore-body/flow", contentLayer: "runtime", priority: 95 },
    11: { contextKey: "ore-body/reader-distance", contentLayer: "runtime", priority: 85 },
    12: {
      contextKey: "ore-body/evidence/structure-elements",
      contentLayer: "evidence",
      priority: 35
    },
    13: { contextKey: "ore-body/contract", contentLayer: "runtime", priority: 100 },
    14: { contextKey: "ore-body/evaluator", contentLayer: "evaluation", priority: 100 }
  };
  const sections: ParsedSection[] = [];

  for (let index = 0; index < h2s.length; index += 1) {
    const h2 = h2s[index];
    const nextLine = h2s[index + 1]?.line ?? lines.length + 1;
    const chapter = bodyChapterNumber(h2.title);
    const children = headings.filter((heading) => {
      return heading.level === 3 && heading.line > h2.line && heading.line < nextLine;
    });

    if (chapter === 8) {
      parseCompactCompositionDeliveries(
        documentTitle,
        lines,
        h2,
        nextLine,
        children,
        sections
      );
      continue;
    }
    if (chapter === 15) {
      parseCompactLongformDeliveries(
        documentTitle,
        lines,
        h2,
        nextLine,
        children,
        sections
      );
      continue;
    }

    const definition = chapter === null ? undefined : definitions[chapter];
    if (definition === undefined) {
      throw new AppError(
        "author_style_compact_body_heading_unmapped",
        `unmapped compact body H2 heading: ${h2.title}`,
        3
      );
    }
    appendBodyDeliveryWithSearchSpans({
      documentTitle,
      lines,
      h2,
      nextLine,
      children,
      definition,
      sections
    });
  }
  return sections;
}

function appendBodyDeliveryWithSearchSpans(input: {
  documentTitle: string;
  lines: string[];
  h2: Heading;
  nextLine: number;
  children: Heading[];
  definition: BodyDefinition;
  sections: ParsedSection[];
}): void {
  const { documentTitle, lines, h2, nextLine, children, definition, sections } = input;
  const sectionId = sectionIdFromContextKey(definition.contextKey);
  const deliveryMarkdown = sliceLines(lines, h2.line, nextLine - 1);
  const directEnd = children[0]?.line ? children[0].line - 1 : nextLine - 1;
  sections.push(buildParsedSection({
    sectionId,
    contextKey: definition.contextKey,
    parentSectionId: null,
    deliverySectionId: sectionId,
    sectionType: "delivery",
    contentLayer: definition.contentLayer,
    contextPriority: definition.priority,
    headingLevel: 2,
    title: h2.title,
    headingPath: [documentTitle, h2.title],
    aliases: [h2.title, definition.contextKey],
    sourceLineStart: h2.line,
    sourceLineEnd: nextLine - 1,
    directMarkdown: sliceLines(lines, h2.line, directEnd),
    deliveryMarkdown,
    isSearchable: true
  }));

  const usedChildIds = new Set<string>();
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const childNextLine = children[childIndex + 1]?.line ?? nextLine;
    const childMarkdown = sliceLines(lines, child.line, childNextLine - 1);
    const childId = uniqueChildId(sectionId, child.title, usedChildIds);
    sections.push(buildParsedSection({
      sectionId: childId,
      contextKey: null,
      parentSectionId: sectionId,
      deliverySectionId: sectionId,
      sectionType: "search_span",
      contentLayer: definition.contentLayer,
      contextPriority: definition.priority,
      headingLevel: 3,
      title: child.title,
      headingPath: [documentTitle, h2.title, child.title],
      aliases: [child.title],
      sourceLineStart: child.line,
      sourceLineEnd: childNextLine - 1,
      directMarkdown: childMarkdown,
      deliveryMarkdown,
      isSearchable: true
    }));
  }
}

function parseCompactCompositionDeliveries(
  documentTitle: string,
  lines: string[],
  h2: Heading,
  nextLine: number,
  children: Heading[],
  sections: ParsedSection[]
): void {
  const expectedTitles = [
    "8.1 標準記事",
    "8.2 レビュー・体験",
    "8.3 インタビュー・長文",
    "8.4 翻訳・紹介"
  ];
  assertChildOutline("compact composition", children, expectedTitles);
  const definitions = [
    [
      { contextKey: "ore-body/composition/short-news", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/composition/explanatory", contentLayer: "runtime", priority: 90 }
    ],
    [{ contextKey: "ore-body/composition/review", contentLayer: "runtime", priority: 90 }],
    [{ contextKey: "ore-body/composition/interview", contentLayer: "runtime", priority: 90 }],
    [{ contextKey: "ore-body/composition/translation", contentLayer: "runtime", priority: 90 }]
  ] satisfies BodyDefinition[][];

  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const childNextLine = children[childIndex + 1]?.line ?? nextLine;
    const markdown = sliceLines(lines, child.line, childNextLine - 1);
    for (const definition of definitions[childIndex] ?? []) {
      const sectionId = sectionIdFromContextKey(definition.contextKey);
      sections.push(buildParsedSection({
        sectionId,
        contextKey: definition.contextKey,
        parentSectionId: null,
        deliverySectionId: sectionId,
        sectionType: "delivery",
        contentLayer: definition.contentLayer,
        contextPriority: definition.priority,
        headingLevel: 3,
        title: child.title,
        headingPath: [documentTitle, h2.title, child.title],
        aliases: [child.title, definition.contextKey],
        sourceLineStart: child.line,
        sourceLineEnd: childNextLine - 1,
        directMarkdown: markdown,
        deliveryMarkdown: markdown,
        isSearchable: true
      }));
    }
  }
}

function parseCompactLongformDeliveries(
  documentTitle: string,
  lines: string[],
  h2: Heading,
  nextLine: number,
  children: Heading[],
  sections: ParsedSection[]
): void {
  const expectedTitles = [
    "15.1 長文の基本方針",
    "15.2 伝聞と自分の判断を分ける",
    "15.3 長文の熱量は、問いと検討で作る",
    "15.4 見出しは「話題名」ではなく「読者の判断軸」にする",
    "15.5 長文記事専用のスタイル契約",
    "15.6 長文で避けること"
  ];
  assertChildOutline("compact longform", children, expectedTitles);

  const contract = children[4];
  const antiPatterns = children[5];
  if (contract === undefined || antiPatterns === undefined) {
    throw new AppError(
      "author_style_compact_body_longform_missing",
      "compact longform contract or anti-patterns section is missing",
      3
    );
  }

  const guidanceDefinition: BodyDefinition = {
    contextKey: "ore-body/longform/guidance",
    contentLayer: "runtime",
    priority: 90
  };
  const guidanceSectionId = sectionIdFromContextKey(guidanceDefinition.contextKey);
  const guidanceMarkdown = sliceLines(lines, h2.line, contract.line - 1);
  sections.push(buildParsedSection({
    sectionId: guidanceSectionId,
    contextKey: guidanceDefinition.contextKey,
    parentSectionId: null,
    deliverySectionId: guidanceSectionId,
    sectionType: "delivery",
    contentLayer: guidanceDefinition.contentLayer,
    contextPriority: guidanceDefinition.priority,
    headingLevel: 2,
    title: h2.title,
    headingPath: [documentTitle, h2.title],
    aliases: [h2.title, guidanceDefinition.contextKey],
    sourceLineStart: h2.line,
    sourceLineEnd: contract.line - 1,
    directMarkdown: sliceLines(lines, h2.line, children[0]?.line ? children[0].line - 1 : contract.line - 1),
    deliveryMarkdown: guidanceMarkdown,
    isSearchable: true
  }));

  const usedChildIds = new Set<string>();
  for (let childIndex = 0; childIndex < 4; childIndex += 1) {
    const child = children[childIndex];
    if (child === undefined) continue;
    const childNextLine = children[childIndex + 1]?.line ?? contract.line;
    const childId = uniqueChildId(guidanceSectionId, child.title, usedChildIds);
    sections.push(buildParsedSection({
      sectionId: childId,
      contextKey: null,
      parentSectionId: guidanceSectionId,
      deliverySectionId: guidanceSectionId,
      sectionType: "search_span",
      contentLayer: guidanceDefinition.contentLayer,
      contextPriority: guidanceDefinition.priority,
      headingLevel: 3,
      title: child.title,
      headingPath: [documentTitle, h2.title, child.title],
      aliases: [child.title],
      sourceLineStart: child.line,
      sourceLineEnd: childNextLine - 1,
      directMarkdown: sliceLines(lines, child.line, childNextLine - 1),
      deliveryMarkdown: guidanceMarkdown,
      isSearchable: true
    }));
  }

  for (const [child, definition] of [
    [
      contract,
      { contextKey: "ore-body/longform/contract", contentLayer: "runtime", priority: 95 }
    ],
    [
      antiPatterns,
      {
        contextKey: "ore-body/longform/anti-patterns",
        contentLayer: "evaluation",
        priority: 95
      }
    ]
  ] satisfies Array<[Heading, BodyDefinition]>) {
    const childNextLine = child === contract ? antiPatterns.line : nextLine;
    const sectionId = sectionIdFromContextKey(definition.contextKey);
    const markdown = sliceLines(lines, child.line, childNextLine - 1);
    sections.push(buildParsedSection({
      sectionId,
      contextKey: definition.contextKey,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "delivery",
      contentLayer: definition.contentLayer,
      contextPriority: definition.priority,
      headingLevel: 3,
      title: child.title,
      headingPath: [documentTitle, h2.title, child.title],
      aliases: [child.title, definition.contextKey],
      sourceLineStart: child.line,
      sourceLineEnd: childNextLine - 1,
      directMarkdown: markdown,
      deliveryMarkdown: markdown,
      isSearchable: true
    }));
  }
}

function assertChildOutline(label: string, children: Heading[], expectedTitles: string[]): void {
  const actualTitles = children.map((child) => child.title);
  if (JSON.stringify(actualTitles) !== JSON.stringify(expectedTitles)) {
    throw new AppError(
      "author_style_compact_body_child_outline_mismatch",
      `${label} H3 outline changed; expected ${expectedTitles.join(", ")}, got ${actualTitles.join(", ")}`,
      3
    );
  }
}

function parseBodyChildDeliveries(
  documentTitle: string,
  lines: string[],
  h2: Heading,
  nextLine: number,
  children: Heading[],
  chapter: number,
  sections: ParsedSection[]
): void {
  if (children.length === 0) {
    throw new AppError(
      "author_style_body_expected_children",
      `expected H3 delivery sections under ${h2.title}`,
      3
    );
  }
  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const child = children[childIndex];
    const childNextLine = children[childIndex + 1]?.line ?? nextLine;
    const definition = bodyChildDefinition(chapter, child.title, childIndex);
    const sectionId = sectionIdFromContextKey(definition.contextKey);
    const markdown = sliceLines(lines, child.line, childNextLine - 1);
    sections.push(buildParsedSection({
      sectionId,
      contextKey: definition.contextKey,
      parentSectionId: null,
      deliverySectionId: sectionId,
      sectionType: "delivery",
      contentLayer: definition.contentLayer,
      contextPriority: definition.priority,
      headingLevel: 3,
      title: child.title,
      headingPath: [documentTitle, h2.title, child.title],
      aliases: [child.title, definition.contextKey],
      sourceLineStart: child.line,
      sourceLineEnd: childNextLine - 1,
      directMarkdown: markdown,
      deliveryMarkdown: markdown,
      isSearchable: true
    }));
  }
}

function bodyH2Definition(title: string, chapter: number | null): BodyDefinition {
  if (title === "Executive Summary") {
    return { contextKey: "ore-body/bootstrap", contentLayer: "runtime", priority: 70 };
  }
  const definitions: Record<number, BodyDefinition> = {
    1: { contextKey: "ore-body/evidence/data-quality", contentLayer: "evidence", priority: 30 },
    2: { contextKey: "ore-body/evidence/basic-dimensions", contentLayer: "evidence", priority: 30 },
    3: { contextKey: "ore-body/core/rhythm", contentLayer: "runtime", priority: 95 },
    4: { contextKey: "ore-body/core/tone", contentLayer: "runtime", priority: 95 },
    5: { contextKey: "ore-body/core/person", contentLayer: "runtime", priority: 90 },
    6: { contextKey: "ore-body/core/logic", contentLayer: "runtime", priority: 95 },
    7: { contextKey: "ore-body/core/certainty-emotion", contentLayer: "runtime", priority: 95 },
    8: { contextKey: "ore-body/core/notation", contentLayer: "runtime", priority: 90 },
    9: { contextKey: "ore-body/structure/opening", contentLayer: "runtime", priority: 95 },
    11: { contextKey: "ore-body/structure/closing", contentLayer: "runtime", priority: 95 },
    12: { contextKey: "ore-body/flow", contentLayer: "runtime", priority: 90 },
    13: { contextKey: "ore-body/reader-distance", contentLayer: "runtime", priority: 85 },
    14: { contextKey: "ore-body/evidence/structure-elements", contentLayer: "evidence", priority: 35 },
    15: { contextKey: "ore-body/profile/media", contentLayer: "profile", priority: 70 },
    16: { contextKey: "ore-body/profile/era", contentLayer: "profile", priority: 70 },
    17: { contextKey: "ore-body/contract", contentLayer: "runtime", priority: 100 },
    19: { contextKey: "ore-body/evaluator", contentLayer: "evaluation", priority: 100 },
    20: { contextKey: "ore-body/evidence/limitations", contentLayer: "evidence", priority: 20 },
    22: { contextKey: "ore-body/ops/references", contentLayer: "ops", priority: 20 }
  };
  const definition = chapter === null ? undefined : definitions[chapter];
  if (definition === undefined) {
    throw new AppError(
      "author_style_body_heading_unmapped",
      `unmapped body H2 heading: ${title}`,
      3
    );
  }
  return definition;
}

function bodyChildDefinition(chapter: number, title: string, index: number): BodyDefinition {
  if (chapter === 10) {
    const definitions = [
      { contextKey: "ore-body/composition/short-news", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/composition/explanatory", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/composition/review", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/composition/interview", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/composition/translation", contentLayer: "runtime", priority: 90 }
    ] satisfies BodyDefinition[];
    return requireIndexedDefinition(definitions, index, title);
  }
  if (chapter === 18) {
    const definitions = [
      { contextKey: "ore-body/mode/classic-short-news", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/mode/modern-explanatory", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/mode/review", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/mode/interview", contentLayer: "runtime", priority: 90 },
      { contextKey: "ore-body/mode/translation", contentLayer: "runtime", priority: 90 }
    ] satisfies BodyDefinition[];
    return requireIndexedDefinition(definitions, index, title);
  }
  const longformNumber = /^21\.(\d+)\s/.exec(title)?.[1];
  if (longformNumber === undefined) {
    throw new AppError(
      "author_style_body_longform_heading_unmapped",
      `unmapped longform heading: ${title}`,
      3
    );
  }
  if (longformNumber === "9") {
    return { contextKey: "ore-body/longform/contract", contentLayer: "runtime", priority: 90 };
  }
  if (longformNumber === "10") {
    return {
      contextKey: "ore-body/longform/anti-patterns",
      contentLayer: "evaluation",
      priority: 90
    };
  }
  return {
    contextKey: `ore-body/evidence/longform-${longformNumber.padStart(2, "0")}`,
    contentLayer: "evidence",
    priority: longformNumber === "11" ? 20 : 35
  };
}

function requireIndexedDefinition(
  definitions: readonly BodyDefinition[],
  index: number,
  title: string
): BodyDefinition {
  const definition = definitions[index];
  if (definition === undefined || index >= definitions.length) {
    throw new AppError(
      "author_style_body_child_count_mismatch",
      `unexpected body child heading: ${title}`,
      3
    );
  }
  return definition;
}

function titleRoutingManifest(): Record<string, unknown> {
  return {
    schemaVersion: AUTHOR_STYLE_ROUTING_VERSION,
    selectorSchema: {
      operations: ["generate", "evaluate"],
      modes: Object.keys(TITLE_MODE_KEYS),
      profiles: ["neutral", "classic", "modern"]
    },
    modeMap: TITLE_MODE_KEYS,
    operations: {
      generate: {
        base: [
          "ore-title/bootstrap",
          "ore-title/input-contract",
          "ore-title/core",
          "ore-title/notation",
          "ore-title/evaluator",
          "ore-title/output-contract"
        ]
      },
      evaluate: {
        base: ["ore-title/core", "ore-title/anti-patterns", "ore-title/evaluator"]
      }
    },
    profileMap: {
      neutral: [],
      classic: ["ore-title/router"],
      modern: ["ore-title/router"]
    },
    maxContextChars: 45_000,
    overflowPolicy: "error_no_truncation"
  };
}

function bodyRoutingManifest(): Record<string, unknown> {
  return {
    schemaVersion: AUTHOR_STYLE_ROUTING_VERSION,
    selectorSchema: {
      operations: ["generate", "edit-voice", "edit-structure", "evaluate"],
      modes: Object.keys(BODY_MODE_KEYS),
      lengthBands: ["le600", "601-1000", "1001-2000", "2001plus"],
      profiles: ["neutral", "classic", "modern", "media-specific"]
    },
    modeMap: BODY_MODE_KEYS,
    operations: {
      generate: {
        base: [
          "ore-body/contract",
          "ore-body/core/rhythm",
          "ore-body/core/tone",
          "ore-body/core/logic",
          "ore-body/core/certainty-emotion",
          "ore-body/core/notation",
          "ore-body/structure/opening",
          "ore-body/structure/closing",
          "ore-body/evaluator"
        ]
      },
      "edit-voice": {
        base: [
          "ore-body/contract",
          "ore-body/core/rhythm",
          "ore-body/core/tone",
          "ore-body/core/person",
          "ore-body/core/certainty-emotion",
          "ore-body/core/notation",
          "ore-body/reader-distance",
          "ore-body/evaluator"
        ]
      },
      "edit-structure": {
        base: [
          "ore-body/contract",
          "ore-body/structure/opening",
          "ore-body/flow",
          "ore-body/structure/closing",
          "ore-body/evaluator"
        ]
      },
      evaluate: {
        base: ["ore-body/contract", "ore-body/evaluator"]
      }
    },
    lengthBandMap: {
      le600: [],
      "601-1000": ["ore-body/longform/contract"],
      "1001-2000": ["ore-body/longform/contract"],
      "2001plus": ["ore-body/longform/contract", "ore-body/longform/anti-patterns"]
    },
    profileMap: {
      neutral: [],
      classic: ["ore-body/profile/era"],
      modern: ["ore-body/profile/era"],
      "media-specific": ["ore-body/profile/media"]
    },
    maxContextChars: 45_000,
    overflowPolicy: "error_no_truncation"
  };
}

function compactBodyRoutingManifest(): Record<string, unknown> {
  return {
    schemaVersion: COMPACT_BODY_ROUTING_VERSION,
    selectorSchema: {
      operations: ["generate", "edit-voice", "edit-structure", "evaluate"],
      modes: Object.keys(COMPACT_BODY_MODE_KEYS),
      lengthBands: ["le600", "601-1000", "1001-2000", "2001plus"],
      profiles: ["neutral", "classic", "modern", "media-specific"]
    },
    modeMap: COMPACT_BODY_MODE_KEYS,
    operations: {
      generate: {
        base: [
          "ore-body/contract",
          "ore-body/core/rhythm",
          "ore-body/core/tone",
          "ore-body/core/logic",
          "ore-body/core/certainty-emotion",
          "ore-body/core/notation",
          "ore-body/structure/opening",
          "ore-body/structure/closing",
          "ore-body/evaluator"
        ]
      },
      "edit-voice": {
        base: [
          "ore-body/contract",
          "ore-body/core/rhythm",
          "ore-body/core/tone",
          "ore-body/core/person",
          "ore-body/core/certainty-emotion",
          "ore-body/core/notation",
          "ore-body/reader-distance",
          "ore-body/evaluator"
        ]
      },
      "edit-structure": {
        base: [
          "ore-body/contract",
          "ore-body/structure/opening",
          "ore-body/flow",
          "ore-body/structure/closing",
          "ore-body/evaluator"
        ]
      },
      evaluate: {
        base: ["ore-body/contract", "ore-body/evaluator"]
      }
    },
    lengthBandMap: {
      le600: [],
      "601-1000": ["ore-body/longform/guidance", "ore-body/longform/contract"],
      "1001-2000": ["ore-body/longform/guidance", "ore-body/longform/contract"],
      "2001plus": [
        "ore-body/longform/guidance",
        "ore-body/longform/contract",
        "ore-body/longform/anti-patterns"
      ]
    },
    profileMap: {
      neutral: [],
      classic: [],
      modern: [],
      "media-specific": []
    },
    maxContextChars: 45_000,
    overflowPolicy: "error_no_truncation"
  };
}

function buildParsedSection(input: Omit<ParsedSection, "contentChars" | "estimatedTokens" | "retrievalText">): ParsedSection {
  return {
    ...input,
    contentChars: input.deliveryMarkdown.length,
    estimatedTokens: null,
    retrievalText: contextualize(input.headingPath, input.directMarkdown)
  };
}

function classifyTitleContextKey(contextKey: string): {
  layer: AuthorStyleContentLayer;
  priority: number;
} {
  if (contextKey === "ore-title/evidence") return { layer: "evidence", priority: 20 };
  if (contextKey === "ore-title/retrieval-ops" || contextKey === "ore-title/maintenance") {
    return { layer: "ops", priority: 20 };
  }
  if (contextKey === "ore-title/anti-patterns" || contextKey === "ore-title/evaluator") {
    return { layer: "evaluation", priority: 95 };
  }
  return { layer: "runtime", priority: contextKey === "ore-title/core" ? 100 : 90 };
}

function assertRoutingReferences(
  sections: ParsedSection[],
  manifest: Record<string, unknown>,
  documentId: string
): void {
  const available = new Set(
    sections.flatMap((section) => section.contextKey === null ? [] : [section.contextKey])
  );
  const referenced = collectContextKeys(manifest);
  const missing = [...referenced].filter((key) => !available.has(key));
  if (missing.length > 0) {
    throw new AppError(
      "author_style_routing_reference_missing",
      `${documentId} routing references missing context keys: ${missing.join(", ")}`,
      3
    );
  }
}

function collectContextKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.startsWith("ore-title/") || value.startsWith("ore-body/")) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContextKeys(item, found);
    return found;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectContextKeys(item, found);
  }
  return found;
}

function assertSections(sections: AuthorStyleSection[], documentId: string): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const section of sections) {
    if (!/^[A-Za-z0-9._~-]+$/.test(section.sectionId)) {
      throw new AppError("author_style_invalid_section_id", `invalid section id: ${section.sectionId}`, 3);
    }
    if (ids.has(section.sectionId)) {
      throw new AppError("author_style_duplicate_section_id", `duplicate section id: ${section.sectionId}`, 3);
    }
    ids.add(section.sectionId);
    if (section.contextKey !== null) {
      if (keys.has(section.contextKey)) {
        throw new AppError(
          "author_style_duplicate_context_key",
          `duplicate context key: ${section.contextKey}`,
          3
        );
      }
      keys.add(section.contextKey);
    }
  }
  for (const section of sections) {
    if (!ids.has(section.deliverySectionId)) {
      throw new AppError(
        "author_style_missing_delivery_section",
        `${documentId} section ${section.sectionId} references missing delivery ${section.deliverySectionId}`,
        3
      );
    }
  }
}

function assertStorageLimits(markdown: string, sections: AuthorStyleSection[]): void {
  if (Buffer.byteLength(markdown, "utf8") > MEDIUMTEXT_MAX_BYTES) {
    throw new AppError("author_style_document_too_large", "author style document exceeds MEDIUMTEXT", 3);
  }
  for (const section of sections) {
    for (const [field, value] of [
      ["direct_markdown", section.directMarkdown],
      ["delivery_markdown", section.deliveryMarkdown],
      ["retrieval_text", section.retrievalText]
    ] as const) {
      if (Buffer.byteLength(value, "utf8") > MEDIUMTEXT_MAX_BYTES) {
        throw new AppError(
          "author_style_section_too_large",
          `${section.sectionId} ${field} exceeds MEDIUMTEXT`,
          3
        );
      }
    }
  }
}

function extractContextKey(markdown: string, title: string): string {
  const match = /`context-key:\s*([^`\s]+)\s*`/.exec(markdown);
  if (match?.[1] === undefined) {
    throw new AppError(
      "author_style_context_key_missing",
      `missing context-key under title section: ${title}`,
      3
    );
  }
  return match[1];
}

function bodyChapterNumber(title: string): number | null {
  const match = /^(\d+)\.\s/.exec(title);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function sectionIdFromContextKey(contextKey: string): string {
  return contextKey.replace(/^ore-(?:title|body)\//, "").replace(/\//g, "--");
}

function uniqueChildId(parentId: string, title: string, used: Set<string>): string {
  const base = `${parentId}--${asciiSlug(title)}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function asciiSlug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized.length > 0 ? normalized : `section-${sha256(value).slice(0, 12)}`;
}

function scanMarkdownHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    headings.push({ level: match[1].length, title: match[2], line: index + 1 });
  }
  return headings;
}

function requireDocumentTitle(headings: Heading[], documentId: string): string {
  const h1 = headings.find((heading) => heading.level === 1);
  if (h1 === undefined) {
    throw new AppError("author_style_title_missing", `missing H1 for ${documentId}`, 3);
  }
  return h1.title;
}

function splitContentLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  if (markdown.endsWith("\n")) lines.pop();
  return lines;
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

function contextualize(pathParts: string[], markdown: string): string {
  return `${pathParts.join(" > ")}\n\n${markdown}`;
}
