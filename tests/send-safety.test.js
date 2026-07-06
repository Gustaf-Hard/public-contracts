// Send-path idempotency & crash safety (autopilot review C1, C2, C3, H7).
// The invariant under test: *never double-message a kommun* — not on a double
// click, not on a racing approve, not on a crash between Gmail accepting and
// the DB finalize, not on a failed dashboard initial send.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { sendApprovedReply, sendInitial, parseDbTime } from '../src/send-reply.js';
import { runTick } from '../src/tick.js';

const env = {
  GMAIL_USER_EMAIL: 'me@x.se',
  GMAIL_FROM_NAME: 'Me',
  SLACK_CHANNEL_ID: 'C1',
};

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-safety-'));
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seedConvWithEscalation({ state = 'DELIVERING' } = {}) {
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, state, { gmail_thread_id: 'thr-orig' });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'r',
    draft_template: 'free_form', draft_subject: 'Re: SV', draft_body: 'tack',
    slack_ts: 'slack-ts-1',
  });
  return {
    convId, escId,
    conv: db.getConversation(convId),
    esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId),
  };
}

function fakeSlackClient() {
  return { chat: { update: vi.fn(async () => ({ ok: true })), postMessage: vi.fn(async () => ({ ts: 't', channel: 'C1' })) } };
}

describe('sendApprovedReply — atomic claim (C1/H7)', () => {
  it('two concurrent approves send exactly once; the loser gets ESCALATION_NOT_OPEN', async () => {
    const { conv, esc } = seedConvWithEscalation();
    let release;
    const gate = new Promise((r) => { release = r; });
    const send = vi.fn(async () => { await gate; return { id: `out-${send.mock.calls.length}`, threadId: 'thr-orig' }; });

    const p1 = sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'edit', gmailSendImpl: send });
    const p2 = sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'edit', gmailSendImpl: send });
    release();
    const results = await Promise.allSettled([p1, p2]);

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe('ESCALATION_NOT_OPEN');
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n).toBe(1);
  });

  it('refuses a resolved escalation without calling Gmail', async () => {
    const { conv, esc, escId } = seedConvWithEscalation();
    db.resolveEscalation(escId, { status: 'resolved_send', resolved_text: 'done' });
    const send = vi.fn();
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'x', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'ESCALATION_NOT_OPEN' });
    expect(send).not.toHaveBeenCalled();
  });

  it('strips the Slack buttons via chat.update after a successful send', async () => {
    const { conv, esc } = seedConvWithEscalation();
    const slackClient = fakeSlackClient();
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-orig' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send, slackClient });
    expect(slackClient.chat.update).toHaveBeenCalledTimes(1);
    const call = slackClient.chat.update.mock.calls[0][0];
    expect(call.ts).toBe('slack-ts-1');
    expect(call.channel).toBe('C1');
    expect(JSON.stringify(call.blocks)).not.toContain('esc_approve'); // buttons gone
  });
});

describe('sendApprovedReply — two-phase send (C2)', () => {
  it('a Gmail failure parks the escalation as send_failed — never back to open, no outbound row', async () => {
    const { conv, esc, escId, convId } = seedConvWithEscalation();
    const send = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'edit', gmailSendImpl: send })
    ).rejects.toThrow('socket hang up');
    const after = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    expect(after.status).toBe('send_failed');
    expect(after.resolved_text).toContain('socket hang up');
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n).toBe(0);
    expect(db.getConversation(convId).state).toBe('DELIVERING'); // FSM untouched

    // And a retry does NOT auto-fire: the claim now fails.
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'edit', gmailSendImpl: vi.fn() })
    ).rejects.toMatchObject({ code: 'ESCALATION_NOT_OPEN' });
  });
});

describe('sendApprovedReply — staleness guard', () => {
  it('blocks approve_unmodified when a newer inbound arrived after the draft', async () => {
    const { conv, esc, convId } = seedConvWithEscalation();
    // Inbound newer than the escalation's created_at (which is "now" via datetime('now'))
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-new', direction: 'inbound',
      from_email: 'a@arboga.se', to_email: 'me@x.se', subject: 's', body_text: 'nytt svar',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: future, attachment_count: 0,
    });
    const send = vi.fn();
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'STALE_ESCALATION' });
    expect(send).not.toHaveBeenCalled();
    // Escalation stays OPEN for re-review — it was not consumed.
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('open');

    // An explicit edit passes — the human wrote with current context.
    const send2 = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-orig' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'nytt svar', decision: 'edit', gmailSendImpl: send2 });
    expect(send2).toHaveBeenCalledTimes(1);
  });
});

