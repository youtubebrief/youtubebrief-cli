import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE_URL } from './config.mjs';
import { CliError, sanitizeMessage } from './errors.mjs';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=LPZh9BOjkQs';
const DEFAULT_SECOND_URL = 'https://www.youtube.com/watch?v=JaRGJVrJBQ8';
const REPORT_SCHEMA_VERSION = '1.0';
const MAX_CAPTURE_CHARS = 2400;

export async function runControlledPaidSmoke(options = {}, { env = process.env, now = () => new Date() } = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || env.YOUTUBEBRIEF_BASE_URL || DEFAULT_BASE_URL);
  const apiKey = options.apiKey || env.YOUTUBEBRIEF_API_KEY;
  if (!apiKey) throw new CliError('Missing API key. Set YOUTUBEBRIEF_API_KEY for the controlled paid smoke.');
  if (!options.allowRun && env.YB_CONTROLLED_PAID_SMOKE !== '1') {
    throw new CliError('Refusing to run paid smoke without explicit opt-in. Set YB_CONTROLLED_PAID_SMOKE=1.');
  }

  const root = options.rootDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliBin = options.cliBin || path.join(root, 'bin', 'yb.js');
  const workDir = path.resolve(options.workDir || await mkdtemp(path.join(tmpdir(), 'yb-paid-smoke-')));
  const reportPath = path.resolve(options.reportPath || path.join(workDir, 'controlled-paid-smoke-report.json'));
  const configDir = path.join(workDir, 'config');
  const briefPath = path.join(workDir, 'brief.md');
  const batchDir = path.join(workDir, 'batch');
  const urlsPath = path.join(workDir, 'urls.txt');
  const urls = options.batchUrls?.length ? options.batchUrls : [options.url || DEFAULT_URL, options.secondUrl || DEFAULT_SECOND_URL];
  const secrets = [apiKey].filter(Boolean);
  const commandEnv = {
    ...env,
    YOUTUBEBRIEF_CONFIG_DIR: configDir,
    YOUTUBEBRIEF_BASE_URL: baseUrl,
    YOUTUBEBRIEF_API_KEY: apiKey,
  };

  await mkdir(workDir, { recursive: true });
  await writeFile(urlsPath, `${urls.join('\n')}\n`, 'utf8');

  const commands = [];
  const runStep = async (name, args, allowedExitCodes = [0]) => {
    const result = await runCliCommand({ cliBin, args, env: commandEnv, cwd: root, secrets });
    commands.push({ name, args: redactArgs(args), ...result });
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new CliError(`Controlled paid smoke step failed: ${name} exited ${result.exitCode}. See ${reportPath}.`);
    }
    return result;
  };

  try {
    await runStep('doctor', ['doctor', '--out-dir', workDir]);
    await runStep('brief', ['brief', options.url || DEFAULT_URL, '--output', briefPath, '--poll-interval-ms', '1']);
    await runStep('batch', ['batch', '--input', urlsPath, '--out-dir', batchDir, '--concurrency', '1', '--allow-partial', '--poll-interval-ms', '1']);
    const beforeRetryManifest = await readJson(path.join(batchDir, 'manifest.json'), secrets);
    await runStep('batch_resume_retry', ['batch', '--out-dir', batchDir, '--resume', '--concurrency', '1', '--allow-partial', '--poll-interval-ms', '1']);
    const afterRetryManifest = await readJson(path.join(batchDir, 'manifest.json'), secrets);
    const billing = assertSuccessOnlyBilling(afterRetryManifest);
    const duplicateRetry = assertResumeDidNotDoubleBill(beforeRetryManifest, afterRetryManifest);
    const report = sanitizeJson({
      schema_version: REPORT_SCHEMA_VERSION,
      type: 'youtubebrief_controlled_paid_smoke',
      status: 'passed',
      created_at: now().toISOString(),
      base_url: baseUrl,
      work_dir: workDir,
      artifacts: {
        brief_markdown: briefPath,
        batch_out_dir: batchDir,
        manifest: path.join(batchDir, 'manifest.json'),
      },
      commands,
      billing,
      duplicate_idempotency_retry: duplicateRetry,
      safety: {
        report_redacted: true,
        api_key_in_argv: false,
        raw_provider_internals_redacted: true,
      },
    }, secrets);
    await writeReport(reportPath, report, secrets);
    return { reportPath, report };
  } catch (error) {
    const failureReport = sanitizeJson({
      schema_version: REPORT_SCHEMA_VERSION,
      type: 'youtubebrief_controlled_paid_smoke',
      status: 'failed',
      created_at: now().toISOString(),
      base_url: baseUrl,
      work_dir: workDir,
      artifacts: {
        brief_markdown: briefPath,
        batch_out_dir: batchDir,
        manifest: path.join(batchDir, 'manifest.json'),
      },
      commands,
      error: sanitizeText(error.message, secrets),
      safety: {
        report_redacted: true,
        api_key_in_argv: false,
      },
    }, secrets);
    await writeReport(reportPath, failureReport, secrets);
    throw error;
  }
}

