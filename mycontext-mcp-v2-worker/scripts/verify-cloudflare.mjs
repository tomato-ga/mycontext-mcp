#!/usr/bin/env node

const API_BASE_URL = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const WORKER_ID_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KV_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAXIMUM_PAGES = 10_000;

export const PRIVATE_BASELINE_SCHEMA_VERSION = 1;
export const REMOTE_STATE_SCHEMA_VERSION = 1;
export const REQUIRED_TARGET_CRON = "17 4 * * *";
export const API_REQUEST_TIMEOUT_MS = 30_000;

export class CloudflareInvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = "CloudflareInvariantError";
  }
}

function invariant(condition, message) {
  if (!condition) {
    throw new CloudflareInvariantError(message);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
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

function sameCanonicalValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function requireExactKeys(value, required, optional, label) {
  invariant(isObject(value), `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    invariant(allowed.has(key), `${label} contains an unsupported field`);
  }
  for (const key of required) {
    invariant(Object.hasOwn(value, key), `${label} is missing a required field`);
  }
}

function requireNonEmptyString(value, label, maximumLength = 1_000) {
  invariant(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximumLength,
    `${label} must be a non-empty string`
  );
  return value;
}

function requireOptionalString(value, label, maximumLength = 1_000) {
  if (value === undefined || value === null) {
    return null;
  }
  return requireNonEmptyString(value, label, maximumLength);
}

function canonicalVersions(versions, label) {
  invariant(Array.isArray(versions) && versions.length > 0, `${label} must be non-empty`);
  const seen = new Set();
  const canonical = versions.map((version) => {
    requireExactKeys(
      version,
      ["versionId", "percentage", "etag"],
      [],
      `${label} entry`
    );
    invariant(
      UUID_PATTERN.test(version.versionId),
      `${label} contains an invalid version identifier`
    );
    invariant(!seen.has(version.versionId), `${label} contains a duplicate version`);
    seen.add(version.versionId);
    invariant(
      typeof version.percentage === "number" &&
        Number.isFinite(version.percentage) &&
        version.percentage >= 0.01 &&
        version.percentage <= 100,
      `${label} contains an invalid percentage`
    );
    return {
      versionId: version.versionId,
      percentage: version.percentage,
      etag: requireNonEmptyString(version.etag, `${label} entry ETag`, 512)
    };
  });
  const total = canonical.reduce((sum, version) => sum + version.percentage, 0);
  invariant(Math.abs(total - 100) < 1e-9, `${label} percentages must total 100`);
  return canonical.sort((left, right) => left.versionId.localeCompare(right.versionId));
}

function canonicalDeployment(value, label, { nullable = false } = {}) {
  if (nullable && value === null) {
    return null;
  }
  requireExactKeys(value, ["id", "versions"], [], label);
  invariant(UUID_PATTERN.test(value.id), `${label} has an invalid deployment identifier`);
  return {
    id: value.id,
    versions: canonicalVersions(value.versions, `${label} versions`)
  };
}

function canonicalCrons(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value
    .map((cron) => requireNonEmptyString(cron, `${label} entry`, 256))
    .sort((left, right) => left.localeCompare(right));
}

function optionalFiniteRate(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  invariant(
    typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    `${label} must be between zero and one`
  );
  return value;
}

function canonicalDestinations(value, label) {
  if (value === undefined) {
    return undefined;
  }
  invariant(Array.isArray(value), `${label} must be an array`);
  return value
    .map((destination) => requireNonEmptyString(destination, `${label} entry`, 512))
    .sort((left, right) => left.localeCompare(right));
}

function canonicalLogs(value, label, { requireCoreFields }) {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(isObject(value), `${label} must be an object or null`);
  const enabled = value.enabled;
  const invocationLogs = value.invocation_logs ?? value.invocationLogs;
  if (requireCoreFields) {
    invariant(typeof enabled === "boolean", `${label} enabled must be boolean`);
    invariant(
      typeof invocationLogs === "boolean",
      `${label} invocation logs must be boolean`
    );
  } else {
    invariant(
      enabled === undefined || typeof enabled === "boolean",
      `${label} enabled must be boolean`
    );
    invariant(
      invocationLogs === undefined || typeof invocationLogs === "boolean",
      `${label} invocation logs must be boolean`
    );
  }
  const headSamplingRate = optionalFiniteRate(
    value.head_sampling_rate ?? value.headSamplingRate,
    `${label} head sampling rate`
  );
  const destinations = canonicalDestinations(value.destinations, `${label} destinations`);
  invariant(
    value.persist === undefined || typeof value.persist === "boolean",
    `${label} persist must be boolean`
  );
  const result = {};
  if (enabled !== undefined) result.enabled = enabled;
  if (invocationLogs !== undefined) result.invocationLogs = invocationLogs;
  if (destinations !== undefined) result.destinations = destinations;
  if (headSamplingRate !== undefined) result.headSamplingRate = headSamplingRate;
  if (value.persist !== undefined) result.persist = value.persist;
  return result;
}

function canonicalTraces(value, label, { requireCoreFields }) {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(isObject(value), `${label} must be an object or null`);
  if (requireCoreFields) {
    invariant(typeof value.enabled === "boolean", `${label} enabled must be boolean`);
  } else {
    invariant(
      value.enabled === undefined || typeof value.enabled === "boolean",
      `${label} enabled must be boolean`
    );
  }
  const headSamplingRate = optionalFiniteRate(
    value.head_sampling_rate ?? value.headSamplingRate,
    `${label} head sampling rate`
  );
  const destinations = canonicalDestinations(value.destinations, `${label} destinations`);
  invariant(
    value.persist === undefined || typeof value.persist === "boolean",
    `${label} persist must be boolean`
  );
  const propagationPolicy =
    value.propagation_policy ?? value.propagationPolicy;
  invariant(
    propagationPolicy === undefined ||
      propagationPolicy === "authenticated" ||
      propagationPolicy === "accept",
    `${label} propagation policy is invalid`
  );
  const result = {};
  if (value.enabled !== undefined) result.enabled = value.enabled;
  if (destinations !== undefined) result.destinations = destinations;
  if (headSamplingRate !== undefined) result.headSamplingRate = headSamplingRate;
  if (value.persist !== undefined) result.persist = value.persist;
  if (propagationPolicy !== undefined) result.propagationPolicy = propagationPolicy;
  return result;
}

function canonicalObservability(value, label, { requireCoreFields = true } = {}) {
  if (value === undefined || value === null) {
    return null;
  }
  invariant(isObject(value), `${label} must be an object or null`);
  if (requireCoreFields) {
    invariant(typeof value.enabled === "boolean", `${label} enabled must be boolean`);
  } else {
    invariant(
      value.enabled === undefined || typeof value.enabled === "boolean",
      `${label} enabled must be boolean`
    );
  }
  const headSamplingRate = optionalFiniteRate(
    value.head_sampling_rate ?? value.headSamplingRate,
    `${label} head sampling rate`
  );
  const result = {
    enabled: value.enabled,
    logs: canonicalLogs(value.logs, `${label} logs`, { requireCoreFields }),
    traces: canonicalTraces(value.traces, `${label} traces`, { requireCoreFields })
  };
  if (!requireCoreFields && value.enabled === undefined) {
    delete result.enabled;
  }
  if (headSamplingRate !== undefined) {
    result.headSamplingRate = headSamplingRate;
  }
  return result;
}

function canonicalSubdomain(value, label) {
  invariant(isObject(value), `${label} must be an object`);
  const previewsEnabled = value.previews_enabled ?? value.previewsEnabled;
  invariant(typeof value.enabled === "boolean", `${label} enabled must be boolean`);
  invariant(
    typeof previewsEnabled === "boolean",
    `${label} preview setting must be boolean`
  );
  return {
    enabled: value.enabled,
    previewsEnabled
  };
}

export function serializeCanonicalPrivateBaseline(value) {
  return JSON.stringify(parsePrivateBaseline(value));
}

export function parsePrivateBaseline(value) {
  let source = value;
  if (typeof value === "string") {
    try {
      source = JSON.parse(value);
    } catch {
      throw new CloudflareInvariantError("private baseline is not valid JSON");
    }
  }
  requireExactKeys(source, ["schemaVersion", "accountId", "legacy"], [], "private baseline");
  invariant(
    source.schemaVersion === PRIVATE_BASELINE_SCHEMA_VERSION,
    "private baseline schema version is unsupported"
  );
  invariant(
    ACCOUNT_ID_PATTERN.test(source.accountId),
    "private baseline account identifier is invalid"
  );
  requireExactKeys(
    source.legacy,
    [
      "scriptEtag",
      "activeDeployment",
      "crons",
      "observability",
      "subdomain"
    ],
    [],
    "private baseline legacy state"
  );
  const legacy = {
    scriptEtag: requireNonEmptyString(
      source.legacy.scriptEtag,
      "private baseline legacy script ETag",
      512
    ),
    activeDeployment: canonicalDeployment(
      source.legacy.activeDeployment,
      "private baseline legacy deployment"
    ),
    crons: canonicalCrons(source.legacy.crons, "private baseline legacy crons"),
    observability: canonicalObservability(
      source.legacy.observability,
      "private baseline legacy observability"
    ),
    subdomain: canonicalSubdomain(
      source.legacy.subdomain,
      "private baseline legacy subdomain"
    )
  };
  return deepFreeze({
    schemaVersion: PRIVATE_BASELINE_SCHEMA_VERSION,
    accountId: source.accountId,
    legacy
  });
}

export function validateCloudflareEnvironment(
  environment,
  { expectedAccountId } = {}
) {
  invariant(isObject(environment), "Cloudflare environment must be an object");
  const accountId = environment.CLOUDFLARE_ACCOUNT_ID;
  const apiToken =
    typeof environment.CLOUDFLARE_API_TOKEN === "string"
      ? environment.CLOUDFLARE_API_TOKEN.trim()
      : "";
  const apiKey =
    typeof environment.CLOUDFLARE_API_KEY === "string"
      ? environment.CLOUDFLARE_API_KEY.trim()
      : "";
  const email =
    typeof environment.CLOUDFLARE_EMAIL === "string"
      ? environment.CLOUDFLARE_EMAIL.trim()
      : "";
  invariant(ACCOUNT_ID_PATTERN.test(accountId), "Cloudflare account identifier is invalid");
  if (expectedAccountId !== undefined) {
    invariant(accountId === expectedAccountId, "Cloudflare account does not match baseline");
  }
  const hasToken = apiToken.length > 0;
  const hasGlobalKey = apiKey.length > 0 || email.length > 0;
  invariant(
    hasToken !== hasGlobalKey,
    "set exactly one Cloudflare authentication method"
  );
  if (hasGlobalKey) {
    invariant(
      apiKey.length > 0 && email.length > 0,
      "global API key authentication requires both key and email"
    );
  }
  return deepFreeze({
    accountId,
    authentication: hasToken ? "api-token" : "global-api-key"
  });
}

function authenticationHeaders(environment) {
  if ((environment.CLOUDFLARE_API_TOKEN?.trim() ?? "").length > 0) {
    return {
      Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN.trim()}`
    };
  }
  return {
    "X-Auth-Key": environment.CLOUDFLARE_API_KEY.trim(),
    "X-Auth-Email": environment.CLOUDFLARE_EMAIL.trim()
  };
}

function endpoint(accountId, suffix) {
  return `${API_BASE_URL}/accounts/${encodeURIComponent(accountId)}${suffix}`;
}

async function apiGet(
  suffix,
  label,
  { accountId, environment, fetchImpl, apiRequestTimeoutMs }
) {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout;
  const timeoutPromise = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(
      new CloudflareInvariantError(`${label} request timed out`)
    );
  }, apiRequestTimeoutMs);

  try {
    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() =>
          fetchImpl(endpoint(accountId, suffix), {
            method: "GET",
            headers: {
              Accept: "application/json",
              ...authenticationHeaders(environment)
            },
            signal: controller.signal
          })
        ),
        timeoutPromise
      ]);
    } catch {
      if (timedOut) {
        throw new CloudflareInvariantError(`${label} request timed out`);
      }
      throw new CloudflareInvariantError(`${label} request failed`);
    }
    invariant(
      response !== null && typeof response === "object",
      `${label} returned an invalid response`
    );
    invariant(
      response.ok === true,
      `${label} request was rejected with HTTP ${String(response.status)}`
    );
    let envelope;
    try {
      envelope = await Promise.race([
        Promise.resolve().then(() => response.json()),
        timeoutPromise
      ]);
    } catch {
      if (timedOut) {
        throw new CloudflareInvariantError(`${label} request timed out`);
      }
      throw new CloudflareInvariantError(
        `${label} response was not valid JSON`
      );
    }
    invariant(isObject(envelope), `${label} response envelope is invalid`);
    invariant(envelope.success === true, `${label} response was unsuccessful`);
    invariant(
      envelope.errors === undefined || Array.isArray(envelope.errors),
      `${label} errors envelope is invalid`
    );
    invariant(
      envelope.messages === undefined || Array.isArray(envelope.messages),
      `${label} messages envelope is invalid`
    );
    invariant(Object.hasOwn(envelope, "result"), `${label} response result is missing`);
    return {
      result: envelope.result,
      resultInfo: envelope.result_info
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function apiRuntime(options, accountId, environment) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  invariant(typeof fetchImpl === "function", "a fetch implementation is required");
  const apiRequestTimeoutMs =
    options.apiRequestTimeoutMs ?? API_REQUEST_TIMEOUT_MS;
  invariant(
    Number.isInteger(apiRequestTimeoutMs) &&
      apiRequestTimeoutMs > 0 &&
      apiRequestTimeoutMs <= 300_000,
    "Cloudflare API request timeout is invalid"
  );
  return { accountId, environment, fetchImpl, apiRequestTimeoutMs };
}

