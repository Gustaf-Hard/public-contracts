import { describe, it, expect } from 'vitest';
import { nextActionForClassification, staleAction } from '../src/conversation.js';

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
});
