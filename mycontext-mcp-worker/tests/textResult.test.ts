import { describe, expect, it } from "vitest";
import { buildTextToolResult } from "../src/tools/textResult.js";

describe("lossless context delivery", () => {
  it.each([500, 6_456, 9_759, 12_274, 24_000])("preserves a %i-character body through either MCP projection", (length) => {
    const prefix = "# Synthetic fixture 😀\n";
    const suffix = "\nEND!";
    const text = prefix + "本文\n".repeat(length).slice(0, length - prefix.length - suffix.length) + suffix;
    expect(text.length).toBe(length);
    const result = buildTextToolResult(text, { context_chars: text.length, truncated: false });
    const wire = JSON.parse(JSON.stringify(result));
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent.markdown).toBe(text);
    expect(wire.content).toEqual([{ type: "text", text }]);
    expect(wire.structuredContent.returned_chars).toBe(text.length);
    expect(wire.structuredContent.markdown.endsWith("\nEND!")).toBe(true);
  });

  it.each(["", " \n\t"])("rejects an empty body instead of claiming success", (text) => {
    const result = buildTextToolResult(text, { truncated: false });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).not.toHaveProperty("truncated");
    expect(result.structuredContent).not.toHaveProperty("markdown");
  });

  it("rejects inconsistent full-context character counts", () => {
    expect(buildTextToolResult("partial", { context_chars: 100, truncated: false }).isError).toBe(true);
  });

  it("checks returnedChars without confusing source length with intentional truncation", () => {
    const metadata = { context: { contextChars: 100, returnedChars: 7, truncatedOutput: true } };
    const result = buildTextToolResult("partial", metadata);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent.context).toEqual(metadata.context);
    expect(buildTextToolResult("partial", { context: { returnedChars: 100 } }).isError).toBe(true);
  });

  it("does not modify the caller's metadata", () => {
    const metadata = { document_id: "synthetic", revision_sha256: "synthetic-revision" };
    const result = buildTextToolResult("body", metadata);
    expect(metadata).not.toHaveProperty("markdown");
    expect(result.structuredContent).toMatchObject(metadata);
  });
});
