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
  it('renders the offentlighetsprincipen request with the school/education scope qualifier', () => {
    const m = T_INITIAL(ctx);
    expect(m.subject).toMatch(/Begäran om allmänna handlingar/);
    expect(m.body).toMatch(/offentlighetsprincipen/);
    expect(m.body).toMatch(/skola och utbildning – direkt eller indirekt/);
    expect(m.body).toMatch(/inom kommunen/);
    // Explicit indirect-procurement coverage so tools bought via resellers /
    // framework agreements (Atea, Läromedia, Adda) are not silently excluded.
    expect(m.body).toMatch(/ramavtal eller inköpscentral/);
    expect(m.body).toMatch(/Atea eller Läromedia/);
    expect(m.body).toMatch(/Skolon/);
    expect(m.body).toMatch(/Avtalsvärde eller årskostnad/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
    expect(m.body).toMatch(/gustaf@mediagraf.se/);
  });

  it('uses "inom kommunen" as scope regardless of role (qualifier narrows the topic, not the förvaltning)', () => {
    const central = T_INITIAL({ ...ctx, role: 'central' });
    const utbildning = T_INITIAL({ ...ctx, role: 'utbildning' });
    expect(central.body).toMatch(/inom kommunen/);
    expect(utbildning.body).toMatch(/inom kommunen/);
    expect(central.body).not.toMatch(/utbildningsförvaltningen/);
    expect(utbildning.body).not.toMatch(/utbildningsförvaltningen/);
  });

  it('includes kommun_namn in the subject (uniqueness signal for spam filters)', () => {
    const m = T_INITIAL(ctx);
    expect(m.subject).toContain('Malå kommun');
    const other = T_INITIAL({ ...ctx, kommun_namn: 'Boxholm' });
    expect(other.subject).toContain('Boxholm kommun');
    expect(m.subject).not.toBe(other.subject);
  });

  it('opens the body with bare "Hej," (Swedish-natural) and mentions the kommun in the first sentence', () => {
    const m = T_INITIAL(ctx);
    expect(m.body).toMatch(/^Hej,\n/);
    expect(m.body).toMatch(/skriver till Malå kommun/);
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

  it('opens with bare "Hej," (kommun context already in the thread)', () => {
    const m = T_PRECISION(ctx);
    expect(m.body).toMatch(/^Hej,\n/);
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
