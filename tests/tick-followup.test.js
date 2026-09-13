// Escalation invariant + follow-up loop (autopilot review H1, M1, M5, M9, M10, L4).
// runDailyFollowup previously had ZERO tests — this file is its contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick, runDailyFollowup, followupCatchUpDue, followupHourFromCron, localDateStr } from '../src/tick.js';
import { effectiveFollowUp, nudgeJitterDays } from '../src/conversation.js';
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
    posts: [], updates: [], alerts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a', channel: 'C1' }; }),
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

// runDailyFollowup only drafts staleness nudges when ingest is healthy — a
// blind daemon must not claim "we have heard nothing". Every case in this file
// is about the staleness rules, so simulate a daemon that ticked cleanly five
// minutes before the simulated `now`.
function seedHealthyTick(now) {
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(now.getTime() - 5 * 60000).toISOString());
}

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), now = new Date('2026-06-24T12:00:00Z'), analyseContracts } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
    env, contractsDir, now, analyseContracts,
    // Hermetic auto-send kill switch: point the loader at a path that does not
    // exist inside this test's temp dir so it returns [] (fully manual). Left
    // undefined, loadAutoSendTemplates falls back to the CWD-relative
    // committed data/pilot-overrides.json — this suite would start auto-sending
    // into its fakes the day that file gains the key.
    overridesPath: join(tmp, 'no-overrides.json'),
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
  it('drafts T_FOLLOWUP_NUDGE for a SENT conversation stale past the 9–15-day jittered threshold', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' }); // 23 days — past the jitter ceiling
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps }));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_NUDGE');
    // The draft is written now but sent by a human, possibly days later, so it
    // must not claim elapsed time. No outbound message is seeded here, so there
    // is no send date to cite either: it omits the reference rather than guess.
    expect(escs[0].draft_body).not.toMatch(/dagar sedan/);
    expect(escs[0].draft_body).toMatch(/min begäran om allmänna handlingar\./);
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
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
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

// The staleness rule is jittered per conversation (2026-08-17 auto-send
// design), but that only helps if runDailyFollowup actually FEEDS the
// conversation's id to staleAction. Every other seed in this file sits past the
// 15-day ceiling, where wired and unwired behave identically — these two cases
// live inside the 9–15-day window, where they diverge: drop the
// `nudgeJitterDays(conv.id)` argument in tick.js and both fail.
describe('runDailyFollowup feeds each conversation its own jitter', () => {
  const stateChangedAt = '2026-06-15T00:00:00Z';
  // Noon-ish offset so daysBetween's floor lands on exactly `n`.
  const dayN = (n) => new Date(Date.parse(stateChangedAt) + n * 86400000 + 9 * 3600000);

  it('at exactly 9 stale days only the zero-jitter conversations are nudged', async () => {
    const ids = ['central', 'utbildning', 'teknik', 'kultur', 'social', 'miljo']
      .map((role) => seedConv({ role, stateChangedAt }));
    const jitters = ids.map(nudgeJitterDays);
    // Guard: without a spread of jitters this case could pass unwired.
    expect(jitters).toContain(0);
    expect(jitters.some((j) => j > 0)).toBe(true);

    await runDailyFollowup(deps({ now: dayN(9) }));

    for (const id of ids) {
      // 9 days is the base threshold: the jittered ones are not due yet.
      expect(db.listOpenEscalationsForConversation(id)).toHaveLength(nudgeJitterDays(id) === 0 ? 1 : 0);
    }
  });

  it('a jittered conversation waits until 9 + its own jitter, then nudges', async () => {
    seedConv({ role: 'central', stateChangedAt });          // takes the id whose jitter is 0
    const id = seedConv({ role: 'utbildning', stateChangedAt });
    const jitter = nudgeJitterDays(id);
    expect(jitter).toBeGreaterThan(0);                       // else this case proves nothing

    await runDailyFollowup(deps({ now: dayN(9 + jitter - 1) }));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);

    await runDailyFollowup(deps({ now: dayN(9 + jitter) }));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_NUDGE');
  });
});

