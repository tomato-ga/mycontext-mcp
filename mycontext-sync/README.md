# mycontext-sync

Notion profile pages, noteAI editor knowledge, and fixed business knowledge
Markdown to TiDB sync CLI.

The stored shape is intentionally small: one Notion page becomes one row in
`notion_pages`, and the page body is saved as full Markdown text. There are no
embeddings, chunks, roles, tags, slugs, or local MCP server.
The fixed editor knowledge corpus is stored separately in
`editor_knowledge_documents`.
The fixed two-document business corpus is stored in
`business_knowledge_documents` plus versioned `business_knowledge_sections`.
Its boundaries come from H2/H3 headings or numbered `§` entries, never a
character-count splitter.
The two fixed author-style documents use two current-snapshot tables.
The document row holds the current source and routing manifest, while
`author_style_current_sections` holds only its current semantic delivery/search
units. Runtime selection happens server-side so an AI receives one complete
context pack per request.
The fixed Metaskill transcription follows the same append-only three-table
pattern, with topic/intent/depth routing over complete semantic sections.

## Scope

Implemented:

- Fixed Notion page list sync to TiDB.
- Automatic discovery of child pages and page links below the configured seed
  pages.
- `migrate`, `pull`, `doctor`, and `search` commands.
- Fixed 8-document editor knowledge sync via `pull-editor-knowledge` and
  verification via `doctor-editor-knowledge`.
- Fixed 2-document, section-first business knowledge sync via the dedicated
  `migrate-business-knowledge`, `pull-business-knowledge`, and
  `doctor-business-knowledge` commands.
- Fixed title/body author-style current-schema migration via
  `migrate-author-style` and verification via `doctor-author-style`.
- Fixed Metaskill transcription sync via `migrate-metaskill`,
  `pull-metaskill`, and `doctor-metaskill`.
- Plain `LIKE` search over `notion_pages.markdown`.

Not implemented, by design:

- Worker-side or realtime Obsidian sync.
- Chunk tables or vector embeddings.
- Character-count section splitting or overlap windows.
- Role, tag, slug, or profile-category storage.
- Whole-workspace Notion sync / Data Source Query.
- Webhooks.

## Setup

1. Create a Notion integration, give it read content permission, and share each
   target Notion page with it.
2. Copy `.env.example` to `.env` and fill in `NOTION_API_KEY` / TiDB connection
   values. `.env` is gitignored.
3. Put the seed `pages[]` entries (`pageId` + `title`) in `MIRROR_CONFIG_JSON`
   inside `.env`. If you prefer a separate local file, copy
   `mirror.config.example.json` to `mirror.config.json`; that file is also
   gitignored. `MIRROR_CONFIG_JSON` takes precedence when present.
4. `pull` will also recurse through `child_page` blocks and `link_to_page`
   blocks below those seed pages.
5. Set `EDITOR_KNOWLEDGE_SOURCE_ROOT` in `.env` to the absolute path of the
   local noteAI repository. The source file allowlist stays fixed in code.
6. Set `BUSINESS_KNOWLEDGE_SOURCE_ROOT` to the absolute directory containing
   `startup-science/` and `marketing-wisdom/`. Only the two fixed source paths
   are read.
7. Set `METASKILL_SOURCE_ROOT` to the absolute Kindle repository path. Only
   `docs/メタスキル_文字起こし.md` is read.
8. Install dependencies:

```bash
pnpm install
```

## Commands

```bash
pnpm migrate
pnpm pull
pnpm pull -- --dry-run
pnpm pull -- --page-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
pnpm doctor
pnpm pull-editor-knowledge
pnpm pull-editor-knowledge -- --dry-run
pnpm doctor-editor-knowledge
pnpm migrate-business-knowledge
pnpm pull-business-knowledge
pnpm pull-business-knowledge -- --dry-run
pnpm doctor-business-knowledge
pnpm migrate-author-style
pnpm doctor-author-style
pnpm migrate-metaskill
pnpm pull-metaskill
pnpm pull-metaskill -- --dry-run
pnpm doctor-metaskill
pnpm export-obsidian
pnpm run search -- --query "some phrase" --top-k 5
pnpm test
pnpm typecheck
```

Use `pnpm run search`; bare `pnpm search` is pnpm's registry search command.

## Manual Smoke Test

1. Run `pnpm migrate`.
2. Run `pnpm pull -- --reindex`.
3. Confirm TiDB has the configured seed pages plus any discovered child/link
   pages in `notion_pages`.
4. Run `pnpm doctor`; expect exit 0.
5. Run `pnpm pull-editor-knowledge`, then `pnpm doctor-editor-knowledge`; expect
   exactly 8 healthy rows in `editor_knowledge_documents`.
