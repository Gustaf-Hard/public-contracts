import { describe, it, expect } from 'vitest';
import {
  T_INITIAL,
  T_PRECISION,
  T_RECEIPT,
  T_FOLLOWUP_NUDGE,
  T_FOLLOWUP_CLOSE,
} from '../src/templates.js';
import { T_REQUEST_MISSING, T_UPDATE, T_DELAY_ACK, formatDateSv, computeReceivedMissing, chooseDeliveryReply } from '../src/templates.js';

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

  it('narrows the request to the actual avtal with price/commercial terms and disclaims bilagor + PUB-avtal', () => {
    const m = T_INITIAL(ctx);
    // ask only for the real contract with price/commercial terms
    expect(m.body).toMatch(/själva avtal/i);
    expect(m.body).toMatch(/pris och kommersiella villkor/);
    // explicitly NOT the annexes / DPA
    expect(m.body).toMatch(/behöver (inte|ej)/i);
    expect(m.body).toMatch(/bilagor/);
    expect(m.body).toMatch(/kravspecifikationer/);
    expect(m.body).toMatch(/SLA/);
    expect(m.body).toMatch(/personuppgiftsbiträdesavtal/);
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
  // Facts come from buildCoverageFacts; these are hand-built equivalents.
  const facts = (over = {}) => ({
    received: [], received_unresolved: [], channels_seen: [], undocumented: [],
    not_yet_seen: [], has_missing: false, ...over,
  });

  it('keeps our extracted vendor names OUT of the ask', () => {
    // Operator rule (2026-07-05, Arjeplog #11): exposing our extraction as fact
    // narrows what the kommun sends back, and it may simply be wrong.
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'unikum', canonical: 'Unikum', products: [] }],
      undocumented: [{ slug: 'vklass', canonical: 'Vklass' }, { name: 'Quiculum' }],
      has_missing: true,
    }) });
    expect(m.subject).toBe('Re: Begäran');
    expect(m.body).toMatch(/faktiska avtalshandlingarna/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
    for (const name of ['Unikum', 'Vklass', 'Quiculum']) expect(m.body).not.toMatch(name);
  });

  it('never names a company we already received, under any of its names', () => {
    // Borlänge: Magma delivered. Neither "Magma" nor "Radish" may appear.
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'radish', canonical: 'Radish', products: ['Magma'] }],
      not_yet_seen: [{ slug: 'ne', canonical: 'Nationalencyklopedin', probeLabel: 'NE' }],
    }) });
    expect(m.body).not.toMatch(/Radish/);
    expect(m.body).not.toMatch(/Magma/);
    expect(m.body).toMatch(/NE/);
  });

  it('asks for the kommuns own avrop when a procurement channel appeared, never the framework contract', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      channels_seen: [{ slug: 'adda', canonical: 'Adda' }, { slug: 'laromedia', canonical: 'LäroMedia Bokhandel Örebro' }],
    }) });
    expect(m.body).toMatch(/avrop/);
    expect(m.body).toMatch(/Adda/);              // named as a channel we buy through
    expect(m.body).not.toMatch(/Addas avtal/);   // never their own contract
  });

  it('omits the avrop paragraph entirely when no channel appeared', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({ undocumented: [{ name: 'X' }], has_missing: true }) });
    expect(m.body).not.toMatch(/avrop/);
  });

  it('probes only the ABSENT watchlist companies, by the brand a kommun recognizes', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'radish', canonical: 'Radish', products: ['Magma'] }],
      not_yet_seen: [
        { slug: 'ilt', canonical: 'ILT Education', probeLabel: 'Inläsningstjänst' },
        { slug: 'binogi', canonical: 'Binogi', probeLabel: 'Binogi' },
      ],
    }) });
    expect(m.body).toMatch(/Inläsningstjänst, Binogi eller liknande\?/);
    expect(m.body).not.toMatch(/ILT Education/);  // company canonical, not the brand
  });

  it('drops the probe when every watchlist company is accounted for', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({ undocumented: [{ name: 'X' }], has_missing: true }) });
    expect(m.body).not.toMatch(/eller liknande/);
  });

  it('narrows the ask to the avtal with price terms and disclaims bilagor + PUB-avtal', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({ has_missing: true, undocumented: [{ name: 'X' }] }) });
    expect(m.body).toMatch(/pris och kommersiella villkor/);
    expect(m.body).toMatch(/behöver (inte|ej)/i);
    expect(m.body).toMatch(/bilagor/);
    expect(m.body).toMatch(/kravspecifikationer/);
    expect(m.body).toMatch(/SLA/);
    expect(m.body).toMatch(/personuppgiftsbiträdesavtal/);
  });

  it('never claims something is missing when the facts say nothing is', () => {
    // Live Borlänge (conv 31): every company they named, they delivered. What
    // remains is the avrop ask and the NE probe. Claiming missing handlingar
    // here would be exactly the dishonesty this template exists to remove.
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'radish', canonical: 'Radish', products: ['Magma'] }],
      channels_seen: [{ slug: 'adda', canonical: 'Adda' }],
      not_yet_seen: [{ slug: 'ne', canonical: 'Nationalencyklopedin', probeLabel: 'NE' }],
      has_missing: false,
    }) });
    expect(m.body).not.toMatch(/saknar/);
    expect(m.body).not.toMatch(/inte .*bifogade/);
    expect(m.body).toMatch(/Tack för avtalen/);
    expect(m.body).toMatch(/avrop/);
    expect(m.body).toMatch(/NE eller liknande/);
  });

  it('thanks for what arrived without naming it, and still asks when nothing real arrived', () => {
    const withDelivery = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'unikum', canonical: 'Unikum', products: [] }], undocumented: [{ name: 'X' }], has_missing: true,
    }) });
    expect(withDelivery.body).toMatch(/Tack för avtalen/);
    const withoutDelivery = T_REQUEST_MISSING({ ...base, facts: facts({ undocumented: [{ name: 'X' }], has_missing: true }) });
    expect(withoutDelivery.body).toMatch(/Tack för ert svar/);
    expect(withoutDelivery.body).toMatch(/faktiska avtalshandlingarna/);
  });

  it('contains no em-dash or en-dash (reads AI-written)', () => {
    const m = T_REQUEST_MISSING({ ...base, facts: facts({
      received: [{ slug: 'radish', canonical: 'Radish', products: ['Magma'] }],
      channels_seen: [{ slug: 'adda', canonical: 'Adda' }],
      undocumented: [{ slug: 'vklass', canonical: 'Vklass' }],
      not_yet_seen: [{ slug: 'ne', canonical: 'Nationalencyklopedin', probeLabel: 'NE' }],
      has_missing: true,
    }) });
    expect(m.body).not.toMatch(/[—–]/);
  });

  it('renders a usable draft when facts are absent (old callers, empty conversation)', () => {
    const m = T_REQUEST_MISSING({ ...base });
    expect(m.body).toMatch(/faktiska avtalshandlingarna/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
  });
});

