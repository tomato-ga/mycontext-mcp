# MCP 2026-07-28 / TypeScript SDK v2 移行設計

作成日: 2026-07-30

対象: `mycontext-mcp-worker`

対象仕様: MCP stable `2026-07-28`

対象SDK: `@modelcontextprotocol/server@2.0.0`

## 1. 結論

`mycontext-mcp-worker`は、同じ`/mcp` endpointのままMCP TypeScript SDK v2へ直接移行する。

- `@modelcontextprotocol/sdk@1.29.0`を`@modelcontextprotocol/server@2.0.0`へ置き換える。
- Cloudflare Agentsを`0.20.1`へ上げ、`agents/mcp/server`のstateless `createMcpHandler`を使う。
- `McpServer`インスタンスではなくfactoryをhandlerへ渡す。
- 2026-07-28クライアントと従来のstatelessクライアントは、Agentsの既定値
  `legacy: "stateless"`で同じrouteから提供する。
- sessionfulなv1 route、Durable Object、`McpAgent`は追加しない。
- OAuthは現在の認証・認可境界を維持しつつ、CIMDを追加してDCR依存を段階的に減らす。

添付されたPython SDK 2.0の`MCPServer`例は更新検知の根拠にはなるが、このリポジトリは
TypeScript/Cloudflare Workers実装なのでAPIを転記しない。TypeScript SDK v2とCloudflare
Agentsの公式移行経路を採用する。

## 2. 現状

| 項目 | 現在 |
| --- | --- |
| Server SDK | `@modelcontextprotocol/sdk@1.29.0` |
| Cloudflare Agents | `agents@0.17.3` |
| Server | `McpServer`、tools 10件、Resources 4系統 |
| Transport | `agents/mcp`の`createMcpHandler` |
| 状態 | requestごとにserverを作るstateless構成 |
| HTTP | Streamable HTTP `/mcp`、JSON response |
| 認証 | `@cloudflare/workers-oauth-provider@0.8.1`、GitHub本人確認、DCR、S256 PKCE |
| データ | TiDB read-only |
| 非依存 | MCP session、GET stream、replay、Roots、Sampling、MCP Logging、Tasks |

現在のserverはsessionful機能に依存していない。Cloudflareのv2移行ガイドが一時的な
legacy laneを必要とする条件に該当しないため、v1/v2の二重実装は不要である。

## 3. 仕様差分と影響

### 3.1 Stateless protocol

MCP `2026-07-28`ではprotocol sessionと`Mcp-Session-Id`がなくなり、`initialize` handshakeも
なくなる。protocol version、client capability、client identityはrequestごとの`_meta`へ移る。
serverは`server/discover`を提供する。

影響:

- 現在のrequest-scoped server構成と一致する。
- business stateをMCP sessionへ保存していないため、データモデル変更はない。
- Agents v2 handlerへfactoryを渡せば`server/discover`とera negotiationはSDK側で処理される。

### 3.2 Streamable HTTP

2026-07-28 requestは`MCP-Protocol-Version`、`Mcp-Method`、対象操作では`Mcp-Name`を要求する。
HTTP GET streamは`subscriptions/listen` POSTへ置き換わる。

影響:

- header生成・検証はSDK/Agentsへ任せ、application codeで再実装しない。
- OAuth Providerを通過しても3種類のheaderが保持されることをintegration testで確認する。
- 現serverはGET streamやlist-change通知を使わないため、subscription実装は追加しない。

### 3.3 Resultとcache

modern responseは`resultType`が必須で、list/read responseには`ttlMs`と`cacheScope`が必須になる。
SDKはwire fieldと既定値を補うため、handlerがraw wire objectを組み立ててはならない。

初期値はSDK既定の`ttlMs: 0`、`cacheScope: "private"`を受け入れる。安定稼働後、固定された
tool surfaceだけTTL延長を別変更として検討する。TiDB内容は同期Workerが外部更新するため、
Resourcesへ長いTTLを設定しない。

### 3.4 Deprecated features

Roots、Sampling、MCP Logging、HTTP+SSE、Dynamic Client RegistrationはDeprecatedである。

- Roots / Sampling: 現在未使用。新規採用しない。
- MCP Logging: 現在の`console.*`とCloudflare Observabilityを継続する。
- HTTP+SSE: 現在未使用。Streamable HTTPだけを提供する。
- DCR: 既存クライアントのため当面維持し、CIMDを同時提供する。

## 4. 実装設計

### 4.1 依存関係

