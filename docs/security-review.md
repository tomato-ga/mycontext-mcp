# Security Review

Date: 2026-07-07

## Executive Summary

The project is ready to publish publicly after excluding local secret files, generated memory files, logs, dependency folders, and machine-specific runtime files from git. The public Worker endpoint remains intentionally small: `/healthz` is public and `/mcp` requires a bearer token. SQL access is parameterized and the Worker exposes no raw SQL tool.

No committed production secrets should be included in the public repository. Real local credential files exist for development, so they must remain untracked and should be rotated if they were ever committed, shared, or uploaded elsewhere.

## Findings

### SEC-001: Local secret files must not be committed

- Severity: High
- Location: `.gitignore`
- Evidence: local-only files such as `.env`, `.dev.vars`, and `mirror.config.json` are excluded by root gitignore rules. Private Notion page IDs/titles can also live in ignored `.env` via `MIRROR_CONFIG_JSON`.
- Impact: committing Notion API keys, TiDB credentials, or MCP bearer tokens would allow unauthorized reads of private context data.
- Fix: keep only `.env.example`, `.dev.vars.example`, and `mirror.config.example.json` in git. Use local env files and Wrangler secrets for real values.
- Status: Fixed.

### SEC-002: Generated memory and logs include local operational context

- Severity: Medium
- Location: `.gitignore`
- Evidence: `MEMORY.md`, `**/MEMORY.md`, `logs/`, and `*.log` are excluded.
- Impact: public memory/log files can leak local paths, run history, implementation notes, or error details.
- Fix: exclude generated memory front pages and runtime logs from git.
- Status: Fixed.

### SEC-003: Worker responses should include baseline hardening headers

- Severity: Low
- Location: `notion-context-mcp-worker/src/index.ts`
- Evidence: `withSecurityHeaders` now adds `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- Impact: these headers reduce accidental browser interpretation, referrer leakage, and framing of public responses.
- Fix: wrap health, auth error, not found, and MCP responses with baseline headers.
- Status: Fixed.

### SEC-004: Bearer token comparison should avoid length-based early return

- Severity: Low
- Location: `notion-context-mcp-worker/src/auth.ts`
- Evidence: `constantTimeEqual` now compares across the maximum input length and includes length in the diff.
- Impact: avoids a length-based timing shortcut in token comparison.
- Fix: remove early return for unequal lengths.
- Status: Fixed.

## Positive Checks

- `notion-context-sync/src/tidb.ts` uses parameterized queries for page reads, writes, and search terms. The only interpolated SQL values are validated database names and integer `LIMIT` values.
- `notion-context-mcp-worker/src/tidb.ts` validates `topK` before interpolating `LIMIT`, and uses query parameters for user search text.
- `notion-context-sync/src/obsidianExport.ts` verifies export paths remain inside the configured vault/output directory.
- The Worker does not call the Notion API, run migrations, write to TiDB, expose raw SQL, or read/write Obsidian files.
- `/mcp` requires `Authorization: Bearer $MCP_ACCESS_TOKEN`; `/healthz` returns only `ok`.

## Verification Commands

Verified before publishing:

```bash
cd notion-context-sync
pnpm run typecheck
pnpm test
pnpm audit --audit-level moderate

cd ../notion-context-mcp-worker
pnpm run typecheck
pnpm test
pnpm audit --audit-level moderate
```

Result: both subprojects passed typecheck, tests, and audit with no known vulnerabilities after upgrading `vitest`/`vite`.

Also verify the git staging set before push:

```bash
git add -n .
git status --short
```

Result: `./scripts/check-public-safety.sh`, staged secret scan, personal absolute path scan, and `git diff --cached --check` passed.
