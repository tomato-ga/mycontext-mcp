# Evernoteノウハウ統合

Evernoteのノウハウ候補をNotionの MyContext Documents へ統合する作業の専用ディレクトリ。

- `plan.md` … 実装手順書。フェーズ、ゲート、判定規則、実行体制（執筆はOpus、実装・反映はCodex）はここに集約する
- `ledger.md` … 候補ノートの台帳。Phase 1で記入し、以降の判定と状態を追跡する
- `themes/` … テーマ別ドキュメント。1テーマ1ファイルでOpusが執筆し、Notionへ反映する本文の正本とする（interview / media-design / sales-client / editor-org）

関連する場所は次のとおり。

- `tools/evernote-integration/` … パーサ検証と20,000文字上限チェックのスクリプト
- `private-exports/evernote-integration/` … Evernote原本ノートDBからの抽出テキストと、Notion編集前のバックアップ。gitignore済みでコミットしない
- `docs/evernote-knowhow-inventory-2026-07-25.md` … 統合対象の候補を洗い出した元の棚卸し文書
