# mycontext-mcp-v2-worker

Parallel, read-only Remote MCP server for synced Notion, editor knowledge,
sectioned business knowledge, routed author-style context, and the Metaskill
transcription stored in TiDB Cloud. This directory updates only the MCP server
stack; it does not replace or modify the existing `mycontext-mcp` Worker.

This Worker exposes Streamable HTTP at `/mcp` and a public non-secret liveness
endpoint at `/healthz`.

```text
Worker:   mycontext-mcp-v2
Origin:   https://mycontext-mcp-v2.servicedake.workers.dev
MCP:      https://mycontext-mcp-v2.servicedake.workers.dev/mcp
Callback: https://mycontext-mcp-v2.servicedake.workers.dev/oauth/github/callback
```

## Design

- Protocol target: MCP stable `2026-07-28`.
- Runtime: Cloudflare Workers with `nodejs_compat`.
- MCP packages: `@modelcontextprotocol/server@2.0.0`,
  `@modelcontextprotocol/client@2.0.0`, and `agents@0.20.1`.
- MCP transport: `createMcpHandler()` from `agents/mcp/server`, passed a fresh
  `McpServer` factory with `responseMode: "json"` and `legacy: "stateless"`.
  The MCP route is stateless and does not add sessions, Durable Objects,
  replay, or a second legacy endpoint.
- MCP methods: authenticated `POST /mcp` handles protocol requests.
  `GET /mcp` and `DELETE /mcp` return `405 Method Not Allowed` at the MCP
  handler; an unauthenticated request can receive the OAuth `401` challenge
  before reaching that handler.
- OAuth state: two v2-only Cloudflare Workers KV namespaces. No Durable
  Objects, no `McpAgent`, and no migrations.
- Database: TiDB Cloud Serverless Driver over HTTP via `@tidbcloud/serverless`;
  no TCP/mysql2 connection is used.
- Data access: read-only SQL against `notion_pages`,
  `editor_knowledge_documents`, `business_knowledge_documents`, and
  `business_knowledge_sections`, plus the two dedicated `author_style_*`
  and three dedicated `metaskill_*` tables. Full general documents use a fixed
  Worker-side `UNION ALL` read model; author style and Metaskill remain on
  dedicated retrieval paths.
- Search:
  - `get_planning_playbook_context` is the mandatory first retrieval path for
    creating, reviewing, or revising an article plan, heading outline, or body
    structure. It returns the complete `kikaku-composition-playbook` without
    truncation. Search is used only afterward for supporting examples or evidence.
  - `get_editing_playbook_context` is the mirrored first retrieval path for
    editing a completed draft (red-lining, proofreading, publish/no-publish
    decisions, post-publication rewrites). It returns the complete
    `henshu-editing-playbook` from one TiDB record without truncation.
  - `get_media_playbook_context` is the first retrieval path for media strategy,
    positioning, operations, KPI, distribution, and monetization. It returns the
    complete `knowhow-media-design` from one TiDB record without truncation.
  - `search_personal_context`: tries the full normalized phrase first, then
    extracts up to eight Japanese terms for title-weighted OR ranking, and
    finally retries a bounded synonym set. Business knowledge searches the
    smallest semantic spans and returns a stable ID for its delivery section.
  - Search results are compact candidates. Use `read_context` with the returned
    stable ID for detailed Markdown.
- Auth: OAuth 2.1 authorization code flow with S256 PKCE. Cloudflare's OAuth
  provider issues and validates MCP access and refresh tokens.
- Identity: GitHub OAuth is used only to authenticate the resource owner. Access
  is restricted to the immutable numeric GitHub user ID in
  `GITHUB_ALLOWED_USER_ID`; the upstream GitHub token is not persisted.
- Discovery: RFC 8414 authorization-server metadata, RFC 9728 protected-resource
  metadata (including the path-aware `/mcp` document), and standard dynamic
  client registration (DCR). CIMD is intentionally disabled so clients use the
  broadly compatible public-client + PKCE flow.
- Scope: all tools require `context:read` and are marked read-only. OAuth
  discovery also advertises `offline_access` so ChatGPT can retain refresh
  access explicitly.
