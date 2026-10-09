import { createTransport } from './transport.js';
import config from '../config.js';
import { err, AppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('ai');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Pull the first balanced JSON value out of model output. Models sometimes
 * wrap JSON in prose or fences, so we scan for a balanced object/array while
 * respecting string literals and escapes.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const starts = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '{' || source[i] === '[') starts.push(i);
  }
  for (const start of starts) {
    const open = source[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

const DEFAULT_SYSTEM =
  'You are a precise analysis engine inside Nexora Outreach. ' +
  'Return only what is supported by the evidence provided. ' +
  'Never invent facts, contact details, or observations. ' +
  'When asked for JSON, return valid JSON and nothing else.';

/**
 * The single AI interface that Nexora business logic depends on.
 * Swapping the underlying provider is a backend concern only (§7).
 */
export class AIRuntime {
  constructor({ db, transport = createTransport(), bin = config.opencode.bin } = {}) {
    if (!db) throw new Error('AIRuntime requires a db handle');
    this.db = db;
    // The transport is the only way this runtime reaches OpenCode: a local
    // binary in development, an HTTP server (OPENCODE_BASE_URL) in production.
    this.transport = transport;
    this.bin = bin;
    this._catalogCache = { at: 0, models: null };
  }

  /** Live catalog from OpenCode, lightly cached to avoid hammering the CLI. */
  async catalog({ refresh = false, cacheMs = 30000 } = {}) {
    const fresh = Date.now() - this._catalogCache.at < cacheMs;
    if (!refresh && fresh && this._catalogCache.models) return this._catalogCache.models;
    const models = await this.transport.listModels({ refresh });
    this._catalogCache = { at: Date.now(), models };
    return models;
  }

  /** Persisted selection for a user, falling back to the configured default. */
  async selection(userId) {
    const row = await this.db.get('SELECT provider, model, agent FROM ai_settings WHERE user_id = ?', userId);
    if (row?.model) return row;
    const fallback = String(config.opencode.defaultModel);
    const [provider] = fallback.split('/');
    return { provider, model: fallback, agent: null };
  }

  /**
   * Discover and persist a provider/model choice.
   * Uses the cached catalog by default; pass `{ refresh: true }` when the user
   * explicitly asks OpenCode to re-fetch (that path hits models.dev and is
   * slow, so it must never block ordinary selection changes).
   */
  async setSelection(userId, modelId, agent = null, { refresh = false } = {}) {
    const models = await this.catalog({ refresh });
    const found = models.find((m) => m.id === modelId);
    if (!found) {
      throw err.validation(
        `"${modelId}" is not offered by the installed OpenCode runtime.`,
        { available: models.slice(0, 50).map((m) => m.id) }
      );
    }
    await this.db.run(
      `INSERT INTO ai_settings(user_id, provider, model, agent, updated_at, updated_by)
       VALUES(?,?,?,?,datetime('now'),'user')
       ON CONFLICT(user_id) DO UPDATE SET
         provider=excluded.provider, model=excluded.model,
         agent=excluded.agent, updated_at=datetime('now'), updated_by='user'`,
      userId, found.provider, found.id, agent
    );
    return { provider: found.provider, model: found.id, agent };
  }

  /**
   * Core execution with bounded retries on transient failures (spec §30).
   * Permanent failures surface immediately rather than looping.
   */
  async complete(userId, purpose, { system = DEFAULT_SYSTEM, prompt, maxRetries = 2, timeoutMs } = {}) {
    const sel = await this.selection(userId);
    const started = Date.now();
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      attempt++;
      try {
        const full = system ? `${system}\n\n---\n\n${prompt}` : prompt;
        const out = await this.transport.runPrompt(full, { model: sel.model, agent: sel.agent, timeoutMs });
        await this._log(userId, purpose, sel.model, Date.now() - started);
        return { text: out.text, model: sel.model, cost: out.cost, attempts: attempt };
      } catch (e) {
        lastError = e;
        const retryable = e instanceof AppError && e.retryable;
        log.warn(`ai ${purpose} attempt ${attempt} failed`, { code: e.code, msg: e.message });
        if (!retryable || attempt > maxRetries) break;
        await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)));
      }
    }

    await this._log(
      userId, purpose, sel.model, Date.now() - started,
      String(lastError?.message || lastError).slice(0, 500),
    );
    throw lastError instanceof AppError
      ? lastError
      : err.ai('AI_PROVIDER_ERROR', String(lastError?.message || lastError));
  }

  /**
   * Usage log (§28). A logging failure must never turn a completed AI call
   * into an error the caller has to handle.
   */
  async _log(userId, purpose, model, ms, error = null) {
    try {
      await this.db.run(
        'INSERT INTO ai_call_log(user_id, purpose, model, ok, ms, error) VALUES(?,?,?,?,?,?)',
        userId, purpose, model, error ? 0 : 1, ms, error,
      );
    } catch (e) {
      log.warn('ai call log write failed', { message: e?.message });
    }
  }

  /** Structured variant: asks for JSON and validates the parsed shape. */
  async completeJson(userId, purpose, { system, prompt, validate, maxRetries = 2, timeoutMs } = {}) {
    const askJson = `${prompt}\n\nRespond with a single valid JSON value and no other text.`;
    const out = await this.complete(userId, purpose, { system, prompt: askJson, maxRetries, timeoutMs });
    const parsed = extractJson(out.text);
    if (parsed === null || parsed === undefined) {
      throw err.ai('AI_INVALID_OUTPUT', `The AI response for "${purpose}" was not valid JSON.`);
    }
    if (typeof validate === 'function') {
      const checked = validate(parsed);
      if (checked !== true) {
        throw err.ai('AI_INVALID_OUTPUT', `The AI response for "${purpose}" failed validation.`, checked);
      }
    }
    return { data: parsed, model: out.model, attempts: out.attempts };
  }

  /** Runtime diagnostics for the Settings screen (no credentials included). */
  async diagnose({ refresh = false } = {}) {
    const described = this.transport.describe ? this.transport.describe() : {};
    const out = {
      transport: described.kind || 'unknown',
      bin: described.bin ?? null,
      baseUrl: described.baseUrl ?? null,
      ok: false, version: null, modelCount: 0, sample: [], error: null,
    };
    try {
      out.version = await this.transport.version();
      const models = await this.catalog({ refresh });
      out.ok = true;
      out.modelCount = models.length;
      out.sample = models.slice(0, 8).map((m) => m.id);
      out.providers = [...new Set(models.map((m) => m.provider))];
    } catch (e) {
      out.error = e.message;
      try { out.providerList = (await this.transport.listProviders()).slice(0, 2000); } catch { /* best effort */ }
    }
    return out;
  }
}

export default AIRuntime;