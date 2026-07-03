#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = path.join(ROOT, 'bin', 'yb.js');
const MCP_BIN = path.join(ROOT, 'bin', 'youtubebrief-mcp.js');
const DEFAULT_BASE_URL = 'https://youtubebrief.com';
const EXPECTED_TOOLS = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
const DEFAULT_URLS = [
  'https://www.youtube.com/watch?v=LPZh9BOjkQs',
  'https://youtu.be/LPZh9BOjkQs',
  'https://example.com/not-youtube',
];
const SECRET_PATTERNS = [
  /cfk_[A-Za-z0-9]+/g,
  /yb_live_[A-Za-z0-9._-]+/g,
  /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const baseUrl = options.baseUrl || process.env.YOUTUBEBRIEF_BASE_URL || DEFAULT_BASE_URL;
  const workDir = path.resolve(options.workDir || await mkdtemp(path.join(tmpdir(), 'yb-production-safe-smoke-')));
  const reportPath = path.resolve(options.report || path.join(workDir, 'production-safe-smoke-report.json'));
  const outDir = path.join(workDir, 'batch-out');
  const urlsPath = path.join(workDir, 'urls.txt');
  await mkdir(workDir, { recursive: true });
  await writeFile(urlsPath, `${DEFAULT_URLS.join('\n')}\n`, 'utf8');

  const env = {
    ...process.env,
    YOUTUBEBRIEF_BASE_URL: baseUrl,
    YB_BASE_URL: baseUrl,
    YOUTUBEBRIEF_CONFIG_DIR: path.join(workDir, 'config'),
    // No API key is supplied by this no-spend smoke. This intentionally prevents paid calls.
    YOUTUBEBRIEF_API_KEY: '',
    YB_API_KEY: '',
  };

  const commands = [];
  const runStep = async (name, args, allowedExitCodes = [0]) => {
    const result = await run(process.execPath, [CLI_BIN, ...args], { cwd: ROOT, env });
    commands.push({ name, command: 'yb', args: redactArgs(args), ...result });
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new Error(`${name} exited ${result.exitCode}; see ${reportPath}`);
    }
    return result;
  };

  await runStep('doctor', ['doctor', '--base-url', baseUrl, '--out-dir', workDir], [0, 4]);
  await runStep('whoami_no_auth', ['whoami', '--base-url', baseUrl], [0, 1, 4]);
  await runStep('credits_no_auth', ['credits', '--base-url', baseUrl], [0, 1, 4]);
  await runStep('batch_dry_run', ['batch', '--out-dir', outDir, '--dry-run', '--input', urlsPath], [0]);
  await runStep('batch_estimate', ['batch', '--out-dir', path.join(workDir, 'estimate-out'), '--estimate-credits', '--input', urlsPath], [0]);

  const mcpMessages = await runMcpEstimate(env);
  const batchManifest = await readOptionalJson(path.join(outDir, 'manifest.json'));
  const report = sanitizeJson({
    schema_version: '1.0',
    type: 'youtubebrief_production_safe_smoke',
    status: 'passed',
    created_at: new Date().toISOString(),
    base_url: baseUrl,
    work_dir: workDir,
    no_spend: true,
    paid_provider_calls_attempted: false,
    api_key_supplied: false,
    commands,
    mcp: mcpMessages,
    artifacts: {
      report: reportPath,
      dry_run_manifest: path.join(outDir, 'manifest.json'),
      urls: urlsPath,
    },
    batch_summary: batchManifest ? {
      mode: batchManifest.mode,
      status: batchManifest.status,
      total: batchManifest.total,
      estimated_billable_items: batchManifest.estimated_billable_items,
      billed_successes: batchManifest.billed_successes,
    } : null,
    safety: {
      redacted_report: true,
      no_api_key_in_argv: true,
      no_paid_brief_or_batch_execution: true,
      no_provider_or_credit_consumption: true,
      forbidden_ports_untouched: 'no listener or port changes; no TCP 20000-20201 or UDP 51820 usage',
    },
  });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  assertNoSecret(body);
  await writeFile(reportPath, body, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ok: true, report: reportPath, no_spend: true, base_url: baseUrl }, null, 2) + '\n');
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--base-url') result.baseUrl = readValue(argv, ++index, arg);
    else if (arg === '--work-dir') result.workDir = readValue(argv, ++index, arg);
    else if (arg === '--report') result.report = readValue(argv, ++index, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`Missing value for ${flag}`);
  return value;
}

function helpText() {
  return `Usage: node scripts/production-safe-smoke.mjs [--base-url <url>] [--work-dir <dir>] [--report <path>]\n\nRuns a no-spend production smoke: yb doctor, unauthenticated whoami/credits, batch dry-run, batch estimate, MCP tools/list, and MCP estimate_brief_cost. It never runs yb brief or paid batch execution.\n`;
}

async function runMcpEstimate(env) {
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'production-safe-smoke', version: '0.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: DEFAULT_URLS, billing_block_minutes: 10 } } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = await run(process.execPath, [MCP_BIN], { cwd: ROOT, env, input, raw: true });
  if (result.exitCode !== 0) throw new Error(`mcp estimate exited ${result.exitCode}`);
  if (result.stderr.trim()) throw new Error(`mcp estimate wrote stderr: ${result.stderr}`);
  const messages = result.stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  const tools = messages.find((message) => message.id === 2)?.result?.tools?.map((tool) => tool.name) || [];
  const estimate = messages.find((message) => message.id === 3)?.result?.structuredContent || null;
  for (const expected of EXPECTED_TOOLS) {
    if (!tools.includes(expected)) throw new Error(`missing MCP tool ${expected}`);
  }
  if (!estimate || estimate.billable_items !== 1 || estimate.duplicate_items !== 1 || estimate.invalid_items !== 1) {
    throw new Error(`unexpected MCP estimate result: ${JSON.stringify(estimate)}`);
  }
  return { tools, estimate };
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, npm_config_update_notifier: 'false', ...(options.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      const sanitizedStdout = sanitizeText(stdout);
      const sanitizedStderr = sanitizeText(stderr);
      resolve({
        exitCode,
        stdout: options.raw ? sanitizedStdout : truncate(sanitizedStdout),
        stderr: options.raw ? sanitizedStderr : truncate(sanitizedStderr),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function redactArgs(args) {
  return args.map((arg) => String(arg).replace(/--api-key=.*/i, '--api-key=[redacted]'));
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitizeJson(child)]));
  if (typeof value === 'string') return sanitizeText(value);
  return value;
}

function sanitizeText(value) {
  let text = String(value || '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, (_, prefix = '') => `${prefix}[redacted]`);
  return text;
}

function truncate(text, max = 2400) {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function assertNoSecret(text) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error(`report contains forbidden secret-like pattern: ${pattern}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${sanitizeText(error.message)}\n`);
  process.exitCode = 1;
});
