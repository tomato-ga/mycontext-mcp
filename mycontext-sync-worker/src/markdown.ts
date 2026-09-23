interface Fence {
  character: "`" | "~";
  length: number;
  trailing: string;
}

/**
 * Returns whether Markdown contains an H1 outside a fenced code block.
 *
 * The sync parsers use H1 as a document title, while Notion bodies may contain
 * code examples that look like headings. Fence closure follows the Markdown
 * rule that the closing marker uses the same character, is at least as long as
 * the opener, and has only whitespace after it.
 */
export function hasNonFencedH1(markdown: string): boolean {
  let fence: Fence | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const candidate = parseFence(line);
    if (fence !== null) {
      if (candidate !== null
        && candidate.character === fence.character
        && candidate.length >= fence.length
        && /^[ \t]*$/.test(candidate.trailing)) {
        fence = null;
      }
      continue;
    }
    if (candidate !== null) {
      fence = candidate;
      continue;
    }
    if (/^#(?!#)\s+\S/.test(line)) return true;
  }
  return false;
}

function parseFence(line: string): Fence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (match === null || match[2] === undefined) return null;
  const character = match[2][0] as "`" | "~";
  const trailing = match[3] ?? "";
  // Backticks are not valid in a backtick fence's info string. Treating this
  // as ordinary content also prevents it from becoming a false close marker.
  if (character === "`" && trailing.includes("`")) return null;
  return { character, length: match[2].length, trailing };
}
