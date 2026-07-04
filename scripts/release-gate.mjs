#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_NAME = '@youtubebrief/cli';
const EXPECTED_BINS = {
  yb: 'bin/yb.js',
  youtubebrief: 'bin/youtubebrief.js',
  'youtubebrief-mcp': 'bin/youtubebrief-mcp.js',
};
const EXPECTED_FILES = ['bin', 'src', 'scripts', 'examples', 'docs', 'README.md', 'llms.txt', 'SECURITY.md', 'LICENSE'];
const FORBIDDEN_FILES = ['.', '..', '.env', '.omx', 'benchmark', 'coverage', 'dist', 'frontend-design-repos', 'node_modules', 'test'];
const SECRET_PATTERNS = [
  /cfk_[A-Za-z0-9]+/,
  /yb_live_[A-Za-z0-9]+/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
];
const BROKEN_NPX_MCP_PATTERNS = [
  /npx\s+-y\s+@youtubebrief\/cli(?:@beta)?\s+mcp/,
  /args\s*=\s*\[\"-y\",\s*\"@youtubebrief\/cli@beta\",\s*\"mcp\"\]/,
  /\[\s*['\"]-y['\"],\s*['\"]@youtubebrief\/cli@beta['\"],\s*['\"]mcp['\"]\s*\]/,
];
const REQUIRED_NPX_MCP_BY_CHANNEL = {
  beta: 'npx -y --package @youtubebrief/cli@beta yb mcp',
  stable: 'npx -y --package @youtubebrief/cli yb mcp',
};

const PUBLIC_SCAN_DIRS = ['test', 'examples'];
const PUBLIC_SOURCE_SECRET_PATTERNS = [
  /cfk_[A-Za-z0-9]+/,
  /npm_[A-Za-z0-9]{20,}/,
  /yb_live_[A-Za-z0-9_-]+/,
  /sk_live_[A-Za-z0-9_-]+/,
  /169\.213\.3\.141/,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/i,
  /FAKE_YB_TEST_TOKEN_[A-Za-z0-9_-]+\s+stack\s+trace\s+Authorization:\s+Bearer/i,
];

function fail(message) {
  throw new Error(`release gate failed: ${message}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function resolveReleaseChannel(version) {
  if (/^0\.1\.0-beta\.\d+$/.test(version)) return 'beta';
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'stable';
  fail(`package.version must be either a 0.1.0 beta prerelease or stable semver, got ${version}`);
}

function expectedNpmTagForChannel(channel) {
  return channel === 'stable' ? 'latest' : 'beta';
}

function assertObjectIncludes(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) assertEqual(actual?.[key], value, `${label}.${key}`);
}

function assertNoSecret(label, text) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) fail(`${label} contains a forbidden secret-like pattern: ${pattern}`);
  }
}

async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walkFiles(full);
    } else if (/\.(?:js|mjs|json|jsonl|md|txt|toml|yml|yaml)$/.test(entry.name)) {
      yield full;
    }
  }
}

async function assertPublicSourcesAvoidScannerNoise() {
  for (const relativeDir of PUBLIC_SCAN_DIRS) {
    const dir = path.join(ROOT, relativeDir);
    for await (const filePath of walkFiles(dir)) {
      const text = await readFile(filePath, 'utf8');
      for (const pattern of PUBLIC_SOURCE_SECRET_PATTERNS) {
        if (pattern.test(text)) {
          fail(`${path.relative(ROOT, filePath)} contains public scanner-noise pattern ${pattern}`);
        }
      }
    }
  }
}

async function main() {
  const packagePath = path.join(ROOT, 'package.json');
  const readmePath = path.join(ROOT, 'README.md');
  const llmsPath = path.join(ROOT, 'llms.txt');
  const securityPath = path.join(ROOT, 'SECURITY.md');
  const linkCheckPath = path.join(ROOT, '.github', 'workflows', 'link-check.yml');
  const [packageText, readme, llms, security, linkCheck] = await Promise.all([
    readFile(packagePath, 'utf8'),
    readFile(readmePath, 'utf8'),
    readFile(llmsPath, 'utf8'),
    readFile(securityPath, 'utf8'),
    readFile(linkCheckPath, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);

  assertEqual(packageJson.name, EXPECTED_NAME, 'package.name');
  const releaseChannel = resolveReleaseChannel(packageJson.version);
  const expectedNpmTag = expectedNpmTagForChannel(releaseChannel);
  if (packageJson.private === true) fail('package.private must not be true for public beta publish');
  assertObjectIncludes(packageJson.bin, EXPECTED_BINS, 'package.bin');
  assertEqual(packageJson.publishConfig?.access, 'public', 'publishConfig.access');
  assertEqual(packageJson.publishConfig?.tag, expectedNpmTag, 'publishConfig.tag');
  assertEqual(packageJson.publishConfig?.provenance, true, 'publishConfig.provenance');
  const repoUrl = String(packageJson.repository?.url || '');
  if (!repoUrl.includes('github.com/youtubebrief/youtubebrief-cli')) {
    fail('repository.url must point at the public Youtubebrief CLI repository for npm users');
  }
  if ('directory' in (packageJson.repository || {})) {
    fail('repository.directory must be omitted in the standalone public CLI package metadata');
  }

  for (const entry of EXPECTED_FILES) {
    if (!packageJson.files?.includes(entry)) fail(`package.files is missing ${entry}`);
  }
  for (const entry of packageJson.files || []) {
    if (FORBIDDEN_FILES.includes(entry) || FORBIDDEN_FILES.some((prefix) => entry.startsWith(`${prefix}/`))) {
      fail(`package.files contains forbidden entry ${entry}`);
    }
  }

  assertEqual(packageJson.scripts?.prepublishOnly, 'npm run verify && npm run release:gate && npm run smoke:pack', 'scripts.prepublishOnly');
  assertEqual(packageJson.scripts?.['release:gate'], 'node scripts/release-gate.mjs', 'scripts.release:gate');
  assertEqual(packageJson.scripts?.['pack:dry-run'], 'npm pack --dry-run --json', 'scripts.pack:dry-run');
  assertEqual(packageJson.scripts?.['smoke:global-install'], 'node scripts/global-install-smoke.mjs', 'scripts.smoke:global-install');
  assertEqual(packageJson.scripts?.['smoke:production-safe'], 'node scripts/production-safe-smoke.mjs', 'scripts.smoke:production-safe');
  if (String(packageJson.scripts?.prepublishOnly).includes('publish')) fail('prepublishOnly must not call npm publish');

  for (const [label, text] of [['package.json', packageText], ['README.md', readme], ['llms.txt', llms], ['SECURITY.md', security]]) {
    assertNoSecret(label, text);
  }
  await assertPublicSourcesAvoidScannerNoise();
  if (!security.includes(packageJson.version)) fail('SECURITY.md must mention the source package version');
  if (!linkCheck.includes('curl -fsSL -o /dev/null')) fail('link-check workflow must use GET checks for sample JSON links');
  if (/curl\s+-fsSI/.test(linkCheck)) fail('link-check workflow must not use HEAD-only checks for sample JSON links');
  if (releaseChannel === 'beta') {
    if (!readme.includes('@youtubebrief/cli@beta')) fail('README must document beta-tag install commands');
    if (!llms.includes('@youtubebrief/cli@beta')) fail('llms.txt must document beta-tag install commands');
  } else {
    if (!/npm install -g @youtubebrief\/cli(?!@)/.test(readme)) fail('README must document stable install commands without @beta');
    if (!/npm install -g @youtubebrief\/cli(?!@)/.test(llms)) fail('llms.txt must document stable install commands without @beta');
  }
  const requiredNpxMcp = REQUIRED_NPX_MCP_BY_CHANNEL[releaseChannel];
  for (const [label, text] of [['README.md', readme], ['llms.txt', llms]]) {
    if (!text.includes(requiredNpxMcp)) {
      fail(`${label} must document the explicit --package npx MCP command: ${requiredNpxMcp}`);
    }
    for (const pattern of BROKEN_NPX_MCP_PATTERNS) {
      if (pattern.test(text)) fail(`${label} documents a broken multi-bin npx MCP command: ${pattern}`);
    }
    if (!/registry verification|npm view @youtubebrief\/cli@beta version/i.test(text)) {
      fail(`${label} must keep registry verification guidance for release/marketing checks`);
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, package: packageJson.name, version: packageJson.version, tag: packageJson.publishConfig.tag, channel: releaseChannel }, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
