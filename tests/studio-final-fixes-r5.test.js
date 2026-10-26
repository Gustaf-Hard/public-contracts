import { describe, it, expect } from 'vitest';
import { buildStudioFacts, priceDistribution, sameDocument, heldAvtal } from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { segmentMatrix } from '../src/studio/charts.js';
import { renderKommun } from '../src/studio/pages/kommun.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { renderUtforska, parseUtforskaQuery } from '../src/studio/pages/utforska.js';
import { renewalRows, renewalsCsv } from '../src/studio/pages/fornyelser.js';
import { notDone } from '../src/studio/pages/common.js';
import { underlagEvidence } from '../src/studio-data.js';

// Regression tests for the fifth final review (V1 to V7, Y1). Hand-written
// fixtures only (the repo is public): real kommun codes (open data) with
// made-up names, elever, values, dates and summaries; company and product
// names come from the committed catalogue. The shapes mirror what the
// reviewers found, the numbers are invented.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 100 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126', '0127'];
const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries(KODS.map((kod, i) => [kod, {
      namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
      peers: KODS.filter((k) => k !== kod), elever: E,
    }])),
  },
});
const F9 = ['1-3', '4-6', '7-9'];

let nextId = 1;
const C = (o = {}) => ({
  contract_id: nextId++,
  vendor_id: 1,
  vendor_name: 'Binogi AB',
  kommun_kod: '0114',
  kommun_namn: 'Testby 1',
  period_start: '2025-01-01',
  period_end: '2028-06-30',
  annual_value_sek: 100000,
  one_time_value_sek: null,
  pricing_model: 'fixed',
  unit_price_sek: null,
  unit: null,
  quantity: null,
  attachment_id: 500,
  received_at: '2026-02-01T10:00:00Z',
  products: [],
  ...o,
});
const covFor = (id, name, grades, count = 0) => grades.map((g) => ({ contract_id: id, product_name: name, grade_level: g, student_count: count, status: 'full' }));
const perElev = (id, name, price) => ({ contract_id: id, product_name: name, amount_sek: null, unit_price_sek: price, unit: 'elev', quantity: null, period_months: 12 });
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id) => facts.find((f) => f.contract_id === id);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const done = (kods) => new Map(kods.map((k) => [k, 'done']));
const points = (facts, slug, kod = '0114') => facts.filter((f) => f.kommun_kod === kod && f.active && !f.superseded && f.kr_per_elev != null
  && (f.kr_per_elev_product_slug === slug || (!f.kr_per_elev_product_slug && f.product_slugs.length === 1 && f.product_slugs[0] === slug)));

// ------------------------------------------------------------------ V3
describe('V3. a shared generic file name alone is not one document', () => {
  it('two independent Binogi avtal both named "Avtal.pdf" stay two avtal with their own prices', () => {
    const mk = (kod, namn, size) => C({ kommun_kod: kod, kommun_namn: namn, filename: 'Avtal.pdf', size_bytes: size, period_start: '2025-08-01', period_end: '2027-07-31', products: ['Binogi'], summary: `Avtal mellan ${namn} och Binogi.` });
    const a = mk('0114', 'Testby 1', 1000); const b = mk('0115', 'Testby 2', 2000);
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'Binogi', F9), ...covFor(b.contract_id, 'Binogi', F9)] });
    expect(facts.every((f) => f.joint == null)).toBe(true);
    expect(facts.map((f) => f.kr_per_elev)).toEqual([111.11, 111.11]);
    expect(sameDocument({ name: 'avtal.pdf', size: 1 }, { name: 'avtal.pdf', size: 2 })).toBe(false);
    expect(sameDocument({ name: 'avtal.pdf', size: 3 }, { name: 'avtal.pdf', size: 3 })).toBe(true);
  });
});

// ------------------------------------------------------------------ V5
describe('V5. a samverkansavtal\'s value carrier is chosen per owner company', () => {
  it('ILT and Binogi split 50/50; the carrier kommun replaces only its ILT avtal: the other copy carries ILT', () => {
    const joint = (kod, namn) => C({
      vendor_name: 'ILT Education AB', kommun_kod: kod, kommun_namn: namn, size_bytes: 9090, annual_value_sek: 100000,
      period_start: '2024-01-01', period_end: '2028-12-31', products: ['Polylino', 'Binogi'],
    });
    const a = joint('0114', 'Testby 1'); const b = joint('0115', 'Testby 2');
    const lines = [a, b].flatMap((c) => [
      { contract_id: c.contract_id, product_name: 'Polylino', amount_sek: 50000, unit_price_sek: null, unit: null, quantity: null, period_months: 12 },
      { contract_id: c.contract_id, product_name: 'Binogi', amount_sek: 50000, unit_price_sek: null, unit: null, quantity: null, period_months: 12 },
    ]);
    // Testby 1 re-signs Polylino on its own.
    const renew = C({ vendor_name: 'ILT Education AB', annual_value_sek: 100000, period_start: '2025-06-01', period_end: '2029-05-31', products: ['Polylino'], size_bytes: 1 });
    const facts = build([a, b, renew], { lineItems: lines });
    const iltA = facts.find((f) => f.contract_id === a.contract_id && f.company_slug === 'ilt');
    const iltB = facts.find((f) => f.contract_id === b.contract_id && f.company_slug === 'ilt');
    expect(iltA.superseded).toBe(true);
    expect(iltB).toMatchObject({ annual_value_sek: 50000, joint: { counted_here: true } });
    expect(facts.find((f) => f.contract_id === a.contract_id && f.company_slug === 'binogi')).toMatchObject({ annual_value_sek: 50000, joint: { counted_here: true } });
    const head = facts.filter((f) => f.active && !f.superseded);
    expect(head.reduce((s, f) => s + (f.annual_value_sek ?? 0), 0)).toBe(200000); // 50 + 50 joint, 100 renewal
  });
});

