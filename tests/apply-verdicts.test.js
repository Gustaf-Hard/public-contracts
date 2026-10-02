import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { openDb } from '../src/storage.js';
import { applyVerdicts } from '../src/apply-verdicts.js';

const env = { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me' };
const sha = (s) => createHash('sha256').update(s).digest('hex');

function seed({ draft = 'tack för avtalen' } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr' });
  const mid = db.recordMessage({
    conversation_id: convId, gmail_message_id: 'in-1', direction: 'inbound',
    from_email: 'reg@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal',
    classification: 'delivery', classification_confidence: 0.9, received_at: '2026-09-01T00:00:00Z',
    attachment_count: 1, gmail_thread_id: 'thr',
  });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: mid, reason: 'r',
    draft_template: 'T_RECEIPT', draft_subject: 'Re: SV', draft_body: draft,
  });
  return { db, convId, mid, escId };
}

const escRow = (db, id) => db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(id);
const decisions = (db) => db.raw.prepare('SELECT * FROM decisions ORDER BY id').all();

describe('applyVerdicts', () => {
  const reviewedAt = '2026-09-26T03:00:00Z';

  it('dry run: writes nothing, sends nothing, reports the planned action', async () => {
    const { db, escId } = seed();
    const send = vi.fn(async () => ({ id: 'out', threadId: 'thr' }));
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: false, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('open');
    expect(res).toEqual([{ esc: escId, verdict: 'approve', outcome: 'would_send' }]);
  });

  it('approve sends the draft body unmodified with decision approve_unmodified', async () => {
    const { db, escId } = seed();
    const send = vi.fn(async () => ({ id: 'out', threadId: 'thr' }));
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send, sleep: async () => {},
      verdicts: [{ esc: escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') }] });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1].body).toContain('tack för avtalen');
    expect(escRow(db, escId).status).toBe('resolved_send');
    expect(decisions(db)[0].decision).toBe('approve_unmodified');
    expect(res[0].outcome).toBe('sent');
  });

  it('edit sends final_body with decision edit', async () => {
    const { db, escId } = seed();
    const send = vi.fn(async () => ({ id: 'out', threadId: 'thr' }));
    await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send, sleep: async () => {},
      verdicts: [{ esc: escId, verdict: 'edit', final_body: 'Hej,\n\nreviderat svar', draft_sha256: sha('tack för avtalen') }] });
    expect(send.mock.calls[0][1].body).toContain('reviderat svar');
    expect(decisions(db)[0].decision).toBe('edit');
    expect(decisions(db)[0].final_body).toContain('reviderat svar');
  });

  it('skip resolves the escalation as resolved_skip with a skip decision, sends nothing', async () => {
    const { db, escId } = seed();
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'skip', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('resolved_skip');
    expect(decisions(db)[0].decision).toBe('skip');
    expect(res[0].outcome).toBe('skipped');
  });

  it('an inbound that arrived after the review leaves the escalation untouched', async () => {
    const { db, escId, convId } = seed();
    db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-2', direction: 'inbound',
      from_email: 'reg@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'mer',
      classification: 'delivery', classification_confidence: 0.9, received_at: '2026-09-26T08:00:00Z',
      attachment_count: 0, gmail_thread_id: 'thr',
    });
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('open');
    expect(res[0].outcome).toBe('newer_inbound');
  });

  it('a draft that changed since the review is left untouched', async () => {
    const { db, escId } = seed({ draft: 'ny text' });
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('open');
    expect(res[0].outcome).toBe('draft_changed');
  });

  it('human, already-resolved and unknown rows are left alone', async () => {
    const { db, escId } = seed();
    db.resolveEscalation(escId, { status: 'resolved_skip' });
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send,
      verdicts: [
        { esc: escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') },
        { esc: 9999, verdict: 'approve', draft_sha256: 'x' },
        { esc: escId, verdict: 'human', draft_sha256: sha('tack för avtalen') },
      ] });
    expect(send).not.toHaveBeenCalled();
    expect(res.map((r) => r.outcome)).toEqual(['not_open', 'missing', 'left_for_operator']);
  });

  // Defer (2026-10-02): the reviewer's verdict for "leave this one parked".
  // Same five snapshot guards as skip, no Gmail at all.
  it('defer dry run reports would_defer and writes nothing', async () => {
    const { db, escId } = seed();
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: false, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('open');
    expect(decisions(db)).toHaveLength(0);
    // The verdict string travels verbatim, which is what makes --only=defer
    // (a plain Set over v.verdict in scripts/14-apply-verdicts.js) select it.
    expect(res).toEqual([{ esc: escId, verdict: 'defer', outcome: 'would_defer' }]);
  });

  it('defer parks the row with its reason, records a defer decision and sends nothing', async () => {
    const { db, convId, escId } = seed();
    db.updateConversationState(convId, 'NEEDS_HUMAN', { follow_up_at: '2026-10-20' });
    db.raw.prepare("UPDATE escalations SET previous_state = 'DELIVERING' WHERE id = ?").run(escId);
    const send = vi.fn();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send,
      verdicts: [{ esc: escId, verdict: 'defer', defer_reason: 'juridik', defer_note: 'överklagbart beslut', draft_sha256: sha('tack för avtalen') }] });
    expect(send).not.toHaveBeenCalled();
    expect(escRow(db, escId).status).toBe('deferred');
    expect(escRow(db, escId).resolved_text).toBe('pausad: juridik – överklagbart beslut');
    expect(escRow(db, escId).draft_body).toBe('tack för avtalen'); // frozen, resumable
    expect(decisions(db)[0].decision).toBe('defer');
    expect(decisions(db)[0].final_body).toBeNull();
    expect(res[0].outcome).toBe('deferred');
    // Off NEEDS_HUMAN, follow-up promise dropped — the same move the dashboard
    // Pausa form makes.
    expect(db.getConversation(convId).state).toBe('DELIVERING');
    expect(db.getConversation(convId).follow_up_at).toBeNull();
    expect(db.hasDeferredEscalation(convId)).toBe(true);
    expect(db.hasActiveEscalation(convId)).toBe(false);
  });

  // Round-14 finding 4: a parked row whose Slack message still carries live
  // buttons is a second way to send the draft the batch just parked. The
  // applier runs the dashboard's park sequence, Slack strip included.
  it('defer strips the Slack buttons through the injected slackOps', async () => {
    const { db, escId } = seed();
    db.raw.prepare("UPDATE escalations SET slack_ts = 'ts-1' WHERE id = ?").run(escId);
    const updateEscalationResolved = vi.fn(async () => {});
    await applyVerdicts({
      db, gmail: {}, env: { ...env, SLACK_CHANNEL_ID: 'C1' }, reviewedAt, apply: true,
      slackOps: { updateEscalationResolved },
      verdicts: [{ esc: escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }],
    });
    expect(updateEscalationResolved).toHaveBeenCalledOnce();
    expect(updateEscalationResolved.mock.calls[0][1]).toMatchObject({
      channel: 'C1', ts: 'ts-1', kommun_namn: 'Arboga', status: 'deferred',
    });
    expect(escRow(db, escId).status).toBe('deferred');
  });

  it('a Slack failure never un-parks the row or stops the batch', async () => {
    const { db, escId } = seed();
    db.raw.prepare("UPDATE escalations SET slack_ts = 'ts-1' WHERE id = ?").run(escId);
    const res = await applyVerdicts({
      db, gmail: {}, env: { ...env, SLACK_CHANNEL_ID: 'C1' }, reviewedAt, apply: true,
      slackOps: { updateEscalationResolved: vi.fn(async () => { throw new Error('slack 500'); }) },
      verdicts: [{ esc: escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }],
    });
    expect(res.at(-1).outcome).toBe('deferred');
    expect(escRow(db, escId).status).toBe('deferred');
  });

  it('without any Slack wiring the park still happens', async () => {
    const { db, escId } = seed();
    db.raw.prepare("UPDATE escalations SET slack_ts = 'ts-1' WHERE id = ?").run(escId);
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true,
      verdicts: [{ esc: escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }] });
    expect(res[0].outcome).toBe('deferred');
    expect(escRow(db, escId).status).toBe('deferred');
  });

  it('defer without a reason is refused before anything is written', async () => {
    const { db, escId } = seed();
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true,
      verdicts: [
        { esc: escId, verdict: 'defer', draft_sha256: sha('tack för avtalen') },
        { esc: escId, verdict: 'defer', defer_reason: 'nonsens', draft_sha256: sha('tack för avtalen') },
      ] });
    expect(res.map((r) => r.outcome)).toEqual(['missing_defer_reason', 'missing_defer_reason']);
    expect(escRow(db, escId).status).toBe('open');
    expect(decisions(db)).toHaveLength(0);
  });

  it('defer inherits the snapshot guards', async () => {
    // draft_changed
    const changed = seed({ draft: 'ny text' });
    let res = await applyVerdicts({ db: changed.db, gmail: {}, env, reviewedAt, apply: true,
      verdicts: [{ esc: changed.escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }] });
    expect(res[0].outcome).toBe('draft_changed');
    expect(escRow(changed.db, changed.escId).status).toBe('open');

    // newer_inbound
    const fresh = seed();
    fresh.db.recordMessage({
      conversation_id: fresh.convId, gmail_message_id: 'in-late', direction: 'inbound',
      from_email: 'reg@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'mer',
      classification: 'delivery', classification_confidence: 0.9, received_at: '2026-09-26T08:00:00Z',
      attachment_count: 0, gmail_thread_id: 'thr',
    });
    res = await applyVerdicts({ db: fresh.db, gmail: {}, env, reviewedAt, apply: true,
      verdicts: [{ esc: fresh.escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') }] });
    expect(res[0].outcome).toBe('newer_inbound');
    expect(escRow(fresh.db, fresh.escId).status).toBe('open');

    // not_open + missing
    const done = seed();
    done.db.resolveEscalation(done.escId, { status: 'resolved_send' });
    res = await applyVerdicts({ db: done.db, gmail: {}, env, reviewedAt, apply: true,
      verdicts: [
        { esc: done.escId, verdict: 'defer', defer_reason: 'avgift', draft_sha256: sha('tack för avtalen') },
        { esc: 4242, verdict: 'defer', defer_reason: 'avgift', draft_sha256: 'x' },
      ] });
    expect(res.map((r) => r.outcome)).toEqual(['not_open', 'missing']);
  });

  it('a failed send does not stop the batch', async () => {
    const a = seed();
    const db = a.db;
    const convId2 = db.createConversation({
      kommun_kod: '2', kommun_namn: 'Borås', role: 'central',
      contact_email: 'reg@boras.se', scheduled_send_at: '2026-05-01T00:00:00Z',
    });
    db.updateConversationState(convId2, 'DELIVERING', { gmail_thread_id: 'thr2' });
    const mid2 = db.recordMessage({
      conversation_id: convId2, gmail_message_id: 'in-b', direction: 'inbound',
      from_email: 'reg@boras.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal',
      classification: 'delivery', classification_confidence: 0.9, received_at: '2026-09-01T00:00:00Z',
      attachment_count: 1, gmail_thread_id: 'thr2',
    });
    const esc2 = db.recordEscalation({ conversation_id: convId2, message_id: mid2, reason: 'r', draft_template: 'T_RECEIPT', draft_subject: 'Re: SV', draft_body: 'tack' });
    let n = 0;
    const send = vi.fn(async () => { n += 1; if (n === 1) throw new Error('gmail 500'); return { id: 'out', threadId: 'thr2' }; });
    const res = await applyVerdicts({ db, gmail: {}, env, reviewedAt, apply: true, gmailSendImpl: send, sleep: async () => {},
      verdicts: [
        { esc: a.escId, verdict: 'approve', draft_sha256: sha('tack för avtalen') },
        { esc: esc2, verdict: 'approve', draft_sha256: sha('tack') },
      ] });
    expect(res.map((r) => r.outcome)).toEqual(['failed', 'sent']);
    expect(res[0].error).toContain('gmail 500');
    expect(escRow(db, a.escId).status).toBe('send_failed');
    expect(escRow(db, esc2).status).toBe('resolved_send');
  });
});
