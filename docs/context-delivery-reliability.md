# MCP context delivery reliability

## Failure identified

The planning, editing and media playbook calls were reproduced through the connected MCP adapter. Each returned a successful-looking object with `context_chars` and `truncated: false`, but no Markdown. This was not an empty server response: the adapter surfaced `structuredContent`, while the tools deliberately put the body only in `content`.

The same omission existed in all six context-pack tools, both evidence-search tools, every successful `read_context` branch, and the exact/full-document fallback of `search_personal_context`. Ordinary search snippets are intentionally compact, not complete documents.

The editing playbook's Notion Active Revision matched the revision returned by MCP. That narrows the observed failure to delivery; it is not an independent proof that every synced document is fresh or byte-identical to Notion.

## Changes

- `buildTextToolResult` retains the body in both the existing text content and `structuredContent.markdown`, with `returned_chars`. Existing IDs, revisions and truncation flags remain available. Empty bodies and inconsistent returned character counts produce errors, not complete-context claims.
- All ten public tool families use this delivery path. Evidence/search results include the complete rendered text once per channel rather than copying the body into every metadata object.
- `read_context` routes the three canonical playbooks directly to their validated full readers. The old default 6,000 / maximum 12,000 character slicing cannot fulfill the whole-playbook promise. Ordinary documents and sections still honor `maxChars`; analysis skills retain their existing full-context behavior.
- A request-local 8,000 ms wall-clock database budget is shared by all SQL calls. A timeout or request cancellation stops waiting and prevents subsequent SQL. This is an application budget, not a claim that Workers HTTP requests have an 8-second platform limit.

No extra Notion requests, resynchronization, schema changes, new dependencies, secrets or OAuth/security changes are introduced. Dual-channel compatibility increases response bytes; it does not double database reads.

## Limits and deployment verification

The existing TiDB adapter does not expose an abort signal. The deadline bounds the caller's wait and consumes a late outcome, but does not physically cancel an in-flight database operation. Normal client/network limits can still apply. Runtime verification must measure real end-to-end latency.

Regression tests use synthetic content only. They cover all ten registered tools through the MCP SDK's in-memory transport, structured-only projection, complete playbook fallbacks above 12,000 characters, intentional ordinary-document truncation, empty/missing bodies, and database timeout/cancellation behavior.

Before release, run the existing typecheck, full test suite, and deployment dry run. Release with the existing `mycontext-mcp-worker` release command; passing CI or creating this change does not mean the Worker has been deployed.

After deployment, refresh tool descriptors as needed and call planning/editing/media through the real adapter. Verify `structuredContent.markdown` is non-empty, its length equals the declared returned count, the last section is present, and full-context flags/revisions are correct. Compare the full body/revision to the authorized source, not just HTTP 200 or metadata. Exercise analysis skills, author style, metaskill, both evidence searches, exact search and `read_context` too. Verify timeout failures in a controlled test environment rather than intentionally stalling production.

References: Cloudflare Workers limits (`https://developers.cloudflare.com/workers/platform/limits/`) and MCP Tools content/structuredContent specification (`https://modelcontextprotocol.io/specification/latest/server/tools`).
