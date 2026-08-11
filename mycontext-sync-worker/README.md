# mycontext-sync-worker

Notionの「MyContext Documents」を人間向けの正本とし、`Ready`になったページだけをTiDBのAI向けread modelへ同期する専用Cloudflare Workerです。公開MCP Workerとはデプロイ・credential・責務を分離します。

## 実行フロー

```text
Notion Status = Ready
  -> Notion webhook
  -> POST /webhooks/notion
  -> Cloudflare Queue
  -> Notion本文と管理プロパティを2回取得して同一fingerprintを確認
  -> 文書種別ごとの検証・section化
  -> TiDB transaction
  -> Notion Status = Synced / Error / Conflict
```

各Queue deliveryは`context_sync_state_log`へ追記されます。入力本文は保存せず、run ID、入力ハッシュ、parser/sectioning/routing version、状態遷移、結果、失敗理由、次の操作を残します。設計契約は[`docs/SYNC_STATE_LOG.md`](docs/SYNC_STATE_LOG.md)を参照してください。

Webhookは`page.properties_updated`と`page.content_updated`だけをQueueへ送ります。Queue consumerはその時点のNotionページを取得し、Statusが`Ready`または再試行中の`Syncing`の場合だけ同期します。Worker自身による`Syncing`や`Synced`への更新イベントは、処理時点で対象外になるため自己ループしません。

定期ポーリングは行いません。Notionの変更時だけWorkerが動きます。通常Queueの再試行を使い切ったmessageはdead-letter Queueで受け、Notionを`Error`へ変更します。

## Notion data source

「MyContext Documents」というdata sourceを作り、プロパティ名と型を次のとおり固定します。

| Property | Type | Values / purpose |
| --- | --- | --- |
| `Name` | Title | 人間向け文書名 |
| `Document ID` | Rich text | 固定・重複禁止 |
| `Category` | Select | `Personal Context` / `AI Skill` / `Author Style` / `Business Knowledge` / `Editor Knowledge` / `Metaskill` |
| `Status` | Status | `Draft` / `Review` / `Ready` / `Syncing` / `Synced` / `Error` / `Conflict` / `Archived` |
| `Active` | Checkbox | 同期対象ならon |
| `Schema Version` | Select | `personal-context-v1` / `ai-skill-v1` / `author-style-v1` / `business-knowledge-v1` / `editor-knowledge-v1` / `metaskill-v1` |
| `Sync Source` | Select | 通常は`Notion`。TiDB管理のMetaskillスナップショットだけ`TiDB` |
| `TiDB Tables` | Multi-select | Worker管理。実際のTiDB保存先table |
| `Last Synced` | Date | Worker管理 |
| `Synced Hash` | Rich text | Worker管理 |
| `Active Revision` | Rich text | Worker管理。Author Styleでは使用せず空欄 |
| `Validation Error` | Rich text | Worker管理 |
| `Original Page ID` | Rich text | 既存`notion_pages`行またはAuthor Styleの所有元を複製ページIDへ移すときだけ使用 |

任意で`Owner`（Person）を追加できます。`Draft / Review`、`Ready`、`Synced`、`Error / Conflict`、`Archived`のStatus別viewを作ると、日常操作は「編集してReadyにする」だけになります。

人間は`Draft`、`Review`、`Ready`を操作し、Workerは`Syncing`、`Synced`、`Error`、`Conflict`を操作します。再編集するときは`Draft`へ戻して編集し、確定後に`Ready`へ変更します。

## 対応する保存先

`TiDB Tables`は人間の入力値ではなく、`Schema Version`から決まるWorker管理の派生メタデータです。同期fingerprintには含めません。Workerは`Syncing`、`Synced`、`Error`、`Conflict`へ更新するときに、次の対応表をNotionへ書き戻します。既存データで`Category`と`Schema Version`が食い違う場合も実保存モデルを正しく示せるよう、`Schema Version`を第一キーとし、未知のversionだけ`Category`をフォールバックに使います。

| Schema Version | `TiDB Tables` |
| --- | --- |
| `personal-context-v1` | `notion_pages` |
| `ai-skill-v1` | `notion_pages` |
| `author-style-v1` | `author_style_documents`, `author_style_current_sections` |
| `business-knowledge-v1` | `business_knowledge_documents`, `business_knowledge_sections` |
| `editor-knowledge-v1` | 原則: `editor_knowledge_documents`, `editor_knowledge_sections` |
| `metaskill-v1` | `metaskill_documents`, `metaskill_revisions`, `metaskill_sections` |

- `Personal Context`: 既存`notion_pages`へ全文Markdownを保存する。`Original Page ID`の行があれば主キーを新しいNotionページIDへ移すため、複製レコードは作らない。
- `AI Skill`: 再利用可能なAI実行手順を、スキルごとに既存`notion_pages`へ全文Markdownとして保存する。
- `Author Style`: 固定された2つのNotionページだけを既存のsection/routing parserで検証し、現在スナップショットを2つのauthor-style tableへ保存する。`ore-title-style`は`3a5625fe-b1a2-818a-96fe-fe6241c33f14`、`ore-body-style`は`1b2625fe-b1a2-82d0-9a16-011305919485`以外から同期できない。
- `Business Knowledge`: 書籍・マーケティング知識の原文を文書行へ保存し、目次アンカーで意味単位のsectionへ分割する。現在Notion同期を許可するDocument IDは`small-company-selling-system`だけ。
- `Editor Knowledge`: 企画・編集ノウハウを検証して保存する。`henshu-editing-playbook`と`knowhow-media-design`は全文1レコード方式のため`editor_knowledge_documents`だけを使い、旧section行も同期時に削除する。それ以外は2つのeditor-knowledge tableへsection化して保存する。
- `Metaskill`: 専用`metaskill_*` tableのactive revisionを示す管理用スナップショット。TiDBを正本とし、Notionから`Ready`にして再同期することはできない。

