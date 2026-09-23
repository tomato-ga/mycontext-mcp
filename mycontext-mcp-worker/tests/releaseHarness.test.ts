import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  activeVersionId,
  runGuardedRelease
} from "../scripts/release-harness.mjs";

describe("guarded MCP release", () => {
  it("makes the package deploy command use the guarded release path", () => {
    const packageJson = JSON.parse(readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8"
    )) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.deploy).toBe("node ./scripts/release.mjs");
    expect(packageJson.scripts?.["verify:public-mcp"])
      .toBe("node ./scripts/verify-public-mcp.mjs");
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      if (name !== "deploy:dry-run") {
        expect(command, `script ${name} bypasses the release harness`)
          .not.toMatch(/\bwrangler deploy\b/);
      }
    }
    const releaseSource = readFileSync(
      new URL("../scripts/release.mjs", import.meta.url),
      "utf8"
    );
    expect(releaseSource).not.toContain("MCP_PUBLIC_BASE_URL");
    expect(releaseSource).toContain("baseUrl: DEFAULT_MCP_PUBLIC_ORIGIN");
  });

  it("completes only after the deployed public endpoint is verified", async () => {
    const events: string[] = [];
    const result = await runGuardedRelease({
      preflight: async () => { events.push("preflight"); },
      getActiveVersion: async () => "old-version",
      deploy: async () => { events.push("deploy"); },
      waitForNewVersion: async (previous) => {
        events.push(`wait-new:${previous}`);
        return "new-version";
      },
      verifyPublic: async (version) => { events.push(`verify-public:${version}`); },
      rollback: async () => { events.push("rollback"); },
      waitForVersion: async () => { events.push("wait-rollback"); }
    });

    expect(result).toEqual({
      previousVersion: "old-version",
      deployedVersion: "new-version",
      rolledBack: false
    });
    expect(events).toEqual([
      "preflight",
      "deploy",
      "wait-new:old-version",
      "verify-public:new-version",
      "wait-rollback"
    ]);
  });

  it("rolls back and re-verifies production when the public contract fails", async () => {
    const events: string[] = [];
    let verification = 0;

    await expect(runGuardedRelease({
      preflight: async () => { events.push("preflight"); },
      getActiveVersion: async () => "old-version",
      deploy: async () => { events.push("deploy"); },
      waitForNewVersion: async () => "bad-version",
      verifyPublic: async (version) => {
        verification += 1;
        events.push(`verify:${verification}:${version}`);
        if (verification === 1) {
          throw new Error("ChatGPT Origin received 403");
        }
      },
      verifyRollbackPublic: async (version) => {
        verification += 1;
        events.push(`verify:${verification}:${version}`);
      },
      rollback: async (version) => { events.push(`rollback:${version}`); },
      waitForVersion: async (version) => { events.push(`wait:${version}`); }
    })).rejects.toThrow("production was rolled back to old-version");

    expect(events).toEqual([
      "preflight",
      "deploy",
      "verify:1:bad-version",
      "rollback:old-version",
      "wait:old-version",
      "verify:2:old-version",
      "wait:old-version"
    ]);
  });

  it("does not deploy when a local gate fails", async () => {
    const deploy = vi.fn();
    await expect(runGuardedRelease({
      preflight: async () => { throw new Error("unit regression"); },
      getActiveVersion: async () => "old-version",
      deploy,
      waitForNewVersion: async () => "new-version",
      verifyPublic: async () => {},
      rollback: async () => {},
      waitForVersion: async () => {}
    })).rejects.toThrow("unit regression");
    expect(deploy).not.toHaveBeenCalled();
  });

  it("does not rollback when Wrangler fails before production changes", async () => {
    const rollback = vi.fn();
    await expect(runGuardedRelease({
      preflight: async () => {},
      getActiveVersion: async () => "old-version",
      deploy: async () => { throw new Error("network failed before upload"); },
      waitForNewVersion: async () => { throw new Error("no new version"); },
      verifyPublic: async () => {},
      rollback,
      waitForVersion: async () => {}
    })).rejects.toThrow("network failed before upload");
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back when Wrangler errors after production changed", async () => {
    const events: string[] = [];
    let activeRead = 0;
    await expect(runGuardedRelease({
      preflight: async () => {},
      getActiveVersion: async () => {
        activeRead += 1;
        return activeRead === 1 ? "old-version" : "new-version";
      },
      deploy: async () => { throw new Error("connection closed after deploy"); },
      waitForNewVersion: async () => "new-version",
      verifyPublic: async (version) => { events.push(`verify:${version}`); },
      verifyRollbackPublic: async (version) => { events.push(`verify:${version}`); },
      rollback: async (version) => { events.push(`rollback:${version}`); },
      waitForVersion: async (version) => { events.push(`wait:${version}`); }
    })).rejects.toThrow("production was rolled back to old-version");
    expect(events).toEqual([
      "verify:new-version",
      "wait:new-version",
      "rollback:old-version",
      "wait:old-version",
      "verify:old-version",
      "wait:old-version"
    ]);
  });

  it("rolls back conservatively when deploy and active-status reads both fail", async () => {
    const events: string[] = [];
    let activeRead = 0;
    await expect(runGuardedRelease({
      preflight: async () => {},
      getActiveVersion: async () => {
        activeRead += 1;
        if (activeRead === 1) {
          return "old-version";
        }
        throw new Error("Cloudflare status unavailable");
      },
      deploy: async () => { throw new Error("connection closed after deploy"); },
      waitForNewVersion: async () => { throw new Error("new version not observable"); },
      verifyPublic: async () => {},
      verifyRollbackPublic: async (version) => { events.push(`verify:${version}`); },
      rollback: async (version) => { events.push(`rollback:${version}`); },
      waitForVersion: async (version) => { events.push(`wait:${version}`); }
    })).rejects.toThrow("production was rolled back to old-version");
    expect(events).toEqual([
      "rollback:old-version",
      "wait:old-version",
      "verify:old-version",
      "wait:old-version"
    ]);
  });

  it("refuses to guess a rollback target from split or partial traffic", () => {
    expect(activeVersionId({
      versions: [{ version_id: "one", percentage: 100 }]
    })).toBe("one");
    expect(() => activeVersionId({
      versions: [
        { version_id: "one", percentage: 50 },
        { version_id: "two", percentage: 50 }
      ]
    })).toThrow("exactly one active Worker version");
    expect(() => activeVersionId({
      versions: [{ version_id: "one", percentage: 99 }]
    })).toThrow("100% traffic");
  });
});
