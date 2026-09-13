import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, ACTIVE_ESCALATION_STATUSES } from '../src/storage.js';

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

describe('resolveEscalationIfOpen — atomic conditional resolve (finding 7)', () => {
  function seedEscalation() {
    const cid = db.createConversation({ kommun_kod: '7777', kommun_namn: 'T', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
    return db.recordEscalation({ conversation_id: cid, reason: 'r', draft_template: 'free_form', draft_subject: 's', draft_body: 'b' });
  }

  it('resolves an open escalation and reports success', () => {
    const eid = seedEscalation();
    expect(db.resolveEscalationIfOpen(eid, { status: 'resolved_skip' })).toBe(true);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(eid).status).toBe('resolved_skip');
  });

  it('never clobbers a non-open escalation — resolved_send survives a racing skip', () => {
    const eid = seedEscalation();
    db.resolveEscalation(eid, { status: 'resolved_send', resolved_text: 'sent' });
    expect(db.resolveEscalationIfOpen(eid, { status: 'resolved_skip' })).toBe(false);
    const row = db.raw.prepare('SELECT status, resolved_text FROM escalations WHERE id=?').get(eid);
    expect(row.status).toBe('resolved_send');
    expect(row.resolved_text).toBe('sent');
  });
});

describe('hasActiveEscalation — one notion of "non-terminal" (hardening 2/3)', () => {
  function seedEsc(status) {
    const cid = db.createConversation({
      kommun_kod: `${9000 + seedEsc.n++}`, kommun_namn: 'T', role: 'central',
      contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    const eid = db.recordEscalation({
      conversation_id: cid, reason: 'r', draft_template: 'free_form',
      draft_subject: 's', draft_body: 'b',
    });
    if (status !== 'open') db.resolveEscalation(eid, { status });
    return { cid, eid };
  }
  seedEsc.n = 0;

  it('open, sending, send_failed and send_unconfirmed are ACTIVE', () => {
    for (const status of ['open', 'sending', 'send_failed', 'send_unconfirmed']) {
      const { cid } = seedEsc(status);
      expect(db.hasActiveEscalation(cid), status).toBe(true);
      expect(db.listActiveEscalationsForConversation(cid).map((e) => e.status)).toEqual([status]);
    }
  });

  it('resolved_* and superseded are terminal; empty conversations are inactive', () => {
    for (const status of ['resolved_send', 'resolved_edit', 'resolved_skip', 'resolved_closed', 'superseded']) {
      const { cid } = seedEsc(status);
      expect(db.hasActiveEscalation(cid), status).toBe(false);
      expect(db.listActiveEscalationsForConversation(cid)).toEqual([]);
    }
    const cid = db.createConversation({
      kommun_kod: '8999', kommun_namn: 'T', role: 'central',
      contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z',
    });
    expect(db.hasActiveEscalation(cid)).toBe(false);
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

  // Round-7 L1: the ledger's `decided_at` is the boundary that discharges a
  // kommun-imposed frist, and the send path needs it to be the moment the send
  // STARTED, not the moment the row was written (Slack cleanup + Gmail archive
  // sit in between). The column keeps its datetime('now') default for every
  // caller that has nothing better to say (skip/closed resolve nothing sent).
  describe('decided_at (round-7 L1)', () => {
    function seedFor() {
      const cid = db.createConversation({ kommun_kod: '9998', kommun_namn: 'Stämpel', role: 'central', contact_email: 'a@x.se', scheduled_send_at: '2026-05-19T10:00:00Z' });
      const eid = db.recordEscalation({ conversation_id: cid, reason: 'r', draft_body: 'body' });
      return { cid, eid };
    }
    const base = (cid, eid) => ({
      escalation_id: eid, conversation_id: cid, conversation_state: 'SENT',
      draft_body: 'body', decision: 'edit', final_body: 'body',
    });
    const read = (id) => db.raw.prepare('SELECT decided_at FROM decisions WHERE id = ?').get(id).decided_at;

    it('stores an explicit decided_at verbatim', () => {
      const { cid, eid } = seedFor();
      const did = db.recordDecision({ ...base(cid, eid), decided_at: '2026-09-12 10:00:00' });
      expect(read(did)).toBe('2026-09-12 10:00:00');
    });

    it('falls back to the SQLite clock when decided_at is omitted', () => {
      const { cid, eid } = seedFor();
      const did = db.recordDecision(base(cid, eid));
      expect(read(did)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(Math.abs(Date.parse(`${read(did).replace(' ', 'T')}Z`) - Date.now())).toBeLessThan(5000);
    });

    it('treats null/undefined decided_at as "use the default"', () => {
      const { cid, eid } = seedFor();
      for (const v of [null, undefined]) {
        const did = db.recordDecision({ ...base(cid, eid), decided_at: v });
        expect(read(did)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      }
    });
  });

  describe('listEditDecisions', () => {
    function seedDecision({ kommun_kod, kommun_namn, role, decision, decided_at, draft = 'draft text', final = 'final text' }) {
      const cid = db.createConversation({
        kommun_kod, kommun_namn, role,
        contact_email: `${kommun_kod}@x.se`, scheduled_send_at: '2026-05-19T10:00:00Z',
      });
      const eid = db.recordEscalation({
        conversation_id: cid, reason: 'reply_needs_review',
        draft_template: 'T_PRECISION', draft_subject: 'Re: x', draft_body: draft,
        classifier_class: 'clarification',
      });
      const did = db.recordDecision({
        escalation_id: eid, conversation_id: cid,
        conversation_state: 'ACK_RECEIVED', classifier_class: 'clarification',
        classifier_confidence: 0.85, draft_template: 'T_PRECISION',
        draft_body: draft, decision, final_body: final,
      });
      if (decided_at) db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decided_at, did);
      return did;
    }

    it('returns only edit decisions, joined to conversation fields, newest first', () => {
      seedDecision({ kommun_kod: '0180', kommun_namn: 'Stockholm', role: 'central', decision: 'approve_unmodified', decided_at: '2026-07-01 08:00:00' });
      const oldEdit = seedDecision({ kommun_kod: '2506', kommun_namn: 'Arjeplog', role: 'central', decision: 'edit', decided_at: '2026-07-02 08:00:00', draft: 'bot draft A', final: 'sent A' });
      seedDecision({ kommun_kod: '1980', kommun_namn: 'Västerås', role: 'utbildning', decision: 'skip', decided_at: '2026-07-03 08:00:00' });
      const newEdit = seedDecision({ kommun_kod: '1480', kommun_namn: 'Göteborg', role: 'utbildning', decision: 'edit', decided_at: '2026-07-04 08:00:00', draft: 'bot draft B', final: 'sent B' });

      const rows = db.listEditDecisions();
      expect(rows).toHaveLength(2);
      // Newest first
      expect(rows.map((r) => r.decision_id)).toEqual([newEdit, oldEdit]);
      const r = rows[0];
      expect(r).toMatchObject({
        decision_id: newEdit,
        decided_at: '2026-07-04 08:00:00',
        kommun_kod: '1480',
        kommun_namn: 'Göteborg',
        role: 'utbildning',
        classifier_class: 'clarification',
        conversation_state: 'ACK_RECEIVED',
        draft_template: 'T_PRECISION',
        draft_body: 'bot draft B',
        final_body: 'sent B',
      });
    });

    it('returns an empty array when there are no edit decisions', () => {
      expect(db.listEditDecisions()).toEqual([]);
    });
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

  // The 09:00 follow-up touches no Gmail, so its success proves nothing about
  // ingest — but it used to write last_error = NULL unconditionally, erasing
  // the invalid_grant diagnosis the dashboard health modal keys on.
  it('a clean follow-up never erases the tick error it knows nothing about', () => {
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    db.recordHeartbeat({ kind: 'followup', error: null });
    expect(db.getTickHealth().last_error).toBe('invalid_grant');
  });

  it('a FAILING follow-up still records its own error, and a clean tick still clears', () => {
    db.recordHeartbeat({ kind: 'followup', error: 'followup crashed' });
    expect(db.getTickHealth().last_error).toBe('followup crashed');
    db.recordHeartbeat({ kind: 'tick', error: null });
    expect(db.getTickHealth().last_error).toBeNull();
  });
});

describe('follow-up completion bookkeeping (catch-up after a blind 09:00)', () => {
  it('starts unset and round-trips a local date', () => {
    expect(db.getFollowupCompletedDate()).toBeNull();
    db.markFollowupCompleted('2026-08-16');
    expect(db.getFollowupCompletedDate()).toBe('2026-08-16');
    db.markFollowupCompleted('2026-08-17');
    expect(db.getFollowupCompletedDate()).toBe('2026-08-17');
  });
});

describe('upsertThread — last_inbound_at only moves forward', () => {
  // Messages do not arrive in delivery order: a post-outage backfill (or the
  // widened Cc-only inbound query surfacing old mail for the first time)
  // ingests an OLDER internalDate later. A plain COALESCE overwrite rewound the
  // thread clock and corrupted thread ordering.
  it('keeps the newer timestamp when an older message is ingested afterwards', () => {
    const convId = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'k@ale.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a', last_inbound_at: '2026-06-20T10:00:00.000Z' });
    const older = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a', last_inbound_at: '2026-06-02T08:00:00.000Z' });
    expect(older.last_inbound_at).toBe('2026-06-20T10:00:00.000Z');
  });

  it('still advances on a genuinely newer message, and fills in from null', () => {
    const convId = db.createConversation({
      kommun_kod: '1441', kommun_namn: 'Alingsås', role: 'central',
      contact_email: 'k@alingsas.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-b' });
    expect(db.getThread(convId, 'thr-b').last_inbound_at).toBeNull();
    db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-b', last_inbound_at: '2026-06-02T08:00:00.000Z' });
    expect(db.getThread(convId, 'thr-b').last_inbound_at).toBe('2026-06-02T08:00:00.000Z');
    db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-b', last_inbound_at: '2026-06-21T09:00:00.000Z' });
    expect(db.getThread(convId, 'thr-b').last_inbound_at).toBe('2026-06-21T09:00:00.000Z');
    // A null carries no information and must not wipe the stamp.
    db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-b', counterparty_name: 'Reg' });
    expect(db.getThread(convId, 'thr-b').last_inbound_at).toBe('2026-06-21T09:00:00.000Z');
  });
});

describe('countUnreadAnalysableAttachments', () => {
  function seedAttachment(convId, { filename, mime_type = null, analysed = false, attempts = 0 }) {
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: `g-${filename}`, direction: 'inbound',
      from_email: 'k@x.se', to_email: 'g@m.se', subject: 's', body_text: 'b',
      classification: 'delivery', classification_confidence: 1,
      received_at: '2026-06-20T10:00:00Z', attachment_count: 1,
    });
    const aid = db.recordAttachment({ message_id: mid, filename, saved_path: `/tmp/${filename}`, mime_type, size_bytes: 10 });
    if (attempts) db.recordAnalysisFailure(aid, { reason: 'transient:api_5xx' });
    if (analysed) db.recordContract({ attachment_id: aid, is_contract: 1, summary: 's' });
    return aid;
  }

  it('counts pending AND parked analysable documents, ignores extracted and non-analysable ones', () => {
    const convId = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'k@ale.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    expect(db.countUnreadAnalysableAttachments(convId)).toBe(0);
    seedAttachment(convId, { filename: 'Läst.pdf', mime_type: 'application/pdf', analysed: true });
    expect(db.countUnreadAnalysableAttachments(convId)).toBe(0);
    seedAttachment(convId, { filename: 'Kö.pdf', mime_type: 'application/pdf' });
    seedAttachment(convId, { filename: 'Lista.xlsx' });
    seedAttachment(convId, { filename: 'Brev.docx' });
    // A logo is not a document we would ever extract — it is not "unread".
    seedAttachment(convId, { filename: 'logo.png', mime_type: 'image/png' });
    expect(db.countUnreadAnalysableAttachments(convId)).toBe(3);
  });
});

describe('listContractInfoForMessage', () => {
  it('returns is_contract, vendor_name (via vendor_id) and analysis_json per analyzed attachment', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: 'm1', direction: 'inbound', from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: 'b', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z', attachment_count: 2 });
    const a1 = db.recordAttachment({ message_id: msgId, filename: 'avtal.pdf', saved_path: '/x/avtal.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const a2 = db.recordAttachment({ message_id: msgId, filename: 'brev.pdf', saved_path: '/x/brev.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const v = db.upsertVendor('Skolon');
    db.recordContract({ attachment_id: a1, vendor_id: v.id, is_contract: 1, summary: 'avtal', analysis_json: { mentioned_agreements: [] } });
    db.recordContract({ attachment_id: a2, vendor_id: null, is_contract: 0, summary: 'brev', analysis_json: { mentioned_agreements: [{ vendor: 'Quiculum', product: null, doc_attached: false }] } });

    const rows = db.listContractInfoForMessage(msgId);
    expect(rows).toHaveLength(2);
    const contract = rows.find((r) => r.is_contract === 1);
    expect(contract.vendor_name).toBe('Skolon');
    const letter = rows.find((r) => r.is_contract === 0);
    expect(JSON.parse(letter.analysis_json).mentioned_agreements[0].vendor).toBe('Quiculum');
  });
});

describe('escalations watchlist_vendors', () => {
  it('persists and returns watchlist_vendors', () => {
    const db = openDb(':memory:'); db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'r', draft_template: 'free_form', draft_body: '(ingen draft)', watchlist_vendors: JSON.stringify(['Binogi', 'Nationalencyklopedin']) });
    const esc = db.listOpenEscalations().find((e) => e.id === id);
    expect(JSON.parse(esc.watchlist_vendors)).toEqual(['Binogi', 'Nationalencyklopedin']);
  });

  it('defaults watchlist_vendors to null when omitted', () => {
    const db = openDb(':memory:'); db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'r', draft_template: 'T_RECEIPT', draft_body: 'x' });
    const esc = db.listOpenEscalations().find((e) => e.id === id);
    expect(esc.watchlist_vendors).toBeNull();
  });

  it('adds watchlist_vendors to a pre-existing escalations table (migration)', () => {
    const db = openDb(':memory:');
    // Simulate an old DB: escalations without the new column.
    db.raw.exec('DROP TABLE IF EXISTS escalations');
    db.raw.exec(`CREATE TABLE escalations (
      id INTEGER PRIMARY KEY, conversation_id INTEGER, message_id INTEGER, reason TEXT NOT NULL,
      draft_template TEXT, draft_subject TEXT, draft_body TEXT, slack_ts TEXT,
      status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, resolved_text TEXT,
      classifier_class TEXT, classifier_confidence REAL, previous_state TEXT, created_at TEXT
    )`);
    db.migrate();
    const cols = db.raw.prepare('PRAGMA table_info(escalations)').all().map((r) => r.name);
    expect(cols).toContain('watchlist_vendors');
  });
});

describe('escalations respond_by (2026-09-12 design)', () => {
  it('recordEscalation persists respond_by and migrate() adds the column to old DBs', () => {
    const convId = db.createConversation({ kommun_kod: '0580', kommun_namn: 'Linköping', role: 'central', contact_email: 'k@linkoping.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'fee_demand', respond_by: '2026-09-02' });
    expect(db.raw.prepare('SELECT respond_by FROM escalations WHERE id = ?').get(id).respond_by).toBe('2026-09-02');
  });

  it('defaults respond_by to null when omitted', () => {
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'r', draft_template: 'free_form', draft_body: '(ingen draft)' });
    expect(db.raw.prepare('SELECT respond_by FROM escalations WHERE id = ?').get(id).respond_by).toBeNull();
  });

  it('adds respond_by to a pre-existing escalations table (migration)', () => {
    const migDb = openDb(':memory:');
    // Simulate an old DB: escalations without the new column.
    migDb.raw.exec('DROP TABLE IF EXISTS escalations');
    migDb.raw.exec(`CREATE TABLE escalations (
      id INTEGER PRIMARY KEY, conversation_id INTEGER, message_id INTEGER, reason TEXT NOT NULL,
      draft_template TEXT, draft_subject TEXT, draft_body TEXT, slack_ts TEXT,
      status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, resolved_text TEXT,
      classifier_class TEXT, classifier_confidence REAL, previous_state TEXT, created_at TEXT
    )`);
    migDb.migrate();
    const cols = migDb.raw.prepare('PRAGMA table_info(escalations)').all().map((r) => r.name);
    expect(cols).toContain('respond_by');
    migDb.close();
  });
});

describe('auto-send decision queries (2026-08-20 delay-ack design)', () => {
  function seed() {
    const convId = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-07-01T00:00:00Z',
    });
    const msgId = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-1', direction: 'inbound',
      from_email: 'upphandling@ale.se', to_email: 'me@x.se',
      subject: 'SV: Begäran', body_text: 'Hej, vi återkommer så snart vi kan. Mvh',
      classification: 'delay_promise', classification_confidence: 0.9,
      received_at: '2026-08-20T06:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-1',
    });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: msgId, reason: 'delay ack until=2026-08-25',
      draft_template: 'T_DELAY_ACK', draft_subject: 'Re: Begäran', draft_body: 'Hej,\n\nTack…',
      classifier_class: 'delay_promise', classifier_confidence: 0.9, previous_state: 'ACK_RECEIVED',
    });
    return { convId, msgId, escId };
  }

  it('countAutoSendDecisions counts only auto_send rows for that conversation+template', () => {
    const { convId, escId } = seed();
    const base = { escalation_id: escId, conversation_id: convId, conversation_state: 'ACK_RECEIVED', draft_body: 'x' };
    db.recordDecision({ ...base, draft_template: 'T_DELAY_ACK', decision: 'auto_send' });
    db.recordDecision({ ...base, draft_template: 'T_DELAY_ACK', decision: 'edit' });          // operator: not counted
    db.recordDecision({ ...base, draft_template: 'T_FOLLOWUP_NUDGE', decision: 'auto_send' }); // other template: not counted
    expect(db.countAutoSendDecisions(convId, 'T_DELAY_ACK')).toBe(1);
    expect(db.countAutoSendDecisions(convId + 999, 'T_DELAY_ACK')).toBe(0);
  });

  // The answered-clarification rule (2026-08-20) asks "did a HUMAN actually
  // SEND here?". Only the decisions ledger can answer it — outbound message
  // rows look the same whoever sent them. Two exclusions matter: 'auto_send' is
  // the machine, and 'skip'/'closed' are operator decisions that send NOTHING
  // (resolving a draft unsent must never count as answering a kommun).
  it('listOperatorDecisionTimes returns operator SEND times only — not auto_send, not skip/closed', () => {
    const { convId, escId } = seed();
    const base = { escalation_id: escId, conversation_id: convId, conversation_state: 'ACK_RECEIVED', draft_body: 'x' };
    db.recordDecision({ ...base, draft_template: 'T_DELAY_ACK', decision: 'auto_send' });
    db.recordDecision({ ...base, draft_template: 'T_PRECISION', decision: 'edit' });
    db.recordDecision({ ...base, draft_template: 'T_RECEIPT', decision: 'approve_unmodified' });
    db.recordDecision({ ...base, draft_template: 'T_PRECISION', decision: 'skip' });     // resolved unsent
    db.recordDecision({ ...base, draft_template: 'T_PRECISION', decision: 'closed' });   // resolved unsent
    const at = (decision, t) => db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE decision = ?').run(t, decision);
    at('edit', '2026-07-11 10:00:00');
    at('approve_unmodified', '2026-07-12 10:00:00');
    at('auto_send', '2026-07-13 10:00:00');
    at('skip', '2026-07-14 10:00:00');
    at('closed', '2026-07-15 10:00:00');

    expect(db.listOperatorDecisionTimes(convId)).toEqual(['2026-07-11 10:00:00', '2026-07-12 10:00:00']);
    expect(db.listOperatorDecisionTimes(convId + 999)).toEqual([]);
  });

  it('listAutoSendDecisions carries the trigger sender + snippet, NULL for proactive drafts', () => {
    const { convId, escId } = seed();
    db.recordDecision({
      escalation_id: escId, conversation_id: convId, conversation_state: 'ACK_RECEIVED',
      draft_template: 'T_DELAY_ACK', draft_body: 'x', decision: 'auto_send',
    });
    const nudgeEsc = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'stale SENT',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_body: 'y', classifier_class: 'followup_stale',
    });
    db.recordDecision({
      escalation_id: nudgeEsc, conversation_id: convId, conversation_state: 'SENT',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_body: 'y', decision: 'auto_send',
    });
    const rows = db.listAutoSendDecisions(10);
    const ack = rows.find((r) => r.draft_template === 'T_DELAY_ACK');
    const nudge = rows.find((r) => r.draft_template === 'T_FOLLOWUP_NUDGE');
    expect(ack.trigger_from).toBe('upphandling@ale.se');
    expect(ack.trigger_snippet).toContain('vi återkommer');
    expect(ack.trigger_snippet.length).toBeLessThanOrEqual(160);
    expect(nudge.trigger_from).toBeNull();
    expect(nudge.trigger_snippet).toBeNull();
  });
});