describe('active (non-terminal) escalations gate new drafts (hardening findings 2/3)', () => {
  it('a send_failed escalation blocks the daily follow-up from minting a new draft', async () => {
    // A Gmail error after Gmail MAY have accepted parks the escalation as
    // send_failed. Until a human verifies in Sent, a fresh nudge draft could
    // double-message the kommun.
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' }); // stale past the jitter ceiling
    const escId = db.recordEscalation({
      conversation_id: id, message_id: null, reason: 'r',
      draft_template: 'T_RECEIPT', draft_subject: 's', draft_body: 'b',
    });
    db.resolveEscalation(escId, { status: 'send_failed', resolved_text: 'send error: socket hang up' });

    await runDailyFollowup(deps());

    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1); // nothing new
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('send_failed');
  });

  it('an in-flight sending escalation defers the daily follow-up and is never superseded', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
    const escId = db.recordEscalation({
      conversation_id: id, message_id: null, reason: 'r',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 's', draft_body: 'b',
    });
    expect(db.claimEscalationForSending(escId)).toBe(true); // another surface is mid-Gmail-call

    await runDailyFollowup(deps());

    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('sending');
  });

  it('an inbound-triggered draft is deferred while a sending escalation is in flight (never superseded)', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv({ state: 'SENT' });
    const escId = db.recordEscalation({
      conversation_id: id, message_id: null, reason: 'r',
      draft_template: 'T_RECEIPT', draft_subject: 's', draft_body: 'b',
    });
    expect(db.claimEscalationForSending(escId)).toBe(true);

    // Inbound "unknown" reply that would normally mint a free_form draft.
    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'in-race' }],
      getResult: {
        'in-race': {
          id: 'in-race', threadId: 'thr-a',
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

    expect(db.hasGmailMessageId('in-race')).toBe(true); // the inbound is still ingested
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1); // draft deferred
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(escId).status).toBe('sending');
    expect(slackOps.posts).toHaveLength(0);
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

  it('isCloserText: present-tense declaratives the old broad regex caught still close (finding 8)', () => {
    expect(isCloserText('Detta är samtliga avtal vi har.')).toBe(true);
    expect(isCloserText('Dessa är samtliga avtal inom det efterfrågade området.')).toBe(true);
    expect(isCloserText('Det här är samtliga avtal.')).toBe(true);
    expect(isCloserText('Bifogat var samtliga avtal.')).toBe(true);
    expect(isCloserText('Vi har inga ytterligare avtal.')).toBe(true);
    // …while the UNQUOTED question form still never closes a case.
    expect(isCloserText('Är detta samtliga avtal eller är fler på väg?')).toBe(false);
  });

  it('LLM analysis null + "Detta är samtliga avtal" closes the DELIVERING case, no later nudge (finding 8)', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null); // API error → regex path
    const id = seedConv({ state: 'DELIVERING', receiptSent: 1, followUpAt: '2026-07-07' });
    const gmail = fakeGmail({
      listResult: [{ id: 'close-1' }],
      getResult: {
        'close-1': {
          id: 'close-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV' },
            ],
            mimeType: 'text/plain', body: { data: b64('Detta är samtliga avtal vi har.') },
          },
        },
      },
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();

    const conv = db.getConversation(id);
    expect(conv.state).toBe('DONE');
    expect(conv.follow_up_at).toBe(null);

    // A month later the daily loop still leaves the closed case alone.
    await runDailyFollowup(deps({ now: new Date('2026-07-30T09:00:00Z') }));
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(0);
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

