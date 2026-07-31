#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  lstat,
  open,
  rename,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXACT_PNPM_LAUNCHER,
  PRIMARY_WORKER,
  PRESERVED_V1_WORKER,
  VERSION_OVERRIDE_HEADER,
  buildPreservedV1DeployCommand,
  buildPrimaryUploadCommand,
  buildPromoteCommand,
  buildRollbackCommand,
  buildZeroTrafficCommand,
  versionOverrideHeader
} from "./release-cutover.mjs";

export const CUTOVER_MANIFEST_SCHEMA_VERSION = 1;
export const EXPECTED_ACCOUNT_ID = "1f7287ca0dc182ac70db5e77dcd5f3ce";
export const EXPECTED_PNPM_VERSION = "11.7.0";
export const EXPECTED_WRANGLER_VERSION = "4.107.0";
export const EXPECTED_BRANCH = "main";
export const EXPECTED_ORIGIN_URL =
  "https://github.com/tomato-ga/mycontext-mcp.git";
export const EXPECTED_CRON = "17 4 * * *";
export const EXPECTED_FROZEN_V1_TREE =
  "33ba9ceecf6dfe15025ef8e8d3662f87bfdbccd9";
export const EXPECTED_PRIMARY_V1_DEPLOYMENT_ID =
  "d41fdac5-5966-4e9a-afa9-0b738c9e32a2";
export const EXPECTED_PRIMARY_V1_VERSION_ID =
  "979ecdd0-54f0-423d-bf66-975b1123f7d7";
export const EXPECTED_PRIMARY_V1_VERSION_ETAG =
  "c0c6654090a2d447818366df78dfd21b16bf6c30cd6338ad5b754ae4dc706802";
export const PRIMARY_ORIGIN =
  "https://mycontext-mcp.servicedake.workers.dev";
export const PRESERVED_V1_ORIGIN =
  "https://mycontext-mcp-v1.servicedake.workers.dev";
export const EXPECTED_OBSERVABILITY = Object.freeze({
  logs: Object.freeze({
    enabled: true,
    headSamplingRate: 1,
    invocationLogs: true
  }),
  traces: Object.freeze({
    enabled: true,
    headSamplingRate: 0.2
  })
});

export const REQUIRED_SECRET_KEYS = Object.freeze([
  "GITHUB_ALLOWED_USER_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "PERSONAL_SYNONYMS",
  "TIDB_DATABASE_URL"
]);
export const FORBIDDEN_CLOUDFLARE_ENV_KEYS = Object.freeze([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_COMPLIANCE_REGION",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ENV",
  "CLOUDFLARE_PROFILE",
  "CF_ACCOUNT_ID",
  "CF_API_BASE_URL",
  "CF_API_KEY",
  "CF_API_TOKEN",
  "CF_EMAIL",
  "WRANGLER_ACCOUNT_ID",
  "WRANGLER_API_TOKEN",
  "WRANGLER_API_ENVIRONMENT",
  "WRANGLER_ENV",
  "WRANGLER_OAUTH_PROFILE_PATH",
  "WRANGLER_PROFILE"
]);

export const EXPECTED_KV_NAMESPACES = Object.freeze([
  Object.freeze({
    scope: "primary",
    binding: "AUTH_KV",
    id: "3c6429869d7e41b19f3423670f2c1c90",
    title: "AUTH_KV"
  }),
  Object.freeze({
    scope: "primary",
    binding: "OAUTH_KV",
    id: "88cc0f72224947fc818c0520207164de",
    title: "OAUTH_KV"
  }),
  Object.freeze({
    scope: "preserved-v1",
    binding: "AUTH_KV",
    id: "3bb6082de7ba4730b759c3e6e8322027",
    title: "mycontext-mcp-v1-auth"
  }),
  Object.freeze({
    scope: "preserved-v1",
    binding: "OAUTH_KV",
    id: "a0616be361fb4a65bd12e1fe35ec1101",
    title: "mycontext-mcp-v1-oauth"
  })
]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const V2_DIRECTORY = path.resolve(scriptDirectory, "..");
export const REPOSITORY_ROOT = path.resolve(V2_DIRECTORY, "..");
export const V1_DIRECTORY = path.resolve(
  REPOSITORY_ROOT,
  "mycontext-mcp-v1-worker"
);

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const maximumManifestFileBytes = 128 * 1024;
const maximumSecretsFileBytes = 64 * 1024;
const commandTimeoutMs = 180_000;

export class CutoverGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "CutoverGateError";
  }
}

function invariant(condition, message) {
  if (!condition) {
    throw new CutoverGateError(message);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sameValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeMode(stat) {
  return stat.mode & 0o777;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function requireUuid(value, label) {
  invariant(uuidPattern.test(value), `${label} must be a lowercase UUID`);
  return value;
}

function runCommand(
  command,
  args,
  {
    cwd = REPOSITORY_ROOT,
    timeout = commandTimeoutMs,
    inherit = false
  } = {}
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout,
    env: process.env
  });
  invariant(
    result.error === undefined,
    `${command} could not be started safely`
  );
  invariant(
    result.status === 0,
    `${command} failed${inherit ? "" : `: ${(result.stderr ?? "").trim()}`}`
  );
  return inherit ? "" : (result.stdout ?? "").trim();
}

function runGit(args) {
  return runCommand("git", args, { cwd: REPOSITORY_ROOT });
}

function runExactPnpm(args, options = {}) {
  return runCommand("npm", [...EXACT_PNPM_LAUNCHER, ...args], options);
}

function treeAtHead(directory) {
  const tree = runGit(["rev-parse", `HEAD:${directory}`]);
  invariant(gitObjectPattern.test(tree), `${directory} tree is invalid`);
  return tree;
}

export function captureRepositoryIdentity() {
  invariant(
    runGit(["status", "--porcelain=v1", "--untracked-files=all"]) === "",
    "repository must be completely clean before a release mutation"
  );
  invariant(
    runGit(["symbolic-ref", "--short", "HEAD"]) === EXPECTED_BRANCH,
    `release branch must be ${EXPECTED_BRANCH}`
  );
  const originUrl = runGit(["remote", "get-url", "origin"]);
  invariant(
    originUrl === EXPECTED_ORIGIN_URL,
    `origin must be ${EXPECTED_ORIGIN_URL}`
  );

  const headCommit = runGit(["rev-parse", "HEAD"]);
  const trackingCommit = runGit(["rev-parse", `origin/${EXPECTED_BRANCH}`]);
  invariant(
    gitObjectPattern.test(headCommit) && gitObjectPattern.test(trackingCommit),
    "local or tracking Git commit is invalid"
  );
  invariant(
    headCommit === trackingCommit,
    "local HEAD must equal origin/main before a release mutation"
  );

  const remoteLine = runGit([
    "ls-remote",
    "--exit-code",
    "origin",
    `refs/heads/${EXPECTED_BRANCH}`
  ]);
  const remoteCommit = remoteLine.split(/\s+/u)[0];
  invariant(
    remoteCommit === headCommit,
    "remote main changed or does not match local HEAD"
  );

  const frozenV1Tree = treeAtHead("mycontext-mcp-worker");
  invariant(
    frozenV1Tree === EXPECTED_FROZEN_V1_TREE,
    "frozen v1 source tree changed"
  );

  return Object.freeze({
    branch: EXPECTED_BRANCH,
    originUrl,
    headCommit,
    remoteCommit,
    frozenV1Tree,
    preservedV1Tree: treeAtHead("mycontext-mcp-v1-worker"),
    primaryV2Tree: treeAtHead("mycontext-mcp-v2-worker")
  });
}

export function assertRepositoryIdentityMatches(current, expected) {
  invariant(
    sameValue(current, expected),
    "repository identity changed after the private release manifest was created"
  );
  return true;
}

export function assertReleaseToolchain() {
  assertNoCloudflareEnvironmentOverrides();
  assertNoWranglerDotEnvFiles();
  const pnpmVersion = runExactPnpm(["--version"], {
    cwd: V2_DIRECTORY
  });
  invariant(
    pnpmVersion === EXPECTED_PNPM_VERSION,
    `pnpm must be exactly ${EXPECTED_PNPM_VERSION}`
  );
  for (const directory of [V1_DIRECTORY, V2_DIRECTORY]) {
    const wranglerOutput = runExactPnpm(
      ["exec", "wrangler", "--version"],
      { cwd: directory }
    );
    const wranglerVersion =
      wranglerOutput.match(/\b(\d+\.\d+\.\d+)\b/u)?.[1] ?? "";
    invariant(
      wranglerVersion === EXPECTED_WRANGLER_VERSION,
      `${path.basename(directory)} Wrangler must be exactly ` +
        EXPECTED_WRANGLER_VERSION
    );
  }
  const whoami = runExactPnpm(["exec", "wrangler", "whoami"], {
    cwd: V2_DIRECTORY
  });
  invariant(
    whoami.includes(EXPECTED_ACCOUNT_ID) &&
      whoami.includes("OAuth Token"),
    "Wrangler OAuth identity does not include the expected account"
  );
  return true;
}

export function assertNoWranglerDotEnvFiles() {
  for (const directory of [V1_DIRECTORY, V2_DIRECTORY]) {
    for (const name of [".env", ".env.local", ".dev.vars"]) {
      invariant(
        !existsSync(path.join(directory, name)),
        `${path.basename(directory)}/${name} must be absent for production release`
      );
    }
  }
  return true;
}

export function assertNoCloudflareEnvironmentOverrides(
  environment = process.env
) {
  for (const key of FORBIDDEN_CLOUDFLARE_ENV_KEYS) {
    invariant(
      environment[key] === undefined || environment[key] === "",
      `${key} must be unset so read and mutation credentials cannot diverge`
    );
  }
  return true;
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/u.test(source[index])) {
    index += 1;
  }
  return index;
}

