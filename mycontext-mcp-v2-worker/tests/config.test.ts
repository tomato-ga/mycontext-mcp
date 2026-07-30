import { describe, expect, it } from "vitest";
import { ConfigError, loadAuthConfig, loadConfig, type EnvSource } from "../src/config.js";

const completeEnv: EnvSource = {
  TIDB_DATABASE_URL: "mysql://mcp-reader.example.invalid/notion_context",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  GITHUB_ALLOWED_USER_ID: "52771764"
};

describe("loadConfig", () => {
  it("loads required configuration", () => {
    expect(loadConfig(completeEnv)).toMatchObject({
      tidbDatabaseUrl: "mysql://mcp-reader.example.invalid/notion_context"
    });
  });

  it("loads GitHub authorization configuration", () => {
    expect(loadAuthConfig(completeEnv)).toEqual({
      githubClientId: "github-client-id",
      githubClientSecret: "github-client-secret",
      githubAllowedUserId: 52771764
    });
  });

  it("throws a clear error when a required environment variable is missing", () => {
    const env = { ...completeEnv };
    delete env.TIDB_DATABASE_URL;

    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow("Missing or empty required environment variable(s): TIDB_DATABASE_URL");
  });

  it("throws a clear error when an OAuth environment variable is empty", () => {
    expect(() => loadAuthConfig({ ...completeEnv, GITHUB_CLIENT_SECRET: " " })).toThrow(
      "Missing or empty required environment variable(s): GITHUB_CLIENT_SECRET"
    );
  });

  it("rejects an invalid GitHub user ID", () => {
    expect(() => loadAuthConfig({ ...completeEnv, GITHUB_ALLOWED_USER_ID: "not-a-number" })).toThrow(
      "Missing or empty required environment variable(s): GITHUB_ALLOWED_USER_ID"
    );
  });
});
