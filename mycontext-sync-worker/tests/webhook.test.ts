import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Env, SyncConfig } from "../src/config.js";
import worker from "../src/index.js";
import { handleNotionWebhook } from "../src/webhook.js";

const config: SyncConfig = {
  tidbDatabaseUrl: "mysql://example.invalid/db",
  notionApiToken: "token",
  notionDataSourceId: "data-source",
  notionWebhookBootstrapSecret: "bootstrap",
  notionWebhookVerificationToken: "verification-token",
  authorStylePageIds: {
    "ore-title-style": "title-page",
    "ore-body-style": "body-page"
  }
};

describe("Notion webhook", () => {
  it("accepts the one-time verification request only with the bootstrap secret", async () => {
    const queue = { send: vi.fn() };
    const response = await handleNotionWebhook(
      new Request("https://sync.example/webhooks/notion?bootstrap=bootstrap", {
        method: "POST",
        body: JSON.stringify({ verification_token: "received-token" })
      }),
      { SYNC_QUEUE: queue as never },
      { ...config, notionWebhookVerificationToken: undefined }
    );
    expect(response.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("verifies the HMAC signature and queues relevant page events", async () => {
    const raw = JSON.stringify({
      id: "event-1",
      timestamp: "2026-07-22T12:00:00.000Z",
      type: "page.properties_updated",
      entity: { type: "page", id: "page-1" }
    });
    const signature = `sha256=${createHmac("sha256", "verification-token").update(raw).digest("hex")}`;
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const response = await worker.fetch(
      new Request("https://sync.example/webhooks/notion", {
        method: "POST",
        body: raw,
        headers: { "X-Notion-Signature": signature }
      }),
      {
        TIDB_DATABASE_URL: config.tidbDatabaseUrl,
        NOTION_API_TOKEN: config.notionApiToken,
        NOTION_DATA_SOURCE_ID: config.notionDataSourceId,
        NOTION_WEBHOOK_BOOTSTRAP_SECRET: config.notionWebhookBootstrapSecret,
        NOTION_WEBHOOK_VERIFICATION_TOKEN: config.notionWebhookVerificationToken,
        AUTHOR_STYLE_TITLE_PAGE_ID: config.authorStylePageIds["ore-title-style"],
        AUTHOR_STYLE_BODY_PAGE_ID: config.authorStylePageIds["ore-body-style"],
        SYNC_QUEUE: queue as never
      } satisfies Env
    );
    expect(response.status).toBe(202);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1",
      pageId: "page-1",
      eventType: "page.properties_updated"
    }));
  });

  it("returns a temporary failure when queue publishing fails so the webhook can be retried", async () => {
    const raw = JSON.stringify({
      id: "event-queue-failure",
      timestamp: "2026-07-22T12:00:00.000Z",
      type: "page.properties_updated",
      entity: { type: "page", id: "page-1" }
    });
    const signature = `sha256=${createHmac("sha256", "verification-token").update(raw).digest("hex")}`;
    const queue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
    const response = await worker.fetch(
      new Request("https://sync.example/webhooks/notion", {
        method: "POST",
        body: raw,
        headers: { "X-Notion-Signature": signature }
      }),
      {
        TIDB_DATABASE_URL: config.tidbDatabaseUrl,
        NOTION_API_TOKEN: config.notionApiToken,
        NOTION_DATA_SOURCE_ID: config.notionDataSourceId,
        NOTION_WEBHOOK_BOOTSTRAP_SECRET: config.notionWebhookBootstrapSecret,
        NOTION_WEBHOOK_VERIFICATION_TOKEN: config.notionWebhookVerificationToken,
        AUTHOR_STYLE_TITLE_PAGE_ID: config.authorStylePageIds["ore-title-style"],
        AUTHOR_STYLE_BODY_PAGE_ID: config.authorStylePageIds["ore-body-style"],
        SYNC_QUEUE: queue as never
      } satisfies Env
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "queue temporarily unavailable" });
  });

  it("acknowledges irrelevant signed events without queueing", async () => {
    const raw = JSON.stringify({ type: "page.unlocked", entity: { id: "page-1" } });
    const signature = `sha256=${createHmac("sha256", "verification-token").update(raw).digest("hex")}`;
    const queue = { send: vi.fn() };
    const response = await handleNotionWebhook(
      new Request("https://sync.example/webhooks/notion", {
        method: "POST",
        body: raw,
        headers: { "X-Notion-Signature": signature }
      }),
      { SYNC_QUEUE: queue as never },
      config
    );
    expect(response.status).toBe(200);
    expect(queue.send).not.toHaveBeenCalled();
  });
});
