import { describe, it, expect } from 'vitest';
import {
  T_INITIAL,
  T_PRECISION,
  T_RECEIPT,
  T_FOLLOWUP_NUDGE,
  T_FOLLOWUP_CLOSE,
} from '../src/templates.js';
import { T_REQUEST_MISSING, T_DELAY_ACK, formatDateSv, computeReceivedMissing, chooseDeliveryReply } from '../src/templates.js';

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

describe('formatDateSv', () => {
  it('renders an ISO date with Swedish month names', () => {
    expect(formatDateSv('2026-07-20')).toBe('20 juli 2026');
    expect(formatDateSv('2027-01-03')).toBe('3 januari 2027');
  });

  it('passes non-ISO input through unchanged (never crashes the draft)', () => {
    expect(formatDateSv('20 juli')).toBe('20 juli');
    expect(formatDateSv('')).toBe('');
  });
});

describe('T_DELAY_ACK', () => {
  it('is a short, warm ack that NAMES the promised return date', () => {
    const m = T_DELAY_ACK({ ...ctx, delay_date: '2026-07-20' });
    expect(m.subject).toMatch(/^Re: /);
    expect(m.body).toMatch(/^Hej,\n/);
    expect(m.body).toMatch(/Tack för ditt svar!/);
    expect(m.body).toMatch(/Då avvaktar vi till 20 juli 2026/);
    expect(m.body).toMatch(/hör av oss igen om vi inte fått något då/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
    expect(m.body).toMatch(/gustaf@mediagraf.se/);
  });

  it('names a non-ISO date verbatim rather than dropping it', () => {
    const m = T_DELAY_ACK({ ...ctx, delay_date: '20 juli' });
    expect(m.body).toMatch(/Då avvaktar vi till 20 juli/);
  });
});

describe('computeReceivedMissing', () => {
  it('splits received (is_contract) vs missing (mentioned, doc_attached=false), deduped', () => {
    const rows = [
      { is_contract: 1, vendor_name: 'Skolon', analysis_json: JSON.stringify({ mentioned_agreements: [] }) },
      { is_contract: 0, vendor_name: null, analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'Quiculum', product: null, doc_attached: false },
        { vendor: 'Teachiq', product: 'Exam.net', doc_attached: false },
        { vendor: 'Skolon', product: null, doc_attached: false }, // already received → excluded
      ] }) },
    ];
    expect(computeReceivedMissing(rows)).toMatchObject({ received: ['Skolon'], missing: ['Quiculum', 'Teachiq'] });
  });

  it('handles object analysis_json and no mentions', () => {
    const rows = [{ is_contract: 1, vendor_name: 'Google', analysis_json: { mentioned_agreements: [] } }];
    expect(computeReceivedMissing(rows)).toMatchObject({ received: ['Google'], missing: [] });
  });
});

describe('computeReceivedMissing — all vendors', () => {
  it('returns all = union of received and every mentioned vendor (incl doc_attached=true)', () => {
    const rows = [
      { is_contract: 1, vendor_name: 'Quiculum', analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'Quiculum', product: null, doc_attached: true },
        { vendor: 'Teachiq', product: null, doc_attached: false },
      ] }) },
      { is_contract: 0, vendor_name: null, analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'LäroMedia Bokhandel Örebro', product: null, doc_attached: false },
      ] }) },
    ];
    const { received, missing, all } = computeReceivedMissing(rows);
    expect(received).toEqual(['Quiculum']);
    expect(missing).toEqual(['Teachiq', 'LäroMedia Bokhandel Örebro']);
    expect(all).toEqual(['Quiculum', 'Teachiq', 'LäroMedia Bokhandel Örebro']);
  });
});

describe('chooseDeliveryReply', () => {
  it('picks T_RECEIPT when nothing is missing, T_REQUEST_MISSING otherwise', () => {
    expect(chooseDeliveryReply({ received: ['Skolon'], missing: [] }).template).toBe('T_RECEIPT');
    expect(chooseDeliveryReply({ received: [], missing: ['Quiculum'] }).template).toBe('T_REQUEST_MISSING');
    expect(chooseDeliveryReply({ received: ['Skolon'], missing: ['Quiculum'] }).template).toBe('T_REQUEST_MISSING');
  });
});

describe('T_REQUEST_MISSING', () => {
  const base = { thread_subject: 'Begäran', from_name: 'Gustaf Hård af Segerstad', from_email: 'gustaf@mediagraf.se' };
  it('acknowledges received and names missing when both present', () => {
    const m = T_REQUEST_MISSING({ ...base, received: ['Skolon'], missing: ['Quiculum', 'Teachiq'] });
    expect(m.subject).toBe('Re: Begäran');
    expect(m.body).toMatch(/Tack för avtalen gällande Skolon/);
    expect(m.body).toMatch(/Quiculum och Teachiq/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
  });
  it('asks for the documents when nothing real arrived', () => {
    const m = T_REQUEST_MISSING({ ...base, received: [], missing: ['Quiculum'] });
    expect(m.body).toMatch(/inte (vara )?bifogade/);
    expect(m.body).toMatch(/Quiculum/);
  });
  it('falls back to a generic ask when there are no names', () => {
    const m = T_REQUEST_MISSING({ ...base, received: [], missing: [] });
    expect(m.body).toMatch(/faktiska avtalshandlingarna/);
  });
});
