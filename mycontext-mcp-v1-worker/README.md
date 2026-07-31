# mycontext-mcp-v1-worker

Read-only Remote MCP server for synced Notion, editor knowledge, sectioned
business knowledge, routed author-style context, and the Metaskill
transcription stored in TiDB Cloud.

This Worker exposes Streamable HTTP at `/mcp` and a public non-secret liveness
endpoint at `/healthz`.

## Design

- Runtime: Cloudflare Workers with `nodejs_compat` for the `agents/mcp` bundle.
- MCP transport: stateless `createMcpHandler()` from `agents/mcp`.
- OAuth state: Cloudflare Workers KV. No Durable Objects, no `McpAgent`, no migrations.
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

Local development uses `.dev.vars` and production should use Wrangler secrets.
Do not commit real values.

```bash
TIDB_DATABASE_URL=mysql://<user>:<password>@<host>/<database>
GITHUB_CLIENT_ID=<github-oauth-app-client-id>
GITHUB_CLIENT_SECRET=<github-oauth-app-client-secret>
GITHUB_ALLOWED_USER_ID=<numeric-github-user-id>
```

If real credentials were ever shared in prompts, attachments, logs, or committed
files, rotate the TiDB password and OAuth app secret before using this endpoint
in production.

`PERSONAL_SYNONYMS` is an optional secret that personalizes `search_personal_context`'s
term-alias and synonym-fallback expansion (see `src/searchQuery.ts`). It is a JSON string
shaped like `{"termAliases":{"<nickname>":{"aliases":["<full name>"],"suppressOriginalTerm":true}},"synonymGroups":[["<term>","<synonym>",...]]}`
— `suppressOriginalTerm: true` drops the matched term itself and keeps only its aliases (useful
for a short nickname that should always resolve to a fuller, unambiguous form); omit it to keep
both. Because this value routinely encodes names and other personal facts, it must never be
committed to `wrangler.jsonc`'s `vars` (which is tracked by git) or to `.dev.vars.example` —
only to a local, gitignored `.dev.vars` and to the deployed Worker's secrets, as shown below. If
it is unset, missing, or fails to parse, `search_personal_context` still works correctly and
simply performs no synonym expansion; a parse failure is logged as a warning, never a crash.

## Deploy

This tree is a deployable alias of the frozen production v1. It must differ
from `mycontext-mcp-worker` only in deployment identity and public origin.

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm run verify:clone
pnpm run typecheck
pnpm test
pnpm run deploy:dry-run
```

The first production deploy requires one repository-external mode-`0600` JSON
file containing `TIDB_DATABASE_URL`, `GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWED_USER_ID`, and
`PERSONAL_SYNONYMS`. Do not print or commit the file. Capture the canonical
baseline before this Worker exists, then run the reviewed gate from the
repository root:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm \
  --dir mycontext-mcp-v2-worker run release:gate -- deploy-alias \
  --baseline /absolute/private/baseline.json \
  --secrets-file /absolute/private/mycontext-mcp-v1-secrets.json \
  --manifest /absolute/private/alias.json \
  --tag mcp-v1-preserved \
  --message "Deploy preserved MCP v1 alias"
```

The alias uses its own GitHub OAuth App and dedicated OAuth/auth KV
namespaces. The gate validates the secrets file, immutable baseline, exact Git
and toolchain identity, and both Workers before and after the mutation. Never
use `wrangler secret put`; it creates and immediately deploys a new version
outside the reviewed release.

## Local Dev

```bash
pnpm install
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
https://mycontext-mcp-v1.servicedake.workers.dev/mcp
```

The client discovers OAuth automatically. The GitHub OAuth App callback URL is:

```text
https://mycontext-mcp-v1.servicedake.workers.dev/oauth/github/callback
```

## Development Checks

```bash
pnpm run typecheck
pnpm test
pnpm run test:live-author-style
pnpm run test:live-metaskill
```

The live author-style smoke test uses the read-only `TIDB_DATABASE_URL` from
`.dev.vars`, lists both MCP tools through an in-memory MCP transport, and calls
title context, body context, and evidence search against current TiDB data.
The live Metaskill test similarly lists both dedicated tools, calls context and
evidence retrieval, and reads document/section resources against current TiDB
data.
