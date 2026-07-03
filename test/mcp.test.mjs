import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MANIFEST_JSON_SCHEMA } from '../src/batch.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MCP_BIN = join(ROOT, 'bin', 'youtubebrief-mcp.js');

async function runMcpSession(messages, options = {}) {
  const env = { ...process.env, ...options.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  const child = spawn(process.execPath, [MCP_BIN], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise((resolve) => child.on('close', resolve)),
  ]);
  return {
    stdout,
    stderr,
    exitCode,
    messages: stdout.trim() ? stdout.trim().split('\n').map((line) => JSON.parse(line)) : [],
  };
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
  const server = createServer(async (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body };
      requests.push(record);
      try {
        const result = await handler(record, requests);
        res.statusCode = result.status ?? 200;
        for (const [key, value] of Object.entries(result.headers ?? { 'Content-Type': 'application/json' })) {
          res.setHeader(key, value);
        }
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await callback({ baseUrl: `http://127.0.0.1:${port}`, requests });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('MCP stdio initializes and lists the deterministic Youtubebrief tool set without stdout logs', async () => {
  const result = await runMcpSession([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { env: { YB_API_KEY: undefined, YOUTUBEBRIEF_API_KEY: undefined } });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].result.protocolVersion, '2025-11-25');
  assert.deepEqual(result.messages[1].result.tools.map((tool) => tool.name), [
    'check_credits',
    'estimate_brief_cost',
    'brief_youtube_video',
    'batch_brief_youtube_videos',
    'read_batch_manifest',
    'read_brief_output',
  ]);
  for (const line of result.stdout.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
});

test('MCP tools validate runtime arguments against declared schemas', async () => {
  const result = await runMcpSession([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: 'https://youtu.be/LPZh9BOjkQs' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brief_youtube_video', arguments: { url: 'https://youtu.be/LPZh9BOjkQs', extra: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: '.', max_chars: 10 } } },
  ], {
    env: {
      YB_API_KEY: undefined,
      YOUTUBEBRIEF_API_KEY: undefined,
      YB_TELEMETRY: '0',
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].result.isError, true);
  assert.match(result.messages[0].result.structuredContent.error, /arguments\.urls must be an array/);
  assert.equal(result.messages[1].result.isError, true);
  assert.match(result.messages[1].result.structuredContent.error, /arguments\.extra is not allowed/);
  assert.equal(result.messages[2].result.isError, true);
  assert.match(result.messages[2].result.structuredContent.error, /arguments\.path is required/);
});

test('MCP Claude Code and Codex config examples point at the local stdio command with env auth', async () => {
  const claude = JSON.parse(await readFile(join(ROOT, 'examples', 'claude-code-mcp.json'), 'utf8'));
  assert.equal(claude.mcpServers.youtubebrief.type, 'stdio');
  assert.equal(claude.mcpServers.youtubebrief.command, 'npx');
  assert.deepEqual(claude.mcpServers.youtubebrief.args, ['-y', '--package', '@youtubebrief/cli@beta', 'yb', 'mcp']);
  assert.equal(claude.mcpServers.youtubebrief.env.YB_API_KEY, '${YB_API_KEY}');

  const codex = await readFile(join(ROOT, 'examples', 'codex-config.toml'), 'utf8');
  assert.match(codex, /\[mcp_servers\.youtubebrief\]/);
  assert.match(codex, /command = "npx"/);
  assert.ok(codex.includes('args = ["-y", "--package", "@youtubebrief/cli@beta", "yb", "mcp"]'));
  assert.ok(codex.includes('env_vars = ["YB_API_KEY"]'));
});

test('MCP tools use YB_API_KEY precedence, avoid estimate billing, write batch bundles, and reject path traversal', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'yb-mcp-out-'));
  try {
    await withMockApi(async (request) => {
      if (request.method === 'GET' && request.url === '/api/v1/credits') {
        assert.equal(request.headers.authorization, 'Bearer FAKE_YB_TEST_TOKEN_mcp_primary');
        return { body: { credits: 9 } };
      }
      if (request.method === 'POST' && request.url === '/api/v1/summaries') {
        assert.equal(request.headers.authorization, 'Bearer FAKE_YB_TEST_TOKEN_mcp_primary');
        const body = JSON.parse(request.body);
        assert.match(body.idempotencyKey, /^batch_[a-f0-9]+:item_\d+_[a-f0-9]+$/);
        return {
          status: 201,
          body: {
            id: `sum_${body.youtubeUrl.slice(-4)}`,
            status: 'completed',
            sourceUrl: body.youtubeUrl,
            markdown: `# MCP Smoke\n\n${body.youtubeUrl}\n\nraw provider response: FAKE_YB_TEST_TOKEN_mcp_primary stack trace`,
            billing: {
              billed: true,
              billingEventId: `bill_${body.youtubeUrl.slice(-4)}`,
              idempotencyKey: body.idempotencyKey,
            },
          },
        };
      }
      return { status: 404, body: { error: { code: 'not_found', message: 'missing' } } };
    }, async ({ baseUrl, requests }) => {
      const result = await runMcpSession([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_credits', arguments: {} } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: ['https://youtu.be/LPZh9BOjkQs', 'https://youtu.be/LPZh9BOjkQs', 'https://example.com/nope'], billing_block_minutes: 10 } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'batch_brief_youtube_videos', arguments: { urls: ['https://youtu.be/LPZh9BOjkQs'], out_dir: outDir, concurrency: 1, combined_md: true, jsonl: true } } },
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_batch_manifest', arguments: { out_dir: outDir, limit: 5 } } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: '../escape.md' } } },
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: 'videos/LPZh9BOjkQs.md', max_chars: 30 } } },
        { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: 'manifest.json' } } },
      ], {
        env: {
          YB_BASE_URL: baseUrl,
          YOUTUBEBRIEF_BASE_URL: 'http://should-not-be-used.invalid',
          YB_API_KEY: 'FAKE_YB_TEST_TOKEN_mcp_primary',
          YOUTUBEBRIEF_API_KEY: 'FAKE_YB_TEST_TOKEN_mcp_secondary',
        },
      });

      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.messages.length, 8);
      const credits = result.messages.find((message) => message.id === 2).result;
      assert.equal(credits.isError, false);
      assert.equal(credits.structuredContent.credits, 9);
      assert.equal(credits.structuredContent.auth_source, 'YB_API_KEY');

      const estimate = result.messages.find((message) => message.id === 3).result.structuredContent;
      assert.equal(estimate.billable_items, 1);
      assert.equal(estimate.duplicate_items, 1);
      assert.equal(estimate.invalid_items, 1);
      assert.equal(requests.filter((request) => request.method === 'POST' && request.url === '/api/v1/summaries').length, 1, 'estimate must not call paid API');

      const batch = result.messages.find((message) => message.id === 4).result.structuredContent;
      assert.equal(batch.status, 'succeeded');
      assert.equal(batch.billed_successes, 1);
      assert.match(batch.manifest_path, /manifest\.json$/);
      assert.doesNotMatch(JSON.stringify(result.messages), /FAKE_YB_TEST_TOKEN_mcp_primary|FAKE_YB_TEST_TOKEN_mcp_secondary|raw provider response|stack trace/i);
      assert.doesNotMatch(JSON.stringify(batch), /# MCP Smoke/);
      const telemetryRequests = requests.filter((request) => request.method === 'POST' && request.url === '/api/v1/analytics/events');
      assert.ok(telemetryRequests.length >= 1, 'MCP tool calls should attempt privacy-safe activation telemetry');
      assert.doesNotMatch(JSON.stringify(telemetryRequests.map((request) => request.body)), /FAKE_YB_TEST_TOKEN_mcp_primary|FAKE_YB_TEST_TOKEN_mcp_secondary|youtube\\.com|youtu\\.be|LPZh9BOjkQs|raw provider response|stack trace/i);
      const telemetryEvents = telemetryRequests.flatMap((request) => JSON.parse(request.body).events || []);
      assert.ok(telemetryEvents.some((event) => event.eventName === 'mcp_tool_call' && event.properties.tool === 'batch_brief_youtube_videos'));

      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.billed_successes, 1);
      assert.doesNotMatch(JSON.stringify(manifest), /FAKE_YB_TEST_TOKEN_mcp_primary|raw provider response|stack trace/i);

      const manifestRead = result.messages.find((message) => message.id === 5).result.structuredContent;
      assert.equal(manifestRead.item_count_returned, 1);
      const traversal = result.messages.find((message) => message.id === 6).result;
      assert.equal(traversal.isError, true);
      assert.match(traversal.structuredContent.error, /escapes out_dir|relative/);

      const allowedOutput = result.messages.find((message) => message.id === 7).result;
      assert.equal(allowedOutput.isError, false);
      assert.equal(allowedOutput.structuredContent.path, 'videos/LPZh9BOjkQs.md');
      assert.match(allowedOutput.structuredContent.content, /# MCP Smoke/);
      assert.equal(allowedOutput.structuredContent.truncated, true);

      const unregisteredOutput = result.messages.find((message) => message.id === 8).result;
      assert.equal(unregisteredOutput.isError, true);
      assert.match(unregisteredOutput.structuredContent.error, /not registered in the batch manifest/);
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});