function parseJsonString(source, start) {
  invariant(source[start] === "\"", "secrets JSON keys and values must be strings");
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\"") {
      try {
        const value = JSON.parse(source.slice(start, index + 1));
        invariant(
          typeof value === "string",
          "secrets JSON contains a non-string value"
        );
        return { value, nextIndex: index + 1 };
      } catch (error) {
        if (error instanceof CutoverGateError) throw error;
        throw new CutoverGateError(
          "secrets JSON contains an invalid string escape"
        );
      }
    }
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    invariant(
      source.charCodeAt(index) >= 0x20,
      "secrets JSON contains an invalid control character"
    );
    index += 1;
  }
  throw new CutoverGateError("secrets JSON contains an unterminated string");
}

export function parseSecretsJson(source) {
  invariant(typeof source === "string", "secrets JSON must be UTF-8 text");
  let index = skipWhitespace(source, 0);
  invariant(source[index] === "{", "secrets JSON must be a top-level object");
  index = skipWhitespace(source, index + 1);
  const entries = new Map();

  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    invariant(index === source.length, "secrets JSON contains trailing content");
  } else {
    while (index < source.length) {
      const parsedKey = parseJsonString(source, index);
      invariant(
        !entries.has(parsedKey.value),
        `secrets JSON contains duplicate key: ${parsedKey.value}`
      );
      index = skipWhitespace(source, parsedKey.nextIndex);
      invariant(source[index] === ":", "secrets JSON is missing ':'");
      index = skipWhitespace(source, index + 1);
      const parsedValue = parseJsonString(source, index);
      entries.set(parsedKey.value, parsedValue.value);
      index = skipWhitespace(source, parsedValue.nextIndex);
      if (source[index] === "}") {
        index = skipWhitespace(source, index + 1);
        invariant(index === source.length, "secrets JSON contains trailing content");
        break;
      }
      invariant(source[index] === ",", "secrets JSON entries must be comma-separated");
      index = skipWhitespace(source, index + 1);
      invariant(source[index] !== "}", "secrets JSON must not have a trailing comma");
    }
  }

  const expected = new Set(REQUIRED_SECRET_KEYS);
  invariant(
    entries.size === expected.size,
    "secrets JSON must contain exactly the five required keys"
  );
  for (const [key, value] of entries) {
    invariant(expected.has(key), `secrets JSON contains an unapproved key: ${key}`);
    invariant(value.trim().length > 0, `secrets JSON value is empty: ${key}`);
  }
  for (const key of expected) {
    invariant(entries.has(key), `secrets JSON is missing required key: ${key}`);
  }
  return Object.freeze(Object.fromEntries(entries));
}

async function inspectPrivateFile(
  suppliedPath,
  {
    expectedMode,
    label,
    mustExist = true,
    extension = ".json",
    maximumBytes = maximumManifestFileBytes
  }
) {
  invariant(
    typeof suppliedPath === "string" && path.isAbsolute(suppliedPath),
    `${label} path must be absolute`
  );
  invariant(
    path.extname(suppliedPath).toLowerCase() === extension,
    `${label} must use the ${extension} extension`
  );

  const repositoryRoot = await realpath(REPOSITORY_ROOT);
  const parentPath = path.dirname(suppliedPath);
  const parentStat = await lstat(parentPath);
  invariant(
    parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    `${label} parent must be a real directory`
  );
  invariant(
    (safeMode(parentStat) & 0o077) === 0,
    `${label} parent must not grant group or other permissions`
  );
  if (typeof process.getuid === "function") {
    invariant(
      parentStat.uid === process.getuid(),
      `${label} parent must be owned by the current user`
    );
  }
  const canonicalParent = await realpath(parentPath);
  invariant(
    !isInside(repositoryRoot, canonicalParent),
    `${label} must be outside the repository`
  );

  if (!mustExist) {
    const destination = path.join(canonicalParent, path.basename(suppliedPath));
    try {
      await lstat(destination);
    } catch (error) {
      invariant(error?.code === "ENOENT", `${label} destination is unsafe`);
      return Object.freeze({ path: destination });
    }
    throw new CutoverGateError(`${label} destination already exists`);
  }

  const suppliedStat = await lstat(suppliedPath);
  invariant(!suppliedStat.isSymbolicLink(), `${label} must not be a symlink`);
  invariant(suppliedStat.isFile(), `${label} must be a regular file`);
  const canonicalPath = await realpath(suppliedPath);
  invariant(
    !isInside(repositoryRoot, canonicalPath),
    `${label} must be outside the repository`
  );
  const handle = await open(
    canonicalPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  let contents;
  let openedStat;
  try {
    openedStat = await handle.stat();
    invariant(openedStat.isFile(), `${label} must remain a regular file`);
    invariant(
      safeMode(openedStat) === expectedMode,
      `${label} permissions must be exactly 0${expectedMode.toString(8)}`
    );
    if (typeof process.getuid === "function") {
      invariant(
        openedStat.uid === process.getuid(),
        `${label} must be owned by the current user`
      );
    }
    invariant(openedStat.nlink === 1, `${label} must not be hard-linked`);
    invariant(
      openedStat.size <= maximumBytes,
      `${label} exceeds the size limit`
    );
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  invariant(
    String(openedStat.dev) === String(suppliedStat.dev) &&
      String(openedStat.ino) === String(suppliedStat.ino),
    `${label} changed while it was inspected`
  );
  return Object.freeze({
    path: canonicalPath,
    contents,
    fingerprint: Object.freeze({
      device: String(openedStat.dev),
      inode: String(openedStat.ino),
      size: openedStat.size,
      modifiedAt: openedStat.mtimeMs,
      mode: safeMode(openedStat),
      sha256: sha256(contents)
    })
  });
}

export async function inspectSecretsFile(suppliedPath) {
  const file = await inspectPrivateFile(suppliedPath, {
    expectedMode: 0o600,
    label: "v1 secrets file",
    maximumBytes: maximumSecretsFileBytes
  });
  return Object.freeze({
    path: file.path,
    fingerprint: file.fingerprint,
    secrets: parseSecretsJson(file.contents)
  });
}

function createManifestEnvelope(kind, payload) {
  const unsigned = {
    schemaVersion: CUTOVER_MANIFEST_SCHEMA_VERSION,
    kind,
    payload
  };
  return Object.freeze({
    ...unsigned,
    integritySha256: sha256(stableJson(unsigned))
  });
}

export function parseManifestEnvelope(value, expectedKind) {
  const source = typeof value === "string" ? JSON.parse(value) : value;
  invariant(isObject(source), "release manifest must be an object");
  invariant(
    source.schemaVersion === CUTOVER_MANIFEST_SCHEMA_VERSION,
    "release manifest schema version is unsupported"
  );
  invariant(source.kind === expectedKind, `expected a ${expectedKind} manifest`);
  invariant(isObject(source.payload), "release manifest payload is invalid");
  const unsigned = {
    schemaVersion: source.schemaVersion,
    kind: source.kind,
    payload: source.payload
  };
  invariant(
    source.integritySha256 === sha256(stableJson(unsigned)),
    "release manifest integrity check failed"
  );
  return Object.freeze(source);
}

export async function writePrivateManifest(suppliedPath, kind, payload) {
  const reservation = await reservePrivateManifest(suppliedPath, kind, {
    createdAt: new Date().toISOString(),
    operation: "capture-without-remote-mutation"
  });
  return finalizePrivateManifest(reservation, kind, payload);
}

export async function reservePrivateManifest(suppliedPath, kind, pendingPayload) {
  const destination = await inspectPrivateFile(suppliedPath, {
    expectedMode: 0o400,
    label: `${kind} manifest`,
    mustExist: false
  });
  const envelope = createManifestEnvelope(`${kind}-pending`, pendingPayload);
  const contents = `${JSON.stringify(envelope, null, 2)}\n`;
  invariant(
    Buffer.byteLength(contents, "utf8") <= maximumManifestFileBytes,
    "pending release manifest exceeds the size limit"
  );
  const handle = await open(
    destination.path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600
  );
  let stat;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    stat = await handle.stat();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    path: destination.path,
    kind,
    device: String(stat.dev),
    inode: String(stat.ino)
  });
}

