ALTER TABLE author_style_documents
  DROP INDEX idx_author_style_active;

ALTER TABLE author_style_documents
  DROP COLUMN active_revision_sha256;

ALTER TABLE author_style_documents
  MODIFY COLUMN context_sha256 CHAR(64) NOT NULL,
  MODIFY COLUMN source_markdown MEDIUMTEXT NOT NULL,
  MODIFY COLUMN source_markdown_sha256 CHAR(64) NOT NULL,
  MODIFY COLUMN source_bytes INT UNSIGNED NOT NULL,
  MODIFY COLUMN source_line_count INT UNSIGNED NOT NULL,
  MODIFY COLUMN source_mtime_ms BIGINT UNSIGNED NOT NULL,
  MODIFY COLUMN parser_version VARCHAR(64) NOT NULL,
  MODIFY COLUMN sectioning_version VARCHAR(64) NOT NULL,
  MODIFY COLUMN routing_version VARCHAR(64) NOT NULL,
  MODIFY COLUMN routing_manifest_json JSON NOT NULL,
  MODIFY COLUMN outline_json JSON NOT NULL,
  MODIFY COLUMN section_count INT UNSIGNED NOT NULL,
  MODIFY COLUMN delivery_section_count INT UNSIGNED NOT NULL,
  MODIFY COLUMN search_span_count INT UNSIGNED NOT NULL;

ALTER TABLE author_style_documents
  ADD KEY idx_author_style_active (status);

DROP TABLE author_style_revisions;

DROP TABLE author_style_sections;
