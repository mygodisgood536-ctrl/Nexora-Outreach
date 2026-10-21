import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverCandidates, normaliseSourceIds, DISCOVERY_SOURCES, DEFAULT_DISCOVERY_SOURCES } from '../../src/discovery/sources.js';
import { searchTerms } from '../../src/discovery/nominatim.js';
import { resolveBusinessTypes } from '../../src/discovery/overpass.js';
import { normalizeDomain } from '../../src/core/normalize.js';

/**
 * Spec §11 — discovery must be configurable per mission, by business type and
 * by source. These tests exercise the registry without a network round trip:
 * every source is replaced by a stub, exactly as the pipeline replaces the AI
 * and email transports.
 */

const stub = (results) => {
  const calls = [];
  return {
    calls,
    discover: async (args) => {
      calls.push(args);
      const outcome = results[args.keyword];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
};

test('discovery: the catalogue offers several permitted sources', () => {
  assert.ok(DISCOVERY_SOURCES.length >= 2, 'more than one source is available');
  for (const s of DISCOVERY_SOURCES) {
    assert.ok(s.id && s.label && s.description, `${s.id} is fully described`);
    assert.equal(typeof s.discover, 'function');
  }
  assert.deepEqual([...DEFAULT_DISCOVERY_SOURCES].sort(), DISCOVERY_SOURCES.map((s) => s.id).sort());
});

test('discovery: a mission chooses which sources run', async () => {
  const a = stub({ alpha: { area: 'Austin', candidates: [] } });
  const b = stub({ alpha: { area: 'Austin', candidates: [] } });
  const registry = DISCOVERY_SOURCES.map((s) => ({ ...s, discover: s.id === 'overpass' ? a.discover : b.discover }));

  // Swap the registry's implementations for this test only.
  const original = DISCOVERY_SOURCES.map((s) => s.discover);
  DISCOVERY_SOURCES.forEach((s, i) => { s.discover = registry[i].discover; });
  try {
    await discoverCandidates({
      country: 'US', city: 'Austin', types: [], keyword: 'alpha', sources: ['nominatim'],
    });
    assert.equal(a.calls.length, 0, 'the unconfigured source did not run');
    assert.equal(b.calls.length, 1, 'the configured source ran');
  } finally {
    DISCOVERY_SOURCES.forEach((s, i) => { s.discover = original[i]; });
  }
});

test('discovery: unknown or missing source ids fall back to the defaults', () => {
  assert.deepEqual(normaliseSourceIds(['overpass', 'nope']), ['overpass']);
  assert.deepEqual(normaliseSourceIds('overpass,nominatim'), ['overpass', 'nominatim']);
  assert.deepEqual(normaliseSourceIds([]), [...DEFAULT_DISCOVERY_SOURCES]);
  assert.deepEqual(normaliseSourceIds(null), [...DEFAULT_DISCOVERY_SOURCES]);
});

test('discovery: the same business from two sources becomes one candidate', async () => {
  const one = stub({
    x: { area: 'Austin', candidates: [{ name: 'ABC Restaurant', website: 'https://abc.example', source: 'a' }] },
  });
  const two = stub({
    x: {
      area: 'Austin',
      candidates: [
        { name: 'ABC RESTAURANT', website: 'http://www.abc.example/', email: 'hi@abc.example', source: 'b' },
        { name: 'Another Place', website: 'https://other.example', source: 'b' },
      ],
    },
  });
  const original = DISCOVERY_SOURCES.map((s) => s.discover);
  DISCOVERY_SOURCES[0].discover = one.discover;
  DISCOVERY_SOURCES[1].discover = two.discover;
  try {
    const { candidates, source } = await discoverCandidates({
      country: 'US', city: 'Austin', keyword: 'x', limit: 10,
    });
    assert.equal(source, 'overpass+nominatim');
    assert.equal(candidates.length, 2, 'the duplicate was merged, not duplicated');
    const abc = candidates.find((c) => normalizeDomain(c.website || '') === 'abc.example');
    assert.ok(abc, 'the merged business is present');
    assert.equal(abc.email, 'hi@abc.example', 'the merge kept the richer record');
  } finally {
    DISCOVERY_SOURCES.forEach((s, i) => { s.discover = original[i]; });
  }
});

test('discovery: one failing source does not lose the pass', async () => {
  const good = stub({ y: { area: 'Austin', candidates: [{ name: 'Survivor', website: 'https://ok.example' }] } });
  const bad = stub({ y: Object.assign(new Error('upstream down'), { code: 'DISCOVERY_SOURCE_ERROR' }) });
  const original = DISCOVERY_SOURCES.map((s) => s.discover);
  DISCOVERY_SOURCES[0].discover = bad.discover;
  DISCOVERY_SOURCES[1].discover = good.discover;
  try {
    const { candidates, sources } = await discoverCandidates({ country: 'US', city: 'Austin', keyword: 'y' });
    assert.deepEqual(sources, ['nominatim'], 'only the working source is reported as used');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].name, 'Survivor');
  } finally {
    DISCOVERY_SOURCES.forEach((s, i) => { s.discover = original[i]; });
  }
});

test('discovery: when every source fails the real cause is raised', async () => {
  const bad = stub({ z: Object.assign(new Error('everything is down'), { code: 'DISCOVERY_RATE_LIMITED' }) });
  const original = DISCOVERY_SOURCES.map((s) => s.discover);
  DISCOVERY_SOURCES.forEach((s) => { s.discover = bad.discover; });
  try {
    await assert.rejects(
      () => discoverCandidates({ country: 'US', city: 'Austin', keyword: 'z' }),
      (e) => e.code === 'DISCOVERY_RATE_LIMITED',
    );
  } finally {
    DISCOVERY_SOURCES.forEach((s, i) => { s.discover = original[i]; });
  }
});

test('discovery: a niche with no type mapping still produces a keyword query', () => {
  const types = resolveBusinessTypes('independent bookshops with tired websites');
  const query = searchTerms('independent bookshops with tired websites', { types, extra: 'Portland, US' });
  assert.ok(query.length > 0, 'a query is still produced');
  assert.match(query, /Portland, US/);
  assert.match(query, /bookshops/);
});

test('discovery: location words are dropped but the business terms are kept', () => {
  const query = searchTerms('restaurants in Austin that need a new website', {
    types: resolveBusinessTypes('restaurants'), extra: 'Austin, Texas, US',
  });
  assert.ok(!/ in /.test(query), 'the preposition is not searched for');
  assert.match(query, /Austin, Texas, US/);
});