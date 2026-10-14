import config from '../config.js';

/**
 * §12 "basic performance indicators where safely measurable".
 *
 * The public PageSpeed Insights API. It works without a key at community rate
 * limits; a `PAGESPEED_API_KEY` only raises the quota. Never a paid provider
 * requirement, so a fresh deployment records real performance evidence.
 */

export function buildPagespeedUrl(url, {
  strategy = config.research.pagespeed.strategy,
  apiKey = config.research.pagespeed.apiKey,
  baseUrl = config.research.pagespeed.baseUrl,
} = {}) {
  const params = new URLSearchParams();
  params.set('url', url);
  params.set('strategy', strategy);
  for (const category of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) {
    params.append('category', category);
  }
  if (apiKey) params.set('key', apiKey);
  return `${baseUrl}/runPagespeed?${params.toString()}`;
}

/**
 * Extract the rendered screenshot PageSpeed captured during its audit, when it
 * produced one. `final-screenshot` holds the full-page image; the last
 * `screenshot-thumbnails` frame is the fallback. The data URI is returned only
 * when it fits the configured cap so one page cannot bloat the evidence store.
 */
export function extractPagespeedScreenshot(lighthouse, { maxBytes = Infinity } = {}) {
  const audits = lighthouse?.audits || {};
  const candidates = [
    audits['final-screenshot']?.details,
    audits['full-page-screenshot']?.details?.screenshot,
    (audits['screenshot-thumbnails']?.details?.items || []).slice(-1)[0],
  ].filter(Boolean);
  for (const c of candidates) {
    const dataUri = typeof c === 'string' ? c : c?.data;
    if (typeof dataUri === 'string' && /^data:image\//.test(dataUri)) {
      if (dataUri.length > maxBytes) return { dataUri: null, truncated: true, bytes: dataUri.length };
      return { dataUri, width: c?.width ?? null, height: c?.height ?? null, bytes: dataUri.length };
    }
  }
  return null;
}

/** Turn a raw PageSpeed response into a compact, stable evidence object. */
export function parsePagespeed(json, {
  strategy = 'mobile',
  captureScreenshot = config.research.pagespeed.captureScreenshot,
  maxScreenshotBytes = config.research.pagespeed.maxScreenshotBytes,
} = {}) {
  const lr = json?.lighthouseResult || {};
  const categories = lr.categories || {};
  const audits = lr.audits || {};
  const score = (id) => (categories[id] && typeof categories[id].score === 'number')
    ? Math.round(categories[id].score * 100) : null;
  const display = (id) => audits[id]?.displayValue ?? null;
  const shot = captureScreenshot ? extractPagespeedScreenshot(lr, { maxBytes: maxScreenshotBytes }) : null;
  return {
    ok: true,
    strategy,
    finalUrl: lr.finalUrl || json?.id || null,
    fetchTime: lr.fetchTime || null,
    scores: {
      performance: score('performance'),
      accessibility: score('accessibility'),
      bestPractices: score('best-practices'),
      seo: score('seo'),
    },
    vitals: {
      firstContentfulPaint: display('first-contentful-paint'),
      largestContentfulPaint: display('largest-contentful-paint'),
      cumulativeLayoutShift: display('cumulative-layout-shift'),
      totalBlockingTime: display('total-blocking-time'),
      speedIndex: display('speed-index'),
    },
    // Visual evidence (§12): a real rendered image, not an interpretation.
    screenshot: shot,
    hasRenderedScreenshot: Boolean(shot?.dataUri),
    fieldDataAvailable: Boolean(
      json?.loadingExperience?.metrics && Object.keys(json.loadingExperience.metrics).length,
    ),
    method: 'pagespeed_insights_lighthouse',
  };
}

/**
 * Run a rendered audit. Never throws for an expected provider/network failure:
 * returns `{ ok:false, error, code }` so the research pass stays in control of
 * what is recorded.
 */
export async function runPagespeed(url, {
  strategy = config.research.pagespeed.strategy,
  apiKey = config.research.pagespeed.apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = config.research.pagespeed.timeoutMs,
  baseUrl = config.research.pagespeed.baseUrl,
  captureScreenshot = config.research.pagespeed.captureScreenshot,
  maxScreenshotBytes = config.research.pagespeed.maxScreenshotBytes,
} = {}) {
  const endpoint = buildPagespeedUrl({ url, strategy, apiKey, baseUrl });
  let res;
  try {
    res = await fetchImpl(endpoint, { signal: signal(timeoutMs) });
  } catch (e) {
    return { ok: false, strategy, error: e.message, code: 'PAGESPEED_UNREACHABLE' };
  }

  let text;
  try { text = await res.text(); } catch { text = ''; }
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }

  if (!res.ok) {
    return {
      ok: false, strategy, code: 'PAGESPEED_HTTP_ERROR',
      error: json?.error?.message || `PageSpeed returned ${res.status}`,
    };
  }
  if (!json?.lighthouseResult) {
    return {
      ok: false, strategy, code: 'PAGESPEED_NO_RESULT',
      error: json?.error?.message || 'PageSpeed returned no Lighthouse result.',
    };
  }
  return parsePagespeed(json, { strategy, captureScreenshot, maxScreenshotBytes });
}

const signal = (ms) => (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(ms) : undefined);

export default runPagespeed;
