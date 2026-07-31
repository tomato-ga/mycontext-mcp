import { connect, type Row as TidbRow } from "@tidbcloud/serverless";
import {
  AuthorStyleContextTooLargeError,
  buildAuthorStyleDocumentUri,
  buildAuthorStyleSectionUri,
  parseAuthorStyleRoutingManifest,
  resolveAuthorStyleContextKeys,
  type AuthorStyleDocumentId,
  type AuthorStyleSelectors
} from "./authorStyle.js";
import { buildBusinessKnowledgeSectionUri } from "./businessKnowledge.js";
import {
  buildEditingPlaybookResourceUri,
  EDITING_PLAYBOOK_DOCUMENT_ID,
  EDITING_PLAYBOOK_SOURCE_ID,
  EditingPlaybookContextError,
  EditingPlaybookContextTooLargeError,
  MAX_EDITING_PLAYBOOK_CONTEXT_CHARS,
  type EditingPlaybookContext
} from "./editingPlaybook.js";
import { resolveEditorTrainingSearchIntent } from "./editorTrainingSearchIntent.js";
import { buildEditorKnowledgeSectionUri } from "./editorKnowledge.js";
import {
  MetaskillContextTooLargeError,
  buildMetaskillDocumentUri,
  buildMetaskillSectionUri,
  maxMetaskillContextChars,
  parseMetaskillRoutingManifest,
  resolveMetaskillContextKeys,
  type MetaskillDocumentId,
  type MetaskillSelectors
} from "./metaskill.js";
import {
  buildMediaPlaybookResourceUri,
  MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS,
  MEDIA_PLAYBOOK_DOCUMENT_ID,
  MEDIA_PLAYBOOK_SOURCE_ID,
  MediaPlaybookContextError,
  MediaPlaybookContextTooLargeError,
  type MediaPlaybookContext
} from "./mediaPlaybook.js";
import {
  buildSearchQueryPlan,
  normalizeSearchText,
  EMPTY_PERSONAL_SYNONYM_CONFIG,
  type PersonalSynonymConfig
} from "./searchQuery.js";
import { getSkillContextDocument } from "./skillContext.js";
import { resolveSkillContextSearchIntent } from "./skillContextSearchIntent.js";
import {
  buildPlanningPlaybookResourceUri,
  MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS,
  PLANNING_PLAYBOOK_DOCUMENT_ID,
  PLANNING_PLAYBOOK_SOURCE_ID,
  PlanningPlaybookContextError,
  PlanningPlaybookContextTooLargeError,
  type PlanningPlaybookContext
} from "./planningPlaybook.js";
import { resolvePlaybookSearchIntent } from "./playbookSearchIntent.js";

export type DocumentSource =
  | "notion"
  | "editor_knowledge"
  | "business_knowledge"
  | "skill_context";

export interface ListedDocument {
  document_id: string;
  source: DocumentSource;
  source_id: string;
  title: string | null;
  markdown_sha256: string;
  source_kind: string | null;
  ingest_scope: string | null;
  source_declared_at: string | null;
  detail_available: boolean | null;
  section_revision_sha256: string | null;
  section_count: number | null;
  search_span_count: number | null;
  source_truncated: boolean;
  last_synced_at: string | null;
}

export interface SearchContextHit {
  document_id: string;
  source: DocumentSource;
  title: string | null;
  text: string;
  match_position: number;
  matched_terms: string[];
  score: number;
  search_stage: "intent" | "phrase" | "keywords" | "synonyms";
  matched_span_position?: number;
  matched_section_id?: string;
  matched_section_title?: string;
  matched_content_layer?: string;
  delivery_section_id?: string;
  delivery_section_title?: string;
  delivery_content_layer?: string;
  heading_path?: string[];
  source_line_start?: number;
  source_line_end?: number;
  delivery_line_start?: number;
  delivery_line_end?: number;
  related_source_path?: string | null;
  freshness_class?: string | null;
  source_kind?: string;
  ingest_scope?: string;
  source_declared_at?: string | null;
  detail_available?: boolean | null;
  resource_uri?: string;
}

export type SearchTextHit = SearchContextHit;

export interface FullDocument {
  document_id: string;
  source: DocumentSource;
  source_id: string;
  title: string | null;
  markdown: string;
  markdown_sha256: string;
  source_kind: string | null;
  ingest_scope: string | null;
  source_declared_at: string | null;
  detail_available: boolean | null;
  section_revision_sha256: string | null;
  section_count: number | null;
  search_span_count: number | null;
  source_truncated: boolean;
  unknown_block_ids: string[];
  last_synced_at: string | null;
}

export interface HealthCheckResult extends Record<string, unknown> {
  ok: boolean;
  db: "ok" | "error";
  notion_documents_count?: number;
  editor_knowledge_documents_count?: number;
  business_knowledge_documents_count?: number;
  business_knowledge_sections_count?: number;
  business_knowledge_search_spans_count?: number;
  author_style_documents_count?: number;
  author_style_sections_count?: number;
  author_style_search_spans_count?: number;
  metaskill_documents_count?: number;
  metaskill_sections_count?: number;
  metaskill_search_spans_count?: number;
  documents_count?: number;
  latest_synced_at?: string | null;
}

export interface AuthorStyleContextPack {
  document_id: AuthorStyleDocumentId;
  display_name: string;
  revision_sha256: string;
  routing_version: string;
  selectors: Omit<AuthorStyleSelectors, "documentId">;
  context_keys: string[];
  context_chars: number;
  markdown: string;
  source_resource_uri: string;
  section_resource_uris: string[];
}

export interface AuthorStyleEvidenceHit {
  document_id: AuthorStyleDocumentId;
  revision_sha256: string;
  matched_section_id: string;
  matched_section_title: string;
  matched_content_layer: string;
  delivery_section_id: string;
  delivery_section_title: string;
  delivery_context_key: string | null;
  heading_path: string[];
  source_line_start: number;
  source_line_end: number;
  matched_position: number;
  markdown: string;
  resource_uri: string;
}

export interface AuthorStyleDocumentResource {
  document_id: AuthorStyleDocumentId;
  display_name: string;
  revision_sha256: string;
  source_markdown_sha256: string;
  markdown: string;
  resource_uri: string;
}

export interface ListedAuthorStyleResource {
  document_id: AuthorStyleDocumentId;
  revision_sha256: string;
  section_id: string;
  context_key: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  size_bytes: number;
  resource_uri: string;
}

export interface AuthorStyleSectionResource extends ListedAuthorStyleResource {
  markdown: string;
  source_line_start: number;
  source_line_end: number;
}

export interface MetaskillContextPack {
  document_id: MetaskillDocumentId;
  display_name: string;
  revision_sha256: string;
  routing_version: string;
  selectors: Omit<MetaskillSelectors, "documentId">;
  context_keys: string[];
  context_chars: number;
  markdown: string;
  source_resource_uri: string;
  section_resource_uris: string[];
}

export interface MetaskillEvidenceHit {
  document_id: MetaskillDocumentId;
  revision_sha256: string;
  matched_section_id: string;
  matched_section_title: string;
  matched_content_layer: string;
  delivery_section_id: string;
  delivery_section_title: string;
  delivery_context_key: string | null;
  heading_path: string[];
  source_line_start: number;
  source_line_end: number;
  matched_position: number;
  markdown: string;
  resource_uri: string;
}

export interface MetaskillDocumentResource {
  document_id: MetaskillDocumentId;
  display_name: string;
  revision_sha256: string;
  source_markdown_sha256: string;
  markdown: string;
  resource_uri: string;
}

export interface ListedMetaskillResource {
  document_id: MetaskillDocumentId;
  revision_sha256: string;
  section_id: string;
  context_key: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  size_bytes: number;
  resource_uri: string;
}

export interface MetaskillSectionResource extends ListedMetaskillResource {
  markdown: string;
  source_line_start: number;
  source_line_end: number;
}

export interface TidbClient {
  execute(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

export interface BusinessKnowledgeResource {
  document_id: string;
  section_id: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  markdown: string;
  source_line_start: number;
  source_line_end: number;
  related_source_path: string | null;
  freshness_class: string | null;
  source_kind: string;
  ingest_scope: string;
  source_declared_at: string | null;
  detail_available: boolean | null;
  resource_uri: string;
}

export interface ListedBusinessKnowledgeResource {
  document_id: string;
  section_id: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  size_bytes: number;
  related_source_path: string | null;
  freshness_class: string | null;
  source_kind: string;
  ingest_scope: string;
  source_declared_at: string | null;
  detail_available: boolean | null;
  resource_uri: string;
}

export interface EditorKnowledgeResource {
  document_id: string;
  section_id: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  markdown: string;
  source_line_start: number;
  source_line_end: number;
  related_source_path: string | null;
  freshness_class: string | null;
  resource_uri: string;
}

export interface ListedEditorKnowledgeResource {
  document_id: string;
  section_id: string;
  title: string;
  heading_path: string[];
  content_layer: string;
  size_bytes: number;
  related_source_path: string | null;
  freshness_class: string | null;
  resource_uri: string;
}

export class DataShapeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataShapeError";
  }
}

export class TopKValidationError extends RangeError {
  constructor(maxTopK = MAX_TOP_K) {
    super(`topK must be an integer from 1 to ${maxTopK}`);
    this.name = "TopKValidationError";
  }
}

const MAX_TOP_K = 20;

const DOCUMENT_READ_MODEL_SQL = `SELECT
        CONCAT('notion:', page_id) AS document_id,
        'notion' AS source,
        page_id AS source_id,
        title,
        markdown,
        markdown_sha256,
        NULL AS source_kind,
        NULL AS ingest_scope,
        NULL AS source_declared_at,
        NULL AS detail_available,
        NULL AS section_revision_sha256,
        NULL AS section_count,
        NULL AS search_span_count,
        truncated AS source_truncated,
        unknown_block_ids,
        last_synced_at
      FROM notion_pages
      UNION ALL
      SELECT
        CONCAT('editor-knowledge:', document_id) AS document_id,
        'editor_knowledge' AS source,
        document_id AS source_id,
        title,
        markdown,
        markdown_sha256,
        NULL AS source_kind,
        NULL AS ingest_scope,
        NULL AS source_declared_at,
        NULL AS detail_available,
        section_revision_sha256,
        section_count,
        search_span_count,
        FALSE AS source_truncated,
        JSON_ARRAY() AS unknown_block_ids,
        last_synced_at
      FROM editor_knowledge_documents
      UNION ALL
      SELECT
        CONCAT('business-knowledge:', document_id) AS document_id,
        'business_knowledge' AS source,
        document_id AS source_id,
        title,
        markdown,
        markdown_sha256,
        source_kind,
        ingest_scope,
        source_declared_at,
        JSON_UNQUOTE(JSON_EXTRACT(routing_metadata_json, '$.detailAvailable')) AS detail_available,
        section_revision_sha256,
        section_count,
        search_span_count,
        FALSE AS source_truncated,
        JSON_ARRAY() AS unknown_block_ids,
        last_synced_at
      FROM business_knowledge_documents`;

