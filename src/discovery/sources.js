import { createLogger } from '../core/logger.js';
import { normalizeBusinessName, normalizeDomain } from '../core/normalize.js';
import { resolveBusinessTypes, discoverViaOverpass } from './overpass.js';
import { discoverViaNominatim, searchTerms } from './nominatim.js';

const log = createLogger('discovery');

/**
 * Discovery sources (§11).
 *
 * "Discovery must be configurable because different missions may require
 * different business types and discovery sources." A mission therefore chooses
 * which of the permitted sources to use, and the registry below runs them in
 * order, merging results and dropping duplicates.
 *
 * Every source here uses a documented, permitted API. Nothing scrapes a
 * provider's user interface, and no source bypasses an access control (§24/§29).
 */
export const DISCOVERY_SOURCES = [
  {
    id: 'overpass',
    label: 'OpenStreetMap Overpass',
    description: 'Finds every business tagged with the mission’s types inside the target area.',
    requiresKey: false,
    discover: discoverViaOverpass,
  },
  {
    id: 'nominatim',
    label: 'OpenStreetMap Nominatim',
    description: 'Searches businesses by name and description, with the contact details OpenStreetMap records.',
    requiresKey: false,
    discover: discoverViaNominatim,
  },
];

export const DEFAULT_DISCOVERY_SOURCES = ['overpass', 'nominatim'];

/**
 * Accepts what a mission stores (a JSON array), what an API client sends (an
 * array of ids) or a comma-separated string, and returns only known source ids.
 */
export function normaliseSourceIds(value) {
  let raw = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { raw = JSON.parse(trimmed); } catch { raw = trimmed.split(','); }
    } else {
      raw = trimmed.split(',');
    }
  }
  if (!Array.isArray(raw)) raw = [];
  const known = DISCOVERY_SOURCES.map((s) => s.id);
  const picked = raw.map((v) => String(v).trim()).filter((v) => known.includes(v));
  const unique = [...new Set(picked)];
  return unique.length ? unique : [...DEFAULT_DISCOVERY_SOURCES];
}

/** Identity for merging results: the domain first, then name + town. */
function identityOf(candidate) {
  const domain = normalizeDomain(candidate.website || '') || null;
  if (domain) return `domain:${domain}`;
  return `name:${normalizeBusinessName(candidate.name)}|${(candidate.city || '').toLowerCase()}`;
}

/**
 * Run the mission's configured sources and return one merged candidate list.
 *
 * A source that fails does not sink the pass: its failure is logged and the
 * remaining sources still produce candidates. Only when every configured source
 * fails is an error raised, and then it is the last failure's error so the
 * operator sees the real cause.
 */
export async function discoverCandidates({
  country, region = null, city = null, types = [], keyword = null,
  limit = 25, sources = DEFAULT_DISCOVERY_SOURCES, signal,
} = {}) {
  const chosen = normaliseSourceIds(sources).map(
    (id) => DISCOVERY_SOURCES.find((s) => s.id === id),
  ).filter(Boolean);

  const seen = new Map();
  const used = [];
  const areas = [];
  let lastError = null;

  for (const source of chosen) {
    try {
      const result = await source.discover({
        country, region, city, types, keyword, limit, signal,
      });
      used.push(source.id);
      areas.push(result.area);
      for (const candidate of result.candidates || []) {
        const id = identityOf(candidate);
        const existing = seen.get(id);
        if (existing) {
          // Two sources describing the same business: keep the richer record
          // rather than creating the business twice (§29 deduplication).
          existing.website = existing.website || candidate.website || null;
          existing.email = existing.email || candidate.email || null;
          existing.phone = existing.phone || candidate.phone || null;
          existing.source = existing.source === candidate.source
            ? existing.source
            : `${existing.source}+${candidate.source}`;
          continue;
        }
        seen.set(id, { ...candidate });
      }
    } catch (e) {
      lastError = e;
      log.warn(`discovery source ${source.id} failed`, { code: e?.code, message: e?.message });
    }
  }

  if (!used.length) throw lastError || new Error('no discovery source is configured');

  const candidates = [...seen.values()].slice(0, limit);
  return {
    candidates,
    source: used.join('+'),
    sources: used,
    area: areas[0] || [city, region, country].filter(Boolean).join(', '),
    types: types.map((t) => t.key),
    keyword: searchTerms(keyword, { types }),
  };
}

export { resolveBusinessTypes, searchTerms };