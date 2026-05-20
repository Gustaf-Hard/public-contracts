import { describe, it, expect } from 'vitest';
import {
  T_INITIAL,
  T_PRECISION,
  T_RECEIPT,
  T_FOLLOWUP_NUDGE,
  T_FOLLOWUP_CLOSE,
} from '../src/templates.js';

const ctx = {
  kommun_namn: 'Malå',
  role: 'utbildning',
  from_email: 'gustaf@mediagraf.se',
  from_name: 'Gustaf Hård af Segerstad',
  thread_subject: 'Begäran om allmänna handlingar – avtal för digitala verktyg',
  days_since_send: 7,
};

describe('T_INITIAL', () => {
  it('renders the offentlighetsprincipen request for utbildning role', () => {
    const m = T_INITIAL(ctx);
    expect(m.subject).toMatch(/Begäran om allmänna handlingar/);
    expect(m.body).toMatch(/offentlighetsprincipen/);
    expect(m.body).toMatch(/utbildningsförvaltningen/);
    expect(m.body).toMatch(/Skolon/);
    expect(m.body).toMatch(/Avtalsvärde eller årskostnad/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
    expect(m.body).toMatch(/gustaf@mediagraf.se/);
  });

  it('uses "kommunen" as scope when role is central', () => {
    const m = T_INITIAL({ ...ctx, role: 'central' });
    expect(m.body).toMatch(/inom kommunen/);
    expect(m.body).not.toMatch(/utbildningsförvaltningen/);
  });

  it('includes kommun_namn in the subject (uniqueness signal for spam filters)', () => {
    const m = T_INITIAL(ctx);
    expect(m.subject).toContain('Malå kommun');
    const other = T_INITIAL({ ...ctx, kommun_namn: 'Boxholm' });
    expect(other.subject).toContain('Boxholm kommun');
    expect(m.subject).not.toBe(other.subject);
  });

  it('opens the body with a kommun-specific salutation', () => {
    const m = T_INITIAL(ctx);
    expect(m.body).toMatch(/^Hej Malå kommun,/);
  });
});

describe('T_PRECISION', () => {
  it('renders the precision reply with reply-style subject', () => {
    const m = T_PRECISION(ctx);
    expect(m.subject).toMatch(/^Re: /);
    expect(m.body).toMatch(/preciserar gärna/);
    expect(m.body).toMatch(/Skolon/);
    expect(m.body).toMatch(/leverantör/);
  });

  it('opens with a kommun-specific salutation', () => {
    const m = T_PRECISION(ctx);
    expect(m.body).toMatch(/^Hej Malå kommun,/);
  });
});

describe('T_RECEIPT', () => {
  it('renders a short tack and asks for completeness', () => {
    const m = T_RECEIPT(ctx);
    expect(m.subject).toMatch(/^Re: /);
    expect(m.body).toMatch(/Tack/);
    expect(m.body).toMatch(/samtliga avtal/);
  });
});

describe('T_FOLLOWUP_NUDGE', () => {
  it('renders a polite follow-up referencing the day count', () => {
    const m = T_FOLLOWUP_NUDGE(ctx);
    expect(m.subject).toMatch(/Påminnelse/);
    expect(m.body).toMatch(/7 dagar sedan/);
  });
});

describe('T_FOLLOWUP_CLOSE', () => {
  it('asks whether the request can be considered fulfilled', () => {
    const m = T_FOLLOWUP_CLOSE(ctx);
    expect(m.body).toMatch(/ytterligare avtal/);
    expect(m.body).toMatch(/slutförd/);
  });
});
