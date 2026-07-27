import { describe, expect, it, vi } from "vitest";
import { NotionApiClient, parseManagedNotionDocument } from "../src/notion.js";

const pageId = "11111111-1111-1111-1111-111111111111";
const dataSourceId = "22222222-2222-2222-2222-222222222222";

describe("Notion MyContext data source", () => {
  it("parses the human-managed document properties", () => {
    expect(parseManagedNotionDocument(page(), dataSourceId)).toMatchObject({
      pageId,
      documentId: "ore-body-style",
      name: "Body style",
      category: "Author Style",
      status: "Ready",
      active: true,
      schemaVersion: "author-style-v1",
      syncSource: "Notion",
      originalPageId: "33333333-3333-3333-3333-333333333333"
    });
  });

  it("rejects a page outside the configured data source", () => {
    expect(() => parseManagedNotionDocument(page(), "another-data-source"))
      .toThrow("does not belong to the configured MyContext data source");
  });

  it.each(["AI Skill", "Metaskill"] as const)(
    "accepts the %s management category",
    (category) => {
      const value = page();
      const properties = value.properties as Record<string, unknown>;
      properties.Category = optionProperty("select", category);
      properties["Schema Version"] = optionProperty(
        "select",
        category === "AI Skill" ? "ai-skill-v1" : "metaskill-v1"
      );
      properties["Sync Source"] = optionProperty(
        "select",
        category === "AI Skill" ? "Notion" : "TiDB"
      );

      expect(parseManagedNotionDocument(value, dataSourceId)).toMatchObject({ category });
    }
  );

  it("writes workflow metadata and TiDB table routing back to Notion", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ object: "page" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const client = new NotionApiClient({
      notionApiToken: "token",
      notionDataSourceId: dataSourceId
    }, fetcher);

    await client.updateWorkflow(pageId, {
      status: "Synced",
      tidbTables: [
        "author_style_documents",
        "author_style_revisions",
        "author_style_sections"
      ],
      syncedHash: "a".repeat(64),
      activeRevision: "b".repeat(64),
      validationError: null,
      lastSyncedAt: "2026-07-22T12:00:00.000Z"
    });

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { properties: Record<string, unknown> };
    expect(body.properties).toHaveProperty("Status");
    expect(body.properties).toHaveProperty("Synced Hash");
    expect(body.properties["TiDB Tables"]).toEqual({
      multi_select: [
        { name: "author_style_documents" },
        { name: "author_style_revisions" },
        { name: "author_style_sections" }
      ]
    });
    expect(body.properties).not.toHaveProperty("Name");
    expect(body.properties).not.toHaveProperty("Document ID");
  });

  it("invokes the fetch implementation with the global receiver required by Workers", async () => {
    const receiverAwareFetcher = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("illegal receiver");
      return Promise.resolve(new Response(JSON.stringify(page()), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    }) as unknown as typeof fetch;
    const client = new NotionApiClient({
      notionApiToken: "token",
      notionDataSourceId: dataSourceId
    }, receiverAwareFetcher);

    await expect(client.getManagedDocument(pageId)).resolves.toMatchObject({ pageId });
  });
});

function page(): Record<string, unknown> {
  return {
    id: pageId,
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    last_edited_time: "2026-07-22T11:00:00.000Z",
    properties: {
      Name: textProperty("title", "Body style"),
      "Document ID": textProperty("rich_text", "ore-body-style"),
      Category: optionProperty("select", "Author Style"),
      Status: optionProperty("status", "Ready"),
      Active: { type: "checkbox", checkbox: true },
      "Schema Version": optionProperty("select", "author-style-v1"),
      "Sync Source": optionProperty("select", "Notion"),
      "Original Page ID": textProperty(
        "rich_text",
        "33333333-3333-3333-3333-333333333333"
      ),
      "Synced Hash": textProperty("rich_text", ""),
      "Active Revision": textProperty("rich_text", "")
    }
  };
}

function textProperty(type: "title" | "rich_text", value: string) {
  return {
    type,
    [type]: value.length === 0 ? [] : [{ plain_text: value }]
  };
}

function optionProperty(type: "select" | "status", value: string) {
  return { type, [type]: { name: value } };
}
