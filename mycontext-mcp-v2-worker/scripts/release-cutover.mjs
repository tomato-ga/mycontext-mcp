#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRIMARY_WORKER = "mycontext-mcp";
export const PRESERVED_V1_WORKER = "mycontext-mcp-v1";
export const PRIMARY_CONFIG = "./wrangler.jsonc";
export const PRESERVED_V1_CONFIG = "./wrangler.jsonc";
export const VERSION_OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";
export const EXACT_PNPM_LAUNCHER = Object.freeze([
  "exec",
  "--yes",
  "--package=pnpm@11.7.0",
  "--",
  "pnpm"
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIRECTORY = path.resolve(scriptDirectory, "..");
export const V1_DIRECTORY = path.resolve(V2_DIRECTORY, "..", "mycontext-mcp-v1-worker");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class CutoverPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "CutoverPlanError";
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new CutoverPlanError(message);
  }
}

function requireVersionId(value, label) {
  assert(uuidPattern.test(value), `${label} must be a lowercase UUID`);
  return value;
}

function requireReleaseText(value, label) {
  assert(
    typeof value === "string" &&
      value.trim() === value &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 1_000,
    `${label} must be non-empty, trimmed, and at most 1000 bytes`
  );
  return value;
}

function command(cwd, label, args) {
  return Object.freeze({
    cwd,
    label,
    command: "npm",
    args: Object.freeze([
      ...EXACT_PNPM_LAUNCHER,
      "exec",
      "wrangler",
      ...args
    ])
  });
}

export function buildPreservedV1DeployCommand({
  secretsFile,
  tag,
  message
}) {
  assert(
    typeof secretsFile === "string" && path.isAbsolute(secretsFile),
    "v1 secrets file must be an absolute path"
  );
  requireReleaseText(tag, "v1 release tag");
  requireReleaseText(message, "v1 release message");
  return command(V1_DIRECTORY, "deploy-preserved-v1", [
    "deploy",
    "--config",
    PRESERVED_V1_CONFIG,
    "--name",
    PRESERVED_V1_WORKER,
    "--strict",
    "--secrets-file",
    secretsFile,
    "--tag",
    tag,
    "--message",
    message
  ]);
}

export function buildPrimaryUploadCommand({ tag, message }) {
  requireReleaseText(tag, "v2 release tag");
  requireReleaseText(message, "v2 release message");
  return command(V2_DIRECTORY, "upload-primary-v2-version", [
    "versions",
    "upload",
    "--config",
    PRIMARY_CONFIG,
    "--name",
    PRIMARY_WORKER,
    "--strict",
    "--tag",
    tag,
    "--message",
    message
  ]);
}

export function buildZeroTrafficCommand({
  v1VersionId,
  v2VersionId,
  message,
  dryRun = false
}) {
  requireVersionId(v1VersionId, "v1 version ID");
  requireVersionId(v2VersionId, "v2 version ID");
  assert(v1VersionId !== v2VersionId, "v1 and v2 version IDs must differ");
  requireReleaseText(message, "zero-traffic deployment message");
  return command(V2_DIRECTORY, "stage-v2-at-zero-percent", [
    "versions",
    "deploy",
    `${v1VersionId}@100%`,
    `${v2VersionId}@0%`,
    "--config",
    PRIMARY_CONFIG,
    "--name",
    PRIMARY_WORKER,
    "--message",
    message,
    "--yes",
    ...(dryRun ? ["--dry-run"] : [])
  ]);
}

export function buildPromoteCommand({ v2VersionId, message }) {
  requireVersionId(v2VersionId, "v2 version ID");
  requireReleaseText(message, "promotion message");
  return command(V2_DIRECTORY, "promote-v2", [
    "versions",
    "deploy",
    `${v2VersionId}@100%`,
    "--config",
    PRIMARY_CONFIG,
    "--name",
    PRIMARY_WORKER,
    "--message",
    message,
    "--yes"
  ]);
}

export function buildRollbackCommand({ v1VersionId, message }) {
  requireVersionId(v1VersionId, "v1 version ID");
  requireReleaseText(message, "rollback message");
  return command(V2_DIRECTORY, "rollback-primary-to-v1", [
    "rollback",
    v1VersionId,
    "--config",
    PRIMARY_CONFIG,
    "--name",
    PRIMARY_WORKER,
    "--message",
    message,
    "--yes"
  ]);
}