- `/healthz`: public and returns only `ok`.

The Worker does not call the Notion API, does not read or write Obsidian files,
does not run migrations, and does not expose a raw SQL tool.

## Parallel isolation

The existing deployment remains independently usable:

- Existing Worker: `mycontext-mcp`
- Existing origin: `https://mycontext-mcp.servicedake.workers.dev`
- New Worker: `mycontext-mcp-v2`
- New origin: `https://mycontext-mcp-v2.servicedake.workers.dev`

Once deployed, the two Workers will not share OAuth KV, authorization tokens,
client registrations, or a GitHub OAuth App. The v2 Worker will use a separate
OAuth App whose callback is the v2 callback shown above. As of 2026-07-30, the
two v2-only KV namespaces exist, while the v2 Worker and OAuth App have not yet
been created or deployed. The existing Worker, its KV
namespaces, OAuth App, routes, active version, triggers, and client settings
must not be edited or redeployed during this migration.

Both Workers read the same existing read-only TiDB datasource. The v2
migration does not create, migrate, seed, update, or delete TiDB schema,
grants, tables, or rows, and it does not change either sync implementation.

## Tools

- `search_personal_context`
- `read_context`
- `get_planning_playbook_context`: mandatory first path for article planning
  and structure work; returns the complete planning playbook with no selectors
  and no truncation. It fails explicitly instead of returning a partial prefix.
- `get_editing_playbook_context`: mandatory first path for editing a completed
  draft through to the publish decision and post-publication improvements;
  single-record, no-truncation contract.
- `get_media_playbook_context`: mandatory first path for media strategy and
  operations; same single-record, no-truncation contract as the editing tool.
- `get_analysis_skill_context`: returns the requested analysis framework's
  complete `SKILL.md` and `reference.md` as one document.
- `get_author_style_context`: normal generation/edit/evaluation path; returns
  one selector-specific context pack without truncating semantic sections.
- `search_author_style_evidence`: audit path over evidence/profile/ops layers;
  matched spans expand to complete delivery sections.
- `get_metaskill_context`: normal topic/intent/depth path; returns one complete
  context pack without truncating selected semantic sections.
- `search_metaskill_evidence`: fine-grained search path for terms, examples,
  prompts, and supporting passages; hits expand to complete delivery sections.

General document IDs are namespaced as `notion:<page-id>` and
`editor-knowledge:<document-id>` or `business-knowledge:<document-id>`.
Business search results use
`business-knowledge:<document-id>#<local-section-id>`. `read_context` accepts
exactly one stable `id` copied from a search result.

`henshu-editing-playbook` and `knowhow-media-design` are compact whole-document
records. General search returns `editor-knowledge:<document-id>` for each, never
a `#chapter-*` ID. Their dedicated tools are the full, non-truncated paths.

For article planning and structure work, do not use search to discover the
playbook. Call `get_planning_playbook_context` first, then use
`search_personal_context` and `read_context` only for relevant catalog or
full-text evidence.

## Resources

The two source documents are available at:

```text
mycontext://business-knowledge/startup-science
mycontext://business-knowledge/marketing-wisdom
```

Active semantic sections use this template:

```text
mycontext://business-knowledge/{documentId}/sections/{sectionId}
```

Search returns a short text summary and compact structured candidates without
duplicating full Markdown. `read_context` returns Markdown once in text content
and metadata separately. Only section rows whose
`section_revision_sha256` matches the owning document are visible. Business
results and resources expose `source_kind`, `ingest_scope`,
`source_declared_at`, `detail_available`, content layers, freshness, and any
relative `related_source_path`, so an index-only source is not mistaken for
stored detail.

The public `/healthz` endpoint remains available for liveness monitoring.
Administrative document listing and database health helpers are not exposed as
ChatGPT tools.

Author-style full-source audit resources are available at:

```text
mycontext://author-style/ore-title-style
mycontext://author-style/ore-body-style
mycontext://author-style/{documentId}/sections/{sectionId}
```

Normal AI work should call `get_author_style_context`; full-source Resources
exist for audit and maintenance. The tool emits the context Markdown once in
MCP text content while structured content contains metadata only.

