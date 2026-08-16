// Step 2b (escalation dispatch) runs AFTER every inbound row is committed, so a
// throw there cannot be recovered by "retry next tick" — the message will never
// be re-fetched. These tests pin that one bad dispatch neither crashes the tick
// nor silently swallows the remaining drafts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick } from '../src/tick.js';
import * as analyseMod from '../src/analyse-message.js';

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-dispatch-'));
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

function b64(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mkMsg(id, threadId, from, body, { subject = 'Svar', internalDate } = {}) {
  return {
    id, threadId, internalDate,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from }, { name: 'To', value: 'gustaf@mediagraf.se' },
        { name: 'Subject', value: subject },
      ],
      body: { data: b64(body) },
    },
  };
}

function fakeGmail(opts = {}) {
  return {
    sendMessage: vi.fn(async () => ({ id: 'out-x', threadId: 'thr-x' })),
    listInboundQuery: vi.fn(async () => opts.listResult ?? []),
    getMessage: vi.fn(async (gmail, id) => opts.getResult?.[id] ?? null),
    fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
  };
}

function fakeSlackOps(overrides = {}) {
  return {
    posts: [], alerts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a', channel: 'C1' }; }),
    updateEscalationResolved: vi.fn(async () => ({})),
    ...overrides,
  };
}

function seedConv({ kod = '1440', namn = 'Ale', role = 'central', email = 'kansli@ale.se', thread = 'thr-a' } = {}) {
  const id = db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role, contact_email: email,
    scheduled_send_at: '2026-06-01T00:00:00Z',
  });
  db.updateConversationState(id, 'SENT', { gmail_thread_id: thread, last_outbound_at: '2026-06-10T10:00:00Z' });
  return id;
}

describe('dispatchEscalationForIngest — voiding a stale draft', () => {
  it('voids the open escalation and completes the tick when the kommun replies with no new draft', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    // A draft written on an earlier tick, still waiting for the operator.
    const staleId = db.recordEscalation({
      conversation_id: id, reason: 'nudge', draft_template: 'free_form',
      draft_subject: 'Re: Begäran', draft_body: 'Har ni hunnit titta på detta?',
    });

    const gmail = fakeGmail({
      listResult: [{ id: 'm-dead' }],
      getResult: {
        'm-dead': mkMsg('m-dead', 'thr-a', 'Kansli <kansli@ale.se>', 'Vi har inga avtal med sådana leverantörer.'),
      },
    });
    const analyseContracts = vi.fn(async () => {});
    const logs = [];

    // The daemon ALWAYS passes a log fn — the void branch is only reachable with
    // one, which is exactly why the `conv is not defined` crash never showed up
    // in a test that omitted it.
    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: fakeSlackOps(),
      env, contractsDir, now: new Date('2026-06-24T12:00:00Z'),
      analyseContracts, log: (m) => logs.push(m),
    });
    spy.mockRestore();

    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(staleId).status).toBe('superseded');
    expect(db.listOpenEscalationsForConversation(id)).toEqual([]);
    expect(logs.some((l) => l.includes('VOIDED') && l.includes('Ale'))).toBe(true);
    // The tick ran to completion — step 3 was reached.
    expect(analyseContracts).toHaveBeenCalled();
    expect(db.getConversation(id).state).toBe('DEAD_END');
  });
});

describe('runTick — one failing dispatch never takes the batch down', () => {
  it('escalates the remaining messages, alerts the operator about the failed one, and still runs contract analysis', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const ale = seedConv({ kod: '1440', namn: 'Ale', email: 'kansli@ale.se', thread: 'thr-ale' });
    const boden = seedConv({ kod: '2582', namn: 'Boden', email: 'kommun@boden.se', thread: 'thr-boden' });

    // Slack is down for the first escalation only (a 500, or a bug in the
    // draft path) — the second must be unaffected.
    const slackOps = fakeSlackOps();
    slackOps.postEscalation = vi.fn(async function (slack, { fallbackText }) {
      if (fallbackText.includes('Ale')) throw new Error('slack 500');
      this.posts.push(fallbackText);
      return { ts: `s-${this.posts.length}`, channel: 'C1' };
    });

    const gmail = fakeGmail({
      listResult: [{ id: 'm-ale' }, { id: 'm-boden' }],
      getResult: {
        'm-ale': mkMsg('m-ale', 'thr-ale', 'K <kansli@ale.se>', 'Hej, kan du ringa mig?', { internalDate: '2026-06-24T09:00:00.000Z' }),
        'm-boden': mkMsg('m-boden', 'thr-boden', 'K <kommun@boden.se>', 'Hej, kan du ringa mig?', { internalDate: '2026-06-24T10:00:00.000Z' }),
      },
    });
    const analyseContracts = vi.fn(async () => {});

    await runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
      env, contractsDir, now: new Date('2026-06-24T12:00:00Z'),
      analyseContracts, log: () => {},
    });
    spy.mockRestore();

    // Both messages were committed before dispatch ran, so neither is lost.
    expect(db.raw.prepare('SELECT COUNT(*) n FROM messages WHERE direction=?').get('inbound').n).toBe(2);
    // The second conversation still got its draft + Slack post.
    expect(db.listOpenEscalationsForConversation(boden)).toHaveLength(1);
    expect(slackOps.posts.some((t) => t.includes('Boden'))).toBe(true);
    // The operator is told WHICH message dropped — it will never be retried.
    const alert = slackOps.alerts.find((t) => t.includes('m-ale'));
    expect(alert).toBeDefined();
    expect(alert).toContain('Ale');
    // Step 3 still ran.
    expect(analyseContracts).toHaveBeenCalled();
  });

  it('a postAlert that itself fails still does not break the tick', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv({ kod: '1440', namn: 'Ale', email: 'kansli@ale.se', thread: 'thr-ale' });

    const slackOps = fakeSlackOps();
    slackOps.postEscalation = vi.fn(async () => { throw new Error('slack 500'); });
    slackOps.postAlert = vi.fn(async () => { throw new Error('slack still down'); });

    const gmail = fakeGmail({
      listResult: [{ id: 'm-ale' }],
      getResult: { 'm-ale': mkMsg('m-ale', 'thr-ale', 'K <kansli@ale.se>', 'Hej, kan du ringa mig?') },
    });
    const analyseContracts = vi.fn(async () => {});

    await expect(runTick({
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
      env, contractsDir, now: new Date('2026-06-24T12:00:00Z'),
      analyseContracts, log: () => {},
    })).resolves.toBeUndefined();

    expect(analyseContracts).toHaveBeenCalled();
  });
});
