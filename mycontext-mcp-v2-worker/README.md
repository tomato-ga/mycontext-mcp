# mycontext-mcp-v2-worker

MCP stable `2026-07-28` and TypeScript SDK v2 implementation for the
canonical production Worker:

```text
Worker:   mycontext-mcp
Origin:   https://mycontext-mcp.servicedake.workers.dev
MCP:      https://mycontext-mcp.servicedake.workers.dev/mcp
Callback: https://mycontext-mcp.servicedake.workers.dev/oauth/github/callback
```

The public endpoint is unchanged during the migration. Existing OAuth client
registrations, access/refresh tokens, GitHub OAuth App, KV namespaces, and
secret bindings remain attached to `mycontext-mcp`. The frozen v1 code is also
deployed independently as `mycontext-mcp-v1` before this Worker is promoted.

## Runtime contract

- Streamable HTTP at `/mcp`; public liveness at `/healthz`.
- MCP application identity remains `mycontext-mcp`; version is `0.8.0`.
- Modern lane: MCP `2026-07-28` `server/discover`.
- Compatibility lane: stateless legacy `initialize`.
- Host and Origin validation runs before the OAuth challenge.
- OAuth access tokens are audience-bound to the canonical `/mcp` resource.
- Protected-resource metadata advertises only `context:read`.
- Authorization-server metadata still supports `offline_access` for clients
  that request refresh tokens.
- All tools remain read-only and use the existing TiDB reader.
- The Worker does not call Notion, modify TiDB schema/data, expose raw SQL, or
  import source from either v1 directory.

