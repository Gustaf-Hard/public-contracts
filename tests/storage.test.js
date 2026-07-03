import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-storage-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrate', () => {
  it('creates the five tables idempotently', () => {
    expect(() => db.migrate()).not.toThrow();
    expect(() => db.migrate()).not.toThrow();
  });
});

describe('conversations', () => {
  it('creates and retrieves a conversation', () => {
    const id = db.createConversation({
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    const conv = db.getConversation(id);
    expect(conv.state).toBe('INITIAL');
    expect(conv.kommun_kod).toBe('9999');
    expect(conv.role).toBe('utbildning');
  });

  it('enforces unique (kommun_kod, role)', () => {
    const args = {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    };
    db.createConversation(args);
    expect(() => db.createConversation(args)).toThrow();
  });

  it('updates state and stamps state_changed_at', async () => {
    const id = db.createConversation({
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      role: 'central',
      contact_email: 'gustaf.hard@gmail.com',
      scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    const before = db.getConversation(id).state_changed_at;
    await new Promise(r => setTimeout(r, 1010)); // Wait > 1 second to ensure timestamp changes
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'tid1', last_outbound_at: '2026-05-19T10:01:00Z' });
    const after = db.getConversation(id);
    expect(after.state).toBe('SENT');
    expect(after.gmail_thread_id).toBe('tid1');
    expect(after.state_changed_at).not.toBe(before);
  });

  it('lists conversations in a given state', () => {
    db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'utbildning', contact_email: 'b@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    expect(db.listConversationsByState('INITIAL')).toHaveLength(2);
    expect(db.listConversationsByState('SENT')).toHaveLength(0);
  });
});

describe('messages', () => {
  it('records inbound and outbound messages tied to a conversation', () => {
    const id = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.recordMessage({
      conversation_id: id,
      gmail_message_id: 'm1',
      direction: 'outbound',
      from_email: 'gustaf@mediagraf.se',
      to_email: 'a@x.se',
      subject: 'Begäran',
      body_text: 'Hej',
      classification: null,
      classification_confidence: null,
      received_at: '2026-05-19T10:00:00Z',
      attachment_count: 0,
    });
    db.recordMessage({
      conversation_id: id,
      gmail_message_id: 'm2',
      direction: 'inbound',
      from_email: 'a@x.se',
      to_email: 'gustaf@mediagraf.se',
      subject: 'Re: Begäran',
      body_text: 'Tack',
      classification: 'auto_ack',
      classification_confidence: 0.85,
      received_at: '2026-05-19T10:05:00Z',
      attachment_count: 0,
    });
    const messages = db.listMessages(id);
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.direction === 'inbound').classification).toBe('auto_ack');
  });

  it('hasGmailMessageId returns true for stored ids', () => {
    const id = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.recordMessage({
      conversation_id: id, gmail_message_id: 'mX', direction: 'inbound',
      from_email: 'a@x.se', to_email: 'gustaf@mediagraf.se',
      subject: 's', body_text: 'b', classification: 'auto_ack',
      classification_confidence: 0.9, received_at: '2026-05-19T10:00:00Z', attachment_count: 0,
    });
    expect(db.hasGmailMessageId('mX')).toBe(true);
    expect(db.hasGmailMessageId('mY')).toBe(false);
  });
});

describe('escalations', () => {
  it('records and resolves an escalation with subject + body', () => {
    const cid = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    const eid = db.recordEscalation({
      conversation_id: cid,
      message_id: null,
      reason: 'classifier returned clarification',
      draft_template: 'T_PRECISION',
      draft_subject: 'Re: Begäran',
      draft_body: 'Tack för...',
      slack_ts: '1234.5678',
    });
    const list = db.listOpenEscalations();
    expect(list).toHaveLength(1);
    expect(list[0].draft_body).toBe('Tack för...');
    expect(list[0].draft_template).toBe('T_PRECISION');
    db.resolveEscalation(eid, { status: 'resolved_send', resolved_text: 'Tack för...' });
    expect(db.listOpenEscalations()).toHaveLength(0);
  });

  it('persists classifier_class, classifier_confidence, previous_state on escalation', () => {
    const cid = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'utbildning', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    db.recordEscalation({
      conversation_id: cid,
      reason: 'unknown classification',
      draft_template: 'free_form',
      draft_subject: 'Re: x',
      draft_body: '(ingen draft)',
      classifier_class: 'unknown',
      classifier_confidence: 0.4,
      previous_state: 'SENT',
    });
    const list = db.listOpenEscalations();
    expect(list).toHaveLength(1);
    expect(list[0].classifier_class).toBe('unknown');
    expect(list[0].classifier_confidence).toBeCloseTo(0.4);
    expect(list[0].previous_state).toBe('SENT');
  });
});

