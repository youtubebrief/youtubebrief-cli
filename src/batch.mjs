import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './errors.mjs';
import { formatPayload } from './output.mjs';

const SCHEMA_VERSION = '1.1';
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_BILLING_BLOCK_MINUTES = 10;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const SECRET_PATTERNS = [
  /raw\s+provider\s+response[:=]?[^\n]*/gi,
  /yb_live_[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /sk_live_[A-Za-z0-9_-]+/g,
  /sk_[A-Za-z0-9_-]{12,}/g,
  /api[_-]?key[=:]\s*[^\s,&}]+/gi,
  /access[_-]?token[=:]\s*[^\s,&}]+/gi,
  /raw[_-]?provider[_-]?secret[^\s,&}]*/gi,
  /provider[_-]?secret[=:]?\s*[^\s,&}]+/gi,
  /stack\s*trace/gi,
];
const SENSITIVE_JSON_KEY_PATTERN = /api[_-]?key|access[_-]?token|raw[_-]?provider|provider[_-]?secret|stack/i;
const RETRYABLE_ERROR_CODES = new Set(['provider_error', 'network_error', 'timeout']);

export const BATCH_EXIT_CODES = Object.freeze({
  success: 0,
  fatal: 1,
  partial: 2,
  insufficientCredits: 3,
  auth: 4,
  providerOrNetwork: 5,
  manifest: 6,
});

export const MANIFEST_JSON_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://youtubebrief.com/schemas/youtubebrief-batch-manifest.schema.json',
  title: 'Youtubebrief batch manifest',
  type: 'object',
  required: ['schema_version', 'batch_id', 'status', 'items'],
  properties: {
    schema_version: { type: 'string', const: SCHEMA_VERSION },
    batch_id: { type: 'string' },
    status: { enum: ['running', 'succeeded', 'partial_failure', 'failed', 'planned', 'estimated'] },
    mode: { enum: ['run', 'dry_run', 'estimate_credits', 'resume', 'single'] },
    out_dir: { type: 'string' },
    billing_block_minutes: { type: 'number' },
    outputs: {
      type: 'object',
      properties: {
        combined_markdown: { type: ['string', 'null'] },
        jsonl: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
    total: { type: 'integer', minimum: 0 },
    succeeded: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    skipped: { type: 'integer', minimum: 0 },
    billed_successes: { type: 'integer', minimum: 0 },
    not_billed: { type: 'integer', minimum: 0 },
    estimated_billable_items: { type: 'integer', minimum: 0 },
    estimated_billing_block_minutes: { type: 'number', minimum: 0 },
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['input_index', 'input', 'status', 'billed'],
        properties: {
          input_index: { type: 'integer', minimum: 0 },
          input: { type: 'string' },
          normalized_url: { type: ['string', 'null'] },
          normalized_video_id: { type: ['string', 'null'] },
          status: { type: 'string' },
          billed: { type: 'boolean' },
          billing_event_id: { type: ['string', 'null'] },
          idempotency_key: { type: ['string', 'null'] },
          markdown_path: { type: ['string', 'null'] },
          json_path: { type: ['string', 'null'] },
          started_at: { type: ['string', 'null'] },
          finished_at: { type: ['string', 'null'] },
          error_code: { type: ['string', 'null'] },
          error_message: { type: ['string', 'null'] },
          retryable: { type: ['boolean', 'null'] },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
});

export async function readBatchInputFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  return splitInputLines(text);
}

export function splitInputLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function normalizeBatchYoutubeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input ?? '').trim());
  } catch {
    throw new CliError('Invalid YouTube URL. Use an HTTPS youtube.com or youtu.be URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new CliError('Unsupported YouTube URL protocol. Use HTTPS youtube.com or youtu.be URLs only.');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(hostname)) {
    throw new CliError('Unsupported YouTube URL host. Use youtube.com or youtu.be URLs only.');
  }

  if (isLocalOrPrivateHostname(hostname)) {
    throw new CliError('Unsafe YouTube URL host. Local, private, and metadata hosts are not allowed.');
  }

  const videoId = extractVideoId(parsed);
  if (!videoId) {
    throw new CliError('Unsupported YouTube URL shape. Use a watch, youtu.be, shorts, or embed video URL.');
  }

  return {
    input: String(input),
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    videoId,
  };
}

