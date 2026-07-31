# MCP 2026-07-28 移行設計

更新日: 2026-07-31

## 結論

canonical endpoint は変えず、`mycontext-mcp` を v1 から v2 へ
Cloudflare Worker version 単位で切り替える。v1 は別 Worker
`mycontext-mcp-v1` として先に複製・検証し、v2 移行後も削除しない。

```text
https://mycontext-mcp.servicedake.workers.dev/mcp
  -> MCP stable 2026-07-28 / SDK v2 / server 0.8.0

https://mycontext-mcp-v1.servicedake.workers.dev/mcp
  -> frozen MCP v1 / SDK v1 / server 0.7.0
```

この配置は、既存クライアントが使う canonical URL、DCR 登録、OAuth
access/refresh token を v2 側に残しつつ、v1 のコードと機能を別 endpoint
で常時維持する。alias 側は別 issuer/resource/KV なので fresh authorization
が必要であり、旧 token を alias へ移す設計ではない。

## 参照仕様と実装

設計対象は stable MCP specification `2026-07-28`。draft や release
candidate は対象に含めない。

- MCP authorization: OAuth 2.1、RFC 9728 protected resource metadata、
  RFC 8707 resource indicator、token audience validation
- MCP Streamable HTTP: Host/Origin 検証、認証、modern discovery
- `@modelcontextprotocol/server` `2.0.0`
- `@modelcontextprotocol/client` `2.0.0`
- legacy compatibility client `@modelcontextprotocol/sdk` `1.30.0`
- Cloudflare `agents` `0.20.1`
- Wrangler `4.107.0`
- pnpm `11.7.0`

SDK v2 の modern API と既存 Cloudflare OAuth Provider の境界は同じ
Worker 内で接続する。Cloudflare OAuth Provider `0.8.1`、GitHub identity
policy、TiDB reader、tool/resource 実装は v1 から凍結し、MCP transport
adapter と protocol surface だけを v2 化する。

## 配置

| Role | Directory | Worker | Version | OAuth/KV |
| --- | --- | --- | --- | --- |
| provenance | `mycontext-mcp-worker/` | deploy しない | v1 `0.7.0` | frozen source only |
| preserved v1 | `mycontext-mcp-v1-worker/` | `mycontext-mcp-v1` | v1 `0.7.0` | 新 GitHub App、専用 KV |
| canonical | `mycontext-mcp-v2-worker/` | `mycontext-mcp` | v2 `0.8.0` | 現行 GitHub App、現行 KV/secret |

凍結 v1 tree:

```text
33ba9ceecf6dfe15025ef8e8d3662f87bfdbccd9
```

KV bindings:

| Worker | Binding | Namespace ID | Release policy |
| --- | --- | --- | --- |
| `mycontext-mcp` | `OAUTH_KV` | `88cc0f72224947fc818c0520207164de` | 既存 ID を変更しない |
| `mycontext-mcp` | `AUTH_KV` | `3c6429869d7e41b19f3423670f2c1c90` | 既存 ID を変更しない |
| `mycontext-mcp-v1` | `OAUTH_KV` | `a0616be361fb4a65bd12e1fe35ec1101` | alias 専用 |
| `mycontext-mcp-v1` | `AUTH_KV` | `3bb6082de7ba4730b759c3e6e8322027` | alias 専用 |

両 Worker は同じ read-only TiDB datasource を参照する。schema、grant、
table、row、同期 CLI/Worker には変更を加えない。

## v1 維持契約

`mycontext-mcp-v1-worker/` は Git の frozen
`mycontext-mcp-worker/` から作る物理 clone である。symlink、workspace
dependency、相対 cross-import は使わない。

runtime の許容差分は `PUBLIC_ORIGIN` だけ:

```text
https://mycontext-mcp.servicedake.workers.dev
  ->
https://mycontext-mcp-v1.servicedake.workers.dev
```

次は v1 と byte-identical に保つ。

- `McpServer` name `mycontext-mcp`
- server version `0.7.0`
- protected resource `resource_name`
- GitHub OAuth policy、user-agent、consent text
- tool/resource/data-plane implementation
- dependency versionsとpnpm lock

