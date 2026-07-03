export class CliError extends Error {
  constructor(message, { exitCode = 1 } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

const SECRET_MESSAGE_PATTERNS = [
  /yb_live_[A-Za-z0-9_-]+/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /sk_live_[A-Za-z0-9_-]+/g,
  /sk_[A-Za-z0-9_-]{12,}/g,
  /api[_ -]?key[=:]\s*[^\s,&}]+/gi,
  /access[_ -]?token[=:]\s*[^\s,&}]+/gi,
  /raw\s+provider\s+response[:=]?[^\n]*/gi,
  /raw[_ -]?provider[_ -]?secret[^\s,&}]*/gi,
  /provider[_ -]?secret[=:]?\s*[^\s,&}]+/gi,
  /stack\s*trace/gi,
];

export function sanitizeMessage(value, secrets = []) {
  let message = String(value ?? '');
  for (const secret of secrets) {
    if (secret) {
      message = message.split(secret).join('[redacted]');
    }
  }
  for (const pattern of SECRET_MESSAGE_PATTERNS) {
    message = message.replace(pattern, '[redacted]');
  }
  return message;
}

export function friendlyHttpError(status, context = 'request') {
  if (status === 401 || status === 403) {
    return `Authentication failed for ${context}. Run \`yb login\` in a terminal, or set YB_API_KEY/YOUTUBEBRIEF_API_KEY.`;
  }
  if (status === 402) {
    return `Youtubebrief credits or billing are required for ${context}. Check your plan or available credits.`;
  }
  if (status === 429) {
    return `Youtubebrief rate limited ${context}. Please wait and try again.`;
  }
  if (status >= 500) {
    return `Youtubebrief service error (${status}) during ${context}. Please retry shortly.`;
  }
  return `Youtubebrief API returned HTTP ${status} during ${context}.`;
}