export async function finalizePrivateManifest(reservation, kind, payload) {
  invariant(
    isObject(reservation) &&
      reservation.kind === kind &&
      typeof reservation.path === "string",
    "release manifest reservation is invalid"
  );
  const suppliedStat = await lstat(reservation.path);
  invariant(
    suppliedStat.isFile() &&
      !suppliedStat.isSymbolicLink() &&
      safeMode(suppliedStat) === 0o600 &&
      suppliedStat.nlink === 1 &&
      String(suppliedStat.dev) === reservation.device &&
      String(suppliedStat.ino) === reservation.inode,
    "release manifest reservation changed before finalization"
  );
  if (typeof process.getuid === "function") {
    invariant(
      suppliedStat.uid === process.getuid(),
      "release manifest reservation owner changed"
    );
  }
  const envelope = createManifestEnvelope(kind, payload);
  const contents = `${JSON.stringify(envelope, null, 2)}\n`;
  invariant(
    Buffer.byteLength(contents, "utf8") <= maximumManifestFileBytes,
    "release manifest exceeds the size limit"
  );
  const temporaryPath = path.join(
    path.dirname(reservation.path),
    `.${path.basename(reservation.path)}.${randomUUID()}.final`
  );
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o400);
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    if (handle.fd !== -1) {
      await handle.close().catch(() => {});
    }
  }

  const reservationRecheck = await lstat(reservation.path);
  invariant(
    reservationRecheck.isFile() &&
      !reservationRecheck.isSymbolicLink() &&
      safeMode(reservationRecheck) === 0o600 &&
      reservationRecheck.nlink === 1 &&
      String(reservationRecheck.dev) === reservation.device &&
      String(reservationRecheck.ino) === reservation.inode,
    "release manifest reservation was replaced before atomic finalization"
  );
  await rename(temporaryPath, reservation.path);
  const directoryHandle = await open(
    path.dirname(reservation.path),
    fsConstants.O_RDONLY
  );
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  await readPrivateManifest(reservation.path, kind);
  return reservation.path;
}

export async function readPendingManifestReservation(suppliedPath, kind) {
  const file = await inspectPrivateFile(suppliedPath, {
    expectedMode: 0o600,
    label: `${kind} pending manifest`
  });
  let envelope;
  try {
    envelope = parseManifestEnvelope(file.contents, `${kind}-pending`);
  } catch (error) {
    if (error instanceof CutoverGateError) throw error;
    throw new CutoverGateError(`${kind} pending manifest is not valid JSON`);
  }
  return Object.freeze({
    reservation: Object.freeze({
      path: file.path,
      kind,
      device: file.fingerprint.device,
      inode: file.fingerprint.inode
    }),
    envelope
  });
}

export async function readPrivateManifest(suppliedPath, expectedKind) {
  const file = await inspectPrivateFile(suppliedPath, {
    expectedMode: 0o400,
    label: `${expectedKind} manifest`
  });
  let envelope;
  try {
    envelope = parseManifestEnvelope(file.contents, expectedKind);
  } catch (error) {
    if (error instanceof CutoverGateError) throw error;
    throw new CutoverGateError(`${expectedKind} manifest is not valid JSON`);
  }
  return Object.freeze({
    path: file.path,
    fingerprint: file.fingerprint,
    envelope
  });
}

async function loadWranglerOAuthToken() {
  const source = runExactPnpm(
    ["exec", "wrangler", "auth", "token", "--json"],
    { cwd: V2_DIRECTORY }
  );
  let credential;
  try {
    credential = JSON.parse(source);
  } catch {
    throw new CutoverGateError("Wrangler auth token response is invalid");
  }
  invariant(
    isObject(credential) &&
      credential.type === "oauth" &&
      typeof credential.token === "string" &&
      credential.token.length > 20,
    "Wrangler must use the authenticated OAuth profile"
  );
  return credential.token;
}

