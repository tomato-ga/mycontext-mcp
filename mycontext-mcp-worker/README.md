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
- 正しいOriginを持つ任意のWeb MCPクライアントを許可。接続元ではなくOAuthで認可
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
pnpm run release:preflight
```

`release:preflight`はpublic-safety、型検査、全テスト、Wrangler dry-runを順に実行し、
1件でも失敗すればdeployへ進みません。テストには、旧実装と同じく外部Web Originを
403にする偽応答を与え、公開検証ハーネス自体が必ず失敗するnegative controlを含みます。

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

`pnpm run deploy`はWranglerを直接呼びません。直前のproduction versionを記録し、
preflight、deploy、公開endpointのread-backを順に実行します。read-backでは
`chatgpt.com`、`chat.openai.com`、任意の正規Web Originについてpreflight、CORS、
未認証時の401 OAuth challengeを確認し、OAuth metadataと不正Originの403も確認します。
失敗時は直前のversionへ自動rollbackし、rollback後の公開endpointも再検証します。

deployを行わず、現在公開中のWorkerだけを読み取り検証する場合は次を使います。

```bash
pnpm run verify:public-mcp
```

この自動検証はOAuth登録やTiDB queryを実行しません。`MCP_RELEASE_ACCESS_TOKEN`を
明示した場合だけ、認証済み`server/discover`も検証します。token値は出力しません。

OAuth metadata、MCP SDK／protocol、Origin／CORS、tool名またはschemaを変更したreleaseは、
ChatGPT Web側の接続を再登録し、新しいchatで実tool callが成功するまで
`CHATGPT_WEB_VERIFIED`とは扱いません。これはChatGPTのログイン済みブラウザ状態と
OAuth同意が必要なため、CLI releaseからは自動実行しません。

`wrangler.jsonc`はcanonical Worker `mycontext-mcp`だけを指します。OAuth App、KV、
secret binding、公開originを変更する世代切替処理はありません。
