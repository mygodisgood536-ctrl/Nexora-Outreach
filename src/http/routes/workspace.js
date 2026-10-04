import { err } from '../../core/errors.js';
import { requireUser } from '../middleware.js';
import { STAGE } from '../../workers/queue.js';

/**
 * Mission, lead, conversation, notification, activity and suppression routes.
 *
 * Every handler resolves the caller's id and delegates to the existing
 * services, which enforce ownership. No business logic is duplicated here.
 */
export function registerWorkspaceRoutes(router, system) {
  const { db, missions, leads, conversations, notifications, suppression, queue } = system;

  // ── Missions (spec §8, §22, §26) ───────────────────────────────
  router.get('/api/missions', (ctx) => {
    const user = requireUser(ctx);
    const includeArchived = ctx.query.includeArchived === '1';
    ctx.json(200, {
      missions: missions.list(user.id, { includeArchived }).map((m) => missions.toPublic(m)),
    });
  });

  router.post('/api/missions', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    const mission = missions.create(user.id, {
      name: body.name,
      objective_raw: body.objectiveRaw ?? null,
      service: body.service || 'other',
      offer_summary: body.offerSummary ?? null,
      target_description: body.targetDescription ?? null,
      investigation_notes: body.investigationNotes ?? null,
      outreach_instructions: body.outreachInstructions ?? null,
      sending_mode: body.sendingMode || 'scout_only',
      timezone: body.timezone || user.timezone || 'UTC',
      follow_up_delay_days: body.followUpDelayDays ?? 2,
      max_follow_ups: body.maxFollowUps ?? 3,
      daily_send_limit: body.dailySendLimit ?? 20,
      max_leads_per_run: body.maxLeadsPerRun ?? 25,
      windows: body.windows,
      locations: body.locations,
    });
    ctx.json(201, { mission: missions.toPublic(mission) });
  });

  router.get('/api/missions/:id', (ctx) => {
    const user = requireUser(ctx);
    const mission = missions.getForUser(toId(ctx.params.id), user.id);
    ctx.json(200, { mission: missions.toPublic(mission) });
  });

  router.patch('/api/missions/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    missions.getForUser(id, user.id);
    const body = await ctx.body();
    const mission = missions.update(id, {
      name: body.name,
      objective_raw: body.objectiveRaw,
      service: body.service,
      offer_summary: body.offerSummary,
      target_description: body.targetDescription,
      investigation_notes: body.investigationNotes,
      outreach_instructions: body.outreachInstructions,
      sending_mode: body.sendingMode,
      timezone: body.timezone,
      follow_up_delay_days: body.followUpDelayDays,
      max_follow_ups: body.maxFollowUps,
      daily_send_limit: body.dailySendLimit,
      max_leads_per_run: body.maxLeadsPerRun,
      windows: body.windows,
      locations: body.locations,
    });
    ctx.json(200, { mission: missions.toPublic(mission) });
  });

  router.post('/api/missions/:id/activate', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: missions.toPublic(missions.activate(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/pause', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: missions.toPublic(missions.pause(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/resume', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: missions.toPublic(missions.resume(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/stop', (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    missions.getForUser(id, user.id);
    // Safe stop: queued work is cancelled, in-flight work stays recoverable.
    const cancelled = queue.cancelQueued({ missionId: id });
    ctx.json(200, { mission: missions.toPublic(missions.stop(id, user.id)), cancelledJobs: cancelled });
  });

  router.post('/api/missions/:id/duplicate', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(201, { mission: missions.toPublic(missions.duplicate(toId(ctx.params.id), user.id)) });
  });

  router.delete('/api/missions/:id', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: missions.toPublic(missions.archive(toId(ctx.params.id), user.id)) });
  });

  /** Run a mission now, through the real queue — never a direct handler call. */
  router.post('/api/missions/:id/run-now', (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    const mission = missions.getForUser(id, user.id);
    const locations = missions.locations(id);
    if (!locations.length) throw err.validation('Add a target location before running.');
    let enqueued = 0;
    for (const location of locations) {
      const { created } = queue.enqueue({
        userId: user.id, missionId: id, stage: STAGE.DISCOVERY,
        payload: { location, limit: mission.max_leads_per_run },
        idempotencyKey: `manual:${id}:${location.country}:${location.city || '*'}:${Date.now()}`,
      });
      if (created) enqueued++;
    }
    ctx.json(202, { enqueued });
  });

  router.get('/api/missions/:id/activity', (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    missions.getForUser(id, user.id);
    ctx.json(200, { jobs: queue.recent({ userId: user.id, missionId: id, limit: 50 }) });
  });
