// @ts-check

/**
 * @typedef ReleaseOperations
 * @property {() => Promise<void>} preflight
 * @property {() => Promise<string>} getActiveVersion
 * @property {() => Promise<void>} deploy
 * @property {(previousVersion: string) => Promise<string>} waitForNewVersion
 * @property {(version: string) => Promise<void>} verifyPublic
 * @property {(version: string) => Promise<void>=} verifyRollbackPublic
 * @property {(version: string) => Promise<void>} rollback
 * @property {(version: string) => Promise<unknown>} waitForVersion
 * @property {(message: string) => void=} log
 */

/**
 * Run the canonical release path. A release is complete only after the new
 * active version passes the public MCP transport contract. A post-deploy
 * failure restores and re-verifies the previously active version.
 *
 * @param {ReleaseOperations} operations
 */
export async function runGuardedRelease(operations) {
  const log = operations.log ?? (() => {});
  await operations.preflight();
  const previousVersion = await operations.getActiveVersion();
  log(`Current production version: ${previousVersion}`);

  /** @type {unknown} */
  let deployError;
  try {
    await operations.deploy();
  } catch (error) {
    deployError = error;
  }

  try {
    const deployedVersion = await operations.waitForNewVersion(previousVersion);
    log(`Deployed version: ${deployedVersion}`);
    await operations.verifyPublic(deployedVersion);
    await operations.waitForVersion(deployedVersion);
    if (deployError !== undefined) {
      throw new Error(
        "Wrangler reported a deploy error after production changed; the new version was verified but the release is being rolled back because command completion was ambiguous",
        { cause: deployError }
      );
    }
    return { previousVersion, deployedVersion, rolledBack: false };
  } catch (releaseError) {
    if (deployError !== undefined) {
      /** @type {string | undefined} */
      let activeVersion;
      try {
        activeVersion = await operations.getActiveVersion();
      } catch {
        // Production may have changed even when the status read fails. The
        // conservative action is to restore the known previous version.
      }
      if (activeVersion === previousVersion) {
        throw deployError;
      }
    }
    log(`Post-deploy verification failed; rolling back to ${previousVersion}.`);
    try {
      await operations.rollback(previousVersion);
      await operations.waitForVersion(previousVersion);
      await (operations.verifyRollbackPublic ?? operations.verifyPublic)(previousVersion);
      await operations.waitForVersion(previousVersion);
    } catch (rollbackError) {
      throw new AggregateError(
        [releaseError, rollbackError],
        `Release failed and rollback to ${previousVersion} could not be verified`
      );
    }
    throw new Error(
      `Release verification failed; production was rolled back to ${previousVersion}`,
      { cause: releaseError }
    );
  }
}

/**
 * Cloudflare's canonical production state for this Worker is one version at
 * 100%. Refuse ambiguous/split states rather than guessing a rollback target.
 *
 * @param {unknown} value
 */
export function activeVersionId(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Wrangler deployment status is not an object");
  }
  const versions = /** @type {{ versions?: unknown }} */ (value).versions;
  if (!Array.isArray(versions) || versions.length !== 1) {
    throw new Error("Expected exactly one active Worker version at 100% traffic");
  }
  const version = versions[0];
  if (typeof version !== "object" || version === null || Array.isArray(version)) {
    throw new Error("Active Worker version has an invalid shape");
  }
  const candidate = /** @type {{ version_id?: unknown, percentage?: unknown }} */ (version);
  if (typeof candidate.version_id !== "string" || candidate.percentage !== 100) {
    throw new Error("Expected exactly one active Worker version at 100% traffic");
  }
  return candidate.version_id;
}
