# Security Review

Date: 2026-07-11

## Executive Summary

The project is ready to publish publicly after excluding local secret files, generated memory files, logs, dependency folders, and machine-specific runtime files from git. The public Worker endpoint remains intentionally small: `/healthz` is public and `/mcp` requires an OAuth access token. SQL access is parameterized and the Worker exposes no raw SQL tool.

No committed production secrets should be included in the public repository. Real local credential files exist for development, so they must remain untracked and should be rotated if they were ever committed, shared, or uploaded elsewhere.

## Findings

### SEC-001: Local secret files must not be committed

- Severity: High
- Location: `.gitignore`
- Evidence: local-only files such as `.env`, `.dev.vars`, and `mirror.config.json` are excluded by root gitignore rules. Private Notion page IDs/titles and the editor knowledge source root live in ignored `.env`.
- Impact: committing Notion API keys, TiDB credentials, or OAuth secrets would allow unauthorized reads of private context data.
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
- Location: `mycontext-mcp-worker/src/index.ts`
- Evidence: `withSecurityHeaders` now adds `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`.
- Impact: these headers reduce accidental browser interpretation, referrer leakage, and framing of public responses.
- Fix: wrap health, auth error, not found, and MCP responses with baseline headers.
- Status: Fixed.

### SEC-004: Bearer token comparison should avoid length-based early return

- Severity: Low
- Location: `mycontext-mcp-worker/src/auth.ts`
- Evidence: `constantTimeEqual` now compares across the maximum input length and includes length in the diff.
- Impact: avoids a length-based timing shortcut in token comparison.
- Fix: remove early return for unequal lengths.
- Status: Fixed.

### SEC-005: Business knowledge sync must not mutate unrelated TiDB data

- Severity: High
- Location: `mycontext-sync/business-knowledge-schema.sql`, `mycontext-sync/src/tidb.ts`
- Evidence: the business migration contains only two fixed `CREATE TABLE IF NOT EXISTS` statements, and the sync writer uses fixed-table UPSERTs for two allowlisted document IDs. It contains no cleanup path, `DELETE`, `TRUNCATE`, `DROP`, or writes to `notion_pages` / `editor_knowledge_documents`.
- Impact: the configured writer credential can have broader privileges than this operation needs, so SQL scope is the primary protection against accidental data loss.
- Fix: use the dedicated `migrate-business-knowledge` command, append-only section revisions, fixed identifiers, and before/after fingerprints for existing tables.
- Status: Fixed by design and covered by tests/runtime verification.

### SEC-006: Author-style sync and retrieval must stay isolated

- Severity: High
- Location: `mycontext-sync/author-style-schema.sql`, author-style sync/parser,
  and the two dedicated Worker tools.
- Evidence: migration creates only two current-snapshot `author_style_*` tables;
  sync uses two fixed document IDs and exact Notion page IDs, then transactionally
  replaces only that document and its current sections. The
  general document list/search SQL does not include author style. Worker access
  is read-only and selector values are allowlisted before parameterized SQL.
- Impact: mixing personal style sources into generic search would increase
  accidental context exposure and token use; partial revision activation could
  return incomplete rules.
- Fix: dedicated tables and tools, current-snapshot joins, complete semantic
  delivery sections, no truncation, and audit-only full-source Resources.
- Status: Fixed by design, unit-tested, and live-smoke verified.

## Positive Checks

- `mycontext-sync/src/tidb.ts` uses parameterized queries for Notion, editor knowledge, and business knowledge reads/writes. The only interpolated SQL values are validated database names and integer `LIMIT` values.
- `mycontext-mcp-worker/src/tidb.ts` validates `topK` before interpolating `LIMIT`, and uses query parameters for user search text.
- `mycontext-sync/src/obsidianExport.ts` verifies export paths remain inside the configured vault/output directory.
- The Worker does not call the Notion API, run migrations, write to TiDB, expose raw SQL, or read/write Obsidian files.
- Business section Resources are read-only and resolve only the two allowlisted document IDs and their active section revisions.
- Author-style Resources and tools resolve only current snapshots; normal
  context output contains complete selected sections once, while structured
  content contains metadata only.
- `/mcp` requires an OAuth access token issued after DCR + S256 PKCE and an
  approved GitHub user-ID check; `/healthz` returns only `ok`.

## Verification Commands

Verified before publishing:

```bash
cd mycontext-sync
pnpm run typecheck
pnpm test
pnpm audit --audit-level moderate

cd ../mycontext-mcp-worker
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
