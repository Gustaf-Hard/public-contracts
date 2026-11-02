import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/storage.js';
import { redraftEscalations, REDRAFT_REASON_PREFIX } from '../src/redraft.js';

const env = { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me', SLACK_CHANNEL_ID: 'C1' };

function seed() {
  const db = openDb(':memory:');
  db.migrate();
  const convId = db.createConversation({ kommun_kod: '0680', kommun_namn: 'Jönköping', role: 'central', contact_email: 'reg@jonkoping.se', scheduled_send_at: '2026-08-11T09:00:00Z' });
  db.updateConversationState(convId, 'NEEDS_HUMAN', { last_outbound_at: '2026-08-11T09:00:00Z' });
  const mid = db.recordMessage({ conversation_id: convId, gmail_message_id: 'in-j', direction: 'inbound',
    from_email: 'reg@jonkoping.se', to_email: 'me@x.se', subject: 'Sv: Begäran', body_text: 'Avgift 276 kr.',
    classification: 'unknown', classification_confidence: 0.9, received_at: '2026-09-14T08:00:00Z', attachment_count: 0 });
  const escId = db.recordEscalation({ conversation_id: convId, message_id: mid, reason: 'llm intent=fee_demand',
    draft_template: 'free_form', draft_subject: 'Re: Sv: Begäran', draft_body: 'Hej,\n\nJag accepterar avgiften.',
    slack_ts: '111.222', respond_by: '2026-10-01' });
  return { db, convId, mid, escId };
}
const analyseReturning = (draft_reply) => vi.fn(async () => ({ intent: 'fee_demand', draft_reply }));
const NEW = 'Hej,\n\nKan ni skicka avtalen som PDF via e-post? Då uppstår ingen kopieringskostnad.';

describe('redraftEscalations', () => {
  it('dry run analyses and reports, writes nothing', async () => {
    const { db, escId } = seed();
    const res = await redraftEscalations({ db, env, ids: [escId], analyse: analyseReturning(NEW) });
    expect(res[0]).toMatchObject({ outcome: 'would_redraft', new_body: NEW, flags: [] });
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1);
  });

  it('apply supersedes the old row, clones it with the new draft and strips the old Slack card', async () => {
    const { db, convId, mid, escId } = seed();
    const slackOps = { updateEscalationResolved: vi.fn(async () => {}) };
    const analyse = analyseReturning(NEW);
    const res = await redraftEscalations({ db, env, ids: [escId], apply: true, analyse, slackOps });
    expect(analyse.mock.calls[0][1].thread_context).toContain('Ursprunglig begäran');
    const old = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const fresh = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(res[0].new_esc);
    expect(old.status).toBe('superseded');
    expect(fresh).toMatchObject({ status: 'open', conversation_id: convId, message_id: mid, draft_body: NEW,
      respond_by: '2026-10-01', slack_ts: null, draft_template: 'free_form' });
    expect(fresh.reason.startsWith(`${REDRAFT_REASON_PREFIX}${escId}`)).toBe(true);
    expect(slackOps.updateEscalationResolved).toHaveBeenCalledWith(null, expect.objectContaining({ ts: '111.222', status: 'superseded' }));
  });

  it('skips a row with a newer inbound than its trigger, and one the analysis gives no draft for', async () => {
    const { db, convId, escId } = seed();
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'in-2', direction: 'inbound', from_email: 'reg@jonkoping.se',
      to_email: 'me@x.se', subject: 'Sv', body_text: 'x', classification: 'unknown', classification_confidence: 0.5,
      received_at: '2026-09-20T08:00:00Z', attachment_count: 0 });
    const res = await redraftEscalations({ db, env, ids: [escId], apply: true, analyse: analyseReturning(NEW) });
    expect(res[0].outcome).toBe('newer_inbound');

    const s2 = seed();
    const res2 = await redraftEscalations({ db: s2.db, env, ids: [s2.escId], apply: true, analyse: analyseReturning(null) });
    expect(res2[0].outcome).toBe('no_draft');
    expect(s2.db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(s2.escId).status).toBe('open');
  });

  it('reports a new draft that still concedes', async () => {
    const { db, escId } = seed();
    const res = await redraftEscalations({ db, env, ids: [escId], analyse: analyseReturning('Hej,\n\nJag godtar 276 kr.') });
    expect(res[0].flags).toEqual(['accepts', 'amount']);
  });
});
