import type {
  EditorKnowledgeSectionedDocumentId,
  EditorKnowledgeSectionedMarkdownInput
} from "../../src/editorKnowledge.js";

export function createKikakuPlaybookFixture(): EditorKnowledgeSectionedMarkdownInput {
  const markdown = [
    "# 企画構成プレイブック テスト版",
    "",
    "## 1. 企画の立て方",
    "第1章の本文。",
    "",
    "### 補足メモ",
    "章本文に含まれるスタイル的な小見出し。",
    "",
    "## 2. 構成の作り方",
    "第2章の本文。",
    "",
    "## 3. 仕上げのチェック",
    "第3章の本文。",
    ""
  ].join("\n");
  return createKikakuSourceFixture("kikaku-composition-playbook", markdown);
}

export function createKikakuCatalogFixture(): EditorKnowledgeSectionedMarkdownInput {
  const markdown = [
    "# 企画カタログ427 テスト版",
    "",
    "## テーマ群A｜EC×D2C戦略",
    "グループAの概要文。",
    "",
    "### No.1 ｜ 最初の企画",
    "企画1の本文。",
    "",
    "### No.2 ｜ 二つ目の企画",
    "企画2の本文。",
    "",
    "## テーマ群B｜SNS運用",
    "グループBの概要文。",
    "",
    "### No.3 ｜ 三つ目の企画",
    "企画3の本文。",
    "",
    "### No.なし-1 ｜ 番号なしの企画",
    "番号なしエントリの本文。",
    ""
  ].join("\n");
  return createKikakuSourceFixture("kikaku-db-catalog", markdown);
}

export function createKikakuFulltextFixture(): EditorKnowledgeSectionedMarkdownInput {
  const markdown = [
    "# 企画ノウハウ全文集 3（No.97〜No.144）",
    "",
    "コンテンツ企画案DBの根拠ノート本文を無加工（機微情報マスキングのみ）で収録した全文集。",
    "",
    "## No.97 ｜ 最初の企画",
    "- **索引**: editor-knowledge:kikaku-db-catalog#no-097",
    "",
    "### 根拠ノート全文（マスキング済み）",
    "",
    "本文1。",
    "",
    "## No.98 ｜ 二つ目の企画",
    "- **索引**: editor-knowledge:kikaku-db-catalog#no-098",
    "",
    "### 根拠ノート全文（マスキング済み）",
    "",
    "本文2。",
    "",
    "## No.なし-1 ｜ 番号なしの企画",
    "根拠ノート本文はDB上に存在しない（本文取得状態: 未特定）。索引の要旨を参照。",
    ""
  ].join("\n");
  return createKikakuSourceFixture("kikaku-fulltext-3", markdown);
}

export function createKikakuSourceFixture(
  documentId: EditorKnowledgeSectionedDocumentId,
  markdown: string
): EditorKnowledgeSectionedMarkdownInput {
  return {
    documentId,
    markdown,
    sourcePathKey: `notion:fixture:${documentId}`
  };
}
