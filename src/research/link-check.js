import config from '../config.js';
import { createLogger } from '../core/logger.js';
import { robotsAllows } from './fetcher.js';

const log = createLogger('research');

const SKIP_SCHEME = /^(mailto:|tel:|javascript:|data:|blob:|sms:|ftp:)/i;

/**
 * §12 "broken links/pages where detectable".
 *
 * Only the site's OWN links are probed: off-site links belong to third parties
 * and hitting them would be impolite and out of scope (§24). The result is a
 * measurement — which same-origin links do not resolve — not a judgement.
 */

/** Absolute, de-duplicated, same-origin links present in the markup. */
export function internalLinks(html, baseUrl, { limit = 40 } = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || SKIP_SCHEME.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, base); } catch { continue; }
    if (abs.origin !== base.origin || !/^https?:$/.test(abs.protocol)) continue;
    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Probe a bounded sample of the site's own links and record the broken ones.
 * Best-effort throughout: a network error probing one link is reported, never
 * thrown, so a single flaky page cannot fail the research pass.
 */
export async function checkLinks(html, baseUrl, {
  fetchImpl = globalThis.fetch,
  maxLinks = config.research.linkCheck.maxLinks,
  timeoutMs = config.research.linkCheck.timeoutMs,
  userAgent = config.research.userAgent,
  robotsCheck = robotsAllows,
} = {}) {
  const links = internalLinks(html, baseUrl, { limit: maxLinks });
  const broken = [];
  const unreachable = [];
  let checked = 0;

  for (const url of links) {
    try {
      if (!(await robotsCheck(url))) continue;
    } catch { /* a robots lookup failure must never block the probe */ }
    checked++;
    const status = await probe(url, { fetchImpl, timeoutMs, userAgent });
    if (status === null) unreachable.push({ url });
    else if (status >= 400) broken.push({ url, status });
  }

  return {
    checked,
    brokenCount: broken.length,
    unreachableCount: unreachable.length,
    broken: broken.slice(0, 10),
    unreachable: unreachable.slice(0, 10),
    method: 'http_link_probe_without_javascript',
  };
}

const signal = (ms) => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

/** HEAD, falling back to a ranged GET for servers that reject HEAD. */
async function probe(url, { fetchImpl, timeoutMs, userAgent }) {
  try {
    const head = await fetchImpl(url, {
      method: 'HEAD', redirect: 'follow',
      headers: { 'User-Agent': userAgent }, signal: signal(timeoutMs),
    });
    if (head.status !== 405 && head.status !== 501) return head.status;
  } catch { /* fall through to GET */ }
  try {
    const get = await fetchImpl(url, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': userAgent, Range: 'bytes=0-0' }, signal: signal(timeoutMs),
    });
    return get.status;
  } catch (e) {
    log.info(`link probe failed for ${url}: ${e.message}`);
    return null;
  }
}

export default checkLinks;
