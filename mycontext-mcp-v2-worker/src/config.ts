import { z } from "zod";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { parsePersonalSynonymConfig, type PersonalSynonymConfig } from "./searchQuery.js";

export interface Env {
  TIDB_DATABASE_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_ALLOWED_USER_ID: string;
  // Optional. A JSON-encoded PersonalSynonymConfig (see searchQuery.ts). Set as a Wrangler
  // secret, never as a `vars` entry in wrangler.jsonc (which is committed). When unset, search
  // performs no personal synonym expansion — this is a safe, fully-functional default.
  PERSONAL_SYNONYMS?: string;
  OAUTH_KV: KVNamespace;
  AUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface AppConfig {
  tidbDatabaseUrl: string;
  personalSynonyms: PersonalSynonymConfig;
}

export interface AuthConfig {
  githubClientId: string;
  githubClientSecret: string;
  githubAllowedUserId: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type EnvStringKey =
  | "TIDB_DATABASE_URL"
  | "GITHUB_CLIENT_ID"
  | "GITHUB_CLIENT_SECRET"
  | "GITHUB_ALLOWED_USER_ID"
  | "PERSONAL_SYNONYMS";

export type EnvSource = Partial<Record<EnvStringKey, string>>;

const nonEmptyString = z.string().trim().min(1);

const appEnvSchema = z.object({
  TIDB_DATABASE_URL: nonEmptyString
});

const authEnvSchema = z.object({
  GITHUB_CLIENT_ID: nonEmptyString,
  GITHUB_CLIENT_SECRET: nonEmptyString,
  GITHUB_ALLOWED_USER_ID: z.coerce.number().int().positive()
});

export function loadConfig(env: EnvSource): AppConfig {
  const values = validateEnv(appEnvSchema, env);

  return {
    tidbDatabaseUrl: values.TIDB_DATABASE_URL,
    // Optional and validated leniently on its own: a missing or malformed PERSONAL_SYNONYMS
    // secret must never prevent the worker from starting, it should just disable synonym
    // expansion.
    personalSynonyms: parsePersonalSynonymConfig(env.PERSONAL_SYNONYMS)
  };
}

export function loadAuthConfig(env: EnvSource): AuthConfig {
  const values = validateEnv(authEnvSchema, env);

  return {
    githubClientId: values.GITHUB_CLIENT_ID,
    githubClientSecret: values.GITHUB_CLIENT_SECRET,
    githubAllowedUserId: values.GITHUB_ALLOWED_USER_ID
  };
}

function validateEnv<T extends z.ZodType>(schema: T, env: EnvSource): z.infer<T> {
  const parsed = schema.safeParse(env);
  if (parsed.success) {
    return parsed.data;
  }

  const missingKeys = Array.from(
    new Set(
      parsed.error.issues
        .map((issue) => issue.path[0])
        .filter((key): key is EnvStringKey => typeof key === "string")
    )
  ).sort();

  throw new ConfigError(`Missing or empty required environment variable(s): ${missingKeys.join(", ")}`);
}
