import { runPrompt as cliRunPrompt, listModels as cliListModels, listProviders as cliListProviders, opencodeVersion } from './opencode-adapter.js';
import { OpenCodeCloudTransport } from './cloud-transport.js';
import { AppError, err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import config from '../config.js';

const log = createLogger('ai.transport');

/**
 * AI transport seam (spec §7/§31).
 *
 * Nexora talks to OpenCode through this interface only, so the runtime never
 * cares whether OpenCode is a local binary or a remote server:
 *
 *  - `cli`  spawns the installed OpenCode binary (development machines),
 *  - `http` speaks to `opencode serve` / an OpenCode cloud endpoint
 *           (`OPENCODE_BASE_URL`), which is the only shape that works on
 *           serverless hosts where spawning a binary is impossible.
 *
 * Both implement: `{ kind, listModels, runPrompt, listProviders, version }`.
 */
export class CliTransport {
  constructor({ bin = config.opencode.bin } = {}) {
    this.kind = 'cli';
    this.bin = bin;
  }

  listModels(opts = {}) { return cliListModels(opts); }
  listProviders() { return cliListProviders(); }
  version() { return opencodeVersion(); }

  runPrompt(prompt, opts = {}) {
    return cliRunPrompt(prompt, opts);
  }

  describe() {
    return { kind: this.kind, bin: this.bin, baseUrl: null };
  }
}

/**
 * HTTP transport for a remote OpenCode server (`opencode serve`, or the
 * hosted equivalent). Speaks the documented OpenAPI surface:
 *
 *   GET    /global/health            -> { healthy, version }
 *   GET    /config/providers         -> { providers, default }
 *   POST   /session                  -> { id, ... }
 *   POST   /session/:id/message      -> { info, parts }
 *   DELETE /session/:id              -> best-effort cleanup
 *
 * Auth is HTTP basic (username `opencode`, password `OPENCODE_SERVER_PASSWORD`
 * on the server side; Nexora sends it as `OPENCODE_API_KEY`). Credentials are
 * never logged and never returned by `describe()`.
 */
export class HttpTransport {
  constructor({
    baseUrl, username = 'opencode', password = '',
    timeoutMs = config.opencode.timeoutMs, fetchImpl = globalThis.fetch,
  } = {}) {
    if (!baseUrl) throw err.ai('AI_PROVIDER_ERROR', 'OpenCode HTTP transport requires a base URL.');
    this.kind = 'http';
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  }

  describe() {
    // Deliberately excludes the password.
    return { kind: this.kind, bin: null, baseUrl: this.baseUrl };
  }

  _headers(extra = {}) {
    const headers = { accept: 'application/json', ...extra };
    if (this.password) {
      const token = Buffer.from(`${this.username}:${this.password}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    return headers;
  }

  /**
   * One HTTP round-trip. Every failure mode is mapped onto the shared error
   * taxonomy so the worker's bounded retry rules apply uniformly:
   * timeouts -> AI_TIMEOUT (transient), network/5xx/429 -> AI_PROVIDER_ERROR
   * (transient), rejected credentials -> UNAUTHENTICATED (permanent).
   */
  async _request(path, { method = 'GET', body = undefined, timeoutMs = this.timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this._headers(body ? { 'content-type': 'application/json' } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw err.ai('AI_TIMEOUT', `OpenCode server timed out after ${timeoutMs}ms (${method} ${path})`);
      }
      throw err.ai('AI_PROVIDER_ERROR', `OpenCode server unreachable: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new AppError('UNAUTHENTICATED', 'The OpenCode server rejected its credentials.', {
          kind: 'ai', status: 502, detail: detail.slice(0, 500),
        });
      }
      if (res.status === 404) {
        throw err.ai('AI_PROVIDER_ERROR', `OpenCode server has no ${path} endpoint (HTTP 404).`);
      }
      throw err.ai('AI_PROVIDER_ERROR', `OpenCode server returned HTTP ${res.status} for ${method} ${path}.`,
        detail.slice(0, 500));
    }

    const type = res.headers?.get?.('content-type') || '';
    if (method === 'DELETE' || res.status === 204) return null;
    if (type.includes('application/json') || type.includes('text/json')) {
      return res.json().catch(() => null);
    }
    const text = await res.text().catch(() => '');
    return text || null;
  }

  async version() {
    const health = await this._request('/global/health', { timeoutMs: 15000 });
    if (!health || health.healthy === false) {
      throw err.ai('AI_PROVIDER_ERROR', 'OpenCode server reports it is unhealthy.');
    }
    return String(health.version || 'unknown');
  }

  /** Provider/model catalog, mirroring the CLI's `opencode models` output. */
  async listModels() {
    const payload = await this._request('/config/providers');
    const providers = Array.isArray(payload?.providers)
      ? payload.providers
      : Array.isArray(payload?.all) ? payload.all : [];

    const models = [];
    const seen = new Set();
    for (const p of providers) {
      const providerId = String(p?.id || p?.provider || '').trim();
      if (!providerId) continue;
      const raw = p.models || {};
      const entries = Array.isArray(raw)
        ? raw.map((m) => (typeof m === 'string' ? [m, {}] : [m?.id || m?.model || '', m]))
        : Object.entries(raw);
      for (const [modelId, def] of entries) {
        if (!modelId) continue;
        const id = modelId.includes('/') ? modelId : `${providerId}/${modelId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        models.push({ id, provider: providerId, model: id.split('/').slice(1).join('/') });
      }
    }

    if (models.length === 0) {
      throw err.ai('AI_PROVIDER_ERROR', 'The OpenCode server returned no models.');
    }
    return models;
  }

  async listProviders() {
    const payload = await this._request('/config/providers');
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    return providers.map((p) => p?.id || p?.provider).filter(Boolean).join('\n');
  }

  /**
   * Execute one prompt end to end: fresh session, single message, cleanup.
   * Returns the assistant's text in exactly the shape the CLI transport does,
   * so `AIRuntime.complete()` is transport-agnostic.
   */
  async runPrompt(prompt, { model, agent = null, timeoutMs = this.timeoutMs } = {}) {
    if (!model) throw err.ai('AI_PROVIDER_ERROR', 'No provider/model selected for AI execution.');

    const session = await this._request('/session', {
      method: 'POST', body: { title: 'Nexora Outreach' }, timeoutMs: Math.min(timeoutMs, 30000),
    });
    const sessionId = session?.id || session?.sessionId;
    if (!sessionId) throw err.ai('AI_PROVIDER_ERROR', 'The OpenCode server did not return a session id.');

    try {
      const body = { parts: [{ type: 'text', text: prompt }], model };
      if (agent) body.agent = agent;
      const result = await this._request(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST', body, timeoutMs,
      });

      const parts = Array.isArray(result?.parts) ? result.parts : [];
      const text = parts
        .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
        .map((p) => p.text || '')
        .join('');
      if (!text.trim()) {
        throw err.ai('AI_PROVIDER_ERROR', 'The OpenCode server returned no text output.',
          JSON.stringify(result?.info || {}).slice(0, 500));
      }

      const info = result?.info || {};
      const tokens = info.tokens || null;
      const cost = typeof info.cost === 'number' ? info.cost : null;
      return { text: text.trim(), cost, tokens };
    } finally {
      // Sessions are per-call scratch space; failing to clean up must never
      // turn a successful completion into an error.
      try {
        await this._request(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', timeoutMs: 10000 });
      } catch (e) {
        log.warn('session cleanup failed', { message: e?.message });
      }
    }
  }

  describeCredentials() {
    return { username: this.username, hasPassword: Boolean(this.password) };
  }
}

/**
 * Pick the transport from configuration, in priority order:
 *
 *   1. OpenCode Cloud   — when an `oc_sk_...` service-account key is present
 *                         (production on Vercel). Discovered automatically; no
 *                         extra secret is needed to select it.
 *   2. Remote server    — when `OPENCODE_BASE_URL` points at `opencode serve`.
 *   3. Local binary     — the development default (`opencode` on PATH).
 */
export function createTransport(cfg = config.opencode) {
  if (cfg?.cloud) {
    return new OpenCodeCloudTransport({
      apiKey: cfg.apiKey,
      inferenceUrl: cfg.cloudUrl,
      consoleUrl: cfg.consoleUrl,
      timeoutMs: cfg.timeoutMs,
      maxTokens: cfg.maxTokens,
    });
  }
  if (cfg?.baseUrl) {
    return new HttpTransport({
      baseUrl: cfg.baseUrl,
      username: cfg.username || 'opencode',
      password: cfg.password || '',
      timeoutMs: cfg.timeoutMs,
    });
  }
  return new CliTransport({ bin: cfg?.bin });
}

export default createTransport;