Worker 名、KV ID、明示的な dev/tail/dry-run command、README/test の endpoint
期待値だけを deployment metadata として変更する。

`verify-v1-clone.mjs` は frozen tree、全 inherited file、origin-only runtime
drift、secret file 不在、symlink 不在、専用 Worker/KV を fail-closed で検査する。

## OAuth 設計

### Canonical v2

`mycontext-mcp` は既存の以下を version 間で継承する。

- GitHub OAuth App
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ALLOWED_USER_ID`
- `TIDB_DATABASE_URL`
- `PERSONAL_SYNONYMS`
- OAuth/client/token KV
- authorization session KV

v2 upload では secrets file を渡さない。Wrangler の
`secrets.required` で5 bindingの存在を検査し、既存値を latest production
version から継承する。新しい `mycontext-mcp-v1` 用 GitHub App の値を
canonical に入れてはいけない。

token は resource audience
`https://mycontext-mcp.servicedake.workers.dev/mcp` に結び付く。v2 でも
同じ resource と KV を使うことで、既存 token の continuity を保つ。
別 audience の token は `401` にする。

MCP `2026-07-28` の scope guidance に合わせ、protected-resource metadata
は `context:read` だけを広告する。refresh token を希望する client のため、
authorization-server metadata と authorization policy は
`offline_access` を引き続き許可する。

### Preserved v1

`mycontext-mcp-v1` は新規登録した production GitHub OAuth App を使う。

```text
Homepage:
https://mycontext-mcp-v1.servicedake.workers.dev

Callback:
https://mycontext-mcp-v1.servicedake.workers.dev/oauth/github/callback
```

GitHub App secret は macOS Keychain などの信頼済み private store から
release 時だけ読む。alias の初回 deploy には、repository 外 mode `0600`
JSON で5 secretを一括投入する。`wrangler secret put` は即時 version/deploy
を起こすため使わない。

alias KV は空から開始する。したがって alias 接続には DCR と OAuth の
fresh flow が必要で、canonical の token は受け付けない。

## v2 runtime 差分

v2 が意図的に変えるのは次だけ。

- MCP server package v2
- Cloudflare Agents MCP adapter
- modern `server/discover` for `2026-07-28`
- modern request headers / `_meta` validation
- Host/Origin validation
- MCP v1.30 stateless compatibility lane
- server version `0.8.0`
- protected-resource metadata から `offline_access` を除外
- canonical preview URLをcandidate upload前に無効化

次は変更しない。

- public canonical URL
- MCP application name
- GitHub owner allowlist policy
- OAuth Provider version、TTL、PKCE、implicit/token-exchange policy
- TiDB query/data-plane
- tools/resources と read-only annotations
- cron `17 4 * * *`
- observability settings

preview URLはversioned settingではないため、gateがactive v1
deployment/version/ETagを固定したまま明示的に`true -> false`へreconcileする。
rollback時はcaptured v1値の`true`へ戻す。workers.dev本体は常に有効のまま。

## Release state machine

```text
PREPARED
  -> V1_ALIAS_LIVE
  -> V2_UPLOADED_NO_TRAFFIC
  -> V2_STAGED_0_PERCENT
  -> V2_PROMOTED_100_PERCENT
  -> VERIFIED

Any failed post-promotion gate
  -> ROLLBACK_TO_CAPTURED_V1_VERSION
```

### 1. PREPARED

- repo clean、commit済み、remote SHA一致
- public safety、typecheck、full test、all verifier、Wrangler dry-run 成功
- v1 source tree SHA一致
- canonical live baselineをprivate manifestへ保存
- `mycontext-mcp-v1` がまだ存在しない
- alias KV 2件が空かつ dedicated
- canonical Worker/KV/secret/cron/health が baseline と一致

baseline前に、空のdedicated KVのIDを変えずtitleだけを確定する。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker \
  exec wrangler kv namespace rename \
  --namespace-id a0616be361fb4a65bd12e1fe35ec1101 \
  --new-name mycontext-mcp-v1-oauth
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker \
  exec wrangler kv namespace rename \
  --namespace-id 3bb6082de7ba4730b759c3e6e8322027 \
  --new-name mycontext-mcp-v1-auth
