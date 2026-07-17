// Vacation mode (2026-07-17): supersedeStaleNudgeEscalations moves open
// staleness-driven escalations (classifier_class='followup_stale') to
// 'superseded', and leaves real-inbound + already-terminal rows untouched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-supersede-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seedConv(role) {
  return db.createConversation({
    kommun_kod: '1440', kommun_namn: 'Ale', role,
    contact_email: `${role}@ale.se`, scheduled_send_at: '2026-05-01T00:00:00Z',
  });
}

function esc(convId, { classifier_class = null, status = 'open' } = {}) {
  const id = db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'r',
    draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 's', draft_body: 'b',
    classifier_class,
  });
  if (status !== 'open') db.resolveEscalation(id, { status });
  return id;
}

const statusOf = (id) => db.raw.prepare('SELECT status FROM escalations WHERE id=?').get(id).status;

describe('supersedeStaleNudgeEscalations', () => {
  it('supersedes open followup_stale escalations and returns the count', () => {
    const c1 = seedConv('central');
    const c2 = seedConv('utbildning');
    const staleA = esc(c1, { classifier_class: 'followup_stale' });
    const staleB = esc(c2, { classifier_class: 'followup_stale' });

    expect(db.supersedeStaleNudgeEscalations()).toBe(2);
    expect(statusOf(staleA)).toBe('superseded');
    expect(statusOf(staleB)).toBe('superseded');
  });

  it('leaves open real-inbound escalations (other class / NULL) untouched', () => {
    const c1 = seedConv('central');
    const c2 = seedConv('utbildning');
    const c3 = seedConv('gymnasie');
    const realInbound = esc(c1, { classifier_class: 'delivery' });
    const nullClass = esc(c2, { classifier_class: null });
    const stale = esc(c3, { classifier_class: 'followup_stale' });

    expect(db.supersedeStaleNudgeEscalations()).toBe(1);
    expect(statusOf(realInbound)).toBe('open');
    expect(statusOf(nullClass)).toBe('open');
    expect(statusOf(stale)).toBe('superseded');
  });

  it('leaves already-terminal followup_stale rows untouched (only open ones move)', () => {
    const c1 = seedConv('central');
    const alreadyResolved = esc(c1, { classifier_class: 'followup_stale', status: 'send_failed' });

    expect(db.supersedeStaleNudgeEscalations()).toBe(0);
    expect(statusOf(alreadyResolved)).toBe('send_failed');
  });

  it('returns 0 when there is nothing to supersede', () => {
    expect(db.supersedeStaleNudgeEscalations()).toBe(0);
  });
});
