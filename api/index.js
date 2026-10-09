// Vercel Node.js function entry point.
//
// The whole app is one request listener (`createHandler`), so both the API
// routes and the static single-page app are served from here. The system (DB
// pool, services, worker, scheduler) is built once per warm instance and reused
// across invocations; the scheduler/worker loops are NOT started here — Vercel
// Cron drives them through /api/cron/tick instead (see src/http/routes/system.js).
import { createSystem } from '../src/system.js';
import { createHandler } from '../src/http/server.js';

let handlerPromise = null;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const system = createSystem();
      // Idempotent: brings a fresh Neon database up to the current schema.
      await system.db.migrate();
      return createHandler(system);
    })();
  }
  return handlerPromise;
}

export default async function handler(req, res) {
  try {
    const handle = await getHandler();
    return await handle(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
    }
    res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: 'The server could not handle that request.' }));
  }
}