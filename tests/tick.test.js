import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick } from '../src/tick.js';

let tmp, db, baseDir, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-tick-'));
  baseDir = tmp;
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function fakeGmail(opts = {}) {
  return {
    sendCalls: [],
    listResult: opts.listResult ?? [],
    getResult: opts.getResult ?? {},
    sendMessage: vi.fn(async function (gmail, msg) {
      this.sendCalls.push(msg);
      return { id: `out-${this.sendCalls.length}`, threadId: msg.threadId ?? `thr-${this.sendCalls.length}` };
    }),
    listInboundQuery: vi.fn(async () => opts.listResult ?? []),
    getMessage: vi.fn(async (gmail, id) => opts.getResult?.[id] ?? null),
    fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
  };
}

function fakeSlack() {
  return {
    posts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) {
      this.posts.push({ blocks });
      return { ts: `slack-${this.posts.length}`, channel: 'C1' };
    }),
  };
}

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  GMAIL_LABEL_PREFIX: 'mediagraf/pilot',
  SLACK_CHANNEL_ID: 'C1',
};

describe('runTick — initial dispatch', () => {
  it('sends T-INITIAL to conversations whose scheduled_send_at <= now and state=INITIAL', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    const gmail = fakeGmail();
    const slack = fakeSlack();
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
    });
    expect(gmail.sendCalls).toHaveLength(1);
    expect(gmail.sendCalls[0].to).toBe('gustaf.hard@gmail.com');
    expect(gmail.sendCalls[0].subject).toMatch(/Begäran om allmänna handlingar/);
    expect(db.getConversation(id).state).toBe('SENT');
  });

  it('does not send before scheduled_send_at', async () => {
    db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-20T09:00:00Z',
    });
    const gmail = fakeGmail();
    const slack = fakeSlack();
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
    });
    expect(gmail.sendCalls).toHaveLength(0);
  });
});

describe('runTick — inbound processing', () => {
  it('classifies auto_ack and transitions SENT → ACK_RECEIVED without outbound', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-X', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-1' }],
      getResult: {
        'in-1': {
          id: 'in-1', threadId: 'thr-X',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' },
              { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' },
              { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Ärendenummer: K9999001').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    const conv = db.getConversation(id);
    expect(conv.state).toBe('ACK_RECEIVED');
    expect(conv.arendenummer).toBe('K9999001');
    expect(gmail.sendCalls).toHaveLength(0);
  });

  it('classifies clarification and posts T-PRECISION DRAFT to Slack (no autosend)', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'ACK_RECEIVED', { gmail_thread_id: 'thr-Y', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-2' }],
      getResult: {
        'in-2': {
          id: 'in-2', threadId: 'thr-Y',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
              { name: 'Message-Id', value: '<msg-2@x.se>' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Kan du precisera din begäran?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    // No autosend in v1 — only T-INITIAL ships without approval
    expect(gmail.sendCalls).toHaveLength(0);
    // Slack post with T-PRECISION draft for human approval
    expect(slack.posts).toHaveLength(1);
    const esc = db.listOpenEscalations()[0];
    expect(esc.draft_template).toBe('T_PRECISION');
    expect(esc.draft_body).toMatch(/preciserar gärna/);
    // State transition still happens automatically (bookkeeping)
    expect(db.getConversation(id).state).toBe('AWAITING_PRECISION');
  });

  it('classifies unknown and escalates to Slack without outbound', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'central',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-Z', last_outbound_at: '2026-05-19T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-3' }],
      getResult: {
        'in-3': {
          id: 'in-3', threadId: 'thr-Z',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hej, kan du ringa mig?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    expect(gmail.sendCalls).toHaveLength(0);
    expect(slack.posts).toHaveLength(1);
    expect(db.getConversation(id).state).toBe('NEEDS_HUMAN');
    const escs = db.listOpenEscalations();
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
  });

  it('does not re-process a message it already saw', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-X', last_outbound_at: '2026-05-19T10:00:00Z' });

    const list = [{ id: 'in-dup' }];
    const getResult = {
      'in-dup': {
        id: 'in-dup', threadId: 'thr-X',
        payload: {
          headers: [
            { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
            { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Ärendenummer: K9999001').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
        },
      },
    };
    const gmail = fakeGmail({ listResult: list, getResult });
    const slack = fakeSlack();
    const args = {
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    };
    await runTick(args);
    await runTick(args);
    expect(gmail.getMessage).toHaveBeenCalledTimes(1);
  });
});
