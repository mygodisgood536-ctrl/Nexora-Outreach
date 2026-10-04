/**
 * Normalisation helpers. Spec §29 requires business identity to be normalised
 * across multiple signals so the same business is never contacted twice.
 */

const LEGAL_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'gmbh', 'ag', 'bv', 'nv', 'sa', 'sas',
  'srl', 'spa', 'plc', 'pty', 'pte', 'oy', 'ab', 'as', 'aps', 'kk', 'srl', 'llp', 'lp', 'lc',
]);

const MULTIWORD_TOKENS = new Set([
  'restaurant', 'restaurants', 'cafe', 'coffee', 'shop', 'store', 'studio', 'agency', 'company',
  'the', 'and', 'of', 'llc', 'inc', 'ltd', 'group', 'services', 'service', 'center', 'centre',
]);

/** Strip protocol, www, trailing slash, query noise → registrable-ish domain. */
export function normalizeDomain(input) {
  if (!input) return null;
  let value = String(input).trim().toLowerCase();
  if (!value) return null;
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  let host;
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.') || /\s/.test(host)) return null;
  return host;
}

/** Full origin URL with scheme, for fetching. */
export function normalizeUrl(input) {
  if (!input) return null;
  const value = String(input).trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Lowercase, strip +tags and dots in the local part is NOT done (may be real). */
export function normalizeEmail(input) {
  if (!input) return null;
  const value = String(input).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return null;
  const [local, domain] = value.split('@');
  if (!local || !domain) return null;
  return `${local}@${normalizeDomain(domain) || domain}`;
}

/**
 * Stable business key. Prefers the website domain (strongest signal),
 * otherwise falls back to a normalised name + locality.
 */
export function businessDedupeKey({ domain, websiteUrl, businessName, city, region, country }) {
  // Always normalise, whether the domain arrives bare or as a full URL.
  const dom = normalizeDomain(domain) || normalizeDomain(websiteUrl);
  if (dom) return `dom:${dom}`;
  const name = normalizeBusinessName(businessName);
  const place = [city, region, country].filter(Boolean).map((p) => String(p).toLowerCase().trim()).join('|');
  return `nam:${name}|${place}`;
}

/** Lowercase, strip punctuation and legal suffixes, collapse spaces. */
export function normalizeBusinessName(input) {
  if (!input) return '';
  let s = String(input).toLowerCase();
  // Strip combining diacritical marks (U+0300–U+036F) after NFKD decomposition.
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ');
  // Drop dotted legal-form acronyms (S.A., L.L.C., Co.Ltd.) before tokenising,
  // otherwise "s.a." becomes the tokens "s" and "a".
  s = s.replace(/\b[a-z](?:\.\s*[a-z])+\.?\b/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = s.split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter(
    (t) => !LEGAL_SUFFIXES.has(t) && !['the', 'and', 'of'].includes(t)
  );
  const core = (meaningful.length ? meaningful : tokens).filter((t) => !MULTIWORD_TOKENS.has(t));
  return (core.length ? core : meaningful.length ? meaningful : tokens).join(' ');
}

/** Keep digits and a leading +, for equality comparison of public numbers. */
export function normalizePhone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return plus + digits;
}

export function normalizeCountry(input) {
  if (!input) return null;
  const v = String(input).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export { LEGAL_SUFFIXES };