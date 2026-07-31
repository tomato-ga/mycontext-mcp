import { describe, expect, it } from "vitest";
import { constantTimeEqual } from "../src/auth.js";

describe("constantTimeEqual", () => {
  it("accepts equal strings", () => {
    expect(constantTimeEqual("expected-token", "expected-token")).toBe(true);
  });

  it("rejects same-length unequal strings", () => {
    expect(constantTimeEqual("expected-token", "different-toke")).toBe(false);
  });

  it("rejects unequal-length tokens", () => {
    expect(constantTimeEqual("short", "shorter")).toBe(false);
  });
});
