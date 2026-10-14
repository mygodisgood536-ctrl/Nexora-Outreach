import config from './config.js';
import { getDb } from './db/index.js';
import { AIRuntime } from './ai/runtime.js';
import { AITasks } from './ai/tasks.js';
import { EmailService } from './email/provider.js';
import { GoogleEmailProvider } from './email/google.js';
import { MicrosoftEmailProvider } from './email/microsoft.js';
import { ResendEmailProvider } from './email/resend.js';
import { MissionService } from './services/missions.js';
import { LeadService } from './services/leads.js';
import { SuppressionService } from './services/suppression.js';
import { EmailConnectionStore } from './services/email-store.js';
import { ConversationService } from './services/conversations.js';
import { ProspectService } from './services/prospect.js';
import { EvidenceService } from './services/evidence.js';
import { MessageQualityService } from './services/message-quality.js';
import { recordAudit, CRON_TICK_ACTION } from './services/audit.js';
import { NotificationService } from './services/notifications.js';
import { AuthService } from './services/auth.js';
import { JobQueue, STAGE } from './workers/queue.js';
import { WorkerRuntime } from './workers/runtime.js';
import { Scheduler } from './workers/scheduler.js';
import { discoveryHandler, researchHandler } from './workers/handlers-discovery.js';
import { siteAnalysisHandler, qualificationHandler } from './workers/handlers-analysis.js';
import { outreachHandler, emailHandler } from './workers/handlers-outreach.js';
import { mailboxMonitorHandler, followUpHandler } from './workers/handlers-monitoring.js';

/**
 * Composition root: builds the one real object graph from the modules that
 * exist, and returns it. Nothing is stubbed here — every dependency is the
 * real service. Tests can pass overrides for outbound integrations only.
 */
export function createSystem({ db, config: cfg = config, overrides = {} } = {}) {
  const database = db || getDb();

  const aiRuntime = overrides.ai ?? new AIRuntime({ db: database });
  const aiTasks = new AITasks({ ai: aiRuntime });

  const emailStore = new EmailConnectionStore({ db: database });
  const email = new EmailService({ db: database, store: emailStore });
  email.register(new GoogleEmailProvider({ config: cfg }));
  email.register(new MicrosoftEmailProvider({ config: cfg }));
  email.register(new ResendEmailProvider({ config: cfg }));

  const missions = new MissionService({ db: database });
  const leads = new LeadService({ db: database });
  const suppression = overrides.suppression ?? new SuppressionService({ db: database });
  const conversations = new ConversationService({ db: database, suppression, config: cfg });
  const notifications = new NotificationService({ db: database });
  const auth = new AuthService({ db: database, sessionTtlHours: cfg.sessionTtlHours });
  const queue = new JobQueue(database);
  const evidence = new EvidenceService({ db: database });
  // §15: deterministic, server-side message quality gate used at the send boundary.
  const messageQuality = overrides.messageQuality ?? new MessageQualityService({ db: database, leads });
  const prospect = new ProspectService({ db: database, leads, conversations, ai: aiTasks, emailStore, queue, evidence, messageQuality });

  const services = {
    ai: aiTasks,
    aiRuntime,
    missions, leads, suppression, conversations, notifications,
    prospect, evidence, messageQuality,
    emailStore, email, auth, queue, config: cfg,
    ...overrides.services,
  };

  const worker = new WorkerRuntime({
    db: database, queue, services, leaseMs: cfg.research ? 10 * 60 * 1000 : 10 * 60 * 1000,
  });
  worker.registerAll({
    [STAGE.DISCOVERY]: discoveryHandler,
    [STAGE.RESEARCH]: researchHandler,
    [STAGE.SITE_ANALYSIS]: siteAnalysisHandler,
    [STAGE.QUALIFICATION]: qualificationHandler,
    [STAGE.OUTREACH]: outreachHandler,
    [STAGE.EMAIL]: emailHandler,
    [STAGE.MAILBOX_MONITOR]: mailboxMonitorHandler,
    [STAGE.FOLLOW_UP]: followUpHandler,
  });

  const scheduler = new Scheduler({ db: database, queue, missions });

  /**
   * Opportunistic automation driver (§10/§26/§30).
   *
   * On a serverless host the Cron may only fire once a day, which cannot honour
   * time-window scouting. This runs the exact same idempotent tick the Cron
   * runs — recovery, due-window discovery, follow-ups, monitoring, bounded
   * drain — on ordinary API traffic. It is throttled per warm instance and
   * never awaited by a request, so it cannot affect request latency. The atomic
   * queue claims make concurrent instances safe.
   */
  let autoTickAt = 0;
  let autoTickInFlight = false;
  const autoTick = async () => {
    const opts = cfg.automation || {};
    if (!opts.autoTick) return null;
    const now = Date.now();
    if (autoTickInFlight || now - autoTickAt < (cfg.automation.autoTickIntervalMs || 0)) return null;
    autoTickAt = now;
    autoTickInFlight = true;
    try {
      const scouted = await scheduler.tick();
      const drained = await worker.drain({ maxJobs: cfg.automation.autoTickMaxJobs || 10 });
      // Record the same audit row the Cron route writes, so `lastRunAt` proves
      // automation ran even when the opportunistic path, not the Cron, drove it.
      await recordAudit(database, {
        actor: 'system', action: CRON_TICK_ACTION,
        detail: { source: 'opportunistic', scouted: scouted.length, drained: drained.length },
      });
      return { scouted: scouted.length, drained: drained.length };
    } finally {
      autoTickInFlight = false;
    }
  };

  return {
    db: database, config: cfg, services, worker, scheduler, queue,
    opportunisticTick: autoTick,
    ...services,
  };
}

export default createSystem;