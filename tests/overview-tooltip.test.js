import { describe, it, expect } from 'vitest';
import { caseTooltip, escalationActionLabel } from '../src/dashboard.js';

describe('escalationActionLabel', () => {
  it('maps known draft templates to plain Swedish actions', () => {
    expect(escalationActionLabel({ draft_template: 'free_form' })).toBe('fritextsvar krävs');
    expect(escalationActionLabel({ draft_template: 'T_FOLLOWUP_NUDGE' })).toBe('skicka påminnelse');
    expect(escalationActionLabel({ draft_template: 'T_FOLLOWUP_CLOSE' })).toBe('skicka avslutspåminnelse');
    expect(escalationActionLabel({ draft_template: 'T_RECEIPT' })).toBe('skicka mottagningskvitto');
  });

  it('falls back to a generic action for unknown/empty templates', () => {
    expect(escalationActionLabel({ draft_template: 'something_new' })).toBe('granska och svara');
    expect(escalationActionLabel({})).toBe('granska och svara');
    expect(escalationActionLabel(null)).toBe('granska och svara');
  });
});

describe('caseTooltip NEEDS_HUMAN', () => {
  const conv = { state: 'NEEDS_HUMAN' };

  it('names the queued action from the open escalation', () => {
    const tip = caseTooltip(conv, null, { date: null }, { draft_template: 'free_form' });
    expect(tip).toContain('Nästa: du måste agera — fritextsvar krävs');
  });

  it('uses the generic action when no escalation is passed', () => {
    const tip = caseTooltip(conv, null, { date: null });
    expect(tip).toContain('Nästa: du måste agera — granska och svara');
  });
});

describe('caseTooltip non-escalated states are unchanged', () => {
  it('SENT still shows the bevakar narrative', () => {
    const conv = { state: 'SENT', last_outbound_at: '2026-06-01T08:00:00Z' };
    const tip = caseTooltip(conv, null, { date: '2026-06-12', source: 'our_followup' });
    expect(tip).toContain('Senast:');
    expect(tip).toContain('Nästa:');
    expect(tip).not.toContain('du måste agera');
  });
});
