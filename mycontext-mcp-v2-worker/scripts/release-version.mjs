#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  unlink
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPostdeployState,
  assertPredeployStateUnchanged,
  assertTrafficDeploymentState,
  assertUploadPreservedInvariants,
  assertUploadReadyState,
  captureCloudflareState,
  findUniqueTargetVersionByTagAndMessage,
  listAllTargetVersions,
  parsePrivateBaseline,
  serializeCanonicalPrivateBaseline
} from "./verify-cloudflare.mjs";

export const EXPECTED_WRANGLER_VERSION = "4.107.0";
export const EXPECTED_PNPM_VERSION = "11.7.0";
export const WORKER_NAME = "mycontext-mcp-v2";
export const WRANGLER_CONFIG = "./wrangler.jsonc";
export const CRON_TRIGGER = "17 4 * * *";
export const COMMAND_TIMEOUT_MS = 120_000;

export const REQUIRED_SECRET_KEYS = Object.freeze([
  "TIDB_DATABASE_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_ALLOWED_USER_ID"
]);
export const OPTIONAL_SECRET_KEYS = Object.freeze(["PERSONAL_SYNONYMS"]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_DIRECTORY = path.resolve(scriptDirectory, "..");
export const REPOSITORY_ROOT = path.resolve(WORKER_DIRECTORY, "..");
const workerDirectoryName = path.basename(WORKER_DIRECTORY);
const legacyDirectoryName = "mycontext-mcp-worker";
const maximumSecretsFileBytes = 64 * 1024;
const maximumManifestFileBytes = 64 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const accountIdPattern = /^[0-9a-f]{32}$/;
const runIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const manifestKeys = Object.freeze([
  "schemaVersion",
  "accountId",
  "workerName",
  "headCommit",
  "legacySourceCommit",
  "legacyWorkerTree",
  "newWorkerTree",
  "lockSha256",
  "runId",
  "tag",
  "message",
  "versionId",
  "etag",
  "legacyBaselineSha256",
  "privateBaseline",
  "cloudflarePredeployState"
]);

export class ReleaseSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseSafetyError";
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new ReleaseSafetyError(message);
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function skipWhitespace(source, start) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) {
    index += 1;
  }
  return index;
}

function parseJsonString(source, start) {
  assert(source[start] === "\"", "secrets JSON keys and values must be strings");
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\"") {
      const encoded = source.slice(start, index + 1);
      try {
        const value = JSON.parse(encoded);
        assert(typeof value === "string", "secrets JSON contains a non-string value");
        return { value, nextIndex: index + 1 };
      } catch (error) {
        if (error instanceof ReleaseSafetyError) {
          throw error;
        }
        throw new ReleaseSafetyError("secrets JSON contains an invalid string escape");
      }
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    assert(
      character.charCodeAt(0) >= 0x20,
      "secrets JSON contains an invalid control character"
    );
    index += 1;
  }
  throw new ReleaseSafetyError("secrets JSON contains an unterminated string");
}

export function parseSecretsJson(source) {
  assert(typeof source === "string", "secrets JSON must be UTF-8 text");
  let index = skipWhitespace(source, 0);
  assert(source[index] === "{", "secrets JSON must be a top-level object");
  index = skipWhitespace(source, index + 1);

  const entries = new Map();
  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    assert(index === source.length, "secrets JSON contains trailing content");
  } else {
    while (index < source.length) {
      const parsedKey = parseJsonString(source, index);
      const key = parsedKey.value;
      assert(
        !entries.has(key),
        `secrets JSON contains duplicate key: ${JSON.stringify(key)}`
      );

      index = skipWhitespace(source, parsedKey.nextIndex);
      assert(source[index] === ":", "secrets JSON is missing a key/value separator");
      index = skipWhitespace(source, index + 1);

      const parsedValue = parseJsonString(source, index);
      entries.set(key, parsedValue.value);
      index = skipWhitespace(source, parsedValue.nextIndex);

      if (source[index] === "}") {
        index = skipWhitespace(source, index + 1);
        assert(index === source.length, "secrets JSON contains trailing content");
        break;
      }
      assert(source[index] === ",", "secrets JSON entries must be comma-separated");
      index = skipWhitespace(source, index + 1);
      assert(source[index] !== "}", "secrets JSON must not contain a trailing comma");
    }
  }

  const allowedKeys = new Set([...REQUIRED_SECRET_KEYS, ...OPTIONAL_SECRET_KEYS]);
  for (const [key, value] of entries) {
    assert(
      allowedKeys.has(key),
      `secrets JSON contains unapproved key: ${JSON.stringify(key)}`
    );
    assert(value.trim().length > 0, `secrets JSON value must be non-empty: ${key}`);
  }
  for (const key of REQUIRED_SECRET_KEYS) {
    assert(entries.has(key), `secrets JSON is missing required key: ${key}`);
  }

  return Object.freeze(Object.fromEntries(entries));
}

function safeFileMode(fileStat) {
  return fileStat.mode & 0o777;
}

function fileFingerprint(fileStat, contents) {
  return Object.freeze({
    device: String(fileStat.dev),
    inode: String(fileStat.ino),
    size: fileStat.size,
    modifiedAt: fileStat.mtimeMs,
    mode: safeFileMode(fileStat),
    sha256: sha256(contents)
  });
}

export async function inspectSecretsFile(
  suppliedPath,
  {
    repositoryRoot = REPOSITORY_ROOT,
    lstatFile = lstat,
    realpathFile = realpath,
    openFile = open
  } = {}
) {
  assert(
    typeof suppliedPath === "string" && path.isAbsolute(suppliedPath),
    "--secrets-file must be an absolute path"
  );

  const suppliedStat = await lstatFile(suppliedPath);
  assert(!suppliedStat.isSymbolicLink(), "secrets file must not be a symlink");
  assert(suppliedStat.isFile(), "secrets file must be a regular file");

  const canonicalPath = await realpathFile(suppliedPath);
  const canonicalRepositoryRoot = await realpathFile(repositoryRoot);
  assert(
    !isInside(canonicalRepositoryRoot, canonicalPath),
    "secrets file must be outside the repository"
  );
  assert(
    path.extname(canonicalPath).toLowerCase() === ".json",
    "secrets file must use the .json extension"
  );

  const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await openFile(
    canonicalPath,
    fsConstants.O_RDONLY | noFollowFlag
  );
  let contents;
  let openedStat;
  try {
    openedStat = await handle.stat();
    assert(openedStat.isFile(), "secrets file must remain a regular file");
    assert(
      safeFileMode(openedStat) === 0o600,
      "secrets file permissions must be exactly 0600"
    );
    assert(openedStat.nlink === 1, "secrets file must not be hard-linked");
    assert(
      openedStat.size <= maximumSecretsFileBytes,
      `secrets file must not exceed ${maximumSecretsFileBytes} bytes`
    );
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }

  assert(
    String(suppliedStat.dev) === String(openedStat.dev) &&
      String(suppliedStat.ino) === String(openedStat.ino),
    "secrets file changed while it was being validated"
  );

  return Object.freeze({
    path: canonicalPath,
    secrets: parseSecretsJson(contents),
    fingerprint: fileFingerprint(openedStat, contents)
  });
}

