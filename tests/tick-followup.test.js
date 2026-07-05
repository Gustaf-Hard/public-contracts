// Escalation invariant + follow-up loop (autopilot review H1, M1, M5, M9, M10, L4).
// runDailyFollowup previously had ZERO tests — this file is its contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick, runDailyFollowup } from '../src/tick.js';
import { effectiveFollowUp } from '../src/conversation.js';
import { stripQuotedText, isCloserText } from '../src/classifier.js';
import { storeContractAnalysis } from '../src/analyse-contract.js';
import * as analyseMod from '../src/analyse-message.js';

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-followup-'));
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

function fakeSlackOps() {
  return {
    posts: [], updates: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async function (slack, args) { this.updates.push(args); }),
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

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), now = new Date('2026-06-24T12:00:00Z'), analyseContracts } = {}) {
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
    env, contractsDir, now, analyseContracts,
  };
}

function seedConv({ state = 'SENT', stateChangedAt = null, followupCount = 0, followUpAt = null, receiptSent = 0, thread = 'thr-a', role = 'central' } = {}) {
  const id = db.createConversation({
    kommun_kod: '1440', kommun_namn: 'Ale', role,
    contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: thread, last_outbound_at: '2026-06-10T10:00:00Z',
    followup_count: followupCount, follow_up_at: followUpAt, receipt_sent: receiptSent,
  });
  if (stateChangedAt) {
    db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  }
  return id;
}

describe('runDailyFollowup — staleness drafting (M1: previously untested)', () => {
  it('drafts T_FOLLOWUP_NUDGE for a SENT conversation stale ≥7 days', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-14T00:00:00Z' }); // 10 days
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps }));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_NUDGE');
    expect(escs[0].draft_body).toMatch(/10 dagar/);
    expect(escs[0].previous_state).toBe('SENT');
    expect(slackOps.posts).toHaveLength(1);
  });

  it('does nothing before the stale threshold or while a kommun promise is live', async () => {
    seedConv({ stateChangedAt: '2026-06-20T00:00:00Z' }); // 4 days — fresh
    seedConv({ role: 'utbildning', stateChangedAt: '2026-06-01T00:00:00Z', followUpAt: '2026-07-01' }); // promised
    await runDailyFollowup(deps());
    expect(db.listOpenEscalations()).toHaveLength(0);
  });

  it('escalates free_form after MAX nudges', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z', followupCount: 2 });
    await runDailyFollowup(deps());
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
    expect(escs[0].reason).toMatch(/2 nudges already sent/);
  });

  it('never mints a duplicate draft while one is already open (H1) — day after day', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-10T00:00:00Z' });
    await runDailyFollowup(deps({ now: new Date('2026-06-24T09:00:00Z') }));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
    // The next three daily runs go by unapproved — still exactly one.
    for (const day of ['25', '26', '27']) {
      await runDailyFollowup(deps({ now: new Date(`2026-06-${day}T09:00:00Z`) }));
    }
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1);
  });
});

describe('escalateWithDraft — at most one open escalation per conversation (H1)', () => {
  it('a fresher inbound-triggered escalation supersedes the open one and strips its buttons', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv({ state: 'SENT' });
    // A stale open escalation from an earlier nudge, with a Slack message.
    const oldEsc = db.recordEscalation({
      conversation_id: id, message_id: null, reason: 'old nudge',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 's', draft_body: 'b',
      slack_ts: 'old-ts',
    });

    // Inbound "unknown" reply → new free_form escalation.
    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'in-1' }],
      getResult: {
        'in-1': {
          id: 'in-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV' },
            ],
            mimeType: 'text/plain', body: { data: b64('Hej, kan du ringa mig?') },
          },
        },
      },
    });
    await runTick(deps({ gmail, slackOps }));
    spy.mockRestore();

    const open = db.listOpenEscalationsForConversation(id);
    expect(open).toHaveLength(1); // THE invariant
    expect(open[0].id).not.toBe(oldEsc);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(oldEsc).status).toBe('superseded');
    expect(slackOps.updates).toHaveLength(1);
    expect(slackOps.updates[0].ts).toBe('old-ts');
    expect(slackOps.updates[0].status).toBe('superseded');
  });
});

