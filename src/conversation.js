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
    if (state === 'DELIVERING') {
      // A real question from the registrator mid-delivery must get a drafted
      // reply + escalation, not be silently swallowed (review L4). The state
      // stays DELIVERING — the kommun is still in the middle of delivering.
      return { nextState: 'DELIVERING', action: 'send_precision' };
    }
    return { nextState: state, action: 'none' };
  }

  if (classification === 'delivery') {
    const action = opts.receipt_sent ? 'none' : 'send_receipt';
    return { nextState: 'DELIVERING', action };
  }

  return { nextState: state, action: 'none' };
}

export const STALE_RULES = {
  SENT: { days: 7, action: 'send_followup_nudge' },
  ACK_RECEIVED: { days: 14, action: 'send_followup_nudge' },
  AWAITING_PRECISION: { days: 10, action: 'send_followup_nudge' },
  DELIVERING: { days: 14, action: 'send_followup_close' },
};

const MAX_NUDGES = 2;
export const TERMINAL_STATES = new Set(['DONE', 'DEAD_END', 'NEEDS_HUMAN']);
const TERMINAL = TERMINAL_STATES;

// REFRESH_DUE is a quiescent, human-gated waypoint (finding 2): the conversation
// holds a T_UPDATE draft awaiting operator approval. It is NOT terminal (the
// dashboard shows it as an open action, not a dead end), but the daily
// follow-up machinery must give it DEFINED handling so it can never strand or
// draw a nudge the kommun can't satisfy: no stale rule fires, no live follow-up
// date. The operator either approves (→ SENT, a fresh round) or skips (the
// refresh scan reverts it to DONE so it re-arms). Quiescent, but explicit.
export const QUIESCENT_STATES = new Set(['REFRESH_DUE']);

// Earliest date the bot will take action again, in YYYY-MM-DD, tagged with
// where the date came from:
//   - 'kommun_promise' — LLM extracted a promise from an inbound reply
//     ("vi behöver 10 dagar"). Green in the dashboard: the kommun is on
//     the hook.
//   - 'our_followup'   — no promise; we'll nudge them after the stale
//     rule fires. Red in the dashboard: we'll have to reach out again.
// Terminal states return {date: null, source: null}.
export function effectiveFollowUp(conv) {
  const none = { date: null, source: null };
  if (!conv) return none;
  // Terminal wins over a lingering kommun promise (review M10): a DONE or
  // DEAD_END case must never show a live follow-up date, even if follow_up_at
  // was never cleared (legacy rows).
  if (TERMINAL.has(conv.state) || QUIESCENT_STATES.has(conv.state)) return none;
  if (conv.follow_up_at) return { date: conv.follow_up_at, source: 'kommun_promise' };
  const rule = STALE_RULES[conv.state];
  if (!rule || !conv.state_changed_at) return none;
  const t = new Date(conv.state_changed_at).getTime();
  if (Number.isNaN(t)) return none;
  return {
    date: new Date(t + rule.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    source: 'our_followup',
  };
}

// staleAction optionally honors a per-conversation `follow_up_at` override
// set by the LLM analyser. When a kommun says "we need 10 days", we record
// `follow_up_at = today + 10 + 3 grace`, and this function returns 'none'
// until that date is reached — overriding the default 7/10/14-day rules.
export function staleAction(state, daysInState, followupCount, opts = {}) {
  if (TERMINAL.has(state) || QUIESCENT_STATES.has(state)) return 'none';
  const rule = STALE_RULES[state];
  if (!rule) return 'none';

  // ISO date string compare (YYYY-MM-DD) is lexicographic-correct
  if (opts.follow_up_at && opts.today && opts.today < opts.follow_up_at) {
    return 'none';
  }

  if (daysInState < rule.days) return 'none';
  if (followupCount >= MAX_NUDGES && rule.action === 'send_followup_nudge') return 'escalate';
  return rule.action;
}