async function apiGet(suffix, { allowMissing = false, token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(
    `${API_BASE_URL}/accounts/${EXPECTED_ACCOUNT_ID}${suffix}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      signal: AbortSignal.timeout(30_000)
    }
  );
  if (allowMissing && response.status === 404) return null;
  invariant(response.ok, `Cloudflare read failed with HTTP ${response.status}`);
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new CutoverGateError("Cloudflare returned invalid JSON");
  }
  invariant(
    isObject(envelope) && envelope.success === true,
    "Cloudflare returned an unsuccessful response"
  );
  return envelope.result;
}

async function setPrimarySubdomain(previewsEnabled) {
  invariant(
    typeof previewsEnabled === "boolean",
    "preview URL setting must be boolean"
  );
  const token = await loadWranglerOAuthToken();
  const response = await fetch(
    `${API_BASE_URL}/accounts/${EXPECTED_ACCOUNT_ID}/workers/scripts/` +
      `${encodeURIComponent(PRIMARY_WORKER)}/subdomain`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Cloudflare-Workers-Script-Api-Date": "2025-08-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        enabled: true,
        previews_enabled: previewsEnabled
      }),
      signal: AbortSignal.timeout(30_000)
    }
  );
  invariant(
    response.ok,
    `Cloudflare subdomain reconciliation failed with HTTP ${response.status}`
  );
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new CutoverGateError(
      "Cloudflare subdomain reconciliation returned invalid JSON"
    );
  }
  invariant(
    isObject(envelope) &&
      envelope.success === true &&
      envelope.result?.enabled === true &&
      envelope.result?.previews_enabled === previewsEnabled,
    "Cloudflare subdomain reconciliation did not reach the requested state"
  );
}

function canonicalBindings(bindings) {
  invariant(Array.isArray(bindings), "Worker bindings must be an array");
  return bindings
    .map((binding) => {
      invariant(
        isObject(binding) &&
          typeof binding.name === "string" &&
          typeof binding.type === "string",
        "Worker binding is invalid"
      );
      const record = { name: binding.name, type: binding.type };
      if (binding.type === "kv_namespace") {
        invariant(
          /^[0-9a-f]{32}$/u.test(binding.namespace_id),
          "KV binding namespace ID is invalid"
        );
        record.namespaceId = binding.namespace_id;
      }
      return record;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function canonicalVersion(version) {
  invariant(isObject(version), "Worker version is invalid");
  requireUuid(version.id, "Worker version ID");
  const etag = version.resources?.script?.etag;
  invariant(typeof etag === "string" && etag.length > 0, "Worker version ETag is missing");
  return {
    id: version.id,
    etag,
    number: version.number,
    annotations: stableValue(version.annotations ?? {}),
    hasPreview: version.metadata?.has_preview === true,
    handlers: [...(version.resources?.script?.handlers ?? [])].sort(),
    runtime: {
      compatibilityDate: version.resources?.script_runtime?.compatibility_date,
      compatibilityFlags: [
        ...(version.resources?.script_runtime?.compatibility_flags ?? [])
      ].sort()
    },
    bindings: canonicalBindings(version.resources?.bindings)
  };
}

function observabilityProjection(observability) {
  invariant(isObject(observability), "Worker observability settings are missing");
  return stableValue(observability);
}

async function captureWorker(workerName, token) {
  const encodedName = encodeURIComponent(workerName);
  const settings = await apiGet(
    `/workers/scripts/${encodedName}/settings`,
    { allowMissing: true, token }
  );
  if (settings === null) {
    return Object.freeze({
      exists: false,
      activeDeployment: null,
      crons: [],
      observability: null,
      subdomain: null
    });
  }
  const [deploymentsResult, schedulesResult, subdomain] = await Promise.all([
    apiGet(`/workers/scripts/${encodedName}/deployments`, { token }),
    apiGet(`/workers/scripts/${encodedName}/schedules`, { token }),
    apiGet(`/workers/scripts/${encodedName}/subdomain`, { token })
  ]);
  invariant(
    Array.isArray(deploymentsResult?.deployments),
    "Worker deployments response is invalid"
  );
  invariant(
    Array.isArray(schedulesResult?.schedules),
    "Worker schedules response is invalid"
  );
  const deployment = deploymentsResult.deployments[0] ?? null;
  let activeDeployment = null;
  if (deployment !== null) {
    requireUuid(deployment.id, "deployment ID");
    invariant(Array.isArray(deployment.versions), "deployment versions are invalid");
    const versions = [];
    for (const item of deployment.versions) {
      requireUuid(item.version_id, "active version ID");
      invariant(
        typeof item.percentage === "number" &&
          item.percentage >= 0 &&
          item.percentage <= 100,
        "active version percentage is invalid"
      );
      const fullVersion = await apiGet(
        `/workers/scripts/${encodedName}/versions/${item.version_id}`,
        { token }
      );
      const canonical = canonicalVersion(fullVersion);
      versions.push({
        ...canonical,
        percentage: item.percentage
      });
    }
    activeDeployment = {
      id: deployment.id,
      versions: versions.sort((left, right) => left.id.localeCompare(right.id))
    };
  }
  invariant(
    isObject(subdomain) &&
      typeof subdomain.enabled === "boolean" &&
      typeof subdomain.previews_enabled === "boolean",
    "Worker subdomain settings are invalid"
  );
  return Object.freeze({
    exists: true,
    activeDeployment,
    crons: schedulesResult.schedules
      .map((schedule) => schedule?.cron)
      .sort(),
    observability: observabilityProjection(settings.observability),
    subdomain: {
      enabled: subdomain.enabled,
      previewsEnabled: subdomain.previews_enabled
    }
  });
}

async function captureKvNamespaces(token) {
  const result = await apiGet("/storage/kv/namespaces?per_page=1000", {
    token
  });
  invariant(Array.isArray(result), "KV namespace list is invalid");
  return EXPECTED_KV_NAMESPACES.map((expected) => {
    const matches = result.filter((namespace) => namespace?.id === expected.id);
    invariant(matches.length === 1, `KV namespace ${expected.id} is missing`);
    invariant(
      matches[0].title === expected.title,
      `KV namespace ${expected.id} title must be ${expected.title}`
    );
    return expected;
  });
}

async function preservedV1KvIsEmpty(token) {
  const aliasNamespaces = EXPECTED_KV_NAMESPACES.filter(
    (namespace) => namespace.scope === "preserved-v1"
  );
  const keyLists = await Promise.all(
    aliasNamespaces.map((namespace) =>
      apiGet(
        `/storage/kv/namespaces/${namespace.id}/keys?limit=10`,
        { token }
      )
    )
  );
  for (const keys of keyLists) {
    invariant(Array.isArray(keys), "KV key list is invalid");
  }
  return keyLists.every((keys) => keys.length === 0);
}

export async function captureRemoteState() {
  const token = await loadWranglerOAuthToken();
  const [primary, preservedV1, kvNamespaces, preservedV1KvEmpty] =
    await Promise.all([
    captureWorker(PRIMARY_WORKER, token),
    captureWorker(PRESERVED_V1_WORKER, token),
    captureKvNamespaces(token),
    preservedV1KvIsEmpty(token)
  ]);
  return Object.freeze({
    accountId: EXPECTED_ACCOUNT_ID,
    primary,
    preservedV1,
    kvNamespaces,
    preservedV1KvEmpty
  });
}

async function capturePrimaryVersion(versionId) {
  requireUuid(versionId, "candidate version ID");
  const token = await loadWranglerOAuthToken();
  const result = await apiGet(
    `/workers/scripts/${encodeURIComponent(PRIMARY_WORKER)}/versions/${versionId}`,
    { token }
  );
  return Object.freeze(canonicalVersion(result));
}

function expectedBindings(scope) {
  const kv = EXPECTED_KV_NAMESPACES.filter((item) => item.scope === scope).map(
    (item) => ({
      name: item.binding,
      type: "kv_namespace",
      namespaceId: item.id
    })
  );
  return [
    ...kv,
    ...REQUIRED_SECRET_KEYS.map((name) => ({ name, type: "secret_text" }))
  ].sort((left, right) => left.name.localeCompare(right.name));
}

function assertWorkerAtFullTraffic(worker, scope) {
  invariant(worker.exists === true, `${scope} Worker must exist`);
  invariant(worker.activeDeployment !== null, `${scope} deployment is missing`);
  invariant(
    worker.activeDeployment.versions.length === 1 &&
      worker.activeDeployment.versions[0].percentage === 100,
    `${scope} Worker must have exactly one version at 100%`
  );
  invariant(
    sameValue(
      worker.activeDeployment.versions[0].bindings,
      expectedBindings(scope)
    ),
    `${scope} active bindings do not match the approved set`
  );
  invariant(
    sameValue(worker.crons, [EXPECTED_CRON]),
    `${scope} cron trigger does not match`
  );
}

function assertWorkerGlobalSettings(worker, { previewsEnabled, scope }) {
  const logs = worker.observability?.logs;
  const traces = worker.observability?.traces;
  invariant(
    logs?.enabled === true &&
      (logs.head_sampling_rate ?? logs.headSamplingRate) === 1 &&
      (logs.invocation_logs ?? logs.invocationLogs) === true &&
      traces?.enabled === true &&
      (traces.head_sampling_rate ?? traces.headSamplingRate) === 0.2,
    `${scope} observability settings are incorrect`
  );
  invariant(
    sameValue(worker.subdomain, {
      enabled: true,
      previewsEnabled
    }),
    `${scope} workers.dev or preview URL setting is incorrect`
  );
  invariant(
    sameValue(worker.crons, [EXPECTED_CRON]),
    `${scope} cron trigger does not match`
  );
}

function assertPrimaryCandidateGlobalSettings(worker) {
  invariant(worker.exists === true, "canonical primary Worker must exist");
  assertWorkerGlobalSettings(worker, {
    previewsEnabled: false,
    scope: "canonical v2 candidate"
  });
  return true;
}

function assertPrimaryNonDeploymentState(current, expected, label) {
  const {
    activeDeployment: currentDeployment,
    ...currentNonDeployment
  } = current;
  const {
    activeDeployment: expectedDeployment,
    ...expectedNonDeployment
  } = expected;
  void currentDeployment;
  void expectedDeployment;
  invariant(
    sameValue(currentNonDeployment, expectedNonDeployment),
    `${label} canonical non-deployment state changed`
  );
}

function assertApprovedPrimaryBaseline(state) {
  invariant(
    state.accountId === EXPECTED_ACCOUNT_ID,
    "Cloudflare account does not match"
  );
  invariant(
    sameValue(state.kvNamespaces, EXPECTED_KV_NAMESPACES),
    "Cloudflare KV namespace records do not match"
  );
  assertWorkerAtFullTraffic(state.primary, "primary");
  invariant(
    state.primary.activeDeployment.id ===
      EXPECTED_PRIMARY_V1_DEPLOYMENT_ID &&
      state.primary.activeDeployment.versions[0].id ===
        EXPECTED_PRIMARY_V1_VERSION_ID &&
      state.primary.activeDeployment.versions[0].etag ===
        EXPECTED_PRIMARY_V1_VERSION_ETAG,
    "canonical v1 deployment/version/ETag does not match the approved baseline"
  );
  assertWorkerGlobalSettings(state.primary, {
    previewsEnabled: true,
    scope: "primary v1 baseline"
  });
  return true;
}

export function assertBaselineState(state) {
  assertApprovedPrimaryBaseline(state);
  invariant(
    state.preservedV1KvEmpty === true,
    "preserved v1 KV namespaces must be empty at baseline capture"
  );
  invariant(
    state.preservedV1.exists === false,
    "preserved v1 Worker must not exist at baseline capture"
  );
  return true;
}

export function assertPrimaryUnchanged(current, expectedPrimary) {
  invariant(
    sameValue(current.primary, expectedPrimary),
    "canonical primary Worker changed from its captured baseline"
  );
  return true;
}

export function assertPreservedV1Ready(worker, { tag, message }) {
  assertWorkerAtFullTraffic(worker, "preserved-v1");
  assertWorkerGlobalSettings(worker, {
    previewsEnabled: false,
    scope: "preserved v1"
  });
  const version = worker.activeDeployment.versions[0];
  invariant(
    version.annotations?.["workers/tag"] === tag &&
      version.annotations?.["workers/message"] === message,
    "preserved v1 release tag or message does not match"
  );
  invariant(
    sameValue(version.handlers, ["fetch", "scheduled"]) &&
      version.runtime.compatibilityDate === "2026-07-06" &&
      sameValue(version.runtime.compatibilityFlags, ["nodejs_compat"]),
    "preserved v1 version metadata does not match the frozen runtime"
  );
  return true;
}

export function assertCandidateVersion(version, { tag, message }) {
  requireUuid(version.id, "candidate version ID");
  invariant(version.etag.length > 0, "candidate version ETag is missing");
  invariant(
    version.annotations?.["workers/tag"] === tag,
    "candidate version tag does not match"
  );
  invariant(
    version.annotations?.["workers/message"] === message,
    "candidate version message does not match"
  );
  invariant(
    sameValue(version.handlers, ["fetch", "scheduled"]),
    "candidate handlers are incorrect"
  );
  invariant(
    version.runtime.compatibilityDate === "2026-07-06" &&
      sameValue(version.runtime.compatibilityFlags, ["nodejs_compat"]),
    "candidate runtime settings are incorrect"
  );
  invariant(
    sameValue(version.bindings, expectedBindings("primary")),
    "candidate bindings do not match the approved canonical bindings"
  );
  return true;
}

function activeVersion(worker, versionId) {
  return worker.activeDeployment?.versions.find(
    (version) => version.id === versionId
  );
}

export function assertCandidatePreStageState(current, manifestPayload) {
  invariant(
    sameValue(current.kvNamespaces, manifestPayload.kvNamespaces),
    "KV namespace records changed after candidate capture"
  );
  invariant(
    sameValue(current.preservedV1, manifestPayload.preservedV1),
    "preserved v1 Worker changed after candidate capture"
  );
  invariant(
    sameValue(current.primary, manifestPayload.primaryCandidateState),
    "canonical state changed before 0% staging"
  );
  return true;
}

export function assertStagedState(current, manifestPayload) {
  const stagedVersions = current.primary.activeDeployment?.versions;
  invariant(
    Array.isArray(stagedVersions) &&
      stagedVersions.length === 2 &&
      new Set(stagedVersions.map((version) => version.id)).size === 2 &&
      sameValue(
        stagedVersions.map((version) => version.id).sort(),
        [
          manifestPayload.primaryV1Version.id,
          manifestPayload.candidateVersion.id
        ].sort()
      ) &&
      stagedVersions.reduce(
        (total, version) => total + version.percentage,
        0
      ) === 100,
    "staging must contain exactly the captured v1 and v2 versions"
  );
  const oldVersion = activeVersion(
    current.primary,
    manifestPayload.primaryV1Version.id
  );
  const candidate = activeVersion(
    current.primary,
    manifestPayload.candidateVersion.id
  );
  invariant(oldVersion !== undefined, "captured v1 version is absent from staging");
  invariant(candidate !== undefined, "v2 candidate is absent from staging");
  invariant(
    oldVersion.percentage === 100 && candidate.percentage === 0,
    "staging must be exactly v1@100% and v2@0%"
  );
  invariant(
    oldVersion.etag === manifestPayload.primaryV1Version.etag &&
      candidate.etag === manifestPayload.candidateVersion.etag,
    "staged version ETag changed"
  );
  invariant(
    sameValue(oldVersion.bindings, expectedBindings("primary")) &&
      sameValue(candidate.bindings, expectedBindings("primary")),
    "staged version bindings changed"
  );
  assertPrimaryNonDeploymentState(
    current.primary,
    manifestPayload.primaryCandidateState,
    "staged"
  );
  invariant(
    sameValue(current.preservedV1, manifestPayload.preservedV1),
    "preserved v1 Worker changed during staging"
  );
  invariant(
    sameValue(current.kvNamespaces, manifestPayload.kvNamespaces),
    "KV namespace records changed during staging"
  );
  return true;
}

export function assertPromotedState(current, manifestPayload) {
  const deployment = current.primary.activeDeployment;
  invariant(deployment !== null, "canonical deployment is missing after promotion");
  invariant(
    deployment.versions.length === 1 &&
      deployment.versions[0].id === manifestPayload.candidateVersion.id &&
      deployment.versions[0].etag === manifestPayload.candidateVersion.etag &&
      deployment.versions[0].percentage === 100,
    "canonical traffic is not exactly the captured v2 candidate at 100%"
  );
  invariant(
    sameValue(
      deployment.versions[0].bindings,
      expectedBindings("primary")
    ),
    "promoted canonical bindings changed"
  );
  assertPrimaryNonDeploymentState(
    current.primary,
    manifestPayload.primaryCandidateState,
    "promoted"
  );
  invariant(
    sameValue(current.preservedV1, manifestPayload.preservedV1),
    "preserved v1 Worker changed during promotion"
  );
  invariant(
    sameValue(current.kvNamespaces, manifestPayload.kvNamespaces),
    "KV namespace records changed during promotion"
  );
  return true;
}

export function assertRolledBackState(current, manifestPayload) {
  const deployment = current.primary.activeDeployment;
  invariant(deployment !== null, "canonical deployment is missing after rollback");
  invariant(
    deployment.versions.length === 1 &&
      deployment.versions[0].id === manifestPayload.primaryV1Version.id &&
      deployment.versions[0].etag === manifestPayload.primaryV1Version.etag &&
      deployment.versions[0].percentage === 100,
    "canonical traffic did not return to the captured v1 version"
  );
  invariant(
    sameValue(
      deployment.versions[0].bindings,
      expectedBindings("primary")
    ),
    "rolled-back canonical bindings changed"
  );
  assertPrimaryNonDeploymentState(
    current.primary,
    manifestPayload.primaryBaseline,
    "rolled-back"
  );
  invariant(
    sameValue(current.preservedV1, manifestPayload.preservedV1),
    "preserved v1 Worker changed during rollback"
  );
  invariant(
    sameValue(current.kvNamespaces, manifestPayload.kvNamespaces),
    "KV namespace records changed during rollback"
  );
  return true;
}

export function assertRollbackPendingSubdomainState(current, manifestPayload) {
  const deployment = current.primary.activeDeployment;
  invariant(deployment !== null, "canonical deployment is missing after rollback");
  invariant(
    deployment.versions.length === 1 &&
      deployment.versions[0].id === manifestPayload.primaryV1Version.id &&
      deployment.versions[0].etag === manifestPayload.primaryV1Version.etag &&
      deployment.versions[0].percentage === 100 &&
      sameValue(
        deployment.versions[0].bindings,
        expectedBindings("primary")
      ),
    "canonical code is not the captured v1 rollback target"
  );
  assertPrimaryNonDeploymentState(
    current.primary,
    manifestPayload.primaryCandidateState,
    "rollback pending subdomain reconciliation"
  );
  invariant(
    sameValue(current.preservedV1, manifestPayload.preservedV1) &&
      sameValue(current.kvNamespaces, manifestPayload.kvNamespaces) &&
      current.accountId === EXPECTED_ACCOUNT_ID,
    "preserved v1 or KV state changed during rollback"
  );
  return true;
}

async function assertPublicUnauthenticated(origin) {
  const [health, mcp] = await Promise.all([
    fetch(`${origin}/healthz`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    }),
    fetch(`${origin}/mcp`, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000)
    })
  ]);
  invariant(health.status === 200, `${origin} health check failed`);
  invariant(mcp.status === 401, `${origin} unauthenticated MCP check failed`);
}

function runReleaseCommand(releaseCommand) {
  runCommand(releaseCommand.command, releaseCommand.args, {
    cwd: releaseCommand.cwd,
    inherit: true
  });
}

function wranglerVersionIds() {
  const source = runExactPnpm(
    ["exec", "wrangler", "versions", "list", "--name", PRIMARY_WORKER, "--json"],
    { cwd: V2_DIRECTORY }
  );
  let versions;
  try {
    versions = JSON.parse(source);
  } catch {
    throw new CutoverGateError("Wrangler version list was not valid JSON");
  }
  invariant(Array.isArray(versions), "Wrangler version list is invalid");
  return new Set(
    versions.map((version) => requireUuid(version?.id, "listed version ID"))
  );
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    invariant(
      typeof key === "string" &&
        key.startsWith("--") &&
        typeof value === "string",
      "release gate options must be --key value pairs"
    );
    invariant(options[key] === undefined, `duplicate release option: ${key}`);
    options[key] = value;
  }
  return options;
}

function requiredOption(options, name) {
  const value = options[`--${name}`];
  invariant(typeof value === "string" && value.length > 0, `--${name} is required`);
  return value;
}

async function revalidateRepository(expected) {
  assertReleaseToolchain();
  const current = captureRepositoryIdentity();
  assertRepositoryIdentityMatches(current, expected);
  return current;
}

async function captureBaseline(options) {
  assertReleaseToolchain();
  const repository = captureRepositoryIdentity();
  const remote = await captureRemoteState();
  assertBaselineState(remote);
  const manifestPath = requiredOption(options, "manifest");
  await writePrivateManifest(manifestPath, "baseline", {
    createdAt: new Date().toISOString(),
    repository,
    remote
  });
  console.log(`Baseline manifest sealed: ${manifestPath}`);
}

async function deployPreservedV1(options) {
  const baseline = await readPrivateManifest(
    requiredOption(options, "baseline"),
    "baseline"
  );
  await revalidateRepository(baseline.envelope.payload.repository);
  const current = await captureRemoteState();
  invariant(
    sameValue(current, baseline.envelope.payload.remote),
    "Cloudflare baseline changed before preserved v1 deploy"
  );

  const secrets = await inspectSecretsFile(requiredOption(options, "secrets-file"));
  const tag = requiredOption(options, "tag");
  const message = requiredOption(options, "message");
  const deployCommand = buildPreservedV1DeployCommand({
    secretsFile: secrets.path,
    tag,
    message
  });
  const secretsRecheck = await inspectSecretsFile(secrets.path);
  invariant(
    sameValue(secrets.fingerprint, secretsRecheck.fingerprint),
    "v1 secrets file changed before deploy"
  );
  const mutationState = await captureRemoteState();
  invariant(
    sameValue(mutationState, baseline.envelope.payload.remote),
    "Cloudflare baseline changed immediately before preserved v1 deploy"
  );
  const aliasManifestReservation = await reservePrivateManifest(
    requiredOption(options, "manifest"),
    "alias",
    {
      createdAt: new Date().toISOString(),
      operation: "deploy-preserved-v1",
      baselineIntegritySha256: baseline.envelope.integritySha256,
      repository: baseline.envelope.payload.repository,
      tag,
      message,
      secretsFingerprint: secrets.fingerprint
    }
  );
  await revalidateRepository(baseline.envelope.payload.repository);
  const finalSecretsRecheck = await inspectSecretsFile(secrets.path);
  invariant(
    sameValue(secrets.fingerprint, finalSecretsRecheck.fingerprint),
    "v1 secrets file changed immediately before deploy"
  );
  const finalMutationState = await captureRemoteState();
  invariant(
    sameValue(finalMutationState, baseline.envelope.payload.remote),
    "Cloudflare baseline changed after final local validation"
  );
  runReleaseCommand(deployCommand);

  const after = await captureRemoteState();
  assertPrimaryUnchanged(after, baseline.envelope.payload.remote.primary);
  assertPreservedV1Ready(after.preservedV1, { tag, message });
  invariant(
    sameValue(after.kvNamespaces, baseline.envelope.payload.remote.kvNamespaces),
    "KV namespace records changed during preserved v1 deploy"
  );
  invariant(
    after.preservedV1KvEmpty === true,
    "preserved v1 KV namespaces changed during first deploy"
  );
  await assertPublicUnauthenticated(PRESERVED_V1_ORIGIN);
  await finalizePrivateManifest(
    aliasManifestReservation,
    "alias",
    {
      createdAt: new Date().toISOString(),
      repository: baseline.envelope.payload.repository,
      primaryBaseline: baseline.envelope.payload.remote.primary,
      preservedV1: after.preservedV1,
      kvNamespaces: after.kvNamespaces
    }
  );
  console.log("Preserved v1 alias deployed and verified.");
}

async function recoverPreservedV1Manifest(options) {
  const baseline = await readPrivateManifest(
    requiredOption(options, "baseline"),
    "baseline"
  );
  await revalidateRepository(baseline.envelope.payload.repository);
  const pending = await readPendingManifestReservation(
    requiredOption(options, "manifest"),
    "alias"
  );
  invariant(
    pending.envelope.payload.operation === "deploy-preserved-v1" &&
      pending.envelope.payload.baselineIntegritySha256 ===
        baseline.envelope.integritySha256 &&
      sameValue(
        pending.envelope.payload.repository,
        baseline.envelope.payload.repository
      ) &&
      typeof pending.envelope.payload.tag === "string" &&
      typeof pending.envelope.payload.message === "string" &&
      isObject(pending.envelope.payload.secretsFingerprint),
    "alias pending manifest does not match the captured baseline"
  );
  let current = await captureRemoteState();
  assertPrimaryUnchanged(current, baseline.envelope.payload.remote.primary);
  let aliasReady = false;
  try {
    assertPreservedV1Ready(current.preservedV1, {
      tag: pending.envelope.payload.tag,
      message: pending.envelope.payload.message
    });
    aliasReady = true;
  } catch (error) {
    if (!(error instanceof CutoverGateError)) throw error;
  }
  if (!aliasReady) {
    invariant(
      current.preservedV1.exists === false,
      "existing but non-conforming v1 alias requires manual investigation"
    );
    const secrets = await inspectSecretsFile(
      requiredOption(options, "secrets-file")
    );
    invariant(
      sameValue(
        secrets.fingerprint,
        pending.envelope.payload.secretsFingerprint
      ),
      "v1 secrets file does not match the pending deploy"
    );
    await revalidateRepository(baseline.envelope.payload.repository);
    const mutationState = await captureRemoteState();
    invariant(
      sameValue(mutationState, baseline.envelope.payload.remote),
      "Cloudflare baseline changed before alias recovery deploy"
    );
    const finalSecrets = await inspectSecretsFile(secrets.path);
    invariant(
      sameValue(secrets.fingerprint, finalSecrets.fingerprint),
      "v1 secrets file changed immediately before recovery deploy"
    );
    const recoveryCommand = buildPreservedV1DeployCommand({
      secretsFile: secrets.path,
      tag: pending.envelope.payload.tag,
      message: pending.envelope.payload.message
    });
    const finalMutationState = await captureRemoteState();
    invariant(
      sameValue(finalMutationState, baseline.envelope.payload.remote),
      "Cloudflare baseline changed after final recovery validation"
    );
    runReleaseCommand(recoveryCommand);
    current = await captureRemoteState();
    assertPrimaryUnchanged(current, baseline.envelope.payload.remote.primary);
    assertPreservedV1Ready(current.preservedV1, {
      tag: pending.envelope.payload.tag,
      message: pending.envelope.payload.message
    });
  }
  invariant(
    sameValue(
      current.kvNamespaces,
      baseline.envelope.payload.remote.kvNamespaces
    ),
    "KV namespace records changed before alias manifest recovery"
  );
  await assertPublicUnauthenticated(PRESERVED_V1_ORIGIN);
  await finalizePrivateManifest(pending.reservation, "alias", {
    createdAt: new Date().toISOString(),
    repository: baseline.envelope.payload.repository,
    primaryBaseline: baseline.envelope.payload.remote.primary,
    preservedV1: current.preservedV1,
    kvNamespaces: current.kvNamespaces
  });
  console.log("Preserved v1 alias pending manifest recovered and sealed.");
}

function assertAliasManifestState(current, payload) {
  assertPrimaryUnchanged(current, payload.primaryBaseline);
  assertAliasResourcesUnchanged(current, payload);
}

function assertAliasResourcesUnchanged(current, payload) {
  invariant(
    sameValue(current.preservedV1, payload.preservedV1),
    "preserved v1 Worker changed after alias manifest capture"
  );
  invariant(
    sameValue(current.kvNamespaces, payload.kvNamespaces),
    "KV namespace records changed after alias manifest capture"
  );
}

function primaryWithoutPreviewFields(primary) {
  const comparable = structuredClone(primary);
  delete comparable.subdomain;
  for (const version of comparable.activeDeployment?.versions ?? []) {
    delete version.hasPreview;
  }
  return comparable;
}

function assertPrimaryPreviewReconciled(
  currentPrimary,
  baselinePrimary,
  previewsEnabled
) {
  invariant(
    sameValue(currentPrimary.subdomain, {
      enabled: true,
      previewsEnabled
    }) &&
      sameValue(
        primaryWithoutPreviewFields(currentPrimary),
        primaryWithoutPreviewFields(baselinePrimary)
      ),
    "canonical preview reconciliation changed non-preview state"
  );
  return true;
}

async function uploadCandidate(options) {
  const alias = await readPrivateManifest(
    requiredOption(options, "alias-manifest"),
    "alias"
  );
  await revalidateRepository(alias.envelope.payload.repository);
  const tag = requiredOption(options, "tag");
  const message = requiredOption(options, "message");
  const manifestPath = requiredOption(options, "manifest");
  const uploadCommand = buildPrimaryUploadCommand({ tag, message });

  let current = await captureRemoteState();
  assertAliasResourcesUnchanged(current, alias.envelope.payload);
  let previewAlreadyReconciled = false;
  if (!sameValue(current.primary, alias.envelope.payload.primaryBaseline)) {
    assertPrimaryPreviewReconciled(
      current.primary,
      alias.envelope.payload.primaryBaseline,
      false
    );
    previewAlreadyReconciled = true;
  }

  const currentVersionIds = wranglerVersionIds();
  let candidateManifestReservation;
  let beforeVersionIds;
  try {
    const pending = await readPendingManifestReservation(
      manifestPath,
      "candidate"
    );
    const pendingPayload = pending.envelope.payload;
    invariant(
      pendingPayload.operation === "upload-canonical-v2" &&
        pendingPayload.aliasIntegritySha256 ===
          alias.envelope.integritySha256 &&
        sameValue(
          pendingPayload.repository,
          alias.envelope.payload.repository
        ) &&
        pendingPayload.tag === tag &&
        pendingPayload.message === message &&
        Array.isArray(pendingPayload.beforeVersionIds),
      "candidate pending manifest does not match this release"
    );
    beforeVersionIds = new Set(
      pendingPayload.beforeVersionIds.map((versionId) =>
        requireUuid(versionId, "pending pre-upload version ID")
      )
    );
    candidateManifestReservation = pending.reservation;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !(
        error.code === "ENOENT" ||
        /pending manifest.*ENOENT|no such file/u.test(error.message)
      )
    ) {
      throw error;
    }
    beforeVersionIds = currentVersionIds;
    candidateManifestReservation = await reservePrivateManifest(
      manifestPath,
      "candidate",
      {
        operation: "upload-canonical-v2",
        aliasIntegritySha256: alias.envelope.integritySha256,
        repository: alias.envelope.payload.repository,
        tag,
        message,
        beforeVersionIds: [...beforeVersionIds].sort()
      }
    );
  }

  if (!previewAlreadyReconciled) {
    await revalidateRepository(alias.envelope.payload.repository);
    const previewMutationState = await captureRemoteState();
    assertAliasManifestState(
      previewMutationState,
      alias.envelope.payload
    );
    await setPrimarySubdomain(false);
    current = await captureRemoteState();
  }
  assertPrimaryPreviewReconciled(
    current.primary,
    alias.envelope.payload.primaryBaseline,
    false
  );
  assertAliasResourcesUnchanged(current, alias.envelope.payload);
  const preUploadPrimary = current.primary;

  let afterVersionIds = wranglerVersionIds();
  let newVersionIds = [...afterVersionIds].filter(
    (versionId) => !beforeVersionIds.has(versionId)
  );
  invariant(
    newVersionIds.length <= 1,
    "more than one canonical version appeared after upload reservation"
  );
  if (newVersionIds.length === 0) {
    const mutationState = await captureRemoteState();
    invariant(
      sameValue(mutationState.primary, preUploadPrimary),
      "canonical state changed immediately before version upload"
    );
    assertAliasResourcesUnchanged(mutationState, alias.envelope.payload);
    await revalidateRepository(alias.envelope.payload.repository);
    const finalMutationState = await captureRemoteState();
    invariant(
      sameValue(finalMutationState.primary, preUploadPrimary),
      "canonical state changed after final repository validation"
    );
    assertAliasResourcesUnchanged(finalMutationState, alias.envelope.payload);
    runReleaseCommand(uploadCommand);
    afterVersionIds = wranglerVersionIds();
    newVersionIds = [...afterVersionIds].filter(
      (versionId) => !beforeVersionIds.has(versionId)
    );
  }
  invariant(
    newVersionIds.length === 1,
    "upload must create exactly one new canonical Worker version"
  );
  const candidateVersion = await capturePrimaryVersion(newVersionIds[0]);
  assertCandidateVersion(candidateVersion, { tag, message });

  const postUpload = await captureRemoteState();
  invariant(
    sameValue(postUpload.primary, preUploadPrimary),
    "canonical state changed during version upload"
  );
  assertAliasResourcesUnchanged(postUpload, alias.envelope.payload);
  assertPrimaryCandidateGlobalSettings(postUpload.primary);

  const primaryV1Version =
    alias.envelope.payload.primaryBaseline.activeDeployment.versions[0];
  await finalizePrivateManifest(
    candidateManifestReservation,
    "candidate",
    {
      createdAt: new Date().toISOString(),
      repository: alias.envelope.payload.repository,
      primaryBaseline: alias.envelope.payload.primaryBaseline,
      primaryCandidateState: postUpload.primary,
      primaryV1Version: {
        id: primaryV1Version.id,
        etag: primaryV1Version.etag
      },
      preservedV1: alias.envelope.payload.preservedV1,
      kvNamespaces: alias.envelope.payload.kvNamespaces,
      candidateVersion,
      tag,
      message
    }
  );
  console.log(`Canonical v2 candidate uploaded: ${candidateVersion.id}`);
}

async function loadCandidateAndState(options) {
  const candidate = await readPrivateManifest(
    requiredOption(options, "manifest"),
    "candidate"
  );
  await revalidateRepository(candidate.envelope.payload.repository);
  const current = await captureRemoteState();
  return { candidate, current };
}

async function stageCandidate(options) {
  const { candidate, current } = await loadCandidateAndState(options);
  const payload = candidate.envelope.payload;
  assertCandidatePreStageState(current, payload);
  const version = await capturePrimaryVersion(payload.candidateVersion.id);
  invariant(
    sameValue(version, payload.candidateVersion),
    "candidate version changed before staging"
  );
  const message = requiredOption(options, "message");
  runReleaseCommand(
    buildZeroTrafficCommand({
      v1VersionId: payload.primaryV1Version.id,
      v2VersionId: payload.candidateVersion.id,
      message,
      dryRun: true
    })
  );
  const afterDryRun = await captureRemoteState();
  assertCandidatePreStageState(afterDryRun, payload);
  await revalidateRepository(payload.repository);
  const finalStageState = await captureRemoteState();
  assertCandidatePreStageState(finalStageState, payload);
  runReleaseCommand(
    buildZeroTrafficCommand({
      v1VersionId: payload.primaryV1Version.id,
      v2VersionId: payload.candidateVersion.id,
      message
    })
  );
  const staged = await captureRemoteState();
  assertStagedState(staged, payload);
  console.log("Canonical v2 candidate staged at 0% and verified.");
}

async function collectZeroTrafficSmoke(candidateVersionId) {
  const overrideValue = versionOverrideHeader(candidateVersionId);
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: "cutover-smoke",
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "mycontext-cutover-gate",
        version: "1.0.0"
      }
    }
  });
  const commonMcpHeaders = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    Origin: "https://invalid-origin.example"
  };
  const [normalHealth, overrideHealth, normalInvalidOrigin, overrideInvalidOrigin] =
    await Promise.all([
      fetch(`${PRIMARY_ORIGIN}/healthz`, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      }),
      fetch(`${PRIMARY_ORIGIN}/healthz`, {
        headers: {
          [VERSION_OVERRIDE_HEADER]: overrideValue
        },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      }),
      fetch(`${PRIMARY_ORIGIN}/mcp`, {
        method: "POST",
        headers: commonMcpHeaders,
        body: initializeBody,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      }),
      fetch(`${PRIMARY_ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          ...commonMcpHeaders,
          [VERSION_OVERRIDE_HEADER]: overrideValue
        },
        body: initializeBody,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000)
      })
    ]);
  const evidence = {
    checkedAt: new Date().toISOString(),
    overrideHeader: {
      name: VERSION_OVERRIDE_HEADER,
      value: overrideValue
    },
    statuses: {
      normalHealth: normalHealth.status,
      overrideHealth: overrideHealth.status,
      normalInvalidOriginMcp: normalInvalidOrigin.status,
      overrideInvalidOriginMcp: overrideInvalidOrigin.status
    }
  };
  invariant(
    evidence.statuses.normalHealth === 200 &&
      evidence.statuses.overrideHealth === 200 &&
      evidence.statuses.normalInvalidOriginMcp === 401 &&
      evidence.statuses.overrideInvalidOriginMcp === 403,
    "0% override smoke did not prove the v2 Origin-policy response differential"
  );
  return Object.freeze(evidence);
}

