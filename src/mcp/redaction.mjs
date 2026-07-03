import { sanitizeMessage } from '../errors.mjs';

const SECRET_PATTERNS = [
  /yb_live_[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /api[_-]?key[=:]\s*[^\s,&}]+/gi,
  /access[_-]?token[=:]\s*[^\s,&}]+/gi,
  /raw\s+provider\s+response[:=]?[^\n]*/gi,
  /provider[_-]?secret[=:]?\s*[^\s,&}]+/gi,
  /stack\s*trace/gi,
];
const SENSITIVE_KEY_PATTERN = /api[_-]?key|access[_-]?token|authorization|raw[_-]?provider|provider[_-]?secret|stack/i;

export function redactText(value, secrets = []) {
  let text = sanitizeMessage(value, secrets);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  return text;
}

export function redactJson(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY_PATTERN.test(key))
        .map(([key, child]) => [key, redactJson(child, secrets)])
    );
  }
  if (typeof value === 'string') return redactText(value, secrets);
  return value;
}

export function assertNoSecretText(value, secrets = []) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) throw new Error('MCP response would contain a secret.');
  }
  if (/yb_live_[A-Za-z0-9_-]+/.test(text)) throw new Error('MCP response would contain a live API key pattern.');
  if (/raw\s+provider\s+response|stack\s*trace/i.test(text)) throw new Error('MCP response would contain provider internals.');
}
