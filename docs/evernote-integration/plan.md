# Evernoteノウハウ統合 実装手順書

作成日: 2026-07-26
実行者: Codex（実装・検証・Notion反映）と Opus（ドキュメント化）。分担は「実行体制」を参照
承認者: 大野（各ゲートで判断する）

## 目的と方針

Evernoteから洗い出したノウハウ候補（`docs/evernote-knowhow-inventory-2026-07-25.md`）を、Notionの MyContext Documents データベースへ統合する。

方針は次の3つに固定する。

- 正本は [MyContext Documents](https://app.notion.com/p/oono/27f581fa7d1d4f13b53f697b2cf3a5e9) とし、すべての文書はこのDB経由でTiDBへ同期する。
- 新規文書の作成より、既存文書への追記を優先する。新規に作ってよいのは、承認済みの3文書だけである。
- どの候補も、台帳で4区分（`既存文書に含まれる` / `既存文書へ追記` / `新規文書へ採用` / `保留・除外`）に判定してから文書化する。台帳の承認前に、Notionへの書き込みを行わない。

## 実行体制

作業は2つのエージェントで分担する。

- **Opus（Claude Opus 5）**: テーマごとのドキュメント化。`docs/evernote-integration/themes/` 配下のテーマ別mdファイル（1テーマ1ファイル）の執筆をすべて担当する。Claude Code の Agent 機能で model=opus を指定して実行する。
- **Codex**: それ以外のすべて。Phase 0の抽出、Phase 1の台帳記入、検証スクリプトの作成と実行、Phase 3-1のコード変更、Notionへの反映と同期確認、Phase 4の全体検証。**Codexはテーマ別mdファイルの本文を書かない。** 起草も改稿もOpusの担当で、Codexが行うのは検証と反映だけである。

起草に必要な入力（承認済み台帳、抽出テキスト、現行本文のバックアップ、本手順書のスコープ境界）はCodexが先に揃える。Opusの成果物は `themes/` 配下のファイルに限る。Opusは台帳・コード・Notionには触れない。検証やレビューで本文の修正が必要になった場合も、Codexが直すのではなくOpusに差し戻す。

## 専用ディレクトリ構成

本作業の成果物はすべて次の専用ディレクトリに集約する。他の場所にファイルを置かない。

```
docs/evernote-integration/                     git管理。手順書・台帳・テーマ別ドキュメント
├── plan.md                                    本手順書
├── README.md                                  ディレクトリ構成の説明
├── ledger.md                                  台帳（Phase 1で記入する）
└── themes/                                    テーマ別ドキュメント。1テーマ1ファイル。執筆はOpus専任
    ├── interview.md                           取材・インタビュー（Phase 2で企画構成プレイブックへ追記）
    ├── media-design.md                        メディア設計・運営（Phase 3で knowhow-media-design として新規作成）
    ├── sales-client.md                        営業・提案・クライアントワーク（Phase 3で knowhow-sales-client として新規作成）
    └── editor-org.md                          編集者育成・制作組織（Phase 3で knowhow-editor-org として新規作成）

tools/evernote-integration/                    git管理。本作業の検証スクリプト

private-exports/evernote-integration/          gitignore済み。コミットしない
├── extracts/                                  Evernote原本ノートDBから抽出した本文テキスト
└── backup/                                    Notion編集前のバックアップMarkdown
```

テーマ別ドキュメントの規則は次のとおり。

- 1テーマ1ファイル。台帳で `既存文書へ追記` または `新規文書へ採用` の素材が1件以上付いたテーマだけファイルを作る。基本は上記4ファイルで、台帳の結果それ以外のテーマが立った場合はファイルを作る前にユーザーへ報告する。
- ファイル冒頭に、テーマ名、反映先（Notion文書名とDocument ID）、反映形態（追記 / 新規）を3行で書く。この冒頭部はNotionへは反映しない。
- 本文の構造は反映形態に合わせる。新規文書は `## 1.` 始まりの連番H2章、追記は章1つ分（章番号は反映時にCodexが既存の最終章の次番号を割り当てるため、見出しは `## N. 章タイトル` と仮置きする）。
- バックアップは `<Document ID>-<YYYY-MM-DD>.md` とする。

Notionへ反映する本文は、必ず `docs/evernote-integration/themes/` のファイルを正とする。テーマ別ドキュメントを作らずにNotionを直接編集しない。

検証スクリプトは `tools/evernote-integration/` に置く。`mycontext-sync` の `parseEditorKnowledgeSectionedMarkdown` を import し、パーサ検証と20,000文字上限チェックの2つを担わせる。使い捨てにせずこのディレクトリで維持し、`mycontext-sync/scripts/` などworker側のディレクトリには置かない。

## 前提となるシステムの事実

実装前に把握しておくべき事実を挙げる。すべて現行コードで確認済みである。

- 同期経路は「Notionページ（Status=Ready）→ mycontext-sync-worker → TiDB → mycontext-mcp-worker（MCP）」の一方向である。ローカルファイルからの直接同期経路は廃止されている。
- Editor Knowledge カテゴリの Document ID は `isEditorKnowledgeSectionedDocumentId`（`mycontext-sync/src/editorKnowledge.ts:73`）で検証される。現在許可されているのは `kikaku-composition-playbook`、`kikaku-db-catalog`、`kikaku-fulltext-*` のみ。新規文書はこの許可リストの拡張（コード変更）が必要になる。
- パーサ振り分けは `parseEditorKnowledgeSectionedMarkdown`（`mycontext-sync/src/editorKnowledge.ts:227`）にある。sync-worker側の入口は `defaultParseEditorKnowledge`（`mycontext-sync-worker/src/sync.ts:487`）。
- `parseKikakuPlaybook`（`mycontext-sync/src/businessKnowledge.ts:465`）は「`## N. 章タイトル` 形式の連番H2章が1つ以上」という構造を要求する。この構造を満たす文書なら再利用できる。
- MCPツール `get_planning_playbook_context` は合計20,000文字が上限で、超過時は省略ではなく明示エラーになる（`mycontext-mcp-worker/src/planningPlaybook.ts:6`）。企画構成プレイブックへの追記は、この上限内に収まることを事前に確認しなければならない。
- MCPのリソース列挙と検索は `editor_knowledge_documents` テーブル全体を対象にしている（`mycontext-mcp-worker/src/tidb.ts:693` 付近のコメント）。新規文書は同期に成功すれば、リソースと `search_context` に自動で現れる。
- Notionページの必須プロパティは Category、Document ID、Schema Version（Editor Knowledge は `editor-knowledge-v1`）、Sync Source=`Notion`、Active=on。Status を `Ready` にすると同期が走り、成功で `Synced`、検証失敗で `Invalid` や `Conflict` になる。
- ページ本文にH1がない場合、Nameプロパティから `# <Name>` が補われる（`canonicalEditorKnowledgeMarkdown`）。本文にH1を書かず、章は `##` から始めてよい。
- `private-exports/` は gitignore 済みである。Evernote由来の生データやバックアップは `private-exports/evernote-integration/` 配下に置く。
- Evernoteの全ノートは、Notionの [Evernote原本ノートDB(9000)](https://app.notion.com/p/3a7625feb1a28068b7dcf73a1201468b) にページとして取り込み済みである。プロパティに `タイトル`、`ノートブック`、`Evernote GUID`、`添付確認`（なし / 要確認）を持つ。このDBは MyContext Documents とは別のDBで、TiDB同期の対象外。素材の読み取り元としてだけ使い、書き込まない。

## 対象文書

| 文書 | Category / Document ID | 本計画での扱い |
|---|---|---|
| [企画構成プレイブック](https://app.notion.com/3a7625feb1a281d1a981e45f36f296f4) | Editor Knowledge / `kikaku-composition-playbook` | 追記先（取材・インタビュー章など） |
| [コンテンツ企画案カタログ](https://app.notion.com/3a7625feb1a281639eb8d8dc982f091e) | Editor Knowledge / `kikaku-db-catalog` | 変更しない（事例・根拠の索引として維持） |
| [大野恭希キャリア・編集スキル](https://app.notion.com/3a5625feb1a281ae80a9f231245e6e36) | Personal Context（着手時にページのCategoryプロパティで要確認） | 原則変更しない。台帳で `既存文書に含まれる` の重複先 |
| [大野恭希起業と経営](https://app.notion.com/3a5625feb1a281a19112ebe340c95808) | Personal Context（同上） | 同上 |
| メディア設計・運営プレイブック | Editor Knowledge / 新規（Phase 3参照） | 新規作成 |
| 営業・提案・クライアントワークプレイブック | Editor Knowledge / 新規 | 新規作成 |
| 編集者育成・制作組織プレイブック | Editor Knowledge / 新規 | 新規作成 |

## Phase 0: 素材の抽出

Evernote本文は [Evernote原本ノートDB(9000)](https://app.notion.com/p/3a7625feb1a28068b7dcf73a1201468b) に全件取り込み済みである（データソースID: `collection://3a7625fe-b1a2-8002-aa9e-000b83c574df`、インポートバッチ `ENEX_ALL_2026-07-25`）。ENEXエクスポートは行わない。このDBから候補ノートの本文をローカルに落とし、後続フェーズの引用元を確定する。

1. 候補ノートをDBから特定する。対象は inventory 文書の「特に密度が高いノート群」19件と、各テーマ領域の候補ノート。`notion-query-data-sources`（SQLモード）で `タイトル` の部分一致検索とし、`ノートブック` プロパティで絞り込んでよい。
2. 各候補ページの本文を `notion-fetch` で取得し、`private-exports/evernote-integration/extracts/` に1ノート1ファイルで書き出す。ファイル冒頭にノート名、ノートブック、NotionページURLをメタ情報として付ける。
3. `添付確認` が `要確認` のノート、および本文が実質空（画像・PDF・Noteshelfのみ）のノートは抽出対象から外し、Phase 1の台帳で `保留・除外`（理由: 要OCR・要添付確認）と記録する。
4. Evernote原本ノートDBは読み取り専用で扱う。ページ本文・プロパティ（`移行状態` を含む）を変更しない。処理状態の追跡は台帳だけで行う。

完了条件: 台帳に載せる候補ノートすべてについて、テキスト抽出済みか `保留・除外` かが決まっている。

## Phase 1: 台帳の作成

`docs/evernote-integration/ledger.md` に、候補ノートを1行1ノートで台帳化する。ファイルは列ヘッダと判定規則の要約だけを入れたテンプレートとして用意済みである。新しい台帳ファイルは作らない。

列は次の9つとする。

| 列 | 内容 |
|---|---|
| No | 連番 |
| ノート名 | ノートのタイトル |
| Notion URL | Evernote原本ノートDB上の該当ページURL |
| ノートブック | `ノートブック` プロパティの値 |
| テーマ領域 | inventory 文書の10領域のいずれか |
| 判定 | `既存文書に含まれる` / `既存文書へ追記` / `新規文書へ採用` / `保留・除外` |
| 対応先 | 判定に応じた文書名（追記なら章名まで、新規なら3文書のいずれか） |
| 根拠 | 判定理由を一文で |
| 状態 | `未処理` / `反映済み` / `見送り` |

判定は次の規則に従う。迷ったら `保留・除外` に倒す。

- 企画、構成、タイトル、記事広告、SEOのノウハウは `既存文書に含まれる`（対応先: 企画構成プレイブック）。
- 取材・インタビューの手順は `既存文書へ追記`（対応先: 企画構成プレイブックの新章）。
- メディア戦略のうちKPI、体制、ポジショニング、収益モデルは `新規文書へ採用`（対応先: メディア設計・運営プレイブック）。企画制作と重なる部分は採用しない。
- ヒアリング、提案、修正、検収、レポートの手順は `新規文書へ採用`（対応先: 営業・提案・クライアントワークプレイブック）。
- 研修、編集長育成、役割設計、採用の運用手順は `新規文書へ採用`（対応先: 編集者育成・制作組織プレイブック）。
- キャリア・働き方、および学習・健康・お金は `既存文書に含まれる` または `保留・除外`。新規文書は作らない。
- 新規事業・起業の方法論は `保留・除外`（将来の独立候補として理由欄に明記）。
- Webクリップ、メールマガジン、書籍の抜き書きなど本人の実務ノウハウでないものは `保留・除外`。

完了条件: 候補ノート全件に判定と根拠が付き、`新規文書へ採用` の対応先が3文書のいずれかに限られている。

**ゲート G1**: 台帳をユーザーがレビューし、承認するまでPhase 2以降に進まない。

## Phase 2: 既存文書への追記

台帳で `既存文書へ追記` と判定された項目を、企画構成プレイブックへ反映する。追記は「`themes/interview.md` をOpusが執筆 → Codexが検証 → G2承認 → CodexがNotion反映」の順で進める。

### 2-1. テーマ別ドキュメントの執筆と検証

1. 【Codex】対象ページの現在の本文Markdownを取得し、`private-exports/evernote-integration/backup/kikaku-composition-playbook-<YYYY-MM-DD>.md` として保存する（ロールバック用）。
2. 【Opus】取材・インタビューのテーマ別ドキュメントを `docs/evernote-integration/themes/interview.md` に執筆する。本文は追記章1つ分とし、見出しは `## N. 章タイトル` と仮置きする（Nは反映時にCodexが既存の最終章の次番号を割り当てる）。既存章の番号変更や並べ替えは行わない。入力は、台帳の該当行、抽出テキスト、手順1のバックアップ（既存章との重複回避のため）とする。
3. 【Codex】`tools/evernote-integration/` の検証スクリプトに、バックアップした現行本文と章番号を確定させたテーマ別ドキュメントを渡し、結合後の全文について2点を検証する。
   - `parseEditorKnowledgeSectionedMarkdown`（documentId: `kikaku-composition-playbook`）を通ること。
   - 文字数が20,000文字の上限に収まること。超過する見込みなら追記せず、台帳の判定を `保留・除外`（理由: 上限超過）に変更してユーザーへ報告する。
   - 検証で本文の修正が必要になった場合はOpusに差し戻す。Codexは本文を直さない。

**ゲート G2（追記章）**: `themes/interview.md` をユーザーがレビューし、承認するまでNotionへ書き込まない。

### 2-2. Notionへの反映と同期確認

1. 承認済みの `themes/interview.md` の本文（冒頭のメタ情報3行を除き、章番号を確定させたもの）をNotionページ末尾にブロックとして追加し、Status を `Ready` に変更する。本文の内容をこの段階で変更しない。変更が必要になった場合はOpusがテーマ別ドキュメントを直し、G2からやり直す。
2. 同期結果を3経路で確認する。
   - Notion: Status が `Synced` になり、Validation Error が空であること。
   - TiDB: `editor_knowledge_documents` の該当行の revision が更新され、section_count が章数と一致すること。
   - MCP: `get_planning_playbook_context` が新章を返すこと。
3. 台帳の該当行の状態を `反映済み` に更新する。

キャリア・起業の2文書（Personal Context）への追記は原則発生しない想定だが、台帳で必要と判定された場合は、該当テーマのファイルを `themes/` に立てて（作成前にユーザーへ報告）、パーサ制約がないため「バックアップ→Opusが執筆→G2承認→本文追記→Ready→`notion_pages` の更新確認」でよい。検証スクリプトは通さない。

完了条件: `既存文書へ追記` の全項目が `反映済み` または理由付きの `見送り` になっている。

## Phase 3: 新規3文書の作成

コード変更で新しい Document ID を受け入れ可能にしてから、Notionページを作成して同期する。

### 3-1. コード変更

新規IDは次の3つとする（固定リスト。開放族にはしない）。

- `knowhow-media-design`（メディア設計・運営プレイブック）
- `knowhow-sales-client`（営業・提案・クライアントワークプレイブック）
- `knowhow-editor-org`（編集者育成・制作組織プレイブック）

変更箇所は次のとおり。

1. `mycontext-sync/src/editorKnowledge.ts`: `EditorKnowledgeSectionedDocumentId` 型と `isEditorKnowledgeSectionedDocumentId` に3IDを追加し、`parseEditorKnowledgeSectionedMarkdown` の振り分けで3IDを `parseKikakuPlaybook` に流す。パーサは連番H2章の構造をそのまま要求する（新パーサは書かない）。
2. `mycontext-sync-worker/src/sync.ts`: `defaultParseEditorKnowledge` のエラーメッセージを新IDを含む表現に更新する。
3. テスト: `mycontext-sync` と `mycontext-sync-worker` の既存テストに、新IDの受理と、未知IDの拒否のケースを追加する。`mycontext-mcp-worker/tests/toolSurface.test.ts` がID列挙に依存していないか確認し、依存していれば更新する。
4. 両workerで `pnpm typecheck` と `pnpm test` を通し、`mycontext-sync-worker` を `pnpm deploy` でデプロイする。`mycontext-mcp-worker` はコード変更が発生した場合のみデプロイする（リソース列挙は動的なので、通常は不要のはず）。

### 3-2. テーマ別ドキュメントの執筆

【Opus】台帳で `新規文書へ採用` と判定された素材から、3テーマを `docs/evernote-integration/themes/` に1テーマ1ファイルで執筆する。ファイル名は `media-design.md`、`sales-client.md`、`editor-org.md` とする。本文は `## 1.` 始まりの連番章で書き、H1は書かない。スコープは次の境界を守る。

- メディア設計・運営: 目的、ポジショニング、KPI、体制、収益モデルに限定する。企画制作の手順（企画構成プレイブックの領分）を繰り返さない。
- 営業・提案・クライアントワーク: ヒアリング、課題整理、提案、制作引き継ぎ、修正、検収、レポートを一連の流れとして書く。
- 編集者育成・制作組織: 研修、編集長育成、役割設計、判断基準、週次改善、採用を扱う。個人の実績記述（キャリア文書の領分）を混ぜない。

執筆した3ファイルは【Codex】が `tools/evernote-integration/` の検証スクリプト（Phase 2-1 手順3と同じもの）でパーサ検証を通す。修正が必要ならOpusに差し戻す。

**ゲート G2（新規3文書）**: `themes/` の3ファイルをユーザーがレビューし、承認するまでNotionページを作成しない。

### 3-3. Notionページ作成と同期

1. MyContext Documents DBに3ページを作成する。プロパティは Category=`Editor Knowledge`、Document ID=上記3ID、Schema Version=`editor-knowledge-v1`、Sync Source=`Notion`、Active=on。本文は `themes/` の承認済みファイル（冒頭のメタ情報3行を除く）をそのまま流し込む。テーマファイルとDocument IDの対応は「専用ディレクトリ構成」のツリー図に従う。
2. 1ページずつ Status を `Ready` にし、Phase 2-2 手順2と同じ3経路（Notion / TiDB / MCP）で確認する。MCPでは新文書がリソース列挙に現れ、`search_context` でヒットすることを確認する。
3. 台帳の `新規文書へ採用` 行を `反映済み` に更新する。

## Phase 4: 全体検証と記録

1. `mycontext-sync`、`mycontext-sync-worker`、`mycontext-mcp-worker` で `pnpm test` と `pnpm typecheck` を実行する。
2. `mycontext-mcp-worker` の live smoke（`pnpm test:live-planning-playbook`）で、追記後のプレイブックが上限内で配信されることを確認する。
3. `docs/evernote-integration/ledger.md` の全行の状態が `反映済み` / `見送り` のいずれかで埋まっていることを確認する。
4. README（`mycontext-sync` と `mycontext-mcp-worker`）の文書一覧・ID記述を新IDに合わせて更新する。
5. `docs/evernote-integration/` 一式（plan.md、ledger.md、themes/）、`tools/evernote-integration/` の検証スクリプト、コード変更、README更新をコミットする。`private-exports/evernote-integration/`（抽出テキスト、バックアップ）はコミットしない。

## やらないこと

- 学習・健康・お金テーマの新規文書化（品質・出典の理由で見送り）。
- コンテンツ企画案カタログの再編・追記。
- 既存文書の削除、改名、章の並べ替え。
- 新規事業プレイブックの作成（台帳に `保留・除外` として記録するだけ）。
- 本手順書に挙げた文書以外のNotionページへの書き込み。

## ロールバック

- Notion本文: `private-exports/evernote-integration/backup/` の同期前Markdownを貼り戻し、Status を `Ready` にして再同期する。
- TiDB: revisionは追記専用で、有効revisionの切り替えのみ行われる。個別のDB操作はせず、Notion側を正して再同期することで戻す。
- コード: 該当コミットを `git revert` し、sync-workerを再デプロイする。

## 未決事項（実行中にユーザー判断が必要になりうる点）

- キャリア・起業2文書の実際のCategoryプロパティ（着手時に確認し、Personal Contextでなければ扱いを報告する）。
- 企画構成プレイブックが20,000文字上限に近い場合の追記可否（超過見込みは自動で保留に落とし、報告する）。
