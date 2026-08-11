import { describe, expect, it } from "vitest";
import {
  GITHUB_CALLBACK_URL,
  MCP_RESOURCE,
  PUBLIC_ORIGIN
} from "../src/constants.js";
import {
  buildAuthorizationFormAction,
  buildGitHubAuthorizeUrl,
  escapeHtml,
  isAllowedGitHubUser,
  readCookie,
  validateRequestedScope
} from "../src/oauth.js";

describe("OAuth helpers", () => {
  it("builds a valid authorization form action with a query delimiter", () => {
    const action = buildAuthorizationFormAction({
      responseType: "code",
      clientId: "client-123",
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      scope: ["context:read"],
      state: "state-456",
      codeChallenge: "challenge-789",
      codeChallengeMethod: "S256",
      resource: MCP_RESOURCE
    });

    expect(action.startsWith("/authorize?")).toBe(true);
    const url = new URL(action, PUBLIC_ORIGIN);
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("scope")).toBe("context:read");
    expect(url.searchParams.get("resource")).toBe(MCP_RESOURCE);
  });

  it("builds a GitHub authorize URL with fixed callback and state", () => {
    const url = new URL(buildGitHubAuthorizeUrl("client-123", "state-456"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(GITHUB_CALLBACK_URL);
    expect(url.searchParams.get("scope")).toBe("read:user");
    expect(url.searchParams.get("state")).toBe("state-456");
    expect(url.searchParams.get("allow_signup")).toBe("false");
  });

  it("reads only the exact named cookie", () => {
    expect(readCookie("a=1; csrf=expected; other=2", "csrf")).toBe("expected");
    expect(readCookie("notcsrf=wrong", "csrf")).toBeNull();
    expect(readCookie(null, "csrf")).toBeNull();
  });

  it("restricts access to the configured immutable GitHub user ID", () => {
    expect(isAllowedGitHubUser(52771764, 52771764)).toBe(true);
    expect(isAllowedGitHubUser(123, 52771764)).toBe(false);
  });

  it("escapes client-controlled HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
    );
  });

  it("accepts offline access while requiring context:read", () => {
    const baseRequest = {
      responseType: "code",
      clientId: "client-123",
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      state: "state-456",
      codeChallenge: "challenge-789",
      codeChallengeMethod: "S256" as const,
      resource: MCP_RESOURCE
    };
    expect(() => validateRequestedScope({
      ...baseRequest,
      scope: ["context:read", "offline_access"]
    })).not.toThrow();
    expect(() => validateRequestedScope({
      ...baseRequest,
      scope: ["offline_access"]
    })).toThrow("Unsupported OAuth scope");
    expect(() => validateRequestedScope({
      ...baseRequest,
      scope: ["context:read", "admin"]
    })).toThrow("Unsupported OAuth scope");
  });
});
