/**
 * docs/evernote-integration/themes/ の新規3文書を検証する。
 *
 * media-design.md / sales-client.md / editor-org.md の実体パーサは
 * parseKikakuPlaybook（連番H2章）なので、同じ振り分けに乗る
 * kikaku-composition-playbook として構造検証する（Phase 3-1のID追加前でも検証できる）。
 *
 * 企画構成プレイブック本体は完成済みで凍結（ユーザー決定 2026-07-26）。
 * interview.md は参照用ドラフトであり、Notionへ反映しないため検証対象外。
 *
 * 実行: mycontext-sync ディレクトリで
 *   pnpm exec tsx ../tools/evernote-integration/validate-themes.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEditorKnowledgeSectionedMarkdown } from "../../mycontext-sync/src/editorKnowledge.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const themesDir = path.join(repoRoot, "docs", "evernote-integration", "themes");

interface NewDocSpec {
  file: string;
  title: string;
}

const NEW_DOCS: NewDocSpec[] = [
  { file: "media-design.md", title: "メディア設計・運営プレイブック" },
  { file: "sales-client.md", title: "営業・提案・クライアントワークプレイブック" },
  { file: "editor-org.md", title: "編集者育成・制作組織プレイブック" }
];

/** 冒頭のメタ3行（テーマ/反映先/反映形態）を落として本文だけ返す */
async function readThemeBody(file: string): Promise<string> {
  const raw = await fs.readFile(path.join(themesDir, file), "utf-8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || /^(テーマ|反映先|反映形態)[:：]/.test(lines[i].trim()))) {
    i += 1;
  }
  return lines.slice(i).join("\n").trim();
}

async function main(): Promise<void> {
  let failed = false;

  for (const spec of NEW_DOCS) {
    const body = await readThemeBody(spec.file);
    // 実運用ではNotionのNameプロパティからH1が補われるため、同じ形にして渡す
    const markdown = `# ${spec.title}\n${body}\n`;
    try {
      const parsed = parseEditorKnowledgeSectionedMarkdown({
        documentId: "kikaku-composition-playbook",
        markdown,
        sourcePathKey: `notion:${spec.file}`
      });
      console.log(`OK   ${spec.file}: sections=${parsed.sectionCount} searchSpans=${parsed.searchSpanCount} chars=${markdown.length}`);
    } catch (error) {
      failed = true;
      console.error(`FAIL ${spec.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
