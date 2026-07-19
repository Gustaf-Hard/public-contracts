// Outbound senders shared between the daemon (Slack interactivity) and the
// dashboard (browser action buttons). Both surfaces produce the same DB side
// effects so the FSM stays consistent regardless of where the human clicked
// "Send".

import { sendMessage as gmailSend, archiveThread } from './gmail.js';
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

// Best-effort: archive the thread we just replied into so the operator's inbox
// stays clean. A reply lives in the SAME Gmail thread as the inbound it answers
// — which is sitting in the inbox — so dropping the thread's INBOX label
// archives that conversation. Runs only after the send is confirmed and never
// lets an archive failure surface: the send already succeeded, archiving is
// cosmetic, and the thread re-enters the inbox on the kommun's next reply.
async function archiveThreadBestEffort({ archiveThreadImpl, gmail, threadId, log }) {
  if (!threadId) return;
  try {
    await archiveThreadImpl(gmail, threadId);
  } catch (e) {
    log?.(`gmail archive failed for thread ${threadId}: ${e.message}`);
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
export async function sendApprovedReply({ db, gmail, env, conv, esc, finalBody, finalSubject, finalTo, decision, gmailSendImpl = gmailSend, archiveThreadImpl = archiveThread, slackClient = null, log = null }) {
  const subject = finalSubject ?? esc.draft_subject ?? 'Re: Begäran om allmänna handlingar';
  const triggeringMessage = esc.message_id ? db.getMessageById(esc.message_id) : null;

  // Bounce resend (2026-07-19 bounce-handling design §4): the T-INITIAL bounced
  // off a dead address, so this is a fresh T-INITIAL to a corrected recipient in
  // a NEW thread — never a reply into the bounce thread. It reuses this exact
  // two-phase atomic-claim path (nothing bypasses the claim), only the routing
  // (recipient + thread + target state) differs below.
  const isBounceResend = esc.draft_template === 'T_RESEND_BAD_ADDRESS' || esc.classifier_class === 'bounce';

  // The corrected address is REQUIRED and must never fall back to the dead one.
  // Checked before the claim (like the staleness guard) so a rejected resend
  // leaves the escalation OPEN for the operator to enter an address and retry —
  // it is never parked, never sent to the bounced address.
  if (isBounceResend && !(typeof finalTo === 'string' && finalTo.trim())) {
    throw errWithCode(
      `Escalation ${esc.id} is a bounce resend: a corrected recipient address is required (the original address bounced).`,
      'MISSING_RESEND_ADDRESS'
    );
  }

  // Staleness guard — checked before the claim so a blocked approve leaves the
  // escalation open for re-review rather than parked.
  //
  // A refresh (T_UPDATE) is exempt (findings 1/4): it opens a NEW outreach round
  // and answers no inbound, so a PRIOR round's delivery is not "newer context"
  // that should block it — it always compares stale by construction. A bounce
  // resend is exempt for the same reason (it answers no inbound — the original
  // never arrived). Every other draft (including proactive follow-ups) keeps the
  // guard: a newer inbound arriving mid-conversation must still force a re-review.
  const isRefreshEsc = esc.draft_template === 'T_UPDATE' || conv.state === 'REFRESH_DUE';
  if (decision === 'approve_unmodified' && !isRefreshEsc && !isBounceResend) {
    const escCreated = parseDbTime(esc.created_at);
    // Precision matters here (hardening finding 6):
    //  - Exclude the inbound the draft answers (esc.message_id) — it is by
    //    definition not "newer context", yet it usually lands in the same
    //    wall-clock second as the draft it triggered.
    //  - created_at is SQLite datetime('now') with whole-second resolution,
    //    while Gmail internalDate carries milliseconds. Compare with a
    //    one-second tolerance or a same-second inbound (ms > 0) wrongly
    //    rejects a legitimate unmodified approve as STALE.
    const newestOtherInbound = db.listMessages(conv.id)
      .filter((m) => m.direction === 'inbound' && m.id !== esc.message_id)
      .map((m) => parseDbTime(m.received_at))
      .filter(Boolean)
      .sort((a, b) => b - a)[0] ?? null;
    if (escCreated && newestOtherInbound
        && newestOtherInbound.getTime() > escCreated.getTime() + 999) {
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

  // A refresh (T_UPDATE) opens a NEW outreach round in a NEW Gmail thread
  // (findings 1/4): the previous round is closed (DONE), so replying in the old
  // thread would reopen a resolved conversation. Force a fresh thread and route
  // to the conversation's canonical contact.
  const isRefreshSend = esc.draft_template === 'T_UPDATE' || conv.state === 'REFRESH_DUE';

  // primaryThreads is empty until Phase 2 sets statuses; then a follow-up nudge
  // with no triggering message routes to the single primary thread.
  const primaryThreads = db.listThreadsForConversation(conv.id).filter((t) => t.status === 'primary');
  const resolved = resolveReplyRecipient({ triggeringMessage, conv, primaryThreads });
  const to = (typeof finalTo === 'string' && finalTo.trim())
    ? finalTo.trim()
    : (isRefreshSend ? conv.contact_email : resolved.to);
  // A bounce resend goes to a BRAND-NEW thread (like a refresh): never reply into
  // the bounce thread, so no threadId → no In-Reply-To/References to the NDR.
  const threadId = (isRefreshSend || isBounceResend) ? undefined : (resolved.threadId ?? conv.gmail_thread_id);
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

  // Target state resolution:
  //  - Refresh send (REFRESH_DUE + T_UPDATE): open a fresh outreach round. The
  //    conversation re-enters the EXISTING reply/delivery/close FSM exactly like
  //    a first-round outreach — state → SENT, refresh_round++, a NEW gmail
  //    thread, next_review_at cleared (findings 1/4). When this round concludes
  //    back to DONE, armRefresh re-arms and the cycle repeats — perpetual.
  //  - Ambiguous-outcome recovery (NEEDS_HUMAN + free_form): restore the state
  //    the draft was created for so staleness rules resume watching it.
  //  - Everything else: state is bookkeeping, stays put.
  let targetState = conv.state;
  if ((esc.draft_template === 'T_UPDATE' || conv.state === 'REFRESH_DUE')) {
    targetState = 'SENT';
    // refresh_round is already bumped by runRefreshScan when the conversation
    // ENTERED this round (REFRESH_DUE), so it is NOT re-incremented here — the
    // round number is the round we are now sending for, not the next one.
    patch.next_review_at = null;
    patch.next_review_source = null;
    patch.receipt_sent = 0;   // a fresh round expects a new delivery + receipt
    patch.followup_count = 0;  // stale-clock restarts for the new round
    patch.follow_up_at = null;
    patch.gmail_thread_id = sent.threadId ?? null; // the newly-opened thread
  } else if (isBounceResend) {
    // The corrected T-INITIAL just went out in a fresh thread: re-enter the
    // normal reply/delivery FSM at SENT, pointing at the NEW thread + the
    // CORRECTED address so future inbound matching and follow-up use it. The
    // original send reached no one, so this is not a double-message.
    targetState = 'SENT';
    patch.gmail_thread_id = sent.threadId ?? null;
    patch.contact_email = to;
  } else if (conv.state === 'NEEDS_HUMAN' && esc.draft_template === 'free_form' && esc.previous_state) {
    targetState = esc.previous_state;
  }
  db.updateConversationState(conv.id, targetState, patch);
  const resolvedStatus = decision === 'edit' ? 'resolved_edit' : 'resolved_send';
  db.resolveEscalation(esc.id, {
    status: resolvedStatus,
    resolved_text: finalBody,
  });
  await stripSlackButtons({ slackClient, env, esc, kommun_namn: conv.kommun_namn, status: resolvedStatus, log });
  // Keep the inbox clean: archive the thread we replied into. The refresh path
  // opens a brand-new thread (no inbound, nothing in the inbox), so archiving it
  // is a harmless no-op there; every other reply archives the inbound thread.
  await archiveThreadBestEffort({ archiveThreadImpl, gmail, threadId: sent.threadId ?? threadId, log });
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
  //
  // The claim result is binding (hardening finding 1): a daemon tick can win
  // the INITIAL → SENDING claim between createConversation above and here and
  // send the canned T-INITIAL itself. Sending ours on top would double-message
  // the kommun, so abort without touching Gmail or the row — exactly like
  // dispatchInitial and sendApprovedReply treat a lost claim.
  if (!db.claimConversationForInitialSend(convId)) {
    throw errWithCode(
      `Conversation ${convId} (${kommun_kod}/${role}) was claimed for its initial send elsewhere (daemon tick?) — already handled, not sending again.`,
      'INITIAL_CLAIM_LOST'
    );
  }
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
