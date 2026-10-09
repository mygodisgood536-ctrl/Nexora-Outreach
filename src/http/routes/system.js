import { createLogger } from '../../core/logger.js';
import config from '../../config.js';

const log = createLogger('cron');

/** Anonymous is fine: the shared secret is the authentication. */
const PUBLIC = { auth: false, csrf: false };

/**
 * §26 — the serverless automation driver.
 *
 * The scheduler and worker are normally long-running loops. Vercel's functions
 * are ephemeral, so instead of a loop we expose a single bounded tick that a
 * Cron can call: it advances due missions, enqueues follow-ups and monitoring,
 * then drains a limited number of jobs before returning. Everything is
 * idempotent, so overlapping or missed ticks are harmless.
 */
export function registerSystemRoutes(router, system) {
  const { scheduler, worker, queue } = system;

  const runTick = async (ctx) => {
    const supplied = String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    // Refuse to run queued automation for anyone who cannot prove they are the
    // Cron; without this the endpoint would be an open "drain my jobs" button.
    if (!config.cron.secret) {
      return ctx.json(503, { error: 'NOT_CONFIGURED', message: 'CRON_SECRET is not set on the server.' });
    }
    if (!timingSafeEqual(supplied, config.cron.secret)) {
      return ctx.json(401, { error: 'UNAUTHENTICATED', message: 'Invalid cron credentials.' });
    }

    const scouted = await scheduler.tick();
    const drained = await worker.drain({ maxJobs: config.cron.maxJobs });
    const stats = await queue.stats({});
    log.info(`cron tick: scouted ${scouted.length}, drained ${drained.length}`, { queued: stats.queued });
    ctx.json(200, {
      ok: true,
      scouted: scouted.length,
      drained: drained.length,
      jobs: stats,
    });
  };

  router.get('/api/cron/tick', runTick, PUBLIC);
  router.post('/api/cron/tick', runTick, PUBLIC);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}