`mycontext-mcp-worker/package.json`を次へ変更し、MCP packageはexact versionで固定する。

```json
{
  "dependencies": {
    "@cloudflare/workers-oauth-provider": "0.8.3",
    "@modelcontextprotocol/server": "2.0.0",
    "agents": "0.20.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@modelcontextprotocol/client": "2.0.0"
  }
}
```

`@modelcontextprotocol/client`はunit/integration testのためだけに使う。v2化したsourceとtestから
v1 importがなくなった時点で`@modelcontextprotocol/sdk`を削除し、lockfileを再生成する。

### 4.2 Server factory

`src/index.ts`はWorker object exportとOAuth Providerを維持する。変更点は以下に限定する。

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

function createServer(config: AppConfig): McpServer {
  // 現在と同じtool/resource登録
}

const response = await createMcpHandler(
  () => createServer(config),
  {
    route: MCP_ROUTE,
    responseMode: "json",
    legacy: "stateless"
  }
)(request, env, ctx);
```

- `createServer(config)`の戻り値を先に渡さず、factoryを渡す。
- `enableJsonResponse: true`は`responseMode: "json"`へ置き換える。
- Wranglerがfunction default exportを`WorkerEntrypoint`と解釈するため、現在のobject default
  exportを維持する。
- modern/legacyともPOSTごとに独立したserverとなり、GET/DELETE `/mcp`は`405`とする。

### 4.3 Tool schema

全toolのraw shapeをStandard Schema objectへ変更する。

```ts
// before
inputSchema: { query: z.string() }

