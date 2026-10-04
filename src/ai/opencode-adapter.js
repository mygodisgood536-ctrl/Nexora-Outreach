import { spawn } from 'node:child_process';
import config from '../config.js';
import { createLogger } from '../core/logger.js';
import { err } from '../core/errors.js';

const log = createLogger('opencode');

const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g;
const stripAnsi = (s) => String(s).replace(ANSI, '');

/** Run the OpenCode binary and capture stdout. Rejects with a typed error. */
function runOpenCode(args, { timeoutMs = config.opencode.timeoutMs, input = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // `.cmd`/`.bat` shims require a shell on Windows; real executables do
      // not, and avoiding the shell keeps multi-line prompts safe.
      const needsShell = /\.(cmd|bat)$/i.test(config.opencode.bin);
      child = spawn(config.opencode.bin, args, {
        windowsHide: true,
        shell: needsShell,
        stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(err.ai('AI_PROVIDER_ERROR', `Could not start OpenCode (${config.opencode.bin}): ${e.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      reject(err.ai('AI_TIMEOUT', `OpenCode timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(err.ai('AI_PROVIDER_ERROR', `OpenCode process error: ${e.message}`, e.message));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code !== 0) {
        reject(err.ai('AI_PROVIDER_ERROR', `OpenCode exited with code ${code}`, stripAnsi(stderr).slice(0, 2000)));
      } else {
        resolve({ stdout, stderr: stripAnsi(stderr) });
      }
    });

    if (input && child.stdin) { child.stdin.write(input); child.stdin.end(); }
  });
}

/**
 * Provider/model catalog — ALWAYS read live from the installed OpenCode.
 * Spec §7/§31: discovery must come from OpenCode, never from a hard-coded
 * Nexora list, so newly available models appear without code changes.
 */
export async function listModels({ refresh = false } = {}) {
  const args = ['models'];
  if (refresh) args.push('--refresh');
  let stdout;
  try {
    ({ stdout } = await runOpenCode(args, { timeoutMs: 60000 }));
  } catch (e) {
    log.warn('model discovery failed', e.message);
    throw e;
  }

  const models = [];
  const seen = new Set();
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // OpenCode prints one `provider/model` id per line.
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/);
    if (!m) continue;
    const id = `${m[1]}/${m[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, provider: m[1], model: m[2] });
  }
  if (models.length === 0) {
    throw err.ai('AI_PROVIDER_ERROR', 'OpenCode returned no models. Is OpenCode installed and reachable?');
  }
  return models;
}

export async function listProviders() {
  const { stdout } = await runOpenCode(['providers', 'list'], { timeoutMs: 30000 });
  return stripAnsi(stdout).trim();
}

export async function opencodeVersion() {
  const { stdout } = await runOpenCode(['--version'], { timeoutMs: 20000 });
  return stripAnsi(stdout).trim();
}

/**
 * Execute a prompt and return the assistant's text.
 * Uses `--format json` so we consume OpenCode's real event stream rather than
 * scraping human-readable output.
 */
export async function runPrompt(prompt, { model, agent = null, dir = config.root, timeoutMs = config.opencode.timeoutMs } = {}) {
  if (!model) throw err.ai('AI_PROVIDER_ERROR', 'No provider/model selected for AI execution.');
  const args = ['run', prompt, '--format', 'json', '--model', model, '--dir', dir, '--pure'];
  if (agent) args.push('--agent', agent);

  const { stdout, stderr } = await runOpenCode(args, { timeoutMs });

  let text = '';
  let sawTextEvent = false;
  let cost = null;
  let tokens = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; }
    const part = evt.part || {};
    if (evt.type === 'text' || part.type === 'text') {
      if (typeof part.text === 'string' && part.text) { text += part.text; sawTextEvent = true; }
    } else if (evt.type === 'step_finish' || part.type === 'step-finish') {
      if (typeof part.cost === 'number') cost = part.cost;
      if (part.tokens) tokens = part.tokens;
    }
  }

  if (!sawTextEvent) {
    throw err.ai('AI_PROVIDER_ERROR', 'OpenCode returned no text output.', (stderr || stdout).slice(0, 1000));
  }
  return { text: text.trim(), cost, tokens };
}

export { runOpenCode, stripAnsi };