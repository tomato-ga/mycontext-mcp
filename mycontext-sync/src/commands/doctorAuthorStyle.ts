import { isDeepStrictEqual } from "node:util";
import {
  AUTHOR_STYLE_DOCUMENTS,
  parseAuthorStyleMarkdown
} from "../authorStyle.js";
import {
  buildAuthorStyleContext,
  enumerateAuthorStyleSelectors,
  parseAuthorStyleRoutingManifest
} from "../authorStyleRouting.js";
import { sha256 } from "../hash.js";
import { createTidbClientFromEnv } from "../tidb.js";
import { errorMessage, type CliFlags } from "../types.js";

type DoctorStatus =
  | "ok"
  | "source_invalid"
  | "missing_tidb_document"
  | "document_mismatch"
  | "snapshot_mismatch"
  | "section_count_mismatch"
  | "section_mismatch"
  | "routing_invalid";

export async function runDoctorAuthorStyle(_flags: CliFlags): Promise<void> {
  const client = createTidbClientFromEnv();
  const results: Array<Record<string, unknown>> = [];

  try {
    await client.ping();
    for (const source of AUTHOR_STYLE_DOCUMENTS) {
      try {
        const storedDocument = await client.getAuthorStyleDocument(source.documentId);
        if (storedDocument === null) {
          results.push({
            documentId: source.documentId,
            status: "missing_tidb_document" satisfies DoctorStatus,
            warnings: []
          });
          continue;
        }
        const reparsed = parseAuthorStyleMarkdown({
          source,
          markdown: storedDocument.source_markdown,
          sourcePathKey: storedDocument.source_path_key,
          sourceMtimeMs: Number(storedDocument.source_mtime_ms)
        });
        const rows = await client.listAuthorStyleSections(source.documentId);

        const documentMatches = storedDocument.author_key === reparsed.authorKey
          && storedDocument.style_scope === reparsed.styleScope
          && storedDocument.display_name === reparsed.displayName
          && storedDocument.source_path_key === reparsed.sourcePathKey
          && storedDocument.source_path_key.startsWith("notion:")
          && storedDocument.status === "active";
        const snapshotMatches = storedDocument.context_sha256 === reparsed.revisionSha256
          && storedDocument.source_markdown === reparsed.sourceMarkdown
          && storedDocument.source_markdown_sha256 === reparsed.sourceMarkdownSha256
          && sha256(storedDocument.source_markdown) === storedDocument.source_markdown_sha256
          && Number(storedDocument.source_bytes) === reparsed.sourceBytes
          && Number(storedDocument.source_line_count) === reparsed.sourceLineCount
          && storedDocument.parser_version === reparsed.parserVersion
          && storedDocument.sectioning_version === reparsed.sectioningVersion
          && storedDocument.routing_version === reparsed.routingVersion
          && jsonEquivalent(storedDocument.routing_manifest_json, reparsed.routingManifest)
          && jsonEquivalent(storedDocument.outline_json, reparsed.outline)
          && Number(storedDocument.section_count) === reparsed.sectionCount
          && Number(storedDocument.delivery_section_count) === reparsed.deliverySectionCount
          && Number(storedDocument.search_span_count) === reparsed.searchSpanCount;

        const reparsedById = new Map(reparsed.sections.map((section) => [section.sectionId, section]));
        const sectionsMatch = rows.every((row) => {
          const expected = reparsedById.get(row.section_id);
          return expected !== undefined
            && row.context_key === expected.contextKey
            && row.parent_section_id === expected.parentSectionId
            && row.delivery_section_id === expected.deliverySectionId
            && row.section_type === expected.sectionType
            && row.content_layer === expected.contentLayer
            && Number(row.context_priority) === expected.contextPriority
            && nullableNumber(row.heading_level) === expected.headingLevel
            && row.title === expected.title
            && stringArrayEquivalent(row.heading_path_json, expected.headingPath)
            && stringArrayEquivalent(row.aliases_json, expected.aliases)
            && Number(row.ordinal) === expected.ordinal
            && Number(row.source_line_start) === expected.sourceLineStart
            && Number(row.source_line_end) === expected.sourceLineEnd
            && Number(row.content_chars) === expected.contentChars
            && nullableNumber(row.estimated_tokens) === expected.estimatedTokens
            && row.direct_markdown === expected.directMarkdown
            && row.delivery_markdown === expected.deliveryMarkdown
            && row.retrieval_text === expected.retrievalText
            && row.content_sha256 === expected.contentSha256
            && sha256(row.direct_markdown) === row.content_sha256
            && booleanLike(row.is_searchable) === expected.isSearchable;
        });

        let routingStatus: DoctorStatus = "ok";
        let minimumContextChars: number | null = null;
        let maximumContextChars: number | null = null;
        let routingCombinations = 0;
        let routingWarning: string | null = null;
        try {
          const manifest = parseAuthorStyleRoutingManifest(reparsed.routingManifest);
          const contextSections = new Map(reparsed.sections.flatMap((section) => {
            return section.contextKey === null ? [] : [[section.contextKey, {
              contextKey: section.contextKey,
              title: section.title,
              markdown: section.deliveryMarkdown
            }] as const];
          }));
          for (const selectors of enumerateAuthorStyleSelectors(manifest)) {
            const context = buildAuthorStyleContext({
              documentId: reparsed.documentId,
              displayName: reparsed.displayName,
              revisionSha256: reparsed.revisionSha256,
              manifest,
              selectors,
              sections: contextSections
            });
            routingCombinations += 1;
            minimumContextChars = minimumContextChars === null
              ? context.contextChars
              : Math.min(minimumContextChars, context.contextChars);
            maximumContextChars = maximumContextChars === null
              ? context.contextChars
              : Math.max(maximumContextChars, context.contextChars);
          }
        } catch (error) {
          routingStatus = "routing_invalid";
          routingWarning = errorMessage(error);
        }

        const status: DoctorStatus = !documentMatches
          ? "document_mismatch"
          : !snapshotMatches
            ? "snapshot_mismatch"
            : rows.length !== reparsed.sectionCount
              ? "section_count_mismatch"
              : !sectionsMatch
                ? "section_mismatch"
                : routingStatus;
        results.push({
          documentId: source.documentId,
          displayName: reparsed.displayName,
          status,
          sourceMarkdownSha256: reparsed.sourceMarkdownSha256,
          contextSha256: storedDocument.context_sha256,
          expectedSections: reparsed.sectionCount,
          storedSections: rows.length,
          expectedDeliverySections: reparsed.deliverySectionCount,
          storedDeliverySections: rows.filter((row) => row.section_type === "delivery").length,
          expectedSearchSpans: reparsed.searchSpanCount,
          storedSearchSpans: rows.filter((row) => row.section_type === "search_span").length,
          routingCombinations,
          minimumContextChars,
          maximumContextChars,
          maxContextChars: parseAuthorStyleRoutingManifest(reparsed.routingManifest).maxContextChars,
          sourceMtimeMs: reparsed.sourceMtimeMs,
          warnings: routingWarning === null ? [] : [routingWarning]
        });
      } catch (error) {
        results.push({
          documentId: source.documentId,
          status: "source_invalid" satisfies DoctorStatus,
          warnings: [errorMessage(error)]
        });
      }
    }
  } finally {
    await client.close();
  }

  const failed = results.some((result) => result.status !== "ok");
  console.log(JSON.stringify({ status: failed ? "failed" : "ok", documents: results }, null, 2));
  if (failed) process.exitCode = 2;
}

function booleanLike(value: boolean | number): boolean {
  return value === true || value === 1;
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function jsonEquivalent(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(parseJson(actual), expected);
}

function stringArrayEquivalent(actual: string | string[], expected: string[]): boolean {
  const parsed = parseJson(actual);
  return Array.isArray(parsed)
    && parsed.every((item) => typeof item === "string")
    && JSON.stringify(parsed) === JSON.stringify(expected);
}
