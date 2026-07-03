import { describe, it, expect } from 'vitest';
import { resolveReplyRecipient } from '../src/threads.js';

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
