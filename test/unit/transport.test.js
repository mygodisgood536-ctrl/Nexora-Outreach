import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpTransport, CliTransport, createTransport } from '../../src/ai/transport.js';
import { AIRuntime } from '../../src/ai/runtime.js';
import { AppError } from '../../src/core/errors.js';

/** Minimal db stub: the AI runtime only logs calls through it. */
function fakeDb() {
  const calls = [];
  return {
    calls,
    async run(sql, ...args) { calls.push({ sql, args }); return { changes: 1 }; },
    async get() { return null; },
    async all() { return []; },
  };
}

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

test('transport: OPENCODE_BASE_URL selects HTTP, otherwise the local binary', () => {
  assert.equal(createTransport({ baseUrl: '' }).kind, 'cli');
  assert.equal(createTransport({}).kind, 'cli');
  assert.equal(createTransport({ baseUrl: 'https://opencode.example' }).kind, 'http');

  const t = createTransport({ baseUrl: 'https://opencode.example/', password: 's3cret' });
  assert.equal(t.baseUrl, 'https://opencode.example', 'trailing slash is trimmed');
  assert.ok(t instanceof HttpTransport);
  assert.ok(createTransport({ baseUrl: '' }) instanceof CliTransport);
});

test('transport: HTTP version calls /global/health and authenticates', async () => {
  const fetch = stubFetch((req) => {
    assert.equal(req.url, 'https://oc.example/global/health');
    assert.match(req.headers.authorization, /^Basic /);
    return json({ healthy: true, version: '1.2.3' });
  });
  const t = new HttpTransport({
    baseUrl: 'https://oc.example', username: 'opencode', password: 'pw', fetchImpl: fetch,
  });

  assert.equal(await t.version(), '1.2.3');
  assert.equal(t.describe().baseUrl, 'https://oc.example');
  assert.equal(t.describe().password, undefined, 'describe never exposes the password');
  assert.equal(JSON.stringify(t.describe()).includes('pw'), false);
});

test('transport: HTTP listModels flattens the provider catalog', async () => {
  const fetch = stubFetch(() => json({
    providers: [
      { id: 'opencode', models: { 'space-bunny-free': {}, 'gpt-x': { name: 'GPT-X' } } },
      { id: 'anthropic', models: [{ id: 'claude-4' }, { model: 'claude-3' }] },
      { id: 'opencode', models: { 'space-bunny-free': {} } }, // duplicate provider entry
    ],
    default: { opencode: 'space-bunny-free' },
  }));
  const t = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: fetch });

  const models = await t.listModels();
  const ids = models.map((m) => m.id);
  assert.deepEqual(ids, [
    'opencode/space-bunny-free', 'opencode/gpt-x', 'anthropic/claude-4', 'anthropic/claude-3',
  ]);
  assert.ok(models.every((m) => m.id.includes('/')), 'ids are provider/model');
  assert.equal(models[1].provider, 'opencode');
  assert.equal(models[1].model, 'gpt-x');
});

test('transport: an empty catalog is an AI error, not an empty list', async () => {
  const t = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: stubFetch(() => json({ providers: [] })) });
  await assert.rejects(() => t.listModels(), (e) => e instanceof AppError && e.code === 'AI_PROVIDER_ERROR');
});

