import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveTelemetryState, sanitizeTelemetryProperties } from '../src/telemetry.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const YB_BIN = join(ROOT, 'bin', 'yb.js');

function runCli(args, options = {}) {
  const env = {
    ...process.env,
    YOUTUBEBRIEF_CONFIG_DIR: options.configDir,
    ...options.env,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [YB_BIN, ...args], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (options.stdin) child.stdin.end(options.stdin);
  else child.stdin.end();
  return Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolveExit) => child.on('close', resolveExit)),
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
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

async function withMockApi(handler, callback) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      try {
        const result = await handler(record, requests);
        res.statusCode = result.status ?? 200;
        for (const [key, value] of Object.entries(result.headers ?? { 'Content-Type': 'application/json' })) res.setHeader(key, value);
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? {}));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  try {
    return await callback({ baseUrl: `http://127.0.0.1:${port}`, requests });
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

test('telemetry preferences support default-on plus env/config opt-out', () => {
  assert.equal(resolveTelemetryState({}, {}).enabled, true);
  assert.equal(resolveTelemetryState({}, { YB_TELEMETRY: '0' }).enabled, false);
  assert.equal(resolveTelemetryState({ telemetry: false }, {}).enabled, false);
  assert.equal(resolveTelemetryState({ telemetry: false }, { YB_TELEMETRY: '1' }).enabled, true);
});

test('telemetry sanitizer keeps only aggregate fields and drops URLs, tokens, and local paths', () => {
  const safe = sanitizeTelemetryProperties({
    surface: 'cli',
    command: 'batch',
    itemCount: 5,
    combinedMd: true,
    jsonl: true,
    rawUrl: 'https://www.youtube.com/watch?v=secret',
    apiKey: 'FAKE_YB_TEST_TOKEN_secret',
    localPath: '/home/user/secret/yb-out',
    markdown: '# raw brief',
  });
  assert.deepEqual(safe, { surface: 'cli', command: 'batch', itemCount: 5, combinedMd: true, jsonl: true });
  assert.doesNotMatch(JSON.stringify(safe), /youtube|yb_live|\/home|raw brief/i);
});

test('doctor emits visible privacy-safe telemetry and fail-opens when telemetry endpoint rejects', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yb-telemetry-doctor-'));
  try {
    await withMockApi(async (request) => {
      if (request.method === 'GET' && request.url === '/healthz') return { body: { ok: true } };
      if (request.method === 'GET' && request.url === '/api/v1/credits') return { body: { credits: 3 } };
      if (request.method === 'POST' && request.url === '/api/v1/analytics/events') return { status: 503, body: { error: 'down' } };
      return { status: 404, body: { error: { code: 'not_found' } } };
    }, async ({ baseUrl, requests }) => {
      const outDir = join(configDir, 'private-output-dir');
      const result = await runCli(['doctor', '--out-dir', outDir], {
        configDir,
        env: { YOUTUBEBRIEF_BASE_URL: baseUrl, YOUTUBEBRIEF_API_KEY: 'FAKE_YB_TEST_TOKEN_telemetry_secret' },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /telemetry: ok - Privacy-safe activation telemetry is on/);
      const telemetryRequest = requests.find((request) => request.method === 'POST' && request.url === '/api/v1/analytics/events');
      assert.ok(telemetryRequest, 'doctor should attempt activation telemetry');
      assert.doesNotMatch(telemetryRequest.body, /FAKE_YB_TEST_TOKEN_telemetry_secret|private-output-dir|\/tmp\//i);
      const payload = JSON.parse(telemetryRequest.body);
      assert.equal(payload.events[0].eventName, 'cli_doctor');
      assert.equal(payload.events[0].properties.command, 'doctor');
      assert.equal(payload.events[0].properties.hasOutDir, true);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('batch emits aggregate PQL events for 5+ URL combined/jsonl dry-run without raw URLs or paths', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yb-telemetry-batch-'));
  try {
    await withMockApi(async (request) => {
      if (request.method === 'POST' && request.url === '/api/v1/analytics/events') return { status: 202, body: { ok: true } };
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    }, async ({ baseUrl, requests }) => {
      const outDir = join(configDir, 'yb-out');
      const urls = [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=JaRGJVrJBQ8',
        'https://www.youtube.com/watch?v=DxL2HoqLbyA',
        'https://www.youtube.com/watch?v=ZoqgAy3h4OM',
      ];
      const result = await runCli(['batch', '--out-dir', outDir, '--dry-run', '--combined-md', '--jsonl', ...urls], {
        configDir,
        env: { YOUTUBEBRIEF_BASE_URL: baseUrl, YOUTUBEBRIEF_API_KEY: undefined },
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const telemetryRequest = requests.find((request) => request.method === 'POST' && request.url === '/api/v1/analytics/events');
      assert.ok(telemetryRequest, 'batch should emit activation telemetry');
      assert.doesNotMatch(telemetryRequest.body, /youtube\.com|youtu\.be|LPZh9BOjkQs|yb-out|\/tmp\//i);
      const names = JSON.parse(telemetryRequest.body).events.map((event) => event.eventName).sort();
      assert.deepEqual(names, ['cli_batch', 'cli_batch_5plus', 'cli_batch_combined_md', 'cli_batch_jsonl'].sort());
      const batchEvent = JSON.parse(telemetryRequest.body).events.find((event) => event.eventName === 'cli_batch');
      assert.equal(batchEvent.properties.itemCount, 5);
      assert.equal(batchEvent.properties.combinedMd, true);
      assert.equal(batchEvent.properties.jsonl, true);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('stored config can opt out of telemetry without contacting the analytics endpoint', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'yb-telemetry-off-'));
  try {
    const setOff = await runCli(['config', 'set', 'telemetry', 'off'], { configDir });
    assert.equal(setOff.exitCode, 0, setOff.stderr);
    assert.match(setOff.stdout, /Set telemetry to off/);
    const stored = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8'));
    assert.equal(stored.telemetry, false);

    await withMockApi(async (request) => {
      if (request.method === 'GET' && request.url === '/healthz') return { body: { ok: true } };
      if (request.method === 'POST' && request.url === '/api/v1/analytics/events') throw new Error('telemetry must be disabled');
      return { status: 404, body: { error: { code: 'not_found' } } };
    }, async ({ baseUrl, requests }) => {
      const result = await runCli(['doctor'], { configDir, env: { YOUTUBEBRIEF_BASE_URL: baseUrl } });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /telemetry: info - Privacy-safe activation telemetry is off/);
      assert.equal(requests.filter((request) => request.url === '/api/v1/analytics/events').length, 0);
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