async function canonicalExternalJsonPath(
  suppliedPath,
  {
    repositoryRoot,
    lstatFile,
    realpathFile,
    label,
    mustExist
  }
) {
  assert(
    typeof suppliedPath === "string" && path.isAbsolute(suppliedPath),
    `--${label}-file must be an absolute path`
  );
  assert(
    path.extname(suppliedPath).toLowerCase() === ".json",
    `${label} file must use the .json extension`
  );

  const canonicalRepositoryRoot = await realpathFile(repositoryRoot);
  const suppliedParent = path.dirname(suppliedPath);
  const parentStat = await lstatFile(suppliedParent);
  assert(
    !parentStat.isSymbolicLink() && parentStat.isDirectory(),
    `${label} parent must be an existing non-symlink directory`
  );
  assert(
    (safeFileMode(parentStat) & 0o077) === 0,
    `${label} parent must not grant group or other permissions`
  );
  if (typeof process.getuid === "function") {
    assert(
      parentStat.uid === process.getuid(),
      `${label} parent must be owned by the current user`
    );
  }
  const canonicalParent = await realpathFile(suppliedParent);
  assert(
    !isInside(canonicalRepositoryRoot, canonicalParent),
    `${label} parent must be outside the repository`
  );

  if (mustExist) {
    const suppliedStat = await lstatFile(suppliedPath);
    assert(!suppliedStat.isSymbolicLink(), `${label} file must not be a symlink`);
    assert(suppliedStat.isFile(), `${label} file must be a regular file`);
    const canonicalPath = await realpathFile(suppliedPath);
    assert(
      !isInside(canonicalRepositoryRoot, canonicalPath),
      `${label} file must be outside the repository`
    );
    return { canonicalPath, suppliedStat };
  }

  const canonicalPath = path.join(canonicalParent, path.basename(suppliedPath));
  assert(
    !isInside(canonicalRepositoryRoot, canonicalPath),
    `${label} destination must be outside the repository`
  );

  try {
    await lstatFile(canonicalPath);
  } catch (error) {
    assert(
      error?.code === "ENOENT",
      `${label} destination could not be inspected safely`
    );
    return { canonicalPath };
  }
  throw new ReleaseSafetyError(
    `${label} destination must not already exist`
  );
}

export async function inspectManifestDestination(
  suppliedPath,
  {
    repositoryRoot = REPOSITORY_ROOT,
    lstatFile = lstat,
    realpathFile = realpath
  } = {}
) {
  const { canonicalPath } = await canonicalExternalJsonPath(suppliedPath, {
    repositoryRoot,
    lstatFile,
    realpathFile,
    label: "manifest",
    mustExist: false
  });
  return Object.freeze({ path: canonicalPath });
}

export async function inspectPrivateBaselineFile(
  suppliedPath,
  {
    repositoryRoot = REPOSITORY_ROOT,
    lstatFile = lstat,
    realpathFile = realpath,
    openFile = open
  } = {}
) {
  const { canonicalPath, suppliedStat } = await canonicalExternalJsonPath(
    suppliedPath,
    {
      repositoryRoot,
      lstatFile,
      realpathFile,
      label: "cloudflare baseline",
      mustExist: true
    }
  );
  const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await openFile(
    canonicalPath,
    fsConstants.O_RDONLY | noFollowFlag
  );
  let contents;
  let openedStat;
  try {
    openedStat = await handle.stat();
    assert(
      openedStat.isFile(),
      "cloudflare baseline must remain a regular file"
    );
    assert(
      safeFileMode(openedStat) === 0o400,
      "cloudflare baseline permissions must be exactly 0400"
    );
    if (typeof process.getuid === "function") {
      assert(
        openedStat.uid === process.getuid(),
        "cloudflare baseline must be owned by the current user"
      );
    }
    assert(
      openedStat.nlink === 1,
      "cloudflare baseline must not be hard-linked"
    );
    assert(
      openedStat.size <= maximumManifestFileBytes,
      `cloudflare baseline must not exceed ${maximumManifestFileBytes} bytes`
    );
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  assert(
    String(suppliedStat.dev) === String(openedStat.dev) &&
      String(suppliedStat.ino) === String(openedStat.ino),
    "cloudflare baseline changed while it was being validated"
  );
  const privateBaseline = parsePrivateBaseline(contents);
  const canonical = serializeCanonicalPrivateBaseline(privateBaseline);
  return Object.freeze({
    path: canonicalPath,
    privateBaseline,
    canonical,
    sha256: sha256(canonical),
    fingerprint: fileFingerprint(openedStat, contents)
  });
}

function parseReleaseManifest(source) {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new ReleaseSafetyError("manifest file must contain valid JSON");
  }
  assert(
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest),
    "manifest file must contain a top-level object"
  );
  const missingKeys = manifestKeys.filter(
    (key) => !Object.hasOwn(manifest, key)
  );
  assert(
    missingKeys.length === 0,
    `manifest file is missing schemaVersion 1 fields: ${missingKeys.join(", ")}`
  );
  assert(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  assert(
    accountIdPattern.test(manifest.accountId),
    "manifest accountId is invalid"
  );
  assert(manifest.workerName === WORKER_NAME, "manifest workerName is invalid");
  requireGitObject(manifest.headCommit, "manifest HEAD");
  requireGitObject(manifest.legacySourceCommit, "manifest legacy source commit");
  requireGitObject(manifest.legacyWorkerTree, "manifest legacy Worker tree");
  requireGitObject(manifest.newWorkerTree, "manifest new Worker tree");
  assert(
    sha256Pattern.test(manifest.lockSha256),
    "manifest lockfile SHA-256 is invalid"
  );
  assert(
    runIdPattern.test(manifest.runId),
    "manifest runId is invalid"
  );
  assert(
    typeof manifest.tag === "string" && manifest.tag.length > 0,
    "manifest tag is invalid"
  );
  assert(
    typeof manifest.message === "string" && manifest.message.length > 0,
    "manifest message is invalid"
  );
  assert(uuidPattern.test(manifest.versionId), "manifest versionId is invalid");
  assert(
    typeof manifest.etag === "string" && manifest.etag.length > 0,
    "manifest etag is invalid"
  );
  assert(
    sha256Pattern.test(manifest.legacyBaselineSha256),
    "manifest legacy baseline SHA-256 is invalid"
  );
  const canonicalPrivateBaseline = serializeCanonicalPrivateBaseline(
    parsePrivateBaseline(manifest.privateBaseline)
  );
  assert(
    sha256(canonicalPrivateBaseline) === manifest.legacyBaselineSha256,
    "manifest private baseline does not match its SHA-256"
  );
  assert(
    manifest.privateBaseline.accountId === manifest.accountId,
    "manifest private baseline account does not match manifest account"
  );
  assert(
    manifest.cloudflarePredeployState !== null &&
      typeof manifest.cloudflarePredeployState === "object" &&
      !Array.isArray(manifest.cloudflarePredeployState),
    "manifest Cloudflare predeploy state is invalid"
  );
  assert(
    manifest.cloudflarePredeployState.schemaVersion === 1 &&
      manifest.cloudflarePredeployState.accountId === manifest.accountId,
    "manifest Cloudflare predeploy state account or schema is invalid"
  );
  return Object.freeze({ ...manifest });
}

