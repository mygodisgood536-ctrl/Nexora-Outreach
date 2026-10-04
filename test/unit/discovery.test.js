import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveBusinessTypes, buildOverpassQuery, resolveAreaName, BUSINESS_TYPES,
} from '../../src/discovery/overpass.js';
import { AppError } from '../../src/core/errors.js';

test('discovery: business types are resolved from free text, not fixed', () => {
  assert.deepEqual(resolveBusinessTypes('independent restaurants').map((t) => t.key), ['restaurant']);
  assert.deepEqual(resolveBusinessTypes('dental practices in town').map((t) => t.key), ['dentist']);
  assert.ok(resolveBusinessTypes('hair salons and spas').length >= 1);
  assert.deepEqual(resolveBusinessTypes('zzzz nothing'), []);
  assert.deepEqual(resolveBusinessTypes(''), []);
  // The catalogue must cover more than one niche (spec §4).
  const keys = new Set(BUSINESS_TYPES.map((t) => t.key));
  assert.ok(keys.size >= 15, `expected a broad catalogue, got ${keys.size}`);
  assert.ok(!keys.has('restaurant_only'));
});

test('discovery: area selection prefers the most specific location', () => {
  assert.equal(resolveAreaName({ country: 'US', city: 'Austin' }), 'Austin');
  assert.equal(resolveAreaName({ country: 'US', region: 'Texas' }), 'Texas');
  assert.equal(resolveAreaName({ country: 'US' }), 'United States of America');
  assert.equal(resolveAreaName({ country: 'ZZ' }), null);
});

test('discovery: every selector carries a spatial filter (whole-world scan times out)', () => {
  const q = buildOverpassQuery({ areaName: 'Austin', types: resolveBusinessTypes('restaurants'), limit: 5 });
  assert.match(q, /area\["name"="Austin"\]\["boundary"="administrative"\]/);
  const selectors = q.split('\n').filter((l) => l.trim().startsWith('nwr['));
  assert.equal(selectors.length, 1);
  for (const line of selectors) {
    assert.match(line, /\(area\.searchArea\);$/, `selector must be bounded: ${line}`);
  }
});

test('discovery: bounding box queries are valid', () => {
  const q = buildOverpassQuery({ bbox: [30.2, -97.8, 30.4, -97.6], types: resolveBusinessTypes('cafes'), limit: 3 });
  assert.match(q, /nwr\["amenity"="cafe"\]\(30\.2,-97\.8,30\.4,-97\.6\);/);
  assert.ok(!q.includes('searchArea'));
});

test('discovery: multiple business types union correctly', () => {
  const types = resolveBusinessTypes('restaurants and cafes');
  const q = buildOverpassQuery({ areaName: 'Berlin', types, limit: 10 });
  assert.match(q, /nwr\["amenity"="restaurant"\]\(area\.searchArea\);/);
  assert.match(q, /nwr\["amenity"="cafe"\]\(area\.searchArea\);/);
});

test('discovery: injection attempts in a location name are neutralised', () => {
  const q = buildOverpassQuery({ areaName: 'Austin";out;//', types: resolveBusinessTypes('cafes') });
  // Quotes and backslashes are stripped, so the value cannot terminate the
  // quoted string and inject additional Overpass statements.
  assert.ok(!q.includes('";out'), 'the area name must not break out of the query');
  assert.match(q, /area\["name"="Austin;out;\/\/"\]\["boundary"="administrative"\]/);
});

test('discovery: missing type or location is a validation error, not a silent empty run', () => {
  assert.throws(
    () => buildOverpassQuery({ areaName: 'Austin', types: [] }),
    (e) => e instanceof AppError && e.code === 'VALIDATION_FAILED'
  );
  assert.throws(
    () => buildOverpassQuery({ types: resolveBusinessTypes('restaurants') }),
    (e) => e instanceof AppError && e.code === 'VALIDATION_FAILED'
  );
});

test('discovery: rate limits are transient so jobs retry rather than fail', () => {
  assert.equal(new AppError('DISCOVERY_HTTP_ERROR', 'busy').retryable, true);
  assert.equal(new AppError('DISCOVERY_QUERY_REJECTED', 'bad query').retryable, false);
});