// D1 — a follow-up SKIPPED because ingest was blind at 09:00 must not cost a
// whole day of nudges. The gate itself is right (we must not claim silence we
// have not verified) but the cron fires once: a 61-minute gap straddling 09:00
// silenced nudges, closes and nudge-cap escalations until the next morning.
describe('daily follow-up catch-up after a blind 09:00', () => {
  function blindDeps(now, minutesAgo = 90) {
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
      .run(new Date(now.getTime() - minutesAgo * 60000).toISOString());
    return {
      db, gmailClient: { gmail: {} }, gmailOps: fakeGmail(), slackClient: {},
      slackOps: fakeSlackOps(), env, contractsDir, now,
    };
  }

  it('does not mark the day complete when the ingest gate skips it', async () => {
    seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
    const nine = new Date('2026-06-24T09:00:00');
    await runDailyFollowup(blindDeps(nine));
    expect(db.listOpenEscalations()).toHaveLength(0);
    expect(db.getFollowupCompletedDate()).toBeNull();
    expect(followupCatchUpDue({ now: nine, completedDate: null })).toBe(true);
  });

  it('a healthy tick later the same day runs it — once', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
    await runDailyFollowup(blindDeps(new Date('2026-06-24T09:00:00')));

    // 10:15, ingest recovered.
    const later = new Date('2026-06-24T10:15:00');
    expect(followupCatchUpDue({ now: later, completedDate: db.getFollowupCompletedDate() })).toBe(true);
    await runDailyFollowup(deps({ now: later }));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
    expect(db.getFollowupCompletedDate()).toBe(localDateStr(later));

    // Already completed → no second run for the rest of the day.
    const evening = new Date('2026-06-24T18:00:00');
    expect(followupCatchUpDue({ now: evening, completedDate: db.getFollowupCompletedDate() })).toBe(false);
  });

  it('a still-blind daemon at the later tick is still skipped — the gate stays authoritative', async () => {
    seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
    await runDailyFollowup(blindDeps(new Date('2026-06-24T09:00:00')));
    const later = new Date('2026-06-24T10:15:00');
    await runDailyFollowup(blindDeps(later));
    expect(db.listOpenEscalations()).toHaveLength(0);
    expect(db.getFollowupCompletedDate()).toBeNull();
    // …and it keeps asking, so the day is caught up the moment ingest returns.
    expect(followupCatchUpDue({ now: later, completedDate: null })).toBe(true);
  });

  it('never runs before the cron hour, and a completed yesterday does not count as today', () => {
    expect(followupCatchUpDue({ now: new Date('2026-06-24T07:30:00'), completedDate: '2026-06-23' })).toBe(false);
    const nine = new Date('2026-06-24T09:00:00');
    expect(followupCatchUpDue({ now: nine, completedDate: '2026-06-23' })).toBe(true);
    expect(followupCatchUpDue({ now: nine, completedDate: '2026-06-24' })).toBe(false);
  });

  it('reads the boundary hour off the configured cron, falling back to 09', () => {
    expect(followupHourFromCron('0 9 * * *')).toBe(9);
    expect(followupHourFromCron('30 6 * * *')).toBe(6);
    expect(followupHourFromCron(undefined)).toBe(9);
    expect(followupHourFromCron('nonsense')).toBe(9);
  });

  it('a vacation-paused run still counts as completed — the decision WAS made', async () => {
    seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' });
    const now = new Date('2026-06-24T09:00:00');
    await runDailyFollowup({
      ...deps({ now }),
      vacationConfig: { enabled: true, start: '06-20', end: '08-01' },
    });
    expect(db.listOpenEscalations()).toHaveLength(0);
    expect(db.getFollowupCompletedDate()).toBe(localDateStr(now));
  });
});

describe('hänvisning nag digest (2026-09-06 design)', () => {
  function seedPendingTask({ ageDays = 3, now = new Date('2026-09-11T09:00:00Z') } = {}) {
    const convId = db.createConversation({
      kommun_kod: '1460', kommun_namn: 'Bengtsfors', role: 'central',
      contact_email: 'kommun@bengtsfors.se', scheduled_send_at: '2026-08-01T08:00:00Z',
    });
    const msgId = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'nag-m', direction: 'inbound',
      from_email: 'kommun@bengtsfors.se', to_email: 'x', subject: 's', body_text: 'kontakta helen',
      received_at: '2026-08-14T07:53:00Z', attachment_count: 0,
    });
    const t = db.upsertHandoffTask({
      kommun_kod: '1460', address: 'helen.pettersson@amal.se',
      source_conversation_id: convId, source_message_id: msgId, verbatim: 1, same_domain: 0,
    });
    const created = new Date(now.getTime() - ageDays * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    db.raw.prepare('UPDATE handoff_tasks SET created_at = ? WHERE id = ?').run(created, t.id);
    return t.id;
  }

  it('posts ONE digest line for old pending tasks and stamps last_nag_at only on success', async () => {
    seedPendingTask();
    const slackOps = fakeSlackOps();
    const now = new Date('2026-09-11T09:00:00Z');
    await runDailyFollowup(deps({ slackOps, now }));
    const nags = slackOps.alerts.filter((t) => t.includes('hänvisning'));
    expect(nags).toHaveLength(1);
    expect(nags[0]).toContain('Bengtsfors → helen.pettersson@amal.se (3 d)');
    // Re-run same day → throttled by last_nag_at.
    await runDailyFollowup(deps({ slackOps, now }));
    expect(slackOps.alerts.filter((t) => t.includes('hänvisning'))).toHaveLength(1);
  });

  it('a failed Slack post does not stamp last_nag_at (retry on a later run)', async () => {
    const id = seedPendingTask();
    const slackOps = fakeSlackOps();
    slackOps.postAlert = vi.fn(async () => { throw new Error('slack down'); });
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-11T09:00:00Z') }));
    const row = db.raw.prepare('SELECT last_nag_at FROM handoff_tasks WHERE id = ?').get(id);
    expect(row.last_nag_at).toBeNull();
  });

  it('a fresh task (< 2 days) is not nagged', async () => {
    seedPendingTask({ ageDays: 1 });
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-11T09:00:00Z') }));
    expect(slackOps.alerts.filter((t) => t.includes('hänvisning'))).toHaveLength(0);
  });
});

