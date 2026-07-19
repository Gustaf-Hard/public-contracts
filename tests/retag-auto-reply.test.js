// Offline retag helper for the autosvar/OOO cleanup (2026-07-19 §3).
// Temp DB only — never touches the live data/pilot.db. DO NOT RUN the helper
// against production here; these tests exercise it against injected fixtures.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { retagAutoReplyEscalations } from '../src/retag-auto-reply.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-retag-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seedConv({ email = 'registrator@bjuv.se', thread = 'thr-bjuv' } = {}) {
  const id = db.createConversation({
    kommun_kod: '1260', kommun_namn: 'Bjuv', role: 'central', contact_email: email,
    scheduled_send_at: '2026-06-01T00:00:00Z',
  });
  db.updateConversationState(id, 'SENT', { gmail_thread_id: thread, last_outbound_at: '2026-06-10T10:00:00Z' });
  return id;
}

function recordInbound(convId, { body, subject = 'Re: Begäran', received_at = '2026-07-05T08:00:00Z', classification = 'unknown' } = {}) {
  return db.recordMessage({
    conversation_id: convId, gmail_message_id: `g-${Math.random()}`, direction: 'inbound',
    from_email: 'registrator@bjuv.se', to_email: 'gustaf@mediagraf.se',
    subject, body_text: body, classification, classification_confidence: null,
    received_at, attachment_count: 0,
  });
}

function openFreeForm(convId, messageId, reason = 'draft a reply') {
  return db.recordEscalation({
    conversation_id: convId, message_id: messageId, reason,
    draft_template: 'free_form', draft_subject: 'Re: Begäran', draft_body: '(ingen draft)',
    classifier_class: 'unknown', previous_state: 'SENT',
  });
}

describe('retagAutoReplyEscalations (§3)', () => {
  it('supersedes an open free-form escalation whose message is an autosvar and pushes follow_up past the return date', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, {
      subject: 'Autosvar: Begäran om allmänna handlingar',
      body: 'Autosvar: Jag har semester och är åter 20 juli. Vid akuta ärenden kontakta min kollega.',
    });
    const escId = openFreeForm(conv, msgId);

    const acted = retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') });

    expect(acted).toEqual([{ escalation_id: escId, conversation_id: conv, follow_up_at: '2026-07-23' }]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('superseded');
    expect(db.getConversation(conv).follow_up_at).toBe('2026-07-23');
    // State intentionally unchanged — an autosvar is a wait, not a transition.
    expect(db.getConversation(conv).state).toBe('SENT');
  });

  it('defaults follow_up to received + 14 when the autosvar has no return date', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, {
      subject: 'Automatiskt svar',
      body: 'Automatiskt svar: Jag är för närvarande frånvarande.',
      received_at: '2026-07-05T08:00:00Z',
    });
    const escId = openFreeForm(conv, msgId);

    retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') });
    expect(db.getConversation(conv).follow_up_at).toBe('2026-07-19'); // 2026-07-05 + 14
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('superseded');
  });

  it('leaves a GENUINE free-form escalation (real reply) untouched — precision over recall', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, {
      subject: 'Re: Begäran',
      body: 'Hej, kan du ringa mig på 070-1234567 så pratar vi om detta? Det är lite oklart vad ni vill ha.',
    });
    const escId = openFreeForm(conv, msgId);

    const acted = retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') });
    expect(acted).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('open');
    expect(db.getConversation(conv).follow_up_at ?? null).toBeNull();
  });

  it('never touches template-driven escalations (only free_form is a candidate)', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, { body: 'Autosvar: semester, åter 20 juli.' });
    const escId = db.recordEscalation({
      conversation_id: conv, message_id: msgId, reason: 'delivery',
      draft_template: 'T_RECEIPT', draft_subject: 'Re', draft_body: 'Tack',
      classifier_class: 'delivery', previous_state: 'DELIVERING',
    });
    const acted = retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') });
    expect(acted).toEqual([]);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('open');
  });

  it('is idempotent — a second run finds nothing left to retag', () => {
    const conv = seedConv();
    const msgId = recordInbound(conv, { body: 'Autosvar: semester, åter 20 juli.' });
    openFreeForm(conv, msgId);
    expect(retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') })).toHaveLength(1);
    expect(retagAutoReplyEscalations(db, { now: new Date('2026-07-05T12:00:00Z') })).toHaveLength(0);
  });
});