export async function inspectManifestFile(
  suppliedPath,
  {
    repositoryRoot = REPOSITORY_ROOT,
    lstatFile = lstat,
    realpathFile = realpath,
    openFile = open
  } = {}
) {
  const { canonicalPath, suppliedStat } = await canonicalExternalJsonPath(
    suppliedPath,
    {
      repositoryRoot,
      lstatFile,
      realpathFile,
      label: "manifest",
      mustExist: true
    }
  );

  const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await openFile(
    canonicalPath,
    fsConstants.O_RDONLY | noFollowFlag
  );
  let contents;
  let openedStat;
  try {
    openedStat = await handle.stat();
    assert(openedStat.isFile(), "manifest file must remain a regular file");
    assert(
      safeFileMode(openedStat) === 0o400,
      "manifest file permissions must be exactly 0400"
    );
    assert(openedStat.nlink === 1, "manifest file must not be hard-linked");
    assert(
      openedStat.size <= maximumManifestFileBytes,
      `manifest file must not exceed ${maximumManifestFileBytes} bytes`
    );
    contents = await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
  assert(
    String(suppliedStat.dev) === String(openedStat.dev) &&
      String(suppliedStat.ino) === String(openedStat.ino),
    "manifest file changed while it was being validated"
  );

  return Object.freeze({
    path: canonicalPath,
    manifest: parseReleaseManifest(contents),
    fingerprint: fileFingerprint(openedStat, contents)
  });
}

export async function reserveReleaseManifest(
  destinationPath,
  { openFile = open } = {}
) {
  const noFollowFlag = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await openFile(
    destinationPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      noFollowFlag,
    0o600
  );
  try {
    await handle.chmod(0o600);
    const reservedStat = await handle.stat();
    assert(
      reservedStat.isFile(),
      "manifest reservation is not a regular file"
    );
    assert(
      safeFileMode(reservedStat) === 0o600,
      "manifest reservation permissions must be exactly 0600"
    );
    assert(
      reservedStat.nlink === 1,
      "manifest reservation must not be hard-linked"
    );
    return {
      path: destinationPath,
      handle,
      device: String(reservedStat.dev),
      inode: String(reservedStat.ino),
      closed: false
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function closeReservation(reservation) {
  if (!reservation.closed) {
    reservation.closed = true;
    await reservation.handle.close();
  }
}

export async function writeReleaseManifest(reservation, manifest) {
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  assert(
    !REQUIRED_SECRET_KEYS.some((key) => Object.hasOwn(manifest, key)) &&
      !OPTIONAL_SECRET_KEYS.some((key) => Object.hasOwn(manifest, key)),
    "release manifest must not contain secrets"
  );
  parseReleaseManifest(serialized);
  assert(
    reservation !== null &&
      typeof reservation === "object" &&
      typeof reservation.path === "string" &&
      reservation.closed === false,
    "manifest reservation is not open"
  );

  try {
    const beforeWriteStat = await reservation.handle.stat();
    assert(
      String(beforeWriteStat.dev) === reservation.device &&
        String(beforeWriteStat.ino) === reservation.inode &&
        beforeWriteStat.nlink === 1 &&
        safeFileMode(beforeWriteStat) === 0o600,
      "manifest reservation changed before capture"
    );
    await reservation.handle.writeFile(serialized, "utf8");
    if (typeof reservation.handle.sync === "function") {
      await reservation.handle.sync();
    }
    await reservation.handle.chmod(0o400);
    if (typeof reservation.handle.sync === "function") {
      await reservation.handle.sync();
    }
    const writtenStat = await reservation.handle.stat();
    assert(writtenStat.isFile(), "manifest destination is not a regular file");
    assert(
      safeFileMode(writtenStat) === 0o400,
      "manifest destination could not be made read-only"
    );
    assert(
      writtenStat.nlink === 1,
      "manifest destination must not be hard-linked"
    );
  } finally {
    await closeReservation(reservation);
  }
}

export async function writePendingReleaseReservation(reservation, pending) {
  assert(
    reservation !== null &&
      typeof reservation === "object" &&
      reservation.closed === false,
    "manifest reservation is not open"
  );
  const recoveryRecord = Object.freeze({
    schemaVersion: 1,
    state: "pending-recovery",
    ...pending
  });
  const serialized = `${JSON.stringify(recoveryRecord, null, 2)}\n`;
  try {
    await reservation.handle.writeFile(serialized, "utf8");
    if (typeof reservation.handle.sync === "function") {
      await reservation.handle.sync();
    }
    const pendingStat = await reservation.handle.stat();
    assert(
      String(pendingStat.dev) === reservation.device &&
        String(pendingStat.ino) === reservation.inode &&
        pendingStat.nlink === 1 &&
        safeFileMode(pendingStat) === 0o600,
      "pending manifest reservation changed during recovery capture"
    );
  } finally {
    await closeReservation(reservation);
  }
}

export async function discardReleaseManifestReservation(
  reservation,
  { lstatFile = lstat, unlinkFile = unlink } = {}
) {
  await closeReservation(reservation);
  const currentStat = await lstatFile(reservation.path);
  assert(
    !currentStat.isSymbolicLink() &&
      currentStat.isFile() &&
      String(currentStat.dev) === reservation.device &&
      String(currentStat.ino) === reservation.inode,
    "manifest reservation path changed before cleanup"
  );
  await unlinkFile(reservation.path);
}

function sameFingerprint(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.mode === right.mode &&
    left.sha256 === right.sha256
  );
}

export function validateReleaseEnvironment(environment) {
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID?.trim() ?? "";
  const apiToken = environment.CLOUDFLARE_API_TOKEN?.trim() ?? "";
  const apiKey = environment.CLOUDFLARE_API_KEY?.trim() ?? "";
  const email = environment.CLOUDFLARE_EMAIL?.trim() ?? "";

  assert(
    accountIdPattern.test(accountId),
    "CLOUDFLARE_ACCOUNT_ID must be a non-empty 32-character lowercase hex ID"
  );

  const tokenAuth = apiToken.length > 0;
  const keyAuth = apiKey.length > 0 || email.length > 0;
  assert(
    tokenAuth !== keyAuth,
    "set exactly one Cloudflare authentication method: CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY with CLOUDFLARE_EMAIL"
  );
  if (keyAuth) {
    assert(
      apiKey.length > 0 && email.length > 0,
      "CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL must be set together"
    );
  }

  return Object.freeze({
    accountId,
    redactedValues: Object.freeze(
      [apiToken, apiKey].filter((value) => value.length > 0)
    )
  });
}

function requireGitObject(value, label) {
  assert(gitObjectPattern.test(value), `${label} is not a full Git object ID`);
  return value;
}

export function deriveReleaseIdentity({
  headCommit,
  legacySourceCommit,
  legacyWorkerTree,
  newWorkerTree,
  lockSha256,
  runId
}) {
  requireGitObject(headCommit, "HEAD");
  requireGitObject(legacySourceCommit, "legacy source commit");
  requireGitObject(legacyWorkerTree, "legacy Worker tree");
  requireGitObject(newWorkerTree, "new Worker tree");
  assert(sha256Pattern.test(lockSha256), "lockfile SHA-256 is invalid");
  assert(
    runIdPattern.test(runId),
    "run ID must be a lowercase UUID v4"
  );

  const tag = `mcp-v2-${headCommit.slice(0, 12)}-${runId}`;
  assert(
    Buffer.byteLength(tag, "utf8") <= 100,
    "derived release tag exceeds the 100-byte Cloudflare limit"
  );
  return Object.freeze({
    runId,
    tag,
    message: [
      `head=${headCommit}`,
      `legacy-source=${legacySourceCommit}`,
      `legacy-tree=${legacyWorkerTree}`,
      `new-tree=${newWorkerTree}`,
      `lock-sha256=${lockSha256}`
    ].join(";")
  });
}

export function buildUploadCommand({ secretsFile, tag, message }) {
  assert(path.isAbsolute(secretsFile), "upload secrets path must be absolute");
  return Object.freeze({
    label: "upload-version",
    mutation: true,
    command: "pnpm",
    args: Object.freeze([
      "exec",
      "wrangler",
      "versions",
      "upload",
      "--config",
      WRANGLER_CONFIG,
      "--name",
      WORKER_NAME,
      "--strict",
      "--tag",
      tag,
      "--message",
      message,
      "--secrets-file",
      secretsFile
    ])
  });
}

export function buildDeployCommands({ versionId }) {
  assert(uuidPattern.test(versionId), "--version-id must be a lowercase UUID");
  return Object.freeze({
    view: Object.freeze({
      label: "verify-version",
      mutation: false,
      command: "pnpm",
      args: Object.freeze([
        "exec",
        "wrangler",
        "versions",
        "view",
        versionId,
        "--config",
        WRANGLER_CONFIG,
        "--name",
        WORKER_NAME,
        "--json"
      ])
    }),
    deploy: Object.freeze({
      label: "deploy-version",
      mutation: true,
      command: "pnpm",
      args: Object.freeze([
        "exec",
        "wrangler",
        "versions",
        "deploy",
        "--config",
        WRANGLER_CONFIG,
        "--name",
        WORKER_NAME,
        "--version-id",
        versionId,
        "--percentage",
        "100",
        "--yes"
      ])
    }),
    triggers: Object.freeze({
      label: "deploy-triggers",
      mutation: true,
      command: "pnpm",
      args: Object.freeze([
        "exec",
        "wrangler",
        "triggers",
        "deploy",
        "--config",
        WRANGLER_CONFIG,
        "--name",
        WORKER_NAME,
        "--triggers",
        CRON_TRIGGER
      ])
    })
  });
}

function annotation(record, key) {
  return record?.annotations?.[key];
}

function validateVersionRecord(record, { versionId, expectedTag, expectedMessage }, label) {
  assert(record !== null && typeof record === "object", `${label} is not an object`);
  assert(record.id === versionId, `${label} returned a different version ID`);
  assert(
    annotation(record, "workers/tag") === expectedTag,
    `${label} tag does not match the expected release tag`
  );
  assert(
    annotation(record, "workers/message") === expectedMessage,
    `${label} provenance message does not match the current committed release`
  );
}

export function validateVersionMetadata({
  view,
  apiVersion,
  versionId,
  expectedTag,
  expectedMessage
}) {
  validateVersionRecord(
    view,
    { versionId, expectedTag, expectedMessage },
    "versions view"
  );
  assert(
    apiVersion !== null &&
      typeof apiVersion === "object" &&
      apiVersion.id === versionId,
    "Cloudflare API returned a different version ID"
  );
  assert(
    apiVersion.tag === expectedTag &&
      apiVersion.message === expectedMessage,
    "Cloudflare API release identity does not match"
  );
  assert(
    typeof apiVersion.etag === "string" && apiVersion.etag.length > 0,
    "Cloudflare API version ETag is missing"
  );
}

export function createReleaseManifest({
  accountId,
  preflight,
  runId,
  versionId,
  etag,
  legacyBaselineSha256,
  privateBaseline,
  cloudflarePredeployState
}) {
  const identity = deriveReleaseIdentity({
    ...preflight.provenance,
    runId
  });
  return Object.freeze({
    schemaVersion: 1,
    accountId,
    workerName: WORKER_NAME,
    headCommit: preflight.provenance.headCommit,
    legacySourceCommit: preflight.provenance.legacySourceCommit,
    legacyWorkerTree: preflight.provenance.legacyWorkerTree,
    newWorkerTree: preflight.provenance.newWorkerTree,
    lockSha256: preflight.provenance.lockSha256,
    runId,
    tag: identity.tag,
    message: identity.message,
    versionId,
    etag,
    legacyBaselineSha256,
    privateBaseline,
    cloudflarePredeployState
  });
}

export function validateManifestAgainstPreflight({
  manifest,
  accountId,
  preflight
}) {
  assert(
    manifest.accountId === accountId,
    "manifest accountId does not match the release environment"
  );
  assert(
    manifest.workerName === WORKER_NAME,
    "manifest workerName does not match the release target"
  );
  assert(
    manifest.privateBaseline.accountId === accountId,
    "manifest private baseline account does not match the release environment"
  );
  for (const key of [
    "headCommit",
    "legacySourceCommit",
    "legacyWorkerTree",
    "newWorkerTree",
    "lockSha256"
  ]) {
    assert(
      manifest[key] === preflight.provenance[key],
      `manifest ${key} does not match the current committed release`
    );
  }
  const expectedIdentity = deriveReleaseIdentity({
    ...preflight.provenance,
    runId: manifest.runId
  });
  assert(
    manifest.tag === expectedIdentity.tag,
    "manifest tag does not match its run ID and current HEAD"
  );
  assert(
    manifest.message === expectedIdentity.message,
    "manifest provenance message does not match the current committed release"
  );
  return expectedIdentity;
}

function sameStringSet(actual, expected, label) {
  assert(Array.isArray(actual), `${label} must be an array`);
  assert(
    actual.every((value) => typeof value === "string"),
    `${label} must contain only strings`
  );
  assert(
    new Set(actual).size === actual.length,
    `${label} must not contain duplicates`
  );
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  assert(
    JSON.stringify(sortedActual) === JSON.stringify(sortedExpected),
    `${label} does not match the release configuration`
  );
}

export function expectedVersionResourcesFromConfig(wranglerConfig) {
  assert(
    wranglerConfig?.name === WORKER_NAME,
    `wrangler config must target ${WORKER_NAME}`
  );
  const kvBindings = wranglerConfig.kv_namespaces;
  assert(
    Array.isArray(kvBindings) && kvBindings.length === 2,
    "wrangler config must declare exactly two KV bindings"
  );
  const expectedKv = new Map();
  for (const binding of kvBindings) {
    assert(
      binding !== null &&
        typeof binding === "object" &&
        typeof binding.binding === "string" &&
        typeof binding.id === "string",
      "wrangler config contains an invalid KV binding"
    );
    assert(
      binding.binding === "OAUTH_KV" || binding.binding === "AUTH_KV",
      "wrangler config contains an unexpected KV binding"
    );
    assert(
      !expectedKv.has(binding.binding),
      "wrangler config contains a duplicate KV binding"
    );
    expectedKv.set(binding.binding, binding.id);
  }
  assert(
    expectedKv.has("OAUTH_KV") && expectedKv.has("AUTH_KV"),
    "wrangler config is missing OAUTH_KV or AUTH_KV"
  );
  assert(
    typeof wranglerConfig.compatibility_date === "string" &&
      wranglerConfig.compatibility_date.length > 0,
    "wrangler config compatibility_date is missing"
  );
  assert(
    Array.isArray(wranglerConfig.compatibility_flags),
    "wrangler config compatibility_flags must be an array"
  );

  return Object.freeze({
    kvBindings: expectedKv,
    requiredSecrets: new Set(REQUIRED_SECRET_KEYS),
    optionalSecrets: new Set(OPTIONAL_SECRET_KEYS),
    handlers: Object.freeze(["fetch", "scheduled"]),
    compatibilityDate: wranglerConfig.compatibility_date,
    compatibilityFlags: Object.freeze([...wranglerConfig.compatibility_flags])
  });
}

export function validateVersionResources(versionRecord, expected) {
  const resources = versionRecord?.resources;
  assert(
    resources !== null && typeof resources === "object",
    "versions view is missing resources"
  );
  const bindings = resources.bindings;
  assert(Array.isArray(bindings), "versions view resources.bindings must be an array");

  const seenNames = new Set();
  const seenKv = new Set();
  const seenSecrets = new Set();
  for (const binding of bindings) {
    assert(
      binding !== null &&
        typeof binding === "object" &&
        typeof binding.name === "string" &&
        typeof binding.type === "string",
      "versions view contains an invalid binding"
    );
    assert(
      !seenNames.has(binding.name),
      "versions view contains a duplicate binding name"
    );
    seenNames.add(binding.name);

    if (binding.type === "kv_namespace") {
      const expectedNamespace = expected.kvBindings.get(binding.name);
      assert(
        expectedNamespace !== undefined &&
          binding.namespace_id === expectedNamespace,
        "versions view KV binding does not match wrangler.jsonc"
      );
      seenKv.add(binding.name);
      continue;
    }

    if (binding.type === "secret_text") {
      assert(
        expected.requiredSecrets.has(binding.name) ||
          expected.optionalSecrets.has(binding.name),
        "versions view contains an unexpected secret binding"
      );
      seenSecrets.add(binding.name);
      continue;
    }

    throw new ReleaseSafetyError(
      "versions view contains an unexpected binding type"
    );
  }

  assert(
    seenKv.size === expected.kvBindings.size &&
      [...expected.kvBindings.keys()].every((name) => seenKv.has(name)),
    "versions view is missing an expected KV binding"
  );
  assert(
    [...expected.requiredSecrets].every((name) => seenSecrets.has(name)),
    "versions view is missing a required secret binding"
  );
  assert(
    [...seenSecrets].every(
      (name) =>
        expected.requiredSecrets.has(name) || expected.optionalSecrets.has(name)
    ),
    "versions view contains a secret outside the allowlist"
  );
  assert(
    seenNames.size === seenKv.size + seenSecrets.size,
    "versions view contains an unexpected binding"
  );

  sameStringSet(
    resources.script?.handlers,
    expected.handlers,
    "versions view script handlers"
  );
  assert(
    resources.script_runtime?.compatibility_date === expected.compatibilityDate,
    "versions view compatibility_date does not match wrangler.jsonc"
  );
  sameStringSet(
    resources.script_runtime?.compatibility_flags,
    expected.compatibilityFlags,
    "versions view compatibility_flags"
  );

  const etag = resources.script?.etag;
  assert(
    typeof etag === "string" && etag.length > 0,
    "versions view script etag is missing"
  );
  return Object.freeze({ etag });
}

export function rejectExistingReleaseTag(versions, expectedTag) {
  assert(Array.isArray(versions), "Cloudflare API version list is invalid");
  assert(
    !versions.some((version) => version?.tag === expectedTag),
    "derived release tag already exists; inspect the existing version instead of uploading again"
  );
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new ReleaseSafetyError(`${label} did not return valid JSON`);
  }
}

function redact(value, secretValues) {
  let redacted = String(value ?? "");
  for (const secretValue of secretValues) {
    if (secretValue.length > 0) {
      redacted = redacted.split(secretValue).join("<redacted>");
    }
  }
  return redacted
    .replace(/mysql:\/\/[^@\s]+@/gi, "mysql://<redacted>@")
    .replace(
      /\b(?:[g]ho_|github[_]pat_|s[k]-)[A-Za-z0-9_-]{8,}\b/g,
      "<redacted-token>"
    );
}

export function defaultRunCommand(
  command,
  args,
  { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS }
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGTERM"
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function runChecked(
  runtime,
  command,
  args,
  {
    cwd = runtime.workerDirectory,
    emitOutput = false,
    secretValues = []
  } = {}
) {
  const result = runtime.runCommand(command, args, {
    cwd,
    env: runtime.environment,
    timeoutMs: runtime.commandTimeoutMs
  });
  const allSecrets = [...runtime.environmentRedactions, ...secretValues];
  const stdout = redact(result.stdout, allSecrets);
  const stderr = redact(result.stderr, allSecrets);
  if (result.error !== undefined) {
    if (result.error.code === "ETIMEDOUT") {
      throw new ReleaseSafetyError(`${command} timed out`);
    }
    throw new ReleaseSafetyError(
      `cannot execute ${command}: ${redact(result.error.message, allSecrets)}`
    );
  }
  if (result.status !== 0) {
    const diagnostic = (stderr || stdout || `exit ${String(result.status)}`).trim();
    throw new ReleaseSafetyError(
      `${command} ${args.slice(0, 4).join(" ")} failed: ${diagnostic}`
    );
  }
  if (emitOutput) {
    if (stdout.length > 0) runtime.writeOutput(stdout);
    if (stderr.length > 0) runtime.writeError(stderr);
  }
  return { stdout, stderr };
}

function runMutationAttempt(runtime, command) {
  let result;
  try {
    result = runtime.runCommand(command.command, command.args, {
      cwd: runtime.workerDirectory,
      env: runtime.environment,
      timeoutMs: runtime.commandTimeoutMs
    });
  } catch {
    return Object.freeze({ outcome: "exception" });
  }
  if (result?.error?.code === "ETIMEDOUT" || result?.signal !== undefined && result.signal !== null) {
    return Object.freeze({ outcome: "timeout" });
  }
  if (result?.error !== undefined) {
    return Object.freeze({ outcome: "exception" });
  }
  return Object.freeze({
    outcome: result?.status === 0 ? "zero" : "nonzero"
  });
}

function runGit(runtime, args) {
  return runChecked(runtime, "git", args, {
    cwd: runtime.repositoryRoot
  }).stdout.trim();
}

async function loadBaseline(runtime) {
  const baseline = JSON.parse(
    await runtime.readFile(
      path.join(runtime.workerDirectory, "verification", "migration-baseline.json"),
      "utf8"
    )
  );
  assert(
    baseline.provenanceStatus === "proven-byte-exact",
    "migration baseline provenance is not proven-byte-exact"
  );
  assert(
    baseline.target?.workerName === WORKER_NAME,
    `migration baseline must target ${WORKER_NAME}`
  );
  assert(
    baseline.legacy?.bundle?.wranglerVersion === EXPECTED_WRANGLER_VERSION,
    `migration baseline Wrangler version must be ${EXPECTED_WRANGLER_VERSION}`
  );
  return baseline;
}

async function collectVerifyScripts(runtime) {
  if (runtime.verifyScripts !== undefined) {
    return [...runtime.verifyScripts];
  }
  const entries = await runtime.readdir(
    path.join(runtime.workerDirectory, "scripts"),
    { withFileTypes: true }
  );
  const scripts = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("verify-") &&
        entry.name.endsWith(".mjs") &&
        entry.name !== "verify-cloudflare.mjs"
    )
    .map((entry) => `./scripts/${entry.name}`)
    .sort();
  assert(scripts.length > 0, "no release verification scripts were found");
  return scripts;
}

export async function runLocalPreflight(runtime) {
  const actualCwd = await runtime.realpath(runtime.cwd);
  const actualWorkerDirectory = await runtime.realpath(runtime.workerDirectory);
  assert(
    actualCwd === actualWorkerDirectory,
    `release wrapper must run from ${runtime.workerDirectory}`
  );

  const auth = validateReleaseEnvironment(runtime.environment);
  runtime.environmentRedactions.push(...auth.redactedValues);

  const repositoryTopLevel = await runtime.realpath(
    runGit(runtime, ["rev-parse", "--show-toplevel"])
  );
  const expectedRepositoryRoot = await runtime.realpath(runtime.repositoryRoot);
  assert(
    repositoryTopLevel === expectedRepositoryRoot,
    "release wrapper resolved an unexpected Git repository"
  );

  const headCommit = requireGitObject(
    runGit(runtime, ["rev-parse", "--verify", "HEAD^{commit}"]),
    "HEAD"
  );
  const worktreeStatus = runGit(runtime, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  assert(worktreeStatus === "", "repository must be completely clean before release");

  const baseline = await loadBaseline(runtime);
  const baselineLegacyTree = requireGitObject(
    runGit(runtime, [
      "rev-parse",
      `${baseline.legacy.sourceCommit}:${legacyDirectoryName}`
    ]),
    "baseline legacy Worker tree"
  );
  assert(
    baselineLegacyTree === baseline.legacy.workerTree,
    "recorded legacy Worker tree does not match the source commit"
  );
  const currentLegacyTree = requireGitObject(
    runGit(runtime, ["rev-parse", `HEAD:${legacyDirectoryName}`]),
    "current legacy Worker tree"
  );
  assert(
    currentLegacyTree === baseline.legacy.workerTree,
    "current committed legacy Worker tree drifted from the proven baseline"
  );

  const newWorkerTree = requireGitObject(
    runGit(runtime, ["rev-parse", `HEAD:${workerDirectoryName}`]),
    "new Worker tree"
  );
  const lockContents = await runtime.readFile(
    path.join(runtime.workerDirectory, "pnpm-lock.yaml")
  );
  const lockSha256 = sha256(lockContents);
  let wranglerConfig;
  try {
    wranglerConfig = JSON.parse(
      await runtime.readFile(
        path.join(runtime.workerDirectory, "wrangler.jsonc"),
        "utf8"
      )
    );
  } catch {
    throw new ReleaseSafetyError("wrangler.jsonc must be strict JSON");
  }
  const expectedVersionResources =
    expectedVersionResourcesFromConfig(wranglerConfig);

  const pnpmVersion = runChecked(
    runtime,
    "pnpm",
    ["--version"]
  ).stdout.trim();
  assert(
    pnpmVersion === EXPECTED_PNPM_VERSION,
    `pnpm must be ${EXPECTED_PNPM_VERSION} before pnpm exec is allowed, got ${pnpmVersion || "<unknown>"}`
  );

  const wranglerVersionOutput = runChecked(
    runtime,
    "pnpm",
    ["exec", "wrangler", "--version"]
  ).stdout;
  const version = wranglerVersionOutput.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  assert(
    version === EXPECTED_WRANGLER_VERSION,
    `project-local Wrangler must be ${EXPECTED_WRANGLER_VERSION}, got ${version ?? "<unknown>"}`
  );

  const verifyScripts = await collectVerifyScripts(runtime);
  for (const verifyScript of verifyScripts) {
    runChecked(runtime, process.execPath, [verifyScript]);
  }

  const provenance = Object.freeze({
    headCommit,
    legacySourceCommit: baseline.legacy.sourceCommit,
    legacyWorkerTree: baseline.legacy.workerTree,
    newWorkerTree,
    lockSha256
  });
  return Object.freeze({
    accountId: auth.accountId,
    baseline,
    provenance,
    wranglerConfig,
    expectedVersionResources,
    verifyScripts: Object.freeze(verifyScripts)
  });
}

function parseFlags(tokens, allowedValueFlags, allowedBooleanFlags) {
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    assert(token.startsWith("--"), `unexpected positional argument: ${token}`);
    if (allowedBooleanFlags.has(token)) {
      assert(!booleans.has(token), `duplicate option: ${token}`);
      booleans.add(token);
      continue;
    }
    assert(allowedValueFlags.has(token), `unknown option: ${token}`);
    assert(!values.has(token), `duplicate option: ${token}`);
    const value = tokens[index + 1];
    assert(
      typeof value === "string" && !value.startsWith("--"),
      `option requires a value: ${token}`
    );
    values.set(token, value);
    index += 1;
  }
  return { values, booleans };
}

function requireAbsoluteJsonCliPath(value, option) {
  assert(path.isAbsolute(value), `${option} must be an absolute path`);
  assert(
    path.extname(value).toLowerCase() === ".json",
    `${option} must use the .json extension`
  );
  return value;
}

export function parseCliArguments(argv) {
  const [command, ...tokens] = argv;
  assert(
    command === "plan" || command === "upload" || command === "deploy",
    "usage: release-version.mjs plan | upload --run-id <lowercase-uuid-v4> --manifest-file /absolute/new.json --secrets-file /absolute/file.json --cloudflare-baseline-file /absolute/baseline.json [--plan] | deploy --manifest-file /absolute/manifest.json [--plan]"
  );

  if (command === "plan") {
    assert(tokens.length === 0, "plan does not accept options");
    return Object.freeze({ command, planOnly: true });
  }

  const allowedValueFlags =
    command === "upload"
      ? new Set([
          "--run-id",
          "--manifest-file",
          "--secrets-file",
          "--cloudflare-baseline-file"
        ])
      : new Set(["--manifest-file"]);
  const parsed = parseFlags(tokens, allowedValueFlags, new Set(["--plan"]));
  const planOnly = parsed.booleans.has("--plan");

  if (command === "upload") {
    const runId = parsed.values.get("--run-id");
    const manifestFile = parsed.values.get("--manifest-file");
    const secretsFile = parsed.values.get("--secrets-file");
    const cloudflareBaselineFile = parsed.values.get(
      "--cloudflare-baseline-file"
    );
    assert(runId !== undefined, "upload requires --run-id");
    assert(
      runIdPattern.test(runId),
      "--run-id must be a lowercase UUID v4"
    );
    assert(manifestFile !== undefined, "upload requires --manifest-file");
    assert(secretsFile !== undefined, "upload requires --secrets-file");
    assert(
      cloudflareBaselineFile !== undefined,
      "upload requires --cloudflare-baseline-file"
    );
    return Object.freeze({
      command,
      planOnly,
      runId,
      manifestFile: requireAbsoluteJsonCliPath(
        manifestFile,
        "--manifest-file"
      ),
      secretsFile: requireAbsoluteJsonCliPath(secretsFile, "--secrets-file"),
      cloudflareBaselineFile: requireAbsoluteJsonCliPath(
        cloudflareBaselineFile,
        "--cloudflare-baseline-file"
      )
    });
  }

  const manifestFile = parsed.values.get("--manifest-file");
  assert(manifestFile !== undefined, "deploy requires --manifest-file");
  return Object.freeze({
    command,
    planOnly,
    manifestFile: requireAbsoluteJsonCliPath(
      manifestFile,
      "--manifest-file"
    )
  });
}

export function staticReleasePlan() {
  return Object.freeze({
    cwd: "<worker-directory>",
    workerName: WORKER_NAME,
    config: WRANGLER_CONFIG,
    requiredWranglerVersion: EXPECTED_WRANGLER_VERSION,
    requiredPnpmVersion: EXPECTED_PNPM_VERSION,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
    uploadUsage:
      "upload --run-id <lowercase-uuid-v4> --manifest-file <absolute-new-external-json> --secrets-file <absolute-external-0600-json> --cloudflare-baseline-file <absolute-external-0400-json> [--plan]",
    upload: [
      "pnpm",
      "exec",
      "wrangler",
      "versions",
      "upload",
      "--config",
      WRANGLER_CONFIG,
      "--name",
      WORKER_NAME,
      "--strict",
      "--tag",
      "mcp-v2-<12-char-head>-<run-id>",
      "--message",
      "<derived-provenance-message>",
      "--secrets-file",
      "<absolute-external-0600-json>"
    ],
    privateBaseline: {
      input: "<absolute-external-owner-only-0400-json>",
      digest: "sha256(canonical-private-baseline)",
      deployRereadsInput: false
    },
    captureManifest: {
      path: "<absolute-new-external-json>",
      privateParent: "owned by current user with no group/other permissions",
      reservedBeforeUpload: true,
      createMode: "0600",
      pendingRecoveryMode: "0600",
      finalMode: "0400",
      schemaVersion: 1,
      containsSecrets: false
    },
    verifyUploadIdentity: "complete paginated Cloudflare API version history",
    verifyVersion: [
      [
        "pnpm",
        "exec",
        "wrangler",
        "versions",
        "view",
        "<manifest-version-uuid>",
        "--config",
        WRANGLER_CONFIG,
        "--name",
        WORKER_NAME,
        "--json"
      ]
    ],
    deployUsage:
      "deploy --manifest-file <absolute-external-immutable-0400-json> [--plan]",
    deploy: [
      "pnpm",
      "exec",
      "wrangler",
      "versions",
      "deploy",
      "--config",
      WRANGLER_CONFIG,
      "--name",
      WORKER_NAME,
      "--version-id",
      "<manifest-version-uuid>",
      "--percentage",
      "100",
      "--yes"
    ],
    triggers: [
      "pnpm",
      "exec",
      "wrangler",
      "triggers",
      "deploy",
      "--config",
      WRANGLER_CONFIG,
      "--name",
      WORKER_NAME,
      "--triggers",
      CRON_TRIGGER
    ]
  });
}

function createRuntime(overrides) {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    workerDirectory: overrides.workerDirectory ?? WORKER_DIRECTORY,
    repositoryRoot: overrides.repositoryRoot ?? REPOSITORY_ROOT,
    environment: {
      ...process.env,
      WRANGLER_SEND_METRICS: "false",
      ...(overrides.environment ?? {})
    },
    environmentRedactions: [],
    commandTimeoutMs: overrides.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    runCommand: overrides.runCommand ?? defaultRunCommand,
    readFile: overrides.readFile ?? readFile,
    readdir: overrides.readdir ?? readdir,
    realpath: overrides.realpath ?? realpath,
    inspectSecretsFile: overrides.inspectSecretsFile ?? inspectSecretsFile,
    inspectManifestDestination:
      overrides.inspectManifestDestination ?? inspectManifestDestination,
    inspectManifestFile:
      overrides.inspectManifestFile ?? inspectManifestFile,
    inspectPrivateBaselineFile:
      overrides.inspectPrivateBaselineFile ?? inspectPrivateBaselineFile,
    reserveReleaseManifest:
      overrides.reserveReleaseManifest ?? reserveReleaseManifest,
    writeReleaseManifest:
      overrides.writeReleaseManifest ?? writeReleaseManifest,
    writePendingReleaseReservation:
      overrides.writePendingReleaseReservation ??
      writePendingReleaseReservation,
    discardReleaseManifestReservation:
      overrides.discardReleaseManifestReservation ??
      discardReleaseManifestReservation,
    cloudflare: {
      captureCloudflareState:
        overrides.cloudflare?.captureCloudflareState ?? captureCloudflareState,
      listAllTargetVersions:
        overrides.cloudflare?.listAllTargetVersions ?? listAllTargetVersions,
      findUniqueTargetVersionByTagAndMessage:
        overrides.cloudflare?.findUniqueTargetVersionByTagAndMessage ??
        findUniqueTargetVersionByTagAndMessage,
      assertUploadReadyState:
        overrides.cloudflare?.assertUploadReadyState ?? assertUploadReadyState,
      assertUploadPreservedInvariants:
        overrides.cloudflare?.assertUploadPreservedInvariants ??
        assertUploadPreservedInvariants,
      assertPredeployStateUnchanged:
        overrides.cloudflare?.assertPredeployStateUnchanged ??
        assertPredeployStateUnchanged,
      assertTrafficDeploymentState:
        overrides.cloudflare?.assertTrafficDeploymentState ??
        assertTrafficDeploymentState,
      assertPostdeployState:
        overrides.cloudflare?.assertPostdeployState ?? assertPostdeployState
    },
    fetchImpl: overrides.fetchImpl,
    verifyScripts: overrides.verifyScripts,
    writeOutput:
      overrides.writeOutput ?? ((value) => process.stdout.write(value)),
    writeError:
      overrides.writeError ?? ((value) => process.stderr.write(value))
  };
}

function cloudflareOptions(
  runtime,
  preflight,
  privateBaseline,
  allowTargetMissing
) {
  return {
    environment: runtime.environment,
    migrationBaseline: preflight.baseline,
    wranglerConfig: preflight.wranglerConfig,
    privateBaseline,
    allowTargetMissing,
    fetchImpl: runtime.fetchImpl
  };
}

async function captureRemoteState(
  runtime,
  preflight,
  privateBaseline,
  allowTargetMissing
) {
  return runtime.cloudflare.captureCloudflareState(
    cloudflareOptions(
      runtime,
      preflight,
      privateBaseline,
      allowTargetMissing
    )
  );
}

async function listRemoteVersions(
  runtime,
  preflight,
  privateBaseline,
  allowTargetMissing
) {
  return runtime.cloudflare.listAllTargetVersions(
    cloudflareOptions(
      runtime,
      preflight,
      privateBaseline,
      allowTargetMissing
    )
  );
}

function findReconciledVersion(runtime, versions, identity) {
  const tagMatches = versions.filter((version) => version?.tag === identity.tag);
  assert(
    tagMatches.length === 1,
    "UNKNOWN: release tag is absent or duplicated in the complete API history"
  );
  return runtime.cloudflare.findUniqueTargetVersionByTagAndMessage(versions, {
    tag: identity.tag,
    message: identity.message
  });
}

function assertInitialUploadState(runtime, state, privateBaseline, wranglerConfig) {
  runtime.cloudflare.assertUploadReadyState(state, {
    privateBaseline,
    wranglerConfig
  });
  assert(
    state?.target?.exists === false,
    "upload precondition requires the target Worker to be absent"
  );
}

function stateMatches(assertion) {
  try {
    assertion();
    return true;
  } catch {
    return false;
  }
}

async function verifyCandidateView(
  runtime,
  preflight,
  candidate,
  identity
) {
  const commands = buildDeployCommands({ versionId: candidate.id });
  const viewRecord = parseJsonOutput(
    runChecked(runtime, commands.view.command, commands.view.args).stdout,
    "versions view"
  );
  validateVersionMetadata({
    view: viewRecord,
    apiVersion: candidate,
    versionId: candidate.id,
    expectedTag: identity.tag,
    expectedMessage: identity.message
  });
  const { etag } = validateVersionResources(
    viewRecord,
    preflight.expectedVersionResources
  );
  assert(
    etag === candidate.etag,
    "versions view ETag does not match the complete Cloudflare API history"
  );
  return { commands, etag };
}

export async function executeRelease(argv, overrides = {}) {
  const options = parseCliArguments(argv);
  const runtime = createRuntime(overrides);

  if (options.command === "plan") {
    const actualCwd = await runtime.realpath(runtime.cwd);
    const actualWorkerDirectory = await runtime.realpath(runtime.workerDirectory);
    assert(
      actualCwd === actualWorkerDirectory,
      `release wrapper must run from ${runtime.workerDirectory}`
    );
    runtime.writeOutput(`${JSON.stringify(staticReleasePlan(), null, 2)}\n`);
    return Object.freeze({ command: "plan", executedMutations: 0 });
  }

  const preflight = await runLocalPreflight(runtime);

  if (options.command === "upload") {
    const identity = deriveReleaseIdentity({
      ...preflight.provenance,
      runId: options.runId
    });
    const inspectedBaseline = await runtime.inspectPrivateBaselineFile(
      options.cloudflareBaselineFile,
      { repositoryRoot: runtime.repositoryRoot }
    );
    assert(
      inspectedBaseline.privateBaseline.accountId === preflight.accountId,
      "Cloudflare baseline account does not match the release environment"
    );
    const inspectedDestination = await runtime.inspectManifestDestination(
      options.manifestFile,
      { repositoryRoot: runtime.repositoryRoot }
    );
    const inspectedSecrets = await runtime.inspectSecretsFile(options.secretsFile, {
      repositoryRoot: runtime.repositoryRoot
    });
    const uploadCommand = buildUploadCommand({
      secretsFile: inspectedSecrets.path,
      tag: identity.tag,
      message: identity.message
    });

    if (options.planOnly) {
      runtime.writeOutput(
        `${JSON.stringify({
          command: "upload",
          planOnly: true,
          remoteMutationAttempts: 0,
          checks: [
            "private baseline digest and account",
            "complete API version history",
            "legacy, KV, target absence, traffic, cron, config, preview URLs",
            "post-upload version resources and API ETag"
          ],
          mutation: staticReleasePlan().upload
        }, null, 2)}\n`
      );
      return Object.freeze({ command: "upload", executedMutations: 0 });
    }

    const [preState, preVersions] = await Promise.all([
      captureRemoteState(
        runtime,
        preflight,
        inspectedBaseline.privateBaseline,
        true
      ),
      listRemoteVersions(
        runtime,
        preflight,
        inspectedBaseline.privateBaseline,
        true
      )
    ]);
    assertInitialUploadState(
      runtime,
      preState,
      inspectedBaseline.privateBaseline,
      preflight.wranglerConfig
    );
    rejectExistingReleaseTag(preVersions, identity.tag);

    const recheckedSecrets = await runtime.inspectSecretsFile(inspectedSecrets.path, {
      repositoryRoot: runtime.repositoryRoot
    });
    assert(
      sameFingerprint(inspectedSecrets.fingerprint, recheckedSecrets.fingerprint),
      "secrets file changed after validation"
    );
    const recheckedBaseline = await runtime.inspectPrivateBaselineFile(
      inspectedBaseline.path,
      { repositoryRoot: runtime.repositoryRoot }
    );
    assert(
      sameFingerprint(
        inspectedBaseline.fingerprint,
        recheckedBaseline.fingerprint
      ) &&
        inspectedBaseline.sha256 === recheckedBaseline.sha256,
      "Cloudflare baseline changed after validation"
    );
    const reservation = await runtime.reserveReleaseManifest(
      inspectedDestination.path
    );
    let uploadAttempted = false;
    let capturedVersionId;
    let uploadOutcome = "not-attempted";
    try {
      const [immediateState, immediateVersions] = await Promise.all([
        captureRemoteState(
          runtime,
          preflight,
          inspectedBaseline.privateBaseline,
          true
        ),
        listRemoteVersions(
          runtime,
          preflight,
          inspectedBaseline.privateBaseline,
          true
        )
      ]);
      runtime.cloudflare.assertPredeployStateUnchanged(
        immediateState,
        preState,
        {
          privateBaseline: inspectedBaseline.privateBaseline,
          wranglerConfig: preflight.wranglerConfig
        }
      );
      assertInitialUploadState(
        runtime,
        immediateState,
        inspectedBaseline.privateBaseline,
        preflight.wranglerConfig
      );
      rejectExistingReleaseTag(immediateVersions, identity.tag);

      let reconciledVersionsResult;
      let reconciledStateResult;
      uploadAttempted = true;
      try {
        uploadOutcome = runMutationAttempt(runtime, uploadCommand).outcome;
      } finally {
        [reconciledVersionsResult, reconciledStateResult] =
          await Promise.allSettled([
            listRemoteVersions(
              runtime,
              preflight,
              inspectedBaseline.privateBaseline,
              true
            ),
            captureRemoteState(
              runtime,
              preflight,
              inspectedBaseline.privateBaseline,
              true
            )
          ]);
      }
      assert(
        reconciledVersionsResult.status === "fulfilled" &&
          reconciledStateResult.status === "fulfilled",
        "UNKNOWN: upload outcome could not be reconciled"
      );
      const candidate = findReconciledVersion(
        runtime,
        reconciledVersionsResult.value,
        identity
      );
      capturedVersionId = candidate.id;
      const postUploadState = reconciledStateResult.value;
      runtime.cloudflare.assertUploadPreservedInvariants(
        preState,
        postUploadState,
        {
          privateBaseline: inspectedBaseline.privateBaseline,
          wranglerConfig: preflight.wranglerConfig
        }
      );
      const { etag } = await verifyCandidateView(
        runtime,
        preflight,
        candidate,
        identity
      );
      const manifest = createReleaseManifest({
        accountId: preflight.accountId,
        preflight,
        runId: options.runId,
        versionId: capturedVersionId,
        etag,
        legacyBaselineSha256: inspectedBaseline.sha256,
        privateBaseline: inspectedBaseline.privateBaseline,
        cloudflarePredeployState: postUploadState
      });
      await runtime.writeReleaseManifest(reservation, manifest);
    } catch (error) {
      if (uploadAttempted && reservation.closed === false) {
        await runtime.writePendingReleaseReservation(reservation, {
          status: "UNKNOWN",
          workerName: WORKER_NAME,
          ...preflight.provenance,
          runId: options.runId,
          tag: identity.tag,
          message: identity.message,
          legacyBaselineSha256: inspectedBaseline.sha256,
          privateBaseline: inspectedBaseline.privateBaseline,
          cloudflarePreUploadState: preState,
          capturedVersionId: capturedVersionId ?? null,
          uploadOutcome
        });
        runtime.writeError(
          "UNKNOWN: upload outcome requires recovery with the same run identity; a private pending record was retained.\n"
        );
      } else if (!uploadAttempted) {
        await runtime.discardReleaseManifestReservation(reservation);
      }
      if (uploadAttempted) {
        throw new ReleaseSafetyError(
          "UNKNOWN: upload did not satisfy every reconciled invariant"
        );
      }
      throw error;
    }
    runtime.writeOutput(
      "Upload reconciled: one undeployed target version was verified and the immutable manifest was sealed.\n"
    );
    return Object.freeze({
      command: "upload",
      status: uploadOutcome === "zero" ? "uploaded" : "reconciled",
      executedMutations: 1
    });
  }

  const inspectedManifest = await runtime.inspectManifestFile(
    options.manifestFile,
    { repositoryRoot: runtime.repositoryRoot }
  );
  const expectedIdentity = validateManifestAgainstPreflight({
    manifest: inspectedManifest.manifest,
    accountId: preflight.accountId,
    preflight
  });
  if (options.planOnly) {
    runtime.writeOutput(
      `${JSON.stringify({
        command: "deploy",
        planOnly: true,
        remoteMutationAttempts: 0,
        resumableStates: [
          "predeploy",
          "traffic-selected-cron-empty",
          "final"
        ],
        mutations: [
          staticReleasePlan().deploy,
          staticReleasePlan().triggers
        ]
      }, null, 2)}\n`
    );
    return Object.freeze({ command: "deploy", executedMutations: 0 });
  }

  const privateBaseline = inspectedManifest.manifest.privateBaseline;
  const versions = await listRemoteVersions(
    runtime,
    preflight,
    privateBaseline,
    false
  );
  const remoteMatch = findReconciledVersion(runtime, versions, expectedIdentity);
  assert(
    remoteMatch.id === inspectedManifest.manifest.versionId,
    "manifest version does not match the unique Cloudflare API version"
  );
  assert(
    remoteMatch.etag === inspectedManifest.manifest.etag,
    "manifest ETag does not match the unique Cloudflare API version"
  );
  const { commands, etag } = await verifyCandidateView(
    runtime,
    preflight,
    remoteMatch,
    expectedIdentity
  );

  const recheckedManifest = await runtime.inspectManifestFile(
    inspectedManifest.path,
    { repositoryRoot: runtime.repositoryRoot }
  );
  assert(
    sameFingerprint(
      inspectedManifest.fingerprint,
      recheckedManifest.fingerprint
    ),
    "manifest file changed after validation"
  );
  assert(
    JSON.stringify(inspectedManifest.manifest) ===
      JSON.stringify(recheckedManifest.manifest),
    "manifest contents changed after validation"
  );
  assert(
    etag === inspectedManifest.manifest.etag,
    "manifest ETag does not match versions view"
  );

  const assertionOptions = {
    privateBaseline,
    wranglerConfig: preflight.wranglerConfig,
    selectedVersionId: inspectedManifest.manifest.versionId,
    selectedVersionEtag: inspectedManifest.manifest.etag,
    predeployState: inspectedManifest.manifest.cloudflarePredeployState
  };
  let currentState = await captureRemoteState(
    runtime,
    preflight,
    privateBaseline,
    false
  );
  const matchesFinal = () =>
    stateMatches(() =>
      runtime.cloudflare.assertPostdeployState(currentState, assertionOptions)
    );
  const matchesTraffic = () =>
    stateMatches(() =>
      runtime.cloudflare.assertTrafficDeploymentState(
        currentState,
        assertionOptions
      )
    );
  const matchesPredeploy = () =>
    stateMatches(() =>
      runtime.cloudflare.assertPredeployStateUnchanged(
        currentState,
        inspectedManifest.manifest.cloudflarePredeployState,
        {
          privateBaseline,
          wranglerConfig: preflight.wranglerConfig
        }
      )
    );

  if (matchesFinal()) {
    runtime.writeOutput(
      "Deploy already final: selected traffic and cron invariants are unchanged.\n"
    );
    return Object.freeze({
      command: "deploy",
      status: "already-final",
      executedMutations: 0
    });
  }

  let executedMutations = 0;
  let resumedFromTraffic = false;
  if (matchesTraffic()) {
    resumedFromTraffic = true;
  } else if (matchesPredeploy()) {
    const immediatePredeploy = await captureRemoteState(
      runtime,
      preflight,
      privateBaseline,
      false
    );
    try {
      runtime.cloudflare.assertPredeployStateUnchanged(
        immediatePredeploy,
        inspectedManifest.manifest.cloudflarePredeployState,
        {
          privateBaseline,
          wranglerConfig: preflight.wranglerConfig
        }
      );
    } catch {
      throw new ReleaseSafetyError(
        "PARTIAL: predeploy state changed before traffic mutation"
      );
    }
    let trafficStateResult;
    try {
      runMutationAttempt(runtime, commands.deploy);
      executedMutations += 1;
    } finally {
      trafficStateResult = await Promise.allSettled([
        captureRemoteState(runtime, preflight, privateBaseline, false)
      ]);
    }
    assert(
      trafficStateResult[0].status === "fulfilled",
      "PARTIAL: traffic outcome could not be reconciled"
    );
    currentState = trafficStateResult[0].value;
    try {
      runtime.cloudflare.assertTrafficDeploymentState(
        currentState,
        assertionOptions
      );
    } catch {
      throw new ReleaseSafetyError(
        "PARTIAL: traffic mutation did not reach the required intermediate state"
      );
    }
  } else {
    throw new ReleaseSafetyError(
      "PARTIAL: remote state matches neither predeploy, traffic-intermediate, nor final state"
    );
  }

  const immediateTraffic = await captureRemoteState(
    runtime,
    preflight,
    privateBaseline,
    false
  );
  try {
    runtime.cloudflare.assertTrafficDeploymentState(
      immediateTraffic,
      assertionOptions
    );
  } catch {
    throw new ReleaseSafetyError(
      "PARTIAL: traffic state changed before cron mutation"
    );
  }
  let finalStateResult;
  try {
    runMutationAttempt(runtime, commands.triggers);
    executedMutations += 1;
  } finally {
    finalStateResult = await Promise.allSettled([
      captureRemoteState(runtime, preflight, privateBaseline, false)
    ]);
  }
  assert(
    finalStateResult[0].status === "fulfilled",
    "PARTIAL: cron outcome could not be reconciled"
  );
  try {
    runtime.cloudflare.assertPostdeployState(
      finalStateResult[0].value,
      assertionOptions
    );
  } catch {
    throw new ReleaseSafetyError(
      "PARTIAL: cron mutation did not reach the required final state"
    );
  }
  runtime.writeOutput(
    resumedFromTraffic
      ? "Deploy resumed from verified traffic state and reached final cron state.\n"
      : "Deploy reconciled: selected traffic and cron reached the final state.\n"
  );
  return Object.freeze({
    command: "deploy",
    status: "final",
    executedMutations
  });
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    await executeRelease(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof ReleaseSafetyError
        ? error.message
        : "release wrapper failed with an unexpected error";
    process.stderr.write(`Release blocked: ${message}\n`);
    process.exitCode = 1;
  }
}
