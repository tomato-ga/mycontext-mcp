# mycontext-mcp

`mycontext-mcp` は、Notion とローカル Markdown に置いている個人コンテキストを AI クライアントから読めるようにするための小さな同期基盤です。

Notion の対象ページを Markdown として TiDB に保存し、Cloudflare Workers 上の Remote MCP server から読み取り専用で公開します。人間が継続編集する文書は、Notionの`Ready`を起点に同期専用Workerから自動反映できます。Obsidianや緊急バックアップへは必要に応じてローカルでMarkdown exportします。

## 全体像

```text
Notion pages
  -> mycontext-sync
  -> TiDB notion_pages
Notion MyContext Documents (Status = Ready)
  -> mycontext-sync-worker webhook + Queue
  -> validated TiDB current snapshots / sections
noteAI editor knowledge Markdown
  -> mycontext-sync
  -> TiDB editor_knowledge_documents
Claude skill business knowledge Markdown (fixed 3 files)
  -> mycontext-sync section-aware parser
  -> TiDB business_knowledge_documents + business_knowledge_sections
Notion author-style pages (fixed title/body pages)
  -> mycontext-sync-worker semantic parser + routing manifest
  -> TiDB author_style_documents + author_style_current_sections
Kindle Metaskill transcription (fixed 1 file)
  -> mycontext-sync semantic parser + topic routing manifest
  -> TiDB metaskill_documents + revisions + sections
TiDB context tables
  -> mycontext-mcp-worker
  -> mycontext-mcp (MCP stable 2026-07-28)
  -> existing MCP clients and OAuth/KV

TiDB notion_pages
  -> mycontext-sync export-obsidian
  -> Obsidian _notion_pages/
```

このプロジェクトは「Notion 全体を検索できる巨大な RAG」ではなく、明示的に管理対象としたページと固定ローカルMarkdownだけを同期する設計です。Notionとeditor knowledgeは1文書1行で保存し、business knowledge・author style・Metaskillは文字数ではなく原文の意味境界で保存します。embeddingとローカルMCP serverは持ちません。公開MCP WorkerはNotion APIを呼ばず、同期専用WorkerだけがNotion APIとTiDB writerを使用します。

## コンポーネント

| Path | 役割 |
| --- | --- |
| `mycontext-sync/` | Notionと固定ローカルコーパスを用途別テーブルへ保存する TypeScript CLI。TiDB から Obsidian へ Notion Markdownをexportするコマンドも持つ。 |
| `mycontext-sync-worker/` | Notionの`Ready`をWebhookとQueueで受け、検証済みrevisionだけをTiDBへ反映する非公開同期Worker。 |
| `mycontext-mcp-worker/` | canonical `mycontext-mcp` の唯一の実装。MCP stable `2026-07-28`と既存クライアント互換のstateless HTTPレーンを提供する。 |
| `docs/` | 記事企画や運用メモなど、プロジェクト横断の資料。 |

## 個人利用と公開repoの分離

個人の Notion pageId/title、ローカルMarkdown同期元の絶対パス、Notion API key、TiDB credentials、OAuth secretsは公開repoに入れません。ローカルでは `mycontext-sync/.env` の `MIRROR_CONFIG_JSON` / `EDITOR_KNOWLEDGE_SOURCE_ROOT` / `BUSINESS_KNOWLEDGE_SOURCE_ROOT` / `AUTHOR_STYLE_SOURCE_ROOT` / `METASKILL_SOURCE_ROOT` と、各Worker用の `.dev.vars` / Wrangler secrets で管理します。

詳細は [docs/personal-use.md](docs/personal-use.md) を参照してください。push前には次を実行できます。

```bash
./scripts/check-public-safety.sh
```

## データモデル

保存先は用途別の9テーブルです。

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

editor_knowledge_documents(
  document_id,
  title,
  markdown,
  markdown_sha256,
  last_synced_at,
  created_at,
  updated_at
)

business_knowledge_documents(
  document_id,
  title,
  markdown,
  markdown_sha256,
  section_revision_sha256,
  section_count,
  search_span_count,
  outline_json,
  routing_metadata_json,
  last_synced_at,
  created_at,
  updated_at
)

business_knowledge_sections(
  document_id,
  section_id,
  section_revision_sha256,
  parent_section_id,
  delivery_section_id,
  title,
  heading_path_json,
  direct_markdown,
  section_markdown,
  retrieval_text,
  source_line_start,
  source_line_end,
  is_searchable
)

author_style_documents(
  document_id,
  author_key,
  style_scope,
  context_sha256,
  source_markdown,
  routing_manifest_json,
  section_count,
  delivery_section_count,
  search_span_count,
  status
)

author_style_current_sections(
  document_id,
  section_id,
  context_key,
  delivery_section_id,
  content_layer,
  direct_markdown,
  delivery_markdown,
  retrieval_text
)

metaskill_documents(
  document_id,
  display_name,
  active_revision_sha256,
  status
)

