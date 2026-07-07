# ブログ記事企画案: Notion を AI 用コンテキスト基盤にする最小構成

## 企画の狙い

Notion に溜めた知識を AI から使いたいが、いきなりベクトルDB、チャンク分割、全文同期、複雑な RAG に寄せると運用が重くなる。この記事では、必要な Notion ページだけを Markdown として TiDB に保存し、Remote MCP から読み取り専用で使う「小さく始める構成」を紹介する。

## 想定読者

- Notion にプロジェクトメモや個人ナレッジを溜めている開発者。
- AI エージェントに自分の文脈を渡したいが、RAG 基盤を大きく作りたくない人。
- MCP server を作りたいが、まずは read-only で安全に始めたい人。
- Obsidian やローカル Markdown との併用も残したい人。

## タイトル案

1. Notion を AI の記憶にする: TiDB と Remote MCP で作る最小コンテキスト基盤
2. RAG を大げさにしない Notion 同期: Markdown 1枚ずつを MCP で読む設計
3. Notion の個人ナレッジを AI から読めるようにした話
4. embedding なしで始める Notion x MCP コンテキスト管理
5. Notion, TiDB, Cloudflare Workers で作る read-only MCP server

## 中心メッセージ

AI に渡したい文脈が明確なら、最初から高機能な RAG を作らなくてもよい。対象ページを絞り、全文 Markdown を保存し、read-only MCP として公開するだけでも、日常運用に十分なコンテキスト基盤になる。

## 記事構成

### 1. 課題: Notion に情報はあるのに AI から使いにくい

- プロジェクトの背景、判断理由、運用メモが Notion に散らばる。
- AI に毎回貼り付けるのは面倒。
- 全ワークスペース検索や自動同期を最初から作ると、認証・権限・差分管理が重い。

### 2. 作ったものの全体像

```text
Notion pages
  -> sync CLI
  -> TiDB notion_pages
  -> Cloudflare Workers Remote MCP
  -> AI client
```

- `notion-context-sync`: Notion から Markdown を取得して TiDB に保存する CLI。
- `notion-context-mcp-worker`: TiDB を読む read-only Remote MCP server。
- `export-obsidian`: TiDB から Obsidian `_notion_pages/` に Markdown を書き出す補助機能。

### 3. 意図的に入れなかったもの

- embedding。
- chunk table。
- raw SQL tool。
- Worker 側の Notion API 呼び出し。
- 全ワークスペース同期。
- リアルタイム webhook 同期。
- ローカル MCP server。

ここは記事の山場。作らなかったものを明確にすることで、実装判断の説得力が出る。

### 4. データモデルは `notion_pages` だけ

紹介するポイント:

- `page_id` を primary key にする。
- `markdown` に本文全文を入れる。
- `markdown_sha256` で差分判定する。
- `truncated` と `unknown_block_ids` で変換時の問題を追えるようにする。

コード断片は schema の一部だけで十分。実 credentials や個人ページ名は出さない。

### 5. 同期CLIの設計

説明する流れ:

1. `.env` の `MIRROR_CONFIG_JSON`、または gitignored な `mirror.config.json` に seed page を置く。
2. seed page の本文を Notion API から Markdown 化する。
3. `child_page` と `link_to_page` を辿って関連ページも拾う。
4. hash が変わったページだけ TiDB に upsert する。
5. `doctor` と `search` で運用確認する。

強調点:

- 「全自動で全部取る」ではなく「起点を明示する」。
- Notion 側の権限も、対象ページ共有に限定できる。

### 6. Remote MCP Workerの設計

説明する流れ:

- Cloudflare Workers で `/mcp` を公開する。
- bearer token で認証する。
- `@tidbcloud/serverless` で TiDB に HTTP 接続する。
- MCP tools は `list_documents`, `search_context`, `search_text`, `get_document`, `health_check` に絞る。

強調点:

- Worker は read-only。
- migration も同期も Worker ではやらない。
- 外部公開面を小さくできる。

### 7. Obsidian exportはローカルで十分

- Obsidian はローカル vault に Markdown があればよい。
- Worker から iCloud/Obsidian を触る必要はない。
- `pnpm pull` と `pnpm export-obsidian` を launchd で週1回動かせば、頻度が低いコンテンツには十分。

### 8. 運用して分かったトレードオフ

良かった点:

- 構成が小さい。
- どこで書き込みが起きるか明確。
- MCP 側は read-only なので壊しにくい。
- Markdown 全文保存なのでデバッグしやすい。

制約:

- 検索は semantic search ではない。
- `LIKE` 検索なので表記ゆれには弱い。
- seed page に含めないページは同期されない。
- Notion 更新から即時反映ではない。

### 9. 次に足すなら

- Notion webhook で TiDB 更新を近リアルタイム化する。
- TiDB Vector Search や embedding を必要になったタイミングで足す。
- sync run の履歴テーブルを追加する。
- ページごとの公開範囲や用途分類を明示する。

## 記事内で使うとよい素材

- README の全体アーキテクチャ図。
- `notion_pages` schema の抜粋。
- MCP tools の一覧。
- `/healthz` と token なし `/mcp` の確認例。
- `pnpm run search -- --query ...` の出力例。ただし個人情報や非公開本文はマスクする。

## 書かないほうがよいこと

- 実際の Notion page ID や private なページタイトル。
- TiDB 接続文字列、MCP token、Notion integration secret。
- 「意味検索できる」といった実装していない機能の表現。
- webhook によるリアルタイム同期が既に動いているような書き方。
- Obsidian が Remote MCP から直接更新されるような書き方。

## 推奨トーン

「すごいAI基盤を作った」ではなく、「まず壊れにくい read-only 文脈供給から始めた」という実務寄りのトーンにする。過剰設計を避けた判断を、制約込みで正直に書くと読み手の再現性が高い。