function parsePagination(resultInfo, expectedPage, label) {
  invariant(isObject(resultInfo), `${label} pagination metadata is missing`);
  const page = resultInfo.page;
  const totalPages = resultInfo.total_pages;
  invariant(
    Number.isInteger(page) && page === expectedPage,
    `${label} pagination page is invalid`
  );
  invariant(
    Number.isInteger(totalPages) &&
      totalPages >= page &&
      totalPages <= MAXIMUM_PAGES,
    `${label} pagination total is invalid`
  );
  return totalPages;
}

async function listPaginated(
  suffixForPage,
  label,
  runtime,
  validateItem
) {
  const items = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const envelope = await apiGet(suffixForPage(page), label, runtime);
    invariant(Array.isArray(envelope.result), `${label} result must be an array`);
    const currentTotalPages = parsePagination(envelope.resultInfo, page, label);
    if (page === 1) {
      totalPages = currentTotalPages;
    } else {
      invariant(currentTotalPages === totalPages, `${label} pagination changed mid-read`);
    }
    for (const item of envelope.result) {
      validateItem(item);
      items.push(item);
    }
  }
  return items;
}

function deriveInputs(migrationBaseline, wranglerConfig) {
  invariant(isObject(migrationBaseline), "migration baseline must be an object");
  invariant(isObject(wranglerConfig), "Wrangler config must be an object");
  const legacyWorkerName = migrationBaseline.legacy?.worker?.name;
  const targetWorkerName = migrationBaseline.target?.workerName;
  requireNonEmptyString(legacyWorkerName, "legacy Worker name", 128);
  requireNonEmptyString(targetWorkerName, "target Worker name", 128);
  invariant(
    wranglerConfig.name === targetWorkerName,
    "Wrangler config target does not match migration baseline"
  );
  const legacyKvNamespaces = migrationBaseline.legacy?.worker?.kvNamespaces;
  invariant(
    Array.isArray(legacyKvNamespaces) && legacyKvNamespaces.length === 2,
    "migration baseline must contain exactly two legacy KV namespaces"
  );
  const expectedKv = [];
  const expectedBindings = new Set(["AUTH_KV", "OAUTH_KV"]);
  for (const namespace of legacyKvNamespaces) {
    invariant(isObject(namespace), "legacy KV namespace record is invalid");
    invariant(
      expectedBindings.has(namespace.binding),
      "legacy KV namespace binding is invalid"
    );
    invariant(
      KV_ID_PATTERN.test(namespace.id),
      "migration baseline contains an invalid KV identifier"
    );
    expectedKv.push({
      scope: "legacy",
      binding: namespace.binding,
      id: namespace.id,
      title: requireNonEmptyString(namespace.title, "legacy KV namespace title", 512)
    });
  }
  invariant(
    new Set(expectedKv.map((entry) => entry.binding)).size === 2,
    "legacy KV namespace bindings must be unique"
  );
  if (migrationBaseline.legacy?.worker?.kvNamespaceIds !== undefined) {
    const legacyKvIds = migrationBaseline.legacy.worker.kvNamespaceIds;
    invariant(
      Array.isArray(legacyKvIds) &&
        sameCanonicalValue(
          [...legacyKvIds].sort(),
          expectedKv.map((entry) => entry.id).sort()
        ),
      "legacy KV namespace records disagree with legacy IDs"
    );
  }
  const targetKvNamespaces = migrationBaseline.target?.kvNamespaces;
  invariant(
    Array.isArray(targetKvNamespaces) && targetKvNamespaces.length === 2,
    "migration baseline must contain exactly two target KV namespaces"
  );
  const targetKvBindings = wranglerConfig.kv_namespaces;
  invariant(
    Array.isArray(targetKvBindings) && targetKvBindings.length === 2,
    "Wrangler config must contain exactly two target KV namespaces"
  );
  const remainingBindings = new Set(expectedBindings);
  for (const binding of targetKvBindings) {
    invariant(isObject(binding), "Wrangler KV binding is invalid");
    invariant(
      remainingBindings.delete(binding.binding),
      "Wrangler config contains a duplicate or unexpected KV binding"
    );
    invariant(KV_ID_PATTERN.test(binding.id), "Wrangler config contains an invalid KV identifier");
    const baselineMatches = targetKvNamespaces.filter(
      (namespace) => namespace?.binding === binding.binding
    );
    invariant(
      baselineMatches.length === 1 &&
        baselineMatches[0].id === binding.id &&
        KV_ID_PATTERN.test(baselineMatches[0].id),
      "target KV namespace baseline disagrees with Wrangler config"
    );
    expectedKv.push({
      scope: "target",
      binding: binding.binding,
      id: binding.id,
      title: requireNonEmptyString(
        baselineMatches[0].title,
        "target KV namespace title",
        512
      )
    });
  }
  invariant(
    remainingBindings.size === 0,
    "Wrangler config is missing a required KV binding"
  );
  const allKvIds = expectedKv.map((entry) => entry.id);
  invariant(
    new Set(allKvIds).size === 4,
    "legacy and target must use four distinct KV namespaces"
  );
  return {
    legacyWorkerName,
    targetWorkerName,
    expectedKv: expectedKv.sort((left, right) => {
      const scopeOrder = left.scope.localeCompare(right.scope);
      if (scopeOrder !== 0) return scopeOrder;
      return (left.binding ?? left.id).localeCompare(right.binding ?? right.id);
    })
  };
}