export function createTidbClient(databaseUrl: string): TidbClient {
  const connection = connect({ url: databaseUrl });

  return {
    async execute(sql, params = []) {
      const rows = await connection.execute(sql, [...params]);
      return rows.map(toRecordRow);
    }
  };
}

export async function listDocuments(client: TidbClient): Promise<ListedDocument[]> {
  const rows = await client.execute(
    `SELECT
        document_id,
        source,
        source_id,
        title,
        markdown_sha256,
        source_kind,
        ingest_scope,
        source_declared_at,
        detail_available,
        section_revision_sha256,
        section_count,
        search_span_count,
        source_truncated,
        last_synced_at
      FROM (${DOCUMENT_READ_MODEL_SQL}) AS documents
      ORDER BY last_synced_at DESC, document_id ASC`
  );

  return rows.map((row) => ({
    document_id: parseRequiredString(row.document_id, "document_id"),
    source: parseDocumentSource(row.source),
    source_id: parseRequiredString(row.source_id, "source_id"),
    title: parseNullableString(row.title, "title"),
    markdown_sha256: parseRequiredString(row.markdown_sha256, "markdown_sha256"),
    source_kind: parseNullableString(row.source_kind, "source_kind"),
    ingest_scope: parseNullableString(row.ingest_scope, "ingest_scope"),
    source_declared_at: parseSourceDeclaredAt(row.source_declared_at),
    detail_available: parseNullableBoolean(row.detail_available, "detail_available"),
    section_revision_sha256: parseNullableString(row.section_revision_sha256, "section_revision_sha256"),
    section_count: parseNullableNumber(row.section_count, "section_count"),
    search_span_count: parseNullableNumber(row.search_span_count, "search_span_count"),
    source_truncated: parseBoolean(row.source_truncated, "source_truncated"),
    last_synced_at: dateToIsoString(row.last_synced_at)
  }));
}

export async function searchContext(
  client: TidbClient,
  query: string,
  topK: number,
  personalSynonyms: PersonalSynonymConfig = EMPTY_PERSONAL_SYNONYM_CONFIG
): Promise<SearchContextHit[]> {
  const limitedTopK = validateTopK(topK);
  const skillIntent = resolveSkillContextSearchIntent(query);
  if (skillIntent !== null) {
    const skillContext = await getSkillContextDocument(client, skillIntent.skillId);
    if (skillContext !== null) {
      return [{
        document_id: skillIntent.documentId,
        source: "skill_context",
        title: skillContext.title,
        text: skillContext.markdown,
        match_position: 1,
        matched_terms: [skillIntent.skillId],
        score: 1000,
        search_stage: "intent",
        resource_uri: skillIntent.resourceUri
      }];
    }
  }
  const canonicalIntent =
    resolvePlaybookSearchIntent(query) ??
    resolveEditorTrainingSearchIntent(query);
  if (canonicalIntent !== null) {
    const document = await getDocument(client, canonicalIntent.documentId);
    if (document !== null) {
      return [{
        document_id: document.document_id,
        source: document.source,
        title: document.title,
        text: document.markdown,
        match_position: 1,
        matched_terms: [canonicalIntent.canonicalTitle],
        score: 1000,
        search_stage: "intent",
        resource_uri: canonicalIntent.resourceUri
      }];
    }
  }
  const plan = buildSearchQueryPlan(query, personalSynonyms);
  const likePattern = buildLikePattern(plan.phrase);
  const phraseRows = await client.execute(
    buildSearchSql(limitedTopK),
    [plan.phrase, plan.phrase, likePattern, plan.phrase, plan.phrase, likePattern, plan.phrase, likePattern]
  );
  if (phraseRows.length > 0) {
    return phraseRows.map((row) =>
      enrichSearchHit(parseSearchContextHit(row), [plan.phrase], "phrase", 100)
    );
  }

  if (plan.terms.length > 0) {
    const keywordRows = await client.execute(
      buildKeywordSearchSql(plan.terms.length, limitedTopK),
      buildKeywordSearchParams(plan.terms)
    );
    if (keywordRows.length > 0) {
      return keywordRows.map((row) =>
        enrichSearchHit(
          parseSearchContextHit(row),
          plan.terms,
          "keywords",
          parseOptionalNumber(row.search_score) ?? 1
        )
      );
    }
  }

  const synonymTerms = plan.synonymTerms.filter((term) =>
    !plan.terms.some((original) => equalSearchText(original, term))
  );
  if (synonymTerms.length === 0) {
    return [];
  }

  const fallbackTerms = synonymTerms.slice(0, 8);
  const synonymRows = await client.execute(
    buildKeywordSearchSql(fallbackTerms.length, limitedTopK),
    buildKeywordSearchParams(fallbackTerms)
  );
  return synonymRows.map((row) =>
    enrichSearchHit(
      parseSearchContextHit(row),
      fallbackTerms,
      "synonyms",
      parseOptionalNumber(row.search_score) ?? 1
    )
  );
}

export async function searchText(
  client: TidbClient,
  query: string,
  topK: number,
  personalSynonyms: PersonalSynonymConfig = EMPTY_PERSONAL_SYNONYM_CONFIG
): Promise<SearchTextHit[]> {
  return searchContext(client, query, topK, personalSynonyms);
}

export async function getDocument(client: TidbClient, documentId: string): Promise<FullDocument | null> {
  const rows = await client.execute(
    `SELECT
        document_id,
        source,
        source_id,
        title,
        markdown,
        markdown_sha256,
        source_kind,
        ingest_scope,
        source_declared_at,
        detail_available,
        section_revision_sha256,
        section_count,
        search_span_count,
        source_truncated,
        unknown_block_ids,
        last_synced_at
      FROM (${DOCUMENT_READ_MODEL_SQL}) AS documents
      WHERE document_id = ?
      LIMIT 1`,
    [documentId]
  );

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  return {
    document_id: parseRequiredString(row.document_id, "document_id"),
    source: parseDocumentSource(row.source),
    source_id: parseRequiredString(row.source_id, "source_id"),
    title: parseNullableString(row.title, "title"),
    markdown: parseRequiredString(row.markdown, "markdown"),
    markdown_sha256: parseRequiredString(row.markdown_sha256, "markdown_sha256"),
    source_kind: parseNullableString(row.source_kind, "source_kind"),
    ingest_scope: parseNullableString(row.ingest_scope, "ingest_scope"),
    source_declared_at: parseSourceDeclaredAt(row.source_declared_at),
    detail_available: parseNullableBoolean(row.detail_available, "detail_available"),
    section_revision_sha256: parseNullableString(row.section_revision_sha256, "section_revision_sha256"),
    section_count: parseNullableNumber(row.section_count, "section_count"),
    search_span_count: parseNullableNumber(row.search_span_count, "search_span_count"),
    source_truncated: parseBoolean(row.source_truncated, "source_truncated"),
    unknown_block_ids: parseStringArray(row.unknown_block_ids, "unknown_block_ids"),
    last_synced_at: dateToIsoString(row.last_synced_at)
  };
}

