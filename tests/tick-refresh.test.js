// Perpetual contract refresh — arming + daily scan
// (2026-07-09-perpetual-contract-refresh-design.md Part B).
// All offline: temp DB, injected slackOps, no Gmail/Anthropic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { computeKommunReview, armRefresh, runRefreshScan } from '../src/tick.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-refresh-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = { GMAIL_USER_EMAIL: 'gustaf@mediagraf.se', GMAIL_FROM_NAME: 'Gustaf', SLACK_CHANNEL_ID: 'C1' };
const now = new Date('2026-07-09T12:00:00Z');

function fakeSlackOps() {
  return {
    posts: [], updates: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async function (slack, args) { this.updates.push(args); }),
  };
}

// Seed a conversation + a delivered contract row with given lifecycle fields.
let msgSeq = 0;
function seedContract(convId, { vendor, period_end = null, auto_renews = null, last_cancellation_date = null, extension_option_until = null, received_at = '2026-05-01T00:00:00Z', is_contract = 1 }) {
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${msgSeq++}`, direction: 'inbound',
    from_email: 'reg@x.se', to_email: 'me@x.se', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null, received_at, attachment_count: 1,
  });
  const attId = db.recordAttachment({ message_id: msgId, filename: `${vendor}.pdf`, saved_path: `/tmp/${vendor}.pdf`, mime_type: 'application/pdf', size_bytes: 10 });
  const v = vendor ? db.upsertVendor(vendor) : null;
  db.recordContract({ attachment_id: attId, vendor_id: v?.id ?? null, period_end, auto_renews, last_cancellation_date, extension_option_until, is_contract });
}

function seedConv(kommun_kod, kommun_namn = `K${kommun_kod}`, role = 'central') {
  return db.createConversation({ kommun_kod, kommun_namn, role, contact_email: `reg@${kommun_kod}.se`, scheduled_send_at: '2026-01-01T00:00:00Z' });
}

describe('computeKommunReview (pure) — soonest review, dedup newest-wins per vendor', () => {
  it('returns the soonest next_review_date across live contracts', () => {
    const rows = [
      { id: 3, vendor_name: 'Skola24', period_end: '2026-06-30', received_at: '2026-05-01' },
      { id: 4, vendor_name: 'Unikum', period_end: '2027-01-31', received_at: '2026-05-01' },
    ];
    const r = computeKommunReview(rows, now);
    expect(r.date).toBe('2026-06-30');
    expect(r.source).toBe('Skola24');
  });

  it('dedups per (vendor) newest-wins: the newer Atea row supersedes the old one', () => {
    const rows = [
      { id: 1, vendor_name: 'Atea', period_end: '2026-06-30', received_at: '2026-01-01' }, // old
      { id: 2, vendor_name: 'Atea', period_end: '2028-06-30', received_at: '2026-06-01' }, // newer → wins
    ];
    const r = computeKommunReview(rows, now);
    // The old expiring row must NOT drive the review; the newer extension does.
    expect(r.date).toBe('2028-06-30');
    expect(r.source).toBe('Atea');
  });

  it('auto-renew cancellation-date math drives the review', () => {
    const rows = [
      { id: 1, vendor_name: 'Tieto', period_end: '2026-12-31', auto_renews: 1, last_cancellation_date: '2026-09-30', received_at: '2026-05-01' },
    ];
    const r = computeKommunReview(rows, now);
    expect(r.date).toBe('2026-10-01');
    expect(r.source).toBe('Tieto');
  });

  it('ignores non-contracts and rows with no usable date', () => {
    const rows = [
      { id: 1, vendor_name: 'Följebrev', period_end: '2026-06-30', is_contract: 0, received_at: '2026-05-01' },
      { id: 2, vendor_name: 'Okänd', period_end: null, received_at: '2026-05-01' },
    ];
    expect(computeKommunReview(rows, now)).toEqual({ date: null, source: null });
  });

  it('empty set → no review', () => {
    expect(computeKommunReview([], now)).toEqual({ date: null, source: null });
  });
});

describe('armRefresh — sets next_review_at on a DONE conversation (allowlist-gated)', () => {
  it('arms an allowlisted kommun from its soonest live contract', () => {
    const id = seedConv('1489', 'Alingsås');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    seedContract(id, { vendor: 'Unikum', period_end: '2027-01-31' });
    db.updateConversationState(id, 'DONE', {});
    armRefresh(db.getConversation(id), { db, now, refreshAllowlist: ['1489'] });
    const conv = db.getConversation(id);
    expect(conv.next_review_at).toBe('2026-06-30');
    expect(conv.next_review_source).toBe('Skola24');
  });

  it('does NOT arm a kommun off the allowlist', () => {
    const id = seedConv('9999');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', {});
    armRefresh(db.getConversation(id), { db, now, refreshAllowlist: ['1489'] });
    expect(db.getConversation(id).next_review_at).toBeNull();
  });

  it('leaves next_review_at null when no contract yields a usable date', () => {
    const id = seedConv('1489');
    seedContract(id, { vendor: 'Okänd', period_end: null });
    db.updateConversationState(id, 'DONE', {});
    armRefresh(db.getConversation(id), { db, now, refreshAllowlist: ['1489'] });
    expect(db.getConversation(id).next_review_at).toBeNull();
  });
});

describe('runRefreshScan — one T_UPDATE escalation per due, allowlist-gated', () => {
  function deps(extra = {}) {
    return { db, now, env, slackClient: {}, slackOps: fakeSlackOps(), refreshAllowlist: ['1489', '1980'], log: () => {}, ...extra };
  }

  it('due + allowlisted → moves to REFRESH_DUE and creates exactly ONE escalation naming the expiring contract', async () => {
    const id = seedConv('1489', 'Alingsås');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });
    const d = deps();
    await runRefreshScan(d);
    const conv = db.getConversation(id);
    expect(conv.state).toBe('REFRESH_DUE');
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('T_UPDATE');
    expect(escs[0].draft_body).toMatch(/Skola24/);
    expect(escs[0].draft_body).toMatch(/2026-06-30/);
    expect(escs[0].draft_body).toMatch(/nya avtal/); // net-new open-ended
    expect(d.slackOps.posts).toHaveLength(1);
  });

  it('not due (future review) → no escalation, stays DONE', async () => {
    const id = seedConv('1489');
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-12-31', next_review_source: 'Skola24' });
    await runRefreshScan(deps());
    expect(db.getConversation(id).state).toBe('DONE');
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
  });

  it('due but NOT allowlisted → no escalation', async () => {
    const id = seedConv('9999');
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });
    await runRefreshScan(deps());
    expect(db.getConversation(id).state).toBe('DONE');
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(0);
  });

  it('respects the one-open-action guard: an existing active escalation blocks a new one', async () => {
    const id = seedConv('1489');
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });
    db.recordEscalation({ conversation_id: id, reason: 'pre-existing open' });
    await runRefreshScan(deps());
    const escs = db.listOpenEscalationsForConversation(id);
    // Still just the one pre-existing escalation; no second minted.
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBeNull();
  });

  it('is idempotent within a day: second scan mints no duplicate (conv already REFRESH_DUE with open esc)', async () => {
    const id = seedConv('1489');
    seedContract(id, { vendor: 'Skola24', period_end: '2026-06-30' });
    db.updateConversationState(id, 'DONE', { next_review_at: '2026-06-30', next_review_source: 'Skola24' });
    const d = deps();
    await runRefreshScan(d);
    await runRefreshScan(d);
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
  });
});
