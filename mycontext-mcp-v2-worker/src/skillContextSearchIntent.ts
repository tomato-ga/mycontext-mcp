import {
  SKILL_CONTEXT_IDS,
  type SkillContextId
} from "./skillContext.js";
import { normalizeSearchText } from "./searchQuery.js";

export interface SkillContextSearchIntent {
  skillId: SkillContextId;
  documentId: `skill-context:${SkillContextId}`;
  resourceUri: `mycontext://skill-context/${SkillContextId}`;
}

/**
 * Resolves one explicit analysis-skill ID through the long-lived search tool.
 *
 * ChatGPT Web can retain an older MCP tools/list response after a new dedicated tool is
 * deployed. Exact IDs therefore remain callable through search_personal_context without
 * depending on a refreshed tool catalogue. Queries mentioning multiple IDs intentionally fall
 * back to generic search so one result is never guessed from an ambiguous batch request.
 */
export function resolveSkillContextSearchIntent(
  query: string
): SkillContextSearchIntent | null {
  const normalizedQuery = normalizeSearchText(query).toLocaleLowerCase("ja");
  const matches = SKILL_CONTEXT_IDS.filter((skillId) =>
    normalizedQuery.includes(skillId)
  );
  if (matches.length !== 1) {
    return null;
  }
  const skillId = matches[0];
  return {
    skillId,
    documentId: `skill-context:${skillId}`,
    resourceUri: `mycontext://skill-context/${skillId}`
  };
}
