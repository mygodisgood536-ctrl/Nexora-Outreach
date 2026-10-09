import config from '../config.js';
import { AppError, err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('ai.cloud');

/**
 * OpenCode Cloud transport (spec §7/§31).
 *
 * Nexora's central AI Runtime talks to OpenCode over this seam only. OpenCode
 * Cloud (the hosted Console product) is exposed through two HTTPS surfaces:
 *
 *   • Workspace configuration / model discovery
 *       GET  {consoleUrl}/api/v2/config
 *     Returns the providers and models the service-account key may use, in the
 *     OpenCode v2 config format. Nexora derives its whole catalog from this —
 *     it is never hard-coded to a fixed provider/model list.
 *
 *   • Inference (one gateway for OpenAI/Anthropic/Gemini model families)
 *       POST {inferenceUrl}/inference/openai/v1/chat/completions
 *       POST {inferenceUrl}/inference/anthropic/v1/messages
 *       POST {inferenceUrl}/inference/google/v1beta/models/<model>:generateContent
 *     Each model's `package` selects the family; the catalog entry may also
 *     carry an explicit `settings.baseURL`.
 *
 * The service-account key is a server-side secret: it is only ever sent in the
 * `Authorization: Bearer` header, never logged, and never returned by
 * `describe()`. Deterministic concerns — scheduling, queues, limits, retries,
 * suppression, audit — deliberately stay outside this transport.
 */

const DEFAULT_INFERENCE_URL = 'https://opencode.ai';
const DEFAULT_CONSOLE_URL = 'https://console.opencode.ai';
const DEFAULT_MAX_TOKENS = 4096;

/** Which inference API family a catalog model is served by. */
export function familyOf(modelDef = {}) {
  const pkg = String(modelDef?.package || '');
  if (pkg.includes('anthropic')) return 'anthropic';
  if (pkg.includes('google')) return 'google';
  return 'openai';
}

function normaliseTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokenCount ?? null;
  const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.candidatesTokenCount ?? null;
  const total = usage.total_tokens ?? usage.totalTokenCount
    ?? ((prompt ?? 0) + (completion ?? 0) || null);
  if (prompt === null && completion === null && total === null) return null;
  return { prompt, completion, total };
}

