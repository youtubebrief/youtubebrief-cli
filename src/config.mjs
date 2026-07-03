import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE_URL = 'https://youtubebrief.com';
export const CONFIG_FILE_NAME = 'config.json';

export function getConfigDir(env = process.env) {
  if (env.YOUTUBEBRIEF_CONFIG_DIR) {
    return env.YOUTUBEBRIEF_CONFIG_DIR;
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, 'youtubebrief');
  }
  return path.join(homedir(), '.config', 'youtubebrief');
}

export function getConfigPath(env = process.env) {
  return path.join(getConfigDir(env), CONFIG_FILE_NAME);
}

export async function readStoredConfig(env = process.env) {
  try {
    const raw = await readFile(getConfigPath(env), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : undefined,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      telemetry: typeof parsed.telemetry === 'boolean' ? parsed.telemetry : undefined,
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function writeStoredConfig(config, env = process.env) {
  const configDir = getConfigDir(env);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => {});
  const body = JSON.stringify({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || DEFAULT_BASE_URL,
    ...(typeof config.telemetry === 'boolean' ? { telemetry: config.telemetry } : {}),
  }, null, 2) + '\n';
  const configPath = getConfigPath(env);
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, body, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}


export async function removeStoredConfig(env = process.env) {
  await rm(getConfigPath(env), { force: true });
}

export async function resolveConfig(overrides = {}, env = process.env) {
  const stored = await readStoredConfig(env);
  return {
    apiKey: overrides.apiKey || env.YB_API_KEY || env.YOUTUBEBRIEF_API_KEY || stored.apiKey,
    baseUrl: normalizeBaseUrl(overrides.baseUrl || env.YB_BASE_URL || env.YOUTUBEBRIEF_BASE_URL || stored.baseUrl || DEFAULT_BASE_URL),
    configPath: getConfigPath(env),
    telemetry: typeof stored.telemetry === 'boolean' ? stored.telemetry : undefined,
    hasStoredApiKey: Boolean(stored.apiKey),
    hasEnvApiKey: Boolean(env.YB_API_KEY || env.YOUTUBEBRIEF_API_KEY),
  };
}

export function normalizeBaseUrl(value) {
  const baseUrl = String(value || DEFAULT_BASE_URL).trim();
  return baseUrl.replace(/\/+$/, '');
}

export function validateBaseUrl(value) {
  const normalized = normalizeBaseUrl(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid base URL. Use an http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid base URL protocol. Use http:// or https://.');
  }
  return normalized;
}
