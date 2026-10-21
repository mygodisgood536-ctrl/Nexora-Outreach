#!/usr/bin/env node
/**
 * Verifies live discovery against every permitted source (§11) and writes the
 * result next to the other evidence files, so the run can be inspected later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverCandidates, DISCOVERY_SOURCES, DEFAULT_DISCOVERY_SOURCES } from '../src/discovery/sources.js';
import { resolveBusinessTypes, buildOverpassQuery } from '../src/discovery/overpass.js';
import { searchTerms } from '../src/discovery/nominatim.js';

const OUT = process.env.PROBE_OUT || 'evidence/discovery-live-verification.txt';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `live discovery probe ${new Date().toISOString()}\n`);
const say = (s) => { fs.appendFileSync(OUT, `${s}\n`); console.log(s); };

try {
  say('--- type resolution (Overpass tag mapping) ---');
  const restaurants = resolveBusinessTypes('independent restaurants in the USA');
  say(`restaurants -> ${restaurants.map((t) => t.key).join(',') || '(none)'}`);
  const dentists = resolveBusinessTypes('dental practices');
  say(`dentists -> ${dentists.map((t) => t.key).join(',') || '(none)'}`);
  say(`unknown niche -> ${resolveBusinessTypes('zzzz nothing matches').length} types`);
  say(`keyword query for unknown niche: ${searchTerms('independent bookshops with tired websites', { extra: 'Portland, US' })}`);
  say(`overpass query sample:\n${buildOverpassQuery({ areaName: 'Austin', types: restaurants, limit: 5 })}`);

  say('--- configured sources ---');
  for (const s of DISCOVERY_SOURCES) say(`${s.id}: ${s.label} — ${s.description}`);

  say('--- live discovery: businesses in Austin, TX, US ---');
  const result = await discoverCandidates({
    country: 'US', region: 'Texas', city: 'Austin',
    types: restaurants, keyword: 'restaurants that need a new website',
    sources: DEFAULT_DISCOVERY_SOURCES, limit: 12,
  });
  say(`sources used=${result.source} area=${result.area} candidates=${result.candidates.length}`);
  for (const c of result.candidates.slice(0, 8)) {
    say(`  ${c.name} | website=${c.website || '-'} | email=${c.email || '-'} | phone=${c.phone || '-'} | ${c.sourceUrl}`);
  }
  const withWebsite = result.candidates.filter((c) => c.website).length;
  say(`candidates with a website: ${withWebsite}/${result.candidates.length}`);
  say(`DISCOVERY_RESULT=${result.candidates.length > 0 ? 'PASS' : 'FAIL'}`);
} catch (e) {
  say(`DISCOVERY_RESULT=FAIL ${e.code || ''} ${e.message}`);
}