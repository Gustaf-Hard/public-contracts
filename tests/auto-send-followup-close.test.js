// Auto-send of T_FOLLOWUP_CLOSE (2026-08-31 design): the third graduated
// template. Unit half: the pure eligibility predicate. Integration half
// (Task 3): the runDailyFollowup sweep.

import { describe, it, expect } from 'vitest';
import { isAutoSendableFollowupClose } from '../src/conversation.js';

function esc(overrides = {}) {
  return { id: 1, conversation_id: 10, status: 'open', draft_template: 'T_FOLLOWUP_CLOSE', ...overrides };
}
function conv(overrides = {}) {
  return { id: 10, state: 'DELIVERING', kommun_namn: 'Grums', role: 'other', ...overrides };
}
function check(overrides = {}) {
  const { e = esc(), c = conv() } = overrides;
  // Deliberately not a destructured default: `unreadDocs = 0` in the
  // parameter list would collapse an explicitly-passed `undefined` back to
  // 0 before the guard ever sees it, making the "fails closed on
  // undefined" assertions below unreachable. `in` distinguishes "omitted"
  // (defaults to the safe 0) from "explicitly undefined" (must reach the
  // guard as undefined so Number.isFinite can reject it).
  const unreadDocs = 'unreadDocs' in overrides ? overrides.unreadDocs : 0;
  const autoSentCount = 'autoSentCount' in overrides ? overrides.autoSentCount : 0;
  return isAutoSendableFollowupClose({ esc: e, conv: c, unreadDocs, autoSentCount });
}

describe('isAutoSendableFollowupClose', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });
  it('rejects wrong template and non-open status', () => {
    expect(check({ e: esc({ draft_template: 'T_FOLLOWUP_NUDGE' }) }).reason).toBe('not_followup_close');
    expect(check({ e: esc({ status: 'send_failed' }) }).reason).toBe('not_open');
    expect(check({ e: null }).reason).toBe('not_followup_close');
  });
  it('rejects every non-DELIVERING state — CROSSCHECK close reminders stay manual', () => {
    expect(check({ c: conv({ state: 'CROSSCHECK' }) }).reason).toBe('wrong_state');
    expect(check({ c: conv({ state: 'ACK_RECEIVED' }) }).reason).toBe('wrong_state');
    expect(check({ c: null }).reason).toBe('wrong_state');
  });
  it('rejects unread analysable documents, failing closed on non-finite counts', () => {
    expect(check({ unreadDocs: 1 }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: NaN }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: undefined }).reason).toBe('unread_documents');
  });
  it('rejects a conversation that already got a machine close, failing closed on non-finite counts', () => {
    expect(check({ autoSentCount: 1 }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: NaN }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: undefined }).reason).toBe('auto_send_cap');
  });
});
