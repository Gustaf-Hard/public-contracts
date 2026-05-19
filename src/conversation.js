export function nextActionForClassification(state, classification, opts = {}) {
  if (classification === 'unknown') {
    return { nextState: 'NEEDS_HUMAN', action: 'escalate' };
  }

  if (classification === 'dead_end') {
    if (state === 'DELIVERING' && opts.is_closer) {
      return { nextState: 'DONE', action: 'none' };
    }
    return { nextState: 'DEAD_END', action: 'none' };
  }

  if (classification === 'auto_ack') {
    if (state === 'SENT' || state === 'AWAITING_PRECISION') {
      return { nextState: 'ACK_RECEIVED', action: 'none' };
    }
    return { nextState: state, action: 'none' };
  }

  if (classification === 'clarification') {
    if (state === 'SENT' || state === 'ACK_RECEIVED' || state === 'AWAITING_PRECISION') {
      return { nextState: 'AWAITING_PRECISION', action: 'send_precision' };
    }
    return { nextState: state, action: 'none' };
  }

  if (classification === 'delivery') {
    const action = opts.receipt_sent ? 'none' : 'send_receipt';
    return { nextState: 'DELIVERING', action };
  }

  return { nextState: state, action: 'none' };
}

const STALE_RULES = {
  SENT: { days: 7, action: 'send_followup_nudge' },
  ACK_RECEIVED: { days: 14, action: 'send_followup_nudge' },
  AWAITING_PRECISION: { days: 10, action: 'send_followup_nudge' },
  DELIVERING: { days: 14, action: 'send_followup_close' },
};

const MAX_NUDGES = 2;
const TERMINAL = new Set(['DONE', 'DEAD_END', 'NEEDS_HUMAN']);

export function staleAction(state, daysInState, followupCount) {
  if (TERMINAL.has(state)) return 'none';
  const rule = STALE_RULES[state];
  if (!rule) return 'none';
  if (daysInState < rule.days) return 'none';
  if (followupCount >= MAX_NUDGES && rule.action === 'send_followup_nudge') return 'escalate';
  return rule.action;
}
