import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/storage.js';
import { sendApprovedReply } from '../src/send-reply.js';
import { T_INITIAL } from '../src/templates.js';

const env = { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me' };

function seedArboga() {
  const db = openDb(':memory:');
  db.migrate();
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
  const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-anneli', counterparty_email: 'Anneli.Waern@arboga.se' });
  const mid = db.recordMessage({
    conversation_id: convId, gmail_message_id: 'in-anneli', direction: 'inbound',
    from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal',
    classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z',
    attachment_count: 10, gmail_thread_id: 'thr-anneli', thread_id: t.id,
  });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: mid, reason: 'r',
    draft_template: 'free_form', draft_subject: 'Re: SV', draft_body: 'tack',
  });
  return { db, conv: db.getConversation(convId), esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId) };
}

describe('sendApprovedReply recipient routing', () => {
  it('replies to the triggering message sender + its thread, not conv.contact_email', async () => {
    const { db, conv, esc } = seedArboga();
    const gmail = {};
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-anneli' }));
    await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send.mock.calls[0][1]).toMatchObject({ to: 'Anneli.Waern@arboga.se', threadId: 'thr-anneli' });
    const out = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'out-1'").get();
    expect(out.to_email).toBe('Anneli.Waern@arboga.se');
    expect(out.gmail_thread_id).toBe('thr-anneli');
  });

  it('honours an explicit finalTo override', async () => {
    const { db, conv, esc } = seedArboga();
    const send = vi.fn(async () => ({ id: 'out-2', threadId: 'thr-anneli' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', finalTo: 'someone.else@arboga.se', decision: 'edit', gmailSendImpl: send });
    expect(send.mock.calls[0][1]).toMatchObject({ to: 'someone.else@arboga.se' });
  });
});

describe('sendApprovedReply archives the replied-into thread', () => {
  it('archives the thread it sent into, keeping the inbox clean', async () => {
    const { db, conv, esc } = seedArboga();
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-anneli' }));
    const archive = vi.fn(async () => {});
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send, archiveThreadImpl: archive });
    expect(archive).toHaveBeenCalledOnce();
    expect(archive.mock.calls[0][1]).toBe('thr-anneli'); // the thread Gmail returned
  });

  it('an archive failure never breaks the (already-confirmed) send', async () => {
    const { db, conv, esc } = seedArboga();
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-anneli' }));
    const archive = vi.fn(async () => { throw new Error('gmail 500'); });
    // Must resolve, not reject — the send succeeded, archiving is cosmetic.
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send, archiveThreadImpl: archive })
    ).resolves.toMatchObject({ id: 'out-1' });
    // The outbound + escalation resolution still committed.
    expect(db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'out-1'").get()).toBeTruthy();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('resolved_send');
  });
});

// A bounce resend escalation (2026-07-19 §4): a T-INITIAL that bounced off a
// dead address. sendApprovedReply must treat it as a fresh T-INITIAL to a
// corrected recipient in a NEW thread, via the same two-phase atomic claim.
function seedBounce() {
  const db = openDb(':memory:');
  db.migrate();
  const convId = db.createConversation({
    kommun_kod: '1281', kommun_namn: 'Lund', role: 'central',
    contact_email: 'lund.kommun@lund.se', scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  // The bounce moved the conversation to NEEDS_HUMAN and left the T-INITIAL as
  // the resend draft.
  db.updateConversationState(convId, 'NEEDS_HUMAN', { gmail_thread_id: 'thr-bounce' });
  const initial = T_INITIAL({ kommun_namn: 'Lund', role: 'central', from_email: 'me@x.se', from_name: 'Me' });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: null,
    reason: 'Leveransfel: adressen `lund.kommun@lund.se` finns inte — ange ny adress och skicka om begäran.',
    draft_template: 'T_RESEND_BAD_ADDRESS', draft_subject: initial.subject, draft_body: initial.body,
    classifier_class: 'bounce', previous_state: 'SENT',
  });
  return { db, conv: db.getConversation(convId), esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId), initial };
}

describe('sendApprovedReply — bounce resend (§4)', () => {
  it('rejects an empty finalTo, leaving the escalation OPEN and sending nothing', async () => {
    const { db, conv, esc } = seedBounce();
    const send = vi.fn(async () => ({ id: 'out-x', threadId: 'thr-x' }));
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: esc.draft_body, finalTo: '   ', decision: 'edit', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'MISSING_RESEND_ADDRESS' });
    expect(send).not.toHaveBeenCalled();
    // Never claimed, never parked — still open for the operator to try again.
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('open');
    // Never sent to the dead address.
    expect(db.getConversation(conv.id).state).toBe('NEEDS_HUMAN');
  });

  it('with a corrected address, resends a T-INITIAL in a NEW thread (no reply threadId) via the two-phase claim', async () => {
    const { db, conv, esc, initial } = seedBounce();
    const send = vi.fn(async () => ({ id: 'out-resend', threadId: 'thr-fresh' }));
    await sendApprovedReply({
      db, gmail: {}, env, conv, esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      finalTo: 'registrator@lund.se', decision: 'edit', gmailSendImpl: send,
    });
    // Fresh T-INITIAL: to the corrected address, NO threadId (a brand-new
    // thread — never a reply into the bounce thread).
    expect(send.mock.calls[0][1]).toMatchObject({
      to: 'registrator@lund.se', subject: initial.subject, body: initial.body,
    });
    expect(send.mock.calls[0][1].threadId).toBeUndefined();
    // Conversation back to SENT on the NEW thread with the CORRECTED address.
    const after = db.getConversation(conv.id);
    expect(after.state).toBe('SENT');
    expect(after.gmail_thread_id).toBe('thr-fresh');
    expect(after.contact_email).toBe('registrator@lund.se');
    // Escalation resolved (not superseded/parked).
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('resolved_edit');
    // The outbound is recorded on the fresh thread.
    const out = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'out-resend'").get();
    expect(out.to_email).toBe('registrator@lund.se');
    expect(out.gmail_thread_id).toBe('thr-fresh');
  });

  it('a Gmail failure parks the escalation as send_failed, never back to open', async () => {
    const { db, conv, esc } = seedBounce();
    const send = vi.fn(async () => { throw new Error('gmail 500'); });
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: esc.draft_body, finalTo: 'registrator@lund.se', decision: 'edit', gmailSendImpl: send })
    ).rejects.toThrow('gmail 500');
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('send_failed');
    // No outbound recorded, contact_email NOT changed (nothing confirmed sent).
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n).toBe(0);
    expect(db.getConversation(conv.id).contact_email).toBe('lund.kommun@lund.se');
  });

  it('a second concurrent approve fails the atomic claim (ESCALATION_NOT_OPEN)', async () => {
    const { db, conv, esc } = seedBounce();
    const send = vi.fn(async () => ({ id: 'out-resend', threadId: 'thr-fresh' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: esc.draft_body, finalTo: 'registrator@lund.se', decision: 'edit', gmailSendImpl: send });
    // The stale esc snapshot still says 'open' — the claim must reject it.
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: esc.draft_body, finalTo: 'registrator@lund.se', decision: 'edit', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'ESCALATION_NOT_OPEN' });
    expect(send).toHaveBeenCalledTimes(1); // never double-sent
  });
});
