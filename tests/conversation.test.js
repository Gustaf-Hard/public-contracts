import { describe, it, expect } from 'vitest';
import { nextActionForClassification, staleAction, effectiveFollowUp } from '../src/conversation.js';

describe('nextActionForClassification', () => {
  it('SENT + auto_ack → ACK_RECEIVED, no outbound', () => {
    const r = nextActionForClassification('SENT', 'auto_ack');
    expect(r.nextState).toBe('ACK_RECEIVED');
    expect(r.action).toBe('none');
  });

  it('SENT + clarification → AWAITING_PRECISION, send_precision', () => {
    const r = nextActionForClassification('SENT', 'clarification');
    expect(r.nextState).toBe('AWAITING_PRECISION');
    expect(r.action).toBe('send_precision');
  });

  it('ACK_RECEIVED + clarification → AWAITING_PRECISION', () => {
    const r = nextActionForClassification('ACK_RECEIVED', 'clarification');
    expect(r.nextState).toBe('AWAITING_PRECISION');
    expect(r.action).toBe('send_precision');
  });

  it('ACK_RECEIVED + delivery → DELIVERING, send_receipt (first delivery)', () => {
    const r = nextActionForClassification('ACK_RECEIVED', 'delivery', { receipt_sent: 0 });
    expect(r.nextState).toBe('DELIVERING');
    expect(r.action).toBe('send_receipt');
  });

  it('DELIVERING + delivery → DELIVERING, none (no second receipt)', () => {
    const r = nextActionForClassification('DELIVERING', 'delivery', { receipt_sent: 1 });
    expect(r.nextState).toBe('DELIVERING');
    expect(r.action).toBe('none');
  });

  it('any state + dead_end → DEAD_END (terminal), none', () => {
    for (const state of ['SENT', 'ACK_RECEIVED', 'AWAITING_PRECISION', 'DELIVERING']) {
      const r = nextActionForClassification(state, 'dead_end');
      expect(r.nextState).toBe('DEAD_END');
      expect(r.action).toBe('none');
    }
  });

  it('DELIVERING + dead_end ("samtliga avtal" closer) → DONE', () => {
    const r = nextActionForClassification('DELIVERING', 'dead_end', { is_closer: true });
    expect(r.nextState).toBe('DONE');
    expect(r.action).toBe('none');
  });

  it('any state + unknown → NEEDS_HUMAN, escalate', () => {
    const r = nextActionForClassification('SENT', 'unknown');
    expect(r.nextState).toBe('NEEDS_HUMAN');
    expect(r.action).toBe('escalate');
  });

  it('SENT/ACK_RECEIVED/AWAITING_PRECISION + delay_promise → ACK_RECEIVED, send_delay_ack', () => {
    for (const state of ['SENT', 'ACK_RECEIVED', 'AWAITING_PRECISION']) {
      const r = nextActionForClassification(state, 'delay_promise');
      expect(r.nextState).toBe('ACK_RECEIVED');
      expect(r.action).toBe('send_delay_ack');
    }
  });

  it('DELIVERING + delay_promise stays DELIVERING but still acks', () => {
    const r = nextActionForClassification('DELIVERING', 'delay_promise');
    expect(r.nextState).toBe('DELIVERING');
    expect(r.action).toBe('send_delay_ack');
  });

  it('delay_promise in other states is a no-op', () => {
    const r = nextActionForClassification('INITIAL', 'delay_promise');
    expect(r.nextState).toBe('INITIAL');
    expect(r.action).toBe('none');
  });
});

