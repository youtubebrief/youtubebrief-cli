import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { YoutubebriefClient } from '../src/api.mjs';
import { exportBatchBundle, getBatchExitCode, MANIFEST_JSON_SCHEMA, normalizeBatchYoutubeUrl, readBatchManifest, runBatch, splitInputLines, summarizeBatchManifest } from '../src/batch.mjs';

async function tempOutDir() {
  return await mkdtemp(path.join(tmpdir(), 'yb-batch-'));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('batch input helpers accept only supported HTTPS YouTube URL shapes', () => {
  assert.deepEqual(splitInputLines('\n# comment\nhttps://youtu.be/LPZh9BOjkQs\n  \nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n'), [
    'https://youtu.be/LPZh9BOjkQs',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  ]);
  assert.equal(normalizeBatchYoutubeUrl('https://youtu.be/LPZh9BOjkQs').canonicalUrl, 'https://www.youtube.com/watch?v=LPZh9BOjkQs');
  assert.equal(normalizeBatchYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ');

  for (const unsafe of [
    'http://www.youtube.com/watch?v=LPZh9BOjkQs',
    'file:///etc/passwd',
    'ftp://youtube.com/watch?v=LPZh9BOjkQs',
    'data:text/plain,hello',
    'https://localhost/watch?v=LPZh9BOjkQs',
    'https://127.0.0.1/watch?v=LPZh9BOjkQs',
    'https://10.0.0.7/watch?v=LPZh9BOjkQs',
    'https://192.168.1.20/watch?v=LPZh9BOjkQs',
    'https://172.16.0.2/watch?v=LPZh9BOjkQs',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://example.com/watch?v=LPZh9BOjkQs',
  ]) {
    assert.throws(() => normalizeBatchYoutubeUrl(unsafe), /YouTube URL|Unsupported|Unsafe/i, unsafe);
  }
});

test('batch runner writes manifest and per-video files while continuing provider failures', async () => {
  const outDir = await tempOutDir();
  const calls = [];
  const client = {
    async createBrief(url, options) {
      calls.push({ url, options });
      if (url.includes('dQw4w9WgXcQ')) {
        throw new Error('provider 503 raw_provider_secret FAKE_YB_TEST_TOKEN_secret_token stack trace');
      }
      return {
        id: `sum_${calls.length}`,
        status: 'completed',
        markdown: `# Brief for ${url}\nraw provider response: {"api_key":"FAKE_YB_TEST_TOKEN_secret_token","stack":"stack trace"}\n`,
        rawProviderResponse: {
          api_key: 'FAKE_YB_TEST_TOKEN_secret_token',
          access_token: 'FAKE_SK_TEST_TOKEN_secret',
          stack: 'stack trace'
        },
        billing: {
          billed: true,
          billingEventId: `bill_${calls.length}`,
          idempotencyKey: options.idempotencyKey,
        }
      };
    }
  };
  try {
    const manifest = await runBatch({
      inputs: [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/embed/JaRGJVrJBQ8'
      ],
      client,
      outDir,
      concurrency: 2,
      secrets: ['FAKE_YB_TEST_TOKEN_secret_token']
    });

    assert.equal(manifest.status, 'partial_failure');
    assert.equal(manifest.total, 3);
    assert.equal(manifest.succeeded, 2);
    assert.equal(manifest.failed, 1);
    assert.equal(manifest.billed_successes, 2);
    assert.equal(manifest.not_billed, 1);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.options.idempotencyKey.startsWith(`${manifest.batch_id}:item_`)));

    const diskManifest = await readJson(path.join(outDir, 'manifest.json'));
    assert.equal(diskManifest.batch_id, manifest.batch_id);
    assert.equal(diskManifest.items[1].error_code, 'provider_error');
    assert.equal(diskManifest.items[1].retryable, true);
    assert.equal(diskManifest.items[1].billed, false);
    assert.doesNotMatch(JSON.stringify(diskManifest), /FAKE_YB_TEST_TOKEN_secret_token|raw_provider_secret|stack trace/i);

    const videos = await readdir(path.join(outDir, 'videos'));
    assert.deepEqual(videos.filter((name) => name.endsWith('.md')).sort(), ['JaRGJVrJBQ8.md', 'LPZh9BOjkQs.md']);
    assert.deepEqual(videos.filter((name) => name.endsWith('.json')).sort(), ['JaRGJVrJBQ8.json', 'LPZh9BOjkQs.json']);
    assert.equal(videos.some((name) => name.endsWith('.tmp')), false);
    const writtenMarkdown = await readFile(path.join(outDir, 'videos', 'LPZh9BOjkQs.md'), 'utf8');
    const writtenJson = await readJson(path.join(outDir, 'videos', 'LPZh9BOjkQs.json'));
    assert.match(writtenMarkdown, /^# Brief/);
    assert.doesNotMatch(writtenMarkdown, /FAKE_YB_TEST_TOKEN_secret_token|raw provider response|stack trace/i);
    assert.doesNotMatch(JSON.stringify(writtenJson), /FAKE_YB_TEST_TOKEN_secret_token|FAKE_SK_TEST_TOKEN_secret|rawProviderResponse|access_token|api_key|stack trace/i);
    assert.match(summarizeBatchManifest(manifest), /yb batch completed/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('fresh batch runs get fresh ids while persisted running manifests are non-terminal', async () => {
  const firstOutDir = await tempOutDir();
  const secondOutDir = await tempOutDir();
  const firstCalls = [];
  const secondCalls = [];
  try {
    const first = await runBatch({
      inputs: ['https://youtu.be/LPZh9BOjkQs'],
      client: {
        async createBrief(url, options) {
          firstCalls.push({ url, options });
          const runningManifest = await readJson(path.join(firstOutDir, 'manifest.json'));
          assert.equal(runningManifest.status, 'running');
          assert.equal(runningManifest.finished_at, null);
          return {
            id: 'sum_first',
            status: 'completed',
            markdown: '# First\n',
            billing: { billed: true, billingEventId: 'bill_first', idempotencyKey: options.idempotencyKey }
          };
        }
      },
      outDir: firstOutDir
    });

    const second = await runBatch({
      inputs: ['https://youtu.be/LPZh9BOjkQs'],
      client: {
        async createBrief(url, options) {
          secondCalls.push({ url, options });
          return {
            id: 'sum_second',
            status: 'completed',
            markdown: '# Second\n',
            billing: { billed: true, billingEventId: 'bill_second', idempotencyKey: options.idempotencyKey }
          };
        }
      },
      outDir: secondOutDir
    });

    assert.notEqual(first.batch_id, second.batch_id);
    assert.notEqual(first.items[0].idempotency_key, second.items[0].idempotency_key);
    assert.equal(firstCalls[0].options.idempotencyKey, first.items[0].idempotency_key);
    assert.equal(secondCalls[0].options.idempotencyKey, second.items[0].idempotency_key);
  } finally {
    await rm(firstOutDir, { recursive: true, force: true });
    await rm(secondOutDir, { recursive: true, force: true });
  }
});

test('batch dry-run and estimate modes validate, dedupe, and make zero API calls', async () => {
  const outDir = await tempOutDir();
  let calls = 0;
  try {
    const dryRun = await runBatch({
      inputs: [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=LPZh9BOjkQs',
        'https://example.com/not-youtube',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      ],
      client: { async createBrief() { calls += 1; throw new Error('must not call API'); } },
      outDir,
      dryRun: true,
      billingBlockMinutes: 30
    });

    assert.equal(calls, 0);
    assert.equal(dryRun.status, 'planned');
    assert.equal(dryRun.mode, 'dry_run');
    assert.equal(dryRun.total, 4);
    assert.equal(dryRun.failed, 1);
    assert.equal(dryRun.skipped, 1);
    assert.equal(dryRun.estimated_billable_items, 2);
    assert.equal(dryRun.estimated_billing_block_minutes, 60);
    assert.equal(dryRun.items[1].status, 'skipped_duplicate');
    assert.equal(dryRun.items[2].error_code, 'invalid_url');
    assert.equal(getBatchExitCode(dryRun), 0);

    const diskManifest = await readBatchManifest(outDir);
    assert.equal(diskManifest.mode, 'dry_run');

    const estimateOut = await tempOutDir();
    try {
      const estimate = await runBatch({
        inputs: ['https://youtu.be/LPZh9BOjkQs'],
        outDir: estimateOut,
        estimateCredits: true,
        billingBlockMinutes: 10
      });
      assert.equal(estimate.status, 'estimated');
      assert.equal(estimate.mode, 'estimate_credits');
      assert.equal(estimate.estimated_billable_items, 1);
      assert.equal(estimate.estimated_billing_block_minutes, 10);
      assert.equal(calls, 0);
    } finally {
      await rm(estimateOut, { recursive: true, force: true });
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('batch runner writes deterministic combined Markdown and JSONL exports when requested', async () => {
  const outDir = await tempOutDir();
  try {
    const manifest = await runBatch({
      inputs: [
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://youtu.be/LPZh9BOjkQs'
      ],
      client: {
        async createBrief(url, options) {
          return {
            id: `sum_${url.slice(-4)}`,
            status: 'completed',
            markdown: `# Brief ${url}\n\nsecret api_key=FAKE_YB_TEST_TOKEN_secret stack trace\n`,
            billing: { billed: true, billingEventId: `bill_${url.slice(-4)}`, idempotencyKey: options.idempotencyKey },
            rawProviderResponse: { api_key: 'FAKE_YB_TEST_TOKEN_secret' }
          };
        }
      },
      outDir,
      combinedMd: true,
      jsonl: true,
      secrets: ['FAKE_YB_TEST_TOKEN_secret']
    });

    assert.equal(manifest.schema_version, MANIFEST_JSON_SCHEMA.properties.schema_version.const);
    assert.equal(manifest.outputs.combined_markdown, 'combined.md');
    assert.equal(manifest.outputs.jsonl, 'videos.jsonl');

    const combined = await readFile(path.join(outDir, 'combined.md'), 'utf8');
    assert.match(combined, /^# Youtubebrief Batch/);
    assert.ok(combined.indexOf('dQw4w9WgXcQ') < combined.indexOf('LPZh9BOjkQs'), 'combined output follows input_index order');
    assert.doesNotMatch(combined, /FAKE_YB_TEST_TOKEN_secret|api_key=|stack trace/i);

    const jsonl = await readFile(path.join(outDir, 'videos.jsonl'), 'utf8');
    const rows = jsonl.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.item.normalized_video_id), ['dQw4w9WgXcQ', 'LPZh9BOjkQs']);
    assert.doesNotMatch(jsonl, /FAKE_YB_TEST_TOKEN_secret|rawProviderResponse|api_key|stack trace/i);

    const diskManifest = await readBatchManifest(outDir);
    assert.equal(diskManifest.outputs.combined_markdown, 'combined.md');
    assert.equal(diskManifest.outputs.jsonl, 'videos.jsonl');

    const exportedCombined = await exportBatchBundle({ outDir, format: 'combined-md', output: '-' });
    assert.equal(exportedCombined.content, combined);
    const exportedJsonl = await exportBatchBundle({ outDir, format: 'jsonl', output: '-' });
    assert.equal(exportedJsonl.content, jsonl);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('batch runner stops undispatched items after insufficient credits', async () => {
  const outDir = await tempOutDir();
  const calls = [];
  const client = {
    async createBrief(url) {
      calls.push(url);
      if (url.includes('dQw4w9WgXcQ')) {
        const error = new Error('HTTP 402 insufficient credits FAKE_YB_TEST_TOKEN_secret_token');
        error.code = 'insufficient_credits';
        throw error;
      }
      return {
        id: 'sum_success',
        status: 'completed',
        markdown: '# Success\n',
        billing: { billed: true, billingEventId: 'bill_success' }
      };
    }
  };
  try {
    const manifest = await runBatch({
      inputs: [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=JaRGJVrJBQ8'
      ],
      client,
      outDir,
      concurrency: 1,
      secrets: ['FAKE_YB_TEST_TOKEN_secret_token']
    });

    assert.equal(calls.length, 2, 'undispatched items should not be sent after insufficient credits');
    assert.equal(manifest.status, 'partial_failure');
    assert.equal(manifest.succeeded, 1);
    assert.equal(manifest.failed, 1);
    assert.equal(manifest.skipped, 1);
    assert.equal(manifest.items[1].error_code, 'insufficient_credits');
    assert.equal(manifest.items[1].billed, false);
    assert.equal(manifest.items[2].status, 'skipped_due_to_insufficient_credits');
    assert.equal(manifest.items[2].billed, false);
    assert.doesNotMatch(JSON.stringify(manifest), /FAKE_YB_TEST_TOKEN_secret_token/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('batch resume skips prior successes and reuses item idempotency keys', async () => {
  const outDir = await tempOutDir();
  const calls = [];
  try {
    const first = await runBatch({
      inputs: [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
      ],
      client: {
        async createBrief(url, options) {
          calls.push({ phase: 'first', url, options });
          if (url.includes('dQw4w9WgXcQ')) {
            const error = new Error('provider timeout');
            error.code = 'provider_error';
            throw error;
          }
          return {
            id: 'sum_success',
            status: 'completed',
            markdown: '# Success\n',
            billing: { billed: true, billingEventId: 'bill_first', idempotencyKey: options.idempotencyKey }
          };
        }
      },
      outDir,
      concurrency: 1
    });
    assert.equal(first.status, 'partial_failure');
    const failedKey = first.items[1].idempotency_key;

    const resumed = await runBatch({
      outDir,
      resume: true,
      client: {
        async createBrief(url, options) {
          calls.push({ phase: 'resume', url, options });
          return {
            id: 'sum_retry_success',
            status: 'completed',
            markdown: '# Retried success\n',
            billing: { billed: true, billingEventId: 'bill_retry', idempotencyKey: options.idempotencyKey }
          };
        }
      }
    });

    assert.equal(resumed.status, 'succeeded');
    assert.equal(calls.filter((call) => call.phase === 'resume').length, 1);
    assert.equal(calls.find((call) => call.phase === 'resume').url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(calls.find((call) => call.phase === 'resume').options.idempotencyKey, failedKey);
    assert.equal(resumed.items[0].status, 'succeeded');
    assert.equal(resumed.items[1].status, 'succeeded');
    assert.equal(resumed.billed_successes, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('batch failed-only and retry-provider-errors limit eligible retry items', async () => {
  const outDir = await tempOutDir();
  try {
    await runBatch({
      inputs: [
        'https://youtu.be/LPZh9BOjkQs',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        'https://www.youtube.com/watch?v=JaRGJVrJBQ8'
      ],
      client: {
        async createBrief(url) {
          if (url.includes('dQw4w9WgXcQ')) {
            const error = new Error('provider 503');
            error.code = 'provider_error';
            throw error;
          }
          if (url.includes('JaRGJVrJBQ8')) {
            const error = new Error('HTTP 402 insufficient credits');
            error.code = 'insufficient_credits';
            throw error;
          }
          return { id: 'sum_ok', status: 'completed', markdown: '# OK\n', billing: { billed: true, billingEventId: 'bill_ok' } };
        }
      },
      outDir,
      concurrency: 1
    });

    const providerRetryCalls = [];
    const providerOnly = await runBatch({
      outDir,
      retryProviderErrors: true,
      client: {
        async createBrief(url) {
          providerRetryCalls.push(url);
          return { id: 'sum_provider_retry', status: 'completed', markdown: '# Provider retry\n', billing: { billed: true, billingEventId: 'bill_provider_retry' } };
        }
      }
    });
    assert.deepEqual(providerRetryCalls, ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']);
    assert.equal(providerOnly.items[1].status, 'succeeded');
    assert.equal(providerOnly.items[2].error_code, 'insufficient_credits');

    const failedOnlyCalls = [];
    const failedOnly = await runBatch({
      outDir,
      failedOnly: true,
      client: {
        async createBrief(url) {
          failedOnlyCalls.push(url);
          return { id: 'sum_failed_only_retry', status: 'completed', markdown: '# Failed only retry\n', billing: { billed: true, billingEventId: 'bill_failed_only_retry' } };
        }
      }
    });
    assert.deepEqual(failedOnlyCalls, ['https://www.youtube.com/watch?v=JaRGJVrJBQ8']);
    assert.equal(failedOnly.status, 'succeeded');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('batch runner records missing server billing facts as not billed instead of inferring charge', async () => {
  const outDir = await tempOutDir();
  try {
    const manifest = await runBatch({
      inputs: ['https://youtu.be/LPZh9BOjkQs'],
      client: {
        async createBrief() {
          return {
            id: 'sum_admin_or_legacy',
            status: 'completed',
            markdown: '# Success without billing facts\n'
          };
        }
      },
      outDir
    });

    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.succeeded, 1);
    assert.equal(manifest.billed_successes, 0);
    assert.equal(manifest.not_billed, 1);
    assert.equal(manifest.items[0].billed, false);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('YoutubebriefClient forwards item idempotency keys to the paid summary API', async () => {
  const requests = [];
  const client = new YoutubebriefClient({
    baseUrl: 'https://api.example.test',
    apiKey: 'FAKE_YB_TEST_TOKEN_test_secret',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 201,
        async text() {
          return JSON.stringify({ id: 'sum_done', status: 'completed', markdown: '# Done\n' });
        }
      };
    }
  });

  await client.createBrief('https://www.youtube.com/watch?v=LPZh9BOjkQs', {
    billingBlockMinutes: 10,
    idempotencyKey: 'batch_abc:item_0'
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example.test/api/v1/summaries');
  assert.equal(requests[0].init.headers.authorization, 'Bearer FAKE_YB_TEST_TOKEN_test_secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    youtubeUrl: 'https://www.youtube.com/watch?v=LPZh9BOjkQs',
    billingBlockMinutes: 10,
    idempotencyKey: 'batch_abc:item_0'
  });
});

test('YoutubebriefClient preserves create-response billing facts when following resultUrl', async () => {
  const requests = [];
  const client = new YoutubebriefClient({
    baseUrl: 'https://api.example.test',
    apiKey: 'FAKE_YB_TEST_TOKEN_test_secret',
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url === 'https://api.example.test/api/v1/summaries') {
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              id: 'sum_done',
              status: 'completed',
              resultUrl: '/api/v1/summaries/sum_done',
              billing: {
                billed: true,
                billingEventId: 'bill_from_create',
                remainingMinutes: 20
              }
            });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ id: 'sum_done', status: 'completed', markdown: '# Done\n' });
        }
      };
    }
  });

  const payload = await client.createBrief('https://www.youtube.com/watch?v=LPZh9BOjkQs');

  assert.equal(requests.length, 2);
  assert.equal(payload.markdown, '# Done\n');
  assert.deepEqual(payload.billing, {
    billed: true,
    billingEventId: 'bill_from_create',
    remainingMinutes: 20
  });
});

test('YoutubebriefClient rejects cross-origin result URLs before sending the API key', async () => {
  for (const resultUrl of ['https://evil.example.test/steal', '//evil.example.test/steal']) {
    const requests = [];
    const client = new YoutubebriefClient({
      baseUrl: 'https://api.example.test',
      apiKey: 'FAKE_YB_TEST_TOKEN_test_secret',
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        return {
          ok: true,
          status: 201,
          async text() {
            return JSON.stringify({
              id: 'sum_cross_origin',
              status: 'completed',
              resultUrl
            });
          }
        };
      }
    });

    await assert.rejects(
      () => client.createBrief('https://www.youtube.com/watch?v=LPZh9BOjkQs'),
      /cross-origin result URL/i
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.example.test/api/v1/summaries');
    assert.equal(requests[0].init.headers.authorization, 'Bearer FAKE_YB_TEST_TOKEN_test_secret');
  }
});
