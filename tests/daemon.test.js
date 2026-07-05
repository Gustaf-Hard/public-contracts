// The daemon's Slack interactivity handler (autopilot review C1, L1, M1) and
// the tick overlap latch (C3). All offline: fake Slack client, fake Gmail send
// via sendApprovedReply's gmailSendImpl seam, real HMAC signatures.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createInteractivityHandler, makeExclusive } from '../src/daemon.js';
import { sendApprovedReply } from '../src/send-reply.js';

const SIGNING_SECRET = 'test-secret';
const env = {
  GMAIL_USER_EMAIL: 'me@x.se',
  GMAIL_FROM_NAME: 'Me',
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  SLACK_CHANNEL_ID: 'C1',
};

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-daemon-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seed() {
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-1' });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'r',
    draft_template: 'T_RECEIPT', draft_subject: 'Re: SV', draft_body: 'tack',
    slack_ts: 'ts-1',
  });
  return { convId, escId };
}

// Build a correctly signed fake express req + capturing res.
function slackRequest(payload) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'v0=' + crypto.createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`).digest('hex');
  const headers = { 'X-Slack-Request-Timestamp': timestamp, 'X-Slack-Signature': signature };
  const req = { body: Buffer.from(body), header: (name) => headers[name] };
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    send(b) { this.body = b; return this; },
  };
  return { req, res };
}

function approvePayload(escId) {
  return {
    type: 'block_actions',
    user: { id: 'U1', name: 'op' },
    actions: [{ action_id: 'esc_approve', value: String(escId) }],
    message: { ts: 'ts-1' },
  };
}

function fakeSlack() {
  return {
    chat: {
      update: vi.fn(async () => ({ ok: true })),
      postMessage: vi.fn(async () => ({ ts: 't', channel: 'C1' })),
    },
  };
}

describe('createInteractivityHandler — approve path', () => {
  it('rejects a bad signature with 401 and does nothing', async () => {
    const { escId } = seed();
    const send = vi.fn();
    const handler = createInteractivityHandler({
      db, slack: fakeSlack(), gmail: {}, env, log: () => {},
      sendApprovedReplyImpl: send,
    });
    const { req, res } = slackRequest(approvePayload(escId));
    req.header = () => 'garbage';
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('approve sends once, resolves the escalation, records the decision, strips buttons, then acks', async () => {
    const { escId, convId } = seed();
    const slack = fakeSlack();
    const gmailSendImpl = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-1' }));
    const handler = createInteractivityHandler({
      db, slack, gmail: {}, env, log: () => {},
      sendApprovedReplyImpl: (args) => sendApprovedReply({ ...args, gmailSendImpl }),
    });

    const { req, res } = slackRequest(approvePayload(escId));
    await handler(req, res);

    expect(res.statusCode).toBe(200); // acked after the work (L1)
    expect(gmailSendImpl).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('resolved_send');
    const decisions = db.listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('approve_unmodified');
    expect(db.getConversation(convId).receipt_sent).toBe(1); // T_RECEIPT side effect
    expect(slack.chat.update).toHaveBeenCalled(); // buttons stripped
  });

  it('a second approve click is a no-op: no second send, buttons re-stripped', async () => {
    const { escId } = seed();
    const slack = fakeSlack();
    const gmailSendImpl = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-1' }));
    const handler = createInteractivityHandler({
      db, slack, gmail: {}, env, log: () => {},
      sendApprovedReplyImpl: (args) => sendApprovedReply({ ...args, gmailSendImpl }),
    });

    const first = slackRequest(approvePayload(escId));
    await handler(first.req, first.res);
    const second = slackRequest(approvePayload(escId));
    await handler(second.req, second.res);

    expect(second.res.statusCode).toBe(200); // still acked — Slack must not retry forever
    expect(gmailSendImpl).toHaveBeenCalledTimes(1); // THE invariant
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages WHERE direction='outbound'").get().n).toBe(1);
  });

  it('skip resolves with a decision row keyed on the draft-time state and strips buttons', async () => {
    const { convId } = seed();
    // Give the escalation an explicit previous_state that differs from the
    // conversation's current state, to pin the decision pair key (review M3).
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'r2',
      draft_template: 'free_form', draft_subject: 's', draft_body: 'b',
      previous_state: 'SENT', slack_ts: 'ts-2',
    });
    const slack = fakeSlack();
    const handler = createInteractivityHandler({ db, slack, gmail: {}, env, log: () => {} });

    const { req, res } = slackRequest({
      type: 'block_actions',
      user: { id: 'U1' },
      actions: [{ action_id: 'esc_skip', value: String(escId) }],
    });
    await handler(req, res);

    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('resolved_skip');
    const d = db.listDecisions().find((x) => x.escalation_id === escId);
    expect(d.decision).toBe('skip');
    expect(d.conversation_state).toBe('SENT'); // draft-time state, not approval-time
    expect(slack.chat.update).toHaveBeenCalled();
  });

  it('skip on an already-resolved escalation records no duplicate decision', async () => {
    const { escId } = seed();
    db.resolveEscalation(escId, { status: 'resolved_skip' });
    const handler = createInteractivityHandler({ db, slack: fakeSlack(), gmail: {}, env, log: () => {} });
    const { req, res } = slackRequest({
      type: 'block_actions', user: { id: 'U1' },
      actions: [{ action_id: 'esc_skip', value: String(escId) }],
    });
    await handler(req, res);
    expect(db.listDecisions()).toHaveLength(0);
  });
});

describe('makeExclusive — tick overlap latch (C3)', () => {
  it('skips an invocation while the previous one is still running, then allows the next', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const fn = vi.fn(async () => { calls.push('start'); await gate; calls.push('end'); });
    const wrapped = makeExclusive(fn, { name: 'tick' });

    const p1 = wrapped();
    const p2 = wrapped(); // overlaps → must be skipped
    const r2 = await p2;
    expect(r2).toEqual({ skipped: true });
    expect(fn).toHaveBeenCalledTimes(1);

    release();
    await p1;
    await wrapped(); // after completion it runs again
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
