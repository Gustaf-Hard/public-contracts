// Batch application of reviewed verdicts over open escalations (2026-09-26).
//
// A reviewer read a snapshot of the DB (the nightly backup) and produced one
// verdict per open escalation: approve / edit / skip / defer / human. This module
// replays those verdicts against the LIVE db through the one approved-send
// path, sendApprovedReply. It is the CLI resolver (scripts/pilot-resolve.js)
// looped over a file, plus the two checks a snapshot review needs:
//
//  - `reviewedAt`: an inbound that arrived after the snapshot was reviewed
//    invalidates the verdict (the reviewer never saw it). Left open, the
//    operator re-reviews. STALE_ESCALATION inside sendApprovedReply only
//    compares against the DRAFT's creation, which is older than the review.
//  - `draft_sha256`: the verdict is about a specific draft body. If the row's
//    body changed since (a backfill, a live patch), the verdict is void.
//
// `human` rows are never touched. Nothing here retries: a Gmail failure parks
// the escalation exactly as a dashboard click would, and the batch moves on.
import { createHash } from 'node:crypto';
import { sendMessage as gmailSend } from './gmail.js';
import { sendApprovedReply, restoreStateAfterDefer } from './send-reply.js';
import { DEFER_REASONS } from './storage.js';

export const sha256 = (s) => createHash('sha256').update(s ?? '').digest('hex');

const parseTs = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime() : NaN);

export async function applyVerdicts({
  db, gmail, env, verdicts, reviewedAt, apply = false,
  gmailSendImpl = gmailSend, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 2000,
}) {
  const reviewedTs = parseTs(reviewedAt);
  if (!Number.isFinite(reviewedTs)) throw new Error(`applyVerdicts: reviewedAt must be an ISO timestamp, got ${reviewedAt}`);
  const results = [];
  let sentAny = false;
  for (const v of verdicts) {
    const row = { esc: v.esc, verdict: v.verdict };
    const done = (outcome, extra = {}) => { const r = { ...row, outcome, ...extra }; results.push(r); log(r); return r; };

    if (v.verdict === 'human') { done('left_for_operator'); continue; }
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(v.esc);
    if (!esc) { done('missing'); continue; }
    if (esc.status !== 'open') { done('not_open', { status: esc.status }); continue; }
    if (sha256(esc.draft_body) !== v.draft_sha256) { done('draft_changed'); continue; }
    const newer = db.listMessages(esc.conversation_id)
      .filter((m) => m.direction === 'inbound' && parseTs(m.received_at) > reviewedTs);
    if (newer.length) { done('newer_inbound', { message_ids: newer.map((m) => m.id) }); continue; }
    const conv = db.getConversation(esc.conversation_id);

    if (v.verdict === 'skip') {
      if (!apply) { done('would_skip'); continue; }
      db.resolveEscalation(esc.id, { status: 'resolved_skip' });
      db.recordDecision({
        escalation_id: esc.id, conversation_id: conv.id,
        conversation_state: esc.previous_state ?? conv.state,
        classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
        draft_template: esc.draft_template, draft_body: esc.draft_body,
        decision: 'skip', final_body: null,
      });
      done('skipped');
      continue;
    }

    // Park it (2026-10-02 design): the verdict for the 38 fee demands and 15
    // sekretess decisions the reviewers deliberately left alone. Nothing is
    // sent, the draft is kept so it can be resumed, and the case leaves the
    // queues without being skipped away. `defer_reason` is REQUIRED and must be
    // one of the four — a park whose reason nobody can read back is worth less
    // than no park at all, and the Pausade surfaces are keyed on it, so this
    // fails the row rather than silently writing 'annat' over a typo.
    if (v.verdict === 'defer') {
      if (!DEFER_REASONS.includes(String(v.defer_reason ?? '').toLowerCase())) {
        done('missing_defer_reason', { defer_reason: v.defer_reason ?? null });
        continue;
      }
      if (!apply) { done('would_defer'); continue; }
      if (!db.deferEscalationIfOpen(esc.id, { reason: v.defer_reason, note: v.defer_note })) {
        done('not_open', { status: db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id)?.status });
        continue;
      }
      db.recordDecision({
        escalation_id: esc.id, conversation_id: conv.id,
        conversation_state: esc.previous_state ?? conv.state,
        classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
        draft_template: esc.draft_template, draft_body: esc.draft_body,
        decision: 'defer', final_body: null,
      });
      restoreStateAfterDefer({ db, conv, esc });
      done('deferred');
      continue;
    }

    if (v.verdict !== 'approve' && v.verdict !== 'edit') { done('unknown_verdict'); continue; }
    const finalBody = v.verdict === 'edit' ? (v.final_body ?? '').trim() : (esc.draft_body ?? '');
    if (!finalBody) { done('empty_body'); continue; }
    if (!apply) { done('would_send'); continue; }
    if (sentAny) await sleep(delayMs);
    try {
      const sent = await sendApprovedReply({
        db, gmail, env, conv, esc, finalBody,
        finalSubject: v.verdict === 'edit' ? (v.final_subject ?? null) : null,
        decision: v.verdict === 'edit' ? 'edit' : 'approve_unmodified',
        gmailSendImpl,
      });
      sentAny = true;
      done('sent', { gmail_message_id: sent.id });
    } catch (e) {
      done('failed', { error: `${e.code ? e.code + ': ' : ''}${e.message}` });
    }
  }
  return results;
}
