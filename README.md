# mycontext-mcp

`mycontext-mcp` は、Notion に置いている個人コンテキストを AI クライアントから読めるようにするための小さな同期基盤です。

Notion の対象ページを Markdown として TiDB に保存し、Cloudflare Workers 上の Remote MCP server から読み取り専用で公開します。Obsidian へは必要に応じてローカルで Markdown export します。

## 全体像

```text
Notion pages
  -> notion-context-sync
  -> TiDB notion_pages
  -> notion-context-mcp-worker
  -> MCP clients

TiDB notion_pages
  -> notion-context-sync export-obsidian
  -> Obsidian _notion_pages/
```

このプロジェクトは「Notion 全体を検索できる巨大な RAG」ではなく、必要なページだけをテキストとして同期する設計です。ページは 1 ページ 1 行で `notion_pages` に保存します。チャンク分割、embedding、ローカル MCP server、Worker 側の Notion API 呼び出しは持ちません。

## コンポーネント

| Path | 役割 |
| --- | --- |
| `notion-context-sync/` | Notion の対象ページを取得し、TiDB の `notion_pages` に保存する TypeScript CLI。TiDB から Obsidian へ Markdown export するコマンドも持つ。 |
| `notion-context-mcp-worker/` | TiDB の `notion_pages` を読む Cloudflare Workers Remote MCP server。`/mcp` は bearer token 必須、`/healthz` は公開 liveness endpoint。 |
| `docs/` | 記事企画や運用メモなど、プロジェクト横断の資料。 |

## 個人利用と公開repoの分離

個人の Notion pageId/title、Notion API key、TiDB credentials、MCP bearer token は公開repoに入れません。ローカルでは `notion-context-sync/.env` の `MIRROR_CONFIG_JSON` と、Worker用の `.dev.vars` / Wrangler secrets で管理します。

詳細は [docs/personal-use.md](docs/personal-use.md) を参照してください。push前には次を実行できます。

```bash
./scripts/check-public-safety.sh
```

## データモデル

保存先は `notion_pages` のみです。

```sql
notion_pages(
  page_id,
  title,
  markdown,
  markdown_sha256,
  truncated,
  unknown_block_ids,
  last_synced_at,
  created_at,
  updated_at
)
```

`markdown_sha256` で内容差分を判定し、変更がないページは `pull` 時に skip できます。`unknown_block_ids` と `truncated` は、Notion ブロック変換時の警告や制限を後から追えるように残します。

## 同期の流れ

1. `notion-context-sync/.env` の `MIRROR_CONFIG_JSON`、または gitignored な `mirror.config.json` に seed page を設定する。
2. `pnpm migrate` で `notion_pages` を作る。
3. `pnpm pull` で Notion から Markdown を取得し、TiDB に upsert する。
4. `pull` は seed page 配下の `child_page` と `link_to_page` を最大 200 ページまで探索する。
5. `pnpm run search` で TiDB 上の Markdown を `LIKE` 検索できる。
6. 必要に応じて `pnpm export-obsidian` で Obsidian vault の `_notion_pages/` に Markdown を書き出す。

Obsidian export は Notion API を呼びません。TiDB に保存済みの内容をローカルファイルへ反映するだけです。

## Remote MCP

`notion-context-mcp-worker` は Cloudflare Workers 上で動く読み取り専用 MCP server です。

公開 endpoint:

- `GET /healthz`: `ok` を返す liveness endpoint。
- `/mcp`: Streamable HTTP MCP endpoint。`Authorization: Bearer $MCP_ACCESS_TOKEN` が必要。

提供 tools:

- `list_documents`: 同期済み Notion page 一覧を返す。
- `search_context`: Markdown 全文を `LIKE` 検索し、該当箇所の excerpt を返す。
- `search_text`: `search_context` と同じ検索を明示的な text fallback として提供する。
- `get_document`: pageId 指定で Markdown 本文を返す。
- `health_check`: TiDB 接続と同期済み document 数を返す。

Worker は stateless です。Durable Objects、migrations、raw SQL tool、Notion API 呼び出しはありません。

## セットアップ

### Notion -> TiDB sync

```bash
cd notion-context-sync
pnpm install
cp .env.example .env
pnpm migrate
pnpm pull
pnpm doctor
```

`.env` には Notion integration secret、TiDB 接続情報、必要なら `MIRROR_CONFIG_JSON` の Notion pageId/title を入れます。実値は commit しません。`mirror.config.json` を使う場合も gitignored なローカルファイルとして扱います。

検索:

```bash
pnpm run search -- --query "検索したい語句" --top-k 5
```

`pnpm search` は pnpm registry search なので使いません。

Obsidian export:

```bash
pnpm export-obsidian
```

既定の出力先は macOS の iCloud Obsidian vault を想定しています。

```text
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/_notion_pages
```

週次 export は launchd などから次の script を呼び出して実行できます。

```text
notion-context-sync/scripts/run-obsidian-sync.sh
```

この作業環境では月曜 04:00 ローカル時刻に実行する LaunchAgent で運用しています。公開リポジトリには個人環境の plist は含めません。

### Remote MCP Worker

```bash
cd notion-context-mcp-worker
pnpm install
wrangler secret put TIDB_DATABASE_URL
wrangler secret put MCP_ACCESS_TOKEN
pnpm run deploy
```

ローカル確認:

```bash
pnpm run dev
curl -i http://localhost:8787/healthz
curl -i http://localhost:8787/mcp
```

`/healthz` は `200 ok`、token なしの `/mcp` は `401` が期待値です。

## 開発チェック

各サブプロジェクトで実行します。

```bash
pnpm run typecheck
pnpm test
```

`notion-context-sync` では実データ確認として次も使います。

```bash
pnpm pull -- --dry-run
pnpm pull -- --reindex
pnpm doctor
```

## 設計判断

- 対象は `mirror.config.json` の seed page と、そこから辿れる child/link page に限定する。
- TiDB には全文 Markdown を保存する。検索はまず `LIKE` で足りる範囲に寄せる。
- Worker は read-only にする。書き込み、migration、Notion API 取得は CLI 側に閉じる。
- Obsidian は Worker から直接触らず、ローカル export と launchd で扱う。
- embedding や chunk table は、必要性が確認できるまで入れない。

この構成により、認証情報と書き込み権限を同期CLIに寄せ、外部公開する MCP endpoint は最小の読み取り面だけにできます。
