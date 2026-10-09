import { err } from '../../core/errors.js';
import { requireUser } from '../middleware.js';
import { STAGE } from '../../workers/queue.js';
import { enforceRateLimit } from '../../services/rate-limit.js';

/**
 * Mission, lead, conversation, notification, activity and suppression routes.
 *
 * Every handler resolves the caller's id and delegates to the existing
 * services, which enforce ownership. No business logic is duplicated here.
 */
export function registerWorkspaceRoutes(router, system) {
  const { db, missions, leads, conversations, notifications, suppression, queue } = system;

  // ── Missions (spec §8, §22, §26) ───────────────────────────────
  router.get('/api/missions', async (ctx) => {
    const user = requireUser(ctx);
    const includeArchived = ctx.query.includeArchived === '1';
    const rows = await missions.list(user.id, { includeArchived });
    ctx.json(200, {
      missions: await Promise.all(rows.map((m) => missions.toPublic(m))),
    });
  });

  router.post('/api/missions', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    const mission = await missions.create(user.id, {
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
    ctx.json(201, { mission: await missions.toPublic(mission) });
  });

  /**
   * §8 — turn a plain-language objective into structured mission settings.
   *
   * The model proposes; the create form shows the result for review. Nothing
   * is persisted, so the user can reword and re-interpret freely before saving.
   */
  router.post('/api/missions/interpret', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    // One AI call per keystroke is not a use case; this bounds the spend a
    // runaway client can cause.
    await enforceRateLimit(db, `ai:interpret:${user.id}`, { limit: 20, windowMs: 60_000 });
    const interpretation = await system.ai.interpretMission(user.id, {
      objective: body.objective,
      existing: body.existing && typeof body.existing === 'object' ? body.existing : {},
    });
    ctx.json(200, { interpretation });
  });

  router.get('/api/missions/:id', async (ctx) => {
    const user = requireUser(ctx);
    const mission = await missions.getForUser(toId(ctx.params.id), user.id);
    ctx.json(200, { mission: await missions.toPublic(mission) });
  });

  router.patch('/api/missions/:id', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    await missions.getForUser(id, user.id);
    const body = await ctx.body();
    const mission = await missions.update(id, {
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
    ctx.json(200, { mission: await missions.toPublic(mission) });
  });

  router.post('/api/missions/:id/activate', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: await missions.toPublic(await missions.activate(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/pause', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: await missions.toPublic(await missions.pause(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/resume', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: await missions.toPublic(await missions.resume(toId(ctx.params.id), user.id)) });
  });

  router.post('/api/missions/:id/stop', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    await missions.getForUser(id, user.id);
    // Safe stop: queued work is cancelled, in-flight work stays recoverable.
    const cancelled = await queue.cancelQueued({ missionId: id });
    ctx.json(200, { mission: await missions.toPublic(await missions.stop(id, user.id)), cancelledJobs: cancelled });
  });

  router.post('/api/missions/:id/duplicate', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(201, { mission: await missions.toPublic(await missions.duplicate(toId(ctx.params.id), user.id)) });
  });

  router.delete('/api/missions/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { mission: await missions.toPublic(await missions.archive(toId(ctx.params.id), user.id)) });
  });

  /** Run a mission now, through the real queue — never a direct handler call. */
  router.post('/api/missions/:id/run-now', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    const mission = await missions.getForUser(id, user.id);
    const locations = await missions.locations(id);
    if (!locations.length) throw err.validation('Add a target location before running.');
    let enqueued = 0;
    for (const location of locations) {
      const { created } = await queue.enqueue({
        userId: user.id, missionId: id, stage: STAGE.DISCOVERY,
        payload: { location, limit: mission.max_leads_per_run },
        idempotencyKey: `manual:${id}:${location.country}:${location.city || '*'}:${Date.now()}`,
      });
      if (created) enqueued++;
    }
    ctx.json(202, { enqueued });
  });

  router.get('/api/missions/:id/activity', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    await missions.getForUser(id, user.id);
    ctx.json(200, { jobs: await queue.recent({ userId: user.id, missionId: id, limit: 50 }) });
  });

  // ── Leads (spec §14, §21) ───────────────────────────────────────
  router.get('/api/leads', async (ctx) => {
    const user = requireUser(ctx);
    const filters = {
      missionId: ctx.query.missionId ? toId(ctx.query.missionId) : null,
      status: ctx.query.status || null,
    };
    const rows = await leads.list(user.id, {
      ...filters,
      limit: Math.min(Number(ctx.query.limit) || 50, 200),
      offset: Number(ctx.query.offset) || 0,
    });
    ctx.json(200, {
      leads: rows.map((l) => leads.toPublic(l)),
      total: await leads.count(user.id, filters),
    });
  });

  router.get('/api/leads/:id', async (ctx) => {
    const user = requireUser(ctx);
    const lead = await leads.getForUser(toId(ctx.params.id), user.id);
    const conversation = (await conversations.getFor(lead.id, lead.mission_id)) || null;
    ctx.json(200, {
      lead: leads.toPublic(lead),
      websiteAnalysis: await leads.websiteAnalysis(lead.id),
      presenceAnalysis: await leads.presenceAnalysis(lead.id),
      qualification: await leads.qualification(lead.id),
      conversation,
      // Section 21 requires the whole prospect view on one screen: the message
      // history, where the follow-up schedule stands, and whether this recipient
      // is still contactable.
      messages: conversation ? await conversations.messagesFor(conversation.id) : [],
      followUps: conversation ? await conversations.followUpsFor(conversation.id) : [],
      suppression: await conversations.suppressionStatusFor(user.id, lead, conversation?.id ?? null),
    });
  });

  // ── Conversations (spec §18) ───────────────────────────────────
  router.get('/api/conversations', async (ctx) => {
    const user = requireUser(ctx);
    const rows = await conversations.listForUser(user.id, {
      status: ctx.query.status || null,
      limit: Math.min(Number(ctx.query.limit) || 50, 200),
    });
    ctx.json(200, { conversations: rows });
  });

  router.get('/api/conversations/:id', async (ctx) => {
    const user = requireUser(ctx);
    const conversation = await conversations.getById(toId(ctx.params.id));
    // Ownership is checked before any related record is read.
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Conversation');
    ctx.json(200, {
      conversation,
      messages: await conversations.messagesFor(conversation.id),
      lead: leads.toPublic(await leads.get(conversation.lead_id)),
    });
  });

  /**
   * Approve a drafted message so the email stage may send it (§27).
   *
   * Approval is what makes a Review & Send mission actionable: the email job
   * enqueued at draft time returned "awaiting approval", so a fresh job is
   * queued here. Without it, approving would leave the message stuck forever.
   */
  router.post('/api/messages/:id/approve', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    const before = await conversations.message(id);
    if (!before) throw err.notFound('Message');
    // Ownership is proven before anything else: another user probing this id
    // must not learn it exists.
    const conversation = await conversations.getById(before.conversation_id);
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Message');
    // Approving a message that already went out is a no-op, not a conflict:
    // the user is looking at history and expects the screen to accept it.
    if (before.send_status === 'sent') {
      ctx.json(200, { message: before, sendQueued: false });
      return;
    }
    const message = await conversations.approveMessage(user.id, id);

    if (message.send_status === 'draft') {
      const { created } = await queue.enqueue({
        userId: user.id,
        missionId: message.mission_id,
        stage: STAGE.EMAIL,
        payload: { leadId: message.lead_id, messageId: message.id, approvedVia: 'user' },
        // Approval is a distinct event from the original draft-time job, so it
        // needs its own idempotency key.
        idempotencyKey: `email:approved:${message.id}`,
      });
      ctx.json(200, { message, sendQueued: created });
      return;
    }
    ctx.json(200, { message, sendQueued: false });
  });

  /** Decline a drafted message (spec §21 user actions, §27). */
  router.post('/api/messages/:id/reject', async (ctx) => {
    const user = requireUser(ctx);
    const id = toId(ctx.params.id);
    const message = await conversations.message(id);
    if (!message) throw err.notFound('Message');
    const conversation = await conversations.getById(message.conversation_id);
    // Ownership is checked before any state is changed.
    if (!conversation || conversation.user_id !== user.id) throw err.notFound('Message');
    const body = await ctx.body();
    ctx.json(200, { message: await conversations.markRejected(id, body.reason || null) });
  });

  // ── Notifications (spec §25) ──────────────────────────────────
  router.get('/api/notifications', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      notifications: await notifications.list(user.id, {
        unreadOnly: ctx.query.unread === '1',
        limit: Math.min(Number(ctx.query.limit) || 50, 200),
      }),
      unread: await notifications.unreadCount(user.id),
    });
  });

  router.post('/api/notifications/:id/read', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { updated: await notifications.markRead(user.id, toId(ctx.params.id)) });
  });

  router.post('/api/notifications/read-all', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { updated: await notifications.markAllRead(user.id) });
  });

  // ── Activity (spec §36) ───────────────────────────────────────
  router.get('/api/activity', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, {
      jobs: await queue.recent({ userId: user.id, limit: Math.min(Number(ctx.query.limit) || 50, 200) }),
      stats: await queue.stats({ userId: user.id }),
      audit: await db.all(
        'SELECT * FROM audit_events WHERE user_id = ? ORDER BY id DESC LIMIT 50', user.id
      ),
    });
  });

  // ── Suppression (spec §17, §29) ──────────────────────────────
  router.get('/api/suppressions', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { suppressions: await suppression.list(user.id) });
  });

  router.post('/api/suppressions', async (ctx) => {
    const user = requireUser(ctx);
    const body = await ctx.body();
    const result = await suppression.add(user.id, {
      scope: String(body.scope || 'email'),
      value: String(body.value || ''),
      reason: body.reason ?? null,
      source: 'manual',
    });
    if (!result) throw err.validation('That suppression value is not valid.');
    ctx.json(201, { suppression: result });
  });

  router.delete('/api/suppressions/:id', async (ctx) => {
    const user = requireUser(ctx);
    ctx.json(200, { removed: await suppression.remove(user.id, toId(ctx.params.id)) });
  });

  // ── Dashboard summary (spec §20) ──────────────────────────────
  router.get('/api/dashboard', async (ctx) => {
    const user = requireUser(ctx);
    const mine = await missions.list(user.id);
    const active = mine.filter((m) => ['scheduled', 'running'].includes(m.status));
    const stats = await queue.stats({ userId: user.id });
    const emailState = await system.email.statusFor(user.id);
    const mailboxConnected = emailState.some((p) => p.connection?.status === 'connected');

    // Section 20 "messages generated/sent" counts messages, not leads.
    const messagesGenerated = await countWhere(
      db, 'outreach_messages', 'mission_id IN (SELECT id FROM missions WHERE user_id = ?)', user.id
    );
    const messagesSent = await countWhere(
      db, 'outreach_messages',
      "mission_id IN (SELECT id FROM missions WHERE user_id = ?) AND send_status = 'sent'", user.id
    );

    // Section 20 "current scouting state": whether automation can run at all.
    const scoutingState = user.automationPaused
      ? 'paused'
      : (mailboxConnected ? (active.length ? 'running' : 'idle') : 'needs_mailbox');

    const criticalUnread = await countWhere(
      db, 'notifications', "user_id = ? AND read_at IS NULL AND severity = 'critical'", user.id
    );
    const followUpsDue = await countWhere(
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

    const nextScouting = [];
    for (const m of active) {
      const nextRunAt = await missions.computeNextRun(m);
      if (nextRunAt) nextScouting.push({ missionId: m.id, name: m.name, nextRunAt });
    }

    ctx.json(200, {
      missions: { total: mine.length, active: active.length },
      leads: {
        discovered: await leads.count(user.id),
        qualified: await countWhere(db, 'leads', 'user_id = ? AND status = ?', user.id, 'qualified'),
        sent: await countWhere(db, 'leads', 'user_id = ? AND status = ?', user.id, 'sent'),
      },
      websitesAnalyzed: await countWhere(
        db,
        'website_analyses',
        'ok = 1 AND lead_id IN (SELECT id FROM leads WHERE user_id = ?)',
        user.id
      ),
      messages: { generated: messagesGenerated, sent: messagesSent },
      conversations: {
        replied: await countWhere(db, 'conversations', 'user_id = ? AND status = ?', user.id, 'reply_received'),
        followUpPending: await countWhere(
          db,
          'follow_ups',
          `status = 'pending' AND mission_id IN (SELECT id FROM missions WHERE user_id = ?)`,
          user.id
        ),
        followUpsDue,
      },
      jobs: stats,
      notifications: {
        unread: await notifications.unreadCount(user.id),
        criticalUnread,
      },
      scoutingState,
      itemsRequiringAttention: attention,
      unreadNotifications: await notifications.unreadCount(user.id),
      nextScouting,
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

async function countWhere(db, table, clause, ...params) {
  const row = await db.get(`SELECT COUNT(*) n FROM ${table} WHERE ${clause}`, ...params);
  return row?.n ?? 0;
}
