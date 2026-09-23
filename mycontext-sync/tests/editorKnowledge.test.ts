import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EDITOR_KNOWLEDGE_SOURCES,
  loadEditorKnowledgeDocument,
  type EditorKnowledgeSource
} from "../src/editorKnowledge.js";
import { sha256 } from "../src/hash.js";

describe("editor knowledge sources", () => {
  it("uses the fixed 8-document ID allowlist", () => {
    expect(EDITOR_KNOWLEDGE_SOURCES.map((source) => source.documentId)).toEqual([
      "overview",
      "lesson-01",
      "lesson-02",
      "lesson-03",
      "lesson-04",
      "lesson-05",
      "lesson-06",
      "lesson-07"
    ]);
  });

  it("loads UTF-8 Markdown, extracts the H1 title, and hashes the stored text", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-"));
    const source = sourceFor("lesson.md");
    const markdown = "# 第4回: 編集作業（13のチェックポイント）\n\n本文\n";
    await fs.writeFile(path.join(root, source.relativePath), markdown, "utf8");

    const document = await loadEditorKnowledgeDocument(root, source);

    expect(document).toEqual({
      documentId: "lesson-04",
      title: "第4回: 編集作業（13のチェックポイント）",
      markdown,
      markdownSha256: sha256(markdown)
    });
  });

  it("allows a filesystem root as the configured source root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-root-"));
    const target = path.join(root, "lesson.md");
    const markdown = "# 第4回: 編集作業\n\n本文\n";
    await fs.writeFile(target, markdown, "utf8");
    const filesystemRoot = path.parse(target).root;
    const source = sourceFor(path.relative(filesystemRoot, target));

    await expect(loadEditorKnowledgeDocument(filesystemRoot, source)).resolves.toMatchObject({
      documentId: "lesson-04",
      title: "第4回: 編集作業",
      markdown
    });
  });

  it("rejects a source path that escapes the configured root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-escape-"));

    await expect(loadEditorKnowledgeDocument(root, sourceFor("../outside.md"))).rejects.toMatchObject({
      code: "editor_knowledge_path_escape"
    });
    await expect(loadEditorKnowledgeDocument(root, sourceFor("."))).rejects.toMatchObject({
      code: "editor_knowledge_path_escape"
    });
  });

  it("allows an in-root filename beginning with two dots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-dotfile-"));
    const markdown = "# 第4回: 編集作業\n\n本文\n";
    await fs.writeFile(path.join(root, "..lesson.md"), markdown, "utf8");

    await expect(loadEditorKnowledgeDocument(root, sourceFor("..lesson.md"))).resolves.toMatchObject({
      documentId: "lesson-04",
      title: "第4回: 編集作業",
      markdown
    });
  });

  it("rejects invalid UTF-8", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-"));
    const source = sourceFor("invalid.md");
    await fs.writeFile(path.join(root, source.relativePath), new Uint8Array([0xc3, 0x28]));

    await expect(loadEditorKnowledgeDocument(root, source)).rejects.toMatchObject({
      code: "editor_knowledge_invalid_utf8"
    });
  });

  it("requires the first line to be an H1 title", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-knowledge-"));
    const source = sourceFor("missing-title.md");
    await fs.writeFile(path.join(root, source.relativePath), "本文だけ\n", "utf8");

    await expect(loadEditorKnowledgeDocument(root, source)).rejects.toMatchObject({
      code: "editor_knowledge_title_missing"
    });
  });
});

function sourceFor(relativePath: string): EditorKnowledgeSource {
  return { documentId: "lesson-04", relativePath };
}
