/** A request-local, shared wall-clock budget, not a Workers CPU limit. */
export const CONTEXT_QUERY_BUDGET_MS = 8_000;

interface QueryClient {
  execute(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

export class ContextQueryDeadlineError extends Error {
  constructor(public readonly code: "CONTEXT_QUERY_TIMEOUT" | "CONTEXT_REQUEST_ABORTED") {
    super(code === "CONTEXT_QUERY_TIMEOUT"
      ? "Context database retrieval exceeded its request deadline. No complete result was returned; retry the request."
      : "Context request was cancelled. No complete result was returned.");
    this.name = "ContextQueryDeadlineError";
  }
}

/**
 * The TiDB adapter does not expose AbortSignal. This bounds the caller's wait
 * and stops subsequent queries, but cannot physically cancel an in-flight
 * SDK query. Its eventual resolution/rejection is consumed by Promise.race.
 * Do not share this wrapper across requests or cache it globally.
 */
export function withQueryDeadline(
  client: QueryClient,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): QueryClient {
  const timeoutMs = options.timeoutMs ?? CONTEXT_QUERY_BUDGET_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be a positive, safe timer duration");
  }
  const deadline = Date.now() + timeoutMs;
  const signal = options.signal;
  let stopped: ContextQueryDeadlineError | undefined;

  function stop(code: ContextQueryDeadlineError["code"]): ContextQueryDeadlineError {
    stopped ??= new ContextQueryDeadlineError(code);
    return stopped;
  }

  function ensureActive(): void {
    if (signal?.aborted) stop("CONTEXT_REQUEST_ABORTED");
    if (Date.now() >= deadline) stop("CONTEXT_QUERY_TIMEOUT");
    if (stopped !== undefined) throw stopped;
  }

  return {
    async execute(sql, params = []) {
      ensureActive();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(stop("CONTEXT_QUERY_TIMEOUT")), deadline - Date.now());
        onAbort = () => reject(stop("CONTEXT_REQUEST_ABORTED"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      try {
        const rows = await Promise.race([
          Promise.resolve().then(() => {
            ensureActive();
            return client.execute(sql, params);
          }),
          interrupted
        ]);
        ensureActive();
        return rows;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      }
    }
  };
}
