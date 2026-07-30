import { loadConfig, type Env } from "./config.js";
import { NotionApiClient } from "./notion.js";
import { processSyncMessage } from "./sync.js";
import { recordDeadLetterState } from "./stateLog.js";
import { TidbSyncRepository } from "./tidb.js";
import { SyncFailure, type SyncMessage } from "./types.js";
import { handleNotionWebhook } from "./webhook.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, service: "mycontext-sync" });
    }
    if (request.method !== "POST" || url.pathname !== "/webhooks/notion") {
      return json({ ok: false, error: "not found" }, 404);
    }
    try {
      return await handleNotionWebhook(request, env, loadConfig(env));
    } catch (error) {
      console.error(JSON.stringify({ event: "notion_webhook_failed", error: errorMessage(error) }));
      return json({ ok: false, error: "invalid webhook request" }, 400);
    }
  },

  async queue(batch: MessageBatch<SyncMessage>, env: Env): Promise<void> {
    const config = loadConfig(env);
    if (batch.queue === "mycontext-sync-dead-letter") {
      const notion = new NotionApiClient(config);
      const repository = new TidbSyncRepository(config.tidbDatabaseUrl);
      for (const message of batch.messages) {
        try {
          await notion.updateWorkflow(message.body.pageId, {
            status: "Error",
            validationError: "sync_retry_exhausted: automatic retries were exhausted; review the Worker logs before setting Ready again"
          });
          await recordDeadLetterState({
            message: message.body,
            deliveryAttempt: message.attempts,
            repository
          });
          console.error(JSON.stringify({
            event: "context_sync_dead_lettered",
            pageId: message.body.pageId,
            eventId: message.body.eventId
          }));
          message.ack();
        } catch (error) {
          console.error(JSON.stringify({
            event: "context_sync_dead_letter_update_failed",
            pageId: message.body.pageId,
            error: errorMessage(error)
          }));
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        }
      }
      return;
    }
    const dependencies = {
      notion: new NotionApiClient(config),
      repository: new TidbSyncRepository(config.tidbDatabaseUrl),
      authorStylePageIds: config.authorStylePageIds
    };
    for (const message of batch.messages) {
      try {
        const outcome = await processSyncMessage(message.body, {
          ...dependencies,
          deliveryAttempt: message.attempts
        });
        console.log(JSON.stringify({ event: "context_sync_completed", ...outcome }));
        message.ack();
      } catch (error) {
        const failure = error instanceof SyncFailure
          ? error
          : new SyncFailure("queue_sync_failed", errorMessage(error), { retryable: true });
        console.error(JSON.stringify({
          event: "context_sync_failed",
          pageId: message.body.pageId,
          code: failure.code,
          retryable: failure.retryable,
          error: failure.message
        }));
        if (failure.retryable) {
          message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
        } else {
          message.ack();
        }
      }
    }
  }
} satisfies ExportedHandler<Env, SyncMessage>;

function retryDelaySeconds(attempts: number): number {
  return Math.min(15 * 2 ** Math.max(0, attempts - 1), 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
