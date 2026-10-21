import { extractWebsiteEvidence, heuristicScore } from '../../src/research/website-analysis.js';

const html = `<!DOCTYPE html><html><head><title>ABC Restaurant &amp; Bar</title>
<meta name="description" content="Family restaurant in Austin"><meta name="viewport" content="width=device-width">
</head><body>
<nav><a href="/">Home</a><a href="/menu">Menu</a><a href="/reservations">Book a table</a></nav>
<h1>ABC Restaurant</h1><h2>Our Services</h2>
<a href="https://doordash.com">Order online</a><a href="https://opentable.com">Reserve</a>
<a href="mailto:hello@abc.com">Email us</a><a href="tel:+15125550100">Call us</a>
<p>Opening hours: Mon-Fri 11-22</p>
<img src="/food.jpg"><p>${'Welcome to our restaurant. '.repeat(20)}</p>
</body></html>`;

const e = extractWebsiteEvidence(html, { url: 'https://abc.example' });
const aspectTerms = Object.fromEntries(
  Object.entries(e.aspects).map(([k, v]) => [k, v.map((t) => t.term)]),
);
console.log('aspects:', JSON.stringify(aspectTerms));
console.log('hasViewportMeta:', e.hasViewportMeta, '| ctas:', e.ctaLinkCount, '| mailto:', e.mailtoAddresses.length);
console.log('visibleTextLength:', e.visibleTextLength, '| heuristicScore:', heuristicScore(e));

// A page with none of those traces must report empty aspects rather than guesses.
const bare = '<html><head><title>Bare</title></head><body><h1>Bare</h1></body></html>';
const b = extractWebsiteEvidence(bare, { url: 'https://bare.example' });
console.log('bare aspects all empty:', Object.values(b.aspects).every((v) => v.length === 0));