export function assertSmokeEvidence(
  smokePayload,
  candidateEnvelope,
  { now = Date.now(), maximumAgeMs = 30 * 60 * 1_000 } = {}
) {
  invariant(isObject(smokePayload), "smoke manifest payload is invalid");
  invariant(
    smokePayload.candidateIntegritySha256 ===
      candidateEnvelope.integritySha256 &&
      smokePayload.candidateVersionId ===
        candidateEnvelope.payload.candidateVersion.id &&
      smokePayload.candidateVersionEtag ===
        candidateEnvelope.payload.candidateVersion.etag,
    "smoke manifest does not match the candidate manifest"
  );
  const checkedAt = Date.parse(smokePayload.evidence?.checkedAt);
  invariant(
    Number.isFinite(checkedAt) &&
      checkedAt <= now &&
      now - checkedAt <= maximumAgeMs,
    "0% smoke evidence is stale or has an invalid timestamp"
  );
  invariant(
    sameValue(smokePayload.evidence.statuses, {
      normalHealth: 200,
      overrideHealth: 200,
      normalInvalidOriginMcp: 401,
      overrideInvalidOriginMcp: 403
    }) &&
      smokePayload.evidence.overrideHeader?.name === VERSION_OVERRIDE_HEADER &&
      smokePayload.evidence.overrideHeader?.value ===
        versionOverrideHeader(candidateEnvelope.payload.candidateVersion.id),
    "0% smoke evidence does not prove the pinned candidate response differential"
  );
  return true;
}

