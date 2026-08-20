// Auto-send of T_DELAY_ACK (2026-08-20 design): the second graduated class.
// Unit half: the pure eligibility predicate. Integration half (Task 4): the
// runDailyFollowup sweep.

import { describe, it, expect } from 'vitest';
import { isAutoSendableDelayAck, DELAY_ACK_AUTO_MIN_CONFIDENCE } from '../src/conversation.js';

const NOW = new Date('2026-08-20T09:00:00Z');

function esc(overrides = {}) {
  return {
    id: 1, conversation_id: 10, message_id: 100, status: 'open',
    draft_template: 'T_DELAY_ACK', classifier_class: 'delay_promise',
    classifier_confidence: 0.9,
    created_at: '2026-08-20 07:00:00', // SQLite datetime('now') shape, UTC
    ...overrides,
  };
}
function inbound(overrides = {}) {
  return {
    id: 100, direction: 'inbound', classification: 'delay_promise',
    received_at: '2026-08-20T06:55:00Z',
    body_text: 'Hej,\nVi återkommer så snart underlaget är klart.\nMvh Frida',
    attachment_count: 0, stored_attachment_count: 0,
    ...overrides,
  };
}
function check({ e = esc(), messages = [inbound()], autoSentCount = 0, now = NOW } = {}) {
  return isAutoSendableDelayAck({ esc: e, messages, autoSentCount, now });
}

describe('isAutoSendableDelayAck', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });

  it('rejects wrong template, non-open status', () => {
    expect(check({ e: esc({ draft_template: 'free_form' }) }).ok).toBe(false);
    expect(check({ e: esc({ status: 'send_failed' }) }).ok).toBe(false);
  });

  it('rejects low/NULL confidence and non-delay class (fail closed)', () => {
    expect(check({ e: esc({ classifier_confidence: 0.65 }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_confidence: null }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_class: null }) }).reason).toBe('class');
    expect(check({ e: esc({ classifier_confidence: DELAY_ACK_AUTO_MIN_CONFIDENCE }) }).ok).toBe(true); // >= is inclusive
  });

  it('rejects an escalation older than 48h — the deploy-backlog guard', () => {
    expect(check({ e: esc({ created_at: '2026-08-17 07:00:00' }) }).reason).toBe('stale_draft');
  });

  it('rejects an unparseable created_at (fail closed)', () => {
    expect(check({ e: esc({ created_at: 'not-a-date' }) }).reason).toBe('stale_draft');
  });

  it('rejects when the trigger is missing or not the newest inbound', () => {
    expect(check({ messages: [] }).reason).toBe('trigger_missing');
    expect(check({ messages: [inbound(), inbound({ id: 101, received_at: '2026-08-20T08:00:00Z' })] }).reason).toBe('not_latest_inbound');
    // tie on received_at → manual
    expect(check({ messages: [inbound(), inbound({ id: 101 })] }).reason).toBe('not_latest_inbound');
  });

  it('outbound rows never count as "newer inbound"', () => {
    const out = { id: 101, direction: 'outbound', received_at: '2026-08-20T08:30:00Z', body_text: 'x', attachment_count: 0 };
    expect(check({ messages: [inbound(), out] }).ok).toBe(true);
  });

  it('rejects a trigger with stored attachments; missing counts fail closed', () => {
    expect(check({ messages: [inbound({ stored_attachment_count: 1 })] }).reason).toBe('attachments');
    expect(check({ messages: [inbound({ stored_attachment_count: undefined, attachment_count: 2 })] }).reason).toBe('attachments');
  });

  it('applies the body gate and surfaces its reason', () => {
    expect(check({ messages: [inbound({ body_text: 'Avtalet kostar 911 000,00 kr per år' })] }).reason).toBe('currency');
  });

  it('caps lifetime auto-sends per conversation at 2', () => {
    expect(check({ autoSentCount: 1 }).ok).toBe(true);
    expect(check({ autoSentCount: 2 }).reason).toBe('auto_send_cap');
  });
});
