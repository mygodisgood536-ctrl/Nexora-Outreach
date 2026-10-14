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
  'AI_MODEL_UNAVAILABLE',
  // The provider refused the request because the workspace is out of credits or
  // quota. Retrying cannot succeed until the account is topped up, so it must
  // not be hammered by the retry loop (spec §30).
  'AI_CREDITS_EXHAUSTED',
  'NOT_QUALIFIED',
  'NO_CONTACT_ROUTE',
  'MAILBOX_NOT_CONNECTED',
  'MAILBOX_AUTH_EXPIRED',
  'RATE_LIMITED_PERMANENT',
  // A campaign whose end date has passed must not be retried; the mission is
  // simply finished (spec §10).
  'CAMPAIGN_ENDED',
  // An exhausted API rate budget must not be hammered by the retry loop; the
  // limiter's own window already defines when it becomes eligible again.
  'RATE_LIMITED',
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
  // Sending-limit pauses are transient: the window resets and the job retries.
  'HOURLY_LIMIT_REACHED',
  'PACING_WAIT',
  'CAMPAIGN_NOT_STARTED',
  'RECIPIENT_COOLDOWN',
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
  tooManyRequests: (msg = 'Too many requests') => new AppError('RATE_LIMITED', msg, { kind: ERROR_KIND.AUTH, status: 429 }),
  notConfigured: (msg = 'This integration is not configured yet') => new AppError('NOT_CONFIGURED', msg, { status: 501 }),
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
      case 'AI_MODEL_UNAVAILABLE': return 'The selected AI model is not available to this workspace. Choose another model in Settings.';
      case 'AI_CREDITS_EXHAUSTED': return 'The AI provider ran out of credits or quota for this workspace.';
      case 'AI_INVALID_OUTPUT': return 'The AI returned a response that could not be used. This step needs a retry after the prompt is reviewed.';
      case 'AI_TIMEOUT': return 'The AI step timed out and will be retried.';
      case 'TIMEOUT': return 'A network request timed out.';
      case 'HTTP_429': return 'A provider rate limit was reached. Work will resume automatically.';
      case 'DAILY_LIMIT_REACHED': return 'The daily sending limit is reached. Sending resumes tomorrow.';
      case 'HOURLY_LIMIT_REACHED': return 'The hourly sending limit is reached. Sending pauses and resumes shortly.';
      case 'PACING_WAIT': return 'Pacing delay between messages is in effect. Sending resumes shortly.';
      case 'CAMPAIGN_NOT_STARTED': return 'This campaign has not reached its start date yet.';
      case 'CAMPAIGN_ENDED': return 'This campaign\'s end date has passed, so nothing was sent.';
      case 'RECIPIENT_COOLDOWN': return 'This recipient was contacted recently; the cooldown prevents over-contacting them.';
      case 'DISCOVERY_HTTP_ERROR': return 'The discovery source is busy or rate limiting. This run will retry automatically.';
      case 'DISCOVERY_QUERY_REJECTED': return 'The discovery query was rejected. Check the mission location and try again.';
      case 'HTTP_403': return 'Access was refused by the remote host.';
      default: return error.message;
    }
  }
  return 'An unexpected error occurred.';
}

/**
 * Operator-facing explanation of a failure (spec §30): what failed, why, what it
 * affected, and whether retrying is safe. Computed server-side so the API never
 * has to leak internals to the browser and every surface explains failures the
 * same way.
 */
