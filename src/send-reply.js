// Outbound senders shared between the daemon (Slack interactivity) and the
// dashboard (browser action buttons). Both surfaces produce the same DB side
// effects so the FSM stays consistent regardless of where the human clicked
// "Send".

import { sendMessage as gmailSend } from './gmail.js';
import { T_INITIAL } from './templates.js';
import { resolveReplyRecipient } from './threads.js';
import { updateEscalationResolved } from './slack.js';

function fromHeader(env) {
  return `${env.GMAIL_FROM_NAME} <${env.GMAIL_USER_EMAIL}>`;
}

// SQLite datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (UTC, no zone marker),
// while our app timestamps are ISO with T/Z. Normalize before comparing.
export function parseDbTime(s) {
  if (!s) return null;
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t;
}

function errWithCode(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Best-effort: replace the escalation's Slack message with a resolved,
// button-less version. Never lets a Slack failure break the send path.
async function stripSlackButtons({ slackClient, env, esc, kommun_namn, status, detail, log }) {
  if (!slackClient || !esc.slack_ts || !env?.SLACK_CHANNEL_ID) return;
  try {
    await updateEscalationResolved(slackClient, {
      channel: env.SLACK_CHANNEL_ID, ts: esc.slack_ts, kommun_namn, status, detail,
    });
  } catch (e) {
    log?.(`slack chat.update failed for escalation ${esc.id}: ${e.message}`);
  }
}

// Send an approved reply to an open escalation. The caller passes the
// possibly-edited body; we send via Gmail, record outbound, advance side
// effects (followup_count, receipt_sent), resolve the escalation, and log
// the decision.
//
// Safety invariants (autopilot review C1/C2/H7):
//  - The escalation is atomically claimed (open → sending) before Gmail is
//    called. A second approve — double click, Slack retry, racing dashboard
//    POST — fails the claim and throws ESCALATION_NOT_OPEN. Never re-sends.
//  - An unmodified approve is blocked when a newer inbound arrived after the
//    draft was created (STALE_ESCALATION): the world moved, re-review. An
//    explicit edit passes — the human wrote with current context.
//  - If Gmail throws after the claim, the escalation is parked as
//    'send_failed' (never back to 'open') so nothing auto-retries an
//    ambiguous send; the operator verifies in Gmail Sent first.
export async function sendApprovedReply({ db, gmail, env, conv, esc, finalBody, finalSubject, finalTo, decision, gmailSendImpl = gmailSend, slackClient = null, log = null }) {
  const subject = finalSubject ?? esc.draft_subject ?? 'Re: Begäran om allmänna handlingar';
  const triggeringMessage = esc.message_id ? db.getMessageById(esc.message_id) : null;

  // Staleness guard — checked before the claim so a blocked approve leaves the
  // escalation open for re-review rather than parked.
  if (decision === 'approve_unmodified') {
    const escCreated = parseDbTime(esc.created_at);
    const newestInbound = db.listMessages(conv.id)
      .filter((m) => m.direction === 'inbound')
      .map((m) => parseDbTime(m.received_at))
      .filter(Boolean)
      .sort((a, b) => b - a)[0] ?? null;
    if (escCreated && newestInbound && newestInbound > escCreated) {
      throw errWithCode(
        `Escalation ${esc.id} is stale: a newer inbound arrived after the draft was created. Re-review (Edit) or skip.`,
        'STALE_ESCALATION'
      );
    }
  }

  if (!db.claimEscalationForSending(esc.id)) {
    const current = db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id);
    throw errWithCode(
      `Escalation ${esc.id} is not open (status=${current?.status ?? 'missing'}) — already handled elsewhere.`,
      'ESCALATION_NOT_OPEN'
    );
  }

  // primaryThreads is empty until Phase 2 sets statuses; then a follow-up nudge
  // with no triggering message routes to the single primary thread.
  const primaryThreads = db.listThreadsForConversation(conv.id).filter((t) => t.status === 'primary');
  const resolved = resolveReplyRecipient({ triggeringMessage, conv, primaryThreads });
  const to = (typeof finalTo === 'string' && finalTo.trim()) ? finalTo.trim() : resolved.to;
  const threadId = resolved.threadId ?? conv.gmail_thread_id;
  let sent;
  try {
    sent = await gmailSendImpl(gmail, {
      from: fromHeader(env),
      to,
      subject,
      body: finalBody,
      threadId,
    });
  } catch (e) {
    // Gmail may or may not have accepted — park, never auto-retry (C2).
    db.resolveEscalation(esc.id, { status: 'send_failed', resolved_text: `send error: ${e.message}` });
    await stripSlackButtons({ slackClient, env, esc, kommun_namn: conv.kommun_namn, status: 'send_failed', detail: e.message, log });
    throw e;
  }
  const nowIso = new Date().toISOString();
  db.recordMessage({
    conversation_id: conv.id,
    gmail_message_id: sent.id,
    direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL,
    to_email: to,
    subject,
    body_text: finalBody,
    classification: null,
    classification_confidence: null,
    received_at: nowIso,
    attachment_count: 0,
    gmail_thread_id: sent.threadId ?? threadId,
    thread_id: triggeringMessage?.thread_id ?? null,
  });
  const patch = { last_outbound_at: nowIso };
  if (esc.draft_template === 'T_RECEIPT') patch.receipt_sent = 1;
  if (esc.draft_template === 'T_FOLLOWUP_NUDGE' || esc.draft_template === 'T_FOLLOWUP_CLOSE') {
    patch.followup_count = (conv.followup_count ?? 0) + 1;
  }
  const targetState =
    conv.state === 'NEEDS_HUMAN' && esc.draft_template === 'free_form' && esc.previous_state
      ? esc.previous_state
      : conv.state;
  db.updateConversationState(conv.id, targetState, patch);
  const resolvedStatus = decision === 'edit' ? 'resolved_edit' : 'resolved_send';
  db.resolveEscalation(esc.id, {
    status: resolvedStatus,
    resolved_text: finalBody,
  });
  await stripSlackButtons({ slackClient, env, esc, kommun_namn: conv.kommun_namn, status: resolvedStatus, log });
  db.recordDecision({
    escalation_id: esc.id,
    conversation_id: conv.id,
    // Pair key for graduation = the state the draft was created FOR, not the
    // state after the FSM auto-advanced (review M3).
    conversation_state: esc.previous_state ?? conv.state,
    classifier_class: esc.classifier_class ?? null,
    classifier_confidence: esc.classifier_confidence ?? null,
    draft_template: esc.draft_template,
    draft_body: esc.draft_body,
    decision,
    final_body: finalBody,
  });
  return sent;
}