export class OpenCodeCloudTransport {
  constructor({
    apiKey,
    inferenceUrl = DEFAULT_INFERENCE_URL,
    consoleUrl = DEFAULT_CONSOLE_URL,
    timeoutMs = config.opencode.timeoutMs,
    maxTokens = config.opencode.maxTokens,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (!apiKey) {
      throw err.ai('AI_PROVIDER_ERROR', 'OpenCode Cloud transport requires a service-account key.');
    }
    this.kind = 'cloud';
    this.apiKey = apiKey;
    this.inferenceUrl = String(inferenceUrl || DEFAULT_INFERENCE_URL).replace(/\/+$/, '');
    this.consoleUrl = String(consoleUrl || DEFAULT_CONSOLE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens || DEFAULT_MAX_TOKENS;
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    this._catalog = null;
  }

  /** Deliberately excludes the key. */
  describe() {
    return { kind: this.kind, bin: null, baseUrl: this.inferenceUrl, discoveryUrl: this.consoleUrl };
  }

  describeCredentials() {
    return { hasApiKey: Boolean(this.apiKey), kind: this.kind };
  }

  _headers(extra = {}) {
    return { accept: 'application/json', authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  /**
   * One HTTP round-trip. Failures map onto the shared error taxonomy so the
   * worker's bounded retry rules apply uniformly:
   *   timeout          -> AI_TIMEOUT (transient)
   *   401              -> UNAUTHENTICATED (permanent)
   *   403 / 404        -> AI_PROVIDER_ERROR (permanent: access/route won't fix)
   *   429 / 5xx / net  -> AI_PROVIDER_ERROR (transient, retried with backoff)
   * The key is never included in any error detail.
   */
  async _request(path, { method = 'GET', body, timeoutMs = this.timeoutMs, base = this.consoleUrl } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${base}${path}`, {
        method,
        headers: this._headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw err.ai('AI_TIMEOUT', `OpenCode Cloud timed out after ${timeoutMs}ms (${method} ${path})`);
      }
      throw err.ai('AI_PROVIDER_ERROR', `OpenCode Cloud unreachable: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = text.slice(0, 500);
      if (res.status === 401) {
        throw new AppError('UNAUTHENTICATED', 'OpenCode Cloud rejected its service-account key.', {
          kind: 'ai', status: 502, detail,
        });
      }
      if (res.status === 403) {
        throw err.ai('AI_MODEL_UNAVAILABLE',
          'OpenCode Cloud denied access to this model or operation (it may be disabled for this workspace).',
          detail);
      }
      if (res.status === 429) {
        throw err.ai('AI_PROVIDER_ERROR', 'OpenCode Cloud rate-limited the request (HTTP 429).', detail);
      }
      throw err.ai('AI_PROVIDER_ERROR',
        `OpenCode Cloud returned HTTP ${res.status} for ${method} ${path}.`, detail);
    }

    const type = res.headers?.get?.('content-type') || '';
    if (res.status === 204) return null;
    if (type.includes('json') || type.includes('text/json')) {
      return text ? JSON.parse(text) : null;
    }
    return text || null;
  }

  /** Config endpoint doubles as a credential/health check. */
  async version() {
    await this._request('/api/v2/config', { timeoutMs: Math.min(15000, this.timeoutMs) });
    return 'opencode-cloud';
  }

  async _config() {
    const data = await this._request('/api/v2/config', { timeoutMs: Math.min(30000, this.timeoutMs) });
    return data?.providers || data?.provider || {};
  }

  /**
   * Live catalog from the OpenCode workspace configuration. Every model Nexora
   * can offer is derived from here (§7: never a hard-coded Nexora list).
   * Cached per transport instance; pass `refresh` after a config change.
   */
  async listModels({ refresh = false } = {}) {
    if (this._catalog && !refresh) return this._catalog;
    const providers = await this._config();
    const models = [];
    for (const [providerId, provider] of Object.entries(providers || {})) {
      const list = provider?.models || {};
      for (const [modelId, def] of Object.entries(list)) {
        models.push({
          id: `${providerId}/${modelId}`,
          provider: providerId,
          model: modelId,
          name: def?.name || modelId,
          family: def?.family || null,
          api: familyOf(def),
          baseURL: def?.settings?.baseURL || null,
          capabilities: def?.capabilities || null,
          limit: def?.limit || null,
          cost: Array.isArray(def?.cost) ? (def.cost[0] || null) : (def?.cost || null),
        });
      }
    }
    if (!models.length) {
      throw err.ai('AI_PROVIDER_ERROR', 'OpenCode Cloud returned no models for this workspace.');
    }
    log.info('catalog loaded from OpenCode Cloud', { models: models.length });
    this._catalog = models;
    return models;
  }

  async listProviders() {
    const providers = await this._config();
    return Object.keys(providers || {}).join('\n');
  }

  _bareModel(model) {
    // Catalog ids are `provider/model`; the gateway expects the bare model id.
    const slash = String(model).indexOf('/');
    return slash === -1 ? String(model) : String(model).slice(slash + 1);
  }

  _route(modelEntry) {
    const family = modelEntry?.api || 'openai';
    if (family === 'anthropic') {
      const base = modelEntry?.baseURL || `${this.inferenceUrl}/inference/anthropic/v1`;
      return { family, url: `${base.replace(/\/+$/, '')}/messages` };
    }
    if (family === 'google') {
      const base = modelEntry?.baseURL || `${this.inferenceUrl}/inference/google/v1beta`;
      return { family, url: `${base.replace(/\/+$/, '')}/models` };
    }
    const base = modelEntry?.baseURL || `${this.inferenceUrl}/inference/openai/v1`;
    return { family: 'openai', url: `${base.replace(/\/+$/, '')}/chat/completions` };
  }

  _extract(family, data) {
    if (family === 'anthropic') {
      const parts = Array.isArray(data?.content) ? data.content : [];
      return parts.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
    }
    if (family === 'google') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
    return '';
  }

  /**
   * Execute one prompt through OpenCode Cloud and return the assistant text in
   * the same shape as every other transport: `{ text, cost, tokens }`.
   */
  async runPrompt(prompt, { model, timeoutMs = this.timeoutMs } = {}) {
    if (!model) throw err.ai('AI_PROVIDER_ERROR', 'No provider/model selected for AI execution.');
    const models = await this.listModels();
    const bare = this._bareModel(model);
    const entry = models.find((m) => m.id === model) || models.find((m) => m.model === bare) || null;
    const route = this._route(entry);

    let body;
    if (route.family === 'anthropic') {
      body = {
        model: bare,
        max_tokens: this.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      };
    } else if (route.family === 'google') {
      route.url = `${route.url}/${encodeURIComponent(bare)}:generateContent`;
      body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: this.maxTokens },
      };
    } else {
      body = {
        model: bare,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: this.maxTokens,
      };
    }

    return this._post(route, body, timeoutMs);
  }

  async _post(route, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(route.url, {
        method: 'POST',
        headers: this._headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw err.ai('AI_TIMEOUT', `OpenCode Cloud timed out after ${timeoutMs}ms`);
      }
      throw err.ai('AI_PROVIDER_ERROR', `OpenCode Cloud unreachable: ${e?.message || e}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = text.slice(0, 500);
      if (res.status === 401) {
        throw new AppError('UNAUTHENTICATED', 'OpenCode Cloud rejected its service-account key.', {
          kind: 'ai', status: 502, detail,
        });
      }
      if (res.status === 403) {
        throw err.ai('AI_MODEL_UNAVAILABLE',
          'OpenCode Cloud denied access to this model (it may be disabled for this workspace).',
          detail);
      }
      if (res.status === 429) {
        throw err.ai('AI_PROVIDER_ERROR', 'OpenCode Cloud rate-limited the request (HTTP 429).', detail);
      }
      throw err.ai('AI_PROVIDER_ERROR', `OpenCode Cloud returned HTTP ${res.status}.`, detail);
    }

    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    const out = this._extract(route.family, data);
    if (!out || !out.trim()) {
      throw err.ai('AI_PROVIDER_ERROR', 'OpenCode Cloud returned no text output.',
        text.slice(0, 500));
    }
    return { text: out.trim(), cost: null, tokens: normaliseTokens(data?.usage || data?.usageMetadata) };
  }
}

export default OpenCodeCloudTransport;