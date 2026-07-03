// Outbound senders shared between the daemon (Slack interactivity) and the
// dashboard (browser action buttons). Both surfaces produce the same DB side
// effects so the FSM stays consistent regardless of where the human clicked
// "Send".

import { sendMessage as gmailSend } from './gmail.js';
import { T_INITIAL } from './templates.js';
import { resolveReplyRecipient } from './threads.js';

function fromHeader(env) {
  return `${env.GMAIL_FROM_NAME} <${env.GMAIL_USER_EMAIL}>`;
}

// Send an approved reply to an open escalation. The caller passes the
// possibly-edited body; we send via Gmail, record outbound, advance side
// effects (followup_count, receipt_sent), resolve the escalation, and log
// the decision.
export async function sendApprovedReply({ db, gmail, env, conv, esc, finalBody, finalSubject, finalTo, decision, gmailSendImpl = gmailSend }) {
  const subject = finalSubject ?? esc.draft_subject ?? 'Re: Begäran om allmänna handlingar';
  const triggeringMessage = esc.message_id ? db.getMessageById(esc.message_id) : null;
  // primaryThreads is empty until Phase 2 sets statuses; then a follow-up nudge
  // with no triggering message routes to the single primary thread.
  const primaryThreads = db.listThreadsForConversation(conv.id).filter((t) => t.status === 'primary');
  const resolved = resolveReplyRecipient({ triggeringMessage, conv, primaryThreads });
  const to = (typeof finalTo === 'string' && finalTo.trim()) ? finalTo.trim() : resolved.to;
  const threadId = resolved.threadId ?? conv.gmail_thread_id;
  const sent = await gmailSendImpl(gmail, {
    from: fromHeader(env),
    to,
    subject,
    body: finalBody,
    threadId,
  });
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
  db.resolveEscalation(esc.id, {
    status: decision === 'edit' ? 'resolved_edit' : 'resolved_send',
    resolved_text: finalBody,
  });
  db.recordDecision({
    escalation_id: esc.id,
    conversation_id: conv.id,
    conversation_state: conv.state,
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
  const sent = await gmailSend(gmail, {
    from: fromHeader(env),
    to: contact_email,
    subject,
    body,
  });
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
