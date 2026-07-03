import { describe, it, expect, vi } from 'vitest';
import { resolveReplyRecipient, inferThreadStatus } from '../src/threads.js';
import { openDb } from '../src/storage.js';
import { backfillThreads } from '../src/backfill-threads.js';

const conv = { contact_email: 'registrator@x.se', gmail_thread_id: 'thr-orig' };

describe('resolveReplyRecipient', () => {
  it('routes to the triggering message sender + its thread', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: { from_email: 'Anneli.Waern@arboga.se', gmail_thread_id: 'thr-anneli' },
      conv,
    });
    expect(r).toEqual({ to: 'Anneli.Waern@arboga.se', threadId: 'thr-anneli' });
  });

  it('falls back to the conversation contact when there is no triggering message and no primary thread', () => {
    const r = resolveReplyRecipient({ triggeringMessage: null, conv, primaryThreads: [] });
    expect(r).toEqual({ to: 'registrator@x.se', threadId: 'thr-orig' });
  });

  it('routes a proactive reply to the single primary thread when present', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: null, conv,
      primaryThreads: [{ counterparty_email: 'anneli@arboga.se', gmail_thread_id: 'thr-anneli' }],
    });
    expect(r).toEqual({ to: 'anneli@arboga.se', threadId: 'thr-anneli' });
  });

  it('falls back to conv thread id when the triggering message lacks one', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: { from_email: 'a@x.se', gmail_thread_id: null }, conv,
    });
    expect(r).toEqual({ to: 'a@x.se', threadId: 'thr-orig' });
  });
});

describe('backfillThreads', () => {
  it('groups existing messages into threads and stamps them, idempotently', async () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'reg-1', direction: 'inbound', from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.se', subject: 'ack', body_text: '', classification: 'auto_ack', classification_confidence: 0.9, received_at: '2026-06-08T00:00:00Z', attachment_count: 0 });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'ann-1', direction: 'inbound', from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z', attachment_count: 10 });

    const gmailOps = { getMessage: vi.fn(async (g, id) => ({ id, threadId: id === 'ann-1' ? 'thr-anneli' : 'thr-orig' })) };
    const r = await backfillThreads({ db, gmail: {}, gmailOps });
    expect(r.updated).toBe(2);
    expect(db.listThreadsForConversation(convId)).toHaveLength(2);
    const ann = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'ann-1'").get();
    expect(ann.gmail_thread_id).toBe('thr-anneli');
    expect(ann.thread_id).toBeTruthy();

    const r2 = await backfillThreads({ db, gmail: {}, gmailOps }); // idempotent
    expect(r2.updated).toBe(0);
  });
});

describe('inferThreadStatus', () => {
  it('primary when any inbound has attachments or a SUBSTANCE classification', () => {
    expect(inferThreadStatus([{ classification: 'auto_ack', attachment_count: 0 }, { classification: 'auto_ack', attachment_count: 3 }])).toBe('primary'); // attachments win
    expect(inferThreadStatus([{ classification: 'delivery', attachment_count: 0 }])).toBe('primary');
    expect(inferThreadStatus([{ classification: 'clarification', attachment_count: 0 }])).toBe('primary');
  });
  it('muted only when every inbound is auto_ack with no attachments', () => {
    expect(inferThreadStatus([{ classification: 'auto_ack', attachment_count: 0 }, { classification: 'auto_ack', attachment_count: 0 }])).toBe('muted');
  });
  it('neutral for no inbound, unknown, dead_end, or unmapped', () => {
    expect(inferThreadStatus([])).toBe('neutral');
    expect(inferThreadStatus([{ classification: 'unknown', attachment_count: 0 }])).toBe('neutral'); // handoff/fee-demand — needs a human, never muted
    expect(inferThreadStatus([{ classification: 'dead_end', attachment_count: 0 }])).toBe('neutral');
    expect(inferThreadStatus([{ classification: 'weird_new_intent', attachment_count: 0 }])).toBe('neutral');
  });
});