describe('T_UPDATE (perpetual refresh re-contact)', () => {
  const base = { kommun_namn: 'Alingsås', role: 'central', thread_subject: 'Begäran om allmänna handlingar', from_name: 'Gustaf Hård af Segerstad', from_email: 'gustaf@mediagraf.se' };

  it('references the prior relationship / ärende and keeps net-new OPEN-ENDED', () => {
    const m = T_UPDATE({ ...base, arendenummer: 'KS-2026-42', review_contracts: [{ vendor_name: 'Skola24', period_end: '2026-06-30' }] });
    // references the prior request
    expect(m.body).toMatch(/tidigare begäran/i);
    expect(m.body).toMatch(/KS-2026-42/);
    // renewal question NAMES the specific expiring contract
    expect(m.body).toMatch(/Skola24/);
    expect(m.body).toMatch(/2026-06-30/);
    expect(m.body).toMatch(/förnyats/);
    // net-new stays open-ended: does NOT enumerate our full holdings
    expect(m.body).toMatch(/nya avtal/);
    expect(m.body).toMatch(/digitala verktyg, lärplattformar eller läromedel/);
    expect(m.body).toMatch(/sedan dess/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
  });

  it('names multiple expiring contracts Swedish-joined', () => {
    const m = T_UPDATE({ ...base, review_contracts: [
      { vendor_name: 'Skola24', period_end: '2026-06-30' },
      { vendor_name: 'Tieto', period_end: '2026-12-31' },
    ] });
    expect(m.body).toMatch(/Skola24/);
    expect(m.body).toMatch(/Tieto/);
  });

  it('works with no arendenummer and no dated contract (graceful)', () => {
    const m = T_UPDATE({ ...base, arendenummer: null, review_contracts: [{ vendor_name: 'Unikum', period_end: null }] });
    expect(m.body).toMatch(/tidigare begäran/i);
    expect(m.body).toMatch(/Unikum/);
    expect(m.body).not.toMatch(/KS-/);
  });

  it('subject re-uses the thread subject with Re:', () => {
    const m = T_UPDATE({ ...base, review_contracts: [{ vendor_name: 'Skola24', period_end: '2026-06-30' }] });
    expect(m.subject).toMatch(/^Re: /);
  });
});
