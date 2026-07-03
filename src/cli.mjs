import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.mjs';
import { YoutubebriefClient } from './api.mjs';
import { exportBatchBundle, getBatchExitCode, MANIFEST_JSON_SCHEMA, readBatchInputFile, runBatch, splitInputLines, summarizeBatchManifest } from './batch.mjs';
import { DEFAULT_BASE_URL, normalizeBaseUrl, readStoredConfig, removeStoredConfig, resolveConfig, validateBaseUrl, writeStoredConfig } from './config.mjs';
import { runDoctor } from './doctor.mjs';
import { CliError } from './errors.mjs';
import { runMcpServer } from './mcp/server.mjs';
import { formatPayload, writeOutput } from './output.mjs';
import { buildBatchTelemetryProperties, sendTelemetryEvent, sendTelemetryEvents, telemetryAuthState } from './telemetry.mjs';

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stdin = io.stdin || process.stdin;
  const interactive = io.interactive ?? Boolean(stdin.isTTY && stdout.isTTY);
  const questioner = io.questioner;
  const browserOpener = io.browserOpener;
  const parsed = parseArgs(argv);

  if (parsed.command === 'interactive') return interactiveHome(parsed, { stdin, stdout, interactive, questioner, browserOpener });
  if (parsed.command === 'help') {
    stdout.write(helpText(parsed.topic));
    return;
  }
  if (parsed.command === 'version') {
    stdout.write(`${await readVersion()}\n`);
    return;
  }
  if (parsed.command === 'login') return login(parsed, { stdin, stdout, interactive, questioner, browserOpener });
  if (parsed.command === 'signup') return signup(parsed, { stdout });
  if (parsed.command === 'buy') return buy(parsed, { stdout, interactive, browserOpener });
  if (parsed.command === 'logout') return logout({ stdout });
  if (parsed.command === 'whoami') return whoami(parsed, { stdout });
  if (parsed.command === 'credits') return credits(parsed, { stdout });
  if (parsed.command === 'doctor') return doctor(parsed, { stdout });
  if (parsed.command === 'config') return configCommand(parsed, { stdin, stdout });
  if (parsed.command === 'mcp') return runMcpServer({ stdin, stdout });
  if (parsed.command === 'batch') return batch(parsed, { stdin, stdout });
  if (parsed.command === 'export') return exportBundle(parsed, { stdout });
  if (parsed.command === 'schema') return schema(parsed, { stdout });
  if (parsed.command === 'brief') return brief(parsed, { stdout });
  throw new CliError(`Unknown command: ${parsed.command}`);
}

async function login(options, { stdin, stdout, interactive = false, questioner, browserOpener }) {
  if (!options.apiKey && !options.tokenStdin && interactive) {
    return interactiveLogin(options, { stdin, stdout, questioner, browserOpener });
  }
  let apiKey = options.apiKey;
  if (options.tokenStdin) {
    apiKey = (await readStdin(stdin)).trim();
  }
  if (!apiKey) {
    throw new CliError('Missing API key. Run `yb login` in a terminal, or set YB_API_KEY/YOUTUBEBRIEF_API_KEY.');
  }
  const existing = await readStoredConfig();
  const baseUrl = resolveAuthCommandBaseUrl(options, existing);
  await writeStoredConfig({ ...existing, apiKey, baseUrl });
  stdout.write(`Logged in to ${baseUrl}.\n`);
}

async function signup(options, { stdout }) {
  const existing = await readStoredConfig();
  const baseUrl = resolveAuthCommandBaseUrl(options, existing);
  const client = new YoutubebriefClient({ baseUrl });
  const payload = await client.signup({ email: options.email });
  if (!payload.apiKey) throw new CliError('Youtubebrief did not return an API key for the new account.');
  await writeStoredConfig({ ...existing, apiKey: payload.apiKey, baseUrl });
  stdout.write(`Created account ${payload.account?.email || options.email} and logged in to ${baseUrl}.\n`);
  stdout.write('Your API key was stored locally. Run `yb credits` or `yb buy 10` next.\n');
}

