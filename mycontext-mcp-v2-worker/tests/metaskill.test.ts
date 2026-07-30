import { describe, expect, it, vi } from "vitest";
import {
  MetaskillRoutingError,
  buildMetaskillSectionUri,
  validateMetaskillSelectors
} from "../src/metaskill.js";
import {
  getMetaskillContext,
  searchMetaskillEvidence,
  type TidbClient
} from "../src/tidb.js";

const routingManifest = {
  schemaVersion: "topic-context-pack-v1",
  selectorSchema: {
    topics: ["structuring"],
    intents: ["understand", "prompt"],
    depths: ["brief", "standard"]
  },
  routes: {
    "structuring:understand:brief": ["metaskill/skill/structuring/core"],
    "structuring:prompt:standard": ["metaskill/skill/structuring/prompt/premortem"]
  },
  maxContextCharsByDepth: { brief: 10_000, standard: 20_000 },
  overflowPolicy: "error_no_truncation"
};

describe("metaskill routing", () => {
  it("validates selector values", () => {
    expect(() => validateMetaskillSelectors({
      documentId: "ai-self-strategy",
      topic: "structuring",
      intent: "understand",
      depth: "brief"
    })).not.toThrow();
    expect(() => validateMetaskillSelectors({
      documentId: "ai-self-strategy",
      topic: "structuring",
      intent: "prompt",
      depth: "deep"
    })).not.toThrow();
    expect(() => validateMetaskillSelectors({
      documentId: "ai-self-strategy",
      topic: "not-a-topic" as "structuring",
      intent: "understand",
      depth: "brief"
    })).toThrow(MetaskillRoutingError);
  });

  it("returns an ordered, untruncated semantic context pack", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        document_id: "ai-self-strategy",
        display_name: "メタスキル",
        revision_sha256: "a".repeat(64),
        routing_version: "topic-context-pack-v1",
        routing_manifest_json: JSON.stringify(routingManifest)
      }])
      .mockResolvedValueOnce([{
        section_id: "skill--structuring--core",
        context_key: "metaskill/skill/structuring/core",
        title: "構造化",
        delivery_markdown: "## 構造化\n\nComplete section.",
        ordinal: 1
      }]);
    const client: TidbClient = { execute };

    const context = await getMetaskillContext(client, {
      documentId: "ai-self-strategy",
      topic: "structuring",
      intent: "understand",
      depth: "brief"
    });
    expect(context).toMatchObject({
      document_id: "ai-self-strategy",
      selectors: { topic: "structuring", intent: "understand", depth: "brief" },
      context_keys: ["metaskill/skill/structuring/core"]
    });
    expect(context?.markdown).toContain("no section is truncated");
    expect(context?.section_resource_uris).toEqual([
      buildMetaskillSectionUri("ai-self-strategy", "skill--structuring--core")
    ]);
  });

  it("searches fine spans and expands them to complete delivery sections", async () => {
    const execute = vi.fn().mockResolvedValue([{
      document_id: "ai-self-strategy",
      revision_sha256: "a".repeat(64),
      matched_section_id: "skill--structuring--core--span-001",
      matched_section_title: "構造化 — 検索スパン1",
      matched_content_layer: "runtime",
      heading_path_json: JSON.stringify(["メタスキル", "構造化", "検索スパン1"]),
      source_line_start: 700,
      source_line_end: 705,
      matched_position: 8,
      delivery_section_id: "skill--structuring--core",
      delivery_section_title: "メタスキル1 構造化",
      delivery_context_key: "metaskill/skill/structuring/core",
      delivery_markdown: "## メタスキル1 構造化\n\nComplete delivery."
    }]);
    const client: TidbClient = { execute };

    await expect(searchMetaskillEvidence(
      client,
      "ai-self-strategy",
      "不確実性",
      3
    )).resolves.toMatchObject([{
      matched_section_id: "skill--structuring--core--span-001",
      delivery_section_id: "skill--structuring--core",
      markdown: "## メタスキル1 構造化\n\nComplete delivery."
    }]);
    const sql = execute.mock.calls[0]?.[0] as string;
    expect(sql).toContain("FROM metaskill_documents AS documents");
    expect(sql).toContain("matched.is_searchable = TRUE");
    expect(sql).toContain("PARTITION BY documents.document_id, matched.delivery_section_id");
    expect(sql).toContain("WHERE delivery_match_rank = 1");
    expect(sql).toContain("LIMIT 3");
  });
});
