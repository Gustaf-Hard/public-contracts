// Archive-on-ingest (2026-07-20 design): after a matched inbound is committed,
// drop the INBOX label from its Gmail thread (best-effort, after commit).
// Unmatched/ambiguous mail is NEVER archived. Config flag can turn it off.
// Plus the one-time backfill helper archiveTrackedThreads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick, archiveTrackedThreads } from '../src/tick.js';
import * as analyseMod from '../src/analyse-message.js';

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-archive-'));
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

function mkMsg(id, threadId, from, body, { subject = 's', internalDate } = {}) {
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
    fetchAttachment: opts.fetchAttachment ?? vi.fn(async () => Buffer.from('%PDF-1.4')),
  };
}

function fakeSlackOps() {
  return {
    posts: [], alerts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a', channel: 'C1' }; }),
  };
}

function deps(extra = {}) {
  return {
    db, gmailClient: { gmail: { GMAIL: 'client' } }, gmailOps: extra.gmail, slackClient: {},
    slackOps: extra.slackOps ?? fakeSlackOps(),
    env, contractsDir, now: extra.now ?? new Date('2026-06-24T12:00:00Z'),
    seenUnmatched: extra.seenUnmatched,
    analyseContracts: extra.analyseContracts,
    archiveThreadImpl: extra.archiveThreadImpl,
    archiveOnIngest: extra.archiveOnIngest,
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

describe('runTick — archive matched inbound after commit', () => {
  it('archives the thread exactly once with the message thread id; the DB row exists BEFORE the archive call', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv();
    const archiveThreadImpl = vi.fn(async (gmail, threadId) => {
      // At archive time, the message must already be recorded (after commit).
      expect(db.hasGmailMessageId('m1')).toBe(true);
      expect(gmail).toEqual({ GMAIL: 'client' }); // the injected gmail client
      expect(threadId).toBe('thr-a');
    });
    const gmail = fakeGmail({
      listResult: [{ id: 'm1' }],
      getResult: { 'm1': mkMsg('m1', 'thr-a', 'K <kansli@ale.se>', 'Ärendenummer: K1440001') },
    });
    await runTick(deps({ gmail, archiveThreadImpl }));
    spy.mockRestore();

    expect(archiveThreadImpl).toHaveBeenCalledTimes(1);
    expect(archiveThreadImpl).toHaveBeenCalledWith({ GMAIL: 'client' }, 'thr-a');
  });

  it('does NOT archive an unmatched message — it stays in the inbox for the digest', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv();
    const archiveThreadImpl = vi.fn(async () => {});
    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'um-1' }],
      getResult: { 'um-1': mkMsg('um-1', 'thr-x', 'Okänd <reg@kommunalforbund.se>', 'Svar på er begäran') },
    });
    await runTick(deps({ gmail, slackOps, archiveThreadImpl }));
    spy.mockRestore();

    expect(db.hasGmailMessageId('um-1')).toBe(false);
    expect(archiveThreadImpl).not.toHaveBeenCalled();
    expect(slackOps.alerts).toHaveLength(1); // still digested
  });

  it('an archive failure never affects ingest — message stays recorded and the error is logged', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    const logs = [];
    const archiveThreadImpl = vi.fn(async () => { throw new Error('429 rate limit'); });
    const gmail = fakeGmail({
      listResult: [{ id: 'm1' }],
      getResult: { 'm1': mkMsg('m1', 'thr-a', 'K <kansli@ale.se>', 'Ärendenummer: K1440001') },
    });
    await expect(runTick({ ...deps({ gmail, archiveThreadImpl }), log: (s) => logs.push(s) }))
      .resolves.not.toThrow();
    spy.mockRestore();

    expect(db.hasGmailMessageId('m1')).toBe(true); // ingest succeeded
    expect(db.getConversation(id).state).toBe('ACK_RECEIVED');
    expect(archiveThreadImpl).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /archive failed for thread thr-a/.test(l))).toBe(true);
  });

  it('PILOT_ARCHIVE_ON_INGEST off → ingest never archives', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv();
    const archiveThreadImpl = vi.fn(async () => {});
    const gmail = fakeGmail({
      listResult: [{ id: 'm1' }],
      getResult: { 'm1': mkMsg('m1', 'thr-a', 'K <kansli@ale.se>', 'Ärendenummer: K1440001') },
    });
    await runTick(deps({ gmail, archiveThreadImpl, archiveOnIngest: false }));
    spy.mockRestore();

    expect(db.hasGmailMessageId('m1')).toBe(true); // still ingested
    expect(archiveThreadImpl).not.toHaveBeenCalled();
  });
});

describe('archiveTrackedThreads — one-time backfill', () => {
  it('archives each tracked thread once (primary + secondary threads), de-duplicated', async () => {
    const a = seedConv({ kod: '1440', namn: 'Ale', role: 'central', email: 'kansli@ale.se', thread: 'thr-a' });
    seedConv({ kod: '1441', namn: 'Alingsås', role: 'central', email: 'k@alingsas.se', thread: 'thr-b' });
    // A secondary thread on conversation A.
    db.upsertThread({ conversation_id: a, gmail_thread_id: 'thr-a2', counterparty_email: 'x@ale.se' });
    // A duplicate registration of the primary thread must not double-archive.
    db.upsertThread({ conversation_id: a, gmail_thread_id: 'thr-a', counterparty_email: 'kansli@ale.se' });

    const archived = [];
    const archiveThreadImpl = vi.fn(async (gmail, threadId) => { archived.push(threadId); });
    const count = await archiveTrackedThreads(db, { archiveThreadImpl, gmail: {} });

    expect(count).toBe(3);
    expect(archiveThreadImpl).toHaveBeenCalledTimes(3);
    expect(new Set(archived)).toEqual(new Set(['thr-a', 'thr-a2', 'thr-b']));
  });

  it('dryRun lists the thread ids without calling modify', async () => {
    seedConv({ thread: 'thr-a' });
    seedConv({ kod: '1441', namn: 'Alingsås', email: 'k@alingsas.se', thread: 'thr-b' });
    const archiveThreadImpl = vi.fn(async () => {});
    const logs = [];
    const count = await archiveTrackedThreads(db, { archiveThreadImpl, dryRun: true, log: (s) => logs.push(s) });

    expect(archiveThreadImpl).not.toHaveBeenCalled();
    expect(count).toBe(2);
    expect(logs.filter((l) => /DRY-RUN would archive/.test(l))).toHaveLength(2);
  });

  it('one thread failing does not abort the backfill (best-effort per thread)', async () => {
    seedConv({ thread: 'thr-a' });
    seedConv({ kod: '1441', namn: 'Alingsås', email: 'k@alingsas.se', thread: 'thr-b' });
    const archiveThreadImpl = vi.fn(async (gmail, threadId) => {
      if (threadId === 'thr-a') throw new Error('boom');
    });
    const count = await archiveTrackedThreads(db, { archiveThreadImpl, gmail: {} });
    expect(archiveThreadImpl).toHaveBeenCalledTimes(2);
    expect(count).toBe(1); // only the successful one counts
  });
});