export function versionOverrideHeader(v2VersionId) {
  requireVersionId(v2VersionId, "v2 version ID");
  return `${PRIMARY_WORKER}="${v2VersionId}"`;
}

export function assertReleaseCommandSafety(releaseCommand) {
  assert(
    releaseCommand.command === "npm",
    "release command must use the exact pnpm launcher"
  );
  assert(
    EXACT_PNPM_LAUNCHER.every(
      (argument, index) => releaseCommand.args[index] === argument
    ) &&
      releaseCommand.args[EXACT_PNPM_LAUNCHER.length] === "exec" &&
      releaseCommand.args[EXACT_PNPM_LAUNCHER.length + 1] === "wrangler",
    "release command must resolve pnpm 11.7.0 and project-local Wrangler"
  );
  const nameIndex = releaseCommand.args.indexOf("--name");
  const configIndex = releaseCommand.args.indexOf("--config");
  assert(nameIndex > 1 && configIndex > 1, "release command must name Worker and config");
  const workerName = releaseCommand.args[nameIndex + 1];
  assert(
    workerName === PRIMARY_WORKER || workerName === PRESERVED_V1_WORKER,
    "release command targets an unexpected Worker"
  );
  if (workerName === PRIMARY_WORKER) {
    assert(
      !releaseCommand.args.includes("--secrets-file"),
      "canonical v2 commands must inherit the existing production secrets"
    );
  }
  if (
    workerName === PRIMARY_WORKER &&
    releaseCommand.args[EXACT_PNPM_LAUNCHER.length + 2] === "deploy"
  ) {
    throw new CutoverPlanError(
      "canonical v2 must use version upload/deploy, never a direct Worker deploy"
    );
  }
  return true;
}

export function buildReviewedPlan({
  secretsFile,
  v1VersionId,
  v2VersionId
}) {
  const commands = [
    buildPreservedV1DeployCommand({
      secretsFile,
      tag: "mcp-v1-preserved",
      message: "Deploy preserved MCP v1 alias"
    }),
    buildPrimaryUploadCommand({
      tag: "mcp-v2-candidate",
      message: "Upload MCP SDK v2 candidate without traffic"
    }),
    buildZeroTrafficCommand({
      v1VersionId,
      v2VersionId,
      message: "Stage MCP SDK v2 at zero percent",
      dryRun: true
    }),
    buildZeroTrafficCommand({
      v1VersionId,
      v2VersionId,
      message: "Stage MCP SDK v2 at zero percent"
    }),
    buildPromoteCommand({
      v2VersionId,
      message: "Promote MCP SDK v2"
    }),
    buildRollbackCommand({
      v1VersionId,
      message: "Rollback MCP SDK v2 cutover"
    })
  ];
  for (const releaseCommand of commands) {
    assertReleaseCommandSafety(releaseCommand);
  }
  return Object.freeze({
    topology: Object.freeze({
      primary: PRIMARY_WORKER,
      preservedV1: PRESERVED_V1_WORKER
    }),
    overrideHeader: Object.freeze({
      name: VERSION_OVERRIDE_HEADER,
      value: versionOverrideHeader(v2VersionId)
    }),
    commands: Object.freeze(commands)
  });
}

function printableCommand(releaseCommand) {
  return [
    `cd ${JSON.stringify(releaseCommand.cwd)}`,
    [releaseCommand.command, ...releaseCommand.args]
      .map((part) => JSON.stringify(part))
      .join(" ")
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "plan") {
    console.error("Usage: node scripts/release-cutover.mjs plan");
    process.exitCode = 2;
  } else {
    const exampleV1 = "11111111-1111-4111-8111-111111111111";
    const exampleV2 = "22222222-2222-4222-8222-222222222222";
    const plan = buildReviewedPlan({
      secretsFile: "/private/mycontext-mcp-v1-secrets.json",
      v1VersionId: exampleV1,
      v2VersionId: exampleV2
    });
    console.log("MCP cutover plan passed static safety validation.");
    console.log(
      `Override: ${plan.overrideHeader.name}: ${plan.overrideHeader.value}`
    );
    for (const releaseCommand of plan.commands) {
      console.log(`\n[${releaseCommand.label}]\n${printableCommand(releaseCommand)}`);
    }
  }
}
