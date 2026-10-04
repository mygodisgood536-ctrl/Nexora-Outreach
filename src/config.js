import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal, dependency-free .env parser (supports KEY=VALUE, quotes, #comments). */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env'));

const env = process.env.NODE_ENV || 'development';
const isProd = env === 'production';

/**
 * Resolve the 32-byte AES-256-GCM key used to encrypt email authorization
 * tokens at rest (spec §5.3 "Encrypted storage for sensitive email
 * authorization tokens").
 *
 * In production a key MUST be supplied. In development we derive a stable
 * local key so the system is runnable out of the box, and persist it with
 * owner-only-ish permissions rather than silently using a constant.
 */
function resolveEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');

  if (isProd) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY is required in production. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  const keyFile = path.join(ROOT, '.data', 'dev-encryption.key');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  if (fs.existsSync(keyFile)) {
    const stored = fs.readFileSync(keyFile, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(stored)) return Buffer.from(stored, 'hex');
  }
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, generated);
  console.warn('[config] No TOKEN_ENCRYPTION_KEY set. Generated a local development key at');
  console.warn(`         ${keyFile}`);
  console.warn('         Set TOKEN_ENCRYPTION_KEY before running in production.');
  return Buffer.from(generated, 'hex');
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Locate the OpenCode binary without hard-coding a provider/model catalog.
 *
 * On Windows the npm install exposes a `opencode.cmd` shim, which Node cannot
 * spawn directly (EINVAL) without a shell. The shim points at a real
 * `opencode.exe`, so prefer that: spawning it directly avoids cmd.exe quoting
 * problems with multi-line AI prompts.
 */
function resolveOpencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;

  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmDir = path.join(process.env.APPDATA, 'npm');
    const candidates = [
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode'),
      path.join(npmDir, 'opencode.cmd'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  }
  return 'opencode';
}

const DATA_DIR = process.env.NEXORA_DATA_DIR || path.join(ROOT, '.data');

export const config = {
  env,
  isProd,
  root: ROOT,
  dataDir: DATA_DIR,
  dbFile: process.env.NEXORA_DB_FILE || path.join(DATA_DIR, 'nexora.db'),
  port: int('PORT', 4317),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${int('PORT', 4317)}`).replace(/\/+$/, ''),

  tokenEncryptionKey: resolveEncryptionKey(),
  sessionTtlHours: int('SESSION_TTL_HOURS', 72),
  sessionCookieName: 'nexora_session',

  opencode: {
    bin: resolveOpencodeBin(),
    defaultModel: process.env.OPENCODE_DEFAULT_MODEL || 'opencode/space-bunny-free',
    timeoutMs: int('OPENCODE_TIMEOUT_MS', 180000),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get configured() { return Boolean(this.clientId && this.clientSecret); },
  },

  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    tenant: process.env.MICROSOFT_TENANT || 'common',
    get configured() { return Boolean(this.clientId && this.clientSecret); },
  },

  discovery: {
    overpassUrl: process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
    googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || '',
  },

  research: {
    fetchDelayMs: int('RESEARCH_FETCH_DELAY_MS', 1500),
    timeoutMs: int('RESEARCH_TIMEOUT_MS', 20000),
    maxBytes: int('RESEARCH_MAX_BYTES', 2000000),
    respectRobots: bool('RESPECT_ROBOTS_TXT', true),
    // Overpass rejects browser-like agents and "localhost" contact URLs with
    // HTTP 406, so this identifies the crawler honestly (spec §24).
    userAgent: process.env.RESEARCH_USER_AGENT
      || 'NexoraOutreach/1.0 (autonomous prospecting research; https://nexora.example/bot)',
  },

  limits: {
    globalMaxSendsPerDay: int('GLOBAL_MAX_SENDS_PER_DAY', 50),
    defaultMaxFollowUps: int('DEFAULT_MAX_FOLLOW_UPS', 3),
    defaultFollowUpDelayDays: int('DEFAULT_FOLLOW_UP_DELAY_DAYS', 2),
  },
};

export default config;