export function createBatchId() {
  return `batch_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function createItemIdempotencyKey({ batchId, inputIndex, canonicalUrl }) {
  return `${batchId}:item_${inputIndex}_${hashText(canonicalUrl).slice(0, 16)}`;
}

export function safeVideoSlug({ videoId, input, inputIndex }, used = new Map()) {
  const base = VIDEO_ID_PATTERN.test(String(videoId ?? ''))
    ? String(videoId)
    : `video_${hashText(String(input ?? inputIndex)).slice(0, 12)}`;
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

export async function runBatch({
  inputs,
  client,
  outDir,
  concurrency = DEFAULT_CONCURRENCY,
  billingBlockMinutes = DEFAULT_BILLING_BLOCK_MINUTES,
  timeoutMs,
  pollIntervalMs,
  dryRun = false,
  estimateCredits = false,
  resume = false,
  failedOnly = false,
  retryProviderErrors = false,
  combinedMd = false,
  jsonl = false,
  now = () => new Date(),
  secrets = [],
} = {}) {
  if (!outDir) throw new CliError('Missing --out-dir for batch output.');
  const planOnly = dryRun || estimateCredits;
  if (!planOnly && (!client || typeof client.createBrief !== 'function')) throw new CliError('Batch runner requires a Youtubebrief client.');
  const safeConcurrency = normalizeConcurrency(concurrency);
  const absoluteOutDir = path.resolve(outDir);
  const videosDir = path.join(absoluteOutDir, 'videos');
  await mkdir(videosDir, { recursive: true });

  const startedAt = now().toISOString();
  const resumeMode = resume || failedOnly || retryProviderErrors;
  const existingManifest = resumeMode ? await readBatchManifest(absoluteOutDir) : null;
  const requestedInputs = Array.isArray(inputs) ? inputs : [];
  if (!resumeMode && requestedInputs.length === 0) throw new CliError('No YouTube URLs provided for batch processing.');
  const usedSlugs = new Map();
  const normalizedItems = existingManifest
    ? buildResumeItems({ existingManifest, resume, failedOnly, retryProviderErrors, now, secrets })
    : dedupeInitialItems(requestedInputs.map((input, index) => buildInitialItem({ input, index, usedSlugs, secrets, now })), { now, secrets });
  const batchId = existingManifest?.batch_id || createBatchId();
  for (const item of normalizedItems) {
    if (!item.idempotency_key && item.normalized_url) {
      item.idempotency_key = createItemIdempotencyKey({ batchId, inputIndex: item.input_index, canonicalUrl: item.normalized_url });
    }
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    batch_id: batchId,
    status: planOnly ? (estimateCredits ? 'estimated' : 'planned') : 'running',
    mode: estimateCredits ? 'estimate_credits' : dryRun ? 'dry_run' : resumeMode ? 'resume' : 'run',
    out_dir: absoluteOutDir,
    billing_block_minutes: billingBlockMinutes,
    resumed_from_batch_id: existingManifest?.batch_id || null,
    outputs: {
      combined_markdown: null,
      jsonl: null,
    },
    started_at: startedAt,
    finished_at: null,
    total: normalizedItems.length,
    succeeded: 0,
    failed: normalizedItems.filter((item) => item.status === 'failed').length,
    skipped: 0,
    billed_successes: 0,
    not_billed: normalizedItems.filter((item) => item.status === 'failed').length,
    estimated_billable_items: 0,
    estimated_billing_block_minutes: 0,
    items: normalizedItems,
  };
  recountManifest(manifest);
  await writeManifestAtomic(manifest, absoluteOutDir);

  if (planOnly) {
    manifest.finished_at = now().toISOString();
    await writeManifestAtomic(recountManifest(manifest, now), absoluteOutDir);
    return manifest;
  }

  let nextIndex = 0;
  let stopDispatchForCredits = false;

  async function worker() {
    while (true) {
      const item = takeNextDispatchableItem();
      if (!item) return;
      await processItem({
        item,
        client,
        videosDir,
        billingBlockMinutes,
        timeoutMs,
        pollIntervalMs,
        now,
        manifest,
        absoluteOutDir,
        secrets,
      });
      if (item.error_code === 'insufficient_credits') stopDispatchForCredits = true;
      if (stopDispatchForCredits) {
        markUndispatchedItemsSkipped({ manifest, now, secrets });
        await writeManifestAtomic(recountManifest(manifest, now), absoluteOutDir);
      }
    }
  }

  function takeNextDispatchableItem() {
    while (nextIndex < manifest.items.length) {
      const item = manifest.items[nextIndex];
      nextIndex += 1;
      if (item.status !== 'pending') continue;
      if (stopDispatchForCredits) {
        markSkippedDueToCredits({ item, now, secrets });
        continue;
      }
      return item;
    }
    return null;
  }

  await Promise.all(Array.from({ length: Math.min(safeConcurrency, manifest.items.length) }, () => worker()));
  markUndispatchedItemsSkipped({ manifest, now, secrets });
  const finalManifest = recountManifest(manifest);
  const nonDuplicateSkipped = finalManifest.items.filter((item) => String(item.status).startsWith('skipped') && item.status !== 'skipped_duplicate').length;
  finalManifest.status = finalManifest.failed > 0 || nonDuplicateSkipped > 0
    ? (finalManifest.succeeded > 0 ? 'partial_failure' : 'failed')
    : 'succeeded';
  finalManifest.finished_at = now().toISOString();
  await writeRequestedExports(finalManifest, absoluteOutDir, { combinedMd, jsonl, secrets });
  await writeManifestAtomic(finalManifest, absoluteOutDir);
  return finalManifest;
}

export async function readBatchManifest(outDir) {
  const manifestPath = path.join(path.resolve(outDir), 'manifest.json');
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new CliError(`Cannot resume batch: missing manifest.json in ${path.resolve(outDir)}.`, { exitCode: BATCH_EXIT_CODES.manifest });
    }
    throw new CliError(`Cannot read batch manifest: ${error.message}`, { exitCode: BATCH_EXIT_CODES.manifest });
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    throw new CliError('Cannot resume batch: manifest.json is missing an items array.', { exitCode: BATCH_EXIT_CODES.manifest });
  }
  return parsed;
}

export function summarizeBatchManifest(manifest) {
  const lines = [
    'yb batch completed',
    `out_dir: ${manifest.out_dir}`,
    `mode: ${manifest.mode || 'run'}`,
    `total: ${manifest.total}`,
    `succeeded: ${manifest.succeeded}`,
    `failed: ${manifest.failed}`,
    `skipped: ${manifest.skipped}`,
    `billed: ${manifest.billed_successes}`,
    `not_billed: ${manifest.not_billed}`,
  ];
  if (Number.isFinite(manifest.estimated_billable_items)) lines.push(`estimated_billable_items: ${manifest.estimated_billable_items}`);
  if (Number.isFinite(manifest.estimated_billing_block_minutes)) lines.push(`estimated_billing_block_minutes: ${manifest.estimated_billing_block_minutes}`);
  lines.push(`manifest: ${path.join(manifest.out_dir, 'manifest.json')}`);
  if (manifest.outputs?.combined_markdown) lines.push(`combined_md: ${path.join(manifest.out_dir, manifest.outputs.combined_markdown)}`);
  if (manifest.outputs?.jsonl) lines.push(`jsonl: ${path.join(manifest.out_dir, manifest.outputs.jsonl)}`);
  return lines.join('\n') + '\n';
}

export async function exportBatchBundle({ outDir, format, output, secrets = [] } = {}) {
  const manifest = await readBatchManifest(outDir);
  const absoluteOutDir = path.resolve(outDir);
  if (format === 'combined-md') {
    const content = await renderCombinedMarkdown(manifest, absoluteOutDir, secrets);
    const defaultPath = path.join(absoluteOutDir, 'combined.md');
    await writeExportOutput({ content, output, defaultPath });
    return { format, outputPath: output && output !== '-' ? path.resolve(output) : output === '-' ? '-' : defaultPath, content };
  }
  if (format === 'jsonl') {
    const content = await renderJsonl(manifest, absoluteOutDir, secrets);
    const defaultPath = path.join(absoluteOutDir, 'videos.jsonl');
    await writeExportOutput({ content, output, defaultPath });
    return { format, outputPath: output && output !== '-' ? path.resolve(output) : output === '-' ? '-' : defaultPath, content };
  }
  throw new CliError('Invalid export format. Use combined-md or jsonl.');
}

export function getBatchExitCode(manifest, { allowPartial = false } = {}) {
  if (!manifest || typeof manifest !== 'object') return BATCH_EXIT_CODES.fatal;
  if (manifest.status === 'planned' || manifest.status === 'estimated' || manifest.status === 'succeeded') return BATCH_EXIT_CODES.success;
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const actionableItems = items.filter((item) => item.status !== 'skipped_duplicate');
  if (manifest.succeeded > 0 && allowPartial) return BATCH_EXIT_CODES.success;
  if (manifest.succeeded > 0) return BATCH_EXIT_CODES.partial;
  if (actionableItems.some((item) => item.error_code === 'insufficient_credits' || item.status === 'skipped_due_to_insufficient_credits')) return BATCH_EXIT_CODES.insufficientCredits;
  if (actionableItems.some((item) => item.error_code === 'unauthorized')) return BATCH_EXIT_CODES.auth;
  if (actionableItems.some((item) => RETRYABLE_ERROR_CODES.has(item.error_code) || item.retryable === true)) return BATCH_EXIT_CODES.providerOrNetwork;
  return BATCH_EXIT_CODES.fatal;
}

function buildInitialItem({ input, index, usedSlugs, secrets, now }) {
  const base = {
    input_index: index,
    input: sanitizeText(input, secrets),
    normalized_url: null,
    normalized_video_id: null,
    status: 'pending',
    billed: false,
    billing_event_id: null,
    idempotency_key: null,
    markdown_path: null,
    json_path: null,
    started_at: null,
    finished_at: null,
    error_code: null,
    error_message: null,
    retryable: null,
  };
  try {
    const normalized = normalizeBatchYoutubeUrl(input);
    const slug = safeVideoSlug({ videoId: normalized.videoId, input, inputIndex: index }, usedSlugs);
    return {
      ...base,
      normalized_url: normalized.canonicalUrl,
      normalized_video_id: normalized.videoId,
      markdown_path: `videos/${slug}.md`,
      json_path: `videos/${slug}.json`,
    };
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      error_code: 'invalid_url',
      error_message: sanitizeText(error.message, secrets),
      retryable: false,
      finished_at: now().toISOString(),
    };
  }
}

function dedupeInitialItems(items, { now, secrets }) {
  const seen = new Set();
  return items.map((item) => {
    if (item.status !== 'pending' || !item.normalized_url) return item;
    if (!seen.has(item.normalized_url)) {
      seen.add(item.normalized_url);
      return item;
    }
    return {
      ...item,
      status: 'skipped_duplicate',
      billed: false,
      markdown_path: null,
      json_path: null,
      error_code: 'skipped_duplicate',
      error_message: sanitizeText('Skipped duplicate input URL; first occurrence will be processed.', secrets),
      retryable: false,
      finished_at: now().toISOString(),
    };
  });
}

function buildResumeItems({ existingManifest, resume, failedOnly, retryProviderErrors, now, secrets }) {
  const batchId = existingManifest.batch_id || createBatchId();
  return existingManifest.items.map((raw, index) => {
    const item = normalizeManifestItem(raw, index, secrets);
    if (!item.idempotency_key && item.normalized_url) {
      item.idempotency_key = createItemIdempotencyKey({ batchId, inputIndex: item.input_index, canonicalUrl: item.normalized_url });
    }
    if (shouldRetryExistingItem(item, { resume, failedOnly, retryProviderErrors })) {
      return {
        ...item,
        status: 'pending',
        billed: false,
        billing_event_id: null,
        started_at: null,
        finished_at: null,
        error_code: null,
        error_message: null,
        retryable: null,
      };
    }
    if (item.status === 'running') {
      return {
        ...item,
        status: 'pending',
        started_at: null,
        finished_at: null,
        retryable: null,
      };
    }
    return {
      ...item,
      input: sanitizeText(item.input, secrets),
      error_message: item.error_message ? sanitizeText(item.error_message, secrets) : null,
      finished_at: item.finished_at ?? (item.status === 'pending' ? null : now().toISOString()),
    };
  });
}

function normalizeManifestItem(raw, fallbackIndex, secrets) {
  return {
    input_index: Number.isInteger(raw?.input_index) ? raw.input_index : fallbackIndex,
    input: sanitizeText(raw?.input ?? '', secrets),
    normalized_url: typeof raw?.normalized_url === 'string' ? raw.normalized_url : null,
    normalized_video_id: typeof raw?.normalized_video_id === 'string' ? raw.normalized_video_id : null,
    status: typeof raw?.status === 'string' ? raw.status : 'pending',
    billed: raw?.billed === true,
    billing_event_id: raw?.billing_event_id ? sanitizeText(raw.billing_event_id, secrets) : null,
    idempotency_key: typeof raw?.idempotency_key === 'string' ? sanitizeText(raw.idempotency_key, secrets) : null,
    markdown_path: typeof raw?.markdown_path === 'string' ? raw.markdown_path : null,
    json_path: typeof raw?.json_path === 'string' ? raw.json_path : null,
    started_at: typeof raw?.started_at === 'string' ? raw.started_at : null,
    finished_at: typeof raw?.finished_at === 'string' ? raw.finished_at : null,
    error_code: typeof raw?.error_code === 'string' ? raw.error_code : null,
    error_message: raw?.error_message ? sanitizeText(raw.error_message, secrets) : null,
    retryable: typeof raw?.retryable === 'boolean' ? raw.retryable : null,
  };
}

function shouldRetryExistingItem(item, { resume, failedOnly, retryProviderErrors }) {
  if (item.status === 'succeeded' || item.status === 'skipped_duplicate') return false;
  if (!item.normalized_url) return false;
  if (retryProviderErrors) return item.status === 'failed' && (item.retryable === true || RETRYABLE_ERROR_CODES.has(item.error_code));
  if (failedOnly) return item.status === 'failed' || String(item.status).startsWith('skipped');
  if (resume) {
    if (item.status === 'failed' && item.error_code === 'invalid_url') return false;
    return item.status !== 'succeeded';
  }
  return false;
}

async function processItem({
  item,
  client,
  videosDir,
  billingBlockMinutes,
  timeoutMs,
  pollIntervalMs,
  now,
  manifest,
  absoluteOutDir,
  secrets,
}) {
  item.status = 'running';
  item.started_at = now().toISOString();
  await writeManifestAtomic(recountManifest(manifest), absoluteOutDir);
  try {
    const payload = await client.createBrief(item.normalized_url, {
      wait: true,
      billingBlockMinutes,
      idempotencyKey: item.idempotency_key,
      timeoutMs,
      pollIntervalMs,
    });
    const billing = payload?.billing && typeof payload.billing === 'object' ? payload.billing : {};
    item.status = 'succeeded';
    item.billed = billing.billed === true;
    item.billing_event_id = sanitizeText(billing.billingEventId ?? billing.billing_event_id ?? '', secrets) || null;
    item.finished_at = now().toISOString();
    item.retryable = false;
    const markdown = sanitizeText(formatPayload(payload, 'markdown'), secrets);
    const jsonPayload = {
      input_index: item.input_index,
      input: item.input,
      normalized_url: item.normalized_url,
      normalized_video_id: item.normalized_video_id,
      idempotency_key: item.idempotency_key,
      billing: sanitizeJson(billing, secrets),
      result: sanitizeJson(payload, secrets),
    };
    await writeTextAtomic(path.join(videosDir, path.basename(item.markdown_path)), markdown);
    await writeJsonAtomic(path.join(videosDir, path.basename(item.json_path)), jsonPayload);
  } catch (error) {
    const classified = classifyBatchError(error, secrets);
    item.status = 'failed';
    item.billed = false;
    item.billing_event_id = null;
    item.error_code = classified.error_code;
    item.error_message = classified.error_message;
    item.retryable = classified.retryable;
    item.finished_at = now().toISOString();
  }
  await writeManifestAtomic(recountManifest(manifest), absoluteOutDir);
}

async function writeRequestedExports(manifest, absoluteOutDir, { combinedMd, jsonl, secrets }) {
  if (combinedMd) {
    const content = await renderCombinedMarkdown(manifest, absoluteOutDir, secrets);
    await writeTextAtomic(path.join(absoluteOutDir, 'combined.md'), content);
    manifest.outputs.combined_markdown = 'combined.md';
  }
  if (jsonl) {
    const content = await renderJsonl(manifest, absoluteOutDir, secrets);
    await writeTextAtomic(path.join(absoluteOutDir, 'videos.jsonl'), content);
    manifest.outputs.jsonl = 'videos.jsonl';
  }
}

async function renderCombinedMarkdown(manifest, absoluteOutDir, secrets = []) {
  const lines = [
    '# Youtubebrief Batch',
    '',
    `Batch: ${sanitizeText(manifest.batch_id, secrets)}`,
    `Status: ${sanitizeText(manifest.status, secrets)}`,
    `Total: ${manifest.total}`,
    `Succeeded: ${manifest.succeeded}`,
    `Failed: ${manifest.failed}`,
    `Skipped: ${manifest.skipped}`,
    '',
  ];

  for (const item of sortedItems(manifest).filter((entry) => entry.status === 'succeeded' && entry.markdown_path)) {
    lines.push(`## ${item.input_index + 1}. ${sanitizeText(item.normalized_video_id || 'video', secrets)}`);
    lines.push('');
    if (item.normalized_url) lines.push(`Source: ${sanitizeText(item.normalized_url, secrets)}`);
    lines.push(`Billed: ${item.billed ? 'yes' : 'no'}`);
    lines.push('');
    lines.push(await readBundleText(absoluteOutDir, item.markdown_path, secrets));
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd()}\n`;
}

async function renderJsonl(manifest, absoluteOutDir, secrets = []) {
  const lines = [];
  for (const item of sortedItems(manifest).filter((entry) => entry.status === 'succeeded' && entry.json_path)) {
    const result = await readBundleJson(absoluteOutDir, item.json_path, secrets);
    lines.push(JSON.stringify(sanitizeJson({
      schema_version: manifest.schema_version,
      batch_id: manifest.batch_id,
      item,
      result,
    }, secrets)));
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

async function writeExportOutput({ content, output, defaultPath }) {
  if (output === '-') return;
  await writeTextAtomic(output ? path.resolve(output) : defaultPath, content);
}

async function readBundleText(absoluteOutDir, relativePath, secrets = []) {
  const target = resolveBundlePath(absoluteOutDir, relativePath);
  return sanitizeText(await readFile(target, 'utf8'), secrets);
}

async function readBundleJson(absoluteOutDir, relativePath, secrets = []) {
  const target = resolveBundlePath(absoluteOutDir, relativePath);
  try {
    return sanitizeJson(JSON.parse(await readFile(target, 'utf8')), secrets);
  } catch (error) {
    throw new CliError(`Cannot read bundle JSON ${relativePath}: ${error.message}`, { exitCode: BATCH_EXIT_CODES.manifest });
  }
}

function resolveBundlePath(absoluteOutDir, relativePath) {
  const target = path.resolve(absoluteOutDir, relativePath);
  const root = `${path.resolve(absoluteOutDir)}${path.sep}`;
  if (target !== path.resolve(absoluteOutDir) && !target.startsWith(root)) {
    throw new CliError('Batch bundle path escapes out-dir.', { exitCode: BATCH_EXIT_CODES.manifest });
  }
  return target;
}

function sortedItems(manifest) {
  return [...(Array.isArray(manifest.items) ? manifest.items : [])].sort((a, b) => (a.input_index ?? 0) - (b.input_index ?? 0));
}

function classifyBatchError(error, secrets = []) {
  const rawCode = String(error?.code ?? error?.statusCode ?? error?.status ?? '').toLowerCase();
  const message = sanitizeText(error?.message ?? String(error), secrets);
  if (rawCode === 'insufficient_credits' || /\b402\b|insufficient|credits?|billing/i.test(message)) {
    return { error_code: 'insufficient_credits', error_message: message || 'Insufficient credits to start this item', retryable: false };
  }
  if (rawCode === 'unauthorized' || /\b401\b|unauthorized|not authorized|api key/i.test(message)) {
    return { error_code: 'unauthorized', error_message: message || 'API key is not authorized', retryable: false };
  }
  if (/\b5\d\d\b|timeout|network|provider|temporar|unavailable/i.test(message)) {
    return { error_code: 'provider_error', error_message: message || 'Provider returned a transient error', retryable: true };
  }
  return { error_code: rawCode || 'request_failed', error_message: message || 'Batch item failed', retryable: false };
}

function markUndispatchedItemsSkipped({ manifest, now, secrets }) {
  for (const item of manifest.items) {
    if (item.status === 'pending') markSkippedDueToCredits({ item, now, secrets });
  }
}

function markSkippedDueToCredits({ item, now, secrets }) {
  item.status = 'skipped_due_to_insufficient_credits';
  item.billed = false;
  item.error_code = 'skipped_due_to_insufficient_credits';
  item.error_message = sanitizeText('Skipped because a previous item exhausted available credits.', secrets);
  item.retryable = false;
  item.started_at = item.started_at ?? null;
  item.finished_at = now().toISOString();
}

function recountManifest(manifest, now) {
  const items = manifest.items;
  manifest.succeeded = items.filter((item) => item.status === 'succeeded').length;
  manifest.failed = items.filter((item) => item.status === 'failed').length;
  manifest.skipped = items.filter((item) => String(item.status).startsWith('skipped')).length;
  manifest.billed_successes = items.filter((item) => item.status === 'succeeded' && item.billed).length;
  manifest.not_billed = items.length - manifest.billed_successes;
  manifest.estimated_billable_items = items.filter((item) => item.status === 'pending' || item.status === 'running').length;
  manifest.estimated_billing_block_minutes = manifest.estimated_billable_items * Number(manifest.billing_block_minutes || DEFAULT_BILLING_BLOCK_MINUTES);
  if (now && isTerminalManifestStatus(manifest.status)) {
    manifest.finished_at = manifest.finished_at ?? now().toISOString();
  }
  return manifest;
}

function isTerminalManifestStatus(status) {
  return ['succeeded', 'partial_failure', 'failed', 'planned', 'estimated'].includes(String(status));
}

async function writeManifestAtomic(manifest, outDir) {
  await writeJsonAtomic(path.join(outDir, 'manifest.json'), sanitizeJson(manifest));
}

async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, content, 'utf8');
  await rename(tempPath, filePath);
}

function extractVideoId(url) {
  if (url.hostname.toLowerCase() === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return VIDEO_ID_PATTERN.test(id ?? '') ? id : '';
  }
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v');
    return VIDEO_ID_PATTERN.test(id ?? '') ? id : '';
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (['shorts', 'embed', 'live'].includes(parts[0])) {
    return VIDEO_ID_PATTERN.test(parts[1] ?? '') ? parts[1] : '';
  }
  return '';
}

function isLocalOrPrivateHostname(hostname) {
  const normalized = String(hostname ?? '').toLowerCase();
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'metadata.google.internal'
    || normalized === '169.254.169.254'
    || /^127\./.test(normalized)
    || /^10\./.test(normalized)
    || /^192\.168\./.test(normalized)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized);
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_CONCURRENCY;
  return Math.min(parsed, 4);
}

function sanitizeJson(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_JSON_KEY_PATTERN.test(key))
        .map(([key, child]) => [key, sanitizeJson(child, secrets)])
    );
  }
  if (typeof value === 'string') return sanitizeText(value, secrets);
  return value;
}

function sanitizeText(value, secrets = []) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  for (const secret of secrets) {
    const token = String(secret ?? '');
    if (token) text = text.split(token).join('[redacted]');
  }
  return text;
}

function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