export function expectedObservabilityFromWranglerConfig(wranglerConfig) {
  invariant(isObject(wranglerConfig), "Wrangler config must be an object");
  const observability = wranglerConfig.observability;
  invariant(isObject(observability), "Wrangler observability config must be an object");
  const expected = canonicalObservability(
    {
      ...observability,
      enabled:
        observability.enabled ??
        Boolean(observability.logs?.enabled || observability.traces?.enabled)
    },
    "Wrangler observability config",
    { requireCoreFields: false }
  );
  invariant(expected !== null, "Wrangler observability config must not be null");
  return deepFreeze(expected);
}

export function expectedSubdomainFromWranglerConfig(wranglerConfig) {
  invariant(isObject(wranglerConfig), "Wrangler config must be an object");
  invariant(
    typeof wranglerConfig.workers_dev === "boolean",
    "Wrangler workers_dev must be explicit"
  );
  invariant(
    typeof wranglerConfig.preview_urls === "boolean",
    "Wrangler preview_urls must be explicit"
  );
  return deepFreeze({
    enabled: wranglerConfig.workers_dev,
    previewsEnabled: wranglerConfig.preview_urls
  });
}

function assertProjection(actual, expected, label) {
  invariant(actual !== null && typeof actual === "object", `${label} is missing`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue !== null && typeof expectedValue === "object") {
      assertProjection(actual[key], expectedValue, label);
    } else {
      invariant(Object.is(actual[key], expectedValue), `${label} does not match config`);
    }
  }
}