// ── Leads (spec §14, §21) ───────────────────────────────────────
  router.get('/api/leads', (ctx) => {
    const user = requireUser(ctx);
    const rows = leads.list(user.id, {
      missionId: ctx.query.missionId ? toId(ctx.query.missionId) : null,
      status: ctx.query.status || null,
      limit: Math.min(Number(ctx.query.limit) || 50, 200),
      offset: Number(ctx.query.offset) || 0,
    });
    ctx.json(200, { leads: rows.map((l) => leads.toPublic(l)), total: leads.count(user.id) });
  });

  router.get('/api/leads/:id', (ctx) => {
    const user = requireUser(ctx);
    const lead = leads.getForUser(toId(ctx.params.id), user.id);
    const conversation = conversations.getFor(lead.id, lead.mission_id) || null;
    ctx.json(200, {
      lead: leads.toPublic(lead),
      websiteAnalysis: leads.websiteAnalysis(lead.id),
      presenceAnalysis: leads.presenceAnalysis(lead.id),
      qualification: leads.qualification(lead.id),
      conversation,
      // Section 21 requires the whole prospect view on one screen: the message
      // history, where the follow-up schedule stands, and whether this recipient
      // is still contactable.
      messages: conversation ? conversations.messagesFor(conversation.id) : [],
      followUps: conversation ? conversations.followUpsFor(conversation.id) : [],
      suppression: conversations.suppressionStatusFor(user.id, lead, conversation?.id ?? null),
    });
  });

  // ── Conversations (spec §18) ───────────────────────────────────
  router.get('/api/conversations', (ctx) => {
    const user = requireUser(ctx);
    const rows = conversations.listForUser(user.id, {
      status: ctx.query.status || null,
      limit: Math.min(Number(ctx.query.limit) || 50, 200),
    });
    ctx.json(200, { conversations: rows });
  });

  router.get('/api/conversations/:id', (ctx) => {
    const user = requireUser(ctx);
    const conversation = conversations.getById(toId(ctx.params.id));
    // Ownership is checked before any related record is read.
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Conversation');
    ctx.json(200, {
      conversation,
      messages: conversations.messagesFor(conversation.id),
      lead: leads.toPublic(leads.get(conversation.lead_id)),
    });
  });

  /** Approve a drafted message so the email stage may send it (§27). */
  router.post('/api/messages/:id/approve', (ctx) => {
    const user = requireUser(ctx);
    const message = system.db.get('SELECT * FROM outreach_messages WHERE id = ?', toId(ctx.params.id));
    if (!message) throw err.notFound('Message');
    const conversation = conversations.getById(message.conversation_id);
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Message');
    ctx.json(200, { message: conversations.markApproved(message.id) });
  });

  /** Decline a drafted message (spec §21 user actions, §27). */
  router.post('/api/messages/:id/reject', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    const message = system.db.get('SELECT * FROM outreach_messages WHERE id = ?', id);
    if (!message) throw err.notFound('Message');
    const conversation = conversations.getById(message.conversation_id);
    // Ownership is checked before any state is changed.
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Message');
    const body = await ctx.body();
    ctx.json(200, { message: conversations.markRejected(id, body.reason || null) });
  });

  // ── Notifications (spec §25) ──────────────────────────────────
  router.get('/api/notifications', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      notifications: notifications.list(user.id, {
        unreadOnly: ctx.query.unread === '1',
        limit: Math.min(Number(ctx.query.limit) || 50, 200),
      }),
      unread: notifications.unreadCount(user.id),
    });
  });

  router.post('/api/notifications/:id/read', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { updated: notifications.markRead(user.id, toId(ctx.params.id)) });
  });

  router.post('/api/notifications/read-all', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { updated: notifications.markAllRead(user.id) });
  });

  // ── Activity (spec §36) ───────────────────────────────────────
  router.get('/api/activity', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      jobs: queue.recent({ userId: user.id, limit: Math.min(Number(ctx.query.limit) || 50, 200) }),
      stats: queue.stats({ userId: user.id }),
      audit: db.all(
        'SELECT * FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id
      ),
    });
  });

  // ── Suppression (spec §17, §29) ──────────────────────────────
  router.get('/api/suppressions', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { suppressions: suppression.list(user.id) });
  });

  router.post('/api/suppressions', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    const result = suppression.add(user.id, {
      scope: String(body.scope || 'email'),
      value: String(body.value || ''),
      reason: body.reason ?? null,
      source: 'manual',
    });
    if (!result) throw err.validation('That suppression value is not valid.');
    ctx.json(201, { suppression: result });
  });

  router.delete('/api/suppressions/:id', (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { removed: suppression.remove(user.id, toId(ctx.params.id)) });
  });

  // ── Dashboard summary (spec §20) ──────────────────────────────
  router.get('/api/dashboard', (ctx) => {
    const user = requireUser(ctx);
    const mine = missions.list(user.id);
    const active = mine.filter((m) => ['scheduled', 'running'].includes(m.status));
    const stats = queue.stats({ userId: user.id });
    const emailState = system.email.statusFor(user.id);
    const mailboxConnected = emailState.some((p) => p.connection?.status === 'connected');

    // Section 20 "messages generated/sent" counts messages, not leads.
    const messagesGenerated = countWhere(
      db, 'outreach_messages', 'mission_id IN (SELECT id FROM missions WHERE user_id = ?)', user.id
    );
    const messagesSent = countWhere(
      db, 'outreach_messages',
      "mission_id IN (SELECT id FROM missions WHERE user_id = ?) AND send_status = 'sent'", user.id
    );

    // Section 20 "current scouting state": whether automation can run at all.
    const scoutingState = user.automationPaused
      ? 'paused'
      : (mailboxConnected ? (active.length ? 'running' : 'idle') : 'needs_mailbox');

    const criticalUnread = countWhere(
      db, 'notifications', "user_id = ? AND read_at IS NULL AND severity = 'critical'", user.id
    );
    const followUpsDue = countWhere(
      db,
      'follow_ups',
      `status = 'pending' AND due_at <= datetime('now')
         AND mission_id IN (SELECT id FROM missions WHERE user_id = ?)`,
      user.id
    );

    // Section 20 "items requiring attention": concrete, actionable reasons only.
    const attention = [];
    if (!mailboxConnected) attention.push({ kind: 'mailbox_not_connected', count: 1 });
    if (user.automationPaused) attention.push({ kind: 'automation_paused', count: 1 });
    if (criticalUnread > 0) attention.push({ kind: 'critical_notifications', count: criticalUnread });
    if ((stats.failed || 0) > 0) attention.push({ kind: 'failed_jobs', count: stats.failed });
    if (followUpsDue > 0) attention.push({ kind: 'follow_ups_due', count: followUpsDue });

    ctx.json(200, {
      missions: { total: mine.length, active: active.length },
      leads: {
        discovered: leads.count(user.id),
        qualified: countWhere(db, 'leads', 'user_id = ? AND status = ?', user.id, 'qualified'),
        sent: countWhere(db, 'leads', 'user_id = ? AND status = ?', user.id, 'sent'),
      },
      websitesAnalyzed: countWhere(
        db,
        'website_analyses',
        'ok = 1 AND lead_id IN (SELECT id FROM leads WHERE user_id = ?)',
        user.id
      ),
      messages: { generated: messagesGenerated, sent: messagesSent },
      conversations: {
        replied: countWhere(db, 'conversations', 'user_id = ? AND status = ?', user.id, 'reply_received'),
        followUpPending: countWhere(
          db,
          'follow_ups',
          `status = 'pending' AND mission_id IN (SELECT id FROM missions WHERE user_id = ?)`,
          user.id
        ),
        followUpsDue,
      },
      jobs: stats,
      notifications: { unread: notifications.unreadCount(user.id), criticalUnread },
      scoutingState,
      itemsRequiringAttention: attention,
      unreadNotifications: notifications.unreadCount(user.id),
      nextScouting: active
        .map((m) => ({ missionId: m.id, name: m.name, nextRunAt: missions.computeNextRun(m) }))
        .filter((m) => m.nextRunAt),
      automationPaused: user.automationPaused,
      email: emailState,
    });
  });
}

function toId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw err.validation('Invalid id.');
  return id;
}

function countWhere(db, table, clause, ...params) {
  return db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${clause}`, ...params).n;
}