Metaskill full-source and semantic-section resources are available at:

```text
mycontext://metaskill/ai-self-strategy
mycontext://metaskill/{documentId}/sections/{sectionId}
```

Normal AI work should call `get_metaskill_context`. Prompt and example blocks
are returned as delimited reference material, not as caller instructions.

The TiDB reader used by `TIDB_DATABASE_URL` needs `SELECT` on all context tables:

```sql
GRANT SELECT ON notion_context.editor_knowledge_documents TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.business_knowledge_documents TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.business_knowledge_sections TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.author_style_documents TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.author_style_current_sections TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.metaskill_documents TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.metaskill_revisions TO '<reader-user>'@'%';
GRANT SELECT ON notion_context.metaskill_sections TO '<reader-user>'@'%';
```

## Environment

Runtime configuration is secret-managed outside this repository. The required
secret names are `TIDB_DATABASE_URL`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, and `GITHUB_ALLOWED_USER_ID`.
`PERSONAL_SYNONYMS` is optional. Do not copy the existing Worker's
`.dev.vars`, write secret values to this README or `wrangler.jsonc`, or print
them while preparing a new version.

`TIDB_DATABASE_URL` must come from the same private secret source and version
used by the existing Worker. The GitHub client credentials must instead come
from the separate v2 OAuth App. This preserves the TiDB datasource while
isolating authorization state.

If real credentials were ever shared in prompts, attachments, logs, or committed
files, rotate the TiDB password and OAuth app secret before using this endpoint
in production.

`PERSONAL_SYNONYMS` is an optional secret that personalizes `search_personal_context`'s
term-alias and synonym-fallback expansion (see `src/searchQuery.ts`). It is a JSON string
shaped like `{"termAliases":{"<nickname>":{"aliases":["<full name>"],"suppressOriginalTerm":true}},"synonymGroups":[["<term>","<synonym>",...]]}`
— `suppressOriginalTerm: true` drops the matched term itself and keeps only its aliases (useful
for a short nickname that should always resolve to a fuller, unambiguous form); omit it to keep
both. Because this value routinely encodes names and other personal facts, it must never be
committed to `wrangler.jsonc`'s `vars` or to `.dev.vars.example`. If it is
unset, missing, or fails to parse, `search_personal_context` still works
correctly and simply performs no synonym expansion; a parse failure is logged
as a warning, never a crash.

## Deploy

Only an explicitly reviewed version of `mycontext-mcp-v2` may be uploaded and
deployed. Run all local checks first:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
./../scripts/check-public-safety.sh
pnpm run typecheck
pnpm test
pnpm run verify:isolation
pnpm run verify:data-plane
pnpm run verify:oauth-policy
pnpm run verify:dependencies
pnpm run verify:release-plan
pnpm run deploy:dry-run
```

The release wrapper requires a completely clean, committed repository,
pnpm `11.7.0`, project-local Wrangler `4.107.0`, the expected
`CLOUDFLARE_ACCOUNT_ID`, and exactly one environment-based Cloudflare
authentication method. The private release environment constructs a
repository-external, mode-`0600` JSON secrets file without logging its
contents.

It also requires two repository-external files under a current-user-owned
directory with no group or other permissions:

- a mode-`0400` Cloudflare baseline containing the private account identifier
  and the canonical legacy Worker deployment, exact active-version ETags, cron,
  observability, subdomain, and KV inventory;
- a new manifest path that does not exist before upload.

Generate one lowercase UUID v4 in the private runner and keep that run identity
for the entire attempt. Preview the sanitized command shape and required checks
first; then upload a version without changing traffic:

```bash
node ./scripts/release-version.mjs upload \
  --run-id "$V2_RUN_ID" \
  --manifest-file "$V2_RELEASE_MANIFEST" \
  --secrets-file "$EPHEMERAL_SECRETS_FILE" \
  --cloudflare-baseline-file "$CLOUDFLARE_BASELINE_FILE" \
  --plan

node ./scripts/release-version.mjs upload \
  --run-id "$V2_RUN_ID" \
  --manifest-file "$V2_RELEASE_MANIFEST" \
  --secrets-file "$EPHEMERAL_SECRETS_FILE" \
  --cloudflare-baseline-file "$CLOUDFLARE_BASELINE_FILE"
