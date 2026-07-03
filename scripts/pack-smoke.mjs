#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_BINS = ['yb', 'youtubebrief', 'youtubebrief-mcp'];
const FORBIDDEN_PACKED_PREFIXES = ['test/', 'benchmark/'];
const EXPECTED_SAMPLE_BUNDLE_FILES = [
  'examples/sample-bundles/README.md',
  'examples/sample-bundles/mcp-agent-workflow/manifest.json',
  'examples/sample-bundles/mcp-agent-workflow/combined.md',
  'examples/sample-bundles/rag-jsonl-pipeline/manifest.json',
  'examples/sample-bundles/rag-jsonl-pipeline/videos.jsonl',
  'examples/sample-bundles/rag-jsonl-pipeline/combined.md',
  'examples/sample-bundles/devrel-research/manifest.json',
  'examples/sample-bundles/devrel-research/combined.md',
];

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), 'yb-pack-smoke-'));
  try {
    const packDir = path.join(workDir, 'pack');
    const installDir = path.join(workDir, 'install');
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });
    const pack = await run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
    const [packed] = JSON.parse(pack.stdout);
    if (!packed?.filename) throw new Error(`npm pack did not return a tarball: ${pack.stdout}`);
    const tarball = path.join(packDir, packed.filename);
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    if (packageJson.name !== '@youtubebrief/cli') throw new Error(`Unexpected package name: ${packageJson.name}`);
    for (const name of EXPECTED_BINS) {
      if (!packageJson.bin?.[name]) throw new Error(`Missing package bin: ${name}`);
    }
    const packedPaths = new Set((packed.files || []).map((file) => file.path));
    for (const expectedPath of [
      'bin/yb.js',
      'bin/youtubebrief.js',
      'bin/youtubebrief-mcp.js',
      'src/cli.mjs',
      'src/mcp/server.mjs',
      'examples/claude-code-mcp.json',
      'examples/codex-config.toml',
      'examples/sample-bundles/mcp-agent-workflow/manifest.json',
      'examples/sample-bundles/mcp-agent-workflow/combined.md',
      'examples/sample-bundles/rag-jsonl-pipeline/videos.jsonl',
      'examples/sample-bundles/devrel-research/manifest.json',
      'README.md',
      'llms.txt',
      'SECURITY.md',
      'LICENSE',
      ...EXPECTED_SAMPLE_BUNDLE_FILES,
    ]) {
      if (!packedPaths.has(expectedPath)) throw new Error(`Packed tarball missing ${expectedPath}`);
    }
    for (const packedPath of packedPaths) {
      if (FORBIDDEN_PACKED_PREFIXES.some((prefix) => packedPath.startsWith(prefix))) {
        throw new Error(`Packed tarball unexpectedly includes ${packedPath}`);
      }
    }

    await run('npm', ['init', '-y'], { cwd: installDir });
    await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: installDir });
    await assertBin(installDir, 'yb', ['--help'], /Youtubebrief CLI/);
    await assertBin(installDir, 'yb', ['config', '--help'], /yb config get/);
    await assertBin(installDir, 'youtubebrief', ['--version'], /^0\.1\.0\b/);
    await assertMcpBin(installDir);

    const report = {
      ok: true,
      package: packageJson.name,
      version: packageJson.version,
      tarball: packed.filename,
      bins: EXPECTED_BINS,
      packed_files: packed.files.length,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function assertBin(installDir, binName, args, pattern) {
  const binPath = path.join(installDir, 'node_modules', '.bin', binName);
  const result = await run(binPath, args, { cwd: installDir });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!pattern.test(output)) throw new Error(`${binName} ${args.join(' ')} output did not match ${pattern}: ${output}`);
}

async function assertMcpBin(installDir) {
  const binPath = path.join(installDir, 'node_modules', '.bin', 'youtubebrief-mcp');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '0.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = await run(binPath, [], { cwd: installDir, input });
  const lines = result.stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  const toolList = lines.find((message) => message.id === 2);
  const names = toolList?.result?.tools?.map((tool) => tool.name) || [];
  for (const expected of ['check_credits', 'estimate_brief_cost', 'brief_youtube_video', 'batch_brief_youtube_videos', 'read_batch_manifest', 'read_brief_output']) {
    if (!names.includes(expected)) throw new Error(`MCP packed bin missing tool ${expected}`);
  }
  if (result.stderr.trim()) throw new Error(`MCP packed bin wrote unexpected stderr: ${result.stderr}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} ${args.join(' ')} failed: ${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
