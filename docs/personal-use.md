# Personal Use With a Public Repository

This project is public, but personal runtime data stays local.

## Keep These Local

Do not commit these files:

- `notion-context-sync/.env`
- `notion-context-sync/mirror.config.json`
- `notion-context-mcp-worker/.dev.vars`
- `MEMORY.md`
- `**/MEMORY.md`
- `logs/`
- `node_modules/`
- `.wrangler/`

They are ignored by git. They can contain Notion page IDs, private page titles,
Notion API keys, TiDB credentials, MCP bearer tokens, local logs, or generated
memory summaries.

## Recommended Local Setup

Keep personal Notion seed pages in `.env`:

```env
MIRROR_CONFIG_JSON={"pages":[{"pageId":"your-private-page-id","title":"your-private-page-title"}]}
```

`MIRROR_CONFIG_JSON` takes precedence over `mirror.config.json`. This lets you
keep the sync target and credentials together in the ignored `.env` file.

Existing local `mirror.config.json` files still work. If `MIRROR_CONFIG_JSON`
is absent, the CLI reads `mirror.config.json` as before.

## Production Secrets

Use platform secrets for deployed Worker values:

```bash
wrangler secret put TIDB_DATABASE_URL
wrangler secret put MCP_ACCESS_TOKEN
```

Local Worker development can use `notion-context-mcp-worker/.dev.vars`, which is
ignored by git.

## Before Pushing

Run:

```bash
./scripts/check-public-safety.sh
```

Then run the subproject checks:

```bash
cd notion-context-sync
pnpm run typecheck
pnpm test

cd ../notion-context-mcp-worker
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
