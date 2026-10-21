import { err } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import config from '../config.js';

const log = createLogger('discovery');

/**
 * Discovery source: OpenStreetMap Nominatim.
 *
 * §11 requires discovery to be configurable because different missions need
 * different sources. Overpass answers "every business tagged X inside this
 * area", which needs a tag we already understand. Nominatim answers a different
 * question — "businesses whose *name or description* matches these words" — and
 * returns the contact details OSM volunteers recorded (website, phone, email,
 * opening hours). That makes it the source that still works for a niche with no
 * tag mapping, and it is the reason a mission is never blocked by the type
 * catalogue.
 *
 * Nominatim's usage policy requires an identifying User-Agent and modest
 * request rates, both honoured here. No key is required and no scraping occurs:
 * this is the documented JSON search endpoint.
 */

const USER_AGENT = 'NexoraOutreach/1.0 (https://outreach-one-sand.vercel.app)';

/** Phrases that are location words rather than a description of the business. */
const LOCATION_WORDS = new Set([
  'business', 'businesses', 'businesses', 'shop', 'shops', 'store', 'stores', 'near',
  'in', 'around', 'the', 'a', 'an', 'and', 'or', 'of', 'for', 'with', 'that', 'have',
  'has', 'need', 'needs', 'looking', 'local', 'area', 'city', 'country',
]);

/**
 * Reduce a free-text target description to the words worth searching for.
 * Falls back to the whole phrase when nothing survives, so a niche the type
 * catalogue has never heard of still produces a real query.
 */
export function searchTerms(description, { types = [], extra = [] } = {}) {
  const parts = [];
  for (const t of types) parts.push(t.label);
  const words = String(description || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s&'-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !LOCATION_WORDS.has(w))
    .slice(0, 4);
  const extras = Array.isArray(extra) ? extra : [extra];
  parts.push(...words, ...extras.filter(Boolean));
  return [...new Set(parts)].slice(0, 6).join(' ').trim();
}

function candidateFromResult(r, country) {
  const extratags = r.extratags || {};
  const address = r.address || {};
  const name = (r.name || '').trim();
  if (!name) return null;
  const website = extratags.website || extratags['contact:website'] || extratags['website:menu'] || '';
  const phone = extratags.phone || extratags['contact:phone'] || '';
  const email = extratags.email || extratags['contact:email'] || '';
  return {
    name,
    website: website || null,
    email: email ? String(email).split(';')[0].trim() : null,
    phone: phone ? phone.split(';')[0].trim() : null,
    city: address.city || address.town || address.village || address.suburb || null,
    region: address.state || address.region || null,
    country: (address.country_code || country || '').toUpperCase(),
    source: 'nominatim',
    sourceUrl: r.osm_type && r.osm_id
      ? `https://www.openstreetmap.org/${r.osm_type}/${r.osm_id}`
      : 'https://www.openstreetmap.org',
    extraTags: {
      ...(extratags.opening_hours ? { opening_hours: extratags.opening_hours } : {}),
      ...(extratags.cuisine ? { cuisine: extratags.cuisine } : {}),
      ...(extratags['contact:facebook'] ? { facebook: extratags['contact:facebook'] } : {}),
      ...(extratags.instagram ? { instagram: extratags.instagram } : {}),
    },
  };
}

/**
 * Search Nominatim for businesses matching `keyword` near the given location.
 * Transient upstream problems are raised as retryable so the queue backs off
 * instead of burning the mission's attempt budget on a network blip (§30).
 */
export async function discoverViaNominatim({
  country, region = null, city = null, types = [], keyword = null, limit = 25, signal,
} = {}) {
  const place = [city, region, country].filter(Boolean).join(', ');
  const query = searchTerms(keyword, { types, extra: place ? [place] : [] });
  if (!query) {
    throw err.discovery('DISCOVERY_NO_QUERY', 'No searchable description was configured for this mission.');
  }

  const url = new URL(config.discovery.nominatimUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('extratags', '1');
  url.searchParams.set('namedetails', '1');
  // Nominatim's policy caps bulk use; a mission never needs more than this.
  url.searchParams.set('limit', String(Math.max(1, Math.min(25, limit || 25))));

  log.debug('nominatim search', { query });

  let res;
  try {
    res = await fetch(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    });
  } catch (e) {
    throw err.discovery('DISCOVERY_NETWORK', `The business directory could not be reached: ${e.message}`);
  }
  if (res.status === 429 || res.status >= 500) {
    const e = err.discovery('DISCOVERY_RATE_LIMITED', 'The business directory is busy. This pass will retry.');
    e.retryable = true;
    throw e;
  }
  if (!res.ok) {
    throw err.discovery('DISCOVERY_SOURCE_ERROR', `The business directory returned ${res.status}.`);
  }

  const body = await res.json();
  const results = Array.isArray(body) ? body : [];
  const candidates = results
    .filter((r) => r && (r.category === 'place' || r.addresstype || r.extratags))
    .map((r) => candidateFromResult(r, country))
    .filter(Boolean);

  return { source: 'nominatim', area: place || query, candidates };
}