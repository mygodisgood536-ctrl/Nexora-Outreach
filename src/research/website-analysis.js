/**
 * Extract objective, verifiable evidence from fetched HTML.
 *
 * Everything here is a fact observable in the markup. No interpretation, no
 * invention — interpretation is the AI stage's job, and it is given only what
 * this module recorded (spec §12).
 */

const decodeEntities = (s) => String(s)
  .replace(/&nbsp;/gi, ' ')
  .replace(/&amp;/gi, '&')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/gi, "'");

export function textOf(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function metaContent(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i'
  );
  const alt = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i'
  );
  const m = html.match(re) || html.match(alt);
  return m ? decodeEntities(m[1]).trim() : null;
}

function linksOf(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: m[1].trim(), text: textOf(m[2]).slice(0, 120) });
  }
  return out;
}

const CTA_TERMS = [
  'book', 'booking', 'reserve', 'reservation', 'order', 'menu', 'call now', 'contact',
  'get started', 'sign up', 'subscribe', 'quote', 'free quote', 'appointment', 'buy',
];

/**
 * Build the evidence object persisted to `website_analyses.evidence`.
 * Every field is a measurement, not a judgement.
 */
export function extractWebsiteEvidence(html, { url, bytes = null, contentType = '' } = {}) {
  const lower = html.toLowerCase();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const description = metaContent(html, 'description');
  const generator = metaContent(html, 'generator');
  const links = linksOf(html);
  const internal = links.filter((l) => l.href.startsWith('/') || (url && l.href.includes(new URL(url).hostname)));
  const navLinks = (html.match(/<nav\b[\s\S]*?<\/nav>/gi) || [])
    .map((nav) => linksOf(nav).length);

  const ctaLinks = links.filter((l) => {
    const t = `${l.text} ${l.href}`.toLowerCase();
    return CTA_TERMS.some((term) => t.includes(term));
  });

  const forms = (html.match(/<form\b/gi) || []).length;
  const images = (html.match(/<img\b/gi) || []).length;
  const imagesWithoutAlt = (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) || []).length;
  const headings = {
    h1: (html.match(/<h1\b/gi) || []).length,
    h2: (html.match(/<h2\b/gi) || []).length,
    h3: (html.match(/<h3\b/gi) || []).length,
  };
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const inlineStyles = (html.match(/style=["'][^"']{40,}/gi) || []).length;
  const externalScripts = (html.match(/<script\b[^>]*\bsrc=/gi) || []).length;
  const fontFamilies = [...new Set(
    (html.match(/font-family\s*:\s*([^;"']{3,60})/gi) || [])
      .map((m) => m.split(':').slice(1).join(':').replace(/["';].*$/, '').trim().toLowerCase())
  )].slice(0, 5);

  // Public contact routes visible in the page markup.
  const mailto = [...new Set((html.match(/mailto:([^"'?>\s]+)/gi) || [])
    .map((m) => decodeEntities(m.replace(/^mailto:/i, '')).toLowerCase()))];
  const tel = [...new Set((html.match(/tel:([+0-9()\s.-]{7,})/gi) || [])
    .map((m) => m.replace(/^tel:/i, '').trim()))];

  return {
    url,
    httpStatus: 200,
    contentType,
    bytes: bytes ?? Buffer.byteLength(html),
    hasTitle: Boolean(title),
    title: title.slice(0, 200),
    titleLength: title.length,
    hasMetaDescription: Boolean(description),
    metaDescription: description ? description.slice(0, 300) : null,
    generator,
    hasViewportMeta: viewport,
    h1Count: headings.h1,
    h2Count: headings.h2,
    h3Count: headings.h3,
    linkCount: links.length,
    internalLinkCount: internal.length,
    navElementCount: (html.match(/<nav\b/gi) || []).length,
    navLinkCounts: navLinks.slice(0, 5),
    ctaLinkCount: ctaLinks.length,
    ctaSamples: ctaLinks.slice(0, 5).map((l) => ({ text: l.text, href: l.href })),
    formCount: forms,
    imageCount: images,
    imagesMissingAlt: imagesWithoutAlt,
    inlineStyleBlocks: inlineStyles,
    externalScriptCount: externalScripts,
    fontFamilies,
    mailtoAddresses: mailto.slice(0, 5),
    telNumbers: tel.slice(0, 5),
    visibleTextLength: textOf(html).length,
    usesViewportFriendlyWidths: viewport && !/user-scalable\s*=\s*no/i.test(html),
    mentionsPrices: /[$€£]\s?\d|\bprice[sd]?\b|\bfrom \d/i.test(lower),
    hasStructuredData: /application\/ld\+json/i.test(html),
    // Honest statement of method so the AI never over-claims.
    analysisMethod: 'http_html_analysis_without_javascript_rendering',
  };
}

/**
 * A deterministic 0-100 signal. This is NOT the AI's verdict; it only orders
 * attention so obviously broken sites are examined first.
 */
export function heuristicScore(e) {
  let score = 100;
  if (!e.hasTitle) score -= 15;
  if (e.titleLength && e.titleLength < 15) score -= 5;
  if (!e.hasMetaDescription) score -= 10;
  if (!e.hasViewportMeta) score -= 20;          // not mobile responsive
  if (e.h1Count === 0) score -= 10;
  if (e.h1Count > 1) score -= 5;
  if (e.ctaLinkCount === 0 && e.formCount === 0) score -= 15;
  if (e.navElementCount === 0) score -= 5;
  if (e.visibleTextLength < 300) score -= 15;
  if (e.images > 0 && e.imagesMissingAlt / e.images > 0.5) score -= 5;
  if (!e.mailtoAddresses.length && !e.telNumbers.length) score -= 10;
  return Math.max(0, Math.min(100, score));
}