import { describe, expect, it } from "vitest";

import {
  CutoverPlanError,
  EXACT_PNPM_LAUNCHER,
  PRIMARY_WORKER,
  PRESERVED_V1_WORKER,
  assertReleaseCommandSafety,
  buildPreservedV1DeployCommand,
  buildPrimaryUploadCommand,
  buildPromoteCommand,
  buildRollbackCommand,
  buildZeroTrafficCommand,
  versionOverrideHeader
} from "../scripts/release-cutover.mjs";

const v1VersionId = "11111111-1111-4111-8111-111111111111";
const v2VersionId = "22222222-2222-4222-8222-222222222222";

describe("MCP in-place cutover commands", () => {
  it("deploys the preserved v1 alias with a complete private secrets file", () => {
    const command = buildPreservedV1DeployCommand({
      secretsFile: "/private/v1.json",
      tag: "v1-alias",
      message: "Deploy v1 alias"
    });
    expect(command.args).toContain(PRESERVED_V1_WORKER);
    expect(command.command).toBe("npm");
    expect(command.args.slice(0, EXACT_PNPM_LAUNCHER.length)).toEqual(
      EXACT_PNPM_LAUNCHER
    );
    expect(command.args).toContain("--secrets-file");
    expect(command.args).toContain("/private/v1.json");
    expect(assertReleaseCommandSafety(command)).toBe(true);
  });

  it("uploads canonical v2 without replacing inherited production secrets", () => {
    const command = buildPrimaryUploadCommand({
      tag: "v2-candidate",
      message: "Upload v2 candidate"
    });
    expect(
      command.args.slice(
        EXACT_PNPM_LAUNCHER.length + 2,
        EXACT_PNPM_LAUNCHER.length + 4
      )
    ).toEqual(["versions", "upload"]);
    expect(command.args).toContain(PRIMARY_WORKER);
    expect(command.args).not.toContain("--secrets-file");
    expect(assertReleaseCommandSafety(command)).toBe(true);
  });

  it("stages immutable v2 at zero public traffic", () => {
    const command = buildZeroTrafficCommand({
      v1VersionId,
      v2VersionId,
      message: "Zero traffic smoke"
    });
    expect(command.args).toContain(`${v1VersionId}@100%`);
    expect(command.args).toContain(`${v2VersionId}@0%`);
    expect(command.args).toContain(PRIMARY_WORKER);
    expect(assertReleaseCommandSafety(command)).toBe(true);
  });

  it("promotes v2 and retains an exact old-version rollback", () => {
    const promote = buildPromoteCommand({
      v2VersionId,
      message: "Promote v2"
    });
    const rollback = buildRollbackCommand({
      v1VersionId,
      message: "Rollback v2"
    });
    expect(promote.args).toContain(`${v2VersionId}@100%`);
    expect(
      rollback.args.slice(
        EXACT_PNPM_LAUNCHER.length + 2,
        EXACT_PNPM_LAUNCHER.length + 4
      )
    ).toEqual(["rollback", v1VersionId]);
    expect(assertReleaseCommandSafety(promote)).toBe(true);
    expect(assertReleaseCommandSafety(rollback)).toBe(true);
  });

  it("formats the quoted Cloudflare version override dictionary", () => {
    expect(versionOverrideHeader(v2VersionId)).toBe(
      `${PRIMARY_WORKER}="${v2VersionId}"`
    );
  });

  it("rejects ambiguous IDs, relative secret paths, and direct primary deploys", () => {
    expect(() => buildZeroTrafficCommand({
      v1VersionId: "latest",
      v2VersionId,
      message: "bad"
    })).toThrow(CutoverPlanError);
    expect(() => buildPreservedV1DeployCommand({
      secretsFile: "./v1.json",
      tag: "v1",
      message: "bad"
    })).toThrow(CutoverPlanError);
    expect(() => assertReleaseCommandSafety({
      command: "npm",
      args: [
        ...EXACT_PNPM_LAUNCHER,
        "exec",
        "wrangler",
        "deploy",
        "--config",
        "./wrangler.jsonc",
        "--name",
        PRIMARY_WORKER
      ]
    })).toThrow(/never a direct Worker deploy/);
  });
});
