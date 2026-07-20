// Supervised cleanup helper (2026-07-20 soft-handoff-wait design §6).
//
// Bjurholm #21, Avesta #12 and Eda #43 are OPEN free-form escalations whose
// triggering message is really a SOFT internal forward ("Jag skickar det vidare
// till skol- och IT-chef …", "vidare till Upphandlingsenheten", "vidare till
// Bildning") that the OLD offline classifier tagged `unknown` and escalated.
// Now that the classifier recognises an internal forward with NO new external
// address -> `handoff_internal`, this helper finds such open free-form
// escalations, RE-recognises their triggering message with the current
// classifier, and — only when it is genuinely `handoff_internal` — cleans up:
//   1. supersedes the escalation (its Slack buttons go dead, it leaves the
//      operator's queue),
//   2. pushes the conversation's follow_up_at to today + 21 days (the wait
//      floor — an internal forward genuinely takes weeks), and
//   3. un-sticks a NEEDS_HUMAN state back to a sane non-terminal waiting state
//      (SENT / ACK_RECEIVED / DELIVERING per prior progress) so the staleness
//      rules resume watching it after the wait window.
//
// DO NOT RUN unsupervised. The OPERATOR runs this backup-first. It is pure +
// offline-testable: it takes a db handle and a `now` clock, touches only a
// temp/injected DB in tests, and never calls Gmail/Slack/Anthropic.
//
// PRECISION OVER RECALL: an escalation whose message is NOT recognised as
// `handoff_internal` by the current classifier is left completely untouched — a
// real clarification / external handoff / fee reply parked as free-form must
// never be silently superseded and deferred.

import { classify } from './classifier.js';
import { addDaysIso } from './analyse-message.js';
import { saneRestoreState } from './send-reply.js';

const SOFT_HANDOFF_WAIT_DAYS = 21;

// Returns a summary array of the escalations acted on:
//   [{ escalation_id, conversation_id, follow_up_at, state }]
// so the operator can eyeball exactly what changed. Idempotent: a second run
// finds no open free-form escalations left to retag.
export function retagSoftHandoff(db, { now = new Date(), classifier = classify } = {}) {
  const acted = [];
  const todayIso = (now instanceof Date ? now.toISOString() : String(now ?? '')).slice(0, 10);
  const followUp = addDaysIso(todayIso, SOFT_HANDOFF_WAIT_DAYS);

  // Only OPEN, free-form escalations are candidates. Template-driven escalations
  // (T_RECEIPT, T_DELAY_ACK, T_UPDATE, T_RESEND_BAD_ADDRESS, …) already reflect a
  // recognised intent and are never touched here.
  const open = db.raw
    .prepare("SELECT * FROM escalations WHERE status = 'open' AND draft_template = 'free_form' AND message_id IS NOT NULL ORDER BY id")
    .all();

  for (const esc of open) {
    const msg = db.getMessageById(esc.message_id);
    if (!msg) continue;
    const cls = classifier({
      from: msg.from_email,
      subject: msg.subject,
      body: msg.body_text,
      attachment_count: msg.attachment_count ?? 0,
    });
    if (cls.class !== 'handoff_internal') continue; // precision: leave real replies / external handoffs alone

    db.resolveEscalation(esc.id, {
      status: 'superseded',
      resolved_text: 'soft internal forward recognised retroactively (2026-07-20 §6) — waiting silently at least 21 days, no reply needed',
    });

    const conv = db.getConversation(esc.conversation_id);
    const patch = {};
    if (followUp) patch.follow_up_at = followUp;
    // Un-stick a stranded NEEDS_HUMAN (0 open escalations, previous_state was
    // itself NEEDS_HUMAN/null) back to a sane waiting state so staleness resumes.
    let state = conv?.state ?? null;
    if (conv?.state === 'NEEDS_HUMAN') {
      state = saneRestoreState(esc.previous_state, conv, db);
    }
    if (state && state !== conv?.state) {
      db.updateConversationState(conv.id, state, patch);
    } else if (Object.keys(patch).length > 0) {
      // State unchanged — patch follow_up_at without rewriting state_changed_at.
      db.raw.prepare('UPDATE conversations SET follow_up_at = ? WHERE id = ?')
        .run(followUp, esc.conversation_id);
    }

    acted.push({ escalation_id: esc.id, conversation_id: esc.conversation_id, follow_up_at: followUp, state });
  }
  return acted;
}
