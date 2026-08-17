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

    // A genuine dispatch failure: the escalation row itself cannot be written
    // for Ale. NOTHING is saved for that draft, so the alert must say exactly
    // that and send the operator to answer manually.
    const failingDb = {
      ...db,
      recordEscalation: (e) => {
        if (e.conversation_id === ale) throw new Error('db write blew up');
        return db.recordEscalation(e);
      },
    };

    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'm-ale' }, { id: 'm-boden' }],
      getResult: {
        'm-ale': mkMsg('m-ale', 'thr-ale', 'K <kansli@ale.se>', 'Hej, kan du ringa mig?', { internalDate: '2026-06-24T09:00:00.000Z' }),
        'm-boden': mkMsg('m-boden', 'thr-boden', 'K <kommun@boden.se>', 'Hej, kan du ringa mig?', { internalDate: '2026-06-24T10:00:00.000Z' }),
      },
    });
    const analyseContracts = vi.fn(async () => {});

    await runTick({
      db: failingDb, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
      env, contractsDir, now: new Date('2026-06-24T12:00:00Z'),
      analyseContracts, log: () => {},
    });
    spy.mockRestore();

    // Both messages were committed before dispatch ran, so neither is lost.
    expect(db.raw.prepare('SELECT COUNT(*) n FROM messages WHERE direction=?').get('inbound').n).toBe(2);
    // The second conversation still got its draft + Slack post.
    expect(db.listOpenEscalationsForConversation(boden)).toHaveLength(1);
    expect(slackOps.posts).toHaveLength(1);
    // The operator is told WHICH message dropped — it will never be retried.
    const alert = slackOps.alerts.find((t) => t.includes('m-ale'));
    expect(alert).toBeDefined();
    expect(alert).toContain('Ale');
    // No escalation row exists, so the alert must NOT promise a saved draft.
    expect(db.listOpenEscalationsForConversation(ale)).toHaveLength(0);
    expect(alert).toContain('inget utkast finns');
    // Step 3 still ran.
    expect(analyseContracts).toHaveBeenCalled();
  });

  // D6: postEscalation used to be the only unguarded Slack call, and it sits
  // AFTER recordEscalation. A Slack outage therefore threw with the row already
  // written — and the alert then told the operator the draft was lost and to
  // answer manually, which hasActiveEscalation blocks.
  it('keeps the draft when Slack is down: escalation stays open with no slack_ts, and no "answer manually" alert', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const ale = seedConv({ kod: '1440', namn: 'Ale', email: 'kansli@ale.se', thread: 'thr-ale' });

    const slackOps = fakeSlackOps();
    slackOps.postEscalation = vi.fn(async () => { throw new Error('slack 500'); });

    const gmail = fakeGmail({
      listResult: [{ id: 'm-ale' }],
      getResult: { 'm-ale': mkMsg('m-ale', 'thr-ale', 'K <kansli@ale.se>', 'Hej, kan du ringa mig?') },
    });
    const analyseContracts = vi.fn(async () => {});
    const deps = {
      db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
      env, contractsDir, now: new Date('2026-06-24T12:00:00Z'),
      analyseContracts, log: () => {},
    };

    await runTick(deps);

    const open = db.listOpenEscalationsForConversation(ale);
    expect(open).toHaveLength(1);
    expect(open[0].slack_ts).toBeNull();
    // Nothing claiming the draft is lost.
    expect(slackOps.alerts.some((t) => t.includes('svara manuellt'))).toBe(false);
    expect(analyseContracts).toHaveBeenCalled();

    // Next tick with Slack healthy: the buttons come back, on the SAME
    // escalation — no duplicate is created.
    const healthy = fakeSlackOps();
    await runTick({ ...deps, slackOps: healthy, gmailOps: fakeGmail({ listResult: [] }) });
    spy.mockRestore();

    const after = db.listOpenEscalationsForConversation(ale);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(open[0].id);
    expect(after[0].slack_ts).toBe('s-1');
    expect(healthy.posts).toHaveLength(1);
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

// retryUnpostedEscalations restores buttons for Slack-outage orphans — but the
// live DB also carries open/slack_ts-NULL rows from OTHER producers (dashboard
// replies refused before the claim, escalations minted before SLACK_CHANNEL_ID
// existed). Those must NOT resurface in Slack with live Approve buttons.
describe('retryUnpostedEscalations — bounds', () => {
  function mkDeps(slackOps) {
    return {
      db, gmailClient: { gmail: {} }, gmailOps: fakeGmail({ listResult: [] }),
      slackClient: {}, slackOps, env, contractsDir, now: new Date(),
      analyseContracts: vi.fn(async () => {}), log: () => {},
    };
  }

  it('does not re-post an escalation older than the age bound', async () => {
    const id = seedConv();
    const escId = db.recordEscalation({
      conversation_id: id, reason: 'old draft', draft_template: 'T_FOLLOWUP_NUDGE',
      draft_subject: 'Påminnelse', draft_body: 'Har ni hunnit titta på detta?',
    });
    db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-30 days') WHERE id = ?").run(escId);

    const slackOps = fakeSlackOps();
    await runTick(mkDeps(slackOps));

    expect(slackOps.posts).toHaveLength(0);
    const esc = db.raw.prepare('SELECT slack_ts, status FROM escalations WHERE id = ?').get(escId);
    expect(esc.slack_ts).toBeNull(); // stays dashboard-only
    expect(esc.status).toBe('open');
  });

  it('a recent orphan IS re-posted (the age bound does not block outage healing)', async () => {
    const id = seedConv();
    const escId = db.recordEscalation({
      conversation_id: id, reason: 'slack was down', draft_template: 'T_RECEIPT',
      draft_subject: 'Re: Svar', draft_body: 'Tack för handlingarna.',
    });

    const slackOps = fakeSlackOps();
    await runTick(mkDeps(slackOps));

    expect(slackOps.posts).toHaveLength(1);
    expect(db.raw.prepare('SELECT slack_ts FROM escalations WHERE id = ?').get(escId).slack_ts).toBe('s-1');
  });

  it('the per-tick cap bounds Slack API calls, not successes — a ts-less response cannot flood', async () => {
    for (let i = 0; i < 8; i += 1) {
      const id = seedConv({ kod: String(1500 + i), namn: `K${i}`, email: `k${i}@k${i}.se`, thread: `thr-${i}` });
      db.recordEscalation({
        conversation_id: id, reason: 'orphan', draft_template: 'T_RECEIPT',
        draft_subject: 'Re: Svar', draft_body: 'Tack.',
      });
    }

    // Resolves without a ts (never happens with @slack/web-api, but the cap
    // must bound calls even then — slack_ts stays NULL so it retries forever).
    const slackOps = fakeSlackOps({ postEscalation: vi.fn(async () => ({})) });
    await runTick(mkDeps(slackOps));

    expect(slackOps.postEscalation).toHaveBeenCalledTimes(5);
  });
});
