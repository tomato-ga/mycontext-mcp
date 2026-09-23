// @ts-check

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runGuardedRelease, activeVersionId } from "./release-harness.mjs";
import {
  DEFAULT_MCP_PUBLIC_ORIGIN,
  verifyPublicMcpWithRetry
} from "./public-mcp-verifier.mjs";

const WORKER_NAME = "mycontext-mcp";
const WRANGLER_CONFIG = "./wrangler.jsonc";

/** @typedef {{ stdout: string }} CommandResult */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ captureStdout?: boolean }=} options
 * @returns {Promise<CommandResult>}
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const captureStdout = options.captureStdout === true;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", captureStdout ? "pipe" : "inherit", "inherit"]
    });
    let stdout = "";
    if (captureStdout) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout });
        return;
      }
      reject(new Error(
        `${command} ${args.join(" ")} failed${signal === null ? ` with exit code ${code}` : ` from signal ${signal}`}`
      ));
    });
  });
}

/** @param {string[]} args @param {{ captureStdout?: boolean }=} options */
function pnpm(args, options) {
  return runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, options);
}

async function preflight() {
  console.log("Release gate: public-safety");
  await runCommand("bash", ["../scripts/check-public-safety.sh"]);
  console.log("Release gate: typecheck");
  await pnpm(["run", "typecheck"]);
  console.log("Release gate: unit and integration tests");
  await pnpm(["test"]);
  console.log("Release gate: Wrangler dry-run");
  await pnpm(["run", "deploy:dry-run"]);
}

async function getActiveVersion() {
  const result = await pnpm([
    "exec",
    "wrangler",
    "deployments",
    "status",
    "--config",
    WRANGLER_CONFIG,
    "--name",
    WORKER_NAME,
    "--json"
  ], { captureStdout: true });
  /** @type {unknown} */
  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler deployment status did not return valid JSON");
  }
  return activeVersionId(status);
}

/**
 * @param {(version: string) => boolean} predicate
 * @param {string} expectation
 */
async function waitForActiveVersion(predicate, expectation) {
  /** @type {unknown} */
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const version = await getActiveVersion();
      if (predicate(version)) {
        return version;
      }
      lastError = new Error(`Active version ${version} does not satisfy ${expectation}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 8) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function deploy() {
  await pnpm([
    "exec",
    "wrangler",
    "deploy",
    "--strict",
    "--config",
    WRANGLER_CONFIG,
    "--name",
    WORKER_NAME
  ]);
}

/** @param {string} version */
async function verifyPublic(version) {
  const result = await verifyPublicMcpWithRetry({
    baseUrl: DEFAULT_MCP_PUBLIC_ORIGIN,
    accessToken: process.env.MCP_RELEASE_ACCESS_TOKEN,
    versionId: version,
    workerName: WORKER_NAME,
    attempts: 3,
    retryDelayMs: 1_000,
    requestTimeoutMs: 8_000
  });
  console.log(
    `Public MCP gate passed: ${result.checks} checks, authenticated=${result.authenticated}.`
  );
}

/**
 * The version metadata header was introduced with this release harness. The
 * immediately previous production version may predate it, so rollback still
 * pins requests to that version and verifies every public contract except the
 * self-reported version header. Active deployment status is checked before and
 * after by runGuardedRelease.
 *
 * @param {string} version
 */
async function verifyRollbackPublic(version) {
  const result = await verifyPublicMcpWithRetry({
    baseUrl: DEFAULT_MCP_PUBLIC_ORIGIN,
    accessToken: process.env.MCP_RELEASE_ACCESS_TOKEN,
    versionId: version,
    workerName: WORKER_NAME,
    requireVersionHeader: false,
    attempts: 3,
    retryDelayMs: 1_000,
    requestTimeoutMs: 8_000
  });
  console.log(
    `Rollback public MCP gate passed: ${result.checks} checks, active version confirmed separately.`
  );
}

/** @param {string} version */
async function rollback(version) {
  await pnpm([
    "exec",
    "wrangler",
    "rollback",
    version,
    "--name",
    WORKER_NAME,
    "--yes",
    "--message",
    "Automatic rollback: public MCP release verification failed"
  ]);
}

/** @param {string[]=} args */
export async function main(args = process.argv.slice(2)) {
  const unknownArguments = args.filter((argument) => argument !== "--preflight-only");
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments[0]}`);
  }
  if (args.includes("--preflight-only")) {
    await preflight();
    console.log("Release preflight passed. No deployment was performed.");
    return;
  }

  const result = await runGuardedRelease({
    preflight,
    getActiveVersion,
    deploy,
    waitForNewVersion: (previousVersion) => waitForActiveVersion(
      (version) => version !== previousVersion,
      `a version different from ${previousVersion}`
    ),
    verifyPublic,
    verifyRollbackPublic,
    rollback,
    waitForVersion: (expectedVersion) => waitForActiveVersion(
      (version) => version === expectedVersion,
      `version ${expectedVersion}`
    ),
    log: console.log
  });

  console.log(`SERVER_RELEASE_VERIFIED ${result.deployedVersion}`);
  console.log(
    "If OAuth metadata, MCP SDK/protocol, Origin/CORS, or tool schemas changed, reconnect the ChatGPT Web app and complete one real tool call before marking CHATGPT_WEB_VERIFIED."
  );
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