MyContext Documentsへ登録したNotion管理文書は、すべてNotionを正本とします。ローカルMarkdownはWorkerの同期入力には使いません。

Author Styleの同期元は上記2ページに固定されています。ページ移行時はWorker設定のpage IDも明示的に変更する必要があります。

## 初回移行

`Ready`ではNotion APIが返す本文を正本として検証し、文書行と現行section行を同一トランザクションで置換します。同じ内容なら`context_sha256`でskipし、履歴行は作りません。

Notionでは最初のH1がページタイトルになる場合があるため、author-style parserへ渡すときだけ`Name`からH1を復元します。Notion本文そのものはWorkerが変更しません。従来の`pull-author-style`は`source_path_key`が`notion:<page-id>`になった文書をローカルMarkdownから上書きしません。

## Secrets and permissions

必要なsecret:

```text
TIDB_DATABASE_URL
NOTION_API_TOKEN
NOTION_DATA_SOURCE_ID
NOTION_WEBHOOK_BOOTSTRAP_SECRET
NOTION_WEBHOOK_VERIFICATION_TOKEN
```

固定同期元の`AUTHOR_STYLE_TITLE_PAGE_ID`と`AUTHOR_STYLE_BODY_PAGE_ID`は
secretではないWorker varsとして`wrangler.jsonc`に設定します。

Notion integrationには対象data sourceへのread contentとpage property update権限だけを与えます。Workerはページ本文を書き換えません。

TiDB writerは次のread model tableだけに`SELECT`、`INSERT`、`UPDATE`を許可します。Author Styleの現行section入れ替えには`author_style_current_sections`への`DELETE`も必要です。DDLと他tableへの権限は不要です。

```text
notion_pages
author_style_documents
author_style_current_sections
business_knowledge_documents
business_knowledge_sections
```

`context_sync_state_log`には`INSERT`だけを許可します。このtableは追記専用で、Workerは過去の状態ログを`UPDATE`または`DELETE`しません。

直近50件は同期CLIから確認できます。

```bash
cd ../mycontext-sync
pnpm audit-sync-state -- --document-id ore-body-style
```

## Cloudflare setup

次はインフラを作成・変更するコマンドなので、実際のdata sourceとsecretを用意した後に実行します。

```bash
cd mycontext-sync-worker
pnpm install
cd ../mycontext-sync
pnpm migrate-sync-state-log
cd ../mycontext-sync-worker
wrangler queues create mycontext-sync
wrangler queues create mycontext-sync-dead-letter
wrangler secret put TIDB_DATABASE_URL
wrangler secret put NOTION_API_TOKEN
wrangler secret put NOTION_DATA_SOURCE_ID
wrangler secret put NOTION_WEBHOOK_BOOTSTRAP_SECRET
pnpm run deploy
```

Notion webhook URLは次の形式で登録します。

```text
https://<sync-worker>/webhooks/notion?bootstrap=<bootstrap-secret>
```

初回verification requestのtokenはWorker logへ一度だけ出力されます。その値を`NOTION_WEBHOOK_VERIFICATION_TOKEN`として保存し、再deployします。その後のイベントは`X-Notion-Signature`のHMAC-SHA256を検証します。

```bash
pnpm run tail
wrangler secret put NOTION_WEBHOOK_VERIFICATION_TOKEN
pnpm run deploy
```

## Verification

```bash
pnpm run typecheck
pnpm test
pnpm exec wrangler deploy --dry-run
```

`GET /healthz`は外部サービスを呼ばないliveness endpointです。

## Emergency Markdown

ローカルMarkdownは通常同期に参加しません。TiDB current snapshotの緊急スナップショットと、明示的な復旧だけに使います。

```bash
cd ../mycontext-sync
pnpm export-author-style-markdown -- --document-id ore-body-style
pnpm restore-author-style-markdown -- --document-id ore-body-style \
  --input-path /private/path/snapshot.md --dry-run
pnpm restore-author-style-markdown -- --document-id ore-body-style \
  --input-path /private/path/snapshot.md --activate-emergency
```

exportは原文`.md`とmetadata `.md.json`を分離して保存し、原文へfrontmatterを加えません。restoreは`--activate-emergency`がなければTiDBを書き換えません。緊急snapshotの`source_path_key`は`emergency:<absolute-path>`となります。Notion復旧後は、Notion上の正しい本文を確認して`Ready`へ戻すとcurrent snapshotが置き換わります。

Personal Contextのローカル退避には既存の`pnpm export-obsidian`を使用できます。いずれのexportファイルも通常同期の入力にはなりません。
