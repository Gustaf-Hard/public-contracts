// Ingest-health gating. The Gmail OAuth token dies roughly weekly, and during
// those outages the system used to keep drafting "vi har inte hört av er"
// nudges while replies sat unfetched in the inbox, with Slack silent about it.
// This file is the contract for the four pieces that fix that:
//   1. only a clean TICK stamps last_success_at (a follow-up must not)
//   2. a stale tick alerts Slack once per outage, and once on recovery
//   3. runDailyFollowup does not draft staleness nudges while blind
//   4. approving a staleness nudge while blind is refused (STALE_INGEST)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { reportTickHealth, TICK_OUTAGE_ALERT_MIN } from '../src/daemon.js';
import { runDailyFollowup, deriveFetchWindowDays } from '../src/tick.js';
import { sendApprovedReply } from '../src/send-reply.js';

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

let tmp, dbPath, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-health-'));
  dbPath = join(tmp, 'pilot.db');
  db = openDb(dbPath);
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

// The last clean tick, and everything after it, on a fixed clock.
const T0 = '2026-08-16T08:00:00.000Z';
const at = (mins) => new Date(new Date(T0).getTime() + mins * 60000);

function seedLastSuccess(iso = T0) {
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1').run(iso);
}

function fakeSlackOps({ throws = false } = {}) {
  return {
    alerts: [],
    postAlert: vi.fn(async function (slack, { text }) {
      if (throws) throw new Error('slack 500');
      this.alerts.push(text);
      return { ts: `a-${this.alerts.length}`, channel: 'C1' };
    }),
  };
}

// Exactly what daemon.js's tickOnce does around a tick: read health BEFORE the
// heartbeat, stamp it, then report.
function simulateTick({ now, error = null, slackOps, handle = null, log = null }) {
  const d = handle ?? db;
  const healthBefore = d.getTickHealth({ now, thresholdMin: TICK_OUTAGE_ALERT_MIN });
  d.recordHeartbeat({ kind: 'tick', error });
  return reportTickHealth({ db: d, slackClient: {}, slackOps, env, now, error, healthBefore, log });
}

describe('last_success_at is tick-only (a blind daemon cannot look healthy)', () => {
  it('a clean followup does NOT stamp last_success_at', () => {
    seedLastSuccess();
    db.recordHeartbeat({ kind: 'followup', error: null });
    const h = db.getTickHealth({ now: at(0) });
    expect(h.last_success_at).toBe(T0);            // untouched by the followup
    expect(h.last_followup_at).toBeUndefined();    // (not part of the health shape)
    expect(db.getHeartbeat().last_followup_at).toBeTruthy(); // but it IS recorded
  });

  it('daily followup successes cannot mask a stale tick', () => {
    seedLastSuccess();
    // Six days of outage in which only the (Gmail-free) followup succeeds.
    for (let d = 1; d <= 6; d += 1) db.recordHeartbeat({ kind: 'followup', error: null });
    const h = db.getTickHealth({ now: at(6 * 24 * 60) });
    expect(h.stale).toBe(true);
    expect(h.last_success_at).toBe(T0);
  });

  it('the catch-up fetch window still covers the whole outage', () => {
    seedLastSuccess();
    for (let d = 1; d <= 40; d += 1) db.recordHeartbeat({ kind: 'followup', error: null });
    const now = at(40 * 24 * 60);
    const h = db.getTickHealth({ now });
    // 40 days blind → a window of 41 days, not the 30-day floor a followup-
    // refreshed clock would have produced (which would skip the older mail).
    expect(deriveFetchWindowDays(h.last_success_at, now)).toBe(41);
  });

  it('a failing tick still leaves the previous success in place', () => {
    seedLastSuccess();
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    const h = db.getTickHealth({ now: at(5) });
    expect(h.last_success_at).toBe(T0);
    expect(h.last_error).toBe('invalid_grant');
    expect(h.stale).toBe(false); // 5 min is still fresh
  });
});

