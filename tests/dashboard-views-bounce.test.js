// The bounce escalation renders a distinct resend form (2026-07-19 §3):
// a leveransfel banner naming the dead address, a REQUIRED empty address input
// (name="finalTo"), the editable T-INITIAL body, and a single resend button —
// never the normal reply textarea / "approve unmodified" affordance.
import { describe, it, expect } from 'vitest';
import { renderEscalationForm } from '../src/dashboard-views.js';

const bounceEsc = {
  id: 42,
  classifier_class: 'bounce',
  draft_template: 'T_RESEND_BAD_ADDRESS',
  reason: 'Leveransfel: adressen `lund.kommun@lund.se` finns inte — ange ny adress och skicka om begäran.',
  draft_subject: 'Begäran om allmänna handlingar – Lund kommun – digitala verktyg, lärplattformar och läromedel',
  draft_body: 'Hej,\n\nJag skriver till Lund kommun med en begäran ... offentlighetsprincipen.',
};

const normalEsc = {
  id: 7,
  classifier_class: 'delivery',
  draft_template: 'free_form',
  reason: 'r',
  draft_subject: 'Re: SV',
  draft_body: 'tack',
  recipient: 'anneli@arboga.se',
};

describe('renderEscalationForm — bounce resend form', () => {
  const html = renderEscalationForm(bounceEsc, true);

  it('shows a leveransfel banner naming the dead address (struck-through)', () => {
    expect(html).toMatch(/Leveransfel/);
    expect(html).toContain('<s>lund.kommun@lund.se</s>');
  });

  it('renders a REQUIRED, EMPTY corrected-address input named finalTo', () => {
    expect(html).toMatch(/name="finalTo"[^>]*required/);
    // Empty value — never pre-fills the dead address.
    expect(html).toMatch(/name="finalTo" value=""/);
    expect(html).not.toMatch(/name="finalTo" value="lund/);
  });

  it('includes the editable T-INITIAL body and the resend button, not a reply textarea', () => {
    expect(html).toContain('offentlighetsprincipen');
    expect(html).toMatch(/Skicka om begäran \(T-INITIAL\)/);
    // Posts as an edit (so finalTo + edited body are honoured), not approve_unmodified.
    expect(html).toMatch(/name="action" value="edit"/);
    expect(html).not.toMatch(/value="send"/); // no "approve unmodified" button
  });
});

describe('renderEscalationForm — a normal reply is unchanged', () => {
  it('renders the standard reply form (To/Ämne/Brödtext), not the bounce form', () => {
    const html = renderEscalationForm(normalEsc, true);
    expect(html).not.toMatch(/Leveransfel/);
    expect(html).not.toMatch(/name="finalTo"/);
    expect(html).toMatch(/name="to"/);
  });
});
