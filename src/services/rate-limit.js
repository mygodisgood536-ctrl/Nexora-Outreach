import { sqliteUtc } from '../core/time.js';

/** Failed-attempt tracking used for rate limiting and progressive lockout. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function registerAttempt(db, usernameLower, ok) {
  db.run('INSERT INTO login_attempts(username_lower, ok) VALUES(?,?)', usernameLower, ok ? 1 : 0);
  const since = sqliteUtc(new Date(Date.now() - FAILURE_WINDOW_MS));
  db.run('DELETE FROM login_attempts WHERE username_lower = ? AND at < ?', usernameLower, since);
}

export function recentFailures(db, usernameLower) {
  const since = sqliteUtc(new Date(Date.now() - FAILURE_WINDOW_MS));
  const row = db.get(
    'SELECT COUNT(*) n FROM login_attempts WHERE username_lower = ? AND ok = 0 AND at >= ?',
    usernameLower, since
  );
  return row?.n || 0;
}

export function clearFailures(db, userId) {
  db.run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', userId);
}

/** Minutes to lock for after `failures` recent failures. */
export function lockMinutesFor(failures, schedule) {
  return schedule[Math.min(failures, schedule.length - 1)] ?? 0;
}