describe('draft-context storage helpers (2026-09-12 design)', () => {
  it('listAttachmentsForConversation returns filename per message, in attachment order', () => {
    const convId = db.createConversation({
      kommun_kod: '1280', kommun_namn: 'Malmö', role: 'central',
      contact_email: 'malmostad@malmo.se', scheduled_send_at: '2026-08-01T08:00:00Z',
    });
    const m1 = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'dc-m1', direction: 'inbound',
      from_email: 'k@malmo.se', to_email: 'us', subject: 's', body_text: 'b',
      received_at: '2026-08-19T14:15:00Z', attachment_count: 2,
    });
    db.recordAttachment({ message_id: m1, filename: 'NE Avtal.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    db.recordAttachment({ message_id: m1, filename: 'Dugga.pdf', saved_path: '/x/2.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const rows = db.listAttachmentsForConversation(convId);
    expect(rows).toEqual([
      { message_id: m1, filename: 'NE Avtal.pdf' },
      { message_id: m1, filename: 'Dugga.pdf' },
    ]);
  });

  it('listContractInfoForConversation includes document_type', () => {
    const convId = db.createConversation({
      kommun_kod: '1281', kommun_namn: 'Lund', role: 'central',
      contact_email: 'k@lund.se', scheduled_send_at: '2026-08-01T08:00:00Z',
    });
    const m = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'dc-m2', direction: 'inbound',
      from_email: 'k@lund.se', to_email: 'us', subject: 's', body_text: 'b',
      received_at: '2026-08-19T14:15:00Z', attachment_count: 1,
    });
    const att = db.recordAttachment({ message_id: m, filename: 'oversikt.pdf', saved_path: '/x/3.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    db.recordContract({ attachment_id: att, vendor_id: null, is_contract: 0, document_type: 'följebrev_sammanställning', summary: 'En översikt.' });
    const rows = db.listContractInfoForConversation(convId);
    expect(rows).toHaveLength(1);
    expect(rows[0].document_type).toBe('följebrev_sammanställning');
    expect(rows[0].is_contract).toBe(0);
  });
});

