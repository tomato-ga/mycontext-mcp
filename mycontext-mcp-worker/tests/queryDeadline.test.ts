import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withQueryDeadline } from "../src/queryDeadline.js";

describe("request-local context query deadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns rows and releases its timer", async () => {
    const execute = vi.fn().mockResolvedValue([{ id: 1 }]);
    const client = withQueryDeadline({ execute }, { timeoutMs: 100 });
    expect(await client.execute("SELECT ?", [1])).toEqual([{ id: 1 }]);
    expect(execute).toHaveBeenCalledWith("SELECT ?", [1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled query and blocks any subsequent SQL", async () => {
    const execute = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = withQueryDeadline({ execute }, { timeoutMs: 100 });
    const assertion = expect(client.execute("first")).rejects.toMatchObject({ code: "CONTEXT_QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await expect(client.execute("second")).rejects.toMatchObject({ code: "CONTEXT_QUERY_TIMEOUT" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares one budget across sequential queries rather than resetting it", async () => {
    const execute = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([]), 60)));
    const client = withQueryDeadline({ execute }, { timeoutMs: 100 });
    const first = client.execute("first");
    await vi.advanceTimersByTimeAsync(60);
    await first;
    const assertion = expect(client.execute("second")).rejects.toMatchObject({ code: "CONTEXT_QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(40);
    await assertion;
    await vi.advanceTimersByTimeAsync(20); // Late underlying completion is discarded.
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not begin SQL for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    const client = withQueryDeadline({ execute }, { signal: controller.signal });
    await expect(client.execute("never")).rejects.toMatchObject({ code: "CONTEXT_REQUEST_ABORTED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("stops waiting when the request is aborted and releases its timer", async () => {
    const controller = new AbortController();
    const execute = vi.fn().mockReturnValue(new Promise(() => {}));
    const client = withQueryDeadline({ execute }, { signal: controller.signal });
    const assertion = expect(client.execute("slow")).rejects.toMatchObject({ code: "CONTEXT_REQUEST_ABORTED" });
    await Promise.resolve();
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not poison a subsequent independent request", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const expired = withQueryDeadline({ execute }, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(expired.execute("old")).rejects.toMatchObject({ code: "CONTEXT_QUERY_TIMEOUT" });
    const fresh = withQueryDeadline({ execute }, { timeoutMs: 100 });
    await expect(fresh.execute("new")).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("propagates database errors and releases its timer", async () => {
    const failure = new Error("synthetic database error");
    const execute = vi.fn().mockRejectedValue(failure);
    await expect(withQueryDeadline({ execute }).execute("query")).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])("rejects invalid timeout %s", (timeoutMs) => {
    expect(() => withQueryDeadline({ execute: vi.fn() }, { timeoutMs })).toThrow(RangeError);
  });
});
