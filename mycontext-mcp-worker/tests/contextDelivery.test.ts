import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPublicTools } from "../src/tools/register.js";
import type { TidbClient } from "../src/tidb.js";

const readers = vi.hoisted(() => ({
  getPlanningPlaybookContext: vi.fn(),
  getEditingPlaybookContext: vi.fn(),
  getMediaPlaybookContext: vi.fn(),
  getAuthorStyleContext: vi.fn(),
  getMetaskillContext: vi.fn(),
  getDocument: vi.fn(),
  getEditorKnowledgeSection: vi.fn(),
  getBusinessKnowledgeSection: vi.fn(),
  searchContext: vi.fn(),
  searchAuthorStyleEvidence: vi.fn(),
  searchMetaskillEvidence: vi.fn()
}));
const skillReader = vi.hoisted(() => vi.fn());
vi.mock("../src/tidb.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/tidb.js")>(),
  ...readers
}));
vi.mock("../src/skillContext.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/skillContext.js")>(),
  getSkillContextDocument: skillReader
}));

// Synthetic fixtures only. Never copy private Notion content into this repository.
const body = "# Synthetic context 😀\n" + "完全な本文のテストです。\n".repeat(1_000) + "\nEND_OF_CONTEXT";
const pack = {
  document_id: "synthetic",
  title: "Synthetic fixture",
  markdown: body,
  markdown_sha256: "synthetic-source-hash",
  revision_sha256: "synthetic-revision",
  context_chars: body.length,
  last_synced_at: "2026-01-01T00:00:00Z",
  truncated: false,
  retrieval_mode: "full_playbook"
};
const section = {
  document_id: "synthetic",
  title: "Synthetic section",
  markdown: body,
  heading_path: ["Synthetic"],
  content_layer: "detail",
  source_line_start: 1,
  source_line_end: 1_002
};
const evidence = {
  ...section,
  delivery_section_title: "Synthetic delivery",
  matched_section_title: "Synthetic match",
  matched_content_layer: "detail",
  delivery_context_key: "synthetic-key",
  resource_uri: "mycontext://synthetic"
};

let server: McpServer;
let sdkClient: Client;
let database: TidbClient;
beforeEach(async () => {
  vi.resetAllMocks();
  for (const name of [
    "getPlanningPlaybookContext", "getEditingPlaybookContext", "getMediaPlaybookContext",
    "getAuthorStyleContext", "getMetaskillContext"
  ] as const) readers[name].mockResolvedValue(pack);
  readers.getDocument.mockResolvedValue({
    ...pack, document_id: "notion:synthetic", source: "notion", source_id: "synthetic",
    source_truncated: false, unknown_block_ids: []
  });
  readers.getEditorKnowledgeSection.mockResolvedValue(section);
  readers.getBusinessKnowledgeSection.mockResolvedValue(section);
  readers.searchAuthorStyleEvidence.mockResolvedValue([evidence]);
  readers.searchMetaskillEvidence.mockResolvedValue([evidence]);
  readers.searchContext.mockResolvedValue([{
    document_id: "skill-context:marketing-lean-canvas", source: "skill_context",
    title: "Synthetic skill", text: body, match_position: 1,
    matched_terms: ["marketing-lean-canvas"], score: 1, search_stage: "intent"
  }]);
  skillReader.mockResolvedValue({ ...pack, skill_id: "marketing-lean-canvas", merge_version: "synthetic" });
  database = { execute: vi.fn() };
  server = new McpServer({ name: "delivery-contract-test", version: "1.0.0" });
  registerPublicTools(server, database);
  sdkClient = new Client({ name: "delivery-contract-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await sdkClient.connect(clientTransport);
});
afterEach(async () => {
  await sdkClient?.close();
  await server?.close();
});

async function call(name: string, args: Record<string, unknown> = {}) {
  // Model the adapter that retains ONLY structuredContent after the wire round-trip.
  const wire = JSON.parse(JSON.stringify(await sdkClient.callTool({ name, arguments: args })));
  return wire as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
    structuredContent?: { markdown?: string; returned_chars?: number; context?: Record<string, unknown>; results?: unknown[] };
  };
}
function expectDelivered(result: Awaited<ReturnType<typeof call>>, expected: string) {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent?.markdown).toBe(expected);
  expect(result.content).toEqual([{ type: "text", text: expected }]);
  expect(result.structuredContent?.returned_chars).toBe(expected.length);
}

describe("all public context delivery routes", () => {
  it.each([
    ["get_planning_playbook_context", {}],
    ["get_editing_playbook_context", {}],
    ["get_media_playbook_context", {}],
    ["get_analysis_skill_context", { skillId: "marketing-lean-canvas" }],
    ["get_author_style_context", { documentId: "ore-title-style", operation: "generate", mode: "news" }],
    ["get_metaskill_context", { topic: "overview", intent: "understand", depth: "brief" }]
  ] as Array<[string, Record<string, unknown>]>) ("delivers the complete body for %s", async (name, args) => {
    expectDelivered(await call(name, args), body);
  });

  it.each([
    ["search_author_style_evidence", { documentId: "ore-title-style", query: "synthetic" }],
    ["search_metaskill_evidence", { query: "synthetic" }],
    ["search_personal_context", { query: "marketing-lean-canvas" }]
  ] as Array<[string, Record<string, unknown>]>) ("retains full fallback/evidence text for %s", async (name, args) => {
    const result = await call(name, args);
    const text = result.content[0]?.text ?? "";
    expectDelivered(result, text);
    expect(result.structuredContent?.markdown).toContain(body);
    expect(result.structuredContent?.markdown).toContain("END_OF_CONTEXT");
  });

  it.each([
    ["editor-knowledge:kikaku-composition-playbook", "getPlanningPlaybookContext"],
    ["editor-knowledge:henshu-editing-playbook", "getEditingPlaybookContext"],
    ["editor-knowledge:knowhow-media-design", "getMediaPlaybookContext"]
  ] as const)("read_context preserves all of %s, even beyond 12k", async (id, reader) => {
    expect(body.length).toBeGreaterThan(12_000);
    // Omit maxChars to exercise the 6k default that previously cut playbooks.
    const result = await call("read_context", { id });
    expectDelivered(result, body);
    expect(result.structuredContent?.context).toMatchObject({ truncatedOutput: false, retrievalMode: "full_playbook" });
    expect(readers[reader]).toHaveBeenCalledOnce();
    expect(readers.getDocument).not.toHaveBeenCalled();
  });

  it("read_context retains intentional truncation and source flags for an ordinary document", async () => {
    const result = await call("read_context", { id: "notion:synthetic", maxChars: 500 });
    expectDelivered(result, body.slice(0, 500));
    expect(result.structuredContent?.context).toMatchObject({
      contextChars: body.length, returnedChars: 500, truncatedOutput: true, sourceTruncated: false
    });
  });

  it("read_context keeps the full analysis-skill fallback", async () => {
    expectDelivered(await call("read_context", { id: "skill-context:marketing-lean-canvas" }), body);
  });

  it.each(["editor-knowledge:synthetic#detail-1", "business-knowledge:synthetic#detail-1"])("read_context delivers semantic section %s", async (id) => {
    expectDelivered(await call("read_context", { id, maxChars: 500 }), body.slice(0, 500));
  });

  it("does not turn a missing playbook into a successful metadata-only response", async () => {
    readers.getEditingPlaybookContext.mockResolvedValue(null);
    const result = await call("get_editing_playbook_context");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