6. Run `pnpm migrate-business-knowledge`; it applies only
   `business-knowledge-schema.sql`, which contains two fixed
   `CREATE TABLE IF NOT EXISTS` statements.
7. Run `pnpm pull-business-knowledge`, then
   `pnpm doctor-business-knowledge`; expect 2 documents, 325 active sections,
   and 287 searchable spans.
8. Run `pnpm export-obsidian`; expect Markdown files under the Obsidian vault's
   `_notion_pages/` directory.
9. Run `pnpm run search -- --query "<a phrase from the Notion page>" --top-k 5`;
   expect rows with full-page Markdown excerpts.
10. Run `pnpm migrate-author-style`; after the fixed Notion pages are synced
    from `Ready`, run `pnpm doctor-author-style`; expect 2 active documents
    and every routing combination to fit without truncation.
11. Run `pnpm migrate-metaskill`, `pnpm pull-metaskill`, and
    `pnpm doctor-metaskill`; expect 1 active document, 40 delivery sections,
    230 searchable spans, and all 69 valid routes to fit without truncation.

## Obsidian Export

Obsidian sync is local and automatic via launchd. The export command reads TiDB
and writes generated Markdown files; it does not call the Notion API.

```bash
pnpm export-obsidian
```

Defaults:

- vault: `~/Library/Mobile Documents/iCloud~md~obsidian/Documents`
- output: `_notion_pages`

Each generated note includes the required Obsidian properties plus the full
Notion Markdown body. `_notion_pages/.notion-pages.json` keeps the pageId to
filename mapping so title changes do not create duplicate files.

For launchd or cron usage, call:

```text
scripts/run-obsidian-sync.sh
```

The script runs `pnpm pull` and then `pnpm export-obsidian`. Keep the actual
LaunchAgent plist local because it usually contains machine-specific paths.

## Database Shape

These nine application tables are required:

```sql
notion_pages(page_id, title, markdown, markdown_sha256, truncated,
  unknown_block_ids, last_synced_at, created_at, updated_at)

editor_knowledge_documents(document_id, title, markdown, markdown_sha256,
  last_synced_at, created_at, updated_at)

business_knowledge_documents(document_id, title, source_path_key, source_kind,
  ingest_scope, markdown, markdown_sha256, section_revision_sha256,
  parser_version, sectioning_version, section_count, search_span_count,
  outline_json, routing_metadata_json, last_synced_at, created_at, updated_at)

business_knowledge_sections(document_id, section_id,
  section_revision_sha256, parent_section_id, delivery_section_id,
  heading_path_json, ordinal, source_line_start, source_line_end,
  direct_markdown, section_markdown, retrieval_text, content_sha256,
  is_searchable, related_source_path, freshness_class, last_synced_at,
  created_at, updated_at)

author_style_documents(document_id, author_key, style_scope, display_name,
  source_path_key, context_sha256, source_markdown, source_markdown_sha256,
  parser_version, sectioning_version, routing_version,
  routing_manifest_json, outline_json, section_count, delivery_section_count,
  search_span_count, status, last_synced_at, created_at, updated_at)

author_style_current_sections(document_id, section_id, context_key,
  parent_section_id, delivery_section_id, section_type, content_layer,
  context_priority, heading_path_json, aliases_json, ordinal,
  direct_markdown, delivery_markdown, retrieval_text, content_sha256,
  is_searchable, created_at, updated_at)

metaskill_documents(document_id, display_name, source_path_key,
  active_revision_sha256, status, last_synced_at, created_at, updated_at)

metaskill_revisions(document_id, revision_sha256, source_markdown,
  source_markdown_sha256, parser_version, sectioning_version, routing_version,
  routing_manifest_json, outline_json, section_count, delivery_section_count,
  search_span_count, synced_at, created_at)

metaskill_sections(document_id, revision_sha256, section_id, context_key,
  parent_section_id, delivery_section_id, section_type, content_layer,
  context_priority, heading_path_json, aliases_json, ordinal,
  direct_markdown, delivery_markdown, retrieval_text, content_sha256,
  is_searchable, created_at, updated_at)
```

Business section rows are revisioned by source content plus parser versions.
The sync does not delete old revisions and never writes to `notion_pages` or
`editor_knowledge_documents`. Retention or cleanup is intentionally outside
these commands.
Author style is intentionally not revisioned in TiDB. A sync replaces the
document snapshot and that document's current sections in one transaction.
`context_sha256` is an integrity/idempotency fingerprint, not a history key.
Metaskill revisions use the same atomic active-revision switch and retain the
raw transcription in `source_markdown`.