async function smokeCandidate(options) {
  const { candidate, current } = await loadCandidateAndState(options);
  const payload = candidate.envelope.payload;
  assertStagedState(current, payload);
  const evidence = await collectZeroTrafficSmoke(payload.candidateVersion.id);
  const finalState = await captureRemoteState();
  assertStagedState(finalState, payload);
  await writePrivateManifest(
    requiredOption(options, "smoke-manifest"),
    "smoke",
    {
      repository: payload.repository,
      candidateIntegritySha256: candidate.envelope.integritySha256,
      candidateVersionId: payload.candidateVersion.id,
      candidateVersionEtag: payload.candidateVersion.etag,
      stagedDeploymentId: finalState.primary.activeDeployment.id,
      evidence
    }
  );
  console.log("0% override smoke evidence sealed.");
}

async function promoteCandidate(options) {
  const { candidate, current } = await loadCandidateAndState(options);
  const payload = candidate.envelope.payload;
  assertStagedState(current, payload);
  const smoke = await readPrivateManifest(
    requiredOption(options, "smoke-manifest"),
    "smoke"
  );
  assertSmokeEvidence(smoke.envelope.payload, candidate.envelope);
  invariant(
    smoke.envelope.payload.stagedDeploymentId ===
      current.primary.activeDeployment.id,
    "staged deployment changed after smoke evidence capture"
  );
  await collectZeroTrafficSmoke(payload.candidateVersion.id);
  await revalidateRepository(payload.repository);
  const finalPromotionState = await captureRemoteState();
  assertStagedState(finalPromotionState, payload);
  invariant(
    finalPromotionState.primary.activeDeployment.id ===
      smoke.envelope.payload.stagedDeploymentId,
    "staged deployment changed immediately before promotion"
  );
  runReleaseCommand(
    buildPromoteCommand({
      v2VersionId: payload.candidateVersion.id,
      message: requiredOption(options, "message")
    })
  );
  const promoted = await captureRemoteState();
  assertPromotedState(promoted, payload);
  await assertPublicUnauthenticated(PRIMARY_ORIGIN);
  await assertPublicUnauthenticated(PRESERVED_V1_ORIGIN);
  console.log("Canonical v2 promoted to 100%; preserved v1 remains healthy.");
}

