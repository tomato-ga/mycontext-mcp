import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAuthorStyleDocument,
  type AuthorStyleSource,
  type LoadedAuthorStyleDocument
} from "../src/authorStyle.js";
import { syncAuthorStyleDocument, type AuthorStyleWriter } from "../src/syncAuthorStyle.js";

vi.mock("../src/authorStyle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/authorStyle.js")>();
  return { ...actual, loadAuthorStyleDocument: vi.fn() };
});

const source: AuthorStyleSource = {
  documentId: "ore-title-style",
  authorKey: "ore",
  styleScope: "title",
  relativePath: "knowledge/title.md"
};

const document: LoadedAuthorStyleDocument = {
  documentId: "ore-title-style",
  authorKey: "ore",
  styleScope: "title",
  displayName: "Title style",
  sourcePathKey: source.relativePath,
  sourceMarkdown: "# Title style",
  sourceMarkdownSha256: "a".repeat(64),
  sourceBytes: 13,
  sourceLineCount: 1,
  sourceMtimeMs: 1,
  revisionSha256: "b".repeat(64),
  parserVersion: "parser-v1",
  sectioningVersion: "sections-v1",
  routingVersion: "routing-v1",
  routingManifest: {},
  outline: {},
  sectionCount: 0,
  deliverySectionCount: 0,
  searchSpanCount: 0,
  sections: []
};

describe("syncAuthorStyleDocument", () => {
  beforeEach(() => {
    vi.mocked(loadAuthorStyleDocument).mockResolvedValue(document);
  });

  it("skips an unchanged current snapshot", async () => {
    const writer: AuthorStyleWriter = {
      getAuthorStyleDocumentState: vi.fn().mockResolvedValue({
        contextSha256: document.revisionSha256,
        sourcePathKey: source.relativePath
      }),
      upsertAuthorStyleDocumentAndSections: vi.fn()
    };

    await expect(syncAuthorStyleDocument({
      sourceRoot: "/tmp/source",
      source,
      tidbClient: writer,
      dryRun: false,
      reindex: false
    })).resolves.toMatchObject({ status: "skipped", dbIndexed: false });
    expect(writer.upsertAuthorStyleDocumentAndSections).not.toHaveBeenCalled();
  });

  it("replaces the current snapshot when reindex is requested", async () => {
    const writer: AuthorStyleWriter = {
      getAuthorStyleDocumentState: vi.fn().mockResolvedValue({
        contextSha256: document.revisionSha256,
        sourcePathKey: source.relativePath
      }),
      upsertAuthorStyleDocumentAndSections: vi.fn()
    };

    await expect(syncAuthorStyleDocument({
      sourceRoot: "/tmp/source",
      source,
      tidbClient: writer,
      dryRun: false,
      reindex: true
    })).resolves.toMatchObject({ status: "synced", dbIndexed: true });
    expect(writer.upsertAuthorStyleDocumentAndSections).toHaveBeenCalledWith(document);
  });

  it("refuses to overwrite a document whose source is managed by Notion", async () => {
    const writer: AuthorStyleWriter = {
      getAuthorStyleDocumentState: vi.fn().mockResolvedValue({
        contextSha256: document.revisionSha256,
        sourcePathKey: "notion:page-1"
      }),
      upsertAuthorStyleDocumentAndSections: vi.fn()
    };

    await expect(syncAuthorStyleDocument({
      sourceRoot: "/tmp/source",
      source,
      tidbClient: writer,
      dryRun: false,
      reindex: false
    })).rejects.toMatchObject({ code: "author_style_source_owned_by_notion" });
    expect(writer.upsertAuthorStyleDocumentAndSections).not.toHaveBeenCalled();
  });
});