export function parseSmokeArgs(argv) {
  const result = { batchUrls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base-url') result.baseUrl = readValue(argv, ++index, arg);
    else if (arg === '--work-dir') result.workDir = readValue(argv, ++index, arg);
    else if (arg === '--report') result.reportPath = readValue(argv, ++index, arg);
    else if (arg === '--url') result.url = readValue(argv, ++index, arg);
    else if (arg === '--batch-url') result.batchUrls.push(readValue(argv, ++index, arg));
    else if (arg === '--allow-run') result.allowRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new CliError(`Unknown smoke option: ${arg}`);
  }
  return result;
}

export function smokeHelpText() {
  return `Usage: YB_CONTROLLED_PAID_SMOKE=1 YOUTUBEBRIEF_API_KEY=... node scripts/controlled-paid-smoke.mjs [--base-url <url>] [--work-dir <dir>] [--report <path>] [--url <youtube-url>] [--batch-url <youtube-url>]...\n\nRuns yb doctor, yb brief, yb batch, and a manifest resume retry against a controlled paid test account. Uses env credentials only and writes a redacted JSON report.\n`;
}

async function runCliCommand({ cliBin, args, env, cwd, secrets }) {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on('close', resolve)),
  ]);
  return {
    exitCode,
    stdout: truncate(sanitizeText(stdout, secrets)),
    stderr: truncate(sanitizeText(stderr, secrets)),
  };
}

function assertSuccessOnlyBilling(manifest) {
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  const succeeded = items.filter((item) => item.status === 'succeeded');
  const billedSuccesses = succeeded.filter((item) => item.billed === true);
  const wronglyBilledFailures = items.filter((item) => item.status !== 'succeeded' && item.billed === true);
  if (wronglyBilledFailures.length > 0) {
    throw new CliError('Smoke billing check failed: non-success items were marked billed.');
  }
  if (succeeded.length !== billedSuccesses.length) {
    throw new CliError('Smoke billing check failed: not every successful item was marked billed by the server ledger.');
  }
  return {
    total: items.length,
    succeeded: succeeded.length,
    failed: items.filter((item) => item.status === 'failed').length,
    skipped: items.filter((item) => String(item.status).startsWith('skipped')).length,
    billed_successes: manifest.billed_successes,
    not_billed: manifest.not_billed,
    success_only_billing: true,
  };
}

function assertResumeDidNotDoubleBill(before, after) {
  const beforeBilled = Number(before.billed_successes || 0);
  const afterBilled = Number(after.billed_successes || 0);
  if (afterBilled !== beforeBilled) {
    throw new CliError(`Smoke idempotency check failed: billed successes changed after resume (${beforeBilled} -> ${afterBilled}).`);
  }
  return {
    billed_successes_before: beforeBilled,
    billed_successes_after: afterBilled,
    unchanged: true,
  };
}

async function readJson(filePath, secrets) {
  try {
    return sanitizeJson(JSON.parse(await readFile(filePath, 'utf8')), secrets);
  } catch (error) {
    throw new CliError(`Cannot read smoke JSON artifact ${filePath}: ${sanitizeText(error.message, secrets)}`);
  }
}

async function writeReport(reportPath, report, secrets) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  assertNoSecretLeak(body, secrets);
  await writeFile(reportPath, body, { mode: 0o600 });
}

function assertNoSecretLeak(text, secrets) {
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new CliError('Controlled paid smoke report would contain an API key; refusing to write it.');
  }
  if (/yb_live_[A-Za-z0-9_-]+/.test(text)) throw new CliError('Controlled paid smoke report would contain a live API key pattern; refusing to write it.');
  if (/raw\s+provider\s+response|stack\s*trace/i.test(text)) throw new CliError('Controlled paid smoke report would contain provider internals; refusing to write it.');
}

function sanitizeJson(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeJson(child, secrets)]));
  }
  if (typeof value === 'string') return sanitizeText(value, secrets);
  return value;
}

function sanitizeText(value, secrets = []) {
  let text = sanitizeMessage(value, secrets);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/yb_live_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [redacted]')
    .replace(/raw\s+provider\s+response[:=]?[^\n]*/gi, '[redacted]')
    .replace(/stack\s*trace/gi, '[redacted]')
    .replace(/api[_-]?key[=:]\s*[^\s,&}]+/gi, 'api_key=[redacted]')
    .replace(/access[_-]?token[=:]\s*[^\s,&}]+/gi, 'access_token=[redacted]');
}

function redactArgs(args) {
  return args.map((arg) => /yb_live_|Bearer\s+/i.test(String(arg)) ? '[redacted]' : arg);
}

function truncate(text) {
  const value = String(text ?? '');
  return value.length > MAX_CAPTURE_CHARS ? `${value.slice(0, MAX_CAPTURE_CHARS)}...[truncated]` : value;
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { output += chunk; });
    stream.on('error', reject);
    stream.on('end', () => resolve(output));
  });
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliError(`Missing value for ${flag}.`);
  return value;
}
