import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SyncConfig } from "../src/config.js";
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
    const response = await handleNotionWebhook(
      new Request("https://sync.example/webhooks/notion", {
        method: "POST",
        body: raw,
        headers: { "X-Notion-Signature": signature }
      }),
      { SYNC_QUEUE: queue as never },
      config
    );
    expect(response.status).toBe(202);
    expect(queue.send).toHaveBeenCalledWith(expect.objectContaining({
      eventId: "event-1",
      pageId: "page-1",
      eventType: "page.properties_updated"
    }));
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
