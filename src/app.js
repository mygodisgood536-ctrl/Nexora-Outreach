import path from 'node:path';
import { fileURLToPath } from 'node:url';

import config from './config.js';
import { createSystem } from './system.js';
import { createServer } from './http/server.js';
import { createLogger } from './core/logger.js';

const log = createLogger('app');

/**
 * Application entry point.
 *
 * `npm start` boots three real things and wires them to the same database:
 *   1. the HTTP API,
 *   2. the scheduler, which opens scouting windows on the mission schedule,
 *   3. the worker runtime, which claims and executes queued jobs.
 */
/**
 * Boot the API, scheduler and worker, and wire them to one database.
 *
 * Exported so tests can start and stop the real application (including the
 * graceful-shutdown path) without spawning a separate process.
 */
export async function start({ system: injected, cfg = config } = {}) {
  const system = injected ?? createSystem();

  // Verify the central AI runtime is reachable before accepting traffic, so a
  // misconfigured install fails loudly instead of at the first outreach.
  const ai = await system.services.aiRuntime.diagnose();
  if (ai.ok) {
    log.info(`OpenCode ready: ${ai.version} with ${ai.modelCount} model(s) from ${ai.bin}`);
  } else {
    log.warn(`OpenCode is not reachable yet: ${ai.error}`);
    log.warn('Discovery and research still work; AI stages will retry until it is available.');
  }

  const server = createServer(system);
  await new Promise((resolve) => server.listen(cfg.port, resolve));
  log.info(`HTTP API listening on http://localhost:${cfg.port}`);

  await system.scheduler.start();
  await system.worker.start();

  let stopped = false;
  /**
   * Stop accepting work, then release resources. Anything already in flight
   * stays in the queue and is recovered on the next start.
   */
  async function stop(reason = 'shutdown') {
    if (stopped) return;
    stopped = true;
    log.info(`${reason} — stopping safely`);
    await system.scheduler.stop();
    await system.worker.stop();
    await new Promise((resolve) => server.close(resolve));
    system.db.close();
    log.info('Stopped.');
  }

  return { system, server, port: cfg.port, stop, get stopped() { return stopped; } };
}

async function main() {
  const app = await start();
  log.info('Nexora Outreach is running. Press Ctrl+C to stop.');

  const shutdown = (signal) => {
    app.stop(signal).then(
      () => process.exit(0),
      (e) => {
        log.error('shutdown failed', { message: e?.message });
        process.exit(1);
      }
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot when this file is the process entry point, so tests can import
// `start` without launching a second application.
const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((e) => {
    log.error('failed to start', { message: e?.message });
    console.error(e);
    process.exit(1);
  });
}