// Render the T-INITIAL template for a given kommun + role. Used by the
// "Skicka T-INITIAL" form to pre-populate the editor.
export function renderInitialDraft({ kommun_namn, role, env }) {
  return T_INITIAL({
    kommun_namn,
    role,
    from_email: env.GMAIL_USER_EMAIL,
    from_name: env.GMAIL_FROM_NAME,
  });
}

// Create a new conversation and send the (possibly-edited) T-INITIAL to it.
// Used by the dashboard's "send initial" action for kommuner that aren't
// yet in the pilot.
export async function sendInitial({ db, gmail, env, kommun_kod, kommun_namn, role, contact_email, subject, body }) {
  const existing = db.raw
    .prepare('SELECT id FROM conversations WHERE kommun_kod = ? AND role = ?')
    .get(kommun_kod, role);
  if (existing) {
    throw new Error(`Conversation already exists for ${kommun_kod}/${role} (id=${existing.id})`);
  }
  const nowIso = new Date().toISOString();
  const convId = db.createConversation({
    kommun_kod,
    kommun_namn,
    role,
    contact_email,
    scheduled_send_at: nowIso,
  });
  // Two-phase (autopilot review C2): claim the fresh INITIAL row as SENDING
  // *before* the Gmail call. A failed or crashed send must never leave a due
  // INITIAL row behind — the tick would later auto-send the canned template
  // without human intent. On failure the row is parked NEEDS_HUMAN instead.
  db.claimConversationForInitialSend(convId);
  let sent;
  try {
    sent = await gmailSend(gmail, {
      from: fromHeader(env),
      to: contact_email,
      subject,
      body,
    });
  } catch (e) {
    db.updateConversationState(convId, 'NEEDS_HUMAN', {
      notes: `sendInitial failed: ${e.message} — verify in Gmail Sent before retrying`,
    });
    throw e;
  }
  db.updateConversationState(convId, 'SENT', {
    gmail_thread_id: sent.threadId,
    last_outbound_at: nowIso,
  });
  db.recordMessage({
    conversation_id: convId,
    gmail_message_id: sent.id,
    direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL,
    to_email: contact_email,
    subject,
    body_text: body,
    classification: null,
    classification_confidence: null,
    received_at: nowIso,
    attachment_count: 0,
  });
  return { conversation_id: convId, sent };
}