The authorization behavior follows the MCP
[2026-07-28 authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and the
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

## Local checks

Use the lockfile versions: pnpm `11.7.0` and project-local Wrangler `4.107.0`.

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
./../scripts/check-public-safety.sh
pnpm run typecheck
pnpm test
pnpm run verify:isolation
pnpm run verify:data-plane
pnpm run verify:oauth-policy
pnpm run verify:dependencies
pnpm run verify:release-command-shapes
pnpm run deploy:dry-run
```

The command-shape check never mutates Cloudflare. Live mutations are available
only through the exact pnpm `11.7.0` launcher and `release:gate`, which
revalidates the pushed Git identity and current Cloudflare state immediately
before and after each operation.

## Production topology

| Role | Worker | Runtime | OAuth/KV |
| --- | --- | --- | --- |
| canonical | `mycontext-mcp` | v2 `0.8.0` | existing production OAuth App, KV, and secrets |
| preserved fallback | `mycontext-mcp-v1` | v1 `0.7.0` | separate OAuth App and dedicated KV |
| provenance only | `mycontext-mcp-worker/` | frozen v1 source | never deployed from this directory |

The alias preserves v1 code and behavior, not the canonical Worker's old
session store. Existing registrations and tokens stay with the canonical URL
and therefore move forward with v2. Connecting to the alias requires a fresh
authorization.

## Cutover

Create a private directory outside the repository with mode `0700`. The v1
secrets JSON in that directory must be a regular, current-user-owned,
single-link mode-`0600` file containing exactly the five required string
values. Baseline, alias, and candidate manifests are written once and sealed
mode `0400`; they contain IDs and ETags, never secret values. A live operation
first reserves its output as an integrity-protected mode-`0600` pending
manifest, then atomically replaces it with the sealed result.

Before baseline capture, rename the two still-empty dedicated namespace titles
without changing their IDs:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm exec wrangler kv namespace rename \
  --namespace-id a0616be361fb4a65bd12e1fe35ec1101 \
  --new-name mycontext-mcp-v1-oauth
npm exec --yes --package=pnpm@11.7.0 -- pnpm exec wrangler kv namespace rename \
  --namespace-id 3bb6082de7ba4730b759c3e6e8322027 \
  --new-name mycontext-mcp-v1-auth
```

Capture the live baseline while the alias is still absent:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- capture \
  --manifest /absolute/private/baseline.json
```

The gate requires a clean `main`, local `HEAD == origin/main == ls-remote
origin/main`, the frozen v1 tree hash, pnpm `11.7.0`, Wrangler `4.107.0`, the
approved KV titles/IDs, and the exact canonical deployment/version ETag,
bindings, cron, observability, and workers.dev state.

Deploy the preserved alias through the same gate:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- deploy-alias \
  --baseline /absolute/private/baseline.json \
  --secrets-file /absolute/private/mycontext-mcp-v1-secrets.json \
  --manifest /absolute/private/alias.json \
  --tag mcp-v1-preserved \
  --message "Deploy preserved MCP v1 alias"
```

It verifies that the canonical Worker is unchanged, the alias has its dedicated
OAuth/KV/secret bindings and cron, and both `/healthz` and unauthenticated
`/mcp` behave as expected.

If the deploy process is interrupted after reserving `alias.json`, do not
delete the pending file or redeploy ad hoc. The recovery gate adopts an exact
ready alias, or retries only when the Worker is still absent:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- recover-alias \
  --baseline /absolute/private/baseline.json \
  --manifest /absolute/private/alias.json \
  --secrets-file /absolute/private/mycontext-mcp-v1-secrets.json
```

An existing alias with any non-conforming state fails closed for manual
investigation; the gate never overwrites it.

Upload v2 as an immutable version without changing traffic:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- upload \
  --alias-manifest /absolute/private/alias.json \
  --manifest /absolute/private/candidate.json \
  --tag mcp-v2-candidate \
  --message "Upload MCP SDK v2 candidate without traffic"
```

Do not pass a secrets file here. Wrangler inherits the five existing canonical
secret bindings, including the existing GitHub OAuth App. The new OAuth App is
for `mycontext-mcp-v1`, not for the canonical Worker. The gate requires exactly
one new version, pins its ID/ETag/tag/message/runtime/bindings, and proves that
canonical traffic stayed on the captured v1 version. Before upload it
explicitly disables canonical preview URLs so the immutable candidate has no
public preview. A matching pending candidate manifest makes an interrupted
upload resumable without creating another version.

Stage the pinned candidate at zero public traffic. The gate performs a
`--dry-run`, rechecks remote state, then performs and verifies the deployment:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- stage \
  --manifest /absolute/private/candidate.json \
  --message "Stage MCP SDK v2 at zero percent"
```

Send every smoke request with this Structured Dictionary header:

```http
Cloudflare-Workers-Version-Overrides: mycontext-mcp="<V2_VERSION_ID>"
```

Gate-enforced 0% checks:

- override `/healthz` is `200`;
- override `/mcp` with an invalid Origin is `403`, while normal v1 traffic is
  still `401`;
- the response differential is bound to the manifest-pinned candidate ID/ETag
  and current staged deployment.

Additional functional acceptance before promotion, when an existing canonical
token is available:

- authenticated override `server/discover` returns only `2026-07-28`;
- tool/resource catalogs and representative read results match the v1
  canonicalized fixtures;
- Cloudflare observability reports the candidate ScriptVersion.

The GitHub callback cannot retain the override header. If no existing token is
available for those authenticated 0% checks, complete them immediately after
promotion while the captured rollback remains ready.

Seal the automated response-differential evidence before promotion:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- smoke \
  --manifest /absolute/private/candidate.json \
  --smoke-manifest /absolute/private/smoke.json
```

The smoke gate requires normal v1 invalid-Origin traffic to remain `401` while
the same request with the exact candidate override is `403`. This excludes
silent fallback to v1 and binds the evidence to the candidate ID/ETag and
staged deployment. Perform any additional authenticated catalog/read checks
before running promotion.

Promote only after those checks. The gate accepts only the manifest-pinned
candidate and requires the captured v1 at 100% plus the candidate at 0%
immediately before the mutation:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- promote \
  --manifest /absolute/private/candidate.json \
  --smoke-manifest /absolute/private/smoke.json \
  --message "Promote MCP SDK v2"
```

Immediately verify canonical health, discovery, a fresh OAuth login, refresh,
modern and legacy clients, representative tools/resources, and continued
health of `mycontext-mcp-v1`.

## Rollback

The primary rollback restores the manifest-pinned v1 version to 100%:

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm run release:gate -- rollback \
  --manifest /absolute/private/candidate.json \
  --message "Rollback MCP SDK v2 cutover"
```

Do not delete or repoint the canonical KV namespaces, rotate the canonical
GitHub OAuth App, or replace inherited secrets during the cutover. Those
resources are required for old-token continuity and for a fast version
rollback. The rollback gate also restores the canonical preview-URL setting to
its captured v1 value. `mycontext-mcp-v1` remains live after a successful v2
migration.

Cloudflare behavior is documented in
[Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/),
[Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/),
[Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
and [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
