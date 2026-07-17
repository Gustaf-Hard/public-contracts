// Vacation mode (2026-07-17) integration with runDailyFollowup:
//  - inside the window the proactive loop mints NO nudge, even for a very
//    stale conversation;
//  - just outside the window (1 Aug) the summer days are discounted, so a
//    conversation quiet since mid-June is NOT instantly maxed out.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runDailyFollowup } from '../src/tick.js';
import { defaultVacationConfig } from '../src/vacation.js';

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-vac-followup-'));
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = { GMAIL_USER_EMAIL: 'gustaf@mediagraf.se', GMAIL_FROM_NAME: 'Gustaf', SLACK_CHANNEL_ID: 'C1' };

function fakeSlackOps() {
  return {
    posts: [],
    postEscalation: async function () { this.posts.push(1); return { ts: `s-${this.posts.length}`, channel: 'C1' }; },
    postAlert: async () => ({ ts: 'a', channel: 'C1' }),
    updateEscalationResolved: async () => {},
  };
}

function deps({ now, vacationConfig, slackOps = fakeSlackOps() } = {}) {
  return {
    db, gmailClient: { gmail: {} },
    gmailOps: { sendMessage: async () => ({ id: 'out', threadId: 'thr' }) },
    slackClient: {}, slackOps, env, contractsDir, now, vacationConfig,
  };
}

function seedConv({ state = 'SENT', stateChangedAt, followupCount = 0, role = 'central' } = {}) {
  const id = db.createConversation({
    kommun_kod: '1440', kommun_namn: 'Ale', role,
    contact_email: 'kansli@ale.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: 'thr-a', last_outbound_at: '2026-05-10T10:00:00Z',
    followup_count: followupCount,
  });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  return id;
}

describe('runDailyFollowup — vacation gate', () => {
  it('inside the window: no nudge even for a long-stale conversation', async () => {
    const id = seedConv({ stateChangedAt: '2026-05-01T00:00:00Z' }); // ~2 months stale
    await runDailyFollowup(deps({
      now: new Date('2026-07-01T09:00:00Z'), // inside 15 Jun–30 Jul
      vacationConfig: defaultVacationConfig(),
    }));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(0);
  });

  it('logs the vacation pause once per tick, not per conversation', async () => {
    seedConv({ stateChangedAt: '2026-05-01T00:00:00Z' });
    seedConv({ stateChangedAt: '2026-05-02T00:00:00Z', followupCount: 1, role: 'utbildning' });
    const lines = [];
    await runDailyFollowup({
      ...deps({ now: new Date('2026-07-01T09:00:00Z'), vacationConfig: defaultVacationConfig() }),
      log: (m) => lines.push(m),
    });
    expect(lines.filter((l) => /vacation/i.test(l))).toHaveLength(1);
  });

  it('just outside (1 Aug): summer days are discounted, so a mid-June conv is not stale yet', async () => {
    // SENT threshold is 7 days. Quiet since 10 Jun; on 1 Aug the raw age is 52
    // days but 46 of them are vacation → discounted age 6 < 7 → NO nudge.
    const id = seedConv({ stateChangedAt: '2026-06-10T00:00:00Z' });
    await runDailyFollowup(deps({
      now: new Date('2026-08-01T09:00:00Z'),
      vacationConfig: defaultVacationConfig(),
    }));
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
  });

  it('control: with vacation disabled the same 1-Aug conv IS stale and draws a nudge', async () => {
    const id = seedConv({ stateChangedAt: '2026-06-10T00:00:00Z' });
    await runDailyFollowup(deps({
      now: new Date('2026-08-01T09:00:00Z'),
      vacationConfig: { enabled: false, start: '06-15', end: '07-30' },
    }));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_FOLLOWUP_NUDGE');
  });

  it('just outside with enough real (non-summer) age still nudges, and the reason shows the discounted count', async () => {
    // Quiet since 20 May; on 1 Aug raw age is 73 days, vacation days 46,
    // discounted 27 (>= 7) → a nudge fires, and the reason reflects 27, not 73.
    const id = seedConv({ stateChangedAt: '2026-05-20T00:00:00Z' });
    await runDailyFollowup(deps({
      now: new Date('2026-08-01T09:00:00Z'),
      vacationConfig: defaultVacationConfig(),
    }));
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].reason).toMatch(/27 days/);
  });
});