describe('watchlist reachable after the first receipt (M5)', () => {
  it('a second delivery naming Binogi is held (free_form + flag) even though receipt_sent=1', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
      intent: 'delivery', confidence: 0.9, summary: 'Fler avtal bifogade.',
      suggested_action: 'send_receipt', is_final_delivery: false,
      draft_reply: 'Tack!', follow_up_at: null, extracted: {},
    });
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1 });

    const msg = {
      id: 'del-2', threadId: 'thr-a',
      payload: {
        headers: [
          { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
          { name: 'Subject', value: 'Fler avtal' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Här kommer resterande avtal.') } },
          { mimeType: 'application/pdf', filename: 'Binogi-avtal.pdf', body: { attachmentId: 'att-1', size: 9 } },
        ],
      },
    };
    const analyseContracts = async ({ db: d, onlyMessageId }) => {
      const atts = d.raw.prepare('SELECT id FROM attachments WHERE message_id = ?').all(onlyMessageId);
      for (const a of atts) {
        storeContractAnalysis(d, a.id, {
          is_contract: true, document_type: 'avtal', vendor_name: 'Binogi',
          products: [], avtalsvarde: null, valuta: null, period_start: null, period_end: null,
          summary: 'avtal', confidence: 0.9, mentioned_agreements: [],
        }, { model: 'test' });
      }
      return atts.length;
    };

    const slackOps = fakeSlackOps();
    await runTick(deps({
      gmail: fakeGmail({ listResult: [{ id: 'del-2' }], getResult: { 'del-2': msg } }),
      slackOps, analyseContracts,
    }));
    spy.mockRestore();

    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
    expect(JSON.parse(escs[0].watchlist_vendors)).toEqual(['Binogi']);
    expect(escs[0].reason).toMatch(/BEVAKAD LEVERANTÖR/);
  });

  it('a second delivery with only unwatched vendors still draws no escalation', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
      intent: 'delivery', confidence: 0.9, summary: 'Fler avtal.',
      suggested_action: 'send_receipt', is_final_delivery: false,
      draft_reply: 'Tack!', follow_up_at: null, extracted: {},
    });
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1 });
    const msg = {
      id: 'del-3', threadId: 'thr-a',
      payload: {
        headers: [
          { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
          { name: 'Subject', value: 'Fler avtal' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Här kommer resterande avtal.') } },
          { mimeType: 'application/pdf', filename: 'Skolon.pdf', body: { attachmentId: 'att-1', size: 9 } },
        ],
      },
    };
    const analyseContracts = async ({ db: d, onlyMessageId }) => {
      if (onlyMessageId == null) return 0;
      const atts = d.raw.prepare('SELECT id FROM attachments WHERE message_id = ?').all(onlyMessageId);
      for (const a of atts) {
        storeContractAnalysis(d, a.id, {
          is_contract: true, document_type: 'avtal', vendor_name: 'Skolon',
          products: [], avtalsvarde: null, valuta: null, period_start: null, period_end: null,
          summary: 'avtal', confidence: 0.9, mentioned_agreements: [],
        }, { model: 'test' });
      }
      return atts.length;
    };
    await runTick(deps({
      gmail: fakeGmail({ listResult: [{ id: 'del-3' }], getResult: { 'del-3': msg } }),
      analyseContracts,
    }));
    spy.mockRestore();
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
  });
});

describe('the closer signal (M9)', () => {
  it('stripQuotedText removes >-quoted lines and Swedish reply blocks', () => {
    const body = [
      'Vi har inga sådana avtal.',
      '',
      'Den 24 juni 2026 kl. 10:00 skrev Gustaf Hård:',
      '> Är detta samtliga avtal eller är fler på väg?',
    ].join('\n');
    const stripped = stripQuotedText(body);
    expect(stripped).toContain('inga sådana avtal');
    expect(stripped).not.toContain('samtliga avtal');
  });

  it('isCloserText: a quoted receipt question never closes; an own declarative statement does', () => {
    expect(isCloserText('Nej tyvärr.\n> Är detta samtliga avtal eller är fler på väg?')).toBe(false);
    expect(isCloserText('Detta var samtliga avtal vi har att lämna ut.')).toBe(true);
    expect(isCloserText('Vi har inga fler avtal att lämna ut.')).toBe(true);
  });

  it('a dead_end reply in DELIVERING that merely quotes our receipt goes DEAD_END, not DONE', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null); // regex path
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1 });
    const body = 'Vi kan inte lämna ut fler handlingar, de finns inte hos oss.\n\n> Är detta samtliga avtal eller är fler på väg?';
    const gmail = fakeGmail({
      listResult: [{ id: 'q-1' }],
      getResult: {
        'q-1': {
          id: 'q-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV' },
            ],
            mimeType: 'text/plain', body: { data: b64(body) },
          },
        },
      },
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();
    expect(db.getConversation(id).state).toBe('DEAD_END'); // not silently DONE off our own text
  });

  it('the LLM is_final_delivery=true closes a DELIVERING case on dead_end', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
      intent: 'dead_end', confidence: 0.9, summary: 'Bekräftar att allt är utlämnat.',
      suggested_action: 'wait', is_final_delivery: true,
      draft_reply: 'Tack!', follow_up_at: null, extracted: {},
    });
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1, followUpAt: '2026-07-07' });
    const gmail = fakeGmail({
      listResult: [{ id: 'c-1' }],
      getResult: {
        'c-1': {
          id: 'c-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV' },
            ],
            mimeType: 'text/plain', body: { data: b64('Det var samtliga avtal.') },
          },
        },
      },
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();
    const conv = db.getConversation(id);
    expect(conv.state).toBe('DONE');
    expect(conv.follow_up_at).toBe(null); // M10: cleared on close
  });
});

describe('terminal states show no live follow-up (M10)', () => {
  it('effectiveFollowUp returns none for DONE even with a lingering follow_up_at', () => {
    expect(effectiveFollowUp({
      state: 'DONE', follow_up_at: '2026-07-07', state_changed_at: '2026-06-20T00:00:00Z',
    })).toEqual({ date: null, source: null });
  });
});

describe('clarification while DELIVERING gets a draft (L4)', () => {
  it('escalates with a precision draft instead of silently swallowing the question', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
      intent: 'clarification', confidence: 0.9, summary: 'Fråga mitt i leveransen.',
      suggested_action: 'send_precision', is_final_delivery: false,
      draft_reply: 'Hej,\n\nJag avser perioden 2024–2026.\n\nMvh', follow_up_at: null,
      extracted: { questions: ['Vilken period?'] },
    });
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1 });
    const gmail = fakeGmail({
      listResult: [{ id: 'cl-1' }],
      getResult: {
        'cl-1': {
          id: 'cl-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV' },
            ],
            mimeType: 'text/plain', body: { data: b64('Vilken period avser begäran?') },
          },
        },
      },
    });
    const slackOps = fakeSlackOps();
    await runTick(deps({ gmail, slackOps }));
    spy.mockRestore();

    expect(db.getConversation(id).state).toBe('DELIVERING'); // still delivering
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_PRECISION');
    expect(escs[0].draft_body).toMatch(/2024–2026/); // LLM contextual draft preferred
  });
});
