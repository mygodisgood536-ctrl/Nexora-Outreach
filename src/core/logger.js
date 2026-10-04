/**
 * Structured logging. Spec §30 requires detailed developer logs while the UI
 * stays user-friendly — so logs go to stdout/stderr with levels, never into
 * the frontend.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info')).toLowerCase()] ?? 20;

function emit(level, scope, message, extra) {
  if (LEVELS[level] < current) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const stream = LEVELS[level] >= LEVELS.error ? process.stderr : process.stdout;
  stream.write(extra === undefined ? `${line}\n` : `${line} ${safeJson(extra)}\n`);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return String(value);
  }
}

/** Never log secrets, even by accident. */
const SECRET_KEYS = /^(password|answer|access_token|refresh_token|id_token|client_secret|token|authorization|cookie)$/i;
function replacer(_key, value) {
  if (_key && SECRET_KEYS.test(_key)) return '[redacted]';
  return value;
}

export function createLogger(scope) {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('nexora');
export { safeJson };