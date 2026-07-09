// Perpetual contract-refresh loop — regression tests for the code-review
// findings on the reopen model (2026-07-09 design Part B).
// All offline: temp DB, injected slackOps + a fake Gmail send, no live services.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runRefreshScan, armRefreshForKommun } from '../src/tick.js';
import { sendApprovedReply } from '../src/send-reply.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-perp-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = { GMAIL_USER_EMAIL: 'gustaf@mediagraf.se', GMAIL_FROM_NAME: 'Gustaf', SLACK_CHANNEL_ID: 'C1' };

function fakeSlackOps() {
  return {
    posts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async () => {}),
  };
}

let msgSeq = 0;
function seedContract(convId, { vendor, period_end = null, received_at = '2026-05-01T00:00:00Z', is_contract = 1 }) {
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${msgSeq++}`, direction: 'inbound',
    from_email: 'reg@x.se', to_email: 'me@x.se', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null, received_at, attachment_count: 1,
  });
  const attId = db.recordAttachment({ message_id: msgId, filename: `${vendor}.pdf`, saved_path: `/tmp/${vendor}.pdf`, mime_type: 'application/pdf', size_bytes: 10 });
  const v = vendor ? db.upsertVendor(vendor) : null;
  db.recordContract({ attachment_id: attId, vendor_id: v?.id ?? null, period_end, is_contract });
}

function seedConv(kommun_kod, { kommun_namn = `K${kommun_kod}`, role = 'central' } = {}) {
  return db.createConversation({ kommun_kod, kommun_namn, role, contact_email: `reg@${kommun_kod}.se`, scheduled_send_at: '2026-01-01T00:00:00Z' });
}

function deps(now, extra = {}) {
  return { db, now, env, slackClient: {}, slackOps: fakeSlackOps(), refreshAllowlist: ['1489', '1980'], log: () => {}, ...extra };
}

// ---- Finding 1 + 4: the loop is perpetual, not one-shot ----
describe('finding 1/4 — perpetual cycle: a completed refresh re-arms and fires again', () => {
  it('arm → REFRESH_DUE → approve/send → SENT → close → DONE → re-arm → SECOND round fires', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489', { kommun_namn: 'Alingsås' });
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24', gmail_thread_id: 'thr-round1' });

    // Round 1: scan arms REFRESH_DUE + one T_UPDATE.
    await runRefreshScan(deps(now));
    expect(db.getConversation(id).state).toBe('REFRESH_DUE');
    const esc1 = db.listOpenEscalationsForConversation(id)[0];
    expect(esc1.draft_template).toBe('T_UPDATE');

    // Operator approves → send. Finding 4: next_review_at cleared. Finding 1:
    // transition to SENT with refresh_round++ and a NEW gmail thread.
    const send = vi.fn(async () => ({ id: 'out-r1', threadId: 'thr-round2-new' }));
    await sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc: esc1,
      finalBody: 'Hej, förnyats?', decision: 'approve_unmodified', gmailSendImpl: send,
    });
    // A fresh thread was opened (threadId NOT forced to the old thr-round1).
    expect(send.mock.calls[0][1].threadId).toBeUndefined();
    let conv = db.getConversation(id);
    expect(conv.state).toBe('SENT');
    expect(conv.refresh_round).toBe(1);
    expect(conv.next_review_at).toBeNull();
    expect(conv.gmail_thread_id).toBe('thr-round2-new');

    // Simulate the round flowing through the existing FSM back to DONE
    // (delivery + close). A NEW contract with a later expiry arrives this round.
    seedContract(id, { vendor: 'Skola24', period_end: '2028-06-30', received_at: '2026-07-20T00:00:00Z' });
    db.updateConversationState(id, 'DONE', {});

    // Next arming recomputes from the now-updated contract set and re-arms.
    armRefreshForKommun([db.getConversation(id)], { db, now: new Date('2026-08-01T00:00:00Z'), refreshAllowlist: ['1489'] });
    conv = db.getConversation(id);
    expect(conv.next_review_at).toBe('2028-06-30');

    // Advance now past the new review date → the SECOND round fires. Proof the
    // loop is not one-shot: a T_UPDATE is minted again after a full cycle.
    const now2 = new Date('2028-07-01T12:00:00Z');
    const d2 = deps(now2);
    await runRefreshScan(d2);
    conv = db.getConversation(id);
    expect(conv.state).toBe('REFRESH_DUE');
    expect(conv.refresh_round).toBe(2); // SECOND round entered — proof it fired again
    const openNow = db.listOpenEscalationsForConversation(id);
    expect(openNow).toHaveLength(1);
    expect(openNow[0].draft_template).toBe('T_UPDATE');
    const send2 = vi.fn(async () => ({ id: 'out-r2', threadId: 'thr-round3-new' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc: openNow[0], finalBody: 'igen', decision: 'approve_unmodified', gmailSendImpl: send2 });
    expect(db.getConversation(id).refresh_round).toBe(2);
    expect(db.getConversation(id).state).toBe('SENT');
  });
});

// ---- Finding 2: REFRESH_DUE never strands (ignored/skipped update) ----
describe('finding 2 — a skipped T_UPDATE reverts REFRESH_DUE → DONE (no strand)', () => {
  it('reverts to DONE when the T_UPDATE escalation was skipped (no active escalation)', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });

    await runRefreshScan(deps(now));
    expect(db.getConversation(id).state).toBe('REFRESH_DUE');

    // Operator skips the T_UPDATE (as the Slack/dashboard/CLI skip path does):
    const esc = db.listOpenEscalationsForConversation(id)[0];
    db.resolveEscalationIfOpen(esc.id, { status: 'resolved_skip' });
    expect(db.hasActiveEscalation(id)).toBe(false);

    // Next scan must reconcile the strand: REFRESH_DUE with no active escalation → DONE.
    await runRefreshScan(deps(now));
    expect(db.getConversation(id).state).toBe('DONE');
  });

  it('does NOT revert a REFRESH_DUE that still has an open T_UPDATE awaiting approval', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });
    await runRefreshScan(deps(now));
    // Scan again without resolving — the open escalation must keep it REFRESH_DUE.
    await runRefreshScan(deps(now));
    expect(db.getConversation(id).state).toBe('REFRESH_DUE');
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
  });
});

// ---- Finding 3: armRefresh must not corrupt state_changed_at ----
describe('finding 3 — arming twice with the same result does not touch state_changed_at', () => {
  it('re-arming an unchanged review performs no state_changed_at write', () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', {});
    armRefreshForKommun([db.getConversation(id)], { db, now, refreshAllowlist: ['1489'] });
    const after1 = db.getConversation(id);
    expect(after1.next_review_at).toBe('2026-06-30');
    const stampBefore = after1.state_changed_at;

    // Arm again with the identical contract set → no-op, stamp unchanged.
    armRefreshForKommun([db.getConversation(id)], { db, now, refreshAllowlist: ['1489'] });
    const after2 = db.getConversation(id);
    expect(after2.state_changed_at).toBe(stampBefore);
    expect(after2.state).toBe('DONE');
    expect(after2.next_review_at).toBe('2026-06-30');
  });
});

// ---- Finding 5: one T_UPDATE per kommun (central + utbildning) ----
describe('finding 5 — a kommun with two DONE conversations yields exactly ONE T_UPDATE', () => {
  it('arms only the canonical conversation; scan fires exactly one escalation', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const central = seedConv('1489', { role: 'central' });
    const utb = seedConv('1489', { role: 'utbildning' });
    // The utbildning conversation holds the most-recent contract delivery.
    seedContract(central, { vendor: 'Skola24', period_end: '2026-06-30', received_at: '2026-05-01T00:00:00Z' });
    seedContract(utb, { vendor: 'Unikum', period_end: '2026-06-30', received_at: '2026-06-15T00:00:00Z' });
    db.updateConversationState(central, 'DONE', {});
    db.updateConversationState(utb, 'DONE', {});

    // Arm the whole kommun in ONE call, as runTick's grouping does.
    armRefreshForKommun(
      [db.getConversation(central), db.getConversation(utb)],
      { db, now, refreshAllowlist: ['1489'] },
    );
    // Exactly one conversation is armed; the sibling is disarmed.
    const armed = [central, utb].filter((cid) => db.getConversation(cid).next_review_at);
    expect(armed).toHaveLength(1);
    expect(armed[0]).toBe(utb); // most-recent contract delivery wins

    await runRefreshScan(deps(now));
    const escCentral = db.listOpenEscalationsForConversation(central).filter((e) => e.draft_template === 'T_UPDATE');
    const escUtb = db.listOpenEscalationsForConversation(utb).filter((e) => e.draft_template === 'T_UPDATE');
    expect(escCentral).toHaveLength(0);
    expect(escUtb).toHaveLength(1);
  });

  it('tie-break to central when neither holds a more-recent contract', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const central = seedConv('1489', { role: 'central' });
    const utb = seedConv('1489', { role: 'utbildning' });
    db.updateConversationState(central, 'DONE', {});
    db.updateConversationState(utb, 'DONE', {});
    // Contracts live only at the kommun level; neither conv holds any here.
    seedContract(central, { vendor: 'Skola24', period_end: '2026-06-30', received_at: '2026-05-01T00:00:00Z' });
    // Both convs see the same kommun contract set (listContractsForKommun),
    // but the delivery is attached to central → central holds it → central wins.
    armRefreshForKommun(
      [db.getConversation(central), db.getConversation(utb)],
      { db, now, refreshAllowlist: ['1489'] },
    );
    expect(db.getConversation(central).next_review_at).toBe('2026-06-30');
    expect(db.getConversation(utb).next_review_at).toBeNull();
  });
});

// ---- Finding 7: T_UPDATE names the real current expiring vendor ----
describe('finding 7 — review contracts recomputed at scan time, never stale', () => {
  it('names the current soonest vendor even when the set changed after arming', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489');
    // Armed against an OLD soonest (Skola24 2026-06-30).
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30', received_at: '2026-05-01T00:00:00Z' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });

    // Between arm and scan a DIFFERENT vendor's contract lands, now the soonest.
    seedContract(id, { vendor: 'Unikum', period_end: '2026-06-15', received_at: '2026-07-01T00:00:00Z' });

    await runRefreshScan(deps(now));
    const esc = db.listOpenEscalationsForConversation(id).find((e) => e.draft_template === 'T_UPDATE');
    expect(esc).toBeTruthy();
    // The draft must name the REAL current soonest vendor (Unikum 2026-06-15),
    // recomputed at scan time — not the stale next_review_source (Skola24).
    expect(esc.draft_body).toMatch(/Unikum/);
    expect(esc.draft_body).toMatch(/2026-06-15/);
  });

  it('does not fire (and re-arms) when the set shifted so nothing is due any more', async () => {
    const now = new Date('2026-07-09T12:00:00Z');
    const id = seedConv('1489');
    // Stale arming says due 2026-06-30, but the live set has been superseded by
    // an extension pushing the real review far into the future.
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30', received_at: '2026-05-01T00:00:00Z' });
    seedContract(id, { vendor: 'Skola24', period_end: '2029-06-30', received_at: '2026-07-01T00:00:00Z' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });

    await runRefreshScan(deps(now));
    const conv = db.getConversation(id);
    // No T_UPDATE minted; conversation stays DONE and is re-armed to the fresh date.
    expect(conv.state).toBe('DONE');
    expect(conv.next_review_at).toBe('2029-06-30');
    expect(db.listOpenEscalationsForConversation(id).filter((e) => e.draft_template === 'T_UPDATE')).toHaveLength(0);
  });
});
