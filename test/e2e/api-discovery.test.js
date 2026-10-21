import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createClient } from '../helpers/api.js';
import { DISCOVERY_SOURCES, DEFAULT_DISCOVERY_SOURCES } from '../../src/discovery/sources.js';

/**
 * Spec §11 — "Discovery must be configurable because different missions may
 * require different business types and discovery sources."
 *
 * These tests go through the HTTP API a user actually calls: the source
 * catalogue is served by the backend, a mission stores its choice, and the
 * discovery stage is handed exactly those sources.
 */

const MISSION = {
  name: 'Restaurant Website Redesign',
  service: 'website_design',
  sendingMode: 'autopilot',
  targetDescription: 'restaurants with weak websites',
  offerSummary: 'free-first website redesign',
  windows: [{ dayOfWeek: 1, startMin: '10:00', endMin: '13:00' }],
  locations: [{ country: 'US', city: 'Austin', priority: 'high' }],
};

async function withServer(fn) {
  const ctx = await startTestServer();
  try { return await fn(ctx); } finally { await ctx.close(); }
}

async function signedIn(base, username = 'ada') {
  const c = createClient(base);
  await c.signupAndLogin({
    fullName: 'Ada', username, securityQuestion: 'First language?', securityAnswer: 'Analytical',
  });
  return c;
}

test('api: the discovery source catalogue comes from the backend', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const res = await c.get('/api/discovery/sources');
    assert.equal(res.status, 200);
    assert.equal(res.body.sources.length, DISCOVERY_SOURCES.length);
    for (const s of res.body.sources) {
      assert.ok(s.id && s.label && s.description, 'each source is described for the user');
      assert.equal(typeof s.requiresKey, 'boolean');
    }
    assert.deepEqual(res.body.defaults, [...DEFAULT_DISCOVERY_SOURCES]);
    // No secret or internal URL is exposed with the catalogue.
    assert.equal(JSON.stringify(res.body).includes('overpass-api.de'), false);
  });
});

test('api: a mission stores the discovery sources it was configured with', async () => {
  await withServer(async ({ base, system }) => {
    const c = await signedIn(base);

    const created = await c.post('/api/missions', { ...MISSION, discoverySources: ['nominatim'] });
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.mission.discoverySources, ['nominatim']);
    const id = created.body.mission.id;

    // It really is persisted, not just echoed back.
    const row = await system.db.get('SELECT discovery_sources FROM missions WHERE id = ?', id);
    assert.deepEqual(JSON.parse(row.discovery_sources), ['nominatim']);

    const patched = await c.patch(`/api/missions/${id}`, { discoverySources: ['overpass', 'nominatim'] });
    assert.deepEqual(patched.body.mission.discoverySources, ['overpass', 'nominatim']);

    // An unknown source is never trusted; known ids are kept.
    const bogus = await c.patch(`/api/missions/${id}`, { discoverySources: ['overpass', 'not-a-source'] });
    assert.deepEqual(bogus.body.mission.discoverySources, ['overpass']);
  });
});

test('api: a mission created without a choice uses the backend default', async () => {
  await withServer(async ({ base }) => {
    const c = await signedIn(base);
    const created = await c.post('/api/missions', MISSION);
    assert.deepEqual(created.body.mission.discoverySources, [...DEFAULT_DISCOVERY_SOURCES]);
  });
});

test('the discovery stage is handed the mission’s own sources', async () => {
  await withServer(async ({ base, system }) => {
    const c = await signedIn(base);
    const created = await c.post('/api/missions', { ...MISSION, discoverySources: ['nominatim'] });
    const id = created.body.mission.id;
    await c.post(`/api/missions/${id}/activate`, {});

    // The stub stands in for the network; it records exactly what it was asked.
    const seen = [];
    system.services.discovery.discover = async (args) => {
      seen.push(args);
      return { source: 'nominatim', area: 'Austin, US', candidates: [] };
    };

    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();

    assert.ok(seen.length > 0, 'discovery ran');
    assert.deepEqual(seen[0].sources, ['nominatim'], 'the configured sources were used');
    assert.ok(seen[0].keyword, 'the mission’s description reached the source as a keyword');
    assert.ok(seen[0].types.length > 0, 'the resolved business types were used too');
  });
});

test('a niche the type catalogue does not know still runs discovery', async () => {
  await withServer(async ({ base, system }) => {
    const c = await signedIn(base);
    const created = await c.post('/api/missions', {
      ...MISSION,
      name: 'Bookshop outreach',
      targetDescription: 'independent bookshops with tired websites',
    });
    const id = created.body.mission.id;

    const seen = [];
    system.services.discovery.discover = async (args) => {
      seen.push(args);
      return { source: 'nominatim', area: 'Austin, US', candidates: [] };
    };
    await c.post(`/api/missions/${id}/run-now`, {});
    await system.worker.drain();

    assert.equal(seen.length, 1, 'discovery ran instead of failing on an unmapped type');
    assert.deepEqual(seen[0].types, [], 'no tag mapping was invented');
    assert.match(seen[0].keyword, /bookshops/);
  });
});