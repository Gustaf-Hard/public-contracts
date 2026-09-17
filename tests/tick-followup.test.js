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
import { postAlert as realPostAlert } from '../src/slack.js';

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

  it('escalates with a T_FOLLOWUP_FINAL draft after MAX nudges (2026-09-17) — never an empty placeholder', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z', followupCount: 2 });
    await runDailyFollowup(deps());
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_FINAL');
    expect(escs[0].reason).toMatch(/2 nudges already sent/);
    expect(escs[0].draft_body).toMatch(/skyndsamt/);
    expect(escs[0].draft_body).toMatch(/skriftligt beslut/);
    expect(escs[0].draft_body).not.toMatch(/ingen draft/);
    expect(escs[0].draft_subject).toMatch(/^Påminnelse: /);
  });

  // Rows minted before the template existed hold the literal placeholder.
  // The daily run heals them in place (guarded on status + exact body + the
  // after-nudges reason) so the operator never meets an empty box again.
  it('backfills an open placeholder after-nudges escalation with the T_FOLLOWUP_FINAL body, and nothing else', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z', followupCount: 2 });
    const placeholder = '(ingen draft — skriv själv via Edit)';
    const target = db.recordEscalation({
      conversation_id: id, message_id: null, reason: 'stale SENT for 15 days, 2 nudges already sent',
      draft_template: 'free_form', draft_subject: 'Re: Begäran om allmänna handlingar', draft_body: placeholder,
      previous_state: 'SENT',
    });
    // A watchlist placeholder (different reason) must stay as it is.
    const other = seedConv({ role: 'utbildning', stateChangedAt: '2026-06-20T00:00:00Z' });
    const untouched = db.recordEscalation({
      conversation_id: other, message_id: null, reason: '⚠️ BEVAKAD LEVERANTÖR: Radish | llm intent=delivery',
      draft_template: 'free_form', draft_subject: 'Re: x', draft_body: placeholder, previous_state: 'DELIVERING',
    });
    // A resolved placeholder row is history, not a draft.
    const resolvedConv = seedConv({ role: 'gymnasie', stateChangedAt: '2026-06-20T00:00:00Z' });
    const resolved = db.recordEscalation({
      conversation_id: resolvedConv, message_id: null, reason: 'stale SENT for 15 days, 2 nudges already sent',
      draft_template: 'free_form', draft_subject: 'Re: x', draft_body: placeholder, previous_state: 'SENT',
    });
    db.resolveEscalation(resolved, { status: 'resolved_skip' });

    await runDailyFollowup(deps());

    const row = (i) => db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(i);
    expect(row(target).draft_template).toBe('T_FOLLOWUP_FINAL');
    expect(row(target).draft_body).toMatch(/skyndsamt/);
    expect(row(target).draft_subject).toMatch(/^Påminnelse: /);
    expect(row(target).status).toBe('open');
    expect(row(untouched).draft_body).toBe(placeholder);
    expect(row(untouched).draft_template).toBe('free_form');
    expect(row(resolved).draft_body).toBe(placeholder);
    // Idempotent: no second open row was minted for the healed conversation.
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
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

// Round-6 K5: the ingest gate read `db.getTickHealth?.({ now }) ?? null`, so a
// db object without the method scored health === null and the follow-up sailed
// straight past the one check that stops it claiming silence it has not
// verified. CLAUDE.md states this call is unconditional and send-reply.js's
// STALE_INGEST guard already is: a safety check must not opt itself out on a db
// that lacks the method.
describe('the ingest gate calls getTickHealth unconditionally (round-6 K5)', () => {
  it('a db without getTickHealth fails the run instead of skipping the gate', async () => {
    const convId = seedConv({ stateChangedAt: '2026-06-01T00:00:00Z' }); // far past the nudge threshold
    const d = deps({});
    const blindDb = { ...db };
    delete blindDb.getTickHealth;
    await expect(runDailyFollowup({ ...d, db: blindDb })).rejects.toThrow(/getTickHealth/);
    // Fail closed: no staleness nudge was drafted for a conversation that would
    // otherwise have got one.
    expect(db.listOpenEscalationsForConversation(convId)).toHaveLength(0);
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

  // Round-7 L7: ⏰ names a case 'kommun/role' because one kommun can hold several
  // conversations (central, utbildning, ...), so the name alone does not say
  // which one needs a human. 🧭 printed the bare name.
  it('names the 🧭 cases kommun/role, the way ⏰ does', async () => {
    const convC = db.createConversation({ kommun_kod: '0003', kommun_namn: 'Föräldralös', role: 'utbildning', contact_email: 'c@c.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.updateConversationState(convC, 'NEEDS_HUMAN');
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toContain('🧭');
    expect(digest.split('🧭')[1]).toContain('Föräldralös/utbildning');
  });

  // Round-8 M5: 🕰 printed the bare kommun name while ⏰ and 🧭 both print
  // kommun/role. One kommun can hold several conversations (central,
  // utbildning, ...), so the name alone does not say which aged draft is meant.
  it('names the 🕰 cases kommun/role, the way ⏰ and 🧭 do', async () => {
    const cid = db.createConversation({ kommun_kod: '0005', kommun_namn: 'Gammal', role: 'utbildning', contact_email: 'g@g.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const escId = db.recordEscalation({ conversation_id: cid, reason: 'r', draft_template: 'free_form', draft_body: 'b' });
    db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(escId);
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toContain('🕰');
    // The age in days is relative to the real clock (created_at is seeded with
    // SQLite's datetime('now')), so the label shape is what matters here.
    expect(digest.split('🕰')[1]).toMatch(/Gammal\/utbildning \(\d+ d\)/);
  });

  it('keeps the deadline suffix on a 🧭 case that carries one', async () => {
    const cid = db.createConversation({ kommun_kod: '0004', kommun_namn: 'Frist', role: 'central', contact_email: 'd@d.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-frist', direction: 'inbound',
      from_email: 'd@d.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-10-01T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-10-20' } }),
    });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest.split('🧭')[1]).toContain('Frist/central (senast 2026-10-20)');
  });

  // Round-9 N1 (critical): the worst case is all three sections full — 20 + 20 +
  // 20 kommun/role labels — and that text does not fit in ONE Slack `section`
  // block (3000 chars), which makes Slack reject the ENTIRE message. The digest's
  // catch only logs, so the operator hears nothing at all about a queue that is
  // by definition in its worst state. postAlert now splits the text across
  // consecutive section blocks in one message; this test drives the real
  // postAlert with a fake Slack client so the assertion is on the blocks that
  // would actually go over the wire.
  it('posts a full three-section digest as one message whose every block fits the Slack limit', async () => {
    const nn = (i) => `Storstadskommunen Nummer ${String(i).padStart(2, '0')}`;
    const role = 'utbildningsforvaltning';
    for (let i = 0; i < 20; i += 1) {
      // ⏰: a dated draft, due today.
      const due = db.createConversation({ kommun_kod: String(6100 + i), kommun_namn: `Frist ${nn(i)}`, role, contact_email: `d${i}@d.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      db.recordEscalation({ conversation_id: due, reason: 'r', draft_template: 'free_form', draft_body: 'b', respond_by: '2026-09-13' });
      // 🕰: an undated draft older than 7 days (never due, so it stays in its own section).
      const aged = db.createConversation({ kommun_kod: String(6200 + i), kommun_namn: `Gammal ${nn(i)}`, role, contact_email: `g${i}@g.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      const escId = db.recordEscalation({ conversation_id: aged, reason: 'r', draft_template: 'free_form', draft_body: 'b' });
      db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(escId);
      // 🧭: NEEDS_HUMAN with nothing to approve and no deadline.
      const orphan = db.createConversation({ kommun_kod: String(6300 + i), kommun_namn: `Ensam ${nn(i)}`, role, contact_email: `o${i}@o.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
      db.updateConversationState(orphan, 'NEEDS_HUMAN');
    }

    const posted = [];
    // Round-10 O1: this fake drives the real postAlert with a low-level
    // chat.postMessage fake, so it gets the same Slack-shaped limit checks as
    // tests/slack.test.js's fake client — a regression that reintroduces the
    // full original string in `text` fails LOUD instead of passing silently.
    const slackOps = {
      ...fakeSlackOps(),
      postAlert: vi.fn(async (slack, args) => realPostAlert(
        {
          chat: {
            postMessage: async (m) => {
              if (m.text.length > 40000) throw new Error(`Slack text field exceeds 40000 chars (${m.text.length})`);
              for (const b of m.blocks) {
                if (b.text.text.length > 3000) throw new Error(`Slack section block exceeds 3000 chars (${b.text.text.length})`);
              }
              posted.push(m);
              return { ts: 'a', channel: m.channel };
            },
          },
        },
        args,
      )),
    };
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));

    const digest = posted.find((m) => m.text.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(posted.filter((m) => m.text.includes('Köhälsa'))).toHaveLength(1); // ONE message
    // The worst case really does exceed one block — otherwise this test proves nothing.
    expect(digest.blocks.length).toBeGreaterThan(1);
    expect(digest.blocks.length).toBeLessThanOrEqual(50);
    for (const b of digest.blocks) {
      expect(b.type).toBe('section');
      expect(b.text.text.length).toBeLessThanOrEqual(2900);
    }
    // O1: the notification fallback is the first block's text, bounded well
    // under the block cap, not the full multi-block digest.
    expect(digest.text.length).toBeLessThanOrEqual(2900);
    expect(digest.text).toBe(digest.blocks[0].text.text);
    // Nothing is lost, and no label is cut in half: every section's own lines
    // survive intact inside some block.
    const joined = digest.blocks.map((b) => b.text.text).join('\n');
    for (const marker of ['⏰', '🕰', '🧭']) expect(joined).toContain(marker);
    for (const label of [`Frist ${nn(0)}/${role} (senast 2026-09-13)`, `Ensam ${nn(0)}/${role}`]) {
      expect(digest.blocks.some((b) => b.text.text.includes(label))).toBe(true);
    }
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

  // Round-2 finding F6: one cap, one phrasing across all three sections.
  it('caps the aged-drafts list at DIGEST_MAX_LINES with the same "…och N till" tail', async () => {
    for (let i = 0; i < 25; i++) {
      const cid = db.createConversation({
        kommun_kod: String(3000 + i), kommun_namn: `Aged${i}`, role: 'central',
        contact_email: `a${i}@a.se`, scheduled_send_at: '2026-08-01T08:00:00Z',
      });
      const esc = db.recordEscalation({ conversation_id: cid, reason: 'r' });
      db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(esc);
    }
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    const agedSection = digest.slice(digest.indexOf('🕰'));
    expect(agedSection).toContain('(25)');
    expect(agedSection).toContain('…och 5 till');
    // Age digits are not asserted: the query filters on SQLite datetime('now')
    // while the display math uses the injected `now` (see the comment in tick.js).
    expect(agedSection).toContain('Aged0/central (');
    expect(agedSection).not.toContain('Aged24');
  });

  // Round-2 finding F2: the void path leaves a NEEDS_HUMAN case with no open
  // escalation, so its frist is invisible to every deadline reader. The digest
  // names it in ⏰, marked "utan utkast" because there is nothing to approve.
  // Round-5 J4: and ONLY there. seenConvIds deduped inside ⏰ but 🧭 ignored it,
  // so the same kommun was named twice in one digest; the ⏰ line already says
  // there is no draft, which is the whole content of the 🧭 row.
  it('an orphaned NEEDS_HUMAN case with a due deadline is named once, in the deadline section only', async () => {
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
    // Round-6 K6: the ⏰ label names kommun/role, the way every other digest
    // and log line in this file does — one kommun can hold several conversations.
    expect(deadlineSection).toContain('Karlstad/central (senast 2026-09-13, utan utkast)');
    expect(deadlineSection).toContain('2026-09-13');
    // listed exactly once in the whole digest (round-5 J4)
    expect(digest.match(/Karlstad/g)).toHaveLength(1);
    // Round-6 K6: this used to sit behind `if (digest.includes('🧭'))`, which
    // disables itself precisely when the dedupe works — and slice(-1) when it
    // does not. The case is the ONLY orphan, so ⏰ naming it leaves the 🧭
    // section empty and therefore absent from the digest altogether.
    expect(digest).not.toContain('🧭');
  });

  // Round-5 J2: a frist stated by a mail that warranted no draft at all (an
  // auto_ack or a hänvisning that says "komplettera inom 7 dagar annars
  // avslutas ärendet") sits on a conversation that is neither NEEDS_HUMAN nor
  // escalated. The open-escalation source needs an escalation and the draftless
  // source needs NEEDS_HUMAN, so the deadline was surfaced nowhere.
  it('a dated conversation that is neither NEEDS_HUMAN nor escalated reaches the deadline section', async () => {
    const cid = db.createConversation({ kommun_kod: '0013', kommun_namn: 'Tystnad', role: 'central', contact_email: 't@t.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-t', direction: 'inbound',
      from_email: 't@t.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      classification: 'auto_ack',
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'ACK_RECEIVED');
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(digest.split('🕰')[0]).toContain('Tystnad/central (senast 2026-09-13, utan utkast)');
  });

  // Round-3 G2 (Codex R2 #2): the deadline section sourced its draftless rows
  // from listOrphanNeedsHuman, which excludes any conversation whose kommun has
  // a pending handoff task. A pending referral does not discharge a reply
  // deadline, so the ⏰ alert vanished for exactly the cases carrying both.
  it('a dated draftless case whose kommun has a pending handoff still raises the deadline alert', async () => {
    const cid = db.createConversation({ kommun_kod: '0011', kommun_namn: 'Hänvisad', role: 'central', contact_email: 'h@h.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const mid = db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-h', direction: 'inbound',
      from_email: 'h@h.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.updateConversationState(cid, 'NEEDS_HUMAN');
    db.upsertHandoffTask({
      kommun_kod: '0011', source_conversation_id: cid, source_message_id: mid,
      address: 'annan@h.se', forvaltning: null, same_domain: 1,
    });
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.split('🧭')[0];
    expect(deadlineSection).toContain('Hänvisad/central (senast 2026-09-13, utan utkast)');
    // The 🧭 list keeps its handoff exclusion (spec section C, list 3), and it is
    // the only candidate, so there is no 🧭 section at all (round-6 K6: the
    // assertion used to sit behind `if (digest.includes('🧭'))`).
    expect(digest).not.toContain('🧭');
  });

  // Round-4 H3: the dashboard and the digest must agree. An UNDATED open
  // escalation (what every row written before this branch looks like) over a
  // conversation whose inbound set an outstanding frist showed the date in
  // Behöver dig and never in Slack: the ⏰ query required e.respond_by IS NOT
  // NULL, and the draftless source requires NO open escalation, so the case
  // fell between them. Both now read one effective deadline.
  it('an undated open escalation over a dated outstanding inbound raises the deadline alert once, with a draft', async () => {
    const cid = db.createConversation({ kommun_kod: '0012', kommun_namn: 'Odaterad', role: 'central', contact_email: 'o@o.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-o', direction: 'inbound',
      from_email: 'o@o.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
    });
    db.recordEscalation({ conversation_id: cid, reason: 'r', draft_template: 'free_form', draft_body: 'b' }); // no respond_by
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.split('🕰')[0].split('🧭')[0];
    expect(deadlineSection).toContain('Odaterad/central (senast 2026-09-13)');
    // There IS a draft to approve, so it must not be labelled draftless...
    expect(deadlineSection).not.toContain('Odaterad/central (senast 2026-09-13, utan utkast)');
    // ...and it is named exactly once.
    expect(digest.match(/Odaterad/g)).toHaveLength(1);
  });

  // Round-8 M1 (critical): the active escalation's respond_by used to WIN over
  // the conversation's frist whenever it was non-null, so a PARKED send carrying
  // 2026-09-20 masked a newer inbound demanding 2026-09-14: the ⏰ section
  // printed the later date, the due comparison failed against it, and the case
  // was named nowhere until the real deadline had passed. Both dates are
  // outstanding; the soonest is the actionable one.
  it('a parked escalation dated later does not mask a newer, sooner inbound deadline', async () => {
    const cid = db.createConversation({ kommun_kod: '0013', kommun_namn: 'Maskerad', role: 'central', contact_email: 'm@m.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const escId = db.recordEscalation({ conversation_id: cid, reason: 'r', draft_template: 'free_form', draft_body: 'b', respond_by: '2026-09-20' });
    db.resolveEscalation(escId, { status: 'send_failed', resolved_text: 'send error: boom' });
    db.recordMessage({
      conversation_id: cid, gmail_message_id: 'g-m', direction: 'inbound',
      from_email: 'm@m.se', to_email: 'x', subject: 's', body_text: 'b',
      received_at: '2026-09-12T08:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-14' } }),
    });
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.split('🕰')[0].split('🧭')[0];
    expect(deadlineSection).toContain('Maskerad/central (senast 2026-09-14)');
    expect(deadlineSection).not.toContain('2026-09-20');
  });

  // Round-4 H7: the aged and orphan sections each had a cap test; the ⏰ section
  // did not, so a regression in its slice would have gone unnoticed until Slack
  // rejected the whole digest with invalid_blocks.
  it('caps the deadline list at DIGEST_MAX_LINES with the same "…och N till" tail', async () => {
    for (let i = 0; i < 25; i += 1) {
      const cid = db.createConversation({
        kommun_kod: String(5000 + i), kommun_namn: `Frist${i}`, role: 'central',
        contact_email: `f${i}@f.se`, scheduled_send_at: '2026-08-01T08:00:00Z',
      });
      db.recordEscalation({ conversation_id: cid, reason: 'r', draft_template: 'free_form', draft_body: 'b', respond_by: '2026-09-13' });
    }
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.slice(digest.indexOf('⏰'), digest.indexOf('🕰') === -1 ? undefined : digest.indexOf('🕰'));
    expect(deadlineSection).toContain('(25)');
    expect(deadlineSection).toContain('…och 5 till');
    expect(deadlineSection).toContain('Frist0/central (senast 2026-09-13)');
    expect(deadlineSection).not.toContain('Frist24');
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

  // Round-6 K4: 🧭 and 🕰 deduped against ALL of `due`, but ⏰ prints only
  // DIGEST_MAX_LINES of it. A dated draftless case past the cap was therefore
  // dropped from ⏰ ("…och 5 till" names nobody) AND suppressed in 🧭 — named
  // nowhere in the digest at all. The dedupe now runs against the INCLUDED set.
  it('a dated draftless case past the deadline cap is still named, in the orphan section', async () => {
    for (let i = 0; i < 25; i += 1) {
      const cid = db.createConversation({
        kommun_kod: String(7000 + i), kommun_namn: `Kapad${String(i).padStart(2, '0')}`, role: 'central',
        contact_email: `k${i}@k.se`, scheduled_send_at: '2026-08-01T08:00:00Z',
      });
      db.recordMessage({
        conversation_id: cid, gmail_message_id: `g-cap-${i}`, direction: 'inbound',
        from_email: 'k@k.se', to_email: 'x', subject: 's', body_text: 'b',
        received_at: '2026-09-11T08:00:00Z', attachment_count: 0,
        analysis_json: JSON.stringify({ extracted: { respond_by_date: '2026-09-13' } }),
      });
      db.updateConversationState(cid, 'NEEDS_HUMAN');
    }
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    const deadlineSection = digest.slice(digest.indexOf('⏰'), digest.indexOf('🧭'));
    const orphanSection = digest.slice(digest.indexOf('🧭'));

    // All 25 are counted and 20 are printed, same cap and tail as always.
    expect(deadlineSection).toContain('(25)');
    expect(deadlineSection).toContain('…och 5 till');
    expect(deadlineSection).toContain('Kapad00/central (senast 2026-09-13, utan utkast)');
    expect(deadlineSection).not.toContain('Kapad20');

    // The five the cap dropped are named here instead of nowhere.
    expect(orphanSection).toContain('(5)');
    for (const n of ['Kapad20', 'Kapad21', 'Kapad22', 'Kapad23', 'Kapad24']) {
      expect(orphanSection).toContain(n);
    }
    expect(orphanSection).not.toContain('Kapad00');

    // 20 + 5 = every kommun named exactly once across the whole digest.
    const named = digest.match(/Kapad\d\d/g) ?? [];
    expect(named).toHaveLength(25);
    expect(new Set(named).size).toBe(25);
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
