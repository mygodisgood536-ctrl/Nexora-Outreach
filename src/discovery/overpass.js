import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import config from '../config.js';

const log = createLogger('discovery');

/**
 * Business-type catalogue mapping human wording to OpenStreetMap tags.
 *
 * This is a *lookup table for a data source*, not a hard-coded mission: a
 * mission may target any of these types, several at once, or none (in which
 * case discovery falls back to the configured paid source). Spec §11 requires
 * discovery to be configurable per mission.
 */
export const BUSINESS_TYPES = [
  { key: 'restaurant', label: 'restaurants', keywords: ['restaurant', 'diner', 'eatery', 'bistro', 'trattoria'], tags: [{ k: 'amenity', v: 'restaurant' }] },
  { key: 'cafe', label: 'cafes and coffee shops', keywords: ['cafe', 'café', 'coffee', 'espresso', 'tea house'], tags: [{ k: 'amenity', v: 'cafe' }] },
  { key: 'bar', label: 'bars and pubs', keywords: ['bar', 'pub', 'brewery', 'cocktail'], tags: [{ k: 'amenity', v: 'bar' }] },
  { key: 'bakery', label: 'bakeries', keywords: ['bakery', 'baker', 'pastry', 'pastr'], tags: [{ k: 'shop', v: 'bakery' }] },
  { key: 'takeaway', label: 'takeaway food', keywords: ['takeaway', 'take out', 'delivery kitchen'], tags: [{ k: 'amenity', v: 'fast_food' }] },
  { key: 'dentist', label: 'dental practices', keywords: ['dentist', 'dental', 'orthodont'], tags: [{ k: 'amenity', v: 'dentist' }] },
  { key: 'gym', label: 'gyms and fitness studios', keywords: ['gym', 'fitness', 'personal trainer', 'yoga', 'pilates'], tags: [{ k: 'leisure', v: 'fitness_centre' }] },
  { key: 'salon', label: 'hair and beauty salons', keywords: ['salon', 'hairdresser', 'barber', 'beauty', 'spa', 'nails'], tags: [{ k: 'shop', v: 'hairdresser' }] },
  { key: 'florist', label: 'florists', keywords: ['florist', 'flower'], tags: [{ k: 'shop', v: 'florist' }] },
  { key: 'hotel', label: 'hotels and lodging', keywords: ['hotel', 'hostel', 'guesthouse', 'lodging', 'bnb'], tags: [{ k: 'tourism', v: 'hotel' }] },
  { key: 'plumber', label: 'plumbers', keywords: ['plumber', 'plumbing', 'drain'], tags: [{ k: 'shop', v: 'plumbing' }] },
  { key: 'electrician', label: 'electricians', keywords: ['electrician', 'electrical'], tags: [{ k: 'shop', v: 'electrical' }] },
  { key: 'builder', label: 'builders and contractors', keywords: ['builder', 'contractor', 'construction', 'renovation'], tags: [{ k: 'craft', v: 'construction' }] },
  { key: 'shop', label: 'retail shops', keywords: ['shop', 'store', 'retail', 'boutique'], tags: [{ k: 'shop', v: 'shop' }] },
  { key: 'clinic', label: 'clinics', keywords: ['clinic', 'medical', 'doctor', 'physio', 'physician'], tags: [{ k: 'amenity', v: 'clinic' }] },
  { key: 'lawyer', label: 'law firms', keywords: ['lawyer', 'law firm', 'attorney', 'solicitor'], tags: [{ k: 'office', v: 'lawyer' }] },
  { key: 'accountant', label: 'accounting firms', keywords: ['accountant', 'accounting', 'bookkeep', 'tax'], tags: [{ k: 'office', v: 'accountant' }] },
  { key: 'realestate', label: 'estate agencies', keywords: ['estate agent', 'realtor', 'real estate', 'property'], tags: [{ k: 'shop', v: 'estate_agent' }] },
];

/**
 * Resolve a mission's free-text target description into concrete data-source
 * filters. Returns an empty array when nothing matches, letting the caller
 * decide how to proceed rather than guessing a type.
 */
export function resolveBusinessTypes(description) {
  const text = String(description || '').toLowerCase();
  if (!text.trim()) return [];
  const matched = [];
  for (const type of BUSINESS_TYPES) {
    if (type.keywords.some((kw) => text.includes(kw))) matched.push(type);
  }
  return matched;
}

