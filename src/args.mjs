import { CliError } from './errors.mjs';

const URL_PATTERN = /^https?:\/\//i;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0) return { command: 'interactive' };
  const first = args[0];
  if (first === '--no-browser') return { command: 'interactive', noBrowser: true };
  if (first === '--help' || first === '-h' || first === 'help') return { command: 'help' };
  if (first === '--version' || first === '-v' || first === 'version') return { command: 'version' };
  if (first === 'login') return parseLogin(args.slice(1));
  if (first === 'signup') return parseSignup(args.slice(1));
  if (first === 'buy') return parseBuy(args.slice(1));
  if (first === 'logout') return ensureNoPositionals('logout', args.slice(1));
  if (first === 'whoami') return parseProbe('whoami', args.slice(1));
  if (first === 'credits') return parseProbe('credits', args.slice(1));
  if (first === 'doctor') return parseDoctor(args.slice(1));
  if (first === 'config') return parseConfig(args.slice(1));
  if (first === 'mcp') return parseMcp(args.slice(1));
  if (first === 'batch') return parseBatch(args.slice(1));
  if (first === 'export') return parseExport(args.slice(1));
  if (first === 'schema') return parseSchema(args.slice(1));
  if (first === 'brief') return parseBrief(args.slice(1));
  if (URL_PATTERN.test(first)) return parseBrief(args);
  throw new CliError(`Unknown command: ${first}. Run \`yb --help\` for usage.`);
}

function parseLogin(args) {
  const result = { command: 'login' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--token-stdin') result.tokenStdin = true;
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--no-browser') result.noBrowser = true;
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'login' };
    else throw new CliError(`Unknown login option: ${arg}`);
  }
  return result;
}

function parseSignup(args) {
  const result = { command: 'signup' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--email') result.email = readValue(args, ++index, arg);
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'signup' };
    else throw new CliError(`Unknown signup option: ${arg}`);
  }
  if (!result.email) throw new CliError('Missing email. Usage: yb signup --email you@example.com');
  return result;
}

function parseBuy(args) {
  const result = { command: 'buy' };
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--minutes') result.minutes = readBillingMinutes(readValue(args, ++index, arg), arg);
    else if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--no-browser') result.noBrowser = true;
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'buy' };
    else if (arg.startsWith('-')) throw new CliError(`Unknown buy option: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length > 1) throw new CliError('Usage: yb buy <5|10|30|60>');
  if (positionals[0]) result.minutes = readBillingMinutes(positionals[0], 'minutes');
  if (!result.minutes) throw new CliError('Missing minutes. Usage: yb buy <5|10|30|60>');
  return result;
}

function parseProbe(command, args) {
  const result = { command };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: command };
    else throw new CliError(`Unknown ${command} option: ${arg}`);
  }
  return result;
}


function parseConfig(args) {
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', topic: 'config' };
  const subcommand = args[0];
  if (subcommand === 'get') {
    const key = args[1];
    if (args.length > 2) throw new CliError(`Unexpected arguments for config get: ${args.slice(2).join(' ')}`);
    if (key && !['base-url', 'api-key', 'config-path', 'telemetry'].includes(key)) {
      throw new CliError('Usage: yb config get [base-url|api-key|config-path|telemetry]');
    }
    return { command: 'config', action: 'get', key };
  }
  if (subcommand === 'set') {
    const key = args[1];
    if (!['base-url', 'api-key', 'telemetry'].includes(key)) throw new CliError('Usage: yb config set base-url <url> | yb config set api-key --token-stdin | yb config set telemetry on|off');
    const result = { command: 'config', action: 'set', key };
    const rest = args.slice(2);
    if (key === 'base-url') {
      if (rest.length !== 1) throw new CliError('Usage: yb config set base-url <url>');
      result.value = rest[0];
      return result;
    }
    if (key === 'telemetry') {
      if (rest.length !== 1) throw new CliError('Usage: yb config set telemetry on|off');
      result.value = rest[0];
      return result;
    }
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index];
      if (arg === '--token-stdin') result.tokenStdin = true;
      else throw new CliError(`Unknown config set api-key option: ${arg}`);
    }
    if (!result.tokenStdin) throw new CliError('Usage: yb config set api-key --token-stdin');
    return result;
  }
  throw new CliError('Usage: yb config get [base-url|api-key|config-path|telemetry] | yb config set base-url <url> | yb config set api-key --token-stdin | yb config set telemetry on|off');
}

function parseMcp(args) {
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', topic: 'mcp' };
  if (args.length > 0) throw new CliError(`Unexpected arguments for mcp: ${args.join(' ')}`);
  return { command: 'mcp' };
}

function parseDoctor(args) {
  const result = { command: 'doctor' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--out-dir') result.outDir = readValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'doctor' };
    else throw new CliError(`Unknown doctor option: ${arg}`);
  }
  return result;
}

function parseBrief(args) {
  const result = { command: 'brief', format: 'markdown', wait: true };
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--format') result.format = readValue(args, ++index, arg);
    else if (arg === '--json') result.format = 'json';
    else if (arg === '--output' || arg === '-o') result.output = readValue(args, ++index, arg);
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--timeout-ms') result.timeoutMs = readInteger(args, ++index, arg);
    else if (arg === '--minutes' || arg === '--block') result.billingBlockMinutes = readBillingMinutes(readValue(args, ++index, arg), arg);
    else if (arg === '--poll-interval-ms') result.pollIntervalMs = readInteger(args, ++index, arg);
    else if (arg === '--wait') result.wait = true;
    else if (arg === '--no-wait') result.wait = false;
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'brief' };
    else if (arg.startsWith('-')) throw new CliError(`Unknown brief option: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 1) {
    throw new CliError('Expected one YouTube URL. Usage: yb brief <youtube-url>');
  }
  if (!['markdown', 'json'].includes(result.format)) {
    throw new CliError('Invalid --format. Use markdown or json.');
  }
  result.youtubeUrl = positionals[0];
  if (!result.billingBlockMinutes) result.billingBlockMinutes = 10;
  return result;
}


