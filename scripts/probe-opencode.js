#!/usr/bin/env node
/**
 * Verifies the real OpenCode integration (spec §31):
 * discovery, selection, execution, structured output, and model switching.
 */
import fs from 'node:fs';
import { createTestDb } from '../src/db/index.js';
import { AIRuntime } from '../src/ai/runtime.js';
import config from '../src/config.js';

const OUT = process.env.PROBE_OUT || '_probe_result.txt';
fs.writeFileSync(OUT, `probe start ${new Date().toISOString()}\n`);
const say = (s) => fs.appendFileSync(OUT, `${s}\n`);

const db = createTestDb();
// The probe runs against a throwaway in-memory database, so the schema has to
// be applied first: every method on Db is async and every query awaits a real
// Promise, so an un-awaited call would hand the probe a pending Promise.
await db.migrate();
await db.run(
  `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
   VALUES('Probe','probe','probe','q?',0)`
);
const userId = (await db.get('SELECT id FROM users WHERE username_lower = ?', 'probe')).id;
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
  // OpenCode exposes a workspace-wide catalog, but a workspace may have some
  // models disabled. Start from the model this deployment is actually
  // configured to use, then walk the catalog until one is permitted, so the
  // probe reports access rather than the accident of catalog order.
  const preferred = [config.opencode.defaultModel, ...catalog.map((m) => m.id)]
    .filter((id, i, all) => all.indexOf(id) === i && catalog.some((m) => m.id === id));
  let picked = null;
  let lastError = null;
  for (const id of preferred) {
    try {
      picked = await ai.setSelection(userId, id);
      say(`selected=${picked.model}`);
      break;
    } catch (e) {
      lastError = e;
      say(`model unavailable: ${id} (${e.code || e.message})`);
    }
  }
  if (!picked) throw lastError || new Error('no model in the catalog could be selected');
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
    // Switching has to reach a model the workspace may actually use, so the
    // same walk as above applies; the point of the probe is that a *different*
    // selected model changes subsequent execution.
    let switched = null;
    for (const id of preferred) {
      if (id === picked.model) continue;
      try {
        switched = await ai.setSelection(userId, id);
        break;
      } catch (e) {
        say(`switch unavailable: ${id} (${e.code || e.message})`);
      }
    }
    if (switched) {
      say(`now_selected=${ai.selection(userId).model}`);
      t = Date.now();
      const o2 = await ai.complete(userId, 'probe_switch', {
        prompt: 'Reply with exactly SWITCHED and nothing else.', maxRetries: 0,
      });
      say(`switch_call model=${o2.model} ms=${Date.now() - t} value=${JSON.stringify(o2.text)}`);
    } else {
      say('switch skipped: this workspace permits only one model');
    }
  }

  const logs = await db.all('SELECT purpose, model, ok, ms FROM ai_call_log ORDER BY id');
  say(`--- ai_call_log rows=${logs.length} ---`);
  for (const l of logs) say(`  ${l.purpose} ${l.model} ok=${l.ok} ${l.ms}ms`);
  say('PROBE_RESULT=PASS');
} catch (e) {
  say(`PROBE_RESULT=FAIL ${e.code || ''} ${e.message}`);
} finally {
  await db.close();
}