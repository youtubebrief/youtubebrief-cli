#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp/tools.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_TOOLS = MCP_TOOL_DEFINITIONS.map((tool) => tool.name);

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), 'yb-global-install-smoke-'));
  try {
    const packDir = path.join(workDir, 'pack');
    const prefixDir = path.join(workDir, 'prefix');
    await mkdir(packDir, { recursive: true });
    await mkdir(prefixDir, { recursive: true });

    const pack = await run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT });
    const [packed] = JSON.parse(pack.stdout);
    if (packed?.name !== '@youtubebrief/cli') throw new Error(`unexpected package name ${packed?.name}`);
    if (!/^0\.1\.0-beta\.\d+$/.test(packed?.version || '')) throw new Error(`unexpected package version ${packed?.version}`);
    const tarball = path.join(packDir, packed.filename);

    await run('npm', ['install', '-g', '--prefix', prefixDir, '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: workDir });

    await assertBin(prefixDir, 'yb', ['--help'], /Youtubebrief CLI/);
    await assertBin(prefixDir, 'youtubebrief', ['--version'], /^0\.1\.0-beta\.\d+\b/);
    await assertMcp(prefixDir);

    process.stdout.write(JSON.stringify({
      ok: true,
      package: packed.name,
      version: packed.version,
      tarball: packed.filename,
      prefix_bin: path.join(prefixDir, 'bin'),
      bins: ['yb', 'youtubebrief', 'youtubebrief-mcp'],
      mcp_tools: EXPECTED_TOOLS,
    }, null, 2) + '\n');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function assertBin(prefixDir, name, args, pattern) {
  const bin = path.join(prefixDir, 'bin', name);
  const result = await run(bin, args, { cwd: prefixDir });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!pattern.test(output)) throw new Error(`${name} ${args.join(' ')} did not match ${pattern}: ${output}`);
}

async function assertMcp(prefixDir) {
  const bin = path.join(prefixDir, 'bin', 'youtubebrief-mcp');
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'global-install-smoke', version: '0.0.0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const result = await run(bin, [], { cwd: prefixDir, input });
  const lines = result.stdout.trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
  const toolList = lines.find((message) => message.id === 2);
  const names = toolList?.result?.tools?.map((tool) => tool.name) || [];
  for (const expected of EXPECTED_TOOLS) {
    if (!names.includes(expected)) throw new Error(`MCP packed bin missing tool ${expected}`);
  }
  if (result.stderr.trim()) throw new Error(`MCP packed bin wrote unexpected stderr: ${result.stderr}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, npm_config_update_notifier: 'false', ...(options.env || {}) },
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