// after
inputSchema: z.object({ query: z.string() })
```

引数なしtoolも`z.object({})`を使う。SDK v2にはraw shape互換overloadが残るがdeprecatedなので
移行時に残さない。`zod@4.4.3`はSDK v2が必要とする`~standard.jsonSchema`を満たす。

tool名、description、annotations、`_meta.securitySchemes`、structured content、エラー契約は
変更しない。

### 4.4 Resourcesとerror

server関連importを`@modelcontextprotocol/server`へ集約する。

- `McpServer`と`ResourceTemplate`は新package rootからimportする。
- `ErrorCode`は`ProtocolErrorCode`へ移行する。
- `McpError`は`ProtocolError`、`InvalidParamsError`、`ResourceNotFoundError`のうち意味が一致する
  classへ置き換える。
- URI、resource名、mime type、metadata、本文は変更しない。

resource not foundは2026-07-28の規定どおりInvalid Params系のerrorになることをtestで固定する。

### 4.5 Test client

v2 serverの単体試験は`@modelcontextprotocol/client@2.0.0`の`Client`と`InMemoryTransport`へ移す。
同じtool/resource contractを検証し、wire-era固有のfieldをapplication-level fixtureへ混ぜない。

別途、SDK v1.30 clientを一時的なcompatibility smoke環境で使用する。これは本番dependencyへ
残さない。

### 4.6 OpenAI tool descriptor互換

`withOpenAiToolDescriptors()`はMCP coreではなくOpenAI Apps向けの`securitySchemes`互換処理で
ある。v2化だけを理由に削除しない。

modernとlegacyの`tools/list`双方で次を確認する。

- `_meta.securitySchemes`が維持される。
- top-level `securitySchemes`が存在する。
- `resultType`、`ttlMs`、`cacheScope`、result `_meta`をresponse rewriteが失わない。

SDK/hostがtop-level fieldをnative出力することを実測できた場合だけ、別commitでrewriteを削除する。
コメント中の`MCP SDK 1.29`固定表現は実装時に更新する。

## 5. OAuth移行

### 5.1 認証境界

GitHubは本人確認にだけ使い、MCP access tokenの発行・検証は引き続き
`@cloudflare/workers-oauth-provider`に閉じる。toolからGitHub tokenへアクセスさせない。

### 5.2 CIMD

DCRは2026-07-28でDeprecatedになったため、次を同時に有効化する。

```ts
clientIdMetadataDocumentEnabled: true
```

```jsonc
"compatibility_flags": [
  "nodejs_compat",
  "global_fetch_strictly_public"
]
```

`global_fetch_strictly_public`はCIMD取得時のSSRF防止に必要である。

既存の`clientRegistrationEndpoint`は移行期間中残す。OAuth metadataで
`client_id_metadata_document_supported: true`を確認し、CIMD対応clientはCIMD、非対応clientは
DCRを使える状態にする。既存登録clientとrefresh tokenを破棄しない。

### 5.3 OAuth受け入れ試験

- metadata discoveryにresource、issuer、CIMD対応が出る。
- 新規CIMD clientでauthorization code + S256 PKCEが成功する。
- 既存DCR clientで再認可とrefreshが成功する。
- `iss`があるauthorization responseをclientが検証できる。
- 未認証`/mcp`は`401`と正しい`WWW-Authenticate`を返す。
- GitHub許可対象外ユーザーは引き続き`403`となる。

## 6. Rollout

### Phase 0: baseline

1. 現在のproduction version ID、`/healthz`、tool/resource一覧を保存する。
2. ChatGPT Web、Codex、Claude Codeの接続方式とprotocol eraを記録する。
3. 現在のtypecheck、unit test、dry-run bundle、公開smokeを成功させる。

### Phase 1: SDK v2

1. dependenciesとimportsを更新する。
2. tool schemaとresource errorを移行する。
3. v2 factory + `agents/mcp/server`へ切り替える。
4. compatibility rewriteを保持したままtestを通す。
5. staging URLでmodern/legacy双方を試験する。

### Phase 2: OAuth CIMD

1. OAuth Providerを更新する。
2. CIMD optionとcompatibility flagを追加する。
3. CIMDとDCRを併存させ、3クライアントを再接続する。
4. 既存refresh tokenが継続利用できることを確認する。

### Phase 3: production

1. Workerをdeployする。
2. health、OAuth、`server/discover`、`tools/list`、代表tool call、resource readを確認する。
3. 24時間、`4xx/5xx`、OAuth error、protocol error、tool latencyを監視する。
4. 問題がなければbaseline artifactとmigration結果を文書化する。

## 7. Verification matrix

| 対象 | 必須確認 |
| --- | --- |
| Build | `pnpm install --frozen-lockfile`、typecheck、test、Wrangler dry-run |
| Modern protocol | `server/discover`、2026-07-28 `_meta`、必須HTTP header、`resultType` |
| Legacy compatibility | v1.30 clientのinitialize、tools/list、代表tool call |
| Tools | 全10件の名前・schema・annotations・security schemes・戻り値 |
| Resources | list/read、URI template、not found error |
| Cache | `ttlMs`、`cacheScope`がmodern list/read resultに存在 |
| OAuth | clean login、refresh、既存DCR、CIMD、未認証401、拒否403 |
| HTTP security | 正常Origin、無効Origin 403、Host検証、protocol header mismatch 400 |
| Data safety | TiDBはread-only、書き込みSQLなし、秘密値のlog/commitなし |
| Clients | ChatGPT Web、Codex、Claude Codeから実データ取得 |

公開smokeでは最低でも`get_author_style_context`、`search_personal_context`、
`get_metaskill_context`、固定Resource 1件を実TiDBに対して実行する。

## 8. Go / No-Go

次をすべて満たすまでproductionへ切り替えない。

- modernとlegacyの両smokeが成功する。
- 既存のtool/resource contract差分がゼロである。
- OAuthのclean login、refresh、既存DCR、CIMDが成功する。
- OpenAI tool descriptorが失われない。
- invalid Origin、未認証、許可対象外ユーザーが拒否される。
- Worker bundle、error rate、latencyに許容外の悪化がない。

No-Go時は直前のCloudflare Worker versionへrollbackする。OAuth KVとAUTH KVは削除・再作成せず、
既存tokenとclient registrationを保持する。schemaやTiDB変更を含まないため、rollbackはWorker
versionの切り戻しだけで完結する。

## 9. 実装完了条件

- source/test/package/lockfileに`@modelcontextprotocol/sdk` importが残っていない。
- `agents/mcp/server`へfactoryを渡している。
- MCP stable `2026-07-28`と従来stateless clientを同じ`/mcp`で提供できる。
- tool 10件と全Resourceのcontractが維持される。
- CIMDをadvertiseし、DCR fallbackも動作する。
- Verification matrixの全項目に実測証跡がある。

## 10. 参照

- [MCP 2026-07-28 Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP 2026-07-28 Deprecated Features](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)
- [TypeScript SDK: Upgrading from v1.x to v2](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)
- [TypeScript SDK: Supporting protocol revision 2026-07-28](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md)
- [Cloudflare: Migrate to MCP SDK v2](https://developers.cloudflare.com/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/)
- [Cloudflare Agents SDK 0.20.0 MCP changelog](https://developers.cloudflare.com/changelog/post/2026-07-27-agents-sdk-v0.20.0-mcp-sdk-v2/)
- [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider)
