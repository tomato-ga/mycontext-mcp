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
  const returnedChars = typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>).returnedChars
    : undefined;
  // context_chars describes a full context pack; read_context's contextChars
  // may describe a larger source, so validate returnedChars there instead.
  const expectedChars = metadata.context_chars ?? returnedChars;
  if (
    typeof text !== "string" || text.trim().length === 0 ||
    (expectedChars !== undefined &&
      (!Number.isInteger(expectedChars) || expectedChars !== text.length))
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
