import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick, runDailyFollowup } from '../src/tick.js';
import * as analyseMod from '../src/analyse-message.js';

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
    expect(esc.classifier_class).toBe('clarification');
    expect(esc.classifier_confidence).toBeGreaterThan(0);
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
    expect(escs[0].previous_state).toBe('SENT');
  });

  it('LLM analysis path: delay_promise sets follow_up_at and records analysis_json (no outbound)', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-LLM', last_outbound_at: '2026-05-19T10:00:00Z' });

    const fakeAnalysis = {
      intent: 'delay_promise', confidence: 0.95,
      summary: 'Kommunen utlovar svar inom 10 arbetsdagar.',
      extracted: { arendenummer: null, promised_response_days: 10, promised_response_date: '2026-06-08', handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null },
      suggested_action: 'wait',
      draft_reply: 'Hej,\n\nTack för uppdateringen. Jag inväntar handlingarna senast 8 juni.\n\nMed vänliga hälsningar,\nGustaf Hård af Segerstad',
      follow_up_at: '2026-06-11',
    };
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(fakeAnalysis);

    const gmail = fakeGmail({
      listResult: [{ id: 'in-llm-1' }],
      getResult: {
        'in-llm-1': {
          id: 'in-llm-1', threadId: 'thr-LLM',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Vi behöver cirka 10 arbetsdagar.').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-29T11:00:00Z'),
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(gmail.sendCalls).toHaveLength(0);
    expect(slack.posts).toHaveLength(0); // delay_promise → auto_ack legacy → no escalation

    const conv = db.getConversation(id);
    expect(conv.state).toBe('ACK_RECEIVED');
    expect(conv.follow_up_at).toBe('2026-06-11');

    // analysis_json was persisted
    const messages = db.listMessages(id);
    expect(messages).toHaveLength(1);
    const recorded = JSON.parse(messages[0].analysis_json);
    expect(recorded.intent).toBe('delay_promise');
    expect(recorded.extracted.promised_response_days).toBe(10);

    spy.mockRestore();
  });

  it('LLM analysis path: clarification uses LLM draft_reply (not template) in escalation', async () => {
    const id = db.createConversation({
      kommun_kod: '9999', kommun_namn: 'Testkommun', role: 'utbildning',
      contact_email: 'gustaf.hard@gmail.com', scheduled_send_at: '2026-05-19T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-LLM2', last_outbound_at: '2026-05-19T10:00:00Z' });

    const llmBody = 'Hej,\n\nJag preciserar gärna: jag söker aktiva avtal för digitala läromedel under perioden 2024-2026...\n\nMvh\nGustaf';
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
      intent: 'clarification', confidence: 0.9,
      summary: 'Behöver precisering.',
      extracted: { arendenummer: null, promised_response_days: null, promised_response_date: null, handoff_to_email: null, handoff_to_forvaltning: null, questions: ['vilken period?'], mentioned_vendors: null },
      suggested_action: 'send_precision',
      draft_reply: llmBody,
      follow_up_at: null,
    });

    const gmail = fakeGmail({
      listResult: [{ id: 'in-llm-2' }],
      getResult: {
        'in-llm-2': {
          id: 'in-llm-2', threadId: 'thr-LLM2',
          payload: {
            headers: [
              { name: 'From', value: 'a@x.se' }, { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Re: Begäran' }, { name: 'Date', value: 'Mon, 19 May 2026 10:30:00 +0200' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Vilken period?').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
          },
        },
      },
    });
    const slack = fakeSlack();

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: slack,
      env, contractsDir, now: new Date('2026-05-19T11:00:00Z'),
    });

    expect(slack.posts).toHaveLength(1);
    const esc = db.listOpenEscalations()[0];
    expect(esc.draft_template).toBe('T_PRECISION');
    expect(esc.draft_body).toBe(llmBody); // not the canned template
    expect(esc.reason).toMatch(/llm intent=clarification/);

    spy.mockRestore();
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

describe('runTick — contract analysis hook', () => {
  it('calls the injected analyseContracts hook with the db', async () => {
    const analyseContracts = vi.fn(async () => 0);
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: fakeGmail(), slackClient: {}, slackOps: fakeSlack(),
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
      analyseContracts,
    });
    expect(analyseContracts).toHaveBeenCalledTimes(1);
    expect(analyseContracts.mock.calls[0][0]).toHaveProperty('db');
  });

  it('survives an analyseContracts hook that throws', async () => {
    const analyseContracts = vi.fn(async () => { throw new Error('llm down'); });
    await expect(runTick({
      db, gmailClient: { gmail: {} }, gmailOps: fakeGmail(), slackClient: {}, slackOps: fakeSlack(),
      env, contractsDir, now: new Date('2026-05-19T10:00:00Z'),
      analyseContracts,
    })).resolves.not.toThrow();
  });
});

