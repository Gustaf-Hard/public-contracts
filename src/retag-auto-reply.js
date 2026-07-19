// Supervised cleanup helper (2026-07-19 autosvar design §3).
//
// Bjuv escalation #38 is an OPEN free-form escalation whose triggering message
// is really a machine autoresponder ("Autosvar: … Jag har semester och är åter
// 20 juli …") that the OLD offline classifier tagged `unknown`. Now that the
// classifier recognises autosvar → `auto_reply`, this helper finds such open
// free-form escalations, RE-recognises their triggering message with the
// current classifier, and — only when it is genuinely an `auto_reply` — cleans
// up: it supersedes the escalation (so its Slack buttons stop being live and it
// leaves the operator's queue) and pushes the conversation's follow_up_at past
// the stated return date, so the case re-surfaces after the person is back.
//
// DO NOT RUN unsupervised. The OPERATOR runs this backup-first. It is written
// pure + offline-testable: it takes a db handle and a `now` clock, touches only
// a temp/injected DB in tests, and never calls Gmail/Slack/Anthropic.
//
// PRECISION OVER RECALL: an escalation whose message is NOT recognised as
// `auto_reply` by the current classifier is left completely untouched — a real
// clarification/handoff/fee reply parked as free-form must never be silently
// superseded.

import { classify, extractReturnDate, stripQuotedText } from './classifier.js';
import { addDaysIso } from './analyse-message.js';

// Compute the follow-up a recognised autosvar deserves: stated return date + 3
// days grace, or a 14-day default from receipt when no date could be parsed.
function autoReplyFollowUp(body, receivedAt, now) {
  const visible = stripQuotedText(body ?? '');
  const todayIso = (now instanceof Date ? now.toISOString() : String(now ?? '')).slice(0, 10);
  const ret = extractReturnDate(visible, { todayIso });
  if (ret) return addDaysIso(ret, 3);
  const base = (receivedAt || todayIso).slice(0, 10);
  return addDaysIso(base, 14) ?? addDaysIso(todayIso, 14);
}

// Returns a summary array of the escalations acted on:
//   [{ escalation_id, conversation_id, follow_up_at }]
// so the operator can eyeball exactly what changed. Idempotent: a second run
// finds no open free-form escalations left to retag.
export function retagAutoReplyEscalations(db, { now = new Date(), classifier = classify } = {}) {
  const acted = [];
  // Only OPEN, free-form escalations are candidates. Template-driven
  // escalations (T_RECEIPT, T_DELAY_ACK, T_UPDATE, T_RESEND_BAD_ADDRESS, …)
  // already reflect a recognised intent and are never touched here.
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
    if (cls.class !== 'auto_reply') continue; // precision: leave real replies alone

    const followUp = autoReplyFollowUp(msg.body_text, msg.received_at, now);

    db.resolveEscalation(esc.id, {
      status: 'superseded',
      resolved_text: 'autosvar recognised retroactively (2026-07-19 §3) — waiting silently past the return date, no reply needed',
    });
    // Push the conversation's follow-up past the return date so it re-surfaces
    // when the person is back. State is intentionally left unchanged — an
    // autosvar is a wait, not a transition.
    if (followUp) {
      db.raw.prepare('UPDATE conversations SET follow_up_at = ? WHERE id = ?')
        .run(followUp, esc.conversation_id);
    }
    acted.push({ escalation_id: esc.id, conversation_id: esc.conversation_id, follow_up_at: followUp });
  }
  return acted;
}