describe('sendApprovedReply — staleness guard precision (finding 6)', () => {
  // The realistic shape: an inbound with Gmail-millisecond received_at
  // triggers a draft whose created_at (SQLite datetime('now')) lands in the
  // same wall-clock second. That draft is fresh, not stale.
  function seedWithTrigger() {
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
      contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
    });
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
    const msgId = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-trig', direction: 'inbound',
      from_email: 'a@arboga.se', to_email: 'me@x.se', subject: 's', body_text: 'leverans',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-24T12:00:00.500Z', attachment_count: 1,
    });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: msgId, reason: 'r',
      draft_template: 'T_RECEIPT', draft_subject: 'Re: s', draft_body: 'tack',
    });
    db.raw.prepare("UPDATE escalations SET created_at='2026-06-24 12:00:00' WHERE id=?").run(escId);
    return {
      convId, msgId, escId,
      conv: db.getConversation(convId),
      esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId),
    };
  }

  it('the triggering inbound itself (same second, ms > 0) never makes the draft stale', async () => {
    const { conv, esc } = seedWithTrigger();
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-orig' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a different inbound within the created_at second is tolerated (whole-second DB timestamps)', async () => {
    const { conv, esc, convId } = seedWithTrigger();
    db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-same-sec', direction: 'inbound',
      from_email: 'a@arboga.se', to_email: 'me@x.se', subject: 's2', body_text: 'del 2',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-24T12:00:00.900Z', attachment_count: 0,
    });
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-orig' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a genuinely newer, different inbound still blocks the unmodified approve', async () => {
    const { conv, esc, convId } = seedWithTrigger();
    db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-later', direction: 'inbound',
      from_email: 'a@arboga.se', to_email: 'me@x.se', subject: 's3', body_text: 'nytt svar',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-24T12:00:01.100Z', attachment_count: 0,
    });
    const send = vi.fn();
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'STALE_ESCALATION' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('runTick — two-phase T-INITIAL dispatch (C2/C3)', () => {
  function fakeGmail({ sendImpl } = {}) {
    return {
      sendCalls: [],
      sendMessage: vi.fn(sendImpl ?? async function (gmail, msg) { return { id: 'out-1', threadId: 'thr-1' }; }),
      listInboundQuery: vi.fn(async () => []),
      getMessage: vi.fn(async () => null),
      fetchAttachment: vi.fn(async () => Buffer.from('')),
    };
  }
  function fakeSlackOps() {
    return {
      posts: [], alerts: [],
      postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
      postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a-1', channel: 'C1' }; }),
    };
  }
  const deps = (gmail, slackOps, now) => ({
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
    env, contractsDir, now: now ?? new Date('2026-06-24T12:00:00Z'),
  });

  it('a failed T-INITIAL send parks the conversation NEEDS_HUMAN and never auto-resends', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'k@test.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    const gmail = fakeGmail({ sendImpl: async () => { throw new Error('quota'); } });
    const slackOps = fakeSlackOps();
    await runTick(deps(gmail, slackOps));

    expect(db.getConversation(id).state).toBe('NEEDS_HUMAN');
    const escs = db.listOpenEscalations();
    expect(escs).toHaveLength(1);
    expect(escs[0].reason).toMatch(/T-INITIAL send failed/);

    // Next tick: still NEEDS_HUMAN, no retry, no second escalation.
    const gmail2 = fakeGmail();
    await runTick(deps(gmail2, slackOps));
    expect(gmail2.sendMessage).not.toHaveBeenCalled();
    expect(db.listOpenEscalations()).toHaveLength(1);
  });

  it('a conversation stuck in SENDING (crash mid-send) is escalated, not re-sent', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'k@test.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    // Simulate the crash: claimed long ago, never finalized.
    db.raw.prepare("UPDATE conversations SET state='SENDING', state_changed_at='2026-06-24 10:00:00' WHERE id=?").run(id);

    const gmail = fakeGmail();
    const slackOps = fakeSlackOps();
    await runTick(deps(gmail, slackOps, new Date('2026-06-24T12:00:00Z')));

    expect(gmail.sendMessage).not.toHaveBeenCalled(); // never auto-retried
    expect(db.getConversation(id).state).toBe('NEEDS_HUMAN');
    expect(db.listOpenEscalations()[0].reason).toMatch(/send unconfirmed/);
  });

  it('a recently-claimed SENDING row is left alone (may be in flight in another process)', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'k@test.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    db.raw.prepare("UPDATE conversations SET state='SENDING', state_changed_at='2026-06-24 11:55:00' WHERE id=?").run(id);
    await runTick(deps(fakeGmail(), fakeSlackOps(), new Date('2026-06-24T12:00:00Z')));
    expect(db.getConversation(id).state).toBe('SENDING'); // untouched, 5 min old
    expect(db.listOpenEscalations()).toHaveLength(0);
  });

  it('an escalation stuck in sending (crash mid-approve) becomes send_unconfirmed with a Slack alert', async () => {
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
      contact_email: 'k@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
    });
    db.updateConversationState(convId, 'DELIVERING', {});
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'r',
      draft_template: 'T_RECEIPT', draft_subject: 's', draft_body: 'b',
    });
    db.raw.prepare("UPDATE escalations SET status='sending', resolved_at='2026-06-24 10:00:00' WHERE id=?").run(escId);

    const slackOps = fakeSlackOps();
    await runTick(deps(fakeGmail(), slackOps, new Date('2026-06-24T12:00:00Z')));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id=?').get(escId);
    expect(esc.status).toBe('send_unconfirmed');
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toMatch(/Arboga/);
  });
});