export async function getPlanningPlaybookContext(
  client: TidbClient
): Promise<PlanningPlaybookContext | null> {
  const rows = await client.execute(
    `SELECT
        document_id,
        title,
        markdown,
        markdown_sha256,
        section_revision_sha256,
        section_count,
        search_span_count,
        last_synced_at
      FROM editor_knowledge_documents
      WHERE document_id = ?
      LIMIT 1`,
    [PLANNING_PLAYBOOK_SOURCE_ID]
  );

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  try {
    const documentId = parseRequiredString(row.document_id, "document_id");
    if (documentId !== PLANNING_PLAYBOOK_SOURCE_ID) {
      throw new PlanningPlaybookContextError(
        `planning playbook document_id must be ${PLANNING_PLAYBOOK_SOURCE_ID}`
      );
    }
    const markdown = parseRequiredString(row.markdown, "markdown");
    if (markdown.length > MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS) {
      throw new PlanningPlaybookContextTooLargeError(
        markdown.length,
        MAX_PLANNING_PLAYBOOK_CONTEXT_CHARS
      );
    }
    const revisionSha256 = parseRequiredString(
      row.section_revision_sha256,
      "section_revision_sha256"
    );
    const sectionCount = parseNumber(row.section_count, "section_count");
    const searchSpanCount = parseNumber(row.search_span_count, "search_span_count");
    if (!Number.isInteger(sectionCount) || sectionCount < 1) {
      throw new PlanningPlaybookContextError("planning playbook section_count must be positive");
    }
    if (searchSpanCount !== sectionCount) {
      throw new PlanningPlaybookContextError(
        `planning playbook must make every chapter searchable: section_count=${sectionCount}, search_span_count=${searchSpanCount}`
      );
    }

    return {
      document_id: PLANNING_PLAYBOOK_DOCUMENT_ID,
      title: parseRequiredString(row.title, "title"),
      markdown_sha256: parseRequiredString(row.markdown_sha256, "markdown_sha256"),
      revision_sha256: revisionSha256,
      section_count: sectionCount,
      search_span_count: searchSpanCount,
      context_chars: markdown.length,
      retrieval_mode: "full_playbook",
      truncated: false,
      last_synced_at: dateToIsoString(row.last_synced_at),
      source_resource_uri: buildPlanningPlaybookResourceUri(),
      markdown
    };
  } catch (error) {
    if (
      error instanceof PlanningPlaybookContextError
      || error instanceof PlanningPlaybookContextTooLargeError
    ) {
      throw error;
    }
    throw new PlanningPlaybookContextError(
      `planning playbook state is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function getEditingPlaybookContext(
  client: TidbClient
): Promise<EditingPlaybookContext | null> {
  try {
    const context = await getWholeDocumentPlaybookContext(client, {
      sourceId: EDITING_PLAYBOOK_SOURCE_ID,
      maximumChars: MAX_EDITING_PLAYBOOK_CONTEXT_CHARS,
      invalidState: (message) => new EditingPlaybookContextError(message),
      tooLarge: (actual, maximum) =>
        new EditingPlaybookContextTooLargeError(actual, maximum)
    });
    return context === null ? null : {
      ...context,
      document_id: EDITING_PLAYBOOK_DOCUMENT_ID,
      source_resource_uri: buildEditingPlaybookResourceUri()
    };
  } catch (error) {
    if (
      error instanceof EditingPlaybookContextError
      || error instanceof EditingPlaybookContextTooLargeError
    ) {
      throw error;
    }
    throw new EditingPlaybookContextError(
      `editing playbook state is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function getMediaPlaybookContext(
  client: TidbClient
): Promise<MediaPlaybookContext | null> {
  try {
    const context = await getWholeDocumentPlaybookContext(client, {
      sourceId: MEDIA_PLAYBOOK_SOURCE_ID,
      maximumChars: MAX_MEDIA_PLAYBOOK_CONTEXT_CHARS,
      invalidState: (message) => new MediaPlaybookContextError(message),
      tooLarge: (actual, maximum) =>
        new MediaPlaybookContextTooLargeError(actual, maximum)
    });
    return context === null ? null : {
      ...context,
      document_id: MEDIA_PLAYBOOK_DOCUMENT_ID,
      source_resource_uri: buildMediaPlaybookResourceUri()
    };
  } catch (error) {
    if (
      error instanceof MediaPlaybookContextError
      || error instanceof MediaPlaybookContextTooLargeError
    ) {
      throw error;
    }
    throw new MediaPlaybookContextError(
      `media playbook state is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

interface WholeDocumentPlaybookContextRow {
  title: string;
  markdown_sha256: string;
  revision_sha256: string;
  storage_mode: "whole_document";
  record_count: 1;
  section_count: 0;
  search_span_count: 1;
  context_chars: number;
  retrieval_mode: "full_playbook";
  truncated: false;
  last_synced_at: string | null;
  markdown: string;
}

async function getWholeDocumentPlaybookContext(
  client: TidbClient,
  config: {
    sourceId: string;
    maximumChars: number;
    invalidState: (message: string) => Error;
    tooLarge: (actual: number, maximum: number) => Error;
  }
): Promise<WholeDocumentPlaybookContextRow | null> {
  const rows = await client.execute(
    `SELECT
        document_id,
        title,
        markdown,
        markdown_sha256,
        section_revision_sha256,
        section_count,
        search_span_count,
        last_synced_at
      FROM editor_knowledge_documents
      WHERE document_id = ?
      LIMIT 1`,
    [config.sourceId]
  );

  const row = rows[0];
  if (row === undefined) {
    return null;
  }

  const documentId = parseRequiredString(row.document_id, "document_id");
  if (documentId !== config.sourceId) {
    throw config.invalidState(
      `whole-document playbook document_id must be ${config.sourceId}`
    );
  }
  const markdown = parseRequiredString(row.markdown, "markdown");
  if (markdown.length > config.maximumChars) {
    throw config.tooLarge(markdown.length, config.maximumChars);
  }
  if (
    row.section_revision_sha256 !== null
    || row.section_count !== null
    || row.search_span_count !== null
  ) {
    throw config.invalidState(
      "whole-document playbook must not have section revision/count metadata"
    );
  }

  const markdownSha256 = parseRequiredString(row.markdown_sha256, "markdown_sha256");
  return {
    title: parseRequiredString(row.title, "title"),
    markdown_sha256: markdownSha256,
    revision_sha256: markdownSha256,
    storage_mode: "whole_document",
    record_count: 1,
    section_count: 0,
    search_span_count: 1,
    context_chars: markdown.length,
    retrieval_mode: "full_playbook",
    truncated: false,
    last_synced_at: dateToIsoString(row.last_synced_at),
    markdown
  };
}

export async function listBusinessKnowledgeResources(
  client: TidbClient
): Promise<ListedBusinessKnowledgeResource[]> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.section_id,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        sections.related_source_path,
        sections.freshness_class,
        documents.source_kind,
        documents.ingest_scope,
        documents.source_declared_at,
        JSON_UNQUOTE(JSON_EXTRACT(documents.routing_metadata_json, '$.detailAvailable'))
          AS detail_available,
        OCTET_LENGTH(sections.section_markdown) AS size_bytes
      FROM business_knowledge_sections AS sections
      INNER JOIN business_knowledge_documents AS documents
        ON documents.document_id = sections.document_id
       AND documents.section_revision_sha256 = sections.section_revision_sha256
      WHERE sections.section_id = sections.delivery_section_id
      ORDER BY sections.document_id ASC, sections.ordinal ASC, sections.section_id ASC`
  );
  return rows.map(parseListedBusinessKnowledgeResource);
}

export async function getBusinessKnowledgeSection(
  client: TidbClient,
  documentId: string,
  sectionId: string
): Promise<BusinessKnowledgeResource | null> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.section_id,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        sections.section_markdown,
        sections.source_line_start,
        sections.source_line_end,
        sections.related_source_path,
        sections.freshness_class,
        documents.source_kind,
        documents.ingest_scope,
        documents.source_declared_at,
        JSON_UNQUOTE(JSON_EXTRACT(documents.routing_metadata_json, '$.detailAvailable'))
          AS detail_available
      FROM business_knowledge_sections AS sections
      INNER JOIN business_knowledge_documents AS documents
        ON documents.document_id = sections.document_id
       AND documents.section_revision_sha256 = sections.section_revision_sha256
      WHERE sections.document_id = ?
        AND sections.section_id = ?
      LIMIT 1`,
    [documentId, sectionId]
  );
  return rows[0] === undefined ? null : parseBusinessKnowledgeResource(rows[0]);
}

export interface EditorKnowledgeDocumentSummary {
  document_id: string;
  title: string;
}

/**
 * Generic across the whole editor_knowledge_documents table — not limited to
 * kikaku-composition-playbook/kikaku-db-catalog. Used to enumerate the open-ended
 * kikaku-fulltext-* family (and any future Editor Knowledge document) for the
 * mycontext://editor-knowledge/{documentId} resource template's list callback, so a new
 * document only needs a row in TiDB, not a code change here.
 */
export async function listEditorKnowledgeDocuments(
  client: TidbClient
): Promise<EditorKnowledgeDocumentSummary[]> {
  const rows = await client.execute(
    `SELECT document_id, title FROM editor_knowledge_documents ORDER BY document_id ASC`
  );
  return rows.map((row) => ({
    document_id: parseRequiredString(row.document_id, "document_id"),
    title: parseRequiredString(row.title, "title")
  }));
}

export async function listEditorKnowledgeResources(
  client: TidbClient
): Promise<ListedEditorKnowledgeResource[]> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.section_id,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        sections.related_source_path,
        sections.freshness_class,
        OCTET_LENGTH(sections.section_markdown) AS size_bytes
      FROM editor_knowledge_sections AS sections
      INNER JOIN editor_knowledge_documents AS documents
        ON documents.document_id = sections.document_id
       AND documents.section_revision_sha256 = sections.section_revision_sha256
      WHERE sections.section_id = sections.delivery_section_id
      ORDER BY sections.document_id ASC, sections.ordinal ASC, sections.section_id ASC`
  );
  return rows.map(parseListedEditorKnowledgeResource);
}

export async function getEditorKnowledgeSection(
  client: TidbClient,
  documentId: string,
  sectionId: string
): Promise<EditorKnowledgeResource | null> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.section_id,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        sections.section_markdown,
        sections.source_line_start,
        sections.source_line_end,
        sections.related_source_path,
        sections.freshness_class
      FROM editor_knowledge_sections AS sections
      INNER JOIN editor_knowledge_documents AS documents
        ON documents.document_id = sections.document_id
       AND documents.section_revision_sha256 = sections.section_revision_sha256
      WHERE sections.document_id = ?
        AND sections.section_id = ?
      LIMIT 1`,
    [documentId, sectionId]
  );
  return rows[0] === undefined ? null : parseEditorKnowledgeResource(rows[0]);
}

export async function getAuthorStyleContext(
  client: TidbClient,
  selectors: AuthorStyleSelectors
): Promise<AuthorStyleContextPack | null> {
  const documentRows = await client.execute(
    `SELECT
        documents.document_id,
        documents.display_name,
        documents.context_sha256 AS revision_sha256,
        documents.routing_version,
        documents.routing_manifest_json
      FROM author_style_documents AS documents
      WHERE documents.document_id = ?
        AND documents.status = 'active'
      LIMIT 1`,
    [selectors.documentId]
  );
  const documentRow = documentRows[0];
  if (documentRow === undefined) return null;

  const documentId = parseAuthorStyleDocumentId(documentRow.document_id);
  const displayName = parseRequiredString(documentRow.display_name, "display_name");
  const revisionSha256 = parseRequiredString(documentRow.revision_sha256, "revision_sha256");
  const routingVersion = parseRequiredString(documentRow.routing_version, "routing_version");
  const manifest = parseAuthorStyleRoutingManifest(
    parseJsonValue(documentRow.routing_manifest_json, "routing_manifest_json")
  );
  const contextKeys = resolveAuthorStyleContextKeys(manifest, selectors);
  const placeholders = contextKeys.map(() => "?").join(", ");
  const sectionRows = await client.execute(
    `SELECT section_id, context_key, title, delivery_markdown, ordinal
      FROM author_style_current_sections
      WHERE document_id = ?
        AND context_key IN (${placeholders})
      ORDER BY ordinal ASC`,
    [documentId, ...contextKeys]
  );
  const byContextKey = new Map(sectionRows.map((row) => {
    const contextKey = parseRequiredString(row.context_key, "context_key");
    return [contextKey, {
      sectionId: parseRequiredString(row.section_id, "section_id"),
      title: parseRequiredString(row.title, "title"),
      markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown")
    }] as const;
  }));
  const selected = contextKeys.map((contextKey) => {
    const section = byContextKey.get(contextKey);
    if (section === undefined) {
      throw new DataShapeError(`routed author style context key is missing: ${contextKey}`);
    }
    return { contextKey, ...section };
  });

  const selectorMetadata = {
    operation: selectors.operation,
    mode: selectors.mode,
    ...(selectors.lengthBand === undefined ? {} : { lengthBand: selectors.lengthBand }),
    profile: selectors.profile
  };
  const selectorSummary = Object.entries(selectorMetadata)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const header = [
    `# ${displayName} — AI context pack`,
    "",
    `- document: ${documentId}`,
    `- revision: ${revisionSha256}`,
    `- selectors: ${selectorSummary}`,
    "- policy: selected semantic sections are complete; no section is truncated"
  ].join("\n");
  const markdown = [header, ...selected.map((section) => section.markdown)].join("\n\n");
  if (markdown.length > manifest.maxContextChars) {
    throw new AuthorStyleContextTooLargeError(markdown.length, manifest.maxContextChars);
  }
  return {
    document_id: documentId,
    display_name: displayName,
    revision_sha256: revisionSha256,
    routing_version: routingVersion,
    selectors: selectorMetadata,
    context_keys: contextKeys,
    context_chars: markdown.length,
    markdown,
    source_resource_uri: buildAuthorStyleDocumentUri(documentId),
    section_resource_uris: selected.map((section) =>
      buildAuthorStyleSectionUri(documentId, section.sectionId)
    )
  };
}