```

live baselineは、repo外mode-`0700` directoryへ次のgateで保存する。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- capture \
  --manifest /absolute/private/baseline.json
```

このgateはclean `main`、local `HEAD`、`origin/main`、`ls-remote
origin/main`、frozen v1 tree、pnpm/Wrangler固定versionを照合し、Cloudflare
からactive deployment、version ETag、binding、KV title/ID、cron、
observability、subdomainを再取得する。manifestはsecret値を含まずmode
`0400`で封印し、内容hashを検証する。

live mutationは出力先を先にmode `0600`のpending manifestとして予約し、
成功後に同じprivate directory内でmode `0400` final manifestへatomic
replaceする。alias deployが中断した場合はpendingを削除せず、次でexact ready
stateをadoptするか、Workerがまだ不存在の場合だけ同一commit/secretsからretry
する。存在するnon-conforming aliasは上書きせず停止する。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker \
  run release:gate -- recover-alias \
  --baseline /absolute/private/baseline.json \
  --manifest /absolute/private/alias.json \
  --secrets-file /absolute/private/mycontext-mcp-v1-secrets.json
```

### 2. V1_ALIAS_LIVE

新規 Worker の first upload は `versions upload` では作れないため、
gate内で `wrangler deploy --secrets-file` を使う。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- deploy-alias \
  --baseline /absolute/private/baseline.json \
  --secrets-file /absolute/private/mycontext-mcp-v1-secrets.json \
  --manifest /absolute/private/alias.json \
  --tag mcp-v1-preserved \
  --message "Deploy preserved MCP v1 alias"
```

secrets JSONはrepo外absolute path、current user所有、regular file、
mode `0600`、link count 1、symlink不可、64 KiB以下とし、5 required keyだけを
重複なしのnon-empty stringで持つ。gateはmutation直前にもinode、mtime、
size、mode、SHA-256を再検査する。

確認:

- `/healthz` `200`
- unauthenticated `/mcp` `401`
- protected-resource/authorization metadata が alias origin に閉じる
- fresh DCR + OAuth + token + refresh
- legacy initialize、tool list、代表 tool/resource read
- alias のKV/secret/cron/observability
- canonical Worker が upload 前 baseline のまま

### 3. V2_UPLOADED_NO_TRAFFIC

canonical に immutable v2 version を upload する。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- upload \
  --alias-manifest /absolute/private/alias.json \
  --manifest /absolute/private/candidate.json \
  --tag mcp-v2-candidate \
  --message "Upload MCP SDK v2 candidate without traffic"
```

upload 後も active deployment は captured v1 version 100% のままでなければ
ならない。gateはupload前後のversion集合差分が1件だけであることを要求し、
candidate version の KV ID、5 secret binding名、compatibility、preview、
code annotation/ETag をcandidate manifestへ固定する。

gateはversion upload前にcanonical preview URLだけを無効化する。active
deployment/version/ETag、binding、cron、observabilityは不変でなければならない。
pending candidate manifestにはupload前のversion集合を固定し、中断後の再実行で
既存candidateをadoptして二重uploadを防ぐ。

### 4. V2_STAGED_0_PERCENT

gateが最初に `--dry-run` し、remote stateを再照合してから0% deploymentを
作る。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- stage \
  --manifest /absolute/private/candidate.json \
  --message "Stage MCP SDK v2 at zero percent"
```

override header:

```http
Cloudflare-Workers-Version-Overrides: mycontext-mcp="<V2_VERSION_ID>"
```

gate必須の0% smoke:

- override `/healthz` `200`
- invalid Origin の override `/mcp` は v2 の `403`
- normal `/mcp` は引き続き v1 の `401`
- response差分をcandidate ID/ETagとstaged deploymentへ固定

既存canonical tokenを利用できる場合の追加functional acceptance:

