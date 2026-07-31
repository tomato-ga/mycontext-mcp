import { describe, expect, it } from "vitest";
import { jsonResponse, withSecurityHeaders } from "../src/http.js";

describe("security headers", () => {
  it("adds baseline security headers without replacing content type", () => {
    const response = withSecurityHeaders(new Response("ok", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    }));

    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("returns JSON with baseline security headers", async () => {
    const response = jsonResponse({ error: "unauthorized" }, 401);

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });
});
