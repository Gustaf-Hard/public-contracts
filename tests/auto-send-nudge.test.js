// Auto-send of T_FOLLOWUP_NUDGE (2026-08-17 design): the first outbound class
// graduated from human-approved to automatic. Everything rides the existing
// approved-send rails; these tests are the contract for the graduation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runDailyFollowup } from '../src/tick.js';
import { sendApprovedReply } from '../src/send-reply.js';
import { renderArenden } from '../src/dashboard-views.js';

let tmp, db, contractsDir, overridesPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-autosend-'));
  contractsDir = join(tmp, 'contracts');
  overridesPath = join(tmp, 'overrides.json');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

function writeSwitch(value) {
  writeFileSync(overridesPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function fakeSlackOps() {
  return {
    posts: [], updates: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async function (slack, args) { this.updates.push(args); }),
  };
}

// sendMessage is passed DETACHED as gmailSendImpl, so capture via closure, not `this`.
function fakeGmail({ sendError = null } = {}) {
  const sent = [];
  return {
    sent,
    sendMessage: vi.fn(async (gmailClient, args) => {
      if (sendError) throw new Error(sendError);
      sent.push(args);
      return { id: `out-${sent.length}`, threadId: 'thr-a' };
    }),
    archiveThread: vi.fn(async () => {}),
    listInboundQuery: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
  };
}

// Seeds a heartbeat that reads healthy to BOTH clocks in play, which is the
// only way this helper earns its name:
//  - runDailyFollowup's gate calls getTickHealth({ now }) with the injected
//    fake clock (tick.js:1331);
//  - sendApprovedReply's STALE_INGEST guard calls getTickHealth() with NO
//    arguments (send-reply.js:196), so it defaults to the REAL clock
//    (storage.js:756).
// Stamping only against the fake clock (2026-08-17T09:00:00Z) went permanently
// stale the moment real wall-clock passed 09:55Z that day, which would refuse
// every T_FOLLOWUP_NUDGE auto-send as STALE_INGEST. Stamping 5 minutes before
// whichever clock is LATER is healthy for both: the later clock sees a 5-minute
// age, the earlier one sees a negative age, and `stale` is `ageMin >
// thresholdMin`, so a negative age is never stale.
function seedHealthyTick(now = new Date()) {
  const latest = Math.max(Date.now(), now.getTime());
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(latest - 5 * 60000).toISOString());
}

// sendApprovedReply strips the Slack buttons via the REAL updateEscalationResolved
// imported from slack.js, not via slackOps — so the only way to see what the
// channel is told about an auto-send is a slackClient with a chat.update spy.
// Default `{}` keeps every other test on the previous behaviour (chat.update is
// undefined, stripSlackButtons swallows the TypeError).
function fakeSlackClient() {
  const updates = [];
  return { updates, chat: { update: async (args) => { updates.push(args); } } };
}

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), slackClient = {}, now = new Date('2026-08-17T09:00:00Z') } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient, slackOps,
    env, contractsDir, now, overridesPath,
  };
}

// Default seed is 23 days stale — safely past the 9–15-day jittered threshold
// for ANY conversation id.
function seedConv({ state = 'SENT', stateChangedAt = '2026-07-25T00:00:00Z', followupCount = 0, followUpAt = null, role = 'central', kommun = ['1440', 'Ale'], email = 'kansli@ale.se' } = {}) {
  const id = db.createConversation({
    kommun_kod: kommun[0], kommun_namn: kommun[1], role,
    contact_email: email, scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: 'thr-a', last_outbound_at: '2026-07-10T10:00:00Z',
    followup_count: followupCount, follow_up_at: followUpAt,
  });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  return id;
}

let inboundSeq = 0;
function seedInbound(convId, { classification = null, receivedAt = '2026-07-26T10:00:00Z', attachmentCount = 0 } = {}) {
  inboundSeq += 1;
  db.recordMessage({
    conversation_id: convId,
    gmail_message_id: `in-${inboundSeq}`,
    direction: 'inbound',
    from_email: 'kansli@ale.se',
    to_email: env.GMAIL_USER_EMAIL,
    subject: 'SV: Begäran om allmänna handlingar',
    body_text: 'Vi har mottagit din begäran.',
    classification,
    classification_confidence: classification ? 0.9 : null,
    received_at: receivedAt,
    attachment_count: attachmentCount,
    gmail_thread_id: 'thr-a',
  });
}

function seedNudgeEscalation(convId) {
  return db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'stale SENT',
    draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 'Påminnelse: begäran om allmänna handlingar',
    draft_body: 'Hej,\n\nJag vill bara följa upp min begäran.\n\nMvh Gustaf',
    classifier_class: 'followup_stale', previous_state: 'SENT',
  });
}

