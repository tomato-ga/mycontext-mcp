# mycontext-mcp-worker

`mycontext-mcp` の唯一の実装です。Cloudflare Workers 上で MCP stable
`2026-07-28` と stateless legacy `initialize` の互換レーンを提供し、TiDBに
同期済みの個人コンテキストを読み取り専用で返します。

```text
Worker:   mycontext-mcp
Origin:   https://mycontext-mcp.servicedake.workers.dev
MCP:      https://mycontext-mcp.servicedake.workers.dev/mcp
Callback: https://mycontext-mcp.servicedake.workers.dev/oauth/github/callback
```

## 実行時の契約

- `/mcp`: OAuth 2.1で保護されたStreamable HTTP endpoint
- `/healthz`: 公開liveness endpoint
- MCP application identity: `mycontext-mcp` `0.8.0`
- MCP stable `2026-07-28` の`server/discover`
- MCP SDK 1.30クライアント向けstateless `initialize`互換
- OAuth scope: `context:read`
- GitHubの数値user IDによる本人限定認可
- TiDBは読み取り専用。Notion APIとTiDBのwrite queryは呼ばない
- Durable Objects、raw SQL tool、schema migrationは持たない

Author Styleの公開入力には既存クライアント互換のため`profile`を残します。
`ore-title-style`ではprofile routingを利用し、`ore-body-style`ではprofile値を
検証・echoするだけでroutingには使いません。bodyからprofile sectionや
`media-specific`のコンテキストは返しません。

Business Knowledge resources:

- `mycontext://business-knowledge/startup-science`
- `mycontext://business-knowledge/marketing-wisdom`
- `mycontext://business-knowledge/small-company-selling-system`

## ローカル確認

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
../scripts/check-public-safety.sh
pnpm run typecheck
pnpm test
pnpm run deploy:dry-run
```

TiDBを読み取ってAuthor Styleの全呼び出し契約を確認するテストは、ローカルの
`.dev.vars`を使って明示的に実行します。

```bash
pnpm run test:live-author-style-contract
```

## ローカル起動とdeploy

必要なsecretはgitignoredの`.dev.vars`またはCloudflare Worker secretsで管理します。

```bash
pnpm dev
pnpm run deploy
pnpm run tail
```

`wrangler.jsonc`はcanonical Worker `mycontext-mcp`だけを指します。OAuth App、KV、
secret binding、公開originを変更する世代切替処理はありません。