export function assertTargetConfiguration(state, wranglerConfig) {
  invariant(isObject(state?.target), "captured target state is invalid");
  if (!state.target.exists) {
    invariant(state.target.observability === null, "absent target has observability state");
    invariant(state.target.subdomain === null, "absent target has subdomain state");
    return true;
  }
  assertProjection(
    state.target.observability,
    expectedObservabilityFromWranglerConfig(wranglerConfig),
    "target observability"
  );
  const expectedSubdomain = expectedSubdomainFromWranglerConfig(wranglerConfig);
  invariant(
    sameCanonicalValue(state.target.subdomain, expectedSubdomain),
    "target subdomain does not match config"
  );
  invariant(
    state.target.subdomain.previewsEnabled === false,
    "target preview URLs must be disabled"
  );
  return true;
}

function matchSingleWorker(scripts, workerName, role, allowMissing) {
  const matches = scripts.filter((script) => script.id === workerName);
  invariant(matches.length <= 1, `${role} Worker is duplicated`);
  if (matches.length === 0) {
    invariant(allowMissing, `${role} Worker is missing`);
    return null;
  }
  const scriptEtag = matches[0].etag;
  invariant(
    typeof scriptEtag === "string" && scriptEtag.length > 0,
    `${role} Worker script ETag is missing`
  );
  return { scriptEtag };
}

