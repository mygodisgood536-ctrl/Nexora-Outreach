import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenCodeCloudTransport, familyOf } from '../../src/ai/cloud-transport.js';
import { createTransport } from '../../src/ai/transport.js';
import { AppError } from '../../src/core/errors.js';

/** Records requests and answers from a script of handlers. */
function stubFetch(handler) {
  const requests = [];
  const fn = async (url, init = {}) => {
    const req = { url, method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    requests.push(req);
    return handler(req, requests.length);
  };
  fn.requests = requests;
  return fn;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CONFIG = {
  providers: {
    opencode: {
      models: {
        'space-bunny-free': { family: 'bunny', name: 'Space Bunny', limit: { output: 32000 } },
        'claude-sonnet-4-6': {
          family: 'claude-sonnet', name: 'Claude Sonnet',
          package: 'aisdk:@ai-sdk/anthropic',
          settings: { baseURL: 'https://opencode.ai/inference/anthropic/v1' },
        },
        'gemini-3.1-pro': {
          family: 'gemini-pro', name: 'Gemini Pro',
          package: 'aisdk:@ai-sdk/google',
          settings: { baseURL: 'https://opencode.ai/inference/google/v1beta' },
        },
      },
    },
  },
};

const KEY = 'oc_sk_test_key_not_real';

test('cloud: familyOf maps package to inference family', () => {
  assert.equal(familyOf({}), 'openai');
  assert.equal(familyOf({ package: 'aisdk:@ai-sdk/openai' }), 'openai');
  assert.equal(familyOf({ package: 'aisdk:@ai-sdk/anthropic' }), 'anthropic');
  assert.equal(familyOf({ package: 'aisdk:@ai-sdk/google' }), 'google');
});

test('cloud: createTransport selects the cloud transport from an oc_sk_ key', () => {
  const cloud = createTransport({
    cloud: true, apiKey: KEY, cloudUrl: 'https://opencode.ai', consoleUrl: 'https://console.opencode.ai',
  });
  assert.ok(cloud instanceof OpenCodeCloudTransport);
  assert.equal(cloud.kind, 'cloud');

  assert.equal(createTransport({ baseUrl: '' }).kind, 'cli');
  assert.equal(createTransport({ baseUrl: 'https://oc.example' }).kind, 'http');
  assert.equal(createTransport({}).kind, 'cli');
});

test('cloud: a missing key is a configuration error', () => {
  assert.throws(() => new OpenCodeCloudTransport({ apiKey: '' }), (e) => e.code === 'AI_PROVIDER_ERROR');
});

test('cloud: credentials are never exposed by describe()', () => {
  const t = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: stubFetch(() => json(CONFIG)) });
  const described = JSON.stringify(t.describe());
  assert.equal(described.includes(KEY), false);
  assert.equal(described.includes('oc_sk_'), false);
  assert.deepEqual(t.describeCredentials(), { hasApiKey: true, kind: 'cloud' });
});

test('cloud: listModels discovers the catalog from the workspace config', async () => {
  const fetch = stubFetch((req) => {
    assert.equal(req.url, 'https://console.opencode.ai/api/v2/config');
    assert.match(req.headers.authorization, /^Bearer oc_sk_/);
    return json(CONFIG);
  });
  const t = new OpenCodeCloudTransport({
    apiKey: KEY, fetchImpl: fetch, inferenceUrl: 'https://opencode.ai', consoleUrl: 'https://console.opencode.ai',
  });

  const models = await t.listModels();
  assert.deepEqual(models.map((m) => m.id), [
    'opencode/space-bunny-free', 'opencode/claude-sonnet-4-6', 'opencode/gemini-3.1-pro',
  ]);
  assert.ok(models.every((m) => m.provider === 'opencode'));
  assert.equal(models[1].api, 'anthropic');
  assert.equal(models[2].api, 'google');
  assert.equal(models[0].api, 'openai');

  // Cached: a second call must not hit the network again.
  await t.listModels();
  assert.equal(fetch.requests.length, 1);
});