describe('staleAction', () => {
  it('SENT for ≥7 days → send_followup_nudge (1st)', () => {
    expect(staleAction('SENT', 7, 0)).toBe('send_followup_nudge');
  });

  it('SENT for 6 days → none', () => {
    expect(staleAction('SENT', 6, 0)).toBe('none');
  });

  it('ACK_RECEIVED for ≥14 days → send_followup_nudge', () => {
    expect(staleAction('ACK_RECEIVED', 14, 0)).toBe('send_followup_nudge');
    expect(staleAction('ACK_RECEIVED', 13, 0)).toBe('none');
  });

  it('AWAITING_PRECISION for ≥10 days → send_followup_nudge', () => {
    expect(staleAction('AWAITING_PRECISION', 10, 0)).toBe('send_followup_nudge');
  });

  it('DELIVERING for ≥14 days → send_followup_close', () => {
    expect(staleAction('DELIVERING', 14, 0)).toBe('send_followup_close');
  });

  it('escalates to NEEDS_HUMAN after 2 nudges', () => {
    expect(staleAction('SENT', 30, 2)).toBe('escalate');
  });

  it('terminal states never produce action', () => {
    expect(staleAction('DONE', 365, 0)).toBe('none');
    expect(staleAction('DEAD_END', 365, 0)).toBe('none');
    expect(staleAction('NEEDS_HUMAN', 365, 0)).toBe('none');
  });

  it('honors follow_up_at override — no action before the promised date', () => {
    // Kommun said "we need 10 days"; bot recorded follow_up_at = 2026-06-11
    expect(staleAction('SENT', 20, 0, { today: '2026-06-04', follow_up_at: '2026-06-11' })).toBe('none');
  });

  it('applies normal stale rule once follow_up_at has passed', () => {
    expect(staleAction('SENT', 20, 0, { today: '2026-06-12', follow_up_at: '2026-06-11' })).toBe('send_followup_nudge');
  });

  it('follow_up_at does not override the MAX_NUDGES escalation', () => {
    // Past the date AND past 2 nudges — still escalates to human
    expect(staleAction('SENT', 30, 2, { today: '2026-06-12', follow_up_at: '2026-06-11' })).toBe('escalate');
  });
});

describe('effectiveFollowUp', () => {
  it('returns LLM-set date as kommun_promise when conversation has follow_up_at', () => {
    const r = effectiveFollowUp({
      state: 'ACK_RECEIVED',
      state_changed_at: '2026-05-24T10:00:00Z',
      follow_up_at: '2026-06-11',
    });
    expect(r).toEqual({ date: '2026-06-11', source: 'kommun_promise' });
  });

  it('derives our_followup date from STALE_RULES when no follow_up_at is set', () => {
    // SENT rule = 7 days; state_changed 2026-05-24 → derived = 2026-05-31
    const r = effectiveFollowUp({ state: 'SENT', state_changed_at: '2026-05-24T10:00:00Z', follow_up_at: null });
    expect(r).toEqual({ date: '2026-05-31', source: 'our_followup' });
  });

  it('returns nulls for terminal states', () => {
    expect(effectiveFollowUp({ state: 'DONE', state_changed_at: '2026-05-24T10:00:00Z' })).toEqual({ date: null, source: null });
    expect(effectiveFollowUp({ state: 'DEAD_END', state_changed_at: '2026-05-24T10:00:00Z' })).toEqual({ date: null, source: null });
    expect(effectiveFollowUp({ state: 'NEEDS_HUMAN', state_changed_at: '2026-05-24T10:00:00Z' })).toEqual({ date: null, source: null });
  });

  it('returns nulls for INITIAL (not yet sent)', () => {
    expect(effectiveFollowUp({ state: 'INITIAL', state_changed_at: '2026-05-24T10:00:00Z' })).toEqual({ date: null, source: null });
  });

  it('uses ACK_RECEIVED 14-day rule', () => {
    const r = effectiveFollowUp({ state: 'ACK_RECEIVED', state_changed_at: '2026-05-24T10:00:00Z', follow_up_at: null });
    expect(r).toEqual({ date: '2026-06-07', source: 'our_followup' });
  });

  describe('vacation-window push (cfg param)', () => {
    const cfg = { enabled: true, start: '06-15', end: '07-30' };

    it('pushes an our_followup date that lands inside the window to the day after it ends', () => {
      // SENT 7-day rule; state_changed 2026-06-20 → derived 2026-06-27 (inside).
      const r = effectiveFollowUp({ state: 'SENT', state_changed_at: '2026-06-20T10:00:00Z', follow_up_at: null }, cfg);
      expect(r).toEqual({ date: '2026-07-31', source: 'our_followup' });
    });

    it('leaves an our_followup date outside the window unchanged', () => {
      const r = effectiveFollowUp({ state: 'SENT', state_changed_at: '2026-05-24T10:00:00Z', follow_up_at: null }, cfg);
      expect(r).toEqual({ date: '2026-05-31', source: 'our_followup' });
    });

    it('with no cfg (default disabled) never pushes — existing callers unaffected', () => {
      const r = effectiveFollowUp({ state: 'SENT', state_changed_at: '2026-06-20T10:00:00Z', follow_up_at: null });
      expect(r).toEqual({ date: '2026-06-27', source: 'our_followup' });
    });

    it('enabled:false cfg never pushes', () => {
      const off = { enabled: false, start: '06-15', end: '07-30' };
      const r = effectiveFollowUp({ state: 'SENT', state_changed_at: '2026-06-20T10:00:00Z', follow_up_at: null }, off);
      expect(r).toEqual({ date: '2026-06-27', source: 'our_followup' });
    });
  });
});