function parseBatch(args) {
  const result = {
    command: 'batch',
    urls: [],
    inputFiles: [],
    useStdin: false,
    concurrency: 2,
    allowPartial: false,
    wait: true,
    dryRun: false,
    estimateCredits: false,
    resume: false,
    failedOnly: false,
    retryProviderErrors: false,
    combinedMd: false,
    jsonl: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out-dir') result.outDir = readValue(args, ++index, arg);
    else if (arg === '--input') result.inputFiles.push(readValue(args, ++index, arg));
    else if (arg === '--stdin') result.useStdin = true;
    else if (arg === '--concurrency') result.concurrency = readPositiveInteger(args, ++index, arg);
    else if (arg === '--allow-partial') result.allowPartial = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--estimate-credits') result.estimateCredits = true;
    else if (arg === '--resume') result.resume = true;
    else if (arg === '--failed-only') result.failedOnly = true;
    else if (arg === '--retry-provider-errors') result.retryProviderErrors = true;
    else if (arg === '--combined-md') result.combinedMd = true;
    else if (arg === '--jsonl') result.jsonl = true;
    else if (arg === '--base-url') result.baseUrl = readValue(args, ++index, arg);
    else if (arg === '--api-key') result.apiKey = readValue(args, ++index, arg);
    else if (arg === '--timeout-ms') result.timeoutMs = readInteger(args, ++index, arg);
    else if (arg === '--minutes' || arg === '--block') result.billingBlockMinutes = readBillingMinutes(readValue(args, ++index, arg), arg);
    else if (arg === '--poll-interval-ms') result.pollIntervalMs = readInteger(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'batch' };
    else if (arg === '-') result.useStdin = true;
    else if (arg.startsWith('-')) throw new CliError(`Unknown batch option: ${arg}`);
    else result.urls.push(arg);
  }
  if (!result.outDir) throw new CliError('Missing --out-dir. Usage: yb batch --out-dir <dir> <youtube-url...>');
  if (!result.billingBlockMinutes) result.billingBlockMinutes = 10;
  return result;
}

function parseExport(args) {
  const result = { command: 'export' };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--from') result.from = readValue(args, ++index, arg);
    else if (arg === '--format') result.format = readValue(args, ++index, arg);
    else if (arg === '--output' || arg === '-o') result.output = readValue(args, ++index, arg);
    else if (arg === '--help' || arg === '-h') return { command: 'help', topic: 'export' };
    else throw new CliError(`Unknown export option: ${arg}`);
  }
  if (!result.from) throw new CliError('Missing --from. Usage: yb export --from <out-dir> --format combined-md|jsonl');
  if (!result.format) throw new CliError('Missing --format. Usage: yb export --from <out-dir> --format combined-md|jsonl');
  if (!['combined-md', 'jsonl'].includes(result.format)) throw new CliError('Invalid --format. Use combined-md or jsonl.');
  return result;
}

function parseSchema(args) {
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', topic: 'schema' };
  if (args.length !== 1 || args[0] !== 'manifest') throw new CliError('Usage: yb schema manifest');
  return { command: 'schema', topic: 'manifest' };
}

function ensureNoPositionals(command, args) {
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', topic: command };
  if (args.length > 0) throw new CliError(`Unexpected arguments for ${command}: ${args.join(' ')}`);
  return { command };
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new CliError(`Missing value for ${flag}.`);
  return value;
}

function readBillingMinutes(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (![5, 10, 30, 60].includes(parsed)) throw new CliError(`Invalid ${flag}. Use 5, 10, 30, or 60.`);
  return parsed;
}

function readInteger(args, index, flag) {
  const value = readValue(args, index, flag);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new CliError(`Invalid integer for ${flag}: ${value}`);
  return parsed;
}

function readPositiveInteger(args, index, flag) {
  const value = readValue(args, index, flag);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new CliError(`Invalid positive integer for ${flag}: ${value}`);
  return parsed;
}