describe('queue hygiene queries (2026-09-12 design)', () => {
  it('aged, deadline-due, and orphan queries each find their case', () => {
    const convA = db.createConversation({ kommun_kod: '0001', kommun_namn: 'Gammal', role: 'central', contact_email: 'a@a.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const escA = db.recordEscalation({ conversation_id: convA, reason: 'r' });
    db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(escA);
    const convB = db.createConversation({ kommun_kod: '0002', kommun_namn: 'Frist', role: 'central', contact_email: 'b@b.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: convB, reason: 'r', respond_by: '2026-09-13' });
    const convC = db.createConversation({ kommun_kod: '0003', kommun_namn: 'Föräldralös', role: 'central', contact_email: 'c@c.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.updateConversationState(convC, 'NEEDS_HUMAN');

    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).toContain('Gammal');
    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).not.toContain('Frist');
    expect(db.listConversationsWithDeadlineDue('2026-09-14').map((r) => r.kommun_namn)).toEqual(['Frist']);
    const orphans = db.listOrphanNeedsHuman().map((c) => c.kommun_namn);
    expect(orphans).toContain('Föräldralös');
    expect(orphans).not.toContain('Gammal'); // has an open escalation
  });

  // Round-3 G2 (Codex R2 #2): listOrphanNeedsHuman excludes any conversation
  // whose kommun has a pending handoff task, which is right for the "utan
  // utkast" list but wrong for the deadline section — a pending referral does
  // not discharge a reply deadline. The two lists now come from one query so
  // they cannot drift.
  it('a handoff-bearing case keeps its deadline in the due list and drops out of listOrphanNeedsHuman', () => {
    const cid = db.createConversation({ kommun_kod: '0042', kommun_namn: 'Hänvisad', role: 'central', contact_email: 'h@h.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const mid = db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-h', direction: 'inbound',
      from_email: 'h@h.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    db.upsertHandoffTask({ kommun_kod: '0042', source_conversation_id: cid, source_message_id: mid, address: 'annan@h.se', forvaltning: null, same_domain: 1 });

    const due = db.listConversationsWithDeadlineDue('2026-09-14');
    expect(due.map((r) => r.kommun_namn)).toContain('Hänvisad');
    expect(due.find((r) => r.conversation_id === cid).respond_by).toBe('2026-09-13');
    expect(db.listOrphanNeedsHuman().map((c) => c.kommun_namn)).not.toContain('Hänvisad');
  });

  // Round-7 L5: the same reasoning as has_open_escalation above, applied to the
  // OTHER half. listOrphanNeedsHuman excluded only status='open', so a
  // conversation whose only escalation is in flight ('sending') or PARKED
  // ('send_failed' / 'send_unconfirmed' — a mail that may already have gone out)
  // was reported to Slack as "Behöver dig utan utkast". That is exactly
  // backwards: a parked send is the most urgent artefact in the system, and
  // telling the operator there is nothing to approve hides it.
  it.each(ACTIVE_ESCALATION_STATUSES)('listOrphanNeedsHuman excludes a case whose escalation is %s', (status) => {
    const cid = db.createConversation({ kommun_kod: `07${status.length}`, kommun_namn: `Parkerad-${status}`, role: 'central', contact_email: 'p@p.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const esc = db.recordEscalation({ conversation_id: cid, reason: 'r' });
    db.raw.prepare('UPDATE escalations SET status = ? WHERE id = ?').run(status, esc);
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    expect(db.listOrphanNeedsHuman().map((c) => c.kommun_namn)).not.toContain(`Parkerad-${status}`);
  });

  it.each(['resolved_send', 'resolved_edit', 'resolved_skip', 'resolved_closed', 'superseded'])(
    'listOrphanNeedsHuman still reports a case whose only escalation is terminal (%s)', (status) => {
      const cid = db.createConversation({ kommun_kod: `08${status.length}`, kommun_namn: `Klarad-${status}`, role: 'central', contact_email: 'q@q.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
      const esc = db.recordEscalation({ conversation_id: cid, reason: 'r' });
      db.raw.prepare('UPDATE escalations SET status = ? WHERE id = ?').run(status, esc);
      db.updateConversationState(cid, 'NEEDS_HUMAN');
      expect(db.listOrphanNeedsHuman().map((c) => c.kommun_namn)).toContain(`Klarad-${status}`);
    });

  // Round-4 H5: buildActionQueue skips DONE/DEAD_END, the digest queries did
  // not. A lingering open escalation on a closed case nagged daily with nothing
  // to click.
  it('a closed conversation with a lingering open escalation is in neither digest list', () => {
    for (const [kod, namn, state] of [['0101', 'KlarDone', 'DONE'], ['0102', 'KlarDead', 'DEAD_END']]) {
      const cid = db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: `${kod}@k.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      const esc = db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: '2026-09-13' });
      db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(esc);
      db.updateConversationState(cid, state);
    }
    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).not.toContain('KlarDone');
    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).not.toContain('KlarDead');
    expect(db.listConversationsWithDeadlineDue('2026-09-14').map((r) => r.kommun_namn)).not.toContain('KlarDone');
    expect(db.listConversationsWithDeadlineDue('2026-09-14').map((r) => r.kommun_namn)).not.toContain('KlarDead');
  });

  // Round-4 H3: one effective-deadline source for the dashboard and the digest.
  // An UNDATED open escalation (every row written before this branch) over a
  // conversation whose inbound carries an outstanding frist showed the date on
  // the dashboard and never in Slack, because the due query required
  // e.respond_by IS NOT NULL.
  it('the due list finds an undated open escalation via the conversation frist', () => {
    const cid = db.createConversation({ kommun_kod: '0103', kommun_namn: 'Odaterad', role: 'central', contact_email: 'o@o.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-o', direction: 'inbound',
      from_email: 'o@o.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.recordEscalation({ conversation_id: cid, reason: 'r' }); // no respond_by
    const hit = db.listConversationsWithDeadlineDue('2026-09-14').find((r) => r.conversation_id === cid);
    expect(hit).toBeTruthy();
    expect(hit.respond_by).toBe('2026-09-13'); // the effective deadline, not the row's NULL
    expect(hit.has_open_escalation).toBe(true);
  });

  it('effectiveRespondBy prefers the escalation row and falls back to the conversation', () => {
    const cid = db.createConversation({ kommun_kod: '0104', kommun_namn: 'Effektiv', role: 'central', contact_email: 'e@e.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-e', direction: 'inbound',
      from_email: 'e@e.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    expect(db.effectiveRespondBy(cid, '2026-09-20')).toBe('2026-09-20');
    expect(db.effectiveRespondBy(cid, null)).toBe('2026-09-13');
    expect(db.effectiveRespondBy(cid, '')).toBe('2026-09-13');
    expect(db.effectiveRespondBy(cid, 'i morgon')).toBe('2026-09-13'); // junk is not a deadline
  });

  // Round-5 J2: a frist can sit on a conversation that is neither NEEDS_HUMAN
  // nor escalated — an auto_ack/handoff mail stating "komplettera inom 7 dagar
  // annars avslutas ärendet" on a conversation still in SENT. Neither digest
  // source could see it: the open-escalation query needs an escalation, the
  // draftless query needs state NEEDS_HUMAN. One query over every live
  // conversation is the ⏰ section's single source.
  it('listConversationsWithDeadlineDue finds a dated SENT conversation with no escalation at all', () => {
    const cid = db.createConversation({ kommun_kod: '0301', kommun_namn: 'Tyst', role: 'central', contact_email: 't@t.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-t', direction: 'inbound',
      from_email: 't@t.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'ACK_RECEIVED');
    const hit = db.listConversationsWithDeadlineDue('2026-09-14').find((r) => r.conversation_id === cid);
    expect(hit).toBeTruthy();
    expect(hit.respond_by).toBe('2026-09-13');
    expect(hit.kommun_namn).toBe('Tyst');
    expect(hit.role).toBe('central');
    expect(hit.has_open_escalation).toBe(false);
  });

  it('listConversationsWithDeadlineDue marks an escalated case, dedupes to one row, and skips closed cases', () => {
    const withDraft = db.createConversation({ kommun_kod: '0302', kommun_namn: 'MedUtkast', role: 'central', contact_email: 'm@m.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: withDraft, reason: 'r', respond_by: '2026-09-13' });
    const closed = db.createConversation({ kommun_kod: '0303', kommun_namn: 'Stängd', role: 'central', contact_email: 's@s.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: closed, reason: 'r', respond_by: '2026-09-13' });
    db.updateConversationState(closed, 'DONE');

    const rows = db.listConversationsWithDeadlineDue('2026-09-14');
    expect(rows.filter((r) => r.conversation_id === withDraft)).toHaveLength(1);
    expect(rows.find((r) => r.conversation_id === withDraft).has_open_escalation).toBe(true);
    expect(rows.map((r) => r.kommun_namn)).not.toContain('Stängd');
  });

  // Round-6 K6: "utan utkast" means there is nothing to approve. A parked send
  // (send_failed / send_unconfirmed — a mail that MAY have gone out) and an
  // in-flight one (sending) are the most urgent artefacts in the system, so
  // labelling their case draftless is exactly backwards. has_open_escalation
  // reads ACTIVE_ESCALATION_STATUSES, the same list every draft guard uses.
  it.each(ACTIVE_ESCALATION_STATUSES)('has_open_escalation is true for a %s escalation', (status) => {
    const cid = db.createConversation({ kommun_kod: `04${status.length}`, kommun_namn: `Aktiv-${status}`, role: 'central', contact_email: 'a@a.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const esc = db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: '2026-09-13' });
    db.raw.prepare('UPDATE escalations SET status = ? WHERE id = ?').run(status, esc);
    const hit = db.listConversationsWithDeadlineDue('2026-09-14').find((r) => r.conversation_id === cid);
    expect(hit).toBeTruthy();
    expect(hit.has_open_escalation).toBe(true);
  });

  it.each(['resolved_send', 'resolved_edit', 'resolved_skip', 'resolved_closed', 'superseded'])(
    'has_open_escalation is false for a terminal %s escalation', (status) => {
      const cid = db.createConversation({ kommun_kod: `05${status.length}`, kommun_namn: `Klar-${status}`, role: 'central', contact_email: 'b@b.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
      const esc = db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: '2026-09-13' });
      db.raw.prepare('UPDATE escalations SET status = ? WHERE id = ?').run(status, esc);
      const hit = db.listConversationsWithDeadlineDue('2026-09-14').find((r) => r.conversation_id === cid);
      // The deadline is still surfaced (the escalation fallback reads any
      // status), it is just labelled as having nothing to approve.
      expect(hit).toBeTruthy();
      expect(hit.has_open_escalation).toBe(false);
    });

  // Round-6 K6: the row used to carry `escalation_id` with a comment claiming the
  // 🕰 section deduped on it. It never did — the dedupe is by conversation — so
  // the field was dead weight that invited exactly that misreading.
  it('the due row exposes no escalation_id', () => {
    const cid = db.createConversation({ kommun_kod: '0601', kommun_namn: 'Fält', role: 'central', contact_email: 'f@f.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: '2026-09-13' });
    const hit = db.listConversationsWithDeadlineDue('2026-09-14').find((r) => r.conversation_id === cid);
    expect(Object.keys(hit).sort()).toEqual(['conversation_id', 'has_open_escalation', 'kommun_namn', 'respond_by', 'role']);
  });

  it('listConversationsWithDeadlineDue sorts soonest first and excludes dates past the window', () => {
    const mk = (kod, namn, date) => {
      const cid = db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: `${kod}@d.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: date });
      return cid;
    };
    mk('0311', 'Sist', '2026-09-14');
    mk('0312', 'Forst', '2026-09-10');
    mk('0313', 'Senare', '2026-09-20');
    const names = db.listConversationsWithDeadlineDue('2026-09-14').map((r) => r.kommun_namn);
    expect(names).toEqual(['Forst', 'Sist']);
  });

  it('the due list is sorted soonest first regardless of where each date came from', () => {
    const mk = (kod, namn, escDate, msgDate) => {
      const cid = db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: `${kod}@s.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      if (msgDate) {
        db.recordMessage({
          conversation_id: cid, gmail_message_id: `g-${kod}`, direction: 'inbound',
          from_email: 's@s.se', to_email: 'x', subject: 's', body_text: 'b',
          received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
          analysis_json: JSON.stringify({ extracted: { respond_by_date: msgDate } }),
        });
      }
      db.recordEscalation({ conversation_id: cid, reason: 'r', respond_by: escDate });
      return cid;
    };
    mk('0201', 'Sen', '2026-09-14', null);
    mk('0202', 'Tidig', null, '2026-09-10');
    expect(db.listConversationsWithDeadlineDue('2026-09-14').map((r) => r.kommun_namn))
      .toEqual(['Tidig', 'Sen']);
  });
});

// Round-2 finding F2: the void path (kommun replied after a draft was written)
// supersedes the open escalation and creates none, so every deadline reader
// keyed on an OPEN escalation loses the frist. This helper surfaces it again,
// read-only, independent of the escalation lifecycle.
describe('latestRespondByForConversation (round-2 finding F2)', () => {
  function seed() {
    return db.createConversation({
      kommun_kod: '7777', kommun_namn: 'Frist', role: 'central',
      contact_email: 'k@frist.se', scheduled_send_at: '2026-09-01T08:00:00Z',
    });
  }
  // ISO-with-Z → the SQLite datetime('now') shape the ledger and ingested_at use.
  const sqliteTs = (iso) => iso.replace('T', ' ').replace('Z', '');

  // `ingested_at` is THE discharge clock (round-6 K1). recordMessage stamps the
  // real wall clock, which says nothing in a fixture seeded with 2026-09 dates,
  // so every seeded inbound gets an explicit value. The default is "ingested
  // when it was delivered" (the normal case); the crossing-mail tests below set
  // the two apart on purpose.
  function inbound(convId, { at, respondBy, json, ingestedAt }) {
    const id = db.recordMessage({
      conversation_id: convId, gmail_message_id: `g-${at}`, direction: 'inbound',
      from_email: 'k@frist.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: at, attachment_count: 0,
      analysis_json: json !== undefined ? json : JSON.stringify({ extracted: { respond_by_date: respondBy ?? null } }),
    });
    db.raw.prepare('UPDATE messages SET ingested_at = ? WHERE id = ?')
      .run(ingestedAt ?? sqliteTs(at), id);
    return id;
  }

  it('prefers the newest inbound analysis over an older escalation', () => {
    const id = seed();
    db.recordEscalation({ conversation_id: id, reason: 'r', respond_by: '2026-09-20' });
    inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-10' });
    inbound(id, { at: '2026-09-08T08:00:00Z', respondBy: '2026-09-15' });
    expect(db.latestRespondByForConversation(id)).toBe('2026-09-15');
  });

  it('falls back to the most recent escalation respond_by, whatever its status', () => {
    const id = seed();
    const esc = db.recordEscalation({ conversation_id: id, reason: 'r', respond_by: '2026-09-18' });
    db.resolveEscalation(esc, { status: 'superseded', resolved_text: 'voided' });
    inbound(id, { at: '2026-09-08T08:00:00Z', respondBy: null });
    expect(db.latestRespondByForConversation(id)).toBe('2026-09-18');
  });

  it('returns null when neither side carries a deadline, and survives unparsable analysis_json', () => {
    const id = seed();
    inbound(id, { at: '2026-09-08T08:00:00Z', json: 'not json at all' });
    db.recordEscalation({ conversation_id: id, reason: 'r' });
    expect(db.latestRespondByForConversation(id)).toBeNull();
  });

  // Round-4 H7: the value comes out of LLM-written analysis_json, so a
  // non-ISO string must not reach a ⏰ label or a sort key. Junk is treated as
  // absent and the helper falls through to the next candidate.
  it('ignores a non-ISO respond_by_date and falls through to an older valid one', () => {
    const id = seed();
    inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-10' });
    inbound(id, { at: '2026-09-08T08:00:00Z', respondBy: 'snarast möjligt' });
    expect(db.latestRespondByForConversation(id)).toBe('2026-09-10');
  });

  it('returns null when the only candidate is junk', () => {
    const id = seed();
    inbound(id, { at: '2026-09-08T08:00:00Z', respondBy: '13/9' });
    expect(db.latestRespondByForConversation(id)).toBeNull();
  });

  // Round-4 H7: an undated newest inbound must not hide an older outstanding
  // frist — the `find` walks newest-first past undated rows.
  it('newest inbound undated, older inbound dated (both after the boundary) → the older date is returned', () => {
    const id = seed();
    inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-10' });
    inbound(id, { at: '2026-09-08T08:00:00Z', respondBy: null });
    expect(db.latestRespondByForConversation(id)).toBe('2026-09-10');
  });

  // Round-4 H1 (critical): the discharge boundary is an OPERATOR send, read
  // from the decisions ledger — never conversations.last_outbound_at, which
  // every machine send stamps too. An auto-sent ack is not an answer.
  describe('discharge boundary is the latest OPERATOR send (round-4 H1)', () => {
    function decide(convId, decision, decidedAt) {
      const escId = db.recordEscalation({ conversation_id: convId, reason: 'r' });
      const did = db.recordDecision({
        escalation_id: escId, conversation_id: convId, conversation_state: 'NEEDS_HUMAN',
        draft_body: 'b', decision,
      });
      db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decidedAt, did);
      // The carrier escalation is deliberately undated, so it never enters the
      // escalation fallback below and the test asserts the ledger alone.
      return did;
    }

    it('an auto_send after the deadline does NOT discharge it', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      db.raw.prepare('UPDATE conversations SET last_outbound_at = ? WHERE id = ?').run('2026-09-06T09:00:00Z', id);
      decide(id, 'auto_send', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-14');
    });

    it('an approve_unmodified after the deadline discharges it', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      decide(id, 'approve_unmodified', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    it('an edit after the deadline discharges it', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      decide(id, 'edit', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    it('a skip after the deadline does NOT discharge it (nothing was sent)', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      decide(id, 'skip', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-14');
    });

    it('an operator send BEFORE the deadline mail leaves it outstanding', () => {
      const id = seed();
      decide(id, 'edit', '2026-09-04 09:00:00');
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-14');
    });

    it('the LATEST operator send is the boundary, not the first', () => {
      const id = seed();
      decide(id, 'edit', '2026-09-04 09:00:00');
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-14' });
      decide(id, 'approve_unmodified', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    it('no operator send at all discharges nothing, whatever last_outbound_at says', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-10' });
      db.raw.prepare('UPDATE conversations SET last_outbound_at = ? WHERE id = ?').run('2026-09-09T09:00:00Z', id);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-10');
    });

    it('ignores an undated escalation row created before the operator send, keeps one created after', () => {
      const id = seed();
      const spent = db.recordEscalation({ conversation_id: id, reason: 'r', respond_by: '2026-09-10' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-05 08:00:00', spent);
      decide(id, 'edit', '2026-09-06 09:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
      const live = db.recordEscalation({ conversation_id: id, reason: 'r', respond_by: '2026-09-18' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-07 08:00:00', live);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-18');
    });

    // Round-7 L2 (critical): both clocks are SECOND-resolution, so "same second"
    // carries no ordering at all. A strict `>` read a tie as "ingested before the
    // send" and discharged a mail the operator may never have seen — with L1 the
    // decision stamp is the moment the send STARTED, so a same-second ingest is
    // genuinely ambiguous and the conservative reading is "not seen". Ties are
    // OUTSTANDING, in the ledger path and in the escalation fallback alike.
    it('an inbound ingested in the SAME second as the operator send stays outstanding (ties fail open)', () => {
      const id = seed();
      decide(id, 'edit', '2026-09-06 10:00:00');
      inbound(id, { at: '2026-09-06T09:59:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-06 10:00:00' });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    it('an escalation whose trigger mail was ingested in the same second as the send keeps its deadline', () => {
      const id = seed();
      decide(id, 'edit', '2026-09-06 10:00:00');
      const tie = inbound(id, { at: '2026-09-06T09:59:00Z', respondBy: null, ingestedAt: '2026-09-06 10:00:00' });
      const esc = db.recordEscalation({ conversation_id: id, message_id: tie, reason: 'r', respond_by: '2026-09-21' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-06 10:00:00', esc);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-21');
    });

    // The same tie on an escalation that names NO trigger mail: the boundary is
    // the row's own created_at, and it must fail open the same way.
    it('an undated-trigger escalation created in the same second as the send keeps its deadline', () => {
      const id = seed();
      decide(id, 'edit', '2026-09-06 10:00:00');
      const esc = db.recordEscalation({ conversation_id: id, reason: 'r', respond_by: '2026-09-22' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-06 10:00:00', esc);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-22');
    });

    // Round-7 L6: these four assert the OUTCOME at explicit, adjacent stamps —
    // both clocks set by hand, one second apart — rather than trusting a fixture
    // date to sort the right way. A boundary off by a second, or one that reads
    // the wrong conversation's ledger, shows up here and nowhere else.
    describe('the boundary at one-second resolution (round-7 L6)', () => {
      const SEND_AT = '2026-09-06 10:00:00';

      it('ingested one second AFTER the send is outstanding', () => {
        const id = seed();
        decide(id, 'edit', SEND_AT);
        inbound(id, { at: '2026-09-06T09:00:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-06 10:00:01' });
        expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
      });

      it('ingested in the SAME second as the send is outstanding (ties fail open, L2)', () => {
        const id = seed();
        decide(id, 'edit', SEND_AT);
        inbound(id, { at: '2026-09-06T09:00:00Z', respondBy: '2026-09-20', ingestedAt: SEND_AT });
        expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
      });

      it('ingested one second BEFORE the send is discharged', () => {
        const id = seed();
        decide(id, 'edit', SEND_AT);
        inbound(id, { at: '2026-09-06T09:00:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-06 09:59:59' });
        expect(db.latestRespondByForConversation(id)).toBeNull();
      });

      // The ledger is read PER CONVERSATION. An operator send in some other
      // kommun's case discharges nothing here, however much later it is.
      it('an operator send on a DIFFERENT conversation discharges nothing', () => {
        const id = seed();
        const other = db.createConversation({
          kommun_kod: '7778', kommun_namn: 'Annan', role: 'central',
          contact_email: 'k@annan.se', scheduled_send_at: '2026-09-01T08:00:00Z',
        });
        decide(other, 'edit', '2026-09-09 10:00:00');
        inbound(id, { at: '2026-09-06T09:00:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-06 09:00:00' });
        expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
      });
    });

    // Round-4 H2: an escalation created AFTER the operator reply can still
    // carry a deadline copied from an inbound the reply already answered
    // (delayed ingest, or a superseded copy). The escalation's own
    // created_at is not evidence; its originating inbound's receipt is.
    it('an escalation whose originating inbound predates the operator send does not resurrect the deadline', () => {
      const id = seed();
      const mid = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-10' });
      decide(id, 'edit', '2026-09-06 09:00:00');
      const copy = db.recordEscalation({ conversation_id: id, message_id: mid, reason: 'r', respond_by: '2026-09-10' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-07 08:00:00', copy);
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });
  });
  // Round-6 K1 (critical): ONE clock, not two. Delivery time (received_at,
  // Gmail internalDate) is the KOMMUN's clock; the operator answers what INGEST
  // has put in front of them, so `messages.ingested_at` — the moment WE recorded
  // the mail, stamped by the same datetime('now') the decisions ledger uses — is
  // the only boundary that can decide whether an operator send answered a mail.
  //
  // The two-clock OR this replaces keyed its arrival-order half on
  // MAX(escalations.message_id) over answered escalations, and that boundary was
  // wrong twice over: five of the six escalateWithDraft call sites pass no
  // messageId at all (T-INITIAL failure, recoverStuckSends, the bounce resend,
  // the daily staleness follow-up, T_UPDATE), so MAX() was NULL and the
  // delivery-time rule ran alone; and when it WAS set, MAX() over ALL answered
  // escalations pinned the boundary at an old id for ever, so a frist answered
  // through a later follow-up draft never discharged and the kommun was nagged
  // daily. Advisory surfacing only: no guard, FSM transition or auto-send rule
  // reads respond_by.
  describe('discharge is ingest order, one clock (round-6 K1)', () => {
    // An operator SEND. `messageId` defaults to NULL, which is what a proactive
    // draft looks like — the daily follow-up, T-INITIAL failure,
    // recoverStuckSends, the bounce resend and T_UPDATE all write one, and the
    // old arrival-order half was blind to every single case.
    function operatorSend(convId, decidedAt, { messageId = null, decision = 'edit' } = {}) {
      const escId = db.recordEscalation({ conversation_id: convId, message_id: messageId, reason: 'r' });
      const did = db.recordDecision({
        escalation_id: escId, conversation_id: convId, conversation_state: 'NEEDS_HUMAN',
        draft_body: 'b', decision,
      });
      db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decidedAt, did);
      return escId;
    }

    // (a) The original J1 bug, now via the clock that actually exists: the
    // answer rode a proactive draft, so there is no answered message id at all.
    it('an inbound ingested after a proactive-draft send stays outstanding', () => {
      const id = seed();
      operatorSend(id, '2026-09-06 10:00:00');
      inbound(id, { at: '2026-09-07T08:00:00Z', respondBy: '2026-09-20' });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    // (b) The mirror image: ingested before the same send, so the operator could
    // see it and their reply answered it.
    it('an inbound ingested before that same send is discharged', () => {
      const id = seed();
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-05 08:01:00' });
      operatorSend(id, '2026-09-06 10:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    // (c) The crossing mail: delivered 09:50, ingested 10:05, an operator send
    // at 10:00 in between. Delivery time says answered, ingest order says it was
    // never on screen. Ingest order is right.
    it('a crossing mail delivered before the send but ingested after it stays outstanding', () => {
      const id = seed();
      operatorSend(id, '2026-09-06 10:00:00');
      inbound(id, { at: '2026-09-06T09:50:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-06 10:05:00' });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    // (d) The over-nag the id boundary caused (adversarial cases C/C2): the
    // first frist was answered through an escalation that NAMED its trigger
    // mail, the second through a proactive follow-up draft that named none.
    // MAX(message_id) therefore stayed pinned at the FIRST mail and the second,
    // higher id looked outstanding for ever. One clock cannot get stuck.
    it('a frist answered through a later follow-up draft discharges anyway', () => {
      const id = seed();
      const first = inbound(id, { at: '2026-09-04T08:00:00Z', respondBy: '2026-09-14' });
      operatorSend(id, '2026-09-05 10:00:00', { messageId: first });
      inbound(id, { at: '2026-09-06T08:00:00Z', respondBy: '2026-09-20' });
      operatorSend(id, '2026-09-07 10:00:00'); // proactive follow-up draft: no message_id
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    it('with no operator send at all every inbound is outstanding', () => {
      const id = seed();
      inbound(id, { at: '2026-09-04T08:00:00Z', respondBy: '2026-09-20' });
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    // The escalation fallback reads the SAME clock: its trigger mail's
    // ingested_at when it names one, its own created_at when it does not.
    it('an escalation whose trigger mail was ingested after the send keeps its deadline', () => {
      const id = seed();
      operatorSend(id, '2026-09-06 10:00:00');
      const later = inbound(id, { at: '2026-09-06T09:50:00Z', respondBy: null, ingestedAt: '2026-09-06 10:05:00' });
      const esc = db.recordEscalation({ conversation_id: id, message_id: later, reason: 'r', respond_by: '2026-09-21' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-06 10:06:00', esc);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-21');
    });

    it('an escalation whose trigger mail was ingested before the send is discharged', () => {
      const id = seed();
      const seen = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null, ingestedAt: '2026-09-05 08:01:00' });
      operatorSend(id, '2026-09-06 10:00:00');
      const esc = db.recordEscalation({ conversation_id: id, message_id: seen, reason: 'r', respond_by: '2026-09-21' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-06 10:06:00', esc);
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    // Fail open: an unreadable or missing ingest stamp is CONSIDERED, never
    // dropped. Showing one date too many is recoverable; hiding a live frist is
    // the failure this helper exists to prevent.
    it('a NULL ingested_at is considered outstanding, not discharged', () => {
      const id = seed();
      const mid = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: '2026-09-20', ingestedAt: '2026-09-05 08:01:00' });
      operatorSend(id, '2026-09-06 10:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
      db.raw.prepare('UPDATE messages SET ingested_at = NULL WHERE id = ?').run(mid);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });
  });
});

// Round-6 K1: the new column is append-only, probed with PRAGMA table_info like
// every other one, and legacy rows are backfilled from received_at (ISO with
// T/Z, stripped to the SQLite 'YYYY-MM-DD HH:MM:SS' shape). The backfill is an
// APPROXIMATION for pre-migration rows: it says "ingested when delivered", which
// is what the old delivery-time rule already assumed, so no case gets worse.
describe('messages.ingested_at migration (round-6 K1)', () => {
  it('adds the column, backfills a legacy row from received_at, and is idempotent', () => {
    const migDb = openDb(':memory:');
    // Simulate a pre-column DB: messages built by hand, without ingested_at.
    migDb.raw.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      gmail_message_id TEXT NOT NULL UNIQUE,
      direction TEXT NOT NULL,
      from_email TEXT, to_email TEXT, subject TEXT, body_text TEXT,
      classification TEXT, classification_confidence REAL,
      received_at TEXT NOT NULL,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      signature_extracted TEXT
    )`);
    migDb.raw.prepare(`INSERT INTO messages (conversation_id, gmail_message_id, direction, received_at, attachment_count)
      VALUES (1, 'legacy-1', 'inbound', '2026-08-19T14:15:00Z', 0)`).run();

    migDb.migrate();
    const cols = migDb.raw.prepare('PRAGMA table_info(messages)').all().map((r) => r.name);
    expect(cols).toContain('ingested_at');
    const read = () => migDb.raw.prepare("SELECT ingested_at FROM messages WHERE gmail_message_id = 'legacy-1'").get().ingested_at;
    expect(read()).toBe('2026-08-19 14:15:00');

    expect(() => migDb.migrate()).not.toThrow();
    expect(read()).toBe('2026-08-19 14:15:00');
    migDb.close();
  });

  // Round-7 L3: the ALTER and the backfill must be ONE unit, and the backfill
  // must be self-healing. A process that died between the two statements left a
  // DB where the probe sees the column and the old "runs once, inside the probe"
  // backfill never ran again — every legacy row stuck on NULL for ever, which
  // the discharge helper reads as outstanding and nags the kommun about daily.
  it('backfills NULL ingested_at on a LATER migrate(), not only on the run that added the column', () => {
    const migDb = openDb(':memory:');
    migDb.migrate();
    const cid = migDb.createConversation({ kommun_kod: '0502', kommun_namn: 'Halv', role: 'central', contact_email: 'h@h.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    // The exact post-crash shape: column present, values NULL.
    const insert = migDb.raw.prepare(`INSERT INTO messages (conversation_id, gmail_message_id, direction, received_at, attachment_count, ingested_at)
      VALUES (?, ?, ?, ?, 0, NULL)`);
    insert.run(cid, 'half-migrated-1', 'inbound', '2026-08-19T14:15:00Z');
    insert.run(cid, 'half-migrated-2', 'outbound', '2026-08-20T06:00:00Z');
    const read = (gid) => migDb.raw.prepare('SELECT ingested_at FROM messages WHERE gmail_message_id = ?').get(gid).ingested_at;
    expect(read('half-migrated-1')).toBeNull();

    migDb.migrate();
    expect(read('half-migrated-1')).toBe('2026-08-19 14:15:00');
    expect(read('half-migrated-2')).toBe('2026-08-20 06:00:00');

    // Idempotent, and it never overwrites a stamp that is already there.
    migDb.raw.prepare("UPDATE messages SET ingested_at = '2026-08-19 20:00:00' WHERE gmail_message_id = 'half-migrated-1'").run();
    migDb.migrate();
    expect(read('half-migrated-1')).toBe('2026-08-19 20:00:00');
    migDb.close();
  });

  it('recordMessage stamps ingested_at with the SQLite clock', () => {
    const cid = db.createConversation({ kommun_kod: '0501', kommun_namn: 'Stämpel', role: 'central', contact_email: 's@s.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const mid = db.recordMessage({
      conversation_id: cid, gmail_message_id: 'stamp-1', direction: 'inbound',
      from_email: 's@s.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-08-19T14:15:00Z', attachment_count: 0,
    });
    const row = migRead(mid);
    // Round-7 L6: shape alone is not the claim. The old assertion passed for
    // '2000-01-01 00:00:00' too, which would silently discharge every frist in
    // the database. Assert the VALUE: within 5 s of this process's clock, read
    // as UTC (datetime('now') is UTC, so this holds in any TZ).
    expect(row.ingested_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const stampedMs = Date.parse(`${row.ingested_at.replace(' ', 'T')}Z`);
    expect(Number.isNaN(stampedMs)).toBe(false);
    expect(Math.abs(stampedMs - Date.now())).toBeLessThan(5000);
    // Not the kommun's delivery clock: the two are different by construction.
    expect(row.ingested_at).not.toBe('2026-08-19 14:15:00');
  });

  function migRead(id) {
    return db.raw.prepare('SELECT ingested_at FROM messages WHERE id = ?').get(id);
  }
});
