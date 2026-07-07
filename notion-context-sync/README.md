# notion-context-sync

Notion profile pages to TiDB sync CLI.

The stored shape is intentionally small: one Notion page becomes one row in
`notion_pages`, and the page body is saved as full Markdown text. There are no
embeddings, chunks, roles, tags, slugs, or local MCP server.

## Scope

Implemented:

- Fixed Notion page list sync to TiDB.
- Automatic discovery of child pages and page links below the configured seed
  pages.
- `migrate`, `pull`, `doctor`, and `search` commands.
- Plain `LIKE` search over `notion_pages.markdown`.

Not implemented, by design:

- Worker-side or realtime Obsidian sync.
- Chunk tables or vector embeddings.
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
5. Install dependencies:

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
5. Run `pnpm export-obsidian`; expect Markdown files under the Obsidian vault's
   `_notion_pages/` directory.
6. Run `pnpm run search -- --query "<a phrase from the Notion page>" --top-k 5`;
   expect rows with full-page Markdown excerpts.

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

Only this application table is required:

```sql
notion_pages(page_id, title, markdown, markdown_sha256, truncated,
  unknown_block_ids, last_synced_at, created_at, updated_at)
```

Old tables from earlier designs can be dropped after `notion_pages` has been
populated and verified:

- `document_chunks`
- `document_snapshots`
- `source_documents`
- `sync_runs`
