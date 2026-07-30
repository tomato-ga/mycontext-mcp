import { describe, expect, it, vi } from "vitest";
import {
  AuthorStyleRoutingError,
  buildAuthorStyleSectionUri,
  validateAuthorStyleSelectors
} from "../src/authorStyle.js";
import {
  getAuthorStyleContext,
  searchAuthorStyleEvidence,
  type TidbClient
} from "../src/tidb.js";

const routingManifest = {
  schemaVersion: "single-context-pack-v1",
  selectorSchema: {
    operations: ["generate"],
    modes: ["news"],
    profiles: ["neutral"]
  },
  modeMap: { news: ["ore-title/mode/news", "ore-title/core"] },
  operations: { generate: { base: ["ore-title/core", "ore-title/output-contract"] } },
  profileMap: { neutral: [] },
  maxContextChars: 10_000,
  overflowPolicy: "error_no_truncation"
};

describe("author style routing", () => {
  it("rejects cross-document selector combinations", () => {
    expect(() => validateAuthorStyleSelectors({
      documentId: "ore-title-style",
      operation: "edit-voice",
      mode: "news",
      profile: "neutral"
    })).toThrow(AuthorStyleRoutingError);
    expect(() => validateAuthorStyleSelectors({
      documentId: "ore-body-style",
      operation: "generate",
      mode: "explanatory",
      profile: "neutral"
    })).toThrow("lengthBand is required");
  });

  it("returns one ordered, de-duplicated, untruncated context pack", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        document_id: "ore-title-style",
        display_name: "ore title style guide",
        revision_sha256: "a".repeat(64),
        routing_version: "single-context-pack-v1",
        routing_manifest_json: JSON.stringify(routingManifest)
      }])
      .mockResolvedValueOnce([
        {
          section_id: "mode-news",
          context_key: "ore-title/mode/news",
          title: "News",
          delivery_markdown: "## News\n\nNews rules.",
          ordinal: 3
        },
        {
          section_id: "core",
          context_key: "ore-title/core",
          title: "Core",
          delivery_markdown: "## Core\n\nCore rules.",
          ordinal: 1
        },
        {
          section_id: "output-contract",
          context_key: "ore-title/output-contract",
          title: "Output",
          delivery_markdown: "## Output\n\nOutput rules.",
          ordinal: 2
        }
      ]);
    const client: TidbClient = { execute };

    const context = await getAuthorStyleContext(client, {
      documentId: "ore-title-style",
      operation: "generate",
      mode: "news",
      profile: "neutral"
    });

    expect(context?.context_keys).toEqual([
      "ore-title/core",
      "ore-title/output-contract",
      "ore-title/mode/news"
    ]);
    expect(context?.markdown.indexOf("## Core")).toBeLessThan(context?.markdown.indexOf("## Output") ?? 0);
    expect(context?.markdown.indexOf("## Output")).toBeLessThan(context?.markdown.indexOf("## News") ?? 0);
    expect(context?.markdown).toContain("no section is truncated");
    expect(context?.section_resource_uris).toEqual([
      buildAuthorStyleSectionUri("ore-title-style", "core"),
      buildAuthorStyleSectionUri("ore-title-style", "output-contract"),
      buildAuthorStyleSectionUri("ore-title-style", "mode-news")
    ]);
    expect(execute.mock.calls[1]?.[0]).toContain("context_key IN (?, ?, ?)");
  });

  it("searches only active evidence layers and collapses a span to its delivery section", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "ore-title-style",
      revision_sha256: "a".repeat(64),
      matched_section_id: "evidence--quote",
      matched_section_title: "quote",
      matched_content_layer: "evidence",
      heading_path_json: JSON.stringify(["Guide", "Evidence", "quote"]),
      source_line_start: 10,
      source_line_end: 12,
      matched_position: 4,
      delivery_section_id: "evidence",
      delivery_section_title: "Evidence",
      delivery_context_key: "ore-title/evidence",
      delivery_markdown: "## Evidence\n\nComplete evidence section."
    }]);
    const client: TidbClient = { execute };

    await expect(searchAuthorStyleEvidence(
      client,
      "ore-title-style",
      "CTR%",
      3
    )).resolves.toMatchObject([{
      matched_section_id: "evidence--quote",
      delivery_section_id: "evidence",
      markdown: "## Evidence\n\nComplete evidence section."
    }]);
    const sql = execute.mock.calls[0]?.[0] as string;
    expect(sql).toContain("matched.content_layer IN ('evidence', 'profile', 'ops')");
    expect(sql).toContain("PARTITION BY documents.document_id, matched.delivery_section_id");
    expect(sql).toContain("WHERE delivery_match_rank = 1");
    expect(sql).toContain("LIMIT 3");
    expect(execute).toHaveBeenCalledWith(sql, [
      "CTR%",
      "CTR%",
      "ore-title-style",
      "%CTR\\%%"
    ]);
  });
});
