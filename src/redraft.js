// Re-draft named open escalations under the CURRENT analysis prompt
// (2026-09-28, after the concession audit: 28 open drafts accepted fees,
// masking or summaries under the old prompt).
//
// Per escalation: re-run analyseMessage on its triggering inbound with the
// same thread context the tick builds, then supersede the old row and mint a
// new open one carrying the new draft_reply. Everything else on the row
// (message_id, template, respond_by, watchlist, classifier fields) is cloned.
// The new row has slack_ts NULL, so the daemon's retryUnpostedEscalations
// posts its card; the old card's buttons are stripped here, best-effort.
//
// Nothing is sent. Skipped, never guessed: a row that is not open, has no
// triggering message, has a newer inbound than its trigger (the tick owns that
// conversation's next draft), or for which the analysis returns no draft.
// Dry run by default: analyses and reports, writes nothing.
import { analyseMessage } from './analyse-message.js';
import { buildDraftContext } from './draft-context.js';
import { concessionFlags } from './classifier.js';
import { localDateStr } from './tick.js';

export const REDRAFT_REASON_PREFIX = 'omskriven (koncessionsgranskning) #';

const parseTs = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).getTime() : NaN);

export async function redraftEscalations({
  db, env, ids, apply = false, now = new Date(),
  analyse = analyseMessage, slackClient = null, slackOps = null, log = () => {},
}) {
  const results = [];
  for (const id of ids) {
    const done = (outcome, extra = {}) => { const r = { esc: id, outcome, ...extra }; results.push(r); log(r); return r; };
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(id);
    if (!esc) { done('missing'); continue; }
    if (esc.status !== 'open') { done('not_open', { status: esc.status }); continue; }
    const msg = esc.message_id ? db.getMessageById(esc.message_id) : null;
    if (!msg) { done('no_trigger'); continue; }
    const conv = db.getConversation(esc.conversation_id);
    const newer = db.listMessages(conv.id)
      .filter((m) => m.direction === 'inbound' && m.id !== msg.id && parseTs(m.received_at) > parseTs(msg.received_at));
    if (newer.length) { done('newer_inbound', { message_ids: newer.map((m) => m.id) }); continue; }

    const parsed = { body: msg.body_text ?? '', subject: msg.subject ?? '', from: msg.from_email ?? '', attachments: [] };
    let threadContext;
    try { threadContext = buildDraftContext(db, conv, parsed); } catch (e) { log({ esc: id, note: `context failed: ${e.message}` }); }
    const lastOut = conv.last_outbound_at ? parseTs(conv.last_outbound_at) : NaN;
    const analysis = await analyse(parsed.body, {
      kommun_namn: conv.kommun_namn,
      role: conv.role,
      conversation_state: conv.state,
      days_since_last_outbound: Number.isFinite(lastOut) ? Math.floor((now.getTime() - lastOut) / 86_400_000) : null,
      today_iso: localDateStr(now),
      received_iso: localDateStr(new Date(parseTs(msg.received_at))),
      thread_context: threadContext,
    }, { env });
    const body = analysis?.draft_reply?.trim();
    if (!body) { done('no_draft', { intent: analysis?.intent ?? null }); continue; }
    const flags = concessionFlags(body);
    if (!apply) { done('would_redraft', { old_body: esc.draft_body, new_body: body, flags }); continue; }

    let newId;
    db.raw.transaction(() => {
      db.resolveEscalation(esc.id, { status: 'superseded', resolved_text: `omskriven under nya utkastregler (#${esc.id} → ny)` });
      newId = db.recordEscalation({
        conversation_id: esc.conversation_id, message_id: esc.message_id,
        reason: `${REDRAFT_REASON_PREFIX}${esc.id} | ${esc.reason}`,
        draft_template: esc.draft_template, draft_subject: esc.draft_subject, draft_body: body,
        classifier_class: esc.classifier_class, classifier_confidence: esc.classifier_confidence,
        previous_state: esc.previous_state, watchlist_vendors: esc.watchlist_vendors, respond_by: esc.respond_by,
      });
    })();
    if (esc.slack_ts && slackOps?.updateEscalationResolved && env.SLACK_CHANNEL_ID) {
      try {
        await slackOps.updateEscalationResolved(slackClient, {
          channel: env.SLACK_CHANNEL_ID, ts: esc.slack_ts, kommun_namn: conv.kommun_namn, status: 'superseded',
        });
      } catch (e) { log({ esc: id, note: `chat.update failed: ${e.message}` }); }
    }
    done('redrafted', { new_esc: newId, old_body: esc.draft_body, new_body: body, flags });
  }
  return results;
}
