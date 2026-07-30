import { z } from "zod";

export interface Env {
  TIDB_DATABASE_URL: string;
  NOTION_API_TOKEN: string;
  NOTION_DATA_SOURCE_ID: string;
  NOTION_WEBHOOK_BOOTSTRAP_SECRET: string;
  NOTION_WEBHOOK_VERIFICATION_TOKEN?: string;
  AUTHOR_STYLE_TITLE_PAGE_ID: string;
  AUTHOR_STYLE_BODY_PAGE_ID: string;
  SYNC_QUEUE: Queue<import("./types.js").SyncMessage>;
}

export interface AuthorStylePageIds {
  "ore-title-style": string;
  "ore-body-style": string;
}

export interface SyncConfig {
  tidbDatabaseUrl: string;
  notionApiToken: string;
  notionDataSourceId: string;
  notionWebhookBootstrapSecret: string;
  notionWebhookVerificationToken?: string;
  authorStylePageIds: AuthorStylePageIds;
}

const required = z.string().trim().min(1);

const schema = z.object({
  TIDB_DATABASE_URL: required,
  NOTION_API_TOKEN: required,
  NOTION_DATA_SOURCE_ID: required,
  NOTION_WEBHOOK_BOOTSTRAP_SECRET: required,
  NOTION_WEBHOOK_VERIFICATION_TOKEN: required.optional(),
  AUTHOR_STYLE_TITLE_PAGE_ID: required,
  AUTHOR_STYLE_BODY_PAGE_ID: required
});

export function loadConfig(env: Env): SyncConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))].sort();
    throw new Error(`Missing or invalid environment variable(s): ${names.join(", ")}`);
  }
  return {
    tidbDatabaseUrl: parsed.data.TIDB_DATABASE_URL,
    notionApiToken: parsed.data.NOTION_API_TOKEN,
    notionDataSourceId: parsed.data.NOTION_DATA_SOURCE_ID,
    notionWebhookBootstrapSecret: parsed.data.NOTION_WEBHOOK_BOOTSTRAP_SECRET,
    authorStylePageIds: {
      "ore-title-style": parsed.data.AUTHOR_STYLE_TITLE_PAGE_ID,
      "ore-body-style": parsed.data.AUTHOR_STYLE_BODY_PAGE_ID
    },
    ...(parsed.data.NOTION_WEBHOOK_VERIFICATION_TOKEN === undefined
      ? {}
      : { notionWebhookVerificationToken: parsed.data.NOTION_WEBHOOK_VERIFICATION_TOKEN })
  };
}