test('MCP read_brief_output refuses arbitrary local directories without a batch manifest handle', async () => {
  const arbitraryDir = await mkdtemp(join(tmpdir(), 'yb-mcp-arbitrary-'));
  try {
    await mkdir(join(arbitraryDir, 'private'), { recursive: true });
    await writeFile(join(arbitraryDir, 'private', 'secret.md'), 'local secret', 'utf8');
    const result = await runMcpSession([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: arbitraryDir, path: 'private/secret.md' } } },
    ], { env: { YB_API_KEY: undefined, YOUTUBEBRIEF_API_KEY: undefined, YB_TELEMETRY: '0' } });

    assert.equal(result.exitCode, 0, result.stderr);
    const read = result.messages.find((message) => message.id === 1).result;
    assert.equal(read.isError, true);
    assert.match(read.structuredContent.error, /manifest|ENOENT|not registered/i);
    assert.doesNotMatch(JSON.stringify(read), /local secret/);
  } finally {
    await rm(arbitraryDir, { recursive: true, force: true });
  }
});


test('MCP tool runtime validation rejects arguments that do not match declared schemas', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'yb-mcp-validation-'));
  try {
    const tooManyUrls = Array.from({ length: 101 }, (_, index) => `https://youtu.be/LPZh9BOj${String(index).padStart(3, '0')}`);
    const result = await runMcpSession([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: ['https://youtu.be/LPZh9BOjkQs'], extra: true } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: 'https://youtu.be/LPZh9BOjkQs' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: [123] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: ['https://youtu.be/LPZh9BOjkQs'], billing_block_minutes: 7 } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'estimate_brief_cost', arguments: { urls: tooManyUrls } } },
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'batch_brief_youtube_videos', arguments: { urls: ['https://youtu.be/LPZh9BOjkQs'], out_dir: outDir, concurrency: 5, estimate_only: true } } },
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: 'videos/LPZh9BOjkQs.md', max_chars: 0 } } },
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'read_batch_manifest', arguments: { out_dir: outDir, limit: 101 } } },
    ], { env: { YB_API_KEY: undefined, YOUTUBEBRIEF_API_KEY: undefined, YB_TELEMETRY: '0' } });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const message of result.messages) assert.equal(message.result.isError, true, `id=${message.id} should be an error`);
    assert.match(result.messages.find((message) => message.id === 1).result.structuredContent.error, /extra.+not allowed/i);
    assert.match(result.messages.find((message) => message.id === 2).result.structuredContent.error, /urls.+array/i);
    assert.match(result.messages.find((message) => message.id === 3).result.structuredContent.error, /urls\[0\].+string/i);
    assert.match(result.messages.find((message) => message.id === 4).result.structuredContent.error, /billing_block_minutes.+one of/i);
    assert.match(result.messages.find((message) => message.id === 5).result.structuredContent.error, /at most 100/i);
    assert.match(result.messages.find((message) => message.id === 6).result.structuredContent.error, /concurrency.+at most 4/i);
    assert.match(result.messages.find((message) => message.id === 7).result.structuredContent.error, /max_chars.+at least 1/i);
    assert.match(result.messages.find((message) => message.id === 8).result.structuredContent.error, /limit.+at most 100/i);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('MCP brief_youtube_video writes a manifest so read_brief_output can read the single-video output', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'yb-mcp-single-'));
  try {
    await withMockApi(async (request) => {
      if (request.method === 'POST' && request.url === '/api/v1/summaries') {
        assert.equal(request.headers.authorization, 'Bearer FAKE_YB_TEST_TOKEN_single_primary');
        return {
          status: 201,
          body: {
            id: 'sum_single',
            status: 'completed',
            sourceUrl: 'https://www.youtube.com/watch?v=LPZh9BOjkQs',
            markdown: '# Single MCP Smoke\n\nraw provider response: FAKE_YB_TEST_TOKEN_single_primary stack trace',
            billing: { billed: true, billingEventId: 'bill_single' },
          },
        };
      }
      return { status: 404, body: { error: { code: 'not_found', message: 'missing' } } };
    }, async ({ baseUrl }) => {
      const result = await runMcpSession([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brief_youtube_video', arguments: { url: 'https://youtu.be/LPZh9BOjkQs', out_dir: outDir, format: 'both' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: 'videos/LPZh9BOjkQs.md', max_chars: 120 } } },
      ], { env: { YB_BASE_URL: baseUrl, YB_API_KEY: 'FAKE_YB_TEST_TOKEN_single_primary' } });

      assert.equal(result.exitCode, 0, result.stderr);
      const brief = result.messages.find((message) => message.id === 1).result;
      assert.equal(brief.isError, false);
      assert.match(brief.structuredContent.manifest_path, /manifest\.json$/);
      assert.equal(brief.structuredContent.outputs.markdown, 'videos/LPZh9BOjkQs.md');
      const read = result.messages.find((message) => message.id === 2).result;
      assert.equal(read.isError, false);
      assert.match(read.structuredContent.content, /# Single MCP Smoke/);
      assert.doesNotMatch(JSON.stringify(result.messages), /FAKE_YB_TEST_TOKEN_single_primary|raw provider response|stack trace/i);
      const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.mode, 'single');
      assert.ok(MANIFEST_JSON_SCHEMA.properties.mode.enum.includes('single'));
      assert.equal(manifest.items[0].markdown_path, 'videos/LPZh9BOjkQs.md');
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('MCP read_brief_output rejects manifest-registered symlinks', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'yb-mcp-symlink-'));
  const secretDir = await mkdtemp(join(tmpdir(), 'yb-mcp-secret-'));
  try {
    await mkdir(join(outDir, 'videos'), { recursive: true });
    await writeFile(join(secretDir, 'secret.md'), 'local symlink secret', 'utf8');
    await symlink(join(secretDir, 'secret.md'), join(outDir, 'videos', 'linked.md'));
    await writeFile(join(outDir, 'manifest.json'), JSON.stringify({
      schema_version: '1.1',
      batch_id: 'batch_symlink',
      status: 'succeeded',
      out_dir: outDir,
      outputs: { combined_markdown: null, jsonl: null },
      items: [{ status: 'succeeded', markdown_path: 'videos/linked.md', json_path: null }]
    }, null, 2), 'utf8');
    const result = await runMcpSession([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_brief_output', arguments: { out_dir: outDir, path: 'videos/linked.md' } } },
    ], { env: { YB_API_KEY: undefined, YOUTUBEBRIEF_API_KEY: undefined, YB_TELEMETRY: '0' } });

    assert.equal(result.exitCode, 0, result.stderr);
    const read = result.messages.find((message) => message.id === 1).result;
    assert.equal(read.isError, true);
    assert.match(read.structuredContent.error, /symlink|regular file|escapes/i);
    assert.doesNotMatch(JSON.stringify(read), /local symlink secret/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(secretDir, { recursive: true, force: true });
  }
});


test('MCP missing auth returns a sanitized tool execution error instead of leaking config state', async () => {
  const result = await runMcpSession([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_credits', arguments: {} } },
  ], {
    env: {
      YB_API_KEY: undefined,
      YOUTUBEBRIEF_API_KEY: undefined,
      YB_TELEMETRY: '0',
      YOUTUBEBRIEF_CONFIG_DIR: join(tmpdir(), `yb-empty-config-${process.pid}-${Date.now()}`),
    },
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].result.isError, true);
  assert.match(result.messages[0].result.structuredContent.error, /Missing API key/);
  assert.doesNotMatch(JSON.stringify(result.messages[0]), /FAKE_YB_TEST_TOKEN_|Bearer\s+/i);
});
