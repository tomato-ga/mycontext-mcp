import type { Env, SyncConfig } from "./config.js";
import type { SyncMessage } from "./types.js";

const RELEVANT_EVENTS = new Set<SyncMessage["eventType"]>([
  "page.properties_updated",
  "page.content_updated"
]);

export async function handleNotionWebhook(
  request: Request,
  env: Pick<Env, "SYNC_QUEUE">,
  config: SyncConfig
): Promise<Response> {
  const rawBody = await request.text();
  const payload = parseJsonRecord(rawBody);

  if (typeof payload.verification_token === "string") {
    const bootstrap = new URL(request.url).searchParams.get("bootstrap");
    if (!safeStringEqual(bootstrap ?? "", config.notionWebhookBootstrapSecret)) {
      return json({ ok: false, error: "invalid bootstrap secret" }, 401);
    }
    if (config.notionWebhookVerificationToken !== undefined) {
      return json({ ok: false, error: "webhook verification is already configured" }, 409);
    }
    console.log(JSON.stringify({
      event: "notion_webhook_verification_token_received",
      verificationToken: payload.verification_token,
      action: "store this value as NOTION_WEBHOOK_VERIFICATION_TOKEN"
    }));
    return json({ ok: true, verificationTokenReceived: true });
  }

  const verificationToken = config.notionWebhookVerificationToken;
  if (verificationToken === undefined) {
    return json({ ok: false, error: "webhook verification token is not configured" }, 503);
  }
  const signature = request.headers.get("X-Notion-Signature") ?? "";
  if (!await verifyNotionSignature(rawBody, signature, verificationToken)) {
    return json({ ok: false, error: "invalid webhook signature" }, 401);
  }

  const eventType = payload.type;
  if (typeof eventType !== "string" || !RELEVANT_EVENTS.has(eventType as SyncMessage["eventType"])) {
    return json({ ok: true, queued: false });
  }
  const entity = asRecord(payload.entity);
  const pageId = typeof entity.id === "string" ? entity.id : null;
  if (pageId === null) {
    return json({ ok: false, error: "webhook page id is missing" }, 400);
  }
  try {
    await env.SYNC_QUEUE.send({
      eventId: typeof payload.id === "string" ? payload.id : crypto.randomUUID(),
      eventType: eventType as SyncMessage["eventType"],
      pageId,
      timestamp: typeof payload.timestamp === "string" ? payload.timestamp : new Date().toISOString()
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "notion_webhook_queue_failed",
      pageId,
      error: error instanceof Error ? error.message : String(error)
    }));
    return json({ ok: false, error: "queue temporarily unavailable" }, 503);
  }
  return json({ ok: true, queued: true }, 202);
}

export async function verifyNotionSignature(
  rawBody: string,
  signature: string,
  verificationToken: string
): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(verificationToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return safeStringEqual(signature, `sha256=${toHex(new Uint8Array(digest))}`);
}

function safeStringEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    throw new Error("Webhook body must be valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