function deploymentFromApi(result, role) {
  invariant(isObject(result) && Array.isArray(result.deployments), `${role} deployments are invalid`);
  if (result.deployments.length === 0) {
    return null;
  }
  const deployment = result.deployments[0];
  invariant(isObject(deployment), `${role} active deployment is invalid`);
  invariant(
    Array.isArray(deployment.versions),
    `${role} active deployment versions are invalid`
  );
  invariant(
    UUID_PATTERN.test(deployment.id),
    `${role} active deployment has an invalid identifier`
  );
  const versions = deployment.versions.map((version) => {
    invariant(isObject(version), `${role} active deployment version is invalid`);
    invariant(
      UUID_PATTERN.test(version.version_id),
      `${role} active deployment version identifier is invalid`
    );
    invariant(
      typeof version.percentage === "number" &&
        Number.isFinite(version.percentage) &&
        version.percentage >= 0.01 &&
        version.percentage <= 100,
      `${role} active deployment percentage is invalid`
    );
    return {
      versionId: version.version_id,
      percentage: version.percentage
    };
  });
  invariant(
    Math.abs(versions.reduce((sum, version) => sum + version.percentage, 0) - 100) <
      1e-9,
    `${role} active deployment percentages must total 100`
  );
  return { id: deployment.id, versions };
}

function schedulesFromApi(result, role) {
  invariant(isObject(result) && Array.isArray(result.schedules), `${role} schedules are invalid`);
  return canonicalCrons(
    result.schedules.map((schedule) => schedule?.cron),
    `${role} schedules`
  );
}

async function captureWorker(workerName, scriptMatch, role, runtime) {
  if (scriptMatch === null) {
    return {
      exists: false,
      scriptEtag: null,
      activeDeployment: null,
      crons: [],
      observability: null,
      subdomain: null
    };
  }
  const encodedName = encodeURIComponent(workerName);
  const [deploymentEnvelope, schedulesEnvelope, settingsEnvelope, subdomainEnvelope] =
    await Promise.all([
      apiGet(
        `/workers/scripts/${encodedName}/deployments`,
        `${role} deployments`,
        runtime
      ),
      apiGet(
        `/workers/scripts/${encodedName}/schedules`,
        `${role} schedules`,
        runtime
      ),
      apiGet(
        `/workers/scripts/${encodedName}/settings`,
        `${role} settings`,
        runtime
      ),
      apiGet(
        `/workers/scripts/${encodedName}/subdomain`,
        `${role} subdomain`,
        runtime
      )
    ]);
  invariant(isObject(settingsEnvelope.result), `${role} settings are invalid`);
  const activeDeployment = deploymentFromApi(deploymentEnvelope.result, role);
  if (activeDeployment !== null) {
    for (const version of activeDeployment.versions) {
      version.etag = await exactVersionEtag(workerName, version.versionId, runtime);
    }
  }
  return {
    exists: true,
    scriptEtag: scriptMatch.scriptEtag,
    activeDeployment:
      activeDeployment === null
        ? null
        : canonicalDeployment(activeDeployment, `${role} active deployment`),
    crons: schedulesFromApi(schedulesEnvelope.result, role),
    observability: canonicalObservability(
      settingsEnvelope.result.observability,
      `${role} observability`
    ),
    subdomain: canonicalSubdomain(subdomainEnvelope.result, `${role} subdomain`)
  };
}

