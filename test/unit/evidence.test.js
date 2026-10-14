import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystem } from '../../src/system.js';
import { createTestDb } from '../../src/db/index.js';
import { sha256 } from '../../src/core/crypto.js';

async function fixture() {
  const system = createSystem({ db: createTestDb() });
  await system.db.migrate();
  await system.db.run(
    `INSERT INTO users(full_name, username, username_lower, security_question, created_ms)
     VALUES('T','t','t','q?',0)`
  );
  const userId = (await system.db.get('SELECT id FROM users WHERE username_lower=?', 't')).id;
  await system.db.run(`INSERT INTO missions(user_id, name, service) VALUES(?, 'M', 'website_design')`, userId);
  const missionId = (await system.db.get('SELECT id FROM missions WHERE user_id=?', userId)).id;
  await system.db.run(
    `INSERT INTO leads(user_id, mission_id, business_name, discovery_source, dedupe_key)
     VALUES(?,?, 'Acme', 'overpass', 'acme')`,
    userId, missionId
  );
  const leadId = (await system.db.get('SELECT id FROM leads WHERE user_id=?', userId)).id;
  return { system, userId, missionId, leadId, evidence: system.evidence };
}

test('evidence: each pass opens the next immutable audit version', async () => {
  const { evidence, userId, leadId } = await fixture();
  const v1 = await evidence.startAudit(userId, leadId, { trigger: 'research' });
  assert.equal(v1.version, 1);
  assert.equal(v1.status, 'running');
  const v2 = await evidence.startAudit(userId, leadId, { trigger: 'manual' });
  assert.equal(v2.version, 2);
  assert.notEqual(v1.id, v2.id);
});

test('evidence: items are bound to their version and hashed at write time', async () => {
  const { evidence, userId, leadId } = await fixture();
  const audit = await evidence.startAudit(userId, leadId, { trigger: 'research' });
  const payload = { hasWebsite: true, bytes: 1234 };
  const item = await evidence.record({
    auditId: audit.id, leadId, userId, kind: 'research', method: 'fetch', payload,
  });
  assert.equal(item.audit_id, audit.id);
  assert.equal(item.kind, 'research');
  assert.deepEqual(JSON.parse(item.payload), payload);
  assert.equal(item.hash, sha256(JSON.stringify(payload)));
});

test('evidence: latest audit reports the highest version with its evidence', async () => {
  const { evidence, userId, leadId } = await fixture();
  const v1 = await evidence.startAudit(userId, leadId, { trigger: 'research' });
  await evidence.record({ auditId: v1.id, leadId, userId, kind: 'research', payload: { a: 1 } });
  await evidence.finishAudit(v1.id, { status: 'succeeded' });
  const v2 = await evidence.startAudit(userId, leadId, { trigger: 'manual' });
  await evidence.record({ auditId: v2.id, leadId, userId, kind: 'presence', payload: { b: 2 } });

  const latest = await evidence.latestForLead(leadId);
  assert.equal(latest.version, 2);
  assert.equal(latest.evidence.length, 1);
  assert.equal(latest.evidence[0].kind, 'presence');

  const finished = await evidence.audit(v1.id);
  assert.equal(finished.status, 'succeeded');
  assert.ok(finished.finished_at);
});

test('evidence: recording without an audit version is rejected', async () => {
  const { evidence, userId, leadId } = await fixture();
  await assert.rejects(
    () => evidence.record({ auditId: null, leadId, userId, kind: 'research' }),
    /audit version/i,
  );
});
