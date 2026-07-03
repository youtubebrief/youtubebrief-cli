import { CliError, friendlyHttpError, sanitizeMessage } from './errors.mjs';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const TERMINAL_SUCCESS = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'ready']);
const TERMINAL_FAILURE = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled']);

export class YoutubebriefClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch } = {}) {
    if (!baseUrl) throw new CliError('Missing Youtubebrief base URL.');
    if (!fetchImpl) throw new CliError('This Node runtime does not provide fetch. Use Node 20 or newer.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async createBrief(youtubeUrl, options = {}) {
    if (!this.apiKey) {
      throw new CliError('Missing API key. Run `yb login` for interactive setup, or set YOUTUBEBRIEF_API_KEY.');
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
    const wait = options.wait !== false;
    const startedAt = Date.now();

    const createBody = { youtubeUrl };
    if (options.billingBlockMinutes !== undefined) createBody.billingBlockMinutes = options.billingBlockMinutes;
    if (options.idempotencyKey) createBody.idempotencyKey = options.idempotencyKey;
    let payload = await this.requestJson('/api/v1/summaries', {
      method: 'POST',
      body: createBody,
      context: 'creating a brief',
    });
    const createPayload = payload;

    let nextUrl = getResultUrl(payload);
    if (!nextUrl && payload && payload.id && shouldFetchResult(payload)) {
      nextUrl = `/api/v1/summaries/${encodeURIComponent(payload.id)}`;
    }

    if (nextUrl) {
      payload = mergeCreateResponseFacts(
        await this.requestJson(nextUrl, { method: 'GET', context: 'fetching a brief' }),
        createPayload
      );
    }

    while (isPending(payload)) {
      if (!wait) return payload;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new CliError(`Timed out waiting for Youtubebrief after ${timeoutMs}ms.`);
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
      const pollUrl = getResultUrl(payload) || nextUrl || (payload && payload.id ? `/api/v1/summaries/${encodeURIComponent(payload.id)}` : undefined);
      if (!pollUrl) {
        throw new CliError('Youtubebrief response is still processing but did not include a result URL or id.');
      }
      payload = mergeCreateResponseFacts(
        await this.requestJson(pollUrl, { method: 'GET', context: 'polling a brief' }),
        createPayload
      );
    }

    if (isFailure(payload)) {
      const reason = payload.error || payload.message || payload.status;
      throw new CliError(`Youtubebrief could not create the brief: ${sanitizeMessage(reason, [this.apiKey])}`);
    }

    return payload;
  }

  async signup({ email }) {
    return this.requestJson('/api/v1/accounts', { method: 'POST', body: { email }, context: 'creating an account' });
  }

  async createCheckout({ minutes }) {
    return this.requestJson('/api/v1/billing/checkout', { method: 'POST', body: { minutes }, context: 'creating a checkout session' });
  }

  async whoami() {
    return this.requestJson('/api/v1/me', { method: 'GET', context: 'checking account' });
  }

  async credits() {
    return this.requestJson('/api/v1/credits', { method: 'GET', context: 'checking credits' });
  }

  async requestJson(target, { method = 'GET', body, context = 'request' } = {}) {
    const url = this.resolveUrl(target);
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
      });
    } catch (error) {
      throw new CliError(`Could not reach Youtubebrief for ${context}. Check ${this.baseUrl} and your network connection. (${sanitizeMessage(error.message, [this.apiKey])})`);
    }

    const text = await response.text();
    let payload = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const detail = extractErrorMessage(payload);
      const apiMessage = detail ? ` ${sanitizeMessage(detail, [this.apiKey])}` : '';
      throw new CliError(`${friendlyHttpError(response.status, context)}${apiMessage}`);
    }

    return payload ?? {};
  }

  resolveUrl(target) {
    const value = String(target);
    const baseUrl = new URL(`${this.baseUrl}/`);
    const targetUrl = new URL(
      /^https?:\/\//i.test(value) || value.startsWith('//')
        ? value
        : value.startsWith('/') ? value : `/${value}`,
      baseUrl
    );
    if (targetUrl.origin !== baseUrl.origin) {
      throw new CliError('Youtubebrief returned a cross-origin result URL, which is not allowed.');
    }
    if (baseUrl.protocol === 'https:' && targetUrl.protocol !== 'https:') {
      throw new CliError('Youtubebrief returned an insecure result URL, which is not allowed.');
    }
    return targetUrl.toString();
  }
}

function mergeCreateResponseFacts(payload, createPayload) {
  if (!payload || typeof payload !== 'object' || !createPayload || typeof createPayload !== 'object') return payload;
  return {
    ...payload,
    billing: payload.billing ?? createPayload.billing,
  };
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.error === 'string') return payload.error;
  if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
  if (payload.error && typeof payload.error.code === 'string') return payload.error.code;
  return '';
}

function getResultUrl(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  return payload.resultUrl || payload.result_url || payload.url || payload.links?.result;
}

function shouldFetchResult(payload) {
  return isPending(payload) || (!extractMarkdown(payload) && !TERMINAL_FAILURE.has(normalizeStatus(payload.status)));
}

function isPending(payload) {
  const status = normalizeStatus(payload && payload.status);
  if (!status) return false;
  return !TERMINAL_SUCCESS.has(status) && !TERMINAL_FAILURE.has(status);
}

function isFailure(payload) {
  return TERMINAL_FAILURE.has(normalizeStatus(payload && payload.status));
}

function normalizeStatus(status) {
  return typeof status === 'string' ? status.toLowerCase() : '';
}

function extractMarkdown(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return payload.markdown || payload.summaryMarkdown || payload.brief || payload.summary || payload.content || payload.text || '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