async function listKvNamespaces(runtime) {
  const records = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page += 1) {
    const suffix =
      page === 1
        ? "/storage/kv/namespaces?per_page=1000"
        : `/storage/kv/namespaces?per_page=1000&page=${String(page)}`;
    const envelope = await apiGet(suffix, "KV namespace list", runtime);
    invariant(Array.isArray(envelope.result), "KV namespace result must be an array");
    for (const namespace of envelope.result) {
      invariant(isObject(namespace), "KV namespace record is invalid");
      invariant(KV_ID_PATTERN.test(namespace.id), "KV namespace identifier is invalid");
      requireNonEmptyString(namespace.title, "KV namespace title", 512);
      records.push({ id: namespace.id, title: namespace.title });
    }
    if (envelope.resultInfo === undefined) {
      invariant(page === 1, "KV namespace pagination metadata disappeared");
      totalPages = 1;
    } else {
      invariant(isObject(envelope.resultInfo), "KV namespace pagination metadata is invalid");
      const totalCount = envelope.resultInfo.total_count;
      const perPage = envelope.resultInfo.per_page ?? 1000;
      invariant(
        totalCount === undefined ||
          (Number.isInteger(totalCount) && totalCount >= envelope.result.length),
        "KV namespace total count is invalid"
      );
      invariant(
        Number.isInteger(perPage) && perPage >= 1 && perPage <= 1000,
        "KV namespace page size is invalid"
      );
      const derivedTotalPages =
        totalCount === undefined ? 1 : Math.max(1, Math.ceil(totalCount / perPage));
      invariant(
        derivedTotalPages <= MAXIMUM_PAGES,
        "KV namespace pagination total is invalid"
      );
      if (page === 1) {
        totalPages = derivedTotalPages;
      } else {
        invariant(
          derivedTotalPages === totalPages,
          "KV namespace pagination changed mid-read"
        );
      }
    }
  }
  return records;
}

function selectExpectedKvNamespaces(allNamespaces, expectedKv) {
  const canonical = [];
  for (const expected of expectedKv) {
    const matches = allNamespaces.filter((namespace) => namespace.id === expected.id);
    invariant(matches.length === 1, "required KV namespace is missing or duplicated");
    invariant(
      matches[0].title === expected.title,
      "required KV namespace title changed"
    );
    canonical.push({
      scope: expected.scope,
      binding: expected.binding,
      id: expected.id,
      title: expected.title
    });
  }
  invariant(canonical.length === 4, "captured KV namespace set must contain four records");
  return canonical;
}

export async function captureCloudflareState(options) {
  invariant(isObject(options), "capture options must be an object");
  const privateBaseline = parsePrivateBaseline(options.privateBaseline);
  const environment = options.environment ?? process.env;
  const cloudflare = validateCloudflareEnvironment(environment, {
    expectedAccountId: privateBaseline.accountId
  });
  const inputs = deriveInputs(options.migrationBaseline, options.wranglerConfig);
  const runtime = apiRuntime(options, cloudflare.accountId, environment);
  const scriptsEnvelope = await apiGet("/workers/scripts", "Worker script list", runtime);
  invariant(Array.isArray(scriptsEnvelope.result), "Worker script list result must be an array");
  for (const script of scriptsEnvelope.result) {
    invariant(isObject(script), "Worker script list contains an invalid record");
    requireNonEmptyString(script.id, "Worker script identifier", 128);
  }
  const legacyScript = matchSingleWorker(
    scriptsEnvelope.result,
    inputs.legacyWorkerName,
    "legacy",
    false
  );
  const targetScript = matchSingleWorker(
    scriptsEnvelope.result,
    inputs.targetWorkerName,
    "target",
    options.allowTargetMissing === true
  );
  const [legacy, target, allKvNamespaces] = await Promise.all([
    captureWorker(inputs.legacyWorkerName, legacyScript, "legacy", runtime),
    captureWorker(inputs.targetWorkerName, targetScript, "target", runtime),
    listKvNamespaces(runtime)
  ]);
  const state = deepFreeze({
    schemaVersion: REMOTE_STATE_SCHEMA_VERSION,
    accountId: cloudflare.accountId,
    legacy,
    target,
    kvNamespaces: selectExpectedKvNamespaces(allKvNamespaces, inputs.expectedKv)
  });
  assertLegacyMatchesPrivateBaseline(state, privateBaseline);
  assertTargetConfiguration(state, options.wranglerConfig);
  return state;
}

function validateStateShape(state) {
  invariant(isObject(state), "captured state must be an object");
  invariant(
    state.schemaVersion === REMOTE_STATE_SCHEMA_VERSION,
    "captured state schema version is unsupported"
  );
  invariant(ACCOUNT_ID_PATTERN.test(state.accountId), "captured state account is invalid");
  invariant(isObject(state.legacy), "captured legacy state is invalid");
  invariant(isObject(state.target), "captured target state is invalid");
  invariant(
    Array.isArray(state.kvNamespaces) && state.kvNamespaces.length === 4,
    "captured state must contain four KV namespaces"
  );
}