test('transport: HTTP runPrompt runs a session, returns text and cleans up', async () => {
  const fetch = stubFetch((req) => {
    if (req.method === 'POST' && req.url.endsWith('/session')) return json({ id: 'sess_1' });
    if (req.method === 'POST' && req.url.endsWith('/session/sess_1/message')) {
      const body = JSON.parse(req.body);
      assert.equal(body.model, 'opencode/space-bunny-free');
      assert.equal(body.agent, 'researcher');
      assert.equal(body.parts[0].type, 'text');
      assert.match(body.parts[0].text, /analyze this site/);
      return json({
        info: { cost: 0.01, tokens: { input: 10, output: 5 } },
        parts: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }],
      });
    }
    if (req.method === 'DELETE' && req.url.endsWith('/session/sess_1')) return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  });
  const t = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: fetch });

  const out = await t.runPrompt('analyze this site', { model: 'opencode/space-bunny-free', agent: 'researcher' });
  assert.equal(out.text, 'Hello there');
  assert.equal(out.cost, 0.01);

  const methods = fetch.requests.map((r) => `${r.method} ${r.url}`);
  assert.deepEqual(methods, [
    'POST https://oc.example/session',
    'POST https://oc.example/session/sess_1/message',
    'DELETE https://oc.example/session/sess_1',
  ]);
});

test('transport: HTTP runPrompt without a model or without output is an AI error', async () => {
  const t = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: stubFetch(() => json({})) });
  await assert.rejects(() => t.runPrompt('hi', {}), (e) => e.code === 'AI_PROVIDER_ERROR');

  const empty = new HttpTransport({
    baseUrl: 'https://oc.example',
    fetchImpl: stubFetch((req) => (req.url.endsWith('/session') && req.method === 'POST'
      ? json({ id: 's' })
      : json({ info: {}, parts: [{ type: 'tool', tool: 'webfetch' }] }))),
  });
  await assert.rejects(
    () => empty.runPrompt('hi', { model: 'a/b' }),
    (e) => e.code === 'AI_PROVIDER_ERROR' && /no text output/.test(e.message),
  );
});

test('transport: HTTP failures map onto the shared retry taxonomy', async () => {
  const cases = [
    [json({ error: 'boom' }, 500), (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable],
    [json({ error: 'busy' }, 429), (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable],
    [json({ error: 'nope' }, 401), (e) => e.code === 'UNAUTHENTICATED' && !e.retryable],
    [json({ error: 'gone' }, 404), (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable],
  ];
  for (const [response, check] of cases) {
    const t = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: async () => response });
    await assert.rejects(() => t.version(), check, `HTTP ${response.status}`);
  }

  const aborted = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const timeout = new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: aborted, timeoutMs: 20 });
  await assert.rejects(
    () => timeout.version(),
    (e) => e.code === 'AI_TIMEOUT' && e.retryable,
  );

  const down = new HttpTransport({
    baseUrl: 'https://oc.example',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  await assert.rejects(() => down.version(), (e) => e.code === 'AI_PROVIDER_ERROR' && e.retryable);
});

test('AIRuntime over HTTP: catalog, complete and diagnose use the transport', async () => {
  const db = fakeDb();
  const fetch = stubFetch((req) => {
    if (req.url.endsWith('/global/health')) return json({ healthy: true, version: '9.9.9' });
    if (req.url.endsWith('/config/providers')) {
      return json({ providers: [{ id: 'opencode', models: { 'space-bunny-free': {} } }] });
    }
    if (req.url.endsWith('/session') && req.method === 'POST') return json({ id: 's1' });
    if (req.url.endsWith('/session/s1/message')) return json({ info: {}, parts: [{ type: 'text', text: '{"ok":true}' }] });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });

  const ai = new AIRuntime({ db, transport: new HttpTransport({ baseUrl: 'https://oc.example', fetchImpl: fetch }) });

  const models = await ai.catalog();
  assert.deepEqual(models.map((m) => m.id), ['opencode/space-bunny-free']);
  assert.equal((await ai.catalog()).length, 1, 'second call is served from cache');

  const out = await ai.complete(1, 'test', { system: '', prompt: 'hi' });
  assert.equal(out.text, '{"ok":true}');

  const diag = await ai.diagnose();
  assert.equal(diag.ok, true);
  assert.equal(diag.transport, 'http');
  assert.equal(diag.version, '9.9.9');
  assert.equal(diag.bin, null, 'no binary is involved over HTTP');
  assert.equal(JSON.stringify(diag).includes('password'), false);
});