metaskill_revisions(
  document_id,
  revision_sha256,
  source_markdown,
  routing_manifest_json,
  section_count,
  delivery_section_count,
  search_span_count
)

metaskill_sections(
  document_id,
  revision_sha256,
  section_id,
  context_key,
  delivery_section_id,
  content_layer,
  direct_markdown,
  delivery_markdown,
  retrieval_text
)
```

`markdown_sha256` で内容差分を判定し、変更がない文書は同期時にskipできます。Business sectionはsource hashとparser/sectioning versionからrevisionを作り、過去revisionを削除せずにUPSERTします。`unknown_block_ids` と `truncated` は、Notion ブロック変換時の警告や制限を後から追えるように残します。

## 同期の流れ

1. `mycontext-sync/.env` の `MIRROR_CONFIG_JSON`、または gitignored な `mirror.config.json` に seed page を設定する。
2. `pnpm migrate` で `notion_pages` と `editor_knowledge_documents` を作る。
3. `pnpm pull` で Notion から Markdown を取得し、TiDB に upsert する。
4. `pull` は seed page 配下の `child_page` と `link_to_page` を最大 200 ページまで探索する。
5. `.env` の `EDITOR_KNOWLEDGE_SOURCE_ROOT` を設定し、`pnpm pull-editor-knowledge` で固定8件を差分同期する。
6. `pnpm doctor-editor-knowledge` でローカルMarkdownとTiDBのハッシュ一致を検証する。
7. `.env` の `BUSINESS_KNOWLEDGE_SOURCE_ROOT` を設定し、`pnpm migrate-business-knowledge`で専用2テーブルだけを作成する。
8. `pnpm pull-business-knowledge`で固定3文書をsection-aware同期し、`pnpm doctor-business-knowledge`で原文・section revision・件数・hashを検証する。
9. `pnpm migrate-author-style`でAuthor Styleのcurrent-snapshot tableを準備し、固定された2つのNotionページを同期Workerで検証・同期する。ローカル`pull-author-style`の対象はtitle文書だけで、bodyの緊急復旧はTiDBからexportした同一構造のsnapshotだけを受け付ける。
10. `.env` の `METASKILL_SOURCE_ROOT` を設定し、`pnpm migrate-metaskill`、`pnpm pull-metaskill`、`pnpm doctor-metaskill`で固定1文書・意味section・全topic routingを検証する。
11. `pnpm run search` でNotion Markdownをローカル検証できる。
12. 必要に応じて `pnpm export-obsidian` で Obsidian vault の `_notion_pages/` に Markdown を書き出す。

Obsidian export は Notion API を呼びません。TiDB に保存済みの内容をローカルファイルへ反映するだけです。

Notionを人間向け正本にする自動同期は`mycontext-sync-worker/README.md`を参照してください。Statusが`Ready`になったページだけを処理し、失敗時はcurrent snapshotを維持します。

## Remote MCP

canonical endpoint `mycontext-mcp` は、Cloudflare Workers 上で動く
MCP stable `2026-07-28`の読み取り専用MCP serverです。
実装とdeploy元は`mycontext-mcp-worker/`だけです。既存origin、GitHub OAuth App、
KV、secretをそのまま利用します。

公開 endpoint:

- `GET /healthz`: `ok` を返す liveness endpoint。
- `/mcp`: OAuth 2.1 で保護された Streamable HTTP MCP endpoint。クライアント登録は DCR、認可コードは S256 PKCE を使う。
- 本人確認は GitHub OAuth で行い、`GITHUB_ALLOWED_USER_ID` に設定した不変の数値 user ID だけを許可する。

提供 tools:

- `search_personal_context`: 同期済みの個人コンテキストを統合検索し、詳細取得用の安定IDと短い候補を返す。
- `read_context`: `search_personal_context`が返した安定IDの文書または意味sectionを読む。
- `get_planning_playbook_context`: 企画案・記事構成・H2/H3見出し・本文構成の作成／レビュー／修正で最初に使い、`kikaku-composition-playbook`全文を非省略で返す。その後に必要な事例だけを検索する。
- `get_editing_playbook_context`: 上がってきた原稿の編集・赤入れ・校正校閲・公開判断・公開後リライトで最初に使い、`henshu-editing-playbook`全文を非省略で返す。企画・構成をゼロから作る場合は`get_planning_playbook_context`を使う。
- `get_media_playbook_context`: メディア戦略・ポジショニング・運営体制・KPI・流通・収益化で最初に使い、`knowhow-media-design`全文を非省略で返す。
- `get_analysis_skill_context`: 指定した分析フレームワークの`SKILL.md`と`reference.md`を完全な1文書として返す。
- `get_author_style_context`: 文書種別・操作・モード・長さ・profileに応じた意味完結sectionを、通常利用向けの1パックとして返す。
- `search_author_style_evidence`: 根拠確認時だけevidence/profile/ops層を検索し、ヒットした細粒度spanを意味完結sectionへ展開して返す。
- `get_metaskill_context`: topic・intent・depthに応じた意味完結sectionを、通常利用向けの1パックとして返す。
- `search_metaskill_evidence`: 用語・例・promptなどを細粒度spanで検索し、ヒットを意味完結sectionへ展開して返す。

編集プレイブックとメディア運営プレイブックは、`editor_knowledge_documents`の全文1行をそのまま検索・取得単位とし、章sectionは作りません。一般検索IDはそれぞれ`editor-knowledge:henshu-editing-playbook`、`editor-knowledge:knowhow-media-design`です。Business knowledge、author style、Metaskillは文書Resourceとsection Resource templateも公開します。MetaskillのURIは`mycontext://metaskill/ai-self-strategy`です。

