/**
 * Preserve the complete body for both MCP text consumers and adapters that
 * expose only structuredContent. Never put the body exclusively in content.
 * This is a synchronous copy of already-loaded data: no extra DB/Notion I/O.
 */
export type TextToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

export function buildTextToolResult(
  text: string,
  metadata: Record<string, unknown>
): TextToolResult {
  const nested = metadata.context;
  const context = typeof nested === "object" && nested !== null
    ? nested as Record<string, unknown>
    : undefined;
  // Validate every declared returned count, not just the first available one.
  // A larger source count is valid only when read_context reports truncation.
  const expectedCounts = [
    metadata.context_chars,
    context?.returnedChars,
    context?.truncatedOutput === false ? context.contextChars : undefined
  ];
  if (
    typeof text !== "string" || text.trim().length === 0 ||
    expectedCounts.some((count) => count !== undefined &&
      (!Number.isSafeInteger(count) || count !== text.length))
  ) {
    const message = "Context delivery failed validation: the body is empty or its character count does not match. No complete context was returned.";
    return {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: {
        error: { code: "INVALID_CONTEXT_DELIVERY", message }
      }
    };
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...metadata, markdown: text, returned_chars: text.length }
  };
}
