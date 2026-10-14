import test from 'node:test';
import assert from 'node:assert/strict';

import { internalLinks, checkLinks } from '../../src/research/link-check.js';

const SITE = `<!DOCTYPE html><html><body>
  <a href="/">Home</a>
  <a href="/menu">Menu</a>
  <a href="/menu">Menu again</a>
  <a href="/reservations?x=1#top">Book</a>
  <a href="https://external.example/partner">Partner</a>
  <a href="mailto:hi@abcrestaurant.com">Email</a>
  <a href="tel:+15125550100">Call</a>
  <a href="#anchor">Jump</a>
  <a href="javascript:void(0)">Nope</a>
  <a href="relative/page">Relative</a>
</body></html>`;

test('link-check: collects only de-duplicated same-origin links', () => {
  const links = internalLinks(SITE, 'https://abcrestaurant.com/');
  assert.ok(links.includes('https://abcrestaurant.com/menu'));
  assert.ok(links.includes('https://abcrestaurant.com/reservations?x=1'));
  assert.ok(links.includes('https://abcrestaurant.com/relative/page'));
  // Off-site, mailto, tel, anchors and javascript: are never probed.
  assert.ok(!links.some((u) => u.includes('external.example')));
  assert.ok(!links.some((u) => u.startsWith('mailto:') || u.startsWith('tel:')));
  // The duplicate /menu appears once.
  assert.equal(links.filter((u) => u.endsWith('/menu')).length, 1);
});

test('link-check: reports broken same-origin links as measurements', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method });
    if (url.endsWith('/menu')) return { status: 404 };
    return { status: 200 };
  };
  const result = await checkLinks(SITE, 'https://abcrestaurant.com/', {
    fetchImpl, robotsCheck: async () => true,
  });
  assert.equal(result.brokenCount, 1);
  assert.equal(result.broken[0].url, 'https://abcrestaurant.com/menu');
  assert.equal(result.broken[0].status, 404);
  assert.equal(result.method, 'http_link_probe_without_javascript');
  assert.ok(calls.every((c) => c.method === 'HEAD'), 'uses HEAD first');
});

test('link-check: falls back to a ranged GET when HEAD is rejected', async () => {
  const methods = [];
  const fetchImpl = async (url, opts) => {
    methods.push(opts.method);
    if (opts.method === 'HEAD') return { status: 405 };
    return { status: 200 };
  };
  const result = await checkLinks('<a href="/menu">M</a>', 'https://x.test/', {
    fetchImpl, robotsCheck: async () => true,
  });
  assert.deepEqual(methods, ['HEAD', 'GET']);
  assert.equal(result.brokenCount, 0);
});

test('link-check: a robots disallow skips the link and a network error is not broken', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const result = await checkLinks(
    '<a href="/denied">D</a><a href="/offline">O</a>',
    'https://x.test/',
    { fetchImpl, robotsCheck: async (url) => !url.endsWith('/denied') },
  );
  assert.equal(result.checked, 1, 'the disallowed link was skipped');
  assert.equal(result.brokenCount, 0);
  assert.equal(result.unreachableCount, 1);
});