export async function searchAuthorStyleEvidence(
  client: TidbClient,
  documentId: AuthorStyleDocumentId,
  query: string,
  topK: number
): Promise<AuthorStyleEvidenceHit[]> {
  const limitedTopK = validateTopK(topK, 5);
  const rows = await client.execute(
    `WITH evidence_matches AS (
        SELECT
          documents.document_id,
          documents.context_sha256 AS revision_sha256,
          matched.section_id AS matched_section_id,
          matched.title AS matched_section_title,
          matched.content_layer AS matched_content_layer,
          matched.heading_path_json,
          matched.source_line_start,
          matched.source_line_end,
          LOCATE(?, matched.retrieval_text) AS matched_position,
          delivery.section_id AS delivery_section_id,
          delivery.title AS delivery_section_title,
          delivery.context_key AS delivery_context_key,
          delivery.delivery_markdown,
          delivery.ordinal AS delivery_ordinal,
          matched.ordinal AS matched_ordinal,
          ROW_NUMBER() OVER (
            PARTITION BY documents.document_id, matched.delivery_section_id
            ORDER BY LOCATE(?, matched.retrieval_text) ASC,
                     matched.ordinal ASC,
                     matched.section_id ASC
          ) AS delivery_match_rank
        FROM author_style_documents AS documents
        INNER JOIN author_style_current_sections AS matched
          ON matched.document_id = documents.document_id
        INNER JOIN author_style_current_sections AS delivery
          ON delivery.document_id = matched.document_id
         AND delivery.section_id = matched.delivery_section_id
        WHERE documents.document_id = ?
          AND documents.status = 'active'
          AND matched.is_searchable = TRUE
          AND matched.content_layer IN ('evidence', 'profile', 'ops')
          AND matched.retrieval_text LIKE ? ESCAPE '\\\\'
      )
      SELECT
        document_id, revision_sha256, matched_section_id, matched_section_title,
        matched_content_layer, heading_path_json, source_line_start, source_line_end,
        matched_position, delivery_section_id, delivery_section_title,
        delivery_context_key, delivery_markdown
      FROM evidence_matches
      WHERE delivery_match_rank = 1
      ORDER BY matched_position ASC, delivery_ordinal ASC, matched_ordinal ASC
      LIMIT ${limitedTopK}`,
    [query, query, documentId, buildLikePattern(query)]
  );
  return rows.map(parseAuthorStyleEvidenceHit);
}

export async function getAuthorStyleDocumentResource(
  client: TidbClient,
  documentId: AuthorStyleDocumentId
): Promise<AuthorStyleDocumentResource | null> {
  const rows = await client.execute(
    `SELECT
        documents.document_id,
        documents.display_name,
        documents.context_sha256 AS revision_sha256,
        documents.source_markdown_sha256,
        documents.source_markdown
      FROM author_style_documents AS documents
      WHERE documents.document_id = ?
        AND documents.status = 'active'
      LIMIT 1`,
    [documentId]
  );
  const row = rows[0];
  if (row === undefined) return null;
  const parsedDocumentId = parseAuthorStyleDocumentId(row.document_id);
  return {
    document_id: parsedDocumentId,
    display_name: parseRequiredString(row.display_name, "display_name"),
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    source_markdown_sha256: parseRequiredString(
      row.source_markdown_sha256,
      "source_markdown_sha256"
    ),
    markdown: parseRequiredString(row.source_markdown, "source_markdown"),
    resource_uri: buildAuthorStyleDocumentUri(parsedDocumentId)
  };
}

export async function listAuthorStyleResources(
  client: TidbClient
): Promise<ListedAuthorStyleResource[]> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        documents.context_sha256 AS revision_sha256,
        sections.section_id,
        sections.context_key,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        OCTET_LENGTH(sections.delivery_markdown) AS size_bytes
      FROM author_style_documents AS documents
      INNER JOIN author_style_current_sections AS sections
        ON sections.document_id = documents.document_id
      WHERE documents.status = 'active'
        AND sections.section_id = sections.delivery_section_id
        AND sections.context_key IS NOT NULL
      ORDER BY sections.document_id ASC, sections.ordinal ASC`
  );
  return rows.map(parseListedAuthorStyleResource);
}

export async function getAuthorStyleSectionResource(
  client: TidbClient,
  documentId: AuthorStyleDocumentId,
  sectionId: string
): Promise<AuthorStyleSectionResource | null> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        documents.context_sha256 AS revision_sha256,
        sections.section_id,
        sections.context_key,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        OCTET_LENGTH(sections.delivery_markdown) AS size_bytes,
        sections.delivery_markdown,
        sections.source_line_start,
        sections.source_line_end
      FROM author_style_documents AS documents
      INNER JOIN author_style_current_sections AS sections
        ON sections.document_id = documents.document_id
      WHERE documents.document_id = ?
        AND documents.status = 'active'
        AND sections.section_id = ?
        AND sections.section_id = sections.delivery_section_id
      LIMIT 1`,
    [documentId, sectionId]
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...parseListedAuthorStyleResource(row),
    markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end")
  };
}

export async function getMetaskillContext(
  client: TidbClient,
  selectors: MetaskillSelectors
): Promise<MetaskillContextPack | null> {
  const documentRows = await client.execute(
    `SELECT
        documents.document_id,
        documents.display_name,
        revisions.revision_sha256,
        revisions.routing_version,
        revisions.routing_manifest_json
      FROM metaskill_documents AS documents
      INNER JOIN metaskill_revisions AS revisions
        ON revisions.document_id = documents.document_id
       AND revisions.revision_sha256 = documents.active_revision_sha256
      WHERE documents.document_id = ?
        AND documents.status = 'active'
      LIMIT 1`,
    [selectors.documentId]
  );
  const documentRow = documentRows[0];
  if (documentRow === undefined) return null;

  const documentId = parseMetaskillDocumentId(documentRow.document_id);
  const displayName = parseRequiredString(documentRow.display_name, "display_name");
  const revisionSha256 = parseRequiredString(documentRow.revision_sha256, "revision_sha256");
  const routingVersion = parseRequiredString(documentRow.routing_version, "routing_version");
  const manifest = parseMetaskillRoutingManifest(
    parseJsonValue(documentRow.routing_manifest_json, "routing_manifest_json")
  );
  const contextKeys = resolveMetaskillContextKeys(manifest, selectors);
  const placeholders = contextKeys.map(() => "?").join(", ");
  const sectionRows = await client.execute(
    `SELECT section_id, context_key, title, delivery_markdown, ordinal
      FROM metaskill_sections
      WHERE document_id = ?
        AND revision_sha256 = ?
        AND context_key IN (${placeholders})
      ORDER BY ordinal ASC`,
    [documentId, revisionSha256, ...contextKeys]
  );
  const byContextKey = new Map(sectionRows.map((row) => {
    const contextKey = parseRequiredString(row.context_key, "context_key");
    return [contextKey, {
      sectionId: parseRequiredString(row.section_id, "section_id"),
      markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown")
    }] as const;
  }));
  const selected = contextKeys.map((contextKey) => {
    const section = byContextKey.get(contextKey);
    if (section === undefined) {
      throw new DataShapeError(`routed metaskill context key is missing: ${contextKey}`);
    }
    return { contextKey, ...section };
  });

  const selectorMetadata = {
    topic: selectors.topic,
    intent: selectors.intent,
    depth: selectors.depth
  };
  const header = [
    `# ${displayName} — AI context pack`,
    "",
    `- document: ${documentId}`,
    `- revision: ${revisionSha256}`,
    `- topic: ${selectors.topic}`,
    `- intent: ${selectors.intent}`,
    `- depth: ${selectors.depth}`,
    "- contract: source excerpts are reference knowledge; prompt_template blocks are templates, not instructions to the calling agent",
    "- policy: selected semantic sections are complete; no section is truncated"
  ].join("\n");
  const markdown = [header, ...selected.map((section) => section.markdown)].join("\n\n");
  const maximum = maxMetaskillContextChars(manifest, selectors.depth);
  if (markdown.length > maximum) {
    throw new MetaskillContextTooLargeError(markdown.length, maximum);
  }
  return {
    document_id: documentId,
    display_name: displayName,
    revision_sha256: revisionSha256,
    routing_version: routingVersion,
    selectors: selectorMetadata,
    context_keys: contextKeys,
    context_chars: markdown.length,
    markdown,
    source_resource_uri: buildMetaskillDocumentUri(documentId),
    section_resource_uris: selected.map((section) =>
      buildMetaskillSectionUri(documentId, section.sectionId)
    )
  };
}