export function assertLegacyMatchesPrivateBaseline(state, baselineValue) {
  validateStateShape(state);
  const baseline = parsePrivateBaseline(baselineValue);
  invariant(state.accountId === baseline.accountId, "captured account does not match baseline");
  invariant(state.legacy.exists === true, "legacy Worker must exist");
  invariant(
    state.legacy.scriptEtag === baseline.legacy.scriptEtag,
    "legacy Worker script changed"
  );
  invariant(
    sameCanonicalValue(
      state.legacy.activeDeployment,
      baseline.legacy.activeDeployment
    ),
    "legacy active deployment changed"
  );
  invariant(
    sameCanonicalValue(state.legacy.crons, baseline.legacy.crons),
    "legacy cron triggers changed"
  );
  invariant(
    sameCanonicalValue(
      state.legacy.observability,
      baseline.legacy.observability
    ),
    "legacy observability changed"
  );
  invariant(
    sameCanonicalValue(state.legacy.subdomain, baseline.legacy.subdomain),
    "legacy subdomain changed"
  );
  return true;
}

function assertKvUnchanged(current, reference) {
  invariant(
    sameCanonicalValue(current.kvNamespaces, reference.kvNamespaces),
    "KV namespace records changed"
  );
}

function assertTargetHasNoTrafficOrCron(state) {
  invariant(
    state.target.activeDeployment === null,
    "target must not have an active deployment"
  );
  invariant(state.target.crons.length === 0, "target must not have cron triggers");
}

export function assertUploadReadyState(
  state,
  { privateBaseline, wranglerConfig }
) {
  assertLegacyMatchesPrivateBaseline(state, privateBaseline);
  assertTargetHasNoTrafficOrCron(state);
  assertTargetConfiguration(state, wranglerConfig);
  return true;
}

export function assertUploadPreservedInvariants(
  before,
  after,
  { privateBaseline, wranglerConfig }
) {
  assertUploadReadyState(before, { privateBaseline, wranglerConfig });
  assertUploadReadyState(after, { privateBaseline, wranglerConfig });
  invariant(
    after.target.exists === true,
    "target Worker was not present after upload"
  );
  assertKvUnchanged(after, before);
  return true;
}

export function assertPredeployStateUnchanged(
  current,
  persisted,
  { privateBaseline, wranglerConfig }
) {
  assertLegacyMatchesPrivateBaseline(current, privateBaseline);
  assertLegacyMatchesPrivateBaseline(persisted, privateBaseline);
  assertTargetConfiguration(current, wranglerConfig);
  assertTargetConfiguration(persisted, wranglerConfig);
  invariant(
    sameCanonicalValue(current, persisted),
    "predeploy Cloudflare state changed"
  );
  return true;
}

function assertSelectedVersionAtFullTraffic(
  state,
  selectedVersionId,
  selectedVersionEtag
) {
  invariant(UUID_PATTERN.test(selectedVersionId), "selected version identifier is invalid");
  requireNonEmptyString(
    selectedVersionEtag,
    "selected version ETag",
    512
  );
  invariant(state.target.exists === true, "target Worker must exist");
  const deployment = state.target.activeDeployment;
  invariant(deployment !== null, "target active deployment is missing");
  invariant(
    deployment.versions.length === 1 &&
      deployment.versions[0].versionId === selectedVersionId &&
      deployment.versions[0].percentage === 100 &&
      deployment.versions[0].etag === selectedVersionEtag,
    "target traffic is not assigned exactly to the selected version"
  );
}

function assertTargetArtifactStateUnchanged(current, reference) {
  invariant(
    current.target.exists === true && reference.target.exists === true,
    "target Worker must exist before traffic deployment"
  );
  invariant(
    current.target.scriptEtag === reference.target.scriptEtag,
    "target Worker script changed"
  );
  invariant(
    sameCanonicalValue(
      current.target.observability,
      reference.target.observability
    ),
    "target observability changed"
  );
  invariant(
    sameCanonicalValue(current.target.subdomain, reference.target.subdomain),
    "target subdomain changed"
  );
}

export function assertTrafficDeploymentState(
  current,
  {
    privateBaseline,
    wranglerConfig,
    selectedVersionId,
    selectedVersionEtag,
    predeployState
  }
) {
  assertUploadReadyState(predeployState, { privateBaseline, wranglerConfig });
  assertLegacyMatchesPrivateBaseline(current, privateBaseline);
  assertTargetConfiguration(current, wranglerConfig);
  assertSelectedVersionAtFullTraffic(
    current,
    selectedVersionId,
    selectedVersionEtag
  );
  assertTargetArtifactStateUnchanged(current, predeployState);
  invariant(
    Array.isArray(predeployState?.target?.crons) &&
      predeployState.target.crons.length === 0,
    "persisted predeploy target cron state is invalid"
  );
  invariant(current.target.crons.length === 0, "target cron changed before trigger deploy");
  assertKvUnchanged(current, predeployState);
  return true;
}

