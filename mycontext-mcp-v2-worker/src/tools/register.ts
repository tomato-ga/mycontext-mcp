import type { McpServer } from "@modelcontextprotocol/server";
import { EMPTY_PERSONAL_SYNONYM_CONFIG, type PersonalSynonymConfig } from "../searchQuery.js";
import type { TidbClient } from "../tidb.js";
import { registerGetAnalysisSkillContextTool } from "./getAnalysisSkillContext.js";
import { registerGetAuthorStyleContextTool } from "./getAuthorStyleContext.js";
import { registerGetEditingPlaybookContextTool } from "./getEditingPlaybookContext.js";
import { registerGetMediaPlaybookContextTool } from "./getMediaPlaybookContext.js";
import { registerGetMetaskillContextTool } from "./getMetaskillContext.js";
import { registerGetPlanningPlaybookContextTool } from "./getPlanningPlaybookContext.js";
import { registerReadContextTool } from "./readContext.js";
import { registerSearchAuthorStyleEvidenceTool } from "./searchAuthorStyleEvidence.js";
import { registerSearchContextTool } from "./searchContext.js";
import { registerSearchMetaskillEvidenceTool } from "./searchMetaskillEvidence.js";

export function registerPublicTools(
  server: McpServer,
  client: TidbClient,
  personalSynonyms: PersonalSynonymConfig = EMPTY_PERSONAL_SYNONYM_CONFIG
): void {
  registerSearchContextTool(server, client, personalSynonyms);
  registerReadContextTool(server, client);
  registerGetPlanningPlaybookContextTool(server, client);
  registerGetEditingPlaybookContextTool(server, client);
  registerGetMediaPlaybookContextTool(server, client);
  registerGetAnalysisSkillContextTool(server, client);
  registerGetAuthorStyleContextTool(server, client);
  registerSearchAuthorStyleEvidenceTool(server, client);
  registerGetMetaskillContextTool(server, client);
  registerSearchMetaskillEvidenceTool(server, client);
}
