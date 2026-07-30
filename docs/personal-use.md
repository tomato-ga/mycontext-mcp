# Personal Use With a Public Repository

This project is public, but personal runtime data stays local.

## Keep These Local

Do not commit these files:

- `mycontext-sync/.env`
- `mycontext-sync/mirror.config.json`
- `mycontext-mcp-worker/.dev.vars`
- `MEMORY.md`
- `**/MEMORY.md`
- `logs/`
- `node_modules/`
- `.wrangler/`

They are ignored by git. They can contain Notion page IDs, private page titles,
absolute local Markdown source paths, Notion API keys, TiDB credentials, OAuth
secrets, local logs, or generated memory summaries.

## Recommended Local Setup

Keep personal Notion seed pages in `.env`:

```env
MIRROR_CONFIG_JSON={"pages":[{"pageId":"your-private-page-id","title":"your-private-page-title"}]}
EDITOR_KNOWLEDGE_SOURCE_ROOT=/absolute/path/to/noteAI
BUSINESS_KNOWLEDGE_SOURCE_ROOT=/absolute/path/to/claude/skills
AUTHOR_STYLE_SOURCE_ROOT=/absolute/path/to/noteAI
```

`MIRROR_CONFIG_JSON` takes precedence over `mirror.config.json`. This lets you
keep the sync target and credentials together in the ignored `.env` file.

Existing local `mirror.config.json` files still work. If `MIRROR_CONFIG_JSON`
is absent, the CLI reads `mirror.config.json` as before.

`BUSINESS_KNOWLEDGE_SOURCE_ROOT` is used only with a fixed two-file allowlist.
The absolute value is never stored in TiDB or exposed by MCP; TiDB stores only
the public-safe relative source key.

`AUTHOR_STYLE_SOURCE_ROOT` is local-only and reserved for explicit emergency
restore/diagnostic commands. Normal author-style synchronization accepts only
the two configured Notion pages. TiDB stores one current source snapshot and
current semantic sections, never historical revisions or the machine-local root.

For the business corpus, use the dedicated migration and sync commands. They
only create/write `business_knowledge_documents` and
`business_knowledge_sections`; the sync path contains no `DELETE`, `TRUNCATE`,
`DROP`, or writes to the existing Notion/editor tables.

```bash
pnpm migrate-business-knowledge
pnpm pull-business-knowledge
pnpm doctor-business-knowledge
pnpm migrate-author-style
```

## Production Secrets

Use platform secrets for deployed Worker values:

```bash
wrangler secret put TIDB_DATABASE_URL
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_ALLOWED_USER_ID
```

Local Worker development can use `mycontext-mcp-worker/.dev.vars`, which is
ignored by git.

## Before Pushing

Run:

```bash
./scripts/check-public-safety.sh
```

Then run the subproject checks:

```bash
cd mycontext-sync
pnpm run typecheck
pnpm test

cd ../mycontext-mcp-worker
pnpm run typecheck
pnpm test
```

The public safety check looks for tracked secret files, common token patterns,
machine-local paths, generated memory files, and known personal placeholder
values that should not be public.

## If Something Leaks

1. Rotate the affected secret first.
2. Remove the value from the repository.
3. Rewrite public history if the value was pushed.
4. Re-run `./scripts/check-public-safety.sh`.