```

Before upload, the wrapper verifies the frozen legacy state, all four KV
namespaces, and target absence. It reserves the manifest with exclusive
creation before remote mutation, searches the complete paginated version
history for tag collisions, and reconciles the remote state after the upload
command even if Wrangler exits nonzero or times out. Reconciliation also checks
the newly created target configuration and preview-URL policy. A successful
reconciliation seals the manifest as mode `0400`; the manifest fixes the
candidate version and ETag, provenance, canonical private baseline and its
SHA-256, and the post-upload/pre-deploy Cloudflare state.

If upload cannot be reconciled, the wrapper leaves a mode-`0600` private
`UNKNOWN` record with the same run identity and stops. Do not automatically
retry, choose a new run ID, upload again, or deploy from that record. Freeze
remote changes and resolve the existing identity with read-only Cloudflare
inventory first.

The deploy phase accepts only the immutable manifest; callers cannot substitute
a version ID or tag:

```bash
node ./scripts/release-version.mjs deploy \
  --manifest-file "$V2_RELEASE_MANIFEST" \
  --plan

node ./scripts/release-version.mjs deploy \
  --manifest-file "$V2_RELEASE_MANIFEST"
```

The deploy wrapper recognizes and verifies exactly three resumable states:
pre-deploy, selected version at 100% traffic with no cron, and final selected
traffic with exactly one `17 4 * * *` cron. It performs an immediate read-only
check before each mutation and a post-command reconciliation afterward.
`versions upload` and `versions deploy` do not apply the cron trigger, so the
wrapper deploys traffic first and the cron only after the intermediate state is
proven. A mismatch is `PARTIAL`: it stops without automatic rollback or retry.
Each Wrangler command has a 120-second timeout. Every Cloudflare API GET,
including response-body parsing, has a separate 30-second timeout and returns
only a sanitized error on expiry.

Cloudflare's deployment API does not provide a compare-and-swap precondition.
The private runner therefore also needs an external concurrency lock, a
dedicated credential, and a change-freeze window for dashboard/API operations.
The remote verifier checks that preview URLs remain disabled, uses exact active
deployment version ETags rather than the scripts-list ETag as traffic evidence,
and rechecks the legacy Worker and KV inventory at every stage.

Every mutating command names `mycontext-mcp-v2` and its config explicitly.
Never run these commands from `mycontext-mcp-worker`, target
`mycontext-mcp`, bypass the wrapper with `wrangler secret put`, or use the
existing Worker's KV or OAuth App. No custom
domain, route, redirect, or DNS cutover is part of this deployment.

## Local Dev

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm run dev
```

Verify:

```bash
curl -i http://localhost:8787/healthz
curl -i http://localhost:8787/mcp
```

The first command should return `200 ok`; the second should return `401` with a
`WWW-Authenticate` header pointing to protected-resource metadata.

Register the same standard endpoint in ChatGPT Web, Codex, and Claude Code:

```text
https://mycontext-mcp-v2.servicedake.workers.dev/mcp
```

The client discovers OAuth automatically. The GitHub OAuth App callback URL is:

```text
https://mycontext-mcp-v2.servicedake.workers.dev/oauth/github/callback
```

## Development Checks

```bash
./../scripts/check-public-safety.sh
pnpm run typecheck
pnpm test
pnpm run verify:isolation
pnpm run verify:data-plane
pnpm run verify:oauth-policy
pnpm run verify:dependencies
pnpm run verify:release-plan
pnpm run deploy:dry-run
```

Optional read-only live data checks are separate:

```bash
pnpm run test:live-author-style
pnpm run test:live-metaskill
```

The live author-style smoke test requires an operator-injected, read-only
`TIDB_DATABASE_URL`, lists both MCP tools through an in-memory MCP transport,
and calls title context, body context, and evidence search against current
TiDB data. The live Metaskill test similarly lists both dedicated tools, calls
context and evidence retrieval, and reads document/section resources against
current TiDB data. These live checks are not part of the public CI job and must
not print the injected value.