describe('stale-tick Slack alert', () => {
  it('stays quiet for a fresh failure (one bad tick is not an outage)', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(15), error: 'ETIMEDOUT', slackOps });
    expect(slackOps.alerts).toHaveLength(0);
    expect(db.getTickHealth({ now: at(15) }).outage_alerted_at).toBeNull();
  });

  it('alerts exactly once across many consecutive failing ticks', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    // 15-minute ticks failing for the next six hours.
    for (let m = 15; m <= 360; m += 15) {
      await simulateTick({ now: at(m), error: 'invalid_grant', slackOps });
    }
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toContain('bearbetas inte');
    expect(slackOps.alerts[0]).toContain('2026-08-16 08:00'); // since when
    expect(slackOps.alerts[0]).toContain('invalid_grant');    // last error
    expect(db.getTickHealth({ now: at(360) }).outage_alerted_at).toBeTruthy();
  });

  it('does not alert before the threshold, and does right after it', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(TICK_OUTAGE_ALERT_MIN), error: 'boom', slackOps });
    expect(slackOps.alerts).toHaveLength(0);
    await simulateTick({ now: at(TICK_OUTAGE_ALERT_MIN + 15), error: 'boom', slackOps });
    expect(slackOps.alerts).toHaveLength(1);
  });

  it('a daemon restarted mid-outage does not re-alert', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(90), error: 'invalid_grant', slackOps });
    expect(slackOps.alerts).toHaveLength(1);

    // Restart: a brand-new process, a brand-new DB handle, no in-memory state.
    const restarted = openDb(dbPath);
    restarted.migrate();
    try {
      await simulateTick({ now: at(105), error: 'invalid_grant', slackOps, handle: restarted });
      await simulateTick({ now: at(120), error: 'invalid_grant', slackOps, handle: restarted });
    } finally {
      restarted.close();
    }
    expect(slackOps.alerts).toHaveLength(1);
  });

  it('posts one recovery message with the outage window and clears the flag', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(90), error: 'invalid_grant', slackOps });
    await simulateTick({ now: at(105), error: 'invalid_grant', slackOps });

    await simulateTick({ now: at(120), error: null, slackOps });
    expect(slackOps.alerts).toHaveLength(2);
    expect(slackOps.alerts[1]).toContain('bearbetas igen');
    expect(slackOps.alerts[1]).toContain('2026-08-16 08:00'); // outage start
    expect(slackOps.alerts[1]).toContain('2026-08-16 10:00'); // outage end
    expect(db.getTickHealth({ now: at(120) }).outage_alerted_at).toBeNull();

    // A further healthy tick says nothing more.
    await simulateTick({ now: at(135), error: null, slackOps });
    expect(slackOps.alerts).toHaveLength(2);
  });

  it('a healthy tick with no outage on record says nothing', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(15), error: null, slackOps });
    expect(slackOps.alerts).toHaveLength(0);
  });

  it('a second outage after a recovery alerts again', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    await simulateTick({ now: at(90), error: 'invalid_grant', slackOps });
    await simulateTick({ now: at(120), error: null, slackOps });        // recovered
    db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1').run('2026-08-16T10:00:00.000Z');
    await simulateTick({ now: at(240), error: 'invalid_grant', slackOps }); // blind again
    expect(slackOps.alerts).toHaveLength(3);
    expect(slackOps.alerts[2]).toContain('bearbetas inte');
  });

  it('Slack being down never breaks the tick loop, and the alert is retried', async () => {
    seedLastSuccess();
    const lines = [];
    const dead = fakeSlackOps({ throws: true });
    await expect(
      simulateTick({ now: at(90), error: 'invalid_grant', slackOps: dead, log: (l) => lines.push(l) })
    ).resolves.toBeNull();
    expect(lines.some((l) => l.includes('tick health alert failed'))).toBe(true);
    // Not marked as alerted → the next tick tries again.
    expect(db.getTickHealth({ now: at(90) }).outage_alerted_at).toBeNull();
    const alive = fakeSlackOps();
    await simulateTick({ now: at(105), error: 'invalid_grant', slackOps: alive });
    expect(alive.alerts).toHaveLength(1);
  });

  it('is a no-op when Slack is not configured', async () => {
    seedLastSuccess();
    const slackOps = fakeSlackOps();
    const healthBefore = db.getTickHealth({ now: at(90) });
    await reportTickHealth({
      db, slackClient: {}, slackOps, env: { ...env, SLACK_CHANNEL_ID: '' },
      now: at(90), error: 'invalid_grant', healthBefore,
    });
    expect(slackOps.alerts).toHaveLength(0);
    // Nothing marked either — a configured channel later still gets the alert.
    expect(db.getTickHealth({ now: at(90) }).outage_alerted_at).toBeNull();
  });
});

describe('runDailyFollowup is gated on tick health', () => {
  function seedStaleConv() {
    const id = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    db.updateConversationState(id, 'SENT', {
      gmail_thread_id: 'thr-a', last_outbound_at: '2026-06-10T10:00:00Z',
    });
    db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?')
      .run('2026-08-01T00:00:00Z', id); // 15 days stale at T0
    return id;
  }

  const followupDeps = (now, log) => ({
    db, gmailClient: { gmail: {} },
    gmailOps: { sendMessage: async () => ({ id: 'out', threadId: 'thr' }) },
    slackClient: {}, slackOps: { postEscalation: async () => ({ ts: 's-1', channel: 'C1' }) },
    env, contractsDir: join(tmp, 'contracts'), now, log,
  });

  it('drafts nothing while ingest is blind, and says why', async () => {
    const id = seedStaleConv();
    seedLastSuccess(); // last clean tick at T0 …
    const lines = [];
    await runDailyFollowup(followupDeps(at(3 * 24 * 60), (l) => lines.push(l))); // … 3 days ago
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
    expect(lines.some((l) => l.includes('FOLLOWUP paused') && l.includes('not being processed'))).toBe(true);
    expect(lines.some((l) => l.includes(T0))).toBe(true); // how stale
  });

  it('drafts nothing when no tick has ever succeeded', async () => {
    const id = seedStaleConv();
    const lines = [];
    await runDailyFollowup(followupDeps(at(0), (l) => lines.push(l)));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
    expect(lines.some((l) => l.includes('ingen lyckad bearbetning'))).toBe(true);
  });

  it('control: with a healthy tick the same conversation IS nudged', async () => {
    const id = seedStaleConv();
    seedLastSuccess();
    await runDailyFollowup(followupDeps(at(10)));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_NUDGE');
  });
});