describe('queue hygiene digest (2026-09-12 design)', () => {
  function seedQueueHygieneCases() {
    const convA = db.createConversation({ kommun_kod: '0001', kommun_namn: 'Gammal', role: 'central', contact_email: 'a@a.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const escA = db.recordEscalation({ conversation_id: convA, reason: 'r' });
    db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(escA);
    const convB = db.createConversation({ kommun_kod: '0002', kommun_namn: 'Frist', role: 'central', contact_email: 'b@b.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: convB, reason: 'r', respond_by: '2026-09-13' });
    const convC = db.createConversation({ kommun_kod: '0003', kommun_namn: 'Föräldralös', role: 'central', contact_email: 'c@c.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.updateConversationState(convC, 'NEEDS_HUMAN');
  }

  it('posts one digest naming due deadlines, aged drafts, and orphaned NEEDS_HUMAN', async () => {
    seedQueueHygieneCases();
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(digest).toContain('⏰');
    expect(digest).toContain('🕰');
    expect(digest).toContain('🧭');
  });

  it('posts nothing when the queue is healthy', async () => {
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    expect(slackOps.alerts.find((t) => t.includes('Köhälsa'))).toBeUndefined();
  });

  it('still posts while ingest is blind (Gmail-free, DB-only) — but still sends no nudges', async () => {
    seedQueueHygieneCases();
    const nudgeConvId = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' }); // far past the nudge threshold
    const slackOps = fakeSlackOps();
    const now = new Date('2026-09-12T09:00:00Z');
    const d = deps({ slackOps, now });
    // Force ingest to look blind (mirrors tests/tick-health.test.js): last
    // successful tick well past TICK_STALE_THRESHOLD_MIN before `now`.
    db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
      .run(new Date(now.getTime() - 3 * 24 * 60 * 60000).toISOString());
    const lines = [];
    await runDailyFollowup({ ...d, log: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes('FOLLOWUP paused'))).toBe(true);
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(digest).toContain('⏰');
    expect(digest).toContain('🕰');
    expect(digest).toContain('🧭');
    // Existing behavior preserved: a blind tick still drafts no staleness nudge.
    expect(db.listOpenEscalationsForConversation(nudgeConvId)).toHaveLength(0);
  });

  // Round-2 finding F2: the void path leaves a NEEDS_HUMAN case with no open
  // escalation, so its frist is invisible to every deadline reader. The digest
  // must name it in BOTH the deadline section (marked "utan utkast", there is
  // nothing to approve) and the orphan section (with the date).
  it('an orphaned NEEDS_HUMAN case with a due deadline appears in both sections, dated', async () => {
    const cid = db.createConversation({ kommun_kod: '0009', kommun_namn: 'Karlstad', role: 'central', contact_email: 'k@k.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-1', direction: 'inbound',
      from_email: 'k@k.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.split('🧭')[0];
    expect(deadlineSection).toContain('Karlstad');
    expect(deadlineSection).toContain('utan utkast');
    expect(deadlineSection).toContain('2026-09-13');
    // listed exactly once in the deadline section
    expect(deadlineSection.match(/Karlstad/g)).toHaveLength(1);
    const orphanSection = digest.slice(digest.indexOf('🧭'));
    expect(orphanSection).toContain('Karlstad (senast 2026-09-13)');
  });

  it('an orphan with no deadline is named without a date and stays out of the deadline section', async () => {
    const cid = db.createConversation({ kommun_kod: '0010', kommun_namn: 'Avesta', role: 'central', contact_email: 'a@a.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toContain('Avesta');
    expect(digest).not.toContain('Avesta (senast');
    expect(digest).not.toContain('⏰');
  });

  // Final-review finding 2 (2026-09-12): due/orphans were the only two lists
  // in this digest NOT capped at DIGEST_MAX_LINES. postAlert puts the whole
  // text in one Slack section block (3000-char cap); an uncapped list can
  // overflow it, Slack rejects with invalid_blocks, and the try/catch
  // swallows it silently.
  it('caps orphans at DIGEST_MAX_LINES and reports the full count plus an "…och N till" tail', async () => {
    for (let i = 0; i < 25; i++) {
      const cid = db.createConversation({
        kommun_kod: String(1000 + i), kommun_namn: `Orphan${i}`, role: 'central',
        contact_email: `o${i}@o.se`, scheduled_send_at: '2026-08-01T08:00:00Z',
      });
      db.updateConversationState(cid, 'NEEDS_HUMAN');
    }
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(digest).toContain('(25)');
    expect(digest).toContain('…och 5 till');
  });
});
