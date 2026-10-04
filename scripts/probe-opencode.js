#!/usr/bin/env node
/**
 * Verifies the real OpenCode integration (spec §31):
 * discovery, selection, execution, structured output, and model switching.
 */
import fs from 'node:fs';
import { createTestDb } from '../src/db/index.js';
import { AIRuntime } from '../src/ai/runtime.js';

const OUT = process.env.PROBE_OUT || '_probe_result.txt';
fs.writeFileSync(OUT, `probe start ${new Date().toISOString()}\n`);
const say = (s) => fs.appendFileSync(OUT, `${s}\n`);

const db = createTestDb();
db.run(
  `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
   VALUES('Probe','probe','probe','q?',0)`
);
const userId = db.get('SELECT id FROM users WHERE username_lower = ?', 'probe').id;
const ai = new AIRuntime({ db });

try {
  say('--- diagnose ---');
  const diag = await ai.diagnose();
  say(`bin=${diag.bin}`);
  say(`ok=${diag.ok} version=${diag.version} models=${diag.modelCount} error=${diag.error}`);
  say(`providers=${JSON.stringify(diag.providers)}`);
  say(`sample=${JSON.stringify(diag.sample)}`);

  say('--- catalog (live from OpenCode, no refresh) ---');
  const catalog = await ai.catalog();
  say(`count=${catalog.length}`);
  for (const m of catalog) say(`  ${m.id}`);

  say('--- reject model not offered by OpenCode ---');
  try {
    await ai.setSelection(userId, 'totally/fake-model-xyz');
    say('FAIL: bogus model accepted');
  } catch (e) { say(`OK rejected: ${e.code}`); }

  say('--- select + execute text ---');
  const picked = await ai.setSelection(userId, catalog[0].id);
  say(`selected=${picked.model}`);
  let t = Date.now();
  const out = await ai.complete(userId, 'probe_text', {
    prompt: 'Reply with exactly the single word PONG and nothing else.', maxRetries: 0,
  });
  say(`text_call model=${out.model} ms=${Date.now() - t} value=${JSON.stringify(out.text)}`);

  say('--- execute structured JSON ---');
  t = Date.now();
  const j = await ai.completeJson(userId, 'probe_json', {
    prompt:
      'A website audit found: no viewport meta tag, no call-to-action link, 3 broken internal links. ' +
      'Return JSON with keys: qualified (boolean), score (0-100), reasons (array of strings).',
    validate: (d) => typeof d.qualified === 'boolean' && Array.isArray(d.reasons),
    maxRetries: 0,
  });
  say(`json_call model=${j.model} ms=${Date.now() - t} data=${JSON.stringify(j.data)}`);

  if (catalog.length > 1) {
    say('--- switch model and re-execute ---');
    await ai.setSelection(userId, catalog[1].id);
    say(`now_selected=${ai.selection(userId).model}`);
    t = Date.now();
    const o2 = await ai.complete(userId, 'probe_switch', {
      prompt: 'Reply with exactly SWITCHED and nothing else.', maxRetries: 0,
    });
    say(`switch_call model=${o2.model} ms=${Date.now() - t} value=${JSON.stringify(o2.text)}`);
  }

  const logs = db.all('SELECT purpose, model, ok, ms FROM ai_call_log ORDER BY id');
  say(`--- ai_call_log rows=${logs.length} ---`);
  for (const l of logs) say(`  ${l.purpose} ${l.model} ok=${l.ok} ${l.ms}ms`);
  say('PROBE_RESULT=PASS');
} catch (e) {
  say(`PROBE_RESULT=FAIL ${e.code || ''} ${e.message}`);
} finally {
  db.close();
}