function resolveAuthBaseUrl(options, existing = {}, env = process.env) {
  return normalizeBaseUrl(options.baseUrl || env.YB_BASE_URL || env.YOUTUBEBRIEF_BASE_URL || existing.baseUrl || DEFAULT_BASE_URL);
}

async function buy(options, { stdout, interactive = false, browserOpener }) {
  const config = await resolveConfig(options);
  if (!config.apiKey) throw new CliError('Missing API key. Run `yb login` in a terminal, or `yb signup --email you@example.com`.');
  const client = new YoutubebriefClient(config);
  const payload = await client.createCheckout({ minutes: options.minutes });
  if (payload.checkoutUrl) {
    if (!interactive) {
      stdout.write(`${payload.checkoutUrl}\n`);
      return;
    }
    await presentBrowserUrl(payload.checkoutUrl, {
      stdout,
      interactive,
      browserOpener,
      noBrowser: options.noBrowser,
      label: 'checkout'
    });
    return;
  }
  stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function logout({ stdout }) {
  await removeStoredConfig();
  stdout.write('Logged out.\n');
}

async function whoami(options, { stdout }) {
  const config = await resolveConfig(options);
  if (!config.apiKey) {
    stdout.write(`Not logged in. Config: ${config.configPath}\n`);
    return;
  }
  const client = new YoutubebriefClient(config);
  try {
    const payload = await client.whoami();
    stdout.write(formatAccount(payload));
  } catch (error) {
    if (String(error.message).includes('HTTP 404')) {
      stdout.write(`Logged in locally for ${config.baseUrl}. Account endpoint is not available yet.\n`);
      return;
    }
    throw error;
  }
}

async function credits(options, { stdout }) {
  const config = await resolveConfig(options);
  if (!config.apiKey) throw new CliError('Missing API key. Run `yb login` in a terminal, or set YOUTUBEBRIEF_API_KEY.');
  const client = new YoutubebriefClient(config);
  try {
    const payload = await client.credits();
    stdout.write(formatCredits(payload));
  } catch (error) {
    if (String(error.message).includes('HTTP 404')) {
      stdout.write('Credits endpoint is not available yet on this Youtubebrief server.\n');
      return;
    }
    throw error;
  }
}

async function interactiveHome(options, { stdin, stdout, interactive, questioner, browserOpener }) {
  if (!interactive) {
    stdout.write(helpText());
    return;
  }
  const rl = questioner || createPromptInterface({ stdin, stdout });
  try {
    stdout.write('Youtubebrief CLI\n\n');
    const setupUrl = buildSiteUrl(options, '/cli', {
      utm_source: 'cli',
      utm_medium: 'terminal',
      utm_campaign: 'onboarding'
    });
    await presentBrowserUrl(setupUrl, {
      stdout,
      interactive,
      browserOpener,
      noBrowser: options.noBrowser,
      label: 'CLI setup'
    });
    while (true) {
      const config = await resolveConfig(options);
      if (!config.apiKey) {
        stdout.write('\nYou are not logged in.\n');
        stdout.write('  1. Create account / sign in with email\n');
        stdout.write('  2. Use an existing API key\n');
        stdout.write('  3. Try a no-spend dry run\n');
        stdout.write('  4. Show help\n');
        stdout.write('  5. Quit\n');
        const choice = await askChoice(rl, 'Choose an option: ', ['1', '2', '3', '4', '5']);
        if (choice === '1') await interactiveSignup(options, { rl, stdout, browserOpener });
        else if (choice === '2') await interactiveExistingKeyHelp({ stdout });
        else if (choice === '3') await interactiveDryRun(options, { rl, stdout });
        else if (choice === '4') stdout.write(`\n${helpText()}`);
        else return;
      } else {
        stdout.write(`\nLogged in to ${config.baseUrl} (${config.hasEnvApiKey ? 'environment API key' : 'stored API key'}).\n`);
        stdout.write('  1. Check credits\n');
        stdout.write('  2. Buy credits\n');
        stdout.write('  3. Run a brief\n');
        stdout.write('  4. Configure Codex MCP\n');
        stdout.write('  5. Show help\n');
        stdout.write('  6. Quit\n');
        const choice = await askChoice(rl, 'Choose an option: ', ['1', '2', '3', '4', '5', '6']);
        if (choice === '1') await interactiveCredits(options, { stdout });
        else if (choice === '2') await interactiveBuy(options, { rl, stdout, browserOpener });
        else if (choice === '3') await interactiveBrief(options, { rl, stdout });
        else if (choice === '4') await interactiveCodexMcp({ stdout });
        else if (choice === '5') stdout.write(`\n${helpText()}`);
        else return;
      }
    }
  } finally {
    if (!questioner) rl.close();
  }
}

async function interactiveLogin(options, { stdin, stdout, questioner, browserOpener }) {
  const rl = questioner || createPromptInterface({ stdin, stdout });
  try {
    stdout.write('Youtubebrief login\n\n');
    const accountUrl = buildSiteUrl(options, '/account', {
      utm_source: 'cli',
      utm_medium: 'terminal',
      utm_campaign: 'login'
    });
    await presentBrowserUrl(accountUrl, {
      stdout,
      interactive: true,
      browserOpener,
      noBrowser: options.noBrowser,
      label: 'account + billing'
    });
    stdout.write('  1. I created/copied an API key in the browser\n');
    stdout.write('  2. Create account directly in terminal\n');
    stdout.write('  3. Cancel\n');
    const choice = await askChoice(rl, 'Choose an option: ', ['1', '2', '3']);
    if (choice === '1') return interactiveExistingKeyHelp({ stdout });
    if (choice === '2') return interactiveSignup(options, { rl, stdout, browserOpener });
  } finally {
    if (!questioner) rl.close();
  }
}

async function interactiveSignup(options, { rl, stdout, browserOpener }) {
  const email = await askNonEmpty(rl, 'Email: ');
  await signup({ ...options, email }, { stdout });
  if (await askYesNo(rl, 'Buy credits now? [Y/n] ', true)) {
    await interactiveBuy(options, { rl, stdout, browserOpener });
  }
}

async function interactiveExistingKeyHelp({ stdout }) {
  stdout.write('\nAfter copying your API key from the browser, store it locally with the non-echoing stdin flow:\n\n');
  stdout.write('  printf "%s\\n" "$YB_API_KEY" | yb login --token-stdin\n\n');
  stdout.write('Or set YB_API_KEY for a single shell/session.\n');
}

async function interactiveCredits(options, { stdout }) {
  try {
    await credits(options, { stdout });
  } catch (error) {
    stdout.write(`${error.message}\n`);
  }
}

async function interactiveBuy(options, { rl, stdout, browserOpener }) {
  const packages = await loadCreditPackages(options, { stdout });
  stdout.write('\nBuy credits:\n');
  for (const [index, pack] of packages.entries()) {
    stdout.write(`  ${index + 1}. ${formatPackageChoice(pack)}\n`);
  }
  stdout.write(`  ${packages.length + 1}. Cancel\n`);
  const allowed = [...packages.map((_, index) => String(index + 1)), String(packages.length + 1)];
  const choice = await askChoice(rl, 'Choose a package: ', allowed);
  if (choice === String(packages.length + 1)) return;
  const pack = packages[Number(choice) - 1];
  try {
    const config = await resolveConfig(options);
    if (!config.apiKey) {
      stdout.write('Missing API key. Create an account first or run `yb login`.\n');
      return;
    }
    const payload = await new YoutubebriefClient(config).createCheckout({ minutes: pack.minutes });
    if (payload.checkoutUrl) {
      await presentBrowserUrl(payload.checkoutUrl, {
        stdout,
        interactive: true,
        browserOpener,
        label: 'checkout'
      });
    } else {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    }
  } catch (error) {
    stdout.write(`${error.message}\n`);
  }
}

async function interactiveBrief(options, { rl, stdout }) {
  const youtubeUrl = await askNonEmpty(rl, 'YouTube URL: ');
  const minutesInput = (await rl.question('Billing block minutes [10; choose 5 if you bought a 5-minute pack]: ')).trim();
  const billingBlockMinutes = minutesInput ? Number(minutesInput) : 10;
  if (![5, 10, 30, 60].includes(billingBlockMinutes)) {
    stdout.write('Billing block minutes must be one of 5, 10, 30, or 60.\n');
    return;
  }
  const output = (await rl.question('Output file (blank for stdout): ')).trim();
  try {
    await brief({ ...options, youtubeUrl, billingBlockMinutes, format: 'markdown', wait: true, output: output || undefined }, { stdout });
  } catch (error) {
    stdout.write(`${error.message}\n`);
    if (/credits|billing/i.test(String(error.message))) {
      stdout.write('Tip: run `yb credits`, `yb buy 5`, or retry with `--minutes 5` if your balance is under 10 minutes.\n');
    }
  }
}

async function interactiveDryRun(options, { rl, stdout }) {
  const youtubeUrl = await askNonEmpty(rl, 'YouTube URL for no-spend dry run: ');
  const outDirInput = (await rl.question('Output directory [./yb-out]: ')).trim();
  const outDir = outDirInput || './yb-out';
  try {
    const manifest = await runBatch({
      inputs: [youtubeUrl],
      outDir,
      billingBlockMinutes: 10,
      dryRun: true,
      secrets: [],
    });
    stdout.write(summarizeBatchManifest(manifest));
  } catch (error) {
    stdout.write(`${error.message}\n`);
  }
}

async function interactiveCodexMcp({ stdout }) {
  stdout.write('\nAdd Youtubebrief to Codex MCP:\n\n');
  stdout.write('  codex mcp add youtubebrief -- npx -y --package @youtubebrief/cli@beta yb mcp\n\n');
  stdout.write('For paid MCP tools, run `yb login` first or forward YB_API_KEY in ~/.codex/config.toml.\n');
}

async function presentBrowserUrl(url, { stdout, interactive = false, browserOpener, noBrowser = false, label = 'page' } = {}) {
  if (shouldOpenBrowser({ interactive, noBrowser })) {
    try {
      await openBrowser(url, { browserOpener });
      stdout.write(`Opened ${label} in your browser.\n`);
      stdout.write(`If it did not open, visit:\n${url}\n\n`);
      return true;
    } catch (error) {
      stdout.write(`Could not open ${label} automatically. Visit:\n${url}\n`);
      stdout.write(`Reason: ${error.message}\n\n`);
      return false;
    }
  }
  stdout.write(`Open ${label}:\n${url}\n\n`);
  return false;
}

function shouldOpenBrowser({ interactive = false, noBrowser = false } = {}) {
  if (!interactive || noBrowser) return false;
  const noBrowserEnv = String(process.env.YB_NO_BROWSER || '').trim().toLowerCase();
  if (process.env.CI || noBrowserEnv === '1' || noBrowserEnv === 'true') return false;
  return true;
}

function openBrowser(url, { browserOpener } = {}) {
  if (browserOpener) return browserOpener(url);
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', url]
    : [url];
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 3000, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function buildSiteUrl(options = {}, pathname = '/', params = {}) {
  const baseUrl = resolveAuthBaseUrl(options);
  const url = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function loadCreditPackages(options, { stdout }) {
  const fallback = [
    { id: '5m', minutes: 5, currency: 'usd' },
    { id: '10m', minutes: 10, currency: 'usd' },
    { id: '30m', minutes: 30, currency: 'usd' },
    { id: '60m', minutes: 60, currency: 'usd' },
  ];
  try {
    const config = await resolveConfig(options);
    if (!config.apiKey) return fallback;
    const payload = await new YoutubebriefClient(config).credits();
    if (Array.isArray(payload.packages) && payload.packages.length) return normalizePackages(payload.packages);
  } catch (error) {
    stdout.write(`Could not load live package list; using defaults. (${error.message})\n`);
  }
  return fallback;
}

function normalizePackages(packages) {
  return packages
    .map((pack) => ({
      id: pack.id,
      minutes: Number(pack.minutes),
      currency: pack.currency || 'usd',
      unitAmountCents: Number.isFinite(pack.unitAmountCents) ? pack.unitAmountCents : undefined,
      unitAmountUsd: Number.isFinite(pack.unitAmountUsd) ? pack.unitAmountUsd : undefined,
    }))
    .filter((pack) => [5, 10, 30, 60].includes(pack.minutes));
}

function createPromptInterface({ stdin, stdout }) {
  return createInterface({ input: stdin, output: stdout, terminal: Boolean(stdout.isTTY) });
}

async function askChoice(rl, prompt, allowed) {
  while (true) {
    const value = (await rl.question(prompt)).trim();
    if (allowed.includes(value)) return value;
    rl.write(`Choose one of: ${allowed.join(', ')}\n`);
  }
}

async function askNonEmpty(rl, prompt) {
  while (true) {
    const value = (await rl.question(prompt)).trim();
    if (value) return value;
    rl.write('Please enter a value.\n');
  }
}

async function askYesNo(rl, prompt, defaultYes = true) {
  const value = (await rl.question(prompt)).trim().toLowerCase();
  if (!value) return defaultYes;
  return ['y', 'yes'].includes(value);
}

async function doctor(options, { stdout }) {
  const report = await runDoctor(options, { stdout });
  const config = await resolveConfig(options);
  await sendTelemetryEvent('cli_doctor', {
    surface: 'cli',
    command: 'doctor',
    status: report.ok ? 'ok' : 'fail',
    result: report.ok ? 'success' : 'failed',
    authState: telemetryAuthState(config),
    hasOutDir: Boolean(options.outDir),
  }, { config });
  if (!report.ok) process.exitCode = 1;
}


async function configCommand(options, { stdin, stdout }) {
  if (options.action === 'get') return configGet(options, { stdout });
  if (options.action === 'set') return configSet(options, { stdin, stdout });
  throw new CliError('Usage: yb config get [base-url|api-key|config-path|telemetry] | yb config set base-url <url> | yb config set api-key --token-stdin | yb config set telemetry on|off');
}

async function configGet(options, { stdout }) {
  const stored = await readStoredConfig();
  const config = await resolveConfig();
  const rows = {
    'config-path': config.configPath,
    'base-url': config.baseUrl,
    'api-key': config.apiKey ? 'set' : 'not set',
    telemetry: config.telemetry === false ? 'off' : 'on',
  };
  if (options.key) {
    stdout.write(`${rows[options.key]}\n`);
    return;
  }
  stdout.write(`config_path: ${rows['config-path']}\n`);
  stdout.write(`base_url: ${rows['base-url']}\n`);
  stdout.write(`api_key: ${rows['api-key']}\n`);
  stdout.write(`telemetry: ${rows.telemetry}\n`);
  stdout.write(`stored_base_url: ${stored.baseUrl ? 'set' : 'not set'}\n`);
  stdout.write(`stored_api_key: ${stored.apiKey ? 'set' : 'not set'}\n`);
  stdout.write(`env_api_key: ${config.hasEnvApiKey ? 'set' : 'not set'}\n`);
}

async function configSet(options, { stdin, stdout }) {
  const existing = await readStoredConfig();
  if (options.key === 'base-url') {
    const baseUrl = validateBaseUrl(options.value);
    await writeStoredConfig({ ...existing, baseUrl });
    stdout.write(`Set base URL to ${baseUrl}.\n`);
    return;
  }
  if (options.key === 'api-key') {
    const apiKey = (await readStdin(stdin)).trim();
    if (!apiKey) throw new CliError('Missing API key. Use --token-stdin.');
    await writeStoredConfig({ ...existing, apiKey, baseUrl: existing.baseUrl || DEFAULT_BASE_URL });
    stdout.write('Stored API key.\n');
    return;
  }
  if (options.key === 'telemetry') {
    const telemetry = parseTelemetryConfigValue(options.value);
    await writeStoredConfig({ ...existing, telemetry, baseUrl: existing.baseUrl || DEFAULT_BASE_URL });
    stdout.write(`Set telemetry to ${telemetry ? 'on' : 'off'}.\n`);
    return;
  }
  throw new CliError('Usage: yb config set base-url <url> | yb config set api-key --token-stdin | yb config set telemetry on|off');
}

async function brief(options, { stdout }) {
  const config = await resolveConfig(options);
  const client = new YoutubebriefClient(config);
  const payload = await client.createBrief(options.youtubeUrl, {
    wait: options.wait,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    billingBlockMinutes: options.billingBlockMinutes,
  });
  const content = formatPayload(payload, options.format);
  await writeOutput(content, options.output, { stdout, format: options.format });
  await sendTelemetryEvent('cli_brief', {
    surface: 'cli',
    command: 'brief',
    status: 'succeeded',
    result: 'success',
    authState: telemetryAuthState(config),
    billingBlockMinutes: Number(options.billingBlockMinutes || 0),
    hasOutDir: Boolean(options.output && options.output !== '-'),
  }, { config });
}


async function batch(options, { stdin, stdout }) {
  const config = await resolveConfig(options);
  const nonSpendMode = options.dryRun || options.estimateCredits;
  if (!config.apiKey && !nonSpendMode) throw new CliError('Missing API key. Run `yb login` in a terminal, or set YOUTUBEBRIEF_API_KEY.');
  const inputs = [...options.urls];
  for (const inputFile of options.inputFiles || []) {
    inputs.push(...await readBatchInputFile(inputFile));
  }
  if (options.useStdin) {
    inputs.push(...splitInputLines(await readStdin(stdin)));
  }
  const client = nonSpendMode ? undefined : new YoutubebriefClient(config);
  const manifest = await runBatch({
    inputs,
    client,
    outDir: options.outDir,
    concurrency: options.concurrency,
    billingBlockMinutes: options.billingBlockMinutes,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    dryRun: options.dryRun,
    estimateCredits: options.estimateCredits,
    resume: options.resume,
    failedOnly: options.failedOnly,
    retryProviderErrors: options.retryProviderErrors,
    combinedMd: options.combinedMd,
    jsonl: options.jsonl,
    secrets: [config.apiKey],
  });
  stdout.write(summarizeBatchManifest(manifest));
  await sendBatchTelemetry({ manifest, options, config });
  process.exitCode = getBatchExitCode(manifest, { allowPartial: options.allowPartial });
}

async function exportBundle(options, { stdout }) {
  const result = await exportBatchBundle({ outDir: options.from, format: options.format, output: options.output });
  if (options.output === '-') {
    stdout.write(result.content);
    return;
  }
  stdout.write(`Wrote ${options.format} export to ${result.outputPath}\n`);
}

async function schema(options, { stdout }) {
  if (options.topic === 'manifest') {
    stdout.write(`${JSON.stringify(MANIFEST_JSON_SCHEMA, null, 2)}\n`);
    return;
  }
  throw new CliError('Usage: yb schema manifest');
}

async function sendBatchTelemetry({ manifest, options, config }) {
  const properties = buildBatchTelemetryProperties(manifest, options, config);
  const events = [{ eventName: 'cli_batch', properties }];
  if (properties.itemCount >= 5) events.push({ eventName: 'cli_batch_5plus', properties });
  if (properties.combinedMd) events.push({ eventName: 'cli_batch_combined_md', properties });
  if (properties.jsonl) events.push({ eventName: 'cli_batch_jsonl', properties });
  await sendTelemetryEvents(events, { config });
}

function parseTelemetryConfigValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  throw new CliError('Usage: yb config set telemetry on|off');
}

function resolveAuthCommandBaseUrl(options = {}, existing = {}, env = process.env) {
  return normalizeBaseUrl(options.baseUrl || env.YB_BASE_URL || env.YOUTUBEBRIEF_BASE_URL || existing.baseUrl || DEFAULT_BASE_URL);
}

function formatAccount(payload) {
  const id = payload.email || payload.username || payload.name || payload.id;
  return id ? `${id}\n` : `${JSON.stringify(payload, null, 2)}\n`;
}

function formatCredits(payload) {
  if (hasMinuteLedger(payload)) return formatMinuteLedger(payload);
  if (typeof payload.credits === 'number') return `${payload.credits} credits\n`;
  if (typeof payload.remaining === 'number') return `${payload.remaining} credits remaining\n`;
  if (typeof payload.balance === 'number') return `${payload.balance} credits\n`;
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function hasMinuteLedger(payload) {
  return payload && typeof payload === 'object' && (
    typeof payload.purchasedMinutes === 'number'
    || typeof payload.consumedMinutes === 'number'
    || typeof payload.remainingMinutes === 'number'
    || Array.isArray(payload.packages)
  );
}

function formatMinuteLedger(payload) {
  const lines = [];
  if (typeof payload.purchasedMinutes === 'number') lines.push(`Purchased: ${payload.purchasedMinutes} minutes`);
  if (typeof payload.consumedMinutes === 'number') lines.push(`Consumed: ${payload.consumedMinutes} minutes`);
  if (typeof payload.remainingMinutes === 'number') lines.push(`Remaining: ${payload.remainingMinutes} minutes`);
  const packages = Array.isArray(payload.packages) ? normalizePackages(payload.packages) : [];
  if (packages.length) {
    lines.push('', 'Buy credits:');
    for (const pack of packages) lines.push(`  yb buy ${pack.minutes}    ${formatPackagePrice(pack)}`);
    if (typeof payload.remainingMinutes === 'number' && payload.remainingMinutes < 10) {
      lines.push('', 'Tip: if you buy a 5-minute pack, run briefs with `--minutes 5`.');
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatPackageChoice(pack) {
  return `${pack.minutes} minutes - ${formatPackagePrice(pack)}`;
}

function formatPackagePrice(pack) {
  const currency = String(pack.currency || 'usd').toUpperCase();
  if (currency === 'USD') {
    if (Number.isFinite(pack.unitAmountUsd)) return `$${pack.unitAmountUsd.toFixed(2)}`;
    if (Number.isFinite(pack.unitAmountCents)) return `$${(pack.unitAmountCents / 100).toFixed(2)}`;
  }
  if (Number.isFinite(pack.unitAmountUsd)) return `${pack.unitAmountUsd.toFixed(2)} ${currency}`;
  if (Number.isFinite(pack.unitAmountCents)) return `${pack.unitAmountCents} ${currency} cents`;
  return 'price shown at checkout';
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('error', reject);
    stdin.on('end', () => resolve(data));
  });
}

async function readVersion() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packagePath = path.resolve(here, '..', 'package.json');
  try {
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
    return packageJson.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function helpText(topic) {
  if (topic === 'login') {
    return `Usage: yb login [--token-stdin] [--base-url <url>] [--no-browser]\n\nIn a terminal, opens youtubebrief.com account setup in your browser and guides API-key storage. For scripts, pass an API key with --token-stdin so it is not saved in shell history.\n`;
  }
  if (topic === 'signup') {
    return `Usage: yb signup --email <email> [--base-url <url>]\n\nCreates an account, stores the returned API key locally, and prepares CLI billing.\n`;
  }
  if (topic === 'buy') {
    return `Usage: yb buy <5|10|30|60> [--base-url <url>] [--no-browser]\n\nCreates a hosted checkout link for a prepaid minute pack. Interactive terminals open the link in a browser; scripts print the URL. Use YB_API_KEY or stored login for auth.\n`;
  }
  if (topic === 'doctor') {
    return `Usage: yb doctor [--base-url <url>] [--out-dir <dir>]\n\nChecks Node version, config path, base URL, auth state, privacy-safe telemetry preference, /healthz reachability, credits endpoint, and optional output-directory write access without printing secrets. Use YB_API_KEY or stored login for auth.\n`;
  }
  if (topic === 'config') {
    return `Usage: yb config get [base-url|api-key|config-path|telemetry]\n       yb config set base-url <url>\n       yb config set api-key --token-stdin\n       yb config set telemetry on|off\n\nReads or updates local CLI config without printing API key values. Privacy-safe activation telemetry is on by default and sends only command/tool counts/status, never URLs, content, tokens, or local paths. Environment variables still override stored config for a single invocation.\n`;
  }
  if (topic === 'brief') {
    return `Usage: yb brief <youtube-url> [--minutes 5|10|30|60] [--format markdown|json] [--output <path|->] [--base-url <url>]\n\nShortcut: yb <youtube-url>. Use YB_API_KEY or stored login for auth.\n`;
  }
  if (topic === 'batch') {
    return `Usage: yb batch --out-dir <dir> [--input <file>] [--stdin|-] [--concurrency <n>] [--allow-partial] [--dry-run] [--estimate-credits] [--resume|--failed-only|--retry-provider-errors] [--combined-md] [--jsonl] [--minutes 5|10|30|60] <youtube-url...>\n\nWrites manifest.json plus videos/*.md and videos/*.json. Optional combined.md and videos.jsonl exports are generated when requested. Non-spend modes make no paid API calls. This is a paid API command and is not exposed in the web UI.\n`;
  }
  if (topic === 'export') {
    return `Usage: yb export --from <out-dir> --format combined-md|jsonl [--output <path|->]\n\nRegenerates combined Markdown or JSONL from an existing yb batch bundle.\n`;
  }
  if (topic === 'schema') {
    return `Usage: yb schema manifest\n\nPrints the JSON Schema for yb batch manifest.json.\n`;
  }
  if (topic === 'mcp') {
    return `Usage: yb mcp\n\nStarts the local stdio Model Context Protocol server. Logs go to stderr; stdout is reserved for JSON-RPC MCP messages only. Prefer YB_API_KEY for MCP credentials.\n`;
  }
  return `Youtubebrief CLI\n\nIf no subcommand is specified, yb opens https://youtubebrief.com/cli in an interactive terminal and shows a browser-assisted setup flow. Non-TTY shells print this deterministic help and never open a browser.\n\nUsage: yb <youtube-url> [options]\n  yb [--no-browser]\n  yb brief <youtube-url> [--minutes 5|10|30|60] [--format markdown|json] [--output <path|->]\n  yb batch --out-dir <dir> [--input <file>] [--allow-partial] [--combined-md] [--jsonl] <youtube-url...>\n  yb export --from <out-dir> --format combined-md|jsonl [--output <path|->]\n  yb schema manifest\n  yb mcp\n  yb doctor [--out-dir <dir>]\n  yb login [--token-stdin] [--base-url <url>] [--no-browser]\n  yb signup --email <email>\n  yb buy <5|10|30|60> [--no-browser]\n  yb credits\n  yb config get [base-url|api-key|config-path|telemetry]\n  yb config set base-url <url>\n  yb config set telemetry on|off\n  yb logout\n  yb whoami\n  yb --help\n  yb --version\n\nOptions:\n  --api-key <token>       Supported for one-off local use, but prefer YB_API_KEY or --token-stdin to avoid shell history/process-argv exposure.\n  --base-url <url>       Override API base URL (default: ${DEFAULT_BASE_URL}).\n  --no-browser           Do not attempt to open browser pages from interactive setup/login/buy flows.\n  --format <type>        Output format: markdown or json.\n  --output <path|->      Write output to a file or stdout.\n  --timeout-ms <ms>      Polling timeout for brief creation.\n  --wait / --no-wait     Wait for async brief completion (default: wait).\n\nEnvironment:\n  YB_API_KEY\n  YB_BASE_URL\n  YOUTUBEBRIEF_API_KEY\n  YOUTUBEBRIEF_BASE_URL\n  YOUTUBEBRIEF_CONFIG_DIR\n  YB_NO_BROWSER=1 to suppress browser opening\n  YB_TELEMETRY=0 or YOUTUBEBRIEF_TELEMETRY=0 to opt out\n`;
}
