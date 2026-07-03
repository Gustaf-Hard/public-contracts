import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/storage.js';
import { sendApprovedReply } from '../src/send-reply.js';

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