export function assertPostdeployState(
  current,
  {
    privateBaseline,
    wranglerConfig,
    selectedVersionId,
    selectedVersionEtag,
    predeployState,
    cron = REQUIRED_TARGET_CRON
  }
) {
  assertUploadReadyState(predeployState, { privateBaseline, wranglerConfig });
  assertLegacyMatchesPrivateBaseline(current, privateBaseline);
  assertTargetConfiguration(current, wranglerConfig);
  assertSelectedVersionAtFullTraffic(
    current,
    selectedVersionId,
    selectedVersionEtag
  );
  assertTargetArtifactStateUnchanged(current, predeployState);
  invariant(
    sameCanonicalValue(current.target.crons, [cron]),
    "target cron trigger does not match release policy"
  );
  assertKvUnchanged(current, predeployState);
  return true;
}

async function listBetaWorkers(runtime) {
  const workers = await listPaginated(
    (page) => `/workers/workers?per_page=100&page=${String(page)}`,
    "beta Worker list",
    runtime,
    (worker) => {
      invariant(isObject(worker), "beta Worker record is invalid");
      invariant(WORKER_ID_PATTERN.test(worker.id), "beta Worker identifier is invalid");
      requireNonEmptyString(worker.name, "beta Worker name", 128);
    }
  );
  const seenWorkerIds = new Set();
  for (const worker of workers) {
    invariant(!seenWorkerIds.has(worker.id), "beta Worker list contains a duplicate");
    seenWorkerIds.add(worker.id);
  }
  return workers;
}

function canonicalListedVersion(version) {
  invariant(isObject(version), "target version record is invalid");
  invariant(UUID_PATTERN.test(version.id), "target version identifier is invalid");
  invariant(
    version.annotations === undefined ||
      version.annotations === null ||
      isObject(version.annotations),
    "target version annotations are invalid"
  );
  const annotations = version.annotations ?? {};
  const tag = requireOptionalString(
    annotations["workers/tag"],
    "target version tag",
    100
  );
  const message = requireOptionalString(
    annotations["workers/message"],
    "target version message",
    1_000
  );
  const etag =
    version.etag === undefined || version.etag === null
      ? null
      : requireNonEmptyString(version.etag, "target version ETag", 512);
  return { id: version.id, tag, message, etag };
}

async function exactVersionEtag(workerName, versionId, runtime) {
  const envelope = await apiGet(
    `/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}`,
    "target version detail",
    runtime
  );
  const etag = envelope.result?.resources?.script?.etag;
  return requireNonEmptyString(etag, "target version detail ETag", 512);
}

export async function listAllTargetVersions(options) {
  invariant(isObject(options), "version list options must be an object");
  const privateBaseline = parsePrivateBaseline(options.privateBaseline);
  const environment = options.environment ?? process.env;
  const cloudflare = validateCloudflareEnvironment(environment, {
    expectedAccountId: privateBaseline.accountId
  });
  const inputs = deriveInputs(options.migrationBaseline, options.wranglerConfig);
  const runtime = apiRuntime(options, cloudflare.accountId, environment);
  const workers = await listBetaWorkers(runtime);
  const targetWorkers = workers.filter(
    (worker) => worker.name === inputs.targetWorkerName
  );
  invariant(targetWorkers.length <= 1, "target beta Worker is duplicated");
  if (targetWorkers.length === 0) {
    invariant(options.allowTargetMissing === true, "target beta Worker is missing");
    return deepFreeze([]);
  }
  const workerId = targetWorkers[0].id;
  const versions = await listPaginated(
    (page) =>
      `/workers/workers/${encodeURIComponent(workerId)}/versions?per_page=100&page=${String(page)}`,
    "target beta version list",
    runtime,
    (version) => {
      invariant(isObject(version), "target beta version record is invalid");
      invariant(UUID_PATTERN.test(version.id), "target beta version identifier is invalid");
    }
  );
  const canonical = [];
  const seen = new Set();
  for (const version of versions) {
    const listed = canonicalListedVersion(version);
    invariant(!seen.has(listed.id), "target version list contains a duplicate");
    seen.add(listed.id);
    if (listed.etag === null) {
      listed.etag = await exactVersionEtag(
        inputs.targetWorkerName,
        listed.id,
        runtime
      );
    }
    canonical.push(listed);
  }
  canonical.sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze(canonical);
}

export function findUniqueTargetVersionByTagAndMessage(
  versions,
  { tag, message }
) {
  invariant(Array.isArray(versions), "target versions must be an array");
  requireNonEmptyString(tag, "expected target version tag", 100);
  requireNonEmptyString(message, "expected target version message", 1_000);
  const matches = versions.filter(
    (version) => version?.tag === tag && version?.message === message
  );
  invariant(matches.length === 1, "target release identity is not unique");
  const match = matches[0];
  invariant(UUID_PATTERN.test(match.id), "matched target version identifier is invalid");
  requireNonEmptyString(match.etag, "matched target version ETag", 512);
  return deepFreeze({
    id: match.id,
    tag: match.tag,
    message: match.message,
    etag: match.etag
  });
}
