import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { YoutubebriefClient } from './api.mjs';
import { resolveConfig } from './config.mjs';
import { sanitizeMessage } from './errors.mjs';
import { resolveTelemetryState } from './telemetry.mjs';

const MIN_NODE_MAJOR = 20;

export async function runDoctor(options = {}, { stdout = process.stdout, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = await resolveConfig(options, env);
  const secrets = [config.apiKey].filter(Boolean);
  const checks = [];

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  checks.push({
    name: 'node',
    status: nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    detail: `v${process.versions.node} (requires >=${MIN_NODE_MAJOR})`,
  });
  checks.push({ name: 'config_path', status: 'info', detail: config.configPath });
  checks.push({ name: 'base_url', status: 'ok', detail: config.baseUrl });
  checks.push({
    name: 'auth',
    status: config.apiKey ? 'ok' : 'warn',
    detail: config.apiKey ? `API key present via ${config.hasEnvApiKey ? 'environment' : config.hasStoredApiKey ? 'stored config' : 'override'}` : 'No API key found; paid commands will fail until login or YOUTUBEBRIEF_API_KEY is set.',
  });
  const telemetry = resolveTelemetryState(config, env);
  checks.push({
    name: 'telemetry',
    status: telemetry.enabled ? 'ok' : 'info',
    detail: telemetry.enabled
      ? 'Privacy-safe activation telemetry is on. Opt out with `yb config set telemetry off` or YB_TELEMETRY=0.'
      : `Privacy-safe activation telemetry is off (${telemetry.reason}).`,
  });

  if (options.outDir) {
    checks.push(await checkWritableOutDir(options.outDir, secrets));
  } else {
    checks.push({ name: 'out_dir', status: 'skip', detail: 'Pass --out-dir <dir> to check bundle write access.' });
  }

  checks.push(await checkHealth({ baseUrl: config.baseUrl, fetchImpl, secrets }));

  if (config.apiKey) {
    checks.push(await checkCredits({ config, secrets }));
  } else {
    checks.push({ name: 'credits', status: 'skip', detail: 'Skipped because no API key is configured.' });
  }

  const report = { ok: !checks.some((check) => check.status === 'fail'), checks };
  stdout.write(formatDoctorReport(report, secrets));
  return report;
}

export function formatDoctorReport(report, secrets = []) {
  const lines = ['Youtubebrief doctor'];
  for (const check of report.checks) {
    lines.push(`${check.name}: ${check.status}${check.detail ? ` - ${redact(check.detail, secrets)}` : ''}`);
  }
  lines.push(`overall: ${report.ok ? 'ok' : 'fail'}`);
  return `${lines.join('\n')}\n`;
}

async function checkWritableOutDir(outDir, secrets) {
  const absolute = path.resolve(outDir);
  const probe = path.join(absolute, `.yb-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await mkdir(absolute, { recursive: true });
    await writeFile(probe, 'ok\n', { mode: 0o600 });
    await rm(probe, { force: true });
    return { name: 'out_dir', status: 'ok', detail: absolute };
  } catch (error) {
    return { name: 'out_dir', status: 'fail', detail: redact(error.message, secrets) };
  }
}

async function checkHealth({ baseUrl, fetchImpl, secrets }) {
  if (!fetchImpl) return { name: 'health', status: 'fail', detail: 'This Node runtime does not provide fetch.' };
  let url;
  try {
    url = new URL('/healthz', `${baseUrl}/`).toString();
  } catch (error) {
    return { name: 'health', status: 'fail', detail: redact(error.message, secrets) };
  }
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) return { name: 'health', status: 'fail', detail: `HTTP ${response.status} from /healthz` };
    return { name: 'health', status: 'ok', detail: '/healthz reachable' };
  } catch (error) {
    return { name: 'health', status: 'fail', detail: redact(`Cannot reach /healthz: ${error.message}`, secrets) };
  }
}

async function checkCredits({ config, secrets }) {
  try {
    const payload = await new YoutubebriefClient(config).credits();
    return { name: 'credits', status: 'ok', detail: summarizeCredits(payload) };
  } catch (error) {
    const message = redact(error.message, secrets);
    if (message.includes('HTTP 404') || message.includes('not available')) {
      return { name: 'credits', status: 'warn', detail: 'Credits endpoint is not available on this server.' };
    }
    return { name: 'credits', status: 'fail', detail: message };
  }
}

function summarizeCredits(payload) {
  if (typeof payload?.credits === 'number') return `${payload.credits} credits`;
  if (typeof payload?.remaining === 'number') return `${payload.remaining} credits remaining`;
  if (typeof payload?.balance === 'number') return `${payload.balance} credits`;
  return 'Credits endpoint reachable';
}

function redact(value, secrets = []) {
  let text = sanitizeMessage(value, secrets);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/yb_live_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Authorization:\s*Bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/raw\s+provider\s+response[:=]?[^\n]*/gi, '[redacted]')
    .replace(/stack\s*trace/gi, '[redacted]');
}