describe('runTick — out-of-thread inbound matched by sender domain', () => {
  function plainMsg(id, threadId, from, bodyText) {
    return {
      id, threadId,
      payload: {
        headers: [
          { name: 'From', value: from },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Fw: Avtal' },
          { name: 'Date', value: 'Fri, 12 Jun 2026 10:30:00 +0200' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from(bodyText).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') },
      },
    };
  }

  it('ingests a kommun reply that arrived in a DIFFERENT thread (domain match)', async () => {
    const id = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-10T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-orig', last_outbound_at: '2026-06-10T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'fwd-1' }],
      // arrives in thr-fwd (NOT the tracked thr-orig) from jerker@ale.se
      getResult: { 'fwd-1': plainMsg('fwd-1', 'thr-fwd', 'Jerker Rellmark <jerker.rellmark@ale.se>', 'Ärendenummer: K1440001') },
    });
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: fakeSlack(),
      env, contractsDir, now: new Date('2026-06-12T11:00:00Z'),
    });
    const conv = db.getConversation(id);
    expect(conv.state).toBe('ACK_RECEIVED');           // message was processed
    expect(conv.arendenummer).toBe('K1440001');
    expect(db.hasGmailMessageId('fwd-1')).toBe(true);  // recorded
  });

  it('does NOT ingest an unrelated-domain message in a different thread', async () => {
    const id = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-10T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-orig', last_outbound_at: '2026-06-10T10:00:00Z' });

    const gmail = fakeGmail({
      listResult: [{ id: 'spam-1' }],
      getResult: { 'spam-1': plainMsg('spam-1', 'thr-other', 'Willys <no-reply@handla.willys.se>', 'Ärendenummer: K9999999') },
    });
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: fakeSlack(),
      env, contractsDir, now: new Date('2026-06-12T11:00:00Z'),
    });
    const conv = db.getConversation(id);
    expect(conv.state).toBe('SENT');                   // unchanged — not matched
    expect(db.hasGmailMessageId('spam-1')).toBe(false);
  });
});

describe('runTick — zip attachments are expanded into inner PDFs', () => {
  it('extracts PDF entries from a zipped inbound attachment and saves them', async () => {
    const id = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-10T09:00:00Z',
    });
    db.updateConversationState(id, 'SENT', { gmail_thread_id: 'thr-zip', last_outbound_at: '2026-06-10T10:00:00Z' });

    const zipBytes = Buffer.from(zipSync({
      'Avtal LexiFlow.pdf': strToU8('%PDF-1.4 lexiflow'),
      'notes.txt': strToU8('skip me'),
    }));

    const gmail = fakeGmail({
      listResult: [{ id: 'zip-1' }],
      getResult: {
        'zip-1': {
          id: 'zip-1', threadId: 'thr-zip',
          payload: {
            headers: [
              { name: 'From', value: 'Jerker <jerker@ale.se>' },
              { name: 'To', value: 'gustaf@mediagraf.se' },
              { name: 'Subject', value: 'Handlingar' },
              { name: 'Date', value: 'Fri, 12 Jun 2026 10:30:00 +0200' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              { mimeType: 'text/plain', body: { data: Buffer.from('Se bifogat').toString('base64url') } },
              { mimeType: 'application/zip', filename: 'Handlingar.zip', body: { attachmentId: 'zatt-1', size: zipBytes.length } },
            ],
          },
        },
      },
    });
    gmail.fetchAttachment = vi.fn(async () => zipBytes);

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: fakeSlack(),
      env, contractsDir, now: new Date('2026-06-12T11:00:00Z'),
    });

    const atts = db.raw.prepare('SELECT a.filename FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=?').all(id);
    expect(atts.map((a) => a.filename)).toEqual(['Avtal LexiFlow.pdf']);
  });
});
