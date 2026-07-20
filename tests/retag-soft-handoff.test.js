// Offline retag helper for the soft-handoff cleanup (2026-07-20 §6).
// Temp DB only — never touches the live data/pilot.db. DO NOT RUN the helper
// against production here; these tests exercise it against injected fixtures.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { retagSoftHandoff } from '../src/retag-soft-handoff.js';
import { saneRestoreState } from '../src/send-reply.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-retag-sh-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seedConv({ email = 'registrator@bjurholm.se', thread = 'thr-bjurholm', state = 'SENT' } = {}) {
  const id = db.createConversation({
    kommun_kod: '2403', kommun_namn: 'Bjurholm', role: 'central', contact_email: email,
    scheduled_send_at: '2026-06-01T00:00:00Z',
  });
  db.updateConversationState(id, state, { gmail_thread_id: thread, last_outbound_at: '2026-06-10T10:00:00Z' });
  return id;
}

function recordInbound(convId, { body, subject = 'Re: Begäran', received_at = '2026-07-05T08:00:00Z', classification = 'unknown' } = {}) {
  return db.recordMessage({
    conversation_id: convId, gmail_message_id: `g-${Math.random()}`, direction: 'inbound',
    from_email: 'registrator@bjurholm.se', to_email: 'gustaf@mediagraf.se',
    subject, body_text: body, classification, classification_confidence: null,
    received_at, attachment_count: 0,
  });
}

function openFreeForm(convId, messageId, { reason = 'draft a reply', previous_state = 'SENT' } = {}) {
  return db.recordEscalation({
    conversation_id: convId, message_id: messageId, reason,
    draft_template: 'free_form', draft_subject: 'Re: Begäran', draft_body: '(ingen draft)',
    classifier_class: 'unknown', previous_state,
  });
}

describe('retagSoftHandoff (§6)', () => {
  it('supersedes an open free-form escalation whose message is a soft internal forward and pushes follow_up to today+21', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, {
      body: 'Tack för ditt mail. Jag skickar det vidare till vår skol- och IT-chef. Semestertider kan fördröja svaret.',
    });
    const escId = openFreeForm(conv, msgId);

    const acted = retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') });

    expect(acted).toEqual([{ escalation_id: escId, conversation_id: conv, follow_up_at: '2026-07-26', state: 'SENT' }]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('superseded');
    expect(db.getConversation(conv).follow_up_at).toBe('2026-07-26'); // 2026-07-05 + 21
    expect(db.getConversation(conv).state).toBe('SENT'); // unchanged, a wait
  });

  it('un-sticks a stranded NEEDS_HUMAN (previous_state itself NEEDS_HUMAN) back to a sane waiting state', () => {
    const conv = seedConv({ state: 'NEEDS_HUMAN' });
    const msgId = recordInbound(conv, { body: 'Jag har skickat vidare din begäran internt till upphandlingsenheten.' });
    openFreeForm(conv, msgId, { previous_state: 'NEEDS_HUMAN' });

    retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') });

    const c = db.getConversation(conv);
    expect(c.state).toBe('SENT');               // restored off NEEDS_HUMAN
    expect(c.follow_up_at).toBe('2026-07-26');  // still pushed
  });

  it('PRECISION: leaves a genuine EXTERNAL handoff (names an address) escalation untouched', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, {
      body: 'Dessa avtal hanteras av stadsledningen. Skicka vidare din begäran till registrator@stadsledningen.se.',
    });
    const escId = openFreeForm(conv, msgId);

    const acted = retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') });
    expect(acted).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('open');
    expect(db.getConversation(conv).follow_up_at ?? null).toBeNull();
  });

  it('PRECISION: leaves a genuine free-form reply (no forward phrase) untouched', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, { body: 'Hej, kan du ringa mig på 070-1234567 så pratar vi om detta?' });
    const escId = openFreeForm(conv, msgId);
    expect(retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') })).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('open');
  });

  it('never touches template-driven escalations (only free_form is a candidate)', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, { body: 'Jag skickar det vidare internt.' });
    const escId = db.recordEscalation({
      conversation_id: conv, message_id: msgId, reason: 'delivery',
      draft_template: 'T_RECEIPT', draft_subject: 'Re', draft_body: 'Tack',
      classifier_class: 'delivery', previous_state: 'DELIVERING',
    });
    expect(retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') })).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('open');
  });

  it('is idempotent — a second run finds nothing left to retag', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, { body: 'Jag skickar det vidare internt till IT.' });
    openFreeForm(conv, msgId);
    expect(retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') })).toHaveLength(1);
    expect(retagSoftHandoff(db, { now: new Date('2026-07-05T12:00:00Z') })).toHaveLength(0);
  });
});

describe('saneRestoreState (root-cause fix, 2026-07-20 stuck NEEDS_HUMAN)', () => {
  it('returns previous_state when it is a valid non-terminal waiting state', () => {
    expect(saneRestoreState('ACK_RECEIVED', { id: 1 }, null)).toBe('ACK_RECEIVED');
    expect(saneRestoreState('DELIVERING', { id: 1 }, null)).toBe('DELIVERING');
  });

  it('falls back to DELIVERING when receipt already sent', () => {
    expect(saneRestoreState('NEEDS_HUMAN', { id: 1, receipt_sent: 1 }, null)).toBe('DELIVERING');
  });

  it('falls back to SENT for a NEEDS_HUMAN/null previous_state with no prior progress', () => {
    expect(saneRestoreState('NEEDS_HUMAN', { id: 1 }, null)).toBe('SENT');
    expect(saneRestoreState(null, { id: 1 }, null)).toBe('SENT');
  });

  it('infers DELIVERING/ACK_RECEIVED from prior inbound when db is available', () => {
    const conv = seedConv();
    recordInbound(conv, { body: 'auto ack', classification: 'auto_ack' });
    expect(saneRestoreState(null, db.getConversation(conv), db)).toBe('ACK_RECEIVED');
    recordInbound(conv, { body: 'delivered', classification: 'delivery' });
    expect(saneRestoreState(null, db.getConversation(conv), db)).toBe('DELIVERING');
  });
});
