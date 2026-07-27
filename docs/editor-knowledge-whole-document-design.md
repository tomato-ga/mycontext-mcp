# Editor Knowledge 全文1レコード設計

更新日: 2026-07-26

## 対象

- `henshu-editing-playbook`（編集プレイブック）
- `knowhow-media-design`（メディア運営プレイブック）

この2文書だけを全文1レコード方式にする。`kikaku-composition-playbook`、`kikaku-db-catalog`、`kikaku-fulltext-*`のsection設計は変更しない。

## 保存契約

- Notion「MyContext Documents」を正本とする。
- 全文とタイトル、本文SHA-256を`editor_knowledge_documents`の1行へ保存する。
- `section_revision_sha256`、`section_count`、`search_span_count`は`NULL`にする。
- `editor_knowledge_sections`には対象文書の行を持たない。旧設計の章行は、全文行の更新と同じトランザクションで文書IDを限定して削除する。
- 同期の同一revision判定には`COALESCE(section_revision_sha256, markdown_sha256)`を使う。全文方式では本文SHA-256がrevisionになる。

## MCP契約

- 一般検索は既存の非section文書経路（`section_count IS NULL`）で全文を検索する。
- 検索結果IDは`editor-knowledge:<document-id>`の1件とし、`#chapter-*`を返さない。
- `read_context`は上記文書IDで全文行を読む。
- 全文・非切り詰めの正規経路として次の専用ツールを提供する。
  - `get_editing_playbook_context`
  - `get_media_playbook_context`
- 専用ツールの構造化メタデータは`storage_mode=whole_document`、`record_count=1`、`section_count=0`、`search_span_count=1`を返す。

## 同期後の成立条件

各対象文書について、次を同時に満たすこと。

1. `editor_knowledge_documents`が1行
2. `editor_knowledge_sections`が0行
3. `section_revision_sha256`、`section_count`、`search_span_count`がすべて`NULL`
4. 一般MCP検索の安定IDが文書ID1件
5. 専用MCPツールの`truncated=false`
