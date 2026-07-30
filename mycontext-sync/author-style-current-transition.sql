START TRANSACTION;

UPDATE author_style_documents AS documents
INNER JOIN author_style_revisions AS revisions
  ON revisions.document_id = documents.document_id
 AND revisions.revision_sha256 = documents.active_revision_sha256
SET
  documents.context_sha256 = revisions.revision_sha256,
  documents.source_markdown = revisions.source_markdown,
  documents.source_markdown_sha256 = revisions.source_markdown_sha256,
  documents.source_bytes = revisions.source_bytes,
  documents.source_line_count = revisions.source_line_count,
  documents.source_mtime_ms = revisions.source_mtime_ms,
  documents.parser_version = revisions.parser_version,
  documents.sectioning_version = revisions.sectioning_version,
  documents.routing_version = revisions.routing_version,
  documents.routing_manifest_json = revisions.routing_manifest_json,
  documents.outline_json = revisions.outline_json,
  documents.section_count = revisions.section_count,
  documents.delivery_section_count = revisions.delivery_section_count,
  documents.search_span_count = revisions.search_span_count
WHERE documents.document_id IN ('ore-body-style', 'ore-title-style');

DELETE FROM author_style_current_sections
WHERE document_id IN ('ore-body-style', 'ore-title-style');

INSERT INTO author_style_current_sections
  (document_id, section_id, context_key, parent_section_id, delivery_section_id,
   section_type, content_layer, context_priority, heading_level, title,
   heading_path_json, aliases_json, ordinal, source_line_start, source_line_end,
   content_chars, estimated_tokens, direct_markdown, delivery_markdown,
   retrieval_text, content_sha256, is_searchable, created_at, updated_at)
SELECT
  sections.document_id,
  sections.section_id,
  sections.context_key,
  sections.parent_section_id,
  sections.delivery_section_id,
  sections.section_type,
  sections.content_layer,
  sections.context_priority,
  sections.heading_level,
  sections.title,
  sections.heading_path_json,
  sections.aliases_json,
  sections.ordinal,
  sections.source_line_start,
  sections.source_line_end,
  sections.content_chars,
  sections.estimated_tokens,
  sections.direct_markdown,
  sections.delivery_markdown,
  sections.retrieval_text,
  sections.content_sha256,
  sections.is_searchable,
  sections.created_at,
  sections.updated_at
FROM author_style_sections AS sections
INNER JOIN author_style_documents AS documents
  ON documents.document_id = sections.document_id
 AND documents.active_revision_sha256 = sections.revision_sha256
WHERE documents.document_id IN ('ore-body-style', 'ore-title-style');

COMMIT;
