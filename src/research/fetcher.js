import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import config from '../config.js';

const log = createLogger('research');

/** Last request time per host, so we never hammer one site (spec §24). */
const lastRequestAt = new Map();
const robotsCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-host politeness delay before issuing a request. */
async function throttle(host) {
  const last = lastRequestAt.get(host) || 0;
  const wait = config.research.fetchDelayMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(host, Date.now());
}

/**
 * Minimal robots.txt parser supporting User-agent groups, Allow and Disallow.
 * Returns a matcher for the given user agent, or null when robots.txt is
 * absent (which is not a prohibition).
 */
export function parseRobots(text, agentToken = 'nexora') {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow') current.allow.push(value);
    else if (field === 'disallow') current.disallow.push(value);
  }

  const matching = groups.find((g) => g.agents.some((a) => agentToken && a.includes(agentToken)))
    || groups.find((g) => g.agents.includes('*'));

  if (!matching) return null;

  return function isAllowed(pathname) {
    const matches = (rules) => rules.some((r) => r && pathname.startsWith(r));
    // Disallow wins ties, matching the widely used precedence rule.
    const disallowed = matches(matching.disallow);
    if (!disallowed) return true;
    const allowed = matches(matching.allow);
    if (!allowed) return false;
    return matching.allow
      .filter((r) => pathname.startsWith(r))
      .sort((a, b) => b.length - a.length)[0].length
      >= matching.disallow
        .filter((r) => pathname.startsWith(r))
        .sort((a, b) => b.length - a.length)[0].length;
  };
}

/** Fetch and cache robots.txt for an origin. Failures mean "no restrictions". */
async function isAllowed(url) {
  if (!config.research.respectRobots) return true;
  const target = new URL(url);
  const origin = `${target.protocol}//${target.host}`;
  let matcher = robotsCache.get(origin);

  if (matcher === undefined) {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': config.research.userAgent },
        signal: AbortSignal.timeout(config.research.timeoutMs),
      });
      matcher = res.ok ? parseRobots(await res.text()) : null;
    } catch (e) {
      log.debug(`robots.txt unavailable for ${origin}: ${e.message}`);
      matcher = null;
    }
    robotsCache.set(origin, matcher);
  }
  if (!matcher) return true;
  return matcher(target.pathname + target.search);
}

/**
 * Fetch a URL politely: robots check, per-host throttle, timeout and a hard
 * byte cap. Never attempts authentication or bypasses access controls (§24).
 */
export async function fetchUrl(url, { accept = 'text/html,application/xhtml+xml' } = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw err.browser('UNSUPPORTED_SCHEME', `Refusing to fetch ${target.protocol} URL.`);
  }

  if (!(await isAllowed(url))) {
    log.info(`robots.txt disallows ${target.pathname}`);
    throw err.browser('ROBOTS_DISALLOWED', 'The site asks automated tools not to fetch this path.');
  }

  await throttle(target.host);

  const res = await fetch(url, {
    headers: { 'User-Agent': config.research.userAgent, Accept: accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(config.research.timeoutMs),
  }).catch((e) => {
    throw err.browser('NETWORK', `Request to ${target.host} failed: ${e.message}`);
  });

  if (res.status === 401 || res.status === 403) {
    // Access-controlled: recorded, never worked around (spec §24).
    throw err.browser('ACCESS_DENIED', `${target.host} returned ${res.status} for this path.`);
  }
  if (res.status === 404 || res.status === 410) {
    throw err.browser('NOT_FOUND', `${target.host} returned ${res.status}.`);
  }
  if (res.status === 429) {
    throw err.browser('HTTP_429', `${target.host} is rate limiting.`);
  }
  if (res.status >= 500) {
    throw err.browser('HTTP_5XX', `${target.host} returned ${res.status}.`);
  }
  if (!res.ok) {
    throw err.browser('HTTP_ERROR', `${target.host} returned ${res.status}.`);
  }

  const buffer = await readCapped(res);
  return {
    url: res.url,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    body: buffer.toString('utf8'),
    bytes: buffer.byteLength,
  };
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.text());
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > config.research.maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function __clearCaches() {
  lastRequestAt.clear();
  robotsCache.clear();
}