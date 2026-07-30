CREATE TABLE IF NOT EXISTS author_style_documents (
  document_id VARCHAR(128) PRIMARY KEY,
  author_key VARCHAR(64) NOT NULL,
  style_scope VARCHAR(32) NOT NULL,
  display_name VARCHAR(512) NOT NULL,
  source_path_key VARCHAR(512) NOT NULL,
  context_sha256 CHAR(64) NOT NULL,
  source_markdown MEDIUMTEXT NOT NULL,
  source_markdown_sha256 CHAR(64) NOT NULL,
  source_bytes INT UNSIGNED NOT NULL,
  source_line_count INT UNSIGNED NOT NULL,
  source_mtime_ms BIGINT UNSIGNED NOT NULL,
  parser_version VARCHAR(64) NOT NULL,
  sectioning_version VARCHAR(64) NOT NULL,
  routing_version VARCHAR(64) NOT NULL,
  routing_manifest_json JSON NOT NULL,
  outline_json JSON NOT NULL,
  section_count INT UNSIGNED NOT NULL,
  delivery_section_count INT UNSIGNED NOT NULL,
  search_span_count INT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  last_synced_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_author_style_scope (author_key, style_scope),
  UNIQUE KEY uk_author_style_source (source_path_key),
  KEY idx_author_style_active (status)
);

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS context_sha256 CHAR(64) NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS source_markdown MEDIUMTEXT NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS source_markdown_sha256 CHAR(64) NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS source_bytes INT UNSIGNED NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS source_line_count INT UNSIGNED NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS source_mtime_ms BIGINT UNSIGNED NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS parser_version VARCHAR(64) NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS sectioning_version VARCHAR(64) NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS routing_version VARCHAR(64) NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS routing_manifest_json JSON NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS outline_json JSON NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS section_count INT UNSIGNED NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS delivery_section_count INT UNSIGNED NULL;

ALTER TABLE author_style_documents
  ADD COLUMN IF NOT EXISTS search_span_count INT UNSIGNED NULL;

CREATE TABLE IF NOT EXISTS author_style_current_sections (
  document_id VARCHAR(128) NOT NULL,
  section_id VARCHAR(255) NOT NULL,
  context_key VARCHAR(255) NULL,
  parent_section_id VARCHAR(255) NULL,
  delivery_section_id VARCHAR(255) NOT NULL,
  section_type VARCHAR(32) NOT NULL,
  content_layer VARCHAR(32) NOT NULL,
  context_priority TINYINT UNSIGNED NOT NULL,
  heading_level TINYINT UNSIGNED NULL,
  title VARCHAR(512) NOT NULL,
  heading_path_json JSON NOT NULL,
  aliases_json JSON NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  source_line_start INT UNSIGNED NOT NULL,
  source_line_end INT UNSIGNED NOT NULL,
  content_chars INT UNSIGNED NOT NULL,
  estimated_tokens INT UNSIGNED NULL,
  direct_markdown MEDIUMTEXT NOT NULL,
  delivery_markdown MEDIUMTEXT NOT NULL,
  retrieval_text MEDIUMTEXT NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  is_searchable BOOLEAN NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_id, section_id),
  UNIQUE KEY uk_author_style_current_context (document_id, context_key),
  UNIQUE KEY uk_author_style_current_ordinal (document_id, ordinal),
  KEY idx_author_style_current_delivery (document_id, delivery_section_id),
  KEY idx_author_style_current_search
    (document_id, is_searchable, content_layer)
);