test('cloud: version performs a config/credential check', async () => {
  const fetch = stubFetch(() => json(CONFIG));
  const t = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: fetch });
  assert.equal(await t.version(), 'opencode-cloud');
  assert.equal(fetch.requests[0].url, 'https://console.opencode.ai/api/v2/config');
});

test('cloud: runPrompt uses the OpenAI chat-completions family by default', async () => {
  const fetch = stubFetch((req) => {
    if (req.url.endsWith('/api/v2/config')) return json(CONFIG);
    if (req.url.endsWith('/inference/openai/v1/chat/completions')) {
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'space-bunny-free');
      assert.equal(body.messages[0].role, 'user');
      assert.equal(body.messages[0].content, 'say hi');
      assert.ok(body.max_tokens > 0);
      return json({
        model: 'space-bunny-free',
        choices: [{ message: { role: 'assistant', content: 'hello world' } }],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      });
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });
  const t = new OpenCodeCloudTransport({
    apiKey: KEY, fetchImpl: fetch, inferenceUrl: 'https://opencode.ai', consoleUrl: 'https://console.opencode.ai',
  });

  const out = await t.runPrompt('say hi', { model: 'opencode/space-bunny-free' });
  assert.equal(out.text, 'hello world');
  assert.deepEqual(out.tokens, { prompt: 7, completion: 2, total: 9 });
});

test('cloud: runPrompt routes Anthropic models to the messages API', async () => {
  const fetch = stubFetch((req) => {
    if (req.url.endsWith('/api/v2/config')) return json(CONFIG);
    if (req.url === 'https://opencode.ai/inference/anthropic/v1/messages') {
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'claude-sonnet-4-6');
      assert.equal(typeof body.max_tokens, 'number');
      return json({
        content: [{ type: 'text', text: 'An' }, { type: 'text', text: 'swer' }],
        usage: { input_tokens: 12, output_tokens: 3 },
      });
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });
  const t = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: fetch });

  const out = await t.runPrompt('hi', { model: 'opencode/claude-sonnet-4-6' });
  assert.equal(out.text, 'Answer');
  assert.deepEqual(out.tokens, { prompt: 12, completion: 3, total: 15 });
});

test('cloud: runPrompt uses the Gemini generateContent path', async () => {
  const fetch = stubFetch((req) => {
    if (req.url.endsWith('/api/v2/config')) return json(CONFIG);
    if (req.url.endsWith('/models/gemini-3.1-pro:generateContent')) {
      return json({
        candidates: [{ content: { parts: [{ text: 'gem' }, { text: 'ini' }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
      });
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });
  const t = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: fetch });

  const out = await t.runPrompt('hi', { model: 'opencode/gemini-3.1-pro' });
  assert.equal(out.text, 'gemini');
  assert.deepEqual(out.tokens, { prompt: 4, completion: 2, total: 6 });
});

test('cloud: failures map onto the shared retry taxonomy', async () => {
  const cases = [
    [401, (e) => e.code === 'UNAUTHENTICATED' && !e.retryable],
    [403, (e) => e.code === 'AI_MODEL_UNAVAILABLE' && !e.retryable],
    [429, (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable],
    [500, (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable],
  ];
  for (const [status, check] of cases) {
    const t = new OpenCodeCloudTransport({
      apiKey: KEY, fetchImpl: stubFetch(() => json({ error: 'x' }, status)),
    });
    await assert.rejects(() => t.version(), check, `HTTP ${status}`);
  }

  const aborted = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const timeout = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: aborted, timeoutMs: 20 });
  await assert.rejects(() => timeout.version(), (e) => e.code === 'AI_TIMEOUT' && e.retryable);

  const down = new OpenCodeCloudTransport({
    apiKey: KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => down.version(),
    (e) => e instanceof AppError && e.code === 'AI_PROVIDER_ERROR' && e.retryable);
});

test('cloud: runPrompt without a model is an AI error', async () => {
  const t = new OpenCodeCloudTransport({ apiKey: KEY, fetchImpl: stubFetch(() => json(CONFIG)) });
  await assert.rejects(() => t.runPrompt('hi', {}), (e) => e.code === 'AI_PROVIDER_ERROR');
});