async function rollbackCandidate(options) {
  const { candidate, current } = await loadCandidateAndState(options);
  const payload = candidate.envelope.payload;
  try {
    assertRolledBackState(current, payload);
    console.log("Canonical Worker is already fully rolled back.");
    return;
  } catch (error) {
    if (!(error instanceof CutoverGateError)) throw error;
  }

  let needsRollbackCommand = true;
  try {
    assertRollbackPendingSubdomainState(current, payload);
    needsRollbackCommand = false;
  } catch (error) {
    if (!(error instanceof CutoverGateError)) throw error;
  }
  if (needsRollbackCommand) {
    let recognizedTrafficState = false;
    try {
      assertStagedState(current, payload);
      recognizedTrafficState = true;
    } catch (error) {
      if (!(error instanceof CutoverGateError)) throw error;
    }
    if (!recognizedTrafficState) {
      assertPromotedState(current, payload);
    }
    await revalidateRepository(payload.repository);
    const finalRollbackSource = await captureRemoteState();
    let finalSourceRecognized = false;
    try {
      assertStagedState(finalRollbackSource, payload);
      finalSourceRecognized = true;
    } catch (error) {
      if (!(error instanceof CutoverGateError)) throw error;
    }
    if (!finalSourceRecognized) {
      assertPromotedState(finalRollbackSource, payload);
    }
    runReleaseCommand(
      buildRollbackCommand({
        v1VersionId: payload.primaryV1Version.id,
        message: requiredOption(options, "message")
      })
    );
  }
  const rollbackCodeState = await captureRemoteState();
  try {
    assertRolledBackState(rollbackCodeState, payload);
  } catch (error) {
    if (!(error instanceof CutoverGateError)) throw error;
    assertRollbackPendingSubdomainState(rollbackCodeState, payload);
    await revalidateRepository(payload.repository);
    const finalSubdomainState = await captureRemoteState();
    assertRollbackPendingSubdomainState(finalSubdomainState, payload);
    await setPrimarySubdomain(true);
  }
  const rolledBack = await captureRemoteState();
  assertRolledBackState(rolledBack, payload);
  await assertPublicUnauthenticated(PRIMARY_ORIGIN);
  await assertPublicUnauthenticated(PRESERVED_V1_ORIGIN);
  console.log("Canonical Worker rolled back to captured v1; v1 alias remains healthy.");
}

