import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_ROOT = path.join(ROOT, 'examples', 'sample-bundles');
const EXPECTED_BUNDLES = new Set(['mcp-agent-workflow', 'rag-jsonl-pipeline', 'devrel-research']);
const PACKAGE_VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;

const SECRET_PATTERNS = [
  /cfk_[A-Za-z0-9]+/,
  /yb_live_[A-Za-z0-9_-]+/,
  /sk_live_[A-Za-z0-9_-]+/,
  /FAKE_YB_TEST_TOKEN_[A-Za-z0-9_-]+/,
  /Authorization:\s*Bearer/i,
  /api[_-]?key\s*[:=]\s*[^\s,&}]+/i,
  /access[_-]?token\s*[:=]\s*[^\s,&}]+/i,
  /raw\s+provider\s+response/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
];

test('sample bundles provide provenance-labeled manifest, JSONL, combined Markdown, and per-video files', async () => {
  const entries = await readdir(SAMPLE_ROOT, { withFileTypes: true });
  const bundles = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(new Set(bundles), EXPECTED_BUNDLES);

  for (const bundle of bundles) {
    const bundleDir = path.join(SAMPLE_ROOT, bundle);
    const manifest = JSON.parse(await readFile(path.join(bundleDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.schema_version, '1.1');
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.sample_source_type, 'synthetic_owned_demo');
    assert.match(manifest.generated_with, new RegExp(`@youtubebrief/cli@${escapeRegExp(PACKAGE_VERSION)}`));
    assert.match(manifest.created_at, /^2026-07-02T13:05:00\.000Z$/);
    assert.equal(manifest.not_a_live_customer_record, true);
    assert.equal(manifest.items.length, manifest.total);
    assert.equal(manifest.outputs.combined_markdown, 'combined.md');
    assert.equal(manifest.outputs.jsonl, 'videos.jsonl');
    assert.equal(manifest.billed_successes, 0);

    const combined = await readFile(path.join(bundleDir, 'combined.md'), 'utf8');
    assert.match(combined, /not a live customer record/i);
    assert.match(combined, new RegExp(escapeRegExp(manifest.use_case), 'i'));

    const jsonlLines = (await readFile(path.join(bundleDir, 'videos.jsonl'), 'utf8')).trim().split(/\n/);
    assert.equal(jsonlLines.length, manifest.items.length);
    for (const line of jsonlLines) {
      const row = JSON.parse(line);
      assert.equal(row.sample_source_type, 'synthetic_owned_demo');
      assert.equal(row.not_a_live_customer_record, true);
      assert.equal(row.created_at, manifest.created_at);
      assert.ok(row.markdown_path.startsWith('videos/'));
      assert.ok(row.json_path.startsWith('videos/'));
    }

    for (const item of manifest.items) {
      assert.equal(item.status, 'succeeded');
      assert.equal(item.billed, false);
      assert.equal(item.sample_source_type, 'synthetic_owned_demo');
      assert.equal(item.generated_with, manifest.generated_with);
      assert.equal(item.not_a_live_customer_record, true);
      assert.ok(item.markdown_path.startsWith('videos/'));
      assert.ok(item.json_path.startsWith('videos/'));
      assert.equal(path.normalize(item.markdown_path).startsWith('..'), false);
      assert.equal(path.normalize(item.json_path).startsWith('..'), false);

      const markdown = await readFile(path.join(bundleDir, item.markdown_path), 'utf8');
      const structured = JSON.parse(await readFile(path.join(bundleDir, item.json_path), 'utf8'));
      assert.match(markdown, /Sample provenance:/);
      assert.equal(structured.sample_source_type, 'synthetic_owned_demo');
      assert.equal(structured.generated_with, manifest.generated_with);
      assert.equal(structured.created_at, manifest.created_at);
      assert.equal(structured.not_a_live_customer_record, true);
      assert.equal(structured.videoId, item.normalized_video_id);
      assert.equal(structured.sourceUrl, item.normalized_url);
    }
  }
});

test('sample bundles contain no secrets, private customer labels, or provider-internal payload markers', async () => {
  const files = await listFiles(SAMPLE_ROOT);
  assert.ok(files.length > 15, 'expected sample bundle files');
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    const text = await readFile(file, 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      assert.doesNotMatch(text, pattern, `${rel} must not contain ${pattern}`);
    }
    assert.doesNotMatch(text, /customer[_ -]?record\s*[:=]\s*true/i, `${rel} must not claim customer-record provenance`);
    assert.doesNotMatch(text, /raw[_ -]?provider[_ -]?(?:secret|payload|trace)/i, `${rel} must not include provider internals`);
  }
});

async function listFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...await listFiles(full));
    else out.push(full);
  }
  return out;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
