#!/usr/bin/env node
/** Verifies live discovery against OpenStreetMap (Overpass + Nominatim). */
import fs from 'node:fs';
import { discoverViaOverpass, resolveBusinessTypes, buildOverpassQuery } from '../src/discovery/overpass.js';

const OUT = '_discovery_result.txt';
fs.writeFileSync(OUT, `discovery probe ${new Date().toISOString()}\n`);
const say = (s) => fs.appendFileSync(OUT, `${s}\n`);

try {
  say('--- type resolution ---');
  const restaurant = resolveBusinessTypes('independent restaurants in the USA');
  say(`restaurants -> ${restaurant.map((t) => t.key).join(',') || '(none)'}`);
  const dentist = resolveBusinessTypes('dental practices');
  say(`dentists -> ${dentist.map((t) => t.key).join(',') || '(none)'}`);
  const none = resolveBusinessTypes('zzzz nothing matches');
  say(`nonsense -> ${none.length} types`);
  say(`query sample:\n${buildOverpassQuery({ areaName: 'Austin', types: restaurant, limit: 5 })}`);

  say('--- live discovery: restaurants in Austin, TX, US ---');
  const result = await discoverViaOverpass({
    country: 'US', region: 'Texas', city: 'Austin',
    types: restaurant, limit: 10,
  });
  say(`source=${result.source} candidates=${result.candidates.length}`);
  for (const c of result.candidates.slice(0, 6)) {
    say(`  ${c.name} | website=${c.website || '-'} | phone=${c.phone || '-'} | city=${c.city || '-'} | ${c.sourceUrl}`);
  }
  say(`DISCOVERY_RESULT=${result.candidates.length > 0 ? 'PASS' : 'FAIL'}`);
} catch (e) {
  say(`DISCOVERY_RESULT=FAIL ${e.code || ''} ${e.message}`);
}