describe("sendApprovedReply guards apply to decision 'auto_send'", () => {
  it('STALE_ESCALATION: an inbound newer than the draft blocks auto_send exactly like approve_unmodified', async () => {
    const id = seedConv({});
    const escId = seedNudgeEscalation(id);
    db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-08-16 08:00:00', escId);
    seedInbound(id, { classification: 'auto_ack', receivedAt: '2026-08-16T10:00:00Z' });
    seedHealthyTick(new Date('2026-08-17T09:00:00Z'));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const gmail = fakeGmail();
    await expect(sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      decision: 'auto_send', gmailSendImpl: gmail.sendMessage,
      archiveThreadImpl: gmail.archiveThread,
    })).rejects.toMatchObject({ code: 'STALE_ESCALATION' });

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('STALE_INGEST refuses an auto_send and leaves the escalation open', async () => {
    const id = seedConv({});
    const escId = seedNudgeEscalation(id);
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
      .run(new Date(Date.now() - 120 * 60000).toISOString());

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const gmail = fakeGmail();
    await expect(sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      decision: 'auto_send', gmailSendImpl: gmail.sendMessage,
      archiveThreadImpl: gmail.archiveThread,
    })).rejects.toMatchObject({ code: 'STALE_INGEST' });

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
    expect(db.listDecisions()).toHaveLength(0);
  });
});

describe('runDailyFollowup auto-sends eligible T_FOLLOWUP_NUDGE', () => {
  it('eligible (SENT, zero inbound, switch on): exactly one send, resolved_send, decision auto_send, followup_count 1', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(gmail.sent[0].to).toBe('kansli@ale.se');
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(id);
    expect(esc.status).toBe('resolved_send');
    expect(esc.draft_template).toBe('T_FOLLOWUP_NUDGE');
    expect(gmail.sent[0].body).toBe(esc.draft_body);           // draft exactly as escalated
    expect(gmail.sent[0].subject).toBe(esc.draft_subject);
    const decisions = db.listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'auto_send', draft_template: 'T_FOLLOWUP_NUDGE', conversation_id: id,
    });
    const conv = db.getConversation(id);
    expect(conv.followup_count).toBe(1);
    expect(conv.state).toBe('SENT');
  });

  it('lazy-only inbound (auto_ack + delay_promise past its follow_up_at) auto-sends', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ state: 'ACK_RECEIVED', followUpAt: '2026-08-10' });
    seedInbound(id, { classification: 'auto_ack' });
    seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-07-27T10:00:00Z' });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.listDecisions()[0]?.decision).toBe('auto_send');
  });

  it('a lazy-classified inbound carrying an attachment → escalation stays open, nothing sent', async () => {
    // The classifier said auto_ack, but the mail came with a file. Every other
    // part of the system treats an attachment as substance (thread status,
    // contract-analysis queue) — so a possible delivered avtal sitting unread
    // on our disk falls back to the operator instead of an unattended nudge.
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    seedInbound(id, { classification: 'auto_ack', attachmentCount: 1 });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.listDecisions()).toHaveLength(0);
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
  });

  it('any substantive or unclassified inbound → escalation stays open, nothing sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const cases = [
      ['0180', 'Stockholm', 'delivery'],
      ['1480', 'Göteborg', 'unknown'],
      ['1280', 'Malmö', null],
    ];
    for (const [kod, namn, classification] of cases) {
      const id = seedConv({ kommun: [kod, namn], email: `kansli@${kod}.se` });
      seedInbound(id, { classification });
    }
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.listDecisions()).toHaveLength(0);
    expect(db.listOpenEscalations()).toHaveLength(cases.length); // drafted, awaiting the operator
  });

  it('kill switch absent, empty, or malformed → fully manual', async () => {
    const id = seedConv({});
    for (const content of [null, '{}', '{"auto_send_templates":[]}', '{broken']) {
      if (content !== null) writeSwitch(content);
      else rmSync(overridesPath, { force: true });
      const gmail = fakeGmail();
      await runDailyFollowup(deps({ gmail }));
      expect(gmail.sendMessage).not.toHaveBeenCalled();
      // The first pass drafts the escalation and leaves it open; later passes
      // are blocked by hasActiveEscalation — which is itself the contract.
    }
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('switch edited between two runs takes effect without restart — and an open refusal is never retried', async () => {
    // Day 1, switch OFF: conv A drafts a manual escalation.
    rmSync(overridesPath, { force: true });
    const a = seedConv({});
    const gmail1 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail1 }));
    expect(gmail1.sendMessage).not.toHaveBeenCalled();
    expect(db.listOpenEscalationsForConversation(a)).toHaveLength(1);

    // Day 2, operator flips the switch ON. Conv B is due; conv A still holds
    // its open escalation → hasActiveEscalation skips it entirely.
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-18T09:00:00Z') }));

    expect(gmail2.sendMessage).toHaveBeenCalledTimes(1);
    expect(gmail2.sent[0].to).toBe('stad@goteborg.se');
    expect(db.listOpenEscalationsForConversation(a)).toHaveLength(1); // untouched
    expect(db.listDecisions().map((d) => d.conversation_id)).toEqual([b]);
  });

  it('a Gmail failure parks send_failed, books no decision, and the next daily run does not re-attempt', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    const gmail = fakeGmail({ sendError: 'socket hang up' });
    await runDailyFollowup(deps({ gmail }));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(id);
    expect(esc.status).toBe('send_failed');
    expect(db.listDecisions()).toHaveLength(0);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);

    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-18T09:00:00Z') }));
    expect(gmail2.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1);
  });

  it('nudge cap: followup_count = 2 → free_form escalation to a human, never auto-sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ followupCount: 2 });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('a mid-run failure does not stop the remaining conversations', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    seedConv({});                                                       // will fail to send
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    let calls = 0;
    const gmail = fakeGmail();
    gmail.sendMessage.mockImplementation(async (gmailClient, args) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      gmail.sent.push(args);
      return { id: `out-${calls}`, threadId: 'thr-a' };
    });
    await runDailyFollowup(deps({ gmail }));

    expect(calls).toBe(2);                                              // second conv still processed
    expect(db.listDecisions().map((d) => d.conversation_id)).toEqual([b]);
    expect(db.getFollowupCompletedDate()).not.toBeNull();               // the run completed
  });
});

