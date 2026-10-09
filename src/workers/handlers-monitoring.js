import { err } from '../core/errors.js';
import { normalizeEmail } from '../core/normalize.js';
import { sqliteUtc } from '../core/time.js';
import { sendKey } from './handlers-outreach.js';

/**
 * §18 Reply monitoring.
 *
 * A detected reply immediately persists conversation state, notifies the user
 * and cancels every pending follow-up for that prospect.
 */

function extractAddress(value) {
  if (!value) return null;
  const m = String(value).match(/<([^>]+)>/);
  return normalizeEmail(m ? m[1] : value);
}

/** §18 — poll the authorized mailbox and stop automation on the first reply. */
export async function mailboxMonitorHandler(ctx) {
  const { services, job } = ctx;
  const { email, conversations, notifications, ai, leads } = services;

  const replies = await email.replies(job.user_id);
  if (!replies.length) return { checked: 0, replies: 0 };

  // Only replies from businesses we actually contacted are actionable.
  const mine = new Map();
  for (const lead of await leads.list(job.user_id, { limit: 1000 })) {
    const addr = normalizeEmail(lead.email_public);
    if (addr) mine.set(addr, lead);
  }

  let handled = 0;
  for (const reply of replies) {
    const fromEmail = extractAddress(reply.from);
    const lead = fromEmail ? mine.get(fromEmail) : null;
    if (!lead) continue;

    const conversation = await conversations.getFor(lead.id, lead.mission_id);
    if (!conversation || conversation.status === 'reply_received') continue;

    await conversations.recordReply(conversation.id, {
      providerMessageId: reply.providerMessageId, threadKey: reply.threadKey,
    });
    await leads.setStatus(lead.id, 'replied');

    let summary = reply.text ? String(reply.text).slice(0, 300) : '';
    try {
      const triage = await ai.triageReply(job.user_id, {
        lead: { businessName: lead.business_name, emailPublic: lead.email_public },
        mission: { name: 'mission' },
        replyText: reply.text,
      });
      summary = triage.summary || summary;
      if (triage.is_opt_out) await conversations.recordOptOut(conversation.id, fromEmail);
    } catch {
      // A triage failure must never block the reply notification.
    }

    await notifications.create(job.user_id, {
      kind: 'reply', severity: 'critical',
      title: `New reply from ${lead.business_name}`,
      body: summary,
      missionId: lead.mission_id, leadId: lead.id,
    });
    handled++;
  }
  return { checked: replies.length, replies: handled };
}

/**
 * §19 — generate and send a follow-up when it is due and every policy allows
 * it. A reply, opt-out, bounce, suppression, mission pause, or a sending mode
 * that forbids sending all prevent the follow-up.
 */
export async function followUpHandler(ctx) {
  const { services, payload, job } = ctx;
  const { leads, conversations, ai, email, emailStore } = services;

  const conversationId = payload.conversationId;
  if (!conversationId) throw err.validation('follow_up requires a conversationId');
  const conversation = await conversations.getById(conversationId);
  if (!conversation) throw err.notFound('Conversation');

  const cancel = async (reason) => {
    await ctx.db.run(
      "UPDATE follow_ups SET status = 'cancelled', reason_cancelled = ? WHERE conversation_id = ? AND status = 'pending'",
      reason, conversationId
    );
    return { conversationId, cancelled: reason };
  };

  const pending = await ctx.db.get(
    "SELECT * FROM follow_ups WHERE conversation_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 1",
    conversationId
  );
  if (!pending) return { conversationId, skipped: 'no pending follow-up' };
  if (pending.due_at > sqliteUtc(new Date())) return { conversationId, skipped: 'not due' };

  const missionRow = await ctx.db.get('SELECT * FROM missions WHERE id = ?', pending.mission_id);
  if (missionRow.status !== 'scheduled') return cancel(`mission_${missionRow.status}`);
  if (conversation.status === 'reply_received') return cancel('prospect replied');
  if (missionRow.sending_mode === 'scout_only') return cancel('scout_only');

  const lead = await leads.get(pending.lead_id);
  if (!lead) return cancel('lead_missing');

  // Throws when the recipient is suppressed, bounced or complained about.
  const to = await conversations.assertSendable(job.user_id, pending.mission_id, lead, conversation.id);

  const connection = await emailStore.activeFor(job.user_id);
  const evidence = await leads.evidenceFor(lead.id);
  const draft = await ai.writeOutreach(job.user_id, {
    lead: evidence.lead,
    analysis: { website: evidence.website, presence: evidence.presence },
    mission: {
      service: missionRow.service,
      offer_summary: missionRow.offer_summary,
      outreach_instructions: missionRow.outreach_instructions,
    },
    senderName: ctx.user?.full_name || 'Nexora Outreach',
    senderEmail: connection?.account_email,
    followUpNumber: pending.sequence,
  });

  const key = sendKey(pending.mission_id, lead.id, 'follow_up', pending.sequence);
  const { message } = await conversations.createMessage({
    conversationId, leadId: lead.id, missionId: pending.mission_id,
    kind: 'follow_up', subject: draft.subject, bodyText: draft.body,
    model: draft.model, idempotencyKey: key,
  });

  if (missionRow.sending_mode === 'review_send' && !message.approved) {
    return { conversationId, awaitingApproval: true, messageId: message.id };
  }

  const result = await email.send(job.user_id, {
    to, subject: draft.subject, text: draft.body, idempotencyKey: key,
  });
  await conversations.markSent(message.id, {
    provider: result.provider, providerMessageId: result.providerMessageId, idempotencyKey: key,
  });
  await ctx.db.run("UPDATE follow_ups SET status = 'sent', message_id = ? WHERE id = ?", message.id, pending.id);
  await ctx.db.run(
    "UPDATE conversations SET followups_sent = followups_sent + 1, status = 'follow_up_sent', last_outbound_at = datetime('now') WHERE id = ?",
    conversationId
  );
  await conversations.recordSend(job.user_id, pending.mission_id, missionRow.timezone);

  // Only reschedule while within the configured maximum.
  const next = await conversations.scheduleFollowUp({
    conversationId, leadId: lead.id, missionId: pending.mission_id, mission: missionRow,
  });
  return { conversationId, sent: true, sequence: pending.sequence, nextScheduled: Boolean(next?.created) };
}