describe('sendInitial — failed dashboard send never leaves a due INITIAL row (C2)', () => {
  it('parks the conversation NEEDS_HUMAN on Gmail failure so the tick cannot auto-send the canned template', async () => {
    // sendInitial uses the real gmailSend, so make the fake gmail client throw
    // at the transport level.
    const gmail = { users: { messages: { send: async () => { throw new Error('invalid_grant'); } } } };
    await expect(sendInitial({
      db, gmail, env,
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'k@test.se', subject: 's', body: 'b',
    })).rejects.toThrow('invalid_grant');

    const conv = db.raw.prepare("SELECT * FROM conversations WHERE kommun_kod='9999'").get();
    expect(conv.state).toBe('NEEDS_HUMAN');
    expect(conv.notes).toMatch(/sendInitial failed/);
    // The tick's due-initial query must not pick it up.
    expect(db.listConversationsDueForInitialSend(new Date().toISOString())).toHaveLength(0);
  });

  it('aborts without calling Gmail when the INITIAL claim was won elsewhere (finding 1)', async () => {
    const gmailSendSpy = vi.fn(async () => ({ data: { id: 'out-1', threadId: 'thr-1' } }));
    const gmail = { users: { messages: { send: gmailSendSpy } } };
    // Simulate the daemon tick winning the INITIAL → SENDING claim between
    // sendInitial's createConversation and its own claim attempt: by the time
    // sendInitial claims, the row is already SENDING and the claim fails.
    const racingDb = {
      ...db,
      claimConversationForInitialSend: (id) => {
        db.claimConversationForInitialSend(id); // the tick got there first
        return db.claimConversationForInitialSend(id); // our attempt loses
      },
    };
    await expect(sendInitial({
      db: racingDb, gmail, env,
      kommun_kod: '9998', kommun_namn: 'Racekommun', role: 'central',
      contact_email: 'k@race.se', subject: 's', body: 'b',
    })).rejects.toMatchObject({ code: 'INITIAL_CLAIM_LOST' });

    expect(gmailSendSpy).not.toHaveBeenCalled(); // THE invariant: no second T-INITIAL
    // The row stays exactly as the winner left it — not parked, not clobbered.
    const conv = db.raw.prepare("SELECT * FROM conversations WHERE kommun_kod='9998'").get();
    expect(conv.state).toBe('SENDING');
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages").get().n).toBe(0);
  });
});

describe('parseDbTime', () => {
  it('parses SQLite datetime("now") format as UTC and ISO as-is', () => {
    expect(parseDbTime('2026-06-24 10:00:00').toISOString()).toBe('2026-06-24T10:00:00.000Z');
    expect(parseDbTime('2026-06-24T10:00:00.000Z').toISOString()).toBe('2026-06-24T10:00:00.000Z');
    expect(parseDbTime(null)).toBe(null);
  });
});
