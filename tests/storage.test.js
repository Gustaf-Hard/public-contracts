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
    expect(db.listOpenEscalationsWithDeadlineDue('2026-09-14').map((e) => e.kommun_namn)).toEqual(['Frist']);
    const orphans = db.listOrphanNeedsHuman().map((c) => c.kommun_namn);
    expect(orphans).toContain('Föräldralös');
    expect(orphans).not.toContain('Gammal'); // has an open escalation
  });

  // Round-3 G2 (Codex R2 #2): listOrphanNeedsHuman excludes any conversation
  // whose kommun has a pending handoff task, which is right for the "utan
  // utkast" list but wrong for the deadline section — a pending referral does
  // not discharge a reply deadline. The two lists now come from one query so
  // they cannot drift.
  it('listNeedsHumanWithoutOpenEscalation keeps a handoff-bearing case that listOrphanNeedsHuman drops', () => {
    const cid = db.createConversation({ kommun_kod: '0042', kommun_namn: 'Hänvisad', role: 'central', contact_email: 'h@h.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const mid = db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-h', direction: 'inbound',
      from_email: 'h@h.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    db.upsertHandoffTask({ kommun_kod: '0042', source_conversation_id: cid, source_message_id: mid, address: 'annan@h.se', forvaltning: null, same_domain: 1 });

    const without = db.listNeedsHumanWithoutOpenEscalation();
    expect(without.map((c) => c.kommun_namn)).toContain('Hänvisad');
    expect(without.find((c) => c.id === cid).respond_by).toBe('2026-09-13');
    expect(db.listOrphanNeedsHuman().map((c) => c.kommun_namn)).not.toContain('Hänvisad');
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
    expect(db.listOpenEscalationsWithDeadlineDue('2026-09-14').map((e) => e.kommun_namn)).not.toContain('KlarDone');
    expect(db.listOpenEscalationsWithDeadlineDue('2026-09-14').map((e) => e.kommun_namn)).not.toContain('KlarDead');
  });

  // Round-4 H3: one effective-deadline source for the dashboard and the digest.
  // An UNDATED open escalation (every row written before this branch) over a
  // conversation whose inbound carries an outstanding frist showed the date on
  // the dashboard and never in Slack, because the due query required
  // e.respond_by IS NOT NULL.
  it('listOpenEscalationsWithDeadlineDue finds an undated open escalation via the conversation frist', () => {
    const cid = db.createConversation({ kommun_kod: '0103', kommun_namn: 'Odaterad', role: 'central', contact_email: 'o@o.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-o', direction: 'inbound',
      from_email: 'o@o.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.recordEscalation({ conversation_id: cid, reason: 'r' }); // no respond_by
    const hit = db.listOpenEscalationsWithDeadlineDue('2026-09-14').find((e) => e.conversation_id === cid);
    expect(hit).toBeTruthy();
    expect(hit.respond_by).toBe('2026-09-13'); // the effective deadline, not the row's NULL
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
    expect(db.listOpenEscalationsWithDeadlineDue('2026-09-14').map((e) => e.kommun_namn))
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
  function inbound(convId, { at, respondBy, json }) {
    return db.recordMessage({
      conversation_id: convId, gmail_message_id: `g-${at}`, direction: 'inbound',
      from_email: 'k@frist.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: at, attachment_count: 0,
      analysis_json: json !== undefined ? json : JSON.stringify({ extracted: { respond_by_date: respondBy ?? null } }),
    });
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
  // Round-5 J1 (critical): delivery time and ingest order are different clocks.
  // A mail DELIVERED before our operator send but INGESTED after it (crossing
  // mails, or an ingest outage while the operator keeps replying) cannot
  // possibly have been answered, yet the time rule alone dropped it. The
  // arrival-order boundary is the highest messages.id any answered escalation
  // pointed at.
  describe('arrival-order boundary (round-5 J1)', () => {
    // An operator decision whose escalation names the inbound it answered.
    function answerMessage(convId, messageId, decidedAt, decision = 'edit') {
      const escId = db.recordEscalation({ conversation_id: convId, message_id: messageId, reason: 'r' });
      const did = db.recordDecision({
        escalation_id: escId, conversation_id: convId, conversation_state: 'NEEDS_HUMAN',
        draft_body: 'b', decision,
      });
      db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decidedAt, did);
      return escId;
    }

    it('an inbound ingested AFTER the answered one stays outstanding even though it was delivered first', () => {
      const id = seed();
      const answered = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null });
      answerMessage(id, answered, '2026-09-06 10:00:00');
      // Delivered 09:50, ingested at 10:05 — a higher row id, an earlier clock.
      inbound(id, { at: '2026-09-06T09:50:00Z', respondBy: '2026-09-20' });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    it('an inbound that arrived BEFORE the answered one and predates the send is discharged', () => {
      const id = seed();
      inbound(id, { at: '2026-09-04T08:00:00Z', respondBy: '2026-09-20' });
      const answered = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null });
      answerMessage(id, answered, '2026-09-06 10:00:00');
      expect(db.latestRespondByForConversation(id)).toBeNull();
    });

    it('with no operator decision at all every inbound is outstanding', () => {
      const id = seed();
      inbound(id, { at: '2026-09-04T08:00:00Z', respondBy: '2026-09-20' });
      inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null });
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-20');
    });

    // The escalation fallback gets the same two-part rule: a row whose
    // originating inbound arrived after the answered one is still live.
    it('an escalation whose originating inbound arrived after the answered one keeps its deadline', () => {
      const id = seed();
      const answered = inbound(id, { at: '2026-09-05T08:00:00Z', respondBy: null });
      answerMessage(id, answered, '2026-09-06 10:00:00');
      const later = inbound(id, { at: '2026-09-06T09:50:00Z', respondBy: null });
      const esc = db.recordEscalation({ conversation_id: id, message_id: later, reason: 'r', respond_by: '2026-09-21' });
      db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-09-06 10:05:00', esc);
      expect(db.latestRespondByForConversation(id)).toBe('2026-09-21');
    });
  });
});