Worker は stateless です。Durable Objects、migrations、raw SQL tool、Notion API 呼び出しはありません。

## セットアップ

### Notion -> TiDB sync

```bash
cd mycontext-sync
pnpm install
cp .env.example .env
pnpm migrate
pnpm pull
pnpm doctor
pnpm pull-editor-knowledge
pnpm doctor-editor-knowledge
pnpm migrate-business-knowledge
pnpm pull-business-knowledge
pnpm doctor-business-knowledge
pnpm migrate-author-style
pnpm pull-author-style
pnpm doctor-author-style
pnpm migrate-metaskill
pnpm pull-metaskill
pnpm doctor-metaskill
```

`.env` には Notion integration secret、TiDB接続情報、必要なら`MIRROR_CONFIG_JSON`のNotion pageId/title、各`*_SOURCE_ROOT`の絶対パスを入れます。実値はcommitしません。`mirror.config.json`を使う場合もgitignoredなローカルファイルとして扱います。

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
mycontext-sync/scripts/run-obsidian-sync.sh
```

この作業環境では月曜 04:00 ローカル時刻に実行する LaunchAgent で運用しています。公開リポジトリには個人環境の plist は含めません。

### Remote MCP Worker

`mycontext-mcp-worker/`がcanonical `mycontext-mcp`の唯一のsource treeです。
ローカル確認:

```bash
cd mycontext-mcp-worker
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm run typecheck
pnpm test
pnpm run deploy:dry-run
```

ローカル起動後のendpoint確認:

```bash
curl -i http://localhost:8787/healthz
curl -i http://localhost:8787/mcp
```

`/healthz` は `200 ok`、token なしの `/mcp` は `401` が期待値です。

### Notion Sync Worker

`mycontext-sync-worker`は公開MCP Workerと別のcredentialで動作します。Notion webhook、Cloudflare Queue、15分ごとのreconciliation、TiDB writerを持ちます。

```bash
cd mycontext-sync-worker
pnpm install
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

Notion data sourceのプロパティ、Queue作成、secret、初回Webhook検証は[専用README](mycontext-sync-worker/README.md)を参照してください。

緊急Markdownは通常同期に使わず、TiDB current snapshotのexportと明示的restoreだけに限定します。

```bash
cd mycontext-sync
pnpm export-author-style-markdown -- --document-id ore-body-style
pnpm restore-author-style-markdown -- --document-id ore-body-style \
  --input-path /private/path/snapshot.md --dry-run
```

## 開発チェック

各サブプロジェクトで実行します。

```bash
pnpm run typecheck
pnpm test
```

`mycontext-sync` では実データ確認として次も使います。

```bash
pnpm pull -- --dry-run
pnpm pull -- --reindex
pnpm doctor
pnpm pull-editor-knowledge -- --dry-run
pnpm pull-editor-knowledge -- --reindex
pnpm doctor-editor-knowledge
pnpm pull-business-knowledge -- --dry-run
pnpm pull-business-knowledge -- --reindex
pnpm doctor-business-knowledge
pnpm pull-author-style -- --dry-run
pnpm pull-author-style -- --reindex
pnpm doctor-author-style
```

## 設計判断

- 対象は `mirror.config.json` の seed page と、そこから辿れる child/link page に限定する。
- TiDBには用途別テーブルで全文Markdownを保存し、business knowledgeだけは著者定義section treeも保存する。文字数によるsection結合・分割はしない。
- Business検索は最小sectionで行い、AIへは`delivery_section_id`が示す意味完結した親sectionを返す（Small2Big）。
- Business同期は新規2テーブルと固定2文書IDだけへUPSERTし、`DELETE`/`TRUNCATE`/`DROP`を持たない。
- Author styleは2専用テーブルへ現在値だけを細粒度保存し、`context_sha256`を履歴ではなく同一性確認に使う。AIにはWorkerが選択・結合した1コンテキストパックを返し、通常経路で全文や任意文字chunkを読ませない。
- 公開MCP Workerはread-onlyにする。Notion APIとTiDB書き込みは、credentialを分離した同期CLIまたは同期専用Workerに閉じる。
- Obsidian は Worker から直接触らず、ローカル export と launchd で扱う。
- embedding や chunk table は、必要性が確認できるまで入れない。

この構成により、認証情報と書き込み権限を同期CLIに寄せ、外部公開する MCP endpoint は最小の読み取り面だけにできます。