/**
 * Overpass cannot serve whole-country queries cheaply (they time out), so an
 * area name is resolved server-side by Overpass itself. English names for the
 * countries a mission is most likely to target; anything else falls back to
 * requiring a city or region.
 */
const COUNTRY_AREA_NAMES = {
  US: 'United States of America', GB: 'United Kingdom', DE: 'Germany',
  FR: 'France', ES: 'Spain', IT: 'Italy', NL: 'Netherlands', CA: 'Canada',
  AU: 'Australia', IE: 'Ireland', PT: 'Portugal', PL: 'Poland', SE: 'Sweden',
  AE: 'United Arab Emirates', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', NG: 'Nigeria', ZA: 'South Africa',
  IN: 'India', BR: 'Brazil', MX: 'Mexico',
};

/**
 * Build an Overpass QL query.
 *
 * Two strategies, both verified against the live API:
 *  - a bounding box when one is known;
 *  - otherwise an administrative area selected by name, which Overpass resolves
 *    server-side (this avoids depending on an external geocoder).
 */
export function buildOverpassQuery({ bbox = null, areaName = null, types = [], limit = 60 }) {
  if (!types.length) {
    throw err.validation(
      'No matching business type was recognised. Name a business type in the target description, or configure a paid discovery source.'
    );
  }
  const tagPairs = types.flatMap((t) => t.tags.map(({ k, v }) => `["${k}"="${v}"]`));

  // Resolve the spatial filter FIRST so every selector is guaranteed to carry
  // it. An Overpass selector without a spatial clause scans the whole planet
  // and times out.
  let filter;
  let prelude = '';
  if (bbox && bbox.length === 4) {
    const [south, west, north, east] = bbox.map(Number);
    filter = `(${south},${west},${north},${east})`;
  } else if (areaName) {
    const safe = String(areaName).replace(/["\\]/g, '');
    prelude = `area["name"="${safe}"]["boundary"="administrative"]->.searchArea;\n`;
    filter = '(area.searchArea)';
  } else {
    throw err.validation(
      'Discovery needs a city or region for this source. Add one to the mission, or configure a paid discovery provider.'
    );
  }

  const statements = tagPairs.map((pair) => `nwr${pair}${filter};`).join('\n    ');
  return `[out:json][timeout:60];
${prelude}(
    ${statements}
);
out center ${limit};`;
}

/** Choose the most specific area available for a mission location. */
export function resolveAreaName({ country, region = null, city = null }) {
  if (city) return city;
  if (region) return region;
  return COUNTRY_AREA_NAMES[country] || null;
}

/** Convert an Overpass element into a discovery candidate. */
function toCandidate(el, country) {
  const tags = el.tags || {};
  const name = tags.name || tags['name:en'];
  if (!name) return null;
  return {
    name,
    website: tags.website || tags['contact:website'] || tags.url || null,
    email: tags.email || tags['contact:email'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    address: [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null,
    city: tags['addr:city'] || null,
    region: tags['addr:state'] || null,
    country,
    rating: null,
    reviewCount: null,
    source: 'osm_overpass',
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    meta: { osmId: `${el.type}/${el.id}`, lat: el.lat ?? el.center?.lat ?? null, lon: el.lon ?? el.center?.lon ?? null },
  };
}

/**
 * Run discovery against Overpass for one target location.
 * Respects the source's fair-use expectations with a single in-flight request.
 */
export async function discoverViaOverpass({ country, region = null, city = null, types = [], limit = 60, signal } = {}) {
  const areaName = resolveAreaName({ country, region, city });
  const query = buildOverpassQuery({ areaName, types, limit });

  const res = await fetch(config.discovery.overpassUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': config.research.userAgent },
    body: new URLSearchParams({ data: query }),
    signal,
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 504) {
      throw err.discovery('DISCOVERY_HTTP_ERROR', 'Overpass is rate limiting or timing out; the job will retry.');
    }
    if (res.status === 400 || res.status === 406) {
      throw err.discovery('DISCOVERY_QUERY_REJECTED', `Overpass rejected the query (${res.status}). Check the User-Agent and location.`);
    }
    throw err.discovery('DISCOVERY_HTTP_ERROR', `Overpass returned status ${res.status}`);
  }
  const body = await res.json();
  const elements = Array.isArray(body.elements) ? body.elements : [];
  const candidates = elements.map((el) => toCandidate(el, country)).filter(Boolean);
  log.info(`overpass discovery: ${candidates.length} candidates for "${areaName}"`);
  return { source: 'osm_overpass', area: areaName, candidates };
}