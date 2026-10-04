import crypto from 'node:crypto';
import config from '../config.js';

// scrypt parameters (OWASP-aligned). Stored per-credential so they can be
// upgraded later without breaking existing rows.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/** Hash a security-answer with scrypt. Returns everything needed to verify. */
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return {
    algo: 'scrypt',
    salt_hex: salt.toString('hex'),
    hash_hex: hash.toString('hex'),
    params: JSON.stringify({ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen }),
  };
}

/** Constant-time verification against a stored scrypt record. */
export function verifySecret(secret, record) {
  if (!record || !record.salt_hex || !record.hash_hex) return false;
  try {
    const salt = Buffer.from(record.salt_hex, 'hex');
    const expected = Buffer.from(record.hash_hex, 'hex');
    const params = record.params ? JSON.parse(record.params) : SCRYPT;
    const actual = crypto.scryptSync(String(secret), salt, expected.length, {
      N: params.N, r: params.r, p: params.p,
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Symmetric encryption for email authorization tokens (spec §5.3) ──

/** AES-256-GCM. Output format: v1:<iv>:<tag>:<ciphertext> (all base64url). */
export function encrypt(plaintext, key = config.tokenEncryptionKey) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
}

export function decrypt(envelope, key = config.tokenEncryptionKey) {
  if (!envelope) return null;
  const parts = String(envelope).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed encrypted value');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

// ── Tokens ────────────────────────────────────────────────────────

/** Random bytes for one-time secrets such as recovery codes. */
export function randomBytes(n) {
  return crypto.randomBytes(n);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Session tokens are stored hashed; the raw token only ever leaves the server once. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}