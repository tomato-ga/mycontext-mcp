import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  EditorKnowledgeSectionedDocumentId,
  EditorKnowledgeSectionedSource
} from "../../src/editorKnowledge.js";

export async function writeKikakuPlaybookFixture() {
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
  return writeKikakuSourceFixture("kikaku-composition-playbook", markdown);
}

export async function writeKikakuCatalogFixture() {
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
  return writeKikakuSourceFixture("kikaku-db-catalog", markdown);
}

export async function writeKikakuFulltextFixture() {
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
  return writeKikakuSourceFixture("kikaku-fulltext-3", markdown);
}

export async function writeKikakuSourceFixture(
  documentId: EditorKnowledgeSectionedDocumentId,
  markdown: string
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `editor-${documentId}-`));
  const relativePath = documentId === "kikaku-composition-playbook"
    ? "kikaku/composition-playbook.md"
    : documentId === "kikaku-db-catalog"
      ? "kikaku/kikaku-db-catalog.md"
      : `kikaku/${documentId}.md`;
  const source: EditorKnowledgeSectionedSource = { documentId, relativePath };
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, markdown, "utf8");
  return { root, source, markdown };
}