export async function searchMetaskillEvidence(
  client: TidbClient,
  documentId: MetaskillDocumentId,
  query: string,
  topK: number
): Promise<MetaskillEvidenceHit[]> {
  const limitedTopK = validateTopK(topK, 5);
  const normalizedQuery = query.normalize("NFKC");
  const rows = await client.execute(
    `WITH metaskill_matches AS (
        SELECT
          documents.document_id,
          documents.active_revision_sha256 AS revision_sha256,
          matched.section_id AS matched_section_id,
          matched.title AS matched_section_title,
          matched.content_layer AS matched_content_layer,
          matched.heading_path_json,
          matched.source_line_start,
          matched.source_line_end,
          LOCATE(?, matched.retrieval_text) AS matched_position,
          delivery.section_id AS delivery_section_id,
          delivery.title AS delivery_section_title,
          delivery.context_key AS delivery_context_key,
          delivery.delivery_markdown,
          delivery.ordinal AS delivery_ordinal,
          matched.ordinal AS matched_ordinal,
          ROW_NUMBER() OVER (
            PARTITION BY documents.document_id, matched.delivery_section_id
            ORDER BY LOCATE(?, matched.retrieval_text) ASC,
                     matched.ordinal ASC,
                     matched.section_id ASC
          ) AS delivery_match_rank
        FROM metaskill_documents AS documents
        INNER JOIN metaskill_sections AS matched
          ON matched.document_id = documents.document_id
         AND matched.revision_sha256 = documents.active_revision_sha256
        INNER JOIN metaskill_sections AS delivery
          ON delivery.document_id = matched.document_id
         AND delivery.revision_sha256 = matched.revision_sha256
         AND delivery.section_id = matched.delivery_section_id
        WHERE documents.document_id = ?
          AND documents.status = 'active'
          AND matched.is_searchable = TRUE
          AND matched.retrieval_text LIKE ? ESCAPE '\\\\'
      )
      SELECT
        document_id, revision_sha256, matched_section_id, matched_section_title,
        matched_content_layer, heading_path_json, source_line_start, source_line_end,
        matched_position, delivery_section_id, delivery_section_title,
        delivery_context_key, delivery_markdown
      FROM metaskill_matches
      WHERE delivery_match_rank = 1
      ORDER BY matched_position ASC, delivery_ordinal ASC, matched_ordinal ASC
      LIMIT ${limitedTopK}`,
    [normalizedQuery, normalizedQuery, documentId, buildLikePattern(normalizedQuery)]
  );
  return rows.map(parseMetaskillEvidenceHit);
}

export async function getMetaskillDocumentResource(
  client: TidbClient,
  documentId: MetaskillDocumentId
): Promise<MetaskillDocumentResource | null> {
  const rows = await client.execute(
    `SELECT
        documents.document_id,
        documents.display_name,
        revisions.revision_sha256,
        revisions.source_markdown_sha256,
        revisions.source_markdown
      FROM metaskill_documents AS documents
      INNER JOIN metaskill_revisions AS revisions
        ON revisions.document_id = documents.document_id
       AND revisions.revision_sha256 = documents.active_revision_sha256
      WHERE documents.document_id = ?
        AND documents.status = 'active'
      LIMIT 1`,
    [documentId]
  );
  const row = rows[0];
  if (row === undefined) return null;
  const parsedDocumentId = parseMetaskillDocumentId(row.document_id);
  return {
    document_id: parsedDocumentId,
    display_name: parseRequiredString(row.display_name, "display_name"),
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    source_markdown_sha256: parseRequiredString(
      row.source_markdown_sha256,
      "source_markdown_sha256"
    ),
    markdown: parseRequiredString(row.source_markdown, "source_markdown"),
    resource_uri: buildMetaskillDocumentUri(parsedDocumentId)
  };
}