const FAILURE_GUIDANCE = {
  AI_CREDITS_EXHAUSTED: {
    title: 'AI credits exhausted',
    detail: 'The AI provider rejected this step because the workspace has no credits or quota left.',
    action: 'Add credits or raise the quota with the AI provider, then retry this job.',
  },
  AI_MODEL_UNAVAILABLE: {
    title: 'AI model unavailable',
    detail: 'The selected AI model is disabled or not permitted for this workspace.',
    action: 'Choose another model in Control → AI, then retry.',
  },
  AI_INVALID_OUTPUT: {
    title: 'Unusable AI output',
    detail: 'The AI returned output that failed validation, so nothing was recorded.',
    action: 'Retry the job; if it keeps failing, simplify the mission instructions.',
  },
  AI_PROVIDER_ERROR: {
    title: 'AI provider error',
    detail: 'The AI provider could not complete the request.',
    action: 'This retries automatically with bounded backoff.',
  },
  AI_TIMEOUT: {
    title: 'AI step timed out',
    detail: 'The AI provider did not answer within the time budget.',
    action: 'This retries automatically with bounded backoff.',
  },
  UNAUTHENTICATED: {
    title: 'AI key rejected',
    detail: 'The OpenCode Cloud service-account key was rejected.',
    action: 'Update OPENCODE_API_KEY, then retry.',
  },
  MAILBOX_NOT_CONNECTED: {
    title: 'Mailbox not connected',
    detail: 'No authorized mailbox is connected, so nothing could be sent.',
    action: 'Connect an authorized mailbox, then retry.',
  },
  MAILBOX_AUTH_EXPIRED: {
    title: 'Mailbox authorization expired',
    detail: 'The mailbox token is no longer valid, so sending stopped.',
    action: 'Reconnect the mailbox, then retry.',
  },
  SUPPRESSED: {
    title: 'Recipient suppressed',
    detail: 'This recipient opted out, bounced, or complained, so nothing was sent.',
    action: 'Retry is not safe — do not contact this recipient again.',
  },
  DUPLICATE: {
    title: 'Already contacted',
    detail: 'This business was already contacted, so it was skipped.',
    action: 'Retry is not needed.',
  },
  NO_CONTACT_ROUTE: {
    title: 'No contact route',
    detail: 'No verified public contact route was found for this business.',
    action: 'Record a public contact route, then retry.',
  },
  NOT_QUALIFIED: {
    title: 'Not qualified',
    detail: 'The evidence did not support a contactable opportunity for this business.',
    action: 'Retry is not safe — this business is intentionally excluded.',
  },
  HOURLY_LIMIT_REACHED: {
    title: 'Hourly sending limit reached',
    detail: 'The mission reached its hourly send cap.',
    action: 'Sending resumes automatically when the window resets.',
  },
  PACING_WAIT: {
    title: 'Pacing delay',
    detail: 'A minimum gap between sends is in effect.',
    action: 'Sending resumes automatically.',
  },
  CAMPAIGN_NOT_STARTED: {
    title: 'Campaign not started',
    detail: 'The campaign start date has not been reached yet.',
    action: 'Sending begins automatically on the start date.',
  },
  CAMPAIGN_ENDED: {
    title: 'Campaign ended',
    detail: 'The campaign end date has passed.',
    action: 'Retry is not safe; extend the end date to resume.',
  },
  RECIPIENT_COOLDOWN: {
    title: 'Recipient cooldown',
    detail: 'This recipient was contacted too recently.',
    action: 'Sending resumes automatically after the cooldown.',
  },
  DISCOVERY_HTTP_ERROR: {
    title: 'Discovery source unavailable',
    detail: 'The discovery source is busy or rate limiting.',
    action: 'This retries automatically.',
  },
  DISCOVERY_TIMEOUT: {
    title: 'Discovery source timed out',
    detail: 'The discovery source did not answer in time.',
    action: 'This retries automatically.',
  },
  HTTP_429: {
    title: 'Provider rate limit',
    detail: 'A provider rate limit was reached.',
    action: 'This retries automatically.',
  },
};

/** Failures where retrying would be wrong, not merely unlikely to help. */
const RETRY_UNSAFE = new Set(['SUPPRESSED', 'DUPLICATE', 'NOT_QUALIFIED', 'NO_CONTACT_ROUTE', 'CAMPAIGN_ENDED']);

export function describeFailure(code, { kind = null, retryable = null } = {}) {
  if (!code) return null;
  const guidance = FAILURE_GUIDANCE[code] || {};
  const isRetryable = typeof retryable === 'boolean'
    ? retryable
    : (TRANSIENT.has(code) && !PERMANENT.has(code));
  return {
    code,
    kind,
    retryable: isRetryable,
    retrySafe: !RETRY_UNSAFE.has(code),
    title: guidance.title
      || String(code).replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
    detail: guidance.detail
      || userFacingMessage(new AppError(code, ''))
      || `The step failed (${code}).`,
    action: guidance.action || (isRetryable
      ? 'This will be retried automatically.'
      : 'Resolve the cause, then retry the job.'),
  };
}