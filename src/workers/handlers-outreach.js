import { STAGE } from './queue.js';
import { err } from '../core/errors.js';
import { sqliteUtc } from '../core/time.js';

/**
 * Outreach generation and sending.
 *
 * Safety rules enforced here rather than left to callers:
 *  - Scout Only never sends; Review & Send waits for approval (§27).
 *  - Suppression and daily limits are checked before every send (§17).
 *  - The idempotency key is written BEFORE the send, so a crash or retry can
 *    never produce a second message to the same prospect (§30).
 */

export const sendKey = (missionId, leadId, kind, seq = 0) =>
  `send:${missionId}:${leadId}:${kind}:${seq}`;

/** §15/§16 — generate individualized outreach for one qualified lead. */
export async function outreachHandler(ctx) {
  const { services, payload, job, mission } = ctx;
  const { leads, conversations, ai, queue, emailStore } = services;
  const lead = await leads.get(payload.leadId);
  if (!lead) throw err.notFound('Lead');

  const connection = await emailStore.activeFor(job.user_id);
  if (!connection) {
    throw err.email('MAILBOX_NOT_CONNECTED', 'Connect an authorized mailbox before generating outreach.');
  }

  const evidence = await leads.evidenceFor(lead.id);
  const draft = await ai.writeOutreach(job.user_id, {
    lead: evidence.lead,
    analysis: { website: evidence.website, presence: evidence.presence },
    mission: {
      service: mission.service,
      offer_summary: mission.offer_summary,
      outreach_instructions: mission.outreach_instructions,
      target_description: mission.target_description,
    },
    senderName: ctx.user?.full_name || 'Nexora Outreach',
    senderEmail: connection.account_email,
    followUpNumber: 0,
  });

  const conversation = await conversations.ensure(lead.id, mission.id, job.user_id);
  const { message, created } = await conversations.createMessage({
    conversationId: conversation.id,
    leadId: lead.id,
    missionId: mission.id,
    kind: 'initial',
    subject: draft.subject,
    bodyText: draft.body,
    model: draft.model,
    idempotencyKey: sendKey(mission.id, lead.id, 'initial'),
  });
  if (!created) return { leadId: lead.id, messageId: message.id, reused: true };

  // §27 Scout Only: research and qualify, never send.
  if (mission.sending_mode === 'scout_only') {
    await leads.setStatus(lead.id, 'message_generated');
    return { leadId: lead.id, messageId: message.id, sent: false, mode: 'scout_only' };
  }

  await leads.setStatus(lead.id, 'awaiting_approval');
  await queue.enqueue({
    userId: job.user_id, missionId: mission.id,
    stage: STAGE.EMAIL, payload: { leadId: lead.id, messageId: message.id },
    idempotencyKey: `email:${mission.id}:${lead.id}:initial`,
  });
  return { leadId: lead.id, messageId: message.id, sent: false, mode: mission.sending_mode };
}

/** §17/§27 — send an approved message through the authorized mailbox. */
export async function emailHandler(ctx) {
  const { services, payload, job, mission } = ctx;
  const { leads, conversations, notifications, email } = services;

  const message = await conversations.message(payload.messageId);
  if (!message) throw err.notFound('Message');
  if (message.send_status === 'sent') return { messageId: message.id, alreadySent: true };

  const lead = await leads.get(message.lead_id);
  if (!lead) throw err.notFound('Lead');

  const conversation = await conversations.getFor(lead.id, mission.id);

  // Suppression is checked FIRST: an opted-out, bounced or complained-about
  // recipient is never presented for approval and is never retried.
  try {
    await conversations.assertNotSuppressed(job.user_id, lead, conversation?.id);
  } catch (e) {
    if (e.code === 'SUPPRESSED') {
      await leads.setStatus(lead.id, 'suppressed');
      if (conversation) await conversations.setStatus(conversation.id, 'suppressed');
    }
    throw e;
  }

  if (mission.sending_mode === 'review_send' && !message.approved) {
    return { messageId: message.id, awaitingApproval: true };
  }
  if (mission.sending_mode === 'scout_only') {
    return { messageId: message.id, skipped: 'scout_only' };
  }

  // Throws when there is no contact route or the daily limit is reached.
  const to = await conversations.assertSendable(job.user_id, mission.id, lead, conversation?.id);
  const idempotencyKey = message.idempotency_key || sendKey(mission.id, lead.id, message.kind);

  try {
    const result = await email.send(job.user_id, {
      to, subject: message.subject, text: message.body_text, idempotencyKey,
    });
    await conversations.markSent(message.id, {
      provider: result.provider, providerMessageId: result.providerMessageId, idempotencyKey,
    });
    if (conversation) await conversations.setStatus(conversation.id, 'sent');
    await conversations.recordSend(job.user_id, mission.id, mission.timezone);
    await leads.markContacted(lead.id);
    await leads.setStatus(lead.id, 'sent');
    if (conversation) {
      await ctx.db.run(
        "UPDATE conversations SET last_outbound_at = datetime('now'), thread_key = COALESCE(?, thread_key) WHERE id = ?",
        result.threadKey || null, conversation.id
      );
    }

    // §19: schedule a follow-up only within the configured limits.
    const scheduled = await conversations.scheduleFollowUp({
      conversationId: conversation?.id, leadId: lead.id, missionId: mission.id, mission,
    });
    if (scheduled?.created) {
      await notifications.create(job.user_id, {
        kind: 'follow_up_due', severity: 'info',
        title: `Follow-up scheduled for ${lead.business_name}`,
        body: `Due in ${mission.follow_up_delay_days} day(s).`,
        missionId: mission.id, leadId: lead.id,
      });
    }
    return { messageId: message.id, sent: true, provider: result.provider, to };
  } catch (e) {
    await conversations.markFailed(message.id, e.message);
    if (e.code === 'MAILBOX_AUTH_EXPIRED') {
      await notifications.create(job.user_id, {
        kind: 'mailbox_expired', severity: 'critical',
        title: 'Mailbox authorization expired',
        body: 'Reconnect your mailbox to resume sending outreach.',
        missionId: mission.id,
      });
    } else if (e.code === 'SUPPRESSED') {
      // Never retry a suppressed recipient.
      await leads.setStatus(lead.id, 'suppressed');
      if (conversation) await conversations.setStatus(conversation.id, 'suppressed');
    }
    throw e;
  }
}

export { STAGE, sqliteUtc };
