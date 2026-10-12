import test from 'node:test';
import assert from 'node:assert/strict';

import { ResendEmailProvider } from '../../src/email/resend.js';
import { GoogleEmailProvider } from '../../src/email/google.js';
import { EmailService } from '../../src/email/provider.js';
import { EmailConnectionStore } from '../../src/services/email-store.js';
import { createTestDb } from '../../src/db/index.js';

const RESEND_CONFIG = { resend: { baseUrl: 'https://api.resend.com' }, google: {}, microsoft: {} };

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    async json() { return body; },
  };
}

function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

async function makeService() {
  const db = await createTestDb();
  await db.migrate();
  await db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, automation_paused, created_ms)
     VALUES('Ada', 'ada', 'ada', 'q?', 0, 0)`,
  );
  const store = new EmailConnectionStore({ db });
  const email = new EmailService({
    db,
    store,
    providers: {
      resend: new ResendEmailProvider({ config: RESEND_CONFIG }),
      google: new GoogleEmailProvider({ config: RESEND_CONFIG }),
    },
  });
  return { db, store, email };
}

test('resend: advertises an API-key flow and honest capabilities', () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  const meta = provider.describe();
  assert.equal(meta.id, 'resend');
  assert.equal(meta.authType, 'api_key');
  assert.equal(meta.configured, true, 'no server credentials are required');
  assert.equal(meta.capabilities.send, true);
  assert.equal(meta.capabilities.replies, false, 'Resend cannot surface inbound replies here');
  assert.ok(meta.fields.some((f) => f.name === 'apiKey' && f.secret));
  assert.ok(meta.fields.some((f) => f.name === 'fromEmail'));
  assert.ok(meta.requirements.length >= 1);
});

test('resend: validateCredential lists the visible sending domains', async () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  const stub = stubFetch(() => jsonResponse(200, {
    data: [{ name: 'acme.com', status: 'verified' }, { name: 'pending.io', status: 'pending' }],
  }));
  try {
    const info = await provider.validateCredential('re_test');
    assert.deepEqual(info.domains, [
      { name: 'acme.com', status: 'verified' },
      { name: 'pending.io', status: 'pending' },
    ]);
    assert.match(stub.calls[0].url, /api\.resend\.com\/domains$/);
    assert.equal(stub.calls[0].opts.headers.Authorization, 'Bearer re_test');
  } finally { stub.restore(); }
});

test('resend: a rejected key maps to MAILBOX_AUTH_FAILED', async () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  const stub = stubFetch(() => jsonResponse(401, { message: 'API key is invalid' }));
  try {
    await assert.rejects(
      () => provider.validateCredential('re_bad'),
      (e) => e.code === 'MAILBOX_AUTH_FAILED',
    );
  } finally { stub.restore(); }
});

test('resend: send carries an Idempotency-Key and returns the provider message id', async () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  const stub = stubFetch(() => jsonResponse(200, { id: 'msg_123' }));
  try {
    const out = await provider.sendMessage({
      accessToken: 're_key', from: 'team@acme.com', to: 'lead@example.com',
      subject: 'Hello', text: 'Body text', idempotencyKey: 'send:1:2:initial:1',
    });
    assert.equal(out.providerMessageId, 'msg_123');
    const body = JSON.parse(stub.calls[0].opts.body);
    assert.deepEqual(body.from, 'team@acme.com');
    assert.deepEqual(body.to, ['lead@example.com']);
    assert.equal(stub.calls[0].opts.headers['Idempotency-Key'], 'send:1:2:initial:1');
  } finally { stub.restore(); }
});

test('resend: error taxonomy classifies retryable vs permanent', async () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  const send = (status, body) => {
    const stub = stubFetch(() => jsonResponse(status, body));
    return provider.sendMessage({ accessToken: 'k', from: 'a@acme.com', to: 'b@x.com', subject: 's', text: 't' })
      .finally(() => stub.restore());
  };
  await assert.rejects(() => send(429, {}), (e) => e.code === 'PROVIDER_TEMPORARY' && e.retryable);
  await assert.rejects(() => send(500, {}), (e) => e.code === 'PROVIDER_TEMPORARY' && e.retryable);
  await assert.rejects(() => send(422, { message: 'domain not verified' }),
    (e) => e.code === 'SEND_FAILED' && !e.retryable);
  await assert.rejects(() => send(401, {}), (e) => e.code === 'MAILBOX_AUTH_FAILED' && !e.retryable);
});

test('resend: replies are empty because the provider has no inbound stream', async () => {
  const provider = new ResendEmailProvider({ config: RESEND_CONFIG });
  assert.deepEqual(await provider.fetchReplies({ accessToken: 'k' }), []);
});

test('email: connectApiKey stores the key encrypted and flags a verified sender', async () => {
  const { db, email } = await makeService();
  const stub = stubFetch(() => jsonResponse(200, { data: [{ name: 'acme.com', status: 'verified' }] }));
  try {
    const userId = (await db.get('SELECT id FROM users LIMIT 1')).id;
    const conn = await email.connectApiKey(userId, 'resend', {
      apiKey: 're_secret_key', fromEmail: 'team@acme.com',
    });
    assert.equal(conn.status, 'connected');
    assert.equal(conn.accountEmail, 'team@acme.com');
    assert.equal(conn.senderReady, true);
    assert.equal(conn.statusDetail, null);

    const row = await db.get('SELECT access_token_enc FROM email_connections WHERE user_id = ? AND provider = ?', userId, 'resend');
    assert.match(row.access_token_enc, /^v1:/, 'the key must be stored encrypted');
    assert.ok(!row.access_token_enc.includes('re_secret_key'), 'the raw key must never be persisted');
  } finally { stub.restore(); }
});

test('email: connectApiKey warns when the From domain is not verified yet', async () => {
  const { db, email } = await makeService();
  const stub = stubFetch(() => jsonResponse(200, { data: [{ name: 'other.com', status: 'verified' }] }));
  try {
    const userId = (await db.get('SELECT id FROM users LIMIT 1')).id;
    const conn = await email.connectApiKey(userId, 'resend', {
      apiKey: 're_secret_key', fromEmail: 'team@unverified.com',
    });
    assert.equal(conn.senderReady, false);
    assert.match(conn.statusDetail, /not verified/i);
  } finally { stub.restore(); }
});

test('email: connectApiKey rejects an OAuth provider and a bad From address', async () => {
  const { db, email } = await makeService();
  const userId = (await db.get('SELECT id FROM users LIMIT 1')).id;
  await assert.rejects(
    () => email.connectApiKey(userId, 'google', { apiKey: 'x', fromEmail: 'a@b.com' }),
    (e) => e.code === 'VALIDATION_FAILED',
  );
  await assert.rejects(
    () => email.connectApiKey(userId, 'resend', { apiKey: 're_x', fromEmail: 'not-an-email' }),
    (e) => e.code === 'VALIDATION_FAILED',
  );
});

test('email: replyCapable is false for Resend and true for an OAuth mailbox', async () => {
  const { db, email } = await makeService();
  const userId = (await db.get('SELECT id FROM users LIMIT 1')).id;
  assert.equal(await email.replyCapable(userId, 'resend'), false);
  assert.equal(await email.replyCapable(userId, 'google'), true);
});
