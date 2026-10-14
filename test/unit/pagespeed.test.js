import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPagespeedUrl, parsePagespeed, runPagespeed, extractPagespeedScreenshot,
} from '../../src/research/pagespeed.js';

const RESPONSE = {
  id: 'https://abcrestaurant.com/',
  loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2400 } } },
  lighthouseResult: {
    finalUrl: 'https://abcrestaurant.com/',
    fetchTime: '2026-01-01T00:00:00.000Z',
    categories: {
      performance: { score: 0.38 },
      accessibility: { score: 0.9 },
      'best-practices': { score: 0.83 },
      seo: { score: 0.92 },
    },
    audits: {
      'largest-contentful-paint': { displayValue: '2.4 s' },
      'cumulative-layout-shift': { displayValue: '0.02' },
      'total-blocking-time': { displayValue: '310 ms' },
      'first-contentful-paint': { displayValue: '1.1 s' },
      'speed-index': { displayValue: '3.2 s' },
      'final-screenshot': { details: { data: 'data:image/jpeg;base64,AAAA' } },
    },
  },
};

test('pagespeed: the request URL is keyless by default and requests all categories', () => {
  const url = buildPagespeedUrl('https://abcrestaurant.com/', {
    strategy: 'mobile', apiKey: '', baseUrl: 'https://www.googleapis.com/pagespeedonline/v5',
  });
  assert.match(url, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?/);
  assert.ok(url.includes('strategy=mobile'));
  for (const c of ['PERFORMANCE', 'ACCESSIBILITY', 'BEST_PRACTICES', 'SEO']) {
    assert.ok(url.includes(`category=${c}`), `requests ${c}`);
  }
  assert.ok(!url.includes('key='), 'works with no API key at all');
});

test('pagespeed: an API key is added when configured', () => {
  const url = buildPagespeedUrl('https://x.test/', { apiKey: 'abc123' });
  assert.ok(url.includes('key=abc123'));
});

test('pagespeed: parses scores, vitals, screenshot and field data', () => {
  const e = parsePagespeed(RESPONSE, { strategy: 'mobile' });
  assert.equal(e.ok, true);
  assert.equal(e.scores.performance, 38);
  assert.equal(e.scores.accessibility, 90);
  assert.equal(e.scores.bestPractices, 83);
  assert.equal(e.scores.seo, 92);
  assert.equal(e.vitals.largestContentfulPaint, '2.4 s');
  assert.equal(e.hasRenderedScreenshot, true);
  assert.equal(e.fieldDataAvailable, true);
  assert.equal(e.method, 'pagespeed_insights_lighthouse');
  // §12 visual evidence: the rendered screenshot is captured, not just a flag.
  assert.equal(e.screenshot.dataUri, 'data:image/jpeg;base64,AAAA');
});

test('pagespeed: the screenshot is withheld when it exceeds the size cap', () => {
  const lighthouse = {
    audits: { 'final-screenshot': { details: { data: `data:image/png;base64,${'A'.repeat(500)}` } } },
  };
  const shot = extractPagespeedScreenshot(lighthouse, { maxBytes: 100 });
  assert.equal(shot.dataUri, null);
  assert.equal(shot.truncated, true);
  const e = parsePagespeed(RESPONSE, { maxScreenshotBytes: 5 });
  assert.equal(e.hasRenderedScreenshot, false);
});

test('pagespeed: capture can be switched off entirely', () => {
  const e = parsePagespeed(RESPONSE, { captureScreenshot: false });
  assert.equal(e.screenshot, null);
  assert.equal(e.hasRenderedScreenshot, false);
});

test('pagespeed: a provider error is reported, never thrown', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 429,
    text: async () => JSON.stringify({ error: { message: 'quota exceeded' } }),
  });
  const e = await runPagespeed('https://x.test/', { fetchImpl });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'PAGESPEED_HTTP_ERROR');
  assert.match(e.error, /quota/);
});

test('pagespeed: a network failure is reported, never thrown', async () => {
  const fetchImpl = async () => { throw new Error('connect timeout'); };
  const e = await runPagespeed('https://x.test/', { fetchImpl });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'PAGESPEED_UNREACHABLE');
});

test('pagespeed: a successful response round-trips through runPagespeed', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(RESPONSE) });
  const e = await runPagespeed('https://abcrestaurant.com/', { fetchImpl });
  assert.equal(e.ok, true);
  assert.equal(e.scores.performance, 38);
});
