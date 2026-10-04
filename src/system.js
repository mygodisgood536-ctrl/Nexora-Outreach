import config from './config.js';
import { getDb } from './db/index.js';
import { AIRuntime } from './ai/runtime.js';
import { AITasks } from './ai/tasks.js';
import { EmailService } from './email/provider.js';
import { GoogleEmailProvider } from './email/google.js';
import { MicrosoftEmailProvider } from './email/microsoft.js';
import { MissionService } from './services/missions.js';
import { LeadService } from './services/leads.js';
import { SuppressionService } from './services/suppression.js';
import { EmailConnectionStore } from './services/email-store.js';
import { ConversationService } from './services/conversations.js';
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

  const missions = new MissionService({ db: database });
  const leads = new LeadService({ db: database });
  const suppression = overrides.suppression ?? new SuppressionService({ db: database });
  const conversations = new ConversationService({ db: database, suppression, config: cfg });
  const notifications = new NotificationService({ db: database });
  const auth = new AuthService({ db: database, sessionTtlHours: cfg.sessionTtlHours });
  const queue = new JobQueue(database);

  const services = {
    ai: aiTasks,
    aiRuntime,
    missions, leads, suppression, conversations, notifications,
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

  return { db: database, config: cfg, services, worker, scheduler, queue, ...services };
}

export default createSystem;