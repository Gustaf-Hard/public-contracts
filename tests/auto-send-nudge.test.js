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

function seedHealthyTick(now) {
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(now.getTime() - 5 * 60000).toISOString());
}

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), now = new Date('2026-08-17T09:00:00Z') } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
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
function seedInbound(convId, { classification = null, receivedAt = '2026-07-26T10:00:00Z' } = {}) {
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
    attachment_count: 0,
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
