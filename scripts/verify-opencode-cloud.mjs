import config from '../src/config.js';
import { AIRuntime } from '../src/ai/runtime.js';
import { createTransport } from '../src/ai/transport.js';

/**
 * Live OpenCode Cloud smoke test.
 *
 *   node scripts/verify-opencode-cloud.mjs
 *
 * Reads the service-account key from the environment (OPENCODE_API_KEY). It
 * never prints the key. Exits non-zero if the workspace catalog cannot be
 * discovered or a model cannot be reached. Run this after setting the Vercel
 * Production environment variables to confirm the AI runtime end to end.
 */

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!config.opencode.cloud) {
  fail('OPENCODE_API_KEY is not an OpenCode Cloud service-account key (expected an "oc_sk_" value).');
}

const transport = createTransport();
const db = {
  async get() { return null; },
  async run() { return { changes: 1 }; },
};
const ai = new AIRuntime({ db, transport });

console.log('transport   :', transport.kind);
console.log('gateway     :', transport.describe().baseUrl);
console.log('discovery   :', transport.describe().discoveryUrl);

const diag = await ai.diagnose();
if (!diag.ok) fail(`diagnostics failed: ${diag.error}`);
console.log('provider(s) :', diag.providers.join(', '));
console.log('models      :', diag.modelCount);

const chosen = diag.sample.includes(config.opencode.defaultModel)
  ? config.opencode.defaultModel
  : diag.sample[0];
console.log('test model  :', chosen);

const out = await ai.complete(1, 'verify_cloud', {
  system: 'You are a precise engine. Follow the instruction exactly.',
  prompt: 'Reply with exactly: NEXORA_OPENCODE_CLOUD_OK',
  maxRetries: 1,
});
console.log('response    :', JSON.stringify(out.text));
console.log(out.text.trim() === 'NEXORA_OPENCODE_CLOUD_OK' ? 'PASS' : 'FAIL: unexpected model output');
if (out.text.trim() !== 'NEXORA_OPENCODE_CLOUD_OK') process.exit(1);