describe('decisions', () => {
  it('records a decision tied to an escalation', () => {
    const cid = db.createConversation({ kommun_kod: '9999', kommun_namn: 'T', role: 'utbildning', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    const eid = db.recordEscalation({
      conversation_id: cid, reason: 'r', draft_template: 'T_PRECISION',
      draft_subject: 'Re: x', draft_body: 'body',
    });
    const did = db.recordDecision({
      escalation_id: eid,
      conversation_id: cid,
      conversation_state: 'ACK_RECEIVED',
      classifier_class: 'clarification',
      classifier_confidence: 0.85,
      draft_template: 'T_PRECISION',
      draft_body: 'body',
      decision: 'approve_unmodified',
      final_body: 'body',
    });
    expect(did).toBeGreaterThan(0);
    const list = db.listDecisions();
    expect(list).toHaveLength(1);
    expect(list[0].decision).toBe('approve_unmodified');
    expect(list[0].classifier_class).toBe('clarification');
  });
});

describe('threads', () => {
  it('creates the threads table and upserts idempotently by (conversation_id, gmail_thread_id)', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'X', role: 'central',
      contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z',
    });
    const t1 = db.upsertThread({
      conversation_id: convId, gmail_thread_id: 'thr-a',
      counterparty_email: 'a@x.se', counterparty_name: 'A', last_inbound_at: '2026-06-01T00:00:00Z',
    });
    expect(t1.status).toBe('neutral');
    expect(t1.status_source).toBe('auto');
    const t2 = db.upsertThread({
      conversation_id: convId, gmail_thread_id: 'thr-a',
      counterparty_email: 'a2@x.se', last_inbound_at: '2026-06-02T00:00:00Z',
    });
    expect(t2.id).toBe(t1.id);                 // same row
    expect(t2.counterparty_email).toBe('a2@x.se');
    expect(t2.last_inbound_at).toBe('2026-06-02T00:00:00Z');
    expect(db.listThreadsForConversation(convId)).toHaveLength(1);
  });

  it('setThreadStatus persists status + source; recordMessage stores thread ids', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'X', role: 'central',
      contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z',
    });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a' });
    db.setThreadStatus(t.id, 'muted', 'manual');
    expect(db.getThreadById(t.id).status).toBe('muted');
    expect(db.getThreadById(t.id).status_source).toBe('manual');
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'g1', direction: 'inbound',
      from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: 'b',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-01T00:00:00Z', attachment_count: 1,
      gmail_thread_id: 'thr-a', thread_id: t.id,
    });
    const m = db.getMessageById(mid);
    expect(m.gmail_thread_id).toBe('thr-a');
    expect(m.thread_id).toBe(t.id);
  });
});

describe('getTickHealth', () => {
  it('is stale with no successful tick yet', () => {
    const h = db.getTickHealth();
    expect(h.ever).toBe(false);
    expect(h.stale).toBe(true);
  });

  it('becomes healthy after a clean tick; a later failure keeps last_success_at', () => {
    db.recordHeartbeat({ kind: 'tick', error: null });
    let h = db.getTickHealth();
    expect(h.ever).toBe(true);
    expect(h.stale).toBe(false);
    expect(h.last_success_at).toBeTruthy();

    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    h = db.getTickHealth();
    expect(h.last_error).toBe('invalid_grant');
    expect(h.last_success_at).toBeTruthy(); // preserved from the clean tick
    expect(h.stale).toBe(false);            // success still recent
  });

  it('is stale when the last success is older than the threshold', () => {
    db.recordHeartbeat({ error: null });
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h
    expect(db.getTickHealth({ now: future, thresholdMin: 60 }).stale).toBe(true);
  });
});