- authenticated `server/discover` は `supportedVersions=["2026-07-28"]`
- `resultType="complete"`、`ttlMs=0`、`cacheScope="private"`
- modern tool/resource surface と legacy compatibility surface
- representative read result parity
- Cloudflare ScriptVersion が candidate ID

無効な override は normal traffic へ silent fallback するため、HTTP差分だけで
なく ScriptVersion も確認する。GitHub callback には override header が残らない
ので、完全な browser OAuth round-trip は promotion直後のrollback gateで行う。
既存tokenがなくauthenticated override検証を実施できない場合も、promotion直後に
同じfunctional acceptanceを完了し、不成立なら即rollbackする。

最低限のresponse differentialをcandidate ID/ETagへ固定したsmoke manifestとして
封印する。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker \
  run release:gate -- smoke \
  --manifest /absolute/private/candidate.json \
  --smoke-manifest /absolute/private/smoke.json
```

### 5. V2_PROMOTED_100_PERCENT

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- promote \
  --manifest /absolute/private/candidate.json \
  --smoke-manifest /absolute/private/smoke.json \
  --message "Promote MCP SDK v2"
```

cron は upload/deployment commandで自動更新しない。既存 cron が正しいため
原則変更せず、差分がある場合だけ明示的な trigger reconciliation を行う。

### 6. VERIFIED

- canonical `/healthz` `200`
- canonical unauthenticated `/mcp` `401`
- invalid Host/Origin `403`
- protected-resource/authorization metadata 正常
- fresh OAuth login、token、refresh
- 既存 token continuity または再認証要否を実測記録
- modern `server/discover`、legacy initialize
- tool/resource catalog、representative read
- `mycontext-mcp-v1` が同時に正常
- 2 Worker の KV/OAuth App が分離
- canonical deployment candidate 100%
- frozen source tree unchanged

## Rollback

promotion後の主 rollback は、canonical を captured v1 version へ戻す。

```bash
npm exec --yes --package=pnpm@11.7.0 -- pnpm --dir mycontext-mcp-v2-worker run release:gate -- rollback \
  --manifest /absolute/private/candidate.json \
  --message "Rollback MCP SDK v2 cutover"
```

rollback成立条件:

- captured v1 version ID/ETagをprivate manifestに固定
- old versionを直近100 version内に維持
- canonical KVを削除・変更しない
- canonical GitHub OAuth Appを変更しない
- inherited secret値を変更しない
- canonical preview URLをcaptured v1値へ戻す

rollback後に deployment、health、OAuth metadata、existing token、fresh login、
legacy client、代表 tool を再検証する。`mycontext-mcp-v1` は rollback と無関係に
常時維持する。

## Concurrency と安全境界

Cloudflare deployment API には compare-and-swap がない。release中は dashboard、
CLI、API を含む変更 freeze を置き、各 mutation 直前に active version/ETag/KV/
cron を再取得する。予期しない version、deployment、secret、KV 差分があれば
retryせず停止する。

secret値、OAuth token、TiDB URL、private baseline本文をログ・Git・artifactへ
出さない。release用 directory は repository外、current user所有、mode
`0700`とする。secretsはmode `0600`、sealed manifestはmode `0400`、
hardlink/symlinkなしとし、完了後に削除する。

## Acceptance checklist

- [ ] `mycontext-mcp-v1` deployed and verified
- [ ] canonical pre-cutover baseline revalidated
- [ ] v2 immutable version uploaded with zero traffic
- [ ] version override smoke and ScriptVersion proof passed
- [ ] v2 promoted to 100%
- [ ] fresh OAuth and refresh passed
- [ ] legacy and modern MCP lanes passed
- [ ] representative tools/resources passed
- [ ] `mycontext-mcp-v1` remained healthy
- [ ] canonical KV/OAuth continuity verified
- [ ] frozen v1 source tree unchanged
- [ ] release evidence committed without secrets
- [ ] local HEAD and remote main SHA match

## 公式資料

- [MCP authorization 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [MCP authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [MCP Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [Cloudflare versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
- [Cloudflare version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
- [Cloudflare rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [GitHub OAuth App creation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
