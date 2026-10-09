import { err } from '../core/errors.js';
import { sqliteUtc } from '../core/time.js';

/** Failed-attempt tracking used for rate limiting and progressive lockout. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export async function registerAttempt(db, usernameLower, ok) {
  await db.run('INSERT INTO login_attempts(username_lower, ok) VALUES(?,?)', usernameLower, ok ? 1 : 0);
  const since = sqliteUtc(new Date(Date.now() - FAILURE_WINDOW_MS));
  await db.run('DELETE FROM login_attempts WHERE username_lower = ? AND at < ?', usernameLower, since);
}

export async function recentFailures(db, usernameLower) {
  const since = sqliteUtc(new Date(Date.now() - FAILURE_WINDOW_MS));
  const row = await db.get(
    'SELECT COUNT(*) n FROM login_attempts WHERE username_lower = ? AND ok = 0 AND at >= ?',
    usernameLower, since,
  );
  return row?.n || 0;
}

export async function clearFailures(db, usernameLower) {
  await db.run('DELETE FROM login_attempts WHERE username_lower = ? AND ok = 0', usernameLower);
}

/** Minutes to lock for after `failures` recent failures. */
export function lockMinutesFor(failures, schedule) {
  return schedule[Math.min(failures, schedule.length - 1)] ?? 0;
}

/**
 * Fixed-window rate limiter for unauthenticated endpoints (spec §5.3 "Rate
 * limiting and progressive lockout").
 *
 * Backed by `api_rate_limits` so the counter is shared across processes —
 * serverless instances must not each get their own budget for the same key.
 * The whole read-modify-write is a single atomic upsert, so concurrent
 * requests cannot exceed the limit by racing.
 *
 * Returns `{ allowed, remaining, resetAtMs }` — callers decide whether to
 * reject or merely observe.
 */
export async function rateLimit(db, key, { limit, windowMs }) {
  const now = Date.now();
  const threshold = now - windowMs;
  const row = await db.get(
    `INSERT INTO api_rate_limits(key, window_start_ms, count, updated_at)
          VALUES(?,?,1,datetime('now'))
     ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN api_rate_limits.window_start_ms <= ? THEN api_rate_limits.count + 1 ELSE 1 END,
          window_start_ms = CASE WHEN api_rate_limits.window_start_ms <= ? THEN api_rate_limits.window_start_ms ELSE ? END,
          updated_at = datetime('now')
     RETURNING count, window_start_ms`,
    key, now, threshold, threshold, now,
  );
  const count = row?.count ?? 1;
  const start = row?.window_start_ms ?? now;
  return {
    allowed: count <= limit,
    count,
    remaining: Math.max(0, limit - count),
    resetAtMs: start + windowMs,
  };
}

/** Reject with 429 when the budget is exhausted. */
export async function enforceRateLimit(db, key, options) {
  const result = await rateLimit(db, key, options);
  if (!result.allowed) {
    const waitSec = Math.max(1, Math.ceil((result.resetAtMs - Date.now()) / 1000));
    throw err.tooManyRequests(`Too many requests. Try again in ${waitSec} second(s).`);
  }
  return result;
}

/** Drop a counter — used after a successful authentication. */
export async function resetRateLimit(db, key) {
  await db.run('DELETE FROM api_rate_limits WHERE key = ?', key);
}

export default rateLimit;
