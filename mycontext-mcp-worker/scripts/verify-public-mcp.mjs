// @ts-check

import { pathToFileURL } from "node:url";
import {
  DEFAULT_MCP_PUBLIC_ORIGIN,
  verifyPublicMcpWithRetry
} from "./public-mcp-verifier.mjs";

/** @param {string[]} args */
export function parseVerifyArguments(args) {
  const options = {
    baseUrl: process.env.MCP_PUBLIC_BASE_URL ?? DEFAULT_MCP_PUBLIC_ORIGIN,
    attempts: 3,
    requestTimeoutMs: 8_000,
    accessToken: process.env.MCP_RELEASE_ACCESS_TOKEN
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--") {
      continue;
    } else if (argument === "--base-url" && value !== undefined) {
      options.baseUrl = value;
      index += 1;
    } else if (argument === "--attempts" && value !== undefined) {
      options.attempts = Number(value);
      index += 1;
    } else if (argument === "--version-id" && value !== undefined) {
      Object.assign(options, { versionId: value });
      index += 1;
    } else if (argument === "--worker-name" && value !== undefined) {
      Object.assign(options, { workerName: value });
      index += 1;
    } else if (argument === "--request-timeout-ms" && value !== undefined) {
      options.requestTimeoutMs = Number(value);
      index += 1;
    } else if (argument === "--allow-legacy-version-header") {
      Object.assign(options, { requireVersionHeader: false });
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

/** @param {string[]=} args */
export async function main(args = process.argv.slice(2)) {
  const result = await verifyPublicMcpWithRetry(parseVerifyArguments(args));
  console.log(
    `Public MCP verification passed: ${result.checks} checks, ${result.clientOrigins.length} browser Origins, authenticated=${result.authenticated}.`
  );
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
