const TELEMETRY_ENDPOINT = '/api/v1/analytics/events';
const DEFAULT_TIMEOUT_MS = 900;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const SAFE_PROPERTY_KEYS = new Set([
  'source',
  'method',
  'status',
  'surface',
  'command',
  'tool',
  'mode',
  'result',
  'outcome',
  'errorCode',
  'authState',
  'packageVersion',
  'itemCount',
  'inputCount',
  'billableItems',
  'duplicateItems',
  'invalidItems',
  'successCount',
  'failureCount',
  'skippedCount',
  'billedCount',
  'notBilledCount',
  'creditMinutes',
  'billingBlockMinutes',
  'combinedMd',
  'jsonl',
  'allowPartial',
  'dryRun',
  'estimateCredits',
  'resume',
  'failedOnly',
  'retryProviderErrors',
  'hasOutDir',
  'telemetry',
  'optOut',
]);
const SENSITIVE_PROPERTY_KEY_PATTERN = /url|href|title|channel|video|provider|token|secret|key|authorization|cookie|email|name|ip|userAgent|raw|markdown|summary|transcript|path/i;
const SENSITIVE_VALUE_PATTERN = /https?:\/\/|youtu\.be|youtube\.com|bearer\s+|api[_ -]?key|secret|token|providerInternal|twelvelabs|LilyS|\.env|\/home\/|\\Users\\/i;

export function resolveTelemetryState(config = {}, env = process.env) {
  const envValue = firstDefined(env.YB_TELEMETRY, env.YOUTUBEBRIEF_TELEMETRY);
  const envPreference = parseBooleanPreference(envValue);
  if (envPreference === false) return { enabled: false, reason: 'disabled by YB_TELEMETRY/YOUTUBEBRIEF_TELEMETRY' };
  if (envPreference === true) return { enabled: true, reason: 'enabled by environment' };
  if (typeof config.telemetry === 'boolean') {
    return { enabled: config.telemetry, reason: config.telemetry ? 'enabled by config' : 'disabled by config' };
  }
  return { enabled: true, reason: 'enabled by default' };
}

export async function sendTelemetryEvent(eventName, properties = {}, options = {}) {
  return sendTelemetryEvents([{ eventName, properties }], options);
}

export async function sendTelemetryEvents(events = [], { config = {}, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const state = resolveTelemetryState(config, env);
  if (!state.enabled) return { sent: false, skipped: true, reason: state.reason };
  if (!fetchImpl) return { sent: false, skipped: true, reason: 'fetch unavailable' };
  const normalizedEvents = events
    .filter((event) => event && typeof event === 'object')
    .slice(0, 10)
    .map((event) => ({
      eventName: event.eventName,
      pageContext: event.properties?.surface === 'mcp' ? 'mcp' : 'cli',
      properties: sanitizeTelemetryProperties(event.properties),
    }));
  if (normalizedEvents.length === 0) return { sent: false, skipped: true, reason: 'empty event list' };

  let endpoint;
  try {
    endpoint = new URL(TELEMETRY_ENDPOINT, `${config.baseUrl || 'https://youtubebrief.com'}/`).toString();
  } catch {
    return { sent: false, skipped: true, reason: 'invalid base url' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1, timeoutMs)) : undefined;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ events: normalizedEvents }),
      redirect: 'error',
      signal: controller?.signal,
    });
    return { sent: Boolean(response?.ok), status: response?.status ?? 0, accepted: normalizedEvents.length };
  } catch (error) {
    return { sent: false, error: error?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sanitizeTelemetryProperties(properties = {}) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(properties)) {
    const key = String(rawKey ?? '').trim();
    if (!SAFE_PROPERTY_KEYS.has(key)) continue;
    if (SENSITIVE_PROPERTY_KEY_PATTERN.test(key)) continue;
    const value = sanitizeTelemetryValue(rawValue);
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function telemetryAuthState(config = {}) {
  if (config.hasEnvApiKey) return 'env';
  if (config.hasStoredApiKey) return 'stored';
  if (config.apiKey) return 'override';
  return 'none';
}

export function buildBatchTelemetryProperties(manifest = {}, options = {}, config = {}) {
  const total = Number(manifest.total ?? (Array.isArray(manifest.items) ? manifest.items.length : 0));
  return {
    surface: 'cli',
    command: 'batch',
    mode: manifest.mode || (options.dryRun ? 'dry_run' : options.estimateCredits ? 'estimate_credits' : 'run'),
    status: manifest.status || 'unknown',
    result: batchResult(manifest),
    authState: telemetryAuthState(config),
    itemCount: total,
    inputCount: total,
    successCount: Number(manifest.succeeded ?? 0),
    failureCount: Number(manifest.failed ?? 0),
    skippedCount: Number(manifest.skipped ?? 0),
    billedCount: Number(manifest.billed_successes ?? 0),
    notBilledCount: Number(manifest.not_billed ?? 0),
    billingBlockMinutes: Number(manifest.billing_block_minutes ?? options.billingBlockMinutes ?? 0),
    combinedMd: Boolean(manifest.outputs?.combined_markdown || options.combinedMd),
    jsonl: Boolean(manifest.outputs?.jsonl || options.jsonl),
    allowPartial: Boolean(options.allowPartial),
    dryRun: Boolean(options.dryRun),
    estimateCredits: Boolean(options.estimateCredits),
    resume: Boolean(options.resume),
    failedOnly: Boolean(options.failedOnly),
    retryProviderErrors: Boolean(options.retryProviderErrors),
    hasOutDir: Boolean(manifest.out_dir || options.outDir),
  };
}

function batchResult(manifest = {}) {
  if (manifest.status === 'succeeded') return 'success';
  if (manifest.status === 'partial_failure') return 'partial_failure';
  if (manifest.status === 'failed') return 'failed';
  if (manifest.status === 'planned') return 'planned';
  if (manifest.status === 'estimated') return 'estimated';
  return 'unknown';
}

function sanitizeTelemetryValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!normalized) return undefined;
  if (SENSITIVE_VALUE_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function parseBooleanPreference(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}
