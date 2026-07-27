import { describe, expect, it } from "vitest";
import { resolveReadContextId } from "../src/tools/readContext.js";

describe("resolveReadContextId", () => {
  it("accepts namespaced document IDs", () => {
    expect(resolveReadContextId("notion:page-1")).toEqual({
      kind: "document",
      id: "notion:page-1"
    });
    expect(resolveReadContextId("editor-knowledge:lesson-04")).toEqual({
      kind: "document",
      id: "editor-knowledge:lesson-04"
    });
  });

  it("resolves a business knowledge section", () => {
    expect(resolveReadContextId(
      "business-knowledge:startup-science#detail-18"
    )).toEqual({
      kind: "section",
      id: "business-knowledge:startup-science#detail-18",
      documentId: "startup-science",
      sectionId: "detail-18"
    });
  });

  it("resolves an editor knowledge section", () => {
    expect(resolveReadContextId(
      "editor-knowledge:kikaku-db-catalog#no-001"
    )).toEqual({
      kind: "section",
      id: "editor-knowledge:kikaku-db-catalog#no-001",
      documentId: "kikaku-db-catalog",
      sectionId: "no-001"
    });
  });

  it("resolves an exact analysis skill context", () => {
    expect(resolveReadContextId("skill-context:resolution-diagnose")).toEqual({
      kind: "skill-context",
      id: "skill-context:resolution-diagnose",
      skillId: "resolution-diagnose"
    });
  });

  it("rejects legacy, guessed, and malformed IDs", () => {
    expect(resolveReadContextId("page-1")).toBeNull();
    expect(resolveReadContextId("business-knowledge:bad#not/a-section")).toBeNull();
    expect(resolveReadContextId("editor-knowledge:bad#not/a-section")).toBeNull();
    expect(resolveReadContextId("notion:page-1#section")).toBeNull();
    expect(resolveReadContextId("skill-context:not-a-real-skill")).toBeNull();
  });
});