// The DB ledger tells machine sends from operator sends via decision='auto_send'.
// Slack is the only artifact an operator actually reads, so it must say the same
// thing — labelling an unattended send "godkänt oförändrat" would have a
// colleague scrolling the channel conclude a human approved it.
describe('Slack tells the truth about who sent an auto-sent nudge', () => {
  it('the resolved Slack message reads as unattended, never as operator-approved', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    const slackClient = fakeSlackClient();
    await runDailyFollowup(deps({ gmail: fakeGmail(), slackClient }));

    expect(db.listDecisions()[0]?.decision).toBe('auto_send');
    expect(db.raw.prepare('SELECT status FROM escalations WHERE conversation_id = ?').get(id).status)
      .toBe('resolved_send');                    // stored status unchanged: no new state string

    expect(slackClient.updates).toHaveLength(1);
    expect(slackClient.updates[0].text).toContain('Auto-skickat');
    expect(slackClient.updates[0].text).not.toContain('godkänt oförändrat');
  });

  it('an operator approving the same draft still reads as approved', async () => {
    const id = seedConv({});
    const escId = seedNudgeEscalation(id);
    db.raw.prepare('UPDATE escalations SET slack_ts = ? WHERE id = ?').run('s-1', escId);
    seedHealthyTick(new Date('2026-08-17T09:00:00Z'));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const gmail = fakeGmail();
    const slackClient = fakeSlackClient();
    await sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      decision: 'approve_unmodified', gmailSendImpl: gmail.sendMessage,
      archiveThreadImpl: gmail.archiveThread, slackClient,
    });

    expect(slackClient.updates[0].text).toContain('godkänt oförändrat');
    expect(slackClient.updates[0].text).not.toContain('Auto-skickat');
  });
});

describe('dashboard visibility — Auto-skickade', () => {
  function seedDecision(convId, decision, decidedAt) {
    const escId = seedNudgeEscalation(convId);
    db.resolveEscalation(escId, { status: 'resolved_send', resolved_text: 'b' });
    const decId = db.recordDecision({
      escalation_id: escId, conversation_id: convId, conversation_state: 'SENT',
      classifier_class: 'followup_stale', draft_template: 'T_FOLLOWUP_NUDGE',
      draft_body: 'b', decision, final_body: 'b',
    });
    db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decidedAt, decId);
    return decId;
  }

  it('listAutoSendDecisions: only auto_send rows, newest first, with the join fields the view needs', () => {
    const a = seedConv({});
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    seedDecision(a, 'approve_unmodified', '2026-08-15 09:00:00');
    seedDecision(a, 'auto_send', '2026-08-16 09:00:00');
    seedDecision(b, 'auto_send', '2026-08-17 09:00:00');

    const rows = db.listAutoSendDecisions(20);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kommun_namn: 'Göteborg', role: 'central', conversation_id: b,
      draft_template: 'T_FOLLOWUP_NUDGE',
    });
    expect(rows[0].decided_at).toBe('2026-08-17T09:00:00Z');
    expect(rows[1].kommun_namn).toBe('Ale');
    expect(typeof rows[0].followup_count).toBe('number');
    expect(db.listAutoSendDecisions(1)).toHaveLength(1);
  });

  it('renderArenden shows the section only when rows exist', () => {
    expect(renderArenden({ cases: [] })).not.toContain('Auto-skickade');
    const html = renderArenden({
      cases: [],
      autoSends: [{
        decision_id: 1, decided_at: '2026-08-17T09:00:00Z', draft_template: 'T_FOLLOWUP_NUDGE',
        conversation_id: 3, kommun_namn: 'Ale', role: 'central', followup_count: 1,
      }],
    });
    expect(html).toContain('Auto-skickade');
    expect(html).toContain('/arenden/3');
    expect(html).toContain('Ale');
  });
});
