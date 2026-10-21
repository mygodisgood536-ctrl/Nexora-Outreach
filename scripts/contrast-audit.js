/**
 * Automated contrast audit (spec TODO 9): every text/background colour pair
 * used in `public/styles.css` must meet WCAG AA (4.5:1 normal text, 3:1 large
 * text). Run with: node scripts/contrast-audit.js
 */
import fs from 'node:fs';

const TOKENS = {
  bg: { r: 7, g: 10, b: 18 },
  'panel-solid': { r: 11, g: 16, b: 32 },
  text: { r: 243, g: 246, b: 252 },
  muted: { r: 176, g: 188, b: 207 },
  faint: { r: 142, g: 155, b: 179 },
  accent: { r: 124, g: 156, b: 255 },
  'accent-bright': { r: 165, g: 188, b: 255 },
  cyan: { r: 124, g: 156, b: 255 },
  teal: { r: 95, g: 214, b: 196 },
  green: { r: 95, g: 214, b: 196 },
  amber: { r: 232, g: 185, b: 106 },
  red: { r: 240, g: 128, b: 143 },
  violet: { r: 169, g: 139, b: 255 },
  'accent-ink': { r: 10, g: 16, b: 36 },
};

const sRGB = (c) => (c <= 0.03928) ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lum = (c) => 0.2126 * sRGB(c.r / 255) + 0.7152 * sRGB(c.g / 255) + 0.0722 * sRGB(c.b / 255);
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

// Every (foreground, background) pairing the design actually uses.
const PAIRS = [
  ['text', 'bg'],
  ['muted', 'bg'],
  ['faint', 'bg'],
  ['accent', 'bg'],
  ['accent-bright', 'bg'],
  ['cyan', 'bg'],
  ['teal', 'bg'],
  ['green', 'bg'],
  ['amber', 'bg'],
  ['red', 'bg'],
  ['violet', 'bg'],
  ['text', 'panel-solid'],
  ['muted', 'panel-solid'],
  ['faint', 'panel-solid'],
  ['accent-ink', 'green'],   // badge ink on green badge
  ['accent-ink', 'teal'],    // badge ink on teal badge
  ['text', 'line'],          // line used as divider on bg
  ['text', 'line-strong'],
];
const COMPOSITE = {
  line: { r: 30, g: 35, b: 48 },   // rgba(150 168 205 / 0.16) over bg(7 10 18)
  'line-strong': { r: 53, g: 61, b: 80 }, // rgba(... / 0.32) over bg
};

let failures = 0;
for (const [fg, bg] of PAIRS) {
  const f = TOKENS[fg];
  const b = COMPOSITE[bg] ?? TOKENS[bg];
  if (!f || !b) { console.log(`missing token: ${fg} or ${bg}`); failures += 1; continue; }
  const ratio = contrast(f, b);
  const ok = ratio >= 4.5;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok' : 'FAIL'} ${fg.padEnd(13)} on ${bg.padEnd(12)} = ${ratio.toFixed(2)}:1`);
}

if (failures > 0) {
  console.log(`\n${failures} pair(s) below WCAG AA 4.5:1`);
  process.exit(1);
}
console.log(`\n${PAIRS.length} pairs checked, all >= 4.5:1`);
