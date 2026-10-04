/**
 * Error taxonomy. Spec §30 requires browser, AI, email, qualification and
 * discovery failures to be separated so the UI can explain what went wrong
 * and so retries can be classified (transient vs permanent).
 */
export const ERROR_KIND = {
  DISCOVERY: 'discovery',
  BROWSER: 'browser',
  AI: 'ai',
  EMAIL: 'email',
  QUALIFICATION: 'qualification',
  AUTH: 'auth',
  VALIDATION: 'validation',
  SYSTEM: 'system',
};

/** Permanent failures must not be retried forever (spec §30). */
const PERMANENT = new Set([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'SUPPRESSED',
  'DUPLICATE',
  'AI_INVALID_OUTPUT',
  'NOT_QUALIFIED',
  'NO_CONTACT_ROUTE',
  'MAILBOX_NOT_CONNECTED',
  'MAILBOX_AUTH_EXPIRED',
  'RATE_LIMITED_PERMANENT',
]);

/** Transient failures are retried with bounded backoff. */
const TRANSIENT = new Set([
  'TIMEOUT',
  'NETWORK',
  'HTTP_5XX',
  'HTTP_429',
  'AI_TIMEOUT',
  'AI_PROVIDER_ERROR',
  'PROVIDER_TEMPORARY',
  'LOCKED',
  // A discovery source rate-limiting or timing out is transient; the job
  // should back off and try again rather than fail permanently.
  'DISCOVERY_HTTP_ERROR',
  'DISCOVERY_TIMEOUT',
]);

export class AppError extends Error {
  constructor(code, message, { kind = ERROR_KIND.SYSTEM, status = 400, detail = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    if (cause) this.cause = cause;
  }

  get transient() { return TRANSIENT.has(this.code); }
  get permanent() { return PERMANENT.has(this.code); }
  get retryable() { return this.transient && !this.permanent; }

  toJSON() {
    return { error: this.code, message: this.message, kind: this.kind, detail: this.detail };
  }
}

export const err = {
  validation: (msg, detail) => new AppError('VALIDATION_FAILED', msg, { kind: ERROR_KIND.VALIDATION, status: 422, detail }),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`, { status: 404 }),
  unauthorized: (msg = 'Authentication required') => new AppError('UNAUTHENTICATED', msg, { kind: ERROR_KIND.AUTH, status: 401 }),
  forbidden: (msg = 'Not permitted') => new AppError('FORBIDDEN', msg, { kind: ERROR_KIND.AUTH, status: 403 }),
  conflict: (msg, code = 'DUPLICATE') => new AppError(code, msg, { status: 409 }),
  locked: (msg) => new AppError('LOCKED', msg, { kind: ERROR_KIND.AUTH, status: 423 }),
  timeout: (msg = 'Operation timed out') => new AppError('TIMEOUT', msg, { kind: ERROR_KIND.SYSTEM, status: 504 }),
  network: (msg, cause) => new AppError('NETWORK', msg, { kind: ERROR_KIND.SYSTEM, status: 502, cause }),
  ai: (code, msg, detail) => new AppError(code, msg, { kind: ERROR_KIND.AI, status: 502, detail }),
  email: (code, msg, detail) => new AppError(code, msg, { kind: ERROR_KIND.EMAIL, status: 502, detail }),
  browser: (code, msg, detail) => new AppError(code, msg, { kind: ERROR_KIND.BROWSER, status: 502, detail }),
  discovery: (code, msg, detail) => new AppError(code, msg, { kind: ERROR_KIND.DISCOVERY, status: 502, detail }),
  suppressed: (msg = 'Recipient is suppressed') => new AppError('SUPPRESSED', msg, { kind: ERROR_KIND.EMAIL, status: 409 }),
};

/** User-facing text for a job failure (spec §30 "show user-friendly errors"). */
export function userFacingMessage(error) {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'MAILBOX_NOT_CONNECTED': return 'Your outreach mailbox is not connected.';
      case 'MAILBOX_AUTH_EXPIRED': return 'Your mailbox authorization expired. Reconnect it to resume sending.';
      case 'SUPPRESSED': return 'This recipient opted out or is suppressed, so nothing was sent.';
      case 'DUPLICATE': return 'This business was already contacted, so it was skipped.';
      case 'NO_CONTACT_ROUTE': return 'No verified public contact route was found for this business.';
      case 'AI_PROVIDER_ERROR': return 'The AI provider could not complete this step. It will retry automatically.';
      case 'AI_TIMEOUT': return 'The AI step timed out and will be retried.';
      case 'TIMEOUT': return 'A network request timed out.';
      case 'HTTP_429': return 'A provider rate limit was reached. Work will resume automatically.';
      case 'DISCOVERY_HTTP_ERROR': return 'The discovery source is busy or rate limiting. This run will retry automatically.';
      case 'DISCOVERY_QUERY_REJECTED': return 'The discovery query was rejected. Check the mission location and try again.';
      case 'HTTP_403': return 'Access was refused by the remote host.';
      default: return error.message;
    }
  }
  return 'An unexpected error occurred.';
}