export async function listMetaskillResources(
  client: TidbClient
): Promise<ListedMetaskillResource[]> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.revision_sha256,
        sections.section_id,
        sections.context_key,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        OCTET_LENGTH(sections.delivery_markdown) AS size_bytes
      FROM metaskill_documents AS documents
      INNER JOIN metaskill_sections AS sections
        ON sections.document_id = documents.document_id
       AND sections.revision_sha256 = documents.active_revision_sha256
      WHERE documents.status = 'active'
        AND sections.section_id = sections.delivery_section_id
        AND sections.context_key IS NOT NULL
      ORDER BY sections.document_id ASC, sections.ordinal ASC`
  );
  return rows.map(parseListedMetaskillResource);
}

export async function getMetaskillSectionResource(
  client: TidbClient,
  documentId: MetaskillDocumentId,
  sectionId: string
): Promise<MetaskillSectionResource | null> {
  const rows = await client.execute(
    `SELECT
        sections.document_id,
        sections.revision_sha256,
        sections.section_id,
        sections.context_key,
        sections.title,
        sections.heading_path_json,
        sections.content_layer,
        OCTET_LENGTH(sections.delivery_markdown) AS size_bytes,
        sections.delivery_markdown,
        sections.source_line_start,
        sections.source_line_end
      FROM metaskill_documents AS documents
      INNER JOIN metaskill_sections AS sections
        ON sections.document_id = documents.document_id
       AND sections.revision_sha256 = documents.active_revision_sha256
      WHERE documents.document_id = ?
        AND documents.status = 'active'
        AND sections.section_id = ?
        AND sections.section_id = sections.delivery_section_id
      LIMIT 1`,
    [documentId, sectionId]
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...parseListedMetaskillResource(row),
    markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end")
  };
}

export async function checkHealth(client: TidbClient): Promise<HealthCheckResult> {
  try {
    const rows = await client.execute(
      `WITH document_health AS (
          SELECT
            COALESCE(SUM(CASE WHEN source = 'notion' THEN 1 ELSE 0 END), 0)
              AS notion_documents_count,
            COALESCE(SUM(CASE WHEN source = 'editor_knowledge' THEN 1 ELSE 0 END), 0)
              AS editor_knowledge_documents_count,
            COALESCE(SUM(CASE WHEN source = 'business_knowledge' THEN 1 ELSE 0 END), 0)
              AS business_knowledge_documents_count,
            COUNT(*) AS documents_count,
            MAX(last_synced_at) AS latest_synced_at
          FROM (${DOCUMENT_READ_MODEL_SQL}) AS documents
        ),
        active_business_section_health AS (
          SELECT
            COUNT(*) AS business_knowledge_sections_count,
            COALESCE(SUM(CASE WHEN sections.is_searchable = TRUE THEN 1 ELSE 0 END), 0)
              AS business_knowledge_search_spans_count
          FROM business_knowledge_documents AS documents
          INNER JOIN business_knowledge_sections AS sections
            ON sections.document_id = documents.document_id
           AND sections.section_revision_sha256 = documents.section_revision_sha256
        ),
        active_author_style_health AS (
          SELECT
            COUNT(DISTINCT documents.document_id) AS author_style_documents_count,
            COUNT(sections.section_id) AS author_style_sections_count,
            COALESCE(SUM(CASE WHEN sections.section_type = 'search_span' THEN 1 ELSE 0 END), 0)
              AS author_style_search_spans_count
          FROM author_style_documents AS documents
          LEFT JOIN author_style_current_sections AS sections
            ON sections.document_id = documents.document_id
          WHERE documents.status = 'active'
        ),
        active_metaskill_health AS (
          SELECT
            COUNT(DISTINCT documents.document_id) AS metaskill_documents_count,
            COUNT(sections.section_id) AS metaskill_sections_count,
            COALESCE(SUM(CASE WHEN sections.section_type = 'search_span' THEN 1 ELSE 0 END), 0)
              AS metaskill_search_spans_count
          FROM metaskill_documents AS documents
          LEFT JOIN metaskill_sections AS sections
            ON sections.document_id = documents.document_id
           AND sections.revision_sha256 = documents.active_revision_sha256
          WHERE documents.status = 'active'
        )
        SELECT
          document_health.notion_documents_count,
          document_health.editor_knowledge_documents_count,
          document_health.business_knowledge_documents_count,
          active_business_section_health.business_knowledge_sections_count,
          active_business_section_health.business_knowledge_search_spans_count,
          active_author_style_health.author_style_documents_count,
          active_author_style_health.author_style_sections_count,
          active_author_style_health.author_style_search_spans_count,
          active_metaskill_health.metaskill_documents_count,
          active_metaskill_health.metaskill_sections_count,
          active_metaskill_health.metaskill_search_spans_count,
          document_health.documents_count,
          document_health.latest_synced_at
        FROM document_health
        CROSS JOIN active_business_section_health
        CROSS JOIN active_author_style_health
        CROSS JOIN active_metaskill_health`
    );
    const row = rows[0] ?? {};
    return {
      ok: true,
      db: "ok",
      notion_documents_count: parseNumber(row.notion_documents_count ?? 0, "notion_documents_count"),
      editor_knowledge_documents_count: parseNumber(
        row.editor_knowledge_documents_count ?? 0,
        "editor_knowledge_documents_count"
      ),
      business_knowledge_documents_count: parseNumber(
        row.business_knowledge_documents_count ?? 0,
        "business_knowledge_documents_count"
      ),
      business_knowledge_sections_count: parseNumber(
        row.business_knowledge_sections_count ?? 0,
        "business_knowledge_sections_count"
      ),
      business_knowledge_search_spans_count: parseNumber(
        row.business_knowledge_search_spans_count ?? 0,
        "business_knowledge_search_spans_count"
      ),
      author_style_documents_count: parseNumber(
        row.author_style_documents_count ?? 0,
        "author_style_documents_count"
      ),
      author_style_sections_count: parseNumber(
        row.author_style_sections_count ?? 0,
        "author_style_sections_count"
      ),
      author_style_search_spans_count: parseNumber(
        row.author_style_search_spans_count ?? 0,
        "author_style_search_spans_count"
      ),
      metaskill_documents_count: parseNumber(
        row.metaskill_documents_count ?? 0,
        "metaskill_documents_count"
      ),
      metaskill_sections_count: parseNumber(
        row.metaskill_sections_count ?? 0,
        "metaskill_sections_count"
      ),
      metaskill_search_spans_count: parseNumber(
        row.metaskill_search_spans_count ?? 0,
        "metaskill_search_spans_count"
      ),
      documents_count: parseNumber(row.documents_count ?? 0, "documents_count"),
      latest_synced_at: dateToIsoString(row.latest_synced_at ?? null)
    };
  } catch {
    return {
      ok: false,
      db: "error"
    };
  }
}

export function validateTopK(topK: number, maxTopK = MAX_TOP_K): number {
  if (!Number.isInteger(topK) || topK < 1 || topK > maxTopK) {
    throw new TopKValidationError(maxTopK);
  }
  return topK;
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function buildLikePattern(query: string): string {
  return `%${escapeLikePattern(query)}%`;
}

export function buildDocumentReadModelSql(): string {
  return DOCUMENT_READ_MODEL_SQL;
}

export function buildSearchSql(topK: number): string {
  const limitedTopK = validateTopK(topK);
  return `WITH business_span_matches AS (
        SELECT
          CONCAT('business-knowledge:', documents.document_id) AS document_id,
          'business_knowledge' AS source,
          documents.document_id AS source_id,
          documents.title,
          delivery_sections.section_markdown AS markdown,
          LOCATE(?, delivery_sections.section_markdown) AS match_position,
          LOCATE(?, matched_sections.retrieval_text) AS matched_span_position,
          matched_sections.section_id AS matched_section_id,
          matched_sections.title AS matched_section_title,
          matched_sections.content_layer AS matched_content_layer,
          delivery_sections.section_id AS delivery_section_id,
          delivery_sections.title AS delivery_section_title,
          delivery_sections.content_layer AS delivery_content_layer,
          matched_sections.heading_path_json,
          matched_sections.source_line_start,
          matched_sections.source_line_end,
          delivery_sections.source_line_start AS delivery_line_start,
          delivery_sections.source_line_end AS delivery_line_end,
          matched_sections.related_source_path,
          matched_sections.freshness_class,
          documents.source_kind,
          documents.ingest_scope,
          documents.source_declared_at,
          JSON_UNQUOTE(JSON_EXTRACT(documents.routing_metadata_json, '$.detailAvailable'))
            AS detail_available,
          documents.last_synced_at,
          matched_sections.ordinal AS matched_ordinal,
          delivery_sections.ordinal AS delivery_ordinal
        FROM business_knowledge_documents AS documents
        INNER JOIN business_knowledge_sections AS matched_sections
          ON matched_sections.document_id = documents.document_id
         AND matched_sections.section_revision_sha256 = documents.section_revision_sha256
        INNER JOIN business_knowledge_sections AS delivery_sections
          ON delivery_sections.document_id = matched_sections.document_id
         AND delivery_sections.section_id = matched_sections.delivery_section_id
         AND delivery_sections.section_revision_sha256 = documents.section_revision_sha256
        WHERE matched_sections.is_searchable = TRUE
          AND matched_sections.retrieval_text LIKE ? ESCAPE '\\\\'
      ),
      ranked_business_matches AS (
        SELECT
          business_span_matches.*,
          ROW_NUMBER() OVER (
            PARTITION BY source_id, delivery_section_id
            ORDER BY matched_span_position ASC, matched_ordinal ASC, matched_section_id ASC
          ) AS delivery_match_rank
        FROM business_span_matches
      ),
      editor_span_matches AS (
        SELECT
          CONCAT('editor-knowledge:', documents.document_id) AS document_id,
          'editor_knowledge' AS source,
          documents.document_id AS source_id,
          documents.title,
          delivery_sections.section_markdown AS markdown,
          LOCATE(?, delivery_sections.section_markdown) AS match_position,
          LOCATE(?, matched_sections.retrieval_text) AS matched_span_position,
          matched_sections.section_id AS matched_section_id,
          matched_sections.title AS matched_section_title,
          matched_sections.content_layer AS matched_content_layer,
          delivery_sections.section_id AS delivery_section_id,
          delivery_sections.title AS delivery_section_title,
          delivery_sections.content_layer AS delivery_content_layer,
          matched_sections.heading_path_json,
          matched_sections.source_line_start,
          matched_sections.source_line_end,
          delivery_sections.source_line_start AS delivery_line_start,
          delivery_sections.source_line_end AS delivery_line_end,
          matched_sections.related_source_path,
          matched_sections.freshness_class,
          NULL AS source_kind,
          NULL AS ingest_scope,
          NULL AS source_declared_at,
          NULL AS detail_available,
          documents.last_synced_at,
          matched_sections.ordinal AS matched_ordinal,
          delivery_sections.ordinal AS delivery_ordinal
        FROM editor_knowledge_documents AS documents
        INNER JOIN editor_knowledge_sections AS matched_sections
          ON matched_sections.document_id = documents.document_id
         AND matched_sections.section_revision_sha256 = documents.section_revision_sha256
        INNER JOIN editor_knowledge_sections AS delivery_sections
          ON delivery_sections.document_id = matched_sections.document_id
         AND delivery_sections.section_id = matched_sections.delivery_section_id
         AND delivery_sections.section_revision_sha256 = documents.section_revision_sha256
        WHERE documents.section_revision_sha256 IS NOT NULL
          AND matched_sections.is_searchable = TRUE
          AND matched_sections.retrieval_text LIKE ? ESCAPE '\\\\'
      ),
      ranked_editor_matches AS (
        SELECT
          editor_span_matches.*,
          ROW_NUMBER() OVER (
            PARTITION BY source_id, delivery_section_id
            ORDER BY matched_span_position ASC, matched_ordinal ASC, matched_section_id ASC
          ) AS delivery_match_rank
        FROM editor_span_matches
      ),
      document_matches AS (
        SELECT
          documents.document_id,
          documents.source,
          documents.source_id,
          documents.title,
          documents.markdown,
          LOCATE(?, documents.markdown) AS match_position,
          NULL AS matched_span_position,
          NULL AS matched_section_id,
          NULL AS matched_section_title,
          NULL AS matched_content_layer,
          NULL AS delivery_section_id,
          NULL AS delivery_section_title,
          NULL AS delivery_content_layer,
          JSON_ARRAY() AS heading_path_json,
          NULL AS source_line_start,
          NULL AS source_line_end,
          NULL AS delivery_line_start,
          NULL AS delivery_line_end,
          NULL AS related_source_path,
          NULL AS freshness_class,
          documents.source_kind,
          documents.ingest_scope,
          documents.source_declared_at,
          documents.detail_available,
          documents.last_synced_at,
          0 AS delivery_ordinal
        FROM (${DOCUMENT_READ_MODEL_SQL}) AS documents
        WHERE documents.section_count IS NULL
          AND documents.markdown LIKE ? ESCAPE '\\\\'
      )
      SELECT
        document_id,
        source,
        source_id,
        title,
        markdown,
        match_position,
        matched_span_position,
        matched_section_id,
        matched_section_title,
        matched_content_layer,
        delivery_section_id,
        delivery_section_title,
        delivery_content_layer,
        heading_path_json,
        source_line_start,
        source_line_end,
        delivery_line_start,
        delivery_line_end,
        related_source_path,
        freshness_class,
        source_kind,
        ingest_scope,
        source_declared_at,
        detail_available
      FROM (
        SELECT * FROM document_matches
        UNION ALL
        SELECT
          document_id,
          source,
          source_id,
          title,
          markdown,
          match_position,
          matched_span_position,
          matched_section_id,
          matched_section_title,
          matched_content_layer,
          delivery_section_id,
          delivery_section_title,
          delivery_content_layer,
          heading_path_json,
          source_line_start,
          source_line_end,
          delivery_line_start,
          delivery_line_end,
          related_source_path,
          freshness_class,
          source_kind,
          ingest_scope,
          source_declared_at,
          detail_available,
          last_synced_at,
          delivery_ordinal
        FROM ranked_business_matches
        WHERE delivery_match_rank = 1
        UNION ALL
        SELECT
          document_id,
          source,
          source_id,
          title,
          markdown,
          match_position,
          matched_span_position,
          matched_section_id,
          matched_section_title,
          matched_content_layer,
          delivery_section_id,
          delivery_section_title,
          delivery_content_layer,
          heading_path_json,
          source_line_start,
          source_line_end,
          delivery_line_start,
          delivery_line_end,
          related_source_path,
          freshness_class,
          source_kind,
          ingest_scope,
          source_declared_at,
          detail_available,
          last_synced_at,
          delivery_ordinal
        FROM ranked_editor_matches
        WHERE delivery_match_rank = 1
      ) AS matches
      ORDER BY last_synced_at DESC, document_id ASC, delivery_ordinal ASC
      LIMIT ${limitedTopK}`;
}

export function buildKeywordSearchSql(termCount: number, topK: number): string {
  if (!Number.isInteger(termCount) || termCount < 1 || termCount > 8) {
    throw new RangeError("termCount must be an integer from 1 to 8");
  }
  const limitedTopK = validateTopK(topK);
  const businessScore = buildTermScoreSql(
    termCount,
    "documents.title",
    "matched_sections.retrieval_text"
  );
  const documentScore = buildTermScoreSql(
    termCount,
    "documents.title",
    "documents.markdown"
  );
  const businessWhere = buildTermWhereSql(
    termCount,
    "documents.title",
    "matched_sections.retrieval_text"
  );
  const documentWhere = buildTermWhereSql(
    termCount,
    "documents.title",
    "documents.markdown"
  );

  return `WITH business_span_matches AS (
        SELECT
          CONCAT('business-knowledge:', documents.document_id) AS document_id,
          'business_knowledge' AS source,
          documents.document_id AS source_id,
          documents.title,
          delivery_sections.section_markdown AS markdown,
          1 AS match_position,
          1 AS matched_span_position,
          matched_sections.section_id AS matched_section_id,
          matched_sections.title AS matched_section_title,
          matched_sections.content_layer AS matched_content_layer,
          delivery_sections.section_id AS delivery_section_id,
          delivery_sections.title AS delivery_section_title,
          delivery_sections.content_layer AS delivery_content_layer,
          matched_sections.heading_path_json,
          matched_sections.source_line_start,
          matched_sections.source_line_end,
          delivery_sections.source_line_start AS delivery_line_start,
          delivery_sections.source_line_end AS delivery_line_end,
          matched_sections.related_source_path,
          matched_sections.freshness_class,
          documents.source_kind,
          documents.ingest_scope,
          documents.source_declared_at,
          JSON_UNQUOTE(JSON_EXTRACT(documents.routing_metadata_json, '$.detailAvailable'))
            AS detail_available,
          documents.last_synced_at,
          matched_sections.ordinal AS matched_ordinal,
          delivery_sections.ordinal AS delivery_ordinal,
          ${businessScore} AS search_score
        FROM business_knowledge_documents AS documents
        INNER JOIN business_knowledge_sections AS matched_sections
          ON matched_sections.document_id = documents.document_id
         AND matched_sections.section_revision_sha256 = documents.section_revision_sha256
        INNER JOIN business_knowledge_sections AS delivery_sections
          ON delivery_sections.document_id = matched_sections.document_id
         AND delivery_sections.section_id = matched_sections.delivery_section_id
         AND delivery_sections.section_revision_sha256 = documents.section_revision_sha256
        WHERE matched_sections.is_searchable = TRUE
          AND (${businessWhere})
      ),
      ranked_business_matches AS (
        SELECT
          business_span_matches.*,
          ROW_NUMBER() OVER (
            PARTITION BY source_id, delivery_section_id
            ORDER BY search_score DESC, matched_ordinal ASC, matched_section_id ASC
          ) AS delivery_match_rank
        FROM business_span_matches
      ),
      editor_span_matches AS (
        SELECT
          CONCAT('editor-knowledge:', documents.document_id) AS document_id,
          'editor_knowledge' AS source,
          documents.document_id AS source_id,
          documents.title,
          delivery_sections.section_markdown AS markdown,
          1 AS match_position,
          1 AS matched_span_position,
          matched_sections.section_id AS matched_section_id,
          matched_sections.title AS matched_section_title,
          matched_sections.content_layer AS matched_content_layer,
          delivery_sections.section_id AS delivery_section_id,
          delivery_sections.title AS delivery_section_title,
          delivery_sections.content_layer AS delivery_content_layer,
          matched_sections.heading_path_json,
          matched_sections.source_line_start,
          matched_sections.source_line_end,
          delivery_sections.source_line_start AS delivery_line_start,
          delivery_sections.source_line_end AS delivery_line_end,
          matched_sections.related_source_path,
          matched_sections.freshness_class,
          NULL AS source_kind,
          NULL AS ingest_scope,
          NULL AS source_declared_at,
          NULL AS detail_available,
          documents.last_synced_at,
          matched_sections.ordinal AS matched_ordinal,
          delivery_sections.ordinal AS delivery_ordinal,
          ${businessScore} AS search_score
        FROM editor_knowledge_documents AS documents
        INNER JOIN editor_knowledge_sections AS matched_sections
          ON matched_sections.document_id = documents.document_id
         AND matched_sections.section_revision_sha256 = documents.section_revision_sha256
        INNER JOIN editor_knowledge_sections AS delivery_sections
          ON delivery_sections.document_id = matched_sections.document_id
         AND delivery_sections.section_id = matched_sections.delivery_section_id
         AND delivery_sections.section_revision_sha256 = documents.section_revision_sha256
        WHERE documents.section_revision_sha256 IS NOT NULL
          AND matched_sections.is_searchable = TRUE
          AND (${businessWhere})
      ),
      ranked_editor_matches AS (
        SELECT
          editor_span_matches.*,
          ROW_NUMBER() OVER (
            PARTITION BY source_id, delivery_section_id
            ORDER BY search_score DESC, matched_ordinal ASC, matched_section_id ASC
          ) AS delivery_match_rank
        FROM editor_span_matches
      ),
      document_matches AS (
        SELECT
          documents.document_id,
          documents.source,
          documents.source_id,
          documents.title,
          documents.markdown,
          1 AS match_position,
          NULL AS matched_span_position,
          NULL AS matched_section_id,
          NULL AS matched_section_title,
          NULL AS matched_content_layer,
          NULL AS delivery_section_id,
          NULL AS delivery_section_title,
          NULL AS delivery_content_layer,
          JSON_ARRAY() AS heading_path_json,
          NULL AS source_line_start,
          NULL AS source_line_end,
          NULL AS delivery_line_start,
          NULL AS delivery_line_end,
          NULL AS related_source_path,
          NULL AS freshness_class,
          documents.source_kind,
          documents.ingest_scope,
          documents.source_declared_at,
          documents.detail_available,
          documents.last_synced_at,
          0 AS delivery_ordinal,
          ${documentScore} AS search_score
        FROM (${DOCUMENT_READ_MODEL_SQL}) AS documents
        WHERE documents.section_count IS NULL
          AND (${documentWhere})
      )
      SELECT
        document_id,
        source,
        source_id,
        title,
        markdown,
        match_position,
        matched_span_position,
        matched_section_id,
        matched_section_title,
        matched_content_layer,
        delivery_section_id,
        delivery_section_title,
        delivery_content_layer,
        heading_path_json,
        source_line_start,
        source_line_end,
        delivery_line_start,
        delivery_line_end,
        related_source_path,
        freshness_class,
        source_kind,
        ingest_scope,
        source_declared_at,
        detail_available,
        search_score
      FROM (
        SELECT * FROM document_matches
        UNION ALL
        SELECT
          document_id,
          source,
          source_id,
          title,
          markdown,
          match_position,
          matched_span_position,
          matched_section_id,
          matched_section_title,
          matched_content_layer,
          delivery_section_id,
          delivery_section_title,
          delivery_content_layer,
          heading_path_json,
          source_line_start,
          source_line_end,
          delivery_line_start,
          delivery_line_end,
          related_source_path,
          freshness_class,
          source_kind,
          ingest_scope,
          source_declared_at,
          detail_available,
          last_synced_at,
          delivery_ordinal,
          search_score
        FROM ranked_business_matches
        WHERE delivery_match_rank = 1
        UNION ALL
        SELECT
          document_id,
          source,
          source_id,
          title,
          markdown,
          match_position,
          matched_span_position,
          matched_section_id,
          matched_section_title,
          matched_content_layer,
          delivery_section_id,
          delivery_section_title,
          delivery_content_layer,
          heading_path_json,
          source_line_start,
          source_line_end,
          delivery_line_start,
          delivery_line_end,
          related_source_path,
          freshness_class,
          source_kind,
          ingest_scope,
          source_declared_at,
          detail_available,
          last_synced_at,
          delivery_ordinal,
          search_score
        FROM ranked_editor_matches
        WHERE delivery_match_rank = 1
      ) AS matches
      ORDER BY search_score DESC, last_synced_at DESC, document_id ASC, delivery_ordinal ASC
      LIMIT ${limitedTopK}`;
}

export function buildKeywordSearchParams(terms: string[]): string[] {
  if (terms.length < 1 || terms.length > 8) {
    throw new RangeError("terms must contain from 1 to 8 items");
  }
  const patterns = terms.map(buildLikePattern);
  return [
    ...patterns.flatMap((pattern) => [pattern, pattern]), // business_span_matches search_score
    ...patterns.flatMap((pattern) => [pattern, pattern]), // business_span_matches WHERE
    ...patterns.flatMap((pattern) => [pattern, pattern]), // editor_span_matches search_score
    ...patterns.flatMap((pattern) => [pattern, pattern]), // editor_span_matches WHERE
    ...patterns.flatMap((pattern) => [pattern, pattern]), // document_matches search_score
    ...patterns.flatMap((pattern) => [pattern, pattern])  // document_matches WHERE
  ];
}

function buildTermScoreSql(termCount: number, titleColumn: string, textColumn: string): string {
  return Array.from({ length: termCount }, () =>
    `(CASE WHEN ${titleColumn} LIKE ? ESCAPE '\\\\' THEN 5 ELSE 0 END + ` +
    `CASE WHEN ${textColumn} LIKE ? ESCAPE '\\\\' THEN 1 ELSE 0 END)`
  ).join(" + ");
}

function buildTermWhereSql(termCount: number, titleColumn: string, textColumn: string): string {
  return Array.from(
    { length: termCount },
    () => `(${titleColumn} LIKE ? ESCAPE '\\\\' OR ${textColumn} LIKE ? ESCAPE '\\\\')`
  ).join(" OR ");
}

function toRecordRow(row: TidbRow): Record<string, unknown> {
  if (Array.isArray(row) || row === null || typeof row !== "object") {
    throw new DataShapeError("TiDB row must be an object");
  }
  return row as Record<string, unknown>;
}

function parseSearchContextHit(row: Record<string, unknown>): SearchContextHit {
  const source = parseDocumentSource(row.source);
  const hit: SearchContextHit = {
    document_id: parseRequiredString(row.document_id, "document_id"),
    source,
    title: parseNullableString(row.title, "title"),
    text: parseRequiredString(row.markdown, "markdown"),
    match_position: parseNumber(row.match_position, "match_position"),
    matched_terms: [],
    score: 0,
    search_stage: "phrase"
  };
  // document_matches rows (whole-document, non-sectioned fallback) always carry a NULL
  // delivery_section_id; business_span_matches and editor_span_matches rows never do. This
  // distinguishes a section hit from a plain document hit regardless of source, so both
  // Business Knowledge and Editor Knowledge sectioned documents are enriched the same way.
  if (row.delivery_section_id === null || row.delivery_section_id === undefined) {
    return hit;
  }

  const sourceId = parseRequiredString(row.source_id, "source_id");
  const deliverySectionId = parseRequiredString(row.delivery_section_id, "delivery_section_id");
  const sectionedHit: SearchContextHit = {
    ...hit,
    matched_span_position: parseNumber(row.matched_span_position, "matched_span_position"),
    matched_section_id: parseRequiredString(row.matched_section_id, "matched_section_id"),
    matched_section_title: parseRequiredString(row.matched_section_title, "matched_section_title"),
    matched_content_layer: parseRequiredString(row.matched_content_layer, "matched_content_layer"),
    delivery_section_id: deliverySectionId,
    delivery_section_title: parseRequiredString(row.delivery_section_title, "delivery_section_title"),
    delivery_content_layer: parseRequiredString(row.delivery_content_layer, "delivery_content_layer"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end"),
    delivery_line_start: parseNumber(row.delivery_line_start, "delivery_line_start"),
    delivery_line_end: parseNumber(row.delivery_line_end, "delivery_line_end"),
    related_source_path: parseNullableString(row.related_source_path, "related_source_path"),
    freshness_class: parseNullableString(row.freshness_class, "freshness_class"),
    resource_uri: source === "business_knowledge"
      ? buildBusinessKnowledgeSectionUri(sourceId, deliverySectionId)
      : buildEditorKnowledgeSectionUri(sourceId, deliverySectionId)
  };

  if (source !== "business_knowledge") {
    // Editor Knowledge sectioned documents (kikaku-*) have no source_kind/ingest_scope/
    // source_declared_at/detail_available concept; those columns don't exist on
    // editor_knowledge_documents, so they are intentionally left unset here.
    return sectionedHit;
  }

  return {
    ...sectionedHit,
    source_kind: parseRequiredString(row.source_kind, "source_kind"),
    ingest_scope: parseRequiredString(row.ingest_scope, "ingest_scope"),
    source_declared_at: parseSourceDeclaredAt(row.source_declared_at),
    detail_available: parseNullableBoolean(row.detail_available, "detail_available")
  };
}

function enrichSearchHit(
  hit: SearchContextHit,
  terms: string[],
  stage: SearchContextHit["search_stage"],
  score: number
): SearchContextHit {
  const searchableText = normalizeSearchText(
    [
      hit.title ?? "",
      hit.matched_section_title ?? "",
      hit.delivery_section_title ?? "",
      ...(hit.heading_path ?? []),
      hit.text
    ].join("\n")
  ).toLocaleLowerCase("ja");
  const matchedTerms = terms.filter((term) =>
    searchableText.includes(normalizeSearchText(term).toLocaleLowerCase("ja"))
  );
  const contentText = normalizeSearchText(hit.text).toLocaleLowerCase("ja");
  const positions = matchedTerms
    .map((term) => contentText.indexOf(normalizeSearchText(term).toLocaleLowerCase("ja")))
    .filter((position) => position >= 0);
  const matchPosition = positions.length === 0 ? hit.match_position : Math.min(...positions) + 1;
  return {
    ...hit,
    match_position: matchPosition,
    matched_terms: matchedTerms,
    score,
    search_stage: stage
  };
}

function equalSearchText(left: string, right: string): boolean {
  return normalizeSearchText(left).toLocaleLowerCase("ja") ===
    normalizeSearchText(right).toLocaleLowerCase("ja");
}

function parseBusinessKnowledgeResource(row: Record<string, unknown>): BusinessKnowledgeResource {
  const documentId = parseRequiredString(row.document_id, "document_id");
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    section_id: sectionId,
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    markdown: parseRequiredString(row.section_markdown, "section_markdown"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end"),
    related_source_path: parseNullableString(row.related_source_path, "related_source_path"),
    freshness_class: parseNullableString(row.freshness_class, "freshness_class"),
    source_kind: parseRequiredString(row.source_kind, "source_kind"),
    ingest_scope: parseRequiredString(row.ingest_scope, "ingest_scope"),
    source_declared_at: parseSourceDeclaredAt(row.source_declared_at),
    detail_available: parseNullableBoolean(row.detail_available, "detail_available"),
    resource_uri: buildBusinessKnowledgeSectionUri(documentId, sectionId)
  };
}

function parseListedBusinessKnowledgeResource(
  row: Record<string, unknown>
): ListedBusinessKnowledgeResource {
  const documentId = parseRequiredString(row.document_id, "document_id");
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    section_id: sectionId,
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    size_bytes: parseNumber(row.size_bytes, "size_bytes"),
    related_source_path: parseNullableString(row.related_source_path, "related_source_path"),
    freshness_class: parseNullableString(row.freshness_class, "freshness_class"),
    source_kind: parseRequiredString(row.source_kind, "source_kind"),
    ingest_scope: parseRequiredString(row.ingest_scope, "ingest_scope"),
    source_declared_at: parseSourceDeclaredAt(row.source_declared_at),
    detail_available: parseNullableBoolean(row.detail_available, "detail_available"),
    resource_uri: buildBusinessKnowledgeSectionUri(documentId, sectionId)
  };
}

function parseEditorKnowledgeResource(row: Record<string, unknown>): EditorKnowledgeResource {
  const documentId = parseRequiredString(row.document_id, "document_id");
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    section_id: sectionId,
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    markdown: parseRequiredString(row.section_markdown, "section_markdown"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end"),
    related_source_path: parseNullableString(row.related_source_path, "related_source_path"),
    freshness_class: parseNullableString(row.freshness_class, "freshness_class"),
    resource_uri: buildEditorKnowledgeSectionUri(documentId, sectionId)
  };
}

function parseListedEditorKnowledgeResource(
  row: Record<string, unknown>
): ListedEditorKnowledgeResource {
  const documentId = parseRequiredString(row.document_id, "document_id");
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    section_id: sectionId,
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    size_bytes: parseNumber(row.size_bytes, "size_bytes"),
    related_source_path: parseNullableString(row.related_source_path, "related_source_path"),
    freshness_class: parseNullableString(row.freshness_class, "freshness_class"),
    resource_uri: buildEditorKnowledgeSectionUri(documentId, sectionId)
  };
}

function parseAuthorStyleEvidenceHit(row: Record<string, unknown>): AuthorStyleEvidenceHit {
  const documentId = parseAuthorStyleDocumentId(row.document_id);
  const deliverySectionId = parseRequiredString(row.delivery_section_id, "delivery_section_id");
  return {
    document_id: documentId,
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    matched_section_id: parseRequiredString(row.matched_section_id, "matched_section_id"),
    matched_section_title: parseRequiredString(
      row.matched_section_title,
      "matched_section_title"
    ),
    matched_content_layer: parseRequiredString(
      row.matched_content_layer,
      "matched_content_layer"
    ),
    delivery_section_id: deliverySectionId,
    delivery_section_title: parseRequiredString(
      row.delivery_section_title,
      "delivery_section_title"
    ),
    delivery_context_key: parseNullableString(row.delivery_context_key, "delivery_context_key"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end"),
    matched_position: parseNumber(row.matched_position, "matched_position"),
    markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown"),
    resource_uri: buildAuthorStyleSectionUri(documentId, deliverySectionId)
  };
}

function parseListedAuthorStyleResource(
  row: Record<string, unknown>
): ListedAuthorStyleResource {
  const documentId = parseAuthorStyleDocumentId(row.document_id);
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    section_id: sectionId,
    context_key: parseRequiredString(row.context_key, "context_key"),
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    size_bytes: parseNumber(row.size_bytes, "size_bytes"),
    resource_uri: buildAuthorStyleSectionUri(documentId, sectionId)
  };
}

function parseAuthorStyleDocumentId(value: unknown): AuthorStyleDocumentId {
  if (value === "ore-title-style" || value === "ore-body-style") return value;
  throw new DataShapeError("document_id must be ore-title-style or ore-body-style");
}

function parseMetaskillEvidenceHit(row: Record<string, unknown>): MetaskillEvidenceHit {
  const documentId = parseMetaskillDocumentId(row.document_id);
  const deliverySectionId = parseRequiredString(row.delivery_section_id, "delivery_section_id");
  return {
    document_id: documentId,
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    matched_section_id: parseRequiredString(row.matched_section_id, "matched_section_id"),
    matched_section_title: parseRequiredString(row.matched_section_title, "matched_section_title"),
    matched_content_layer: parseRequiredString(row.matched_content_layer, "matched_content_layer"),
    delivery_section_id: deliverySectionId,
    delivery_section_title: parseRequiredString(
      row.delivery_section_title,
      "delivery_section_title"
    ),
    delivery_context_key: parseNullableString(row.delivery_context_key, "delivery_context_key"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    source_line_start: parseNumber(row.source_line_start, "source_line_start"),
    source_line_end: parseNumber(row.source_line_end, "source_line_end"),
    matched_position: parseNumber(row.matched_position, "matched_position"),
    markdown: parseRequiredString(row.delivery_markdown, "delivery_markdown"),
    resource_uri: buildMetaskillSectionUri(documentId, deliverySectionId)
  };
}

function parseListedMetaskillResource(
  row: Record<string, unknown>
): ListedMetaskillResource {
  const documentId = parseMetaskillDocumentId(row.document_id);
  const sectionId = parseRequiredString(row.section_id, "section_id");
  return {
    document_id: documentId,
    revision_sha256: parseRequiredString(row.revision_sha256, "revision_sha256"),
    section_id: sectionId,
    context_key: parseRequiredString(row.context_key, "context_key"),
    title: parseRequiredString(row.title, "title"),
    heading_path: parseStringArray(row.heading_path_json, "heading_path_json"),
    content_layer: parseRequiredString(row.content_layer, "content_layer"),
    size_bytes: parseNumber(row.size_bytes, "size_bytes"),
    resource_uri: buildMetaskillSectionUri(documentId, sectionId)
  };
}

function parseMetaskillDocumentId(value: unknown): MetaskillDocumentId {
  if (value === "ai-self-strategy") return value;
  throw new DataShapeError("document_id must be ai-self-strategy");
}

function parseDocumentSource(value: unknown): DocumentSource {
  if (value === "notion" || value === "editor_knowledge" || value === "business_knowledge") {
    return value;
  }
  throw new DataShapeError("source must be notion, editor_knowledge, or business_knowledge");
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DataShapeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  throw new DataShapeError(`${fieldName} must be a string or null`);
}

function parseNumber(value: unknown, fieldName: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new DataShapeError(`${fieldName} must be a number`);
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseNullableNumber(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseNumber(value, fieldName);
}

function parseNullableBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseBoolean(value, fieldName);
}

function parseSourceDeclaredAt(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:$|T|\s)/.test(value)) {
    return value.slice(0, 10);
  }
  throw new DataShapeError("source_declared_at must be a DATE string, Date, or null");
}

function parseStringArray(value: unknown, fieldName: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return value;
    }
    throw new DataShapeError(`${fieldName} JSON array must contain only strings`);
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parseStringArray(parsed, fieldName);
    } catch (error) {
      if (error instanceof DataShapeError) {
        throw error;
      }
      throw new DataShapeError(`${fieldName} is not valid JSON`, { cause: error });
    }
  }
  throw new DataShapeError(`${fieldName} must be a JSON string array`);
}

function parseJsonValue(value: unknown, fieldName: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new DataShapeError(`${fieldName} is not valid JSON`, { cause: error });
  }
}

function parseBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 0) {
      return false;
    }
    if (value === 1) {
      return true;
    }
  }
  if (typeof value === "string") {
    if (value === "0" || value.toLowerCase() === "false") {
      return false;
    }
    if (value === "1" || value.toLowerCase() === "true") {
      return true;
    }
  }
  throw new DataShapeError(`${fieldName} must be boolean-like`);
}

function dateToIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    return value;
  }
  throw new DataShapeError("date value must be a Date, string, or null");
}