describe('approving a staleness nudge while ingest is blind (STALE_INGEST)', () => {
  let seq = 0;
  function seedEscalation(draftTemplate) {
    seq += 1;
    const convId = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: `central-${seq}`,
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-06-01T00:00:00Z',
    });
    db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-a' });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'stale SENT for 15 days',
      draft_template: draftTemplate, draft_subject: 'Re: Begäran', draft_body: 'påminnelse',
      previous_state: 'SENT',
    });
    return {
      conv: db.getConversation(convId),
      esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId),
    };
  }

  // sendApprovedReply asks for health at the real send moment (there is no
  // injectable clock on that path), so blindness has to be expressed against
  // the wall clock: the last clean tick was six hours ago.
  const blindSince = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const blind = () => seedLastSuccess(blindSince);

  it('refuses the send and leaves the escalation open, untouched', async () => {
    blind();
    const { conv, esc } = seedEscalation('T_FOLLOWUP_NUDGE');
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-a' }));
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'påminnelse', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'STALE_INGEST' });
    expect(send).not.toHaveBeenCalled();
    // Not consumed, not parked — the operator retries once ingest is back.
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('open');
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('the refusal names the kommun and how long we have been blind', async () => {
    blind();
    const { conv, esc } = seedEscalation('T_FOLLOWUP_CLOSE');
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'x', decision: 'approve_unmodified', gmailSendImpl: vi.fn() })
    ).rejects.toThrow(/Ale may already have replied/);
  });

  it('blocks an EDIT of a nudge too — the operator cannot see the unfetched reply either', async () => {
    blind();
    const { conv, esc } = seedEscalation('T_FOLLOWUP_NUDGE');
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'omskriven', decision: 'edit', gmailSendImpl: vi.fn() })
    ).rejects.toMatchObject({ code: 'STALE_INGEST' });
  });

  // T_REQUEST_MISSING is a conversation-wide negative too — "vi saknar
  // fortfarande avtal med X" is falsified by an unfetched mail carrying exactly
  // that avtal, and accusing a kommun of withholding what they already sent is
  // worse than waiting for a tick.
  it('blocks T_REQUEST_MISSING: it claims something has NOT arrived', async () => {
    blind();
    const { conv, esc } = seedEscalation('T_REQUEST_MISSING');
    const send = vi.fn();
    await expect(
      sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'vi saknar avtal med X', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toMatchObject({ code: 'STALE_INGEST' });
    expect(send).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('open');
  });

  it('sends T_REQUEST_MISSING normally once a tick has succeeded', async () => {
    const { conv, esc } = seedEscalation('T_REQUEST_MISSING');
    db.recordHeartbeat({ kind: 'tick', error: null });
    const send = vi.fn(async () => ({ id: 'out-rm', threadId: 'thr-a' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'vi saknar avtal med X', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send).toHaveBeenCalledOnce();
  });

  // A guard that opts itself out on a db object without the method is worse
  // than no guard: the send looks verified when nothing was checked.
  it('fails loudly rather than skipping the check when the db cannot answer', async () => {
    blind();
    const { conv, esc } = seedEscalation('T_FOLLOWUP_NUDGE');
    const crippled = { ...db, getTickHealth: undefined };
    const send = vi.fn();
    await expect(
      sendApprovedReply({ db: crippled, gmail: {}, env, conv, esc, finalBody: 'x', decision: 'approve_unmodified', gmailSendImpl: send })
    ).rejects.toThrow(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it('does NOT block other templates — they answer mail we HAVE seen', async () => {
    blind();
    for (const tpl of ['T_RECEIPT', 'T_PRECISION', 'T_CROSSCHECK', 'free_form', 'T_RESEND_BAD_ADDRESS', 'T_UPDATE']) {
      const { conv, esc } = seedEscalation(tpl);
      const send = vi.fn(async () => ({ id: `out-${tpl}`, threadId: 'thr-a' }));
      await sendApprovedReply({
        db, gmail: {}, env, conv, esc, finalBody: 'svar',
        finalTo: 'kansli@ale.se', decision: 'edit', gmailSendImpl: send,
      });
      expect(send, tpl).toHaveBeenCalledOnce();
      expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('resolved_edit');
    }
  });

  it('sends the nudge normally once a tick has succeeded', async () => {
    const { conv, esc } = seedEscalation('T_FOLLOWUP_NUDGE');
    db.recordHeartbeat({ kind: 'tick', error: null }); // healthy, right now
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-a' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'påminnelse', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send).toHaveBeenCalledOnce();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id).status).toBe('resolved_send');
    expect(db.getConversation(conv.id).followup_count).toBe(1);
  });
});