async function verifyCandidatePhase(command, options) {
  const { candidate, current } = await loadCandidateAndState(options);
  if (command === "verify-candidate") {
    assertCandidatePreStageState(current, candidate.envelope.payload);
  } else if (command === "verify-stage") {
    assertStagedState(current, candidate.envelope.payload);
  } else if (command === "verify-promotion") {
    assertPromotedState(current, candidate.envelope.payload);
  } else if (command === "verify-rollback") {
    assertRolledBackState(current, candidate.envelope.payload);
  }
  console.log(`${command} passed.`);
}

async function main(argv) {
  const [command, ...rawOptions] = argv;
  const options = parseOptions(rawOptions);
  if (command === "capture") {
    await captureBaseline(options);
  } else if (command === "deploy-alias") {
    await deployPreservedV1(options);
  } else if (command === "recover-alias") {
    await recoverPreservedV1Manifest(options);
  } else if (command === "upload") {
    await uploadCandidate(options);
  } else if (command === "stage") {
    await stageCandidate(options);
  } else if (command === "smoke") {
    await smokeCandidate(options);
  } else if (command === "promote") {
    await promoteCandidate(options);
  } else if (command === "rollback") {
    await rollbackCandidate(options);
  } else if (
    [
      "verify-candidate",
      "verify-stage",
      "verify-promotion",
      "verify-rollback"
    ].includes(command)
  ) {
    await verifyCandidatePhase(command, options);
  } else {
    throw new CutoverGateError(
      "Usage: release-cutover-gate.mjs " +
        "<capture|deploy-alias|recover-alias|upload|stage|smoke|promote|rollback|" +
        "verify-candidate|verify-stage|verify-promotion|verify-rollback> ..."
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      error instanceof CutoverGateError
        ? error.message
        : "release cutover gate failed unexpectedly"
    );
    process.exitCode = 1;
  });
}
