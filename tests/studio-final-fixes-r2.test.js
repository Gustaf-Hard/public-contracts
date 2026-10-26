import { describe, it, expect } from 'vitest';
import {
  buildStudioFacts, companyShares, marketByCategory, dataBasis,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renderKommun } from '../src/studio/pages/kommun.js';

// Regression tests for the second final review (items P1 to P9, Q1 to Q3).
// Hand-written fixtures only (the repo is public): real kommun codes (open
// data) with made-up names, elever, values and dates; company and product
// names come from the committed catalogue. Shapes mirror what the reviewers
// found, not their data.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 50 };
const SMALL = { 'Förskola': 50, 'Förskoleklass': 50, '1-3': 100, '4-6': 100, '7-9': 100, Gymnasiet: 200, Komvux: 10 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126'];
// Two kommuner of one län (06) for the samverkansavtal shape, one far away.
const JOINT = { '0662': E, '0617': SMALL, '2480': E };
export const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries([
      ...KODS.map((kod, i) => [kod, {
        namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
        peers: KODS.filter((k) => k !== kod), elever: E,
      }]),
      ...Object.entries(JOINT).map(([kod, elever], i) => [kod, {
        namn: `Samby ${i + 1}`, lan: 'Annat län', folkmangd: 10000, kommungrupp: 'G2', peers: [], elever,
      }]),
    ]),
  },
});

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
const LI = (contract_id, product_name, amount_sek, o = {}) => ({
  contract_id, product_name, amount_sek, unit_price_sek: null, unit: null, quantity: null, period_months: null, ...o,
});
const COV = (contract_id, product_name, grade_level, student_count = 0, status = 'full') => ({
  contract_id, product_name, grade_level, student_count, status,
});
const covFor = (id, name, grades) => grades.map((g) => COV(id, name, g));
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id, slug) => facts.find((f) => f.contract_id === id && (slug === undefined || f.company_slug === slug));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const F9 = ['Förskoleklass', '1-3', '4-6', '7-9'];

// ------------------------------------------------------------------ P1
describe('P1. supersede only when the newer avtal can replace the older', () => {
  it('Landskrona shape: a F-9 Binogi avtal and a later Komvux one run side by side, both count', () => {
    const f9 = C({ annual_value_sek: 585000, period_start: '2025-01-01', period_end: '2028-06-30', products: ['Binogi'] });
    const vux = C({ annual_value_sek: 51137, period_start: '2025-04-15', period_end: '2028-06-30', products: ['Binogi'] });
    const facts = build([f9, vux], { coverage: [...covFor(f9.contract_id, 'Binogi', F9), ...covFor(vux.contract_id, 'Binogi', ['Komvux'])] });
    expect(row(facts, f9.contract_id)).toMatchObject({ active: true, superseded: false, annual_value_sek: 585000 });
    expect(row(facts, vux.contract_id)).toMatchObject({ active: true, superseded: false });
    const html = text(renderKommun({ kod: '0114', stats, facts, statusMap: new Map([['0114', 'done']]), today: TODAY }));
    expect(html).toMatch(/Känt årsvärde 636 tkr/);
  });
  it('Skellefteå shape: gymnasiet and F-9 Gleerups avtal with the same start and a day apart in end date both count', () => {
    const gy = C({ vendor_name: 'Gleerups', annual_value_sek: 1400000, period_start: '2025-08-02', period_end: '2028-08-01', products: ['Gleerups digitala läromedel'] });
    const f9 = C({ vendor_name: 'Gleerups', annual_value_sek: 1800000, period_start: '2025-08-02', period_end: '2028-08-02', products: ['Gleerups digitala läromedel'] });
    const vux = C({ vendor_name: 'Gleerups', annual_value_sek: 28000, period_start: '2025-08-02', period_end: '2028-08-02', products: ['Gleerups digitala läromedel'] });
    const facts = build([gy, f9, vux], {
      coverage: [
        ...covFor(gy.contract_id, 'Gleerups digitala läromedel', ['Gymnasiet']),
        ...covFor(f9.contract_id, 'Gleerups digitala läromedel', F9),
        ...covFor(vux.contract_id, 'Gleerups digitala läromedel', ['Komvux']),
      ],
    });
    for (const c of [gy, f9, vux]) expect(row(facts, c.contract_id).superseded).toBe(false);
  });
  it('a tie is never broken by id: same start, overlapping segments, neither supersedes', () => {
    const a = C({ annual_value_sek: 50000, products: ['Binogi'] });
    const b = C({ annual_value_sek: 70000, period_end: '2028-07-01', products: ['Binogi'] });
    const facts = build([a, b]);
    expect(facts.filter((f) => f.superseded)).toHaveLength(0);
  });
  it('a later start over the same school forms still replaces the older avtal', () => {
    const old = C({ period_start: '2024-01-01', products: ['Binogi'] });
    const neu = C({ period_start: '2025-08-01', products: ['Binogi'] });
    const facts = build([old, neu], { coverage: [...covFor(old.contract_id, 'Binogi', F9), ...covFor(neu.contract_id, 'Binogi', ['7-9'])] });
    expect(row(facts, old.contract_id).superseded).toBe(true);
    expect(row(facts, neu.contract_id).superseded).toBe(false);
  });
  it('a later avtal with no known segments still replaces one with segments', () => {
    const old = C({ period_start: '2024-01-01', products: ['Binogi'] });
    const neu = C({ period_start: '2025-08-01', products: ['Binogi'] });
    const facts = build([old, neu], { coverage: covFor(old.contract_id, 'Binogi', F9) });
    expect(row(facts, old.contract_id).superseded).toBe(true);
  });
});

// ------------------------------------------------------------------ Q2
describe('Q2. a duplicate delivery is one avtal and leaves no orphan owner row', () => {
  it('Bjuv shape: two copies of one Tietoevry avtal, one also naming Skola24, give one whole avtal', () => {
    const a = C({ vendor_name: 'Tietoevry', annual_value_sek: 468000, period_start: '2024-06-01', period_end: '2029-12-31', products: ['Edlevo', 'Skola24'] });
    const b = C({ vendor_name: 'Tietoevry', annual_value_sek: 468000, period_start: '2024-06-01', period_end: '2029-12-31', products: ['Edlevo'] });
    const facts = build([a, b]);
    const head = facts.filter((f) => f.active && !f.superseded);
    expect(new Set(head.map((f) => f.contract_id))).toEqual(new Set([a.contract_id]));
    expect(facts.filter((f) => f.contract_id === b.contract_id).every((f) => f.superseded && f.duplicate_of === a.contract_id)).toBe(true);
    const html = text(renderKommun({ kod: '0114', stats, facts, statusMap: new Map([['0114', 'done']]), today: TODAY }));
    expect(html).toMatch(/Aktiva avtal 1 /);
    expect(html).toContain('samma avtal som ett annat underlag');
  });
  it('the copy with a known value counts over one without', () => {
    const a = C({ annual_value_sek: null, products: ['Binogi'] });
    const b = C({ annual_value_sek: 90000, products: ['Binogi'] });
    const facts = build([a, b]);
    expect(row(facts, a.contract_id).duplicate_of).toBe(b.contract_id);
    expect(row(facts, b.contract_id).superseded).toBe(false);
  });
});

// ------------------------------------------------------------------ P2
describe('P2. a samverkansavtal delivered by several kommuner is one avtal', () => {
  const ist = (kod, o = {}) => C({
    vendor_name: 'IST', kommun_kod: kod, annual_value_sek: 2300000, period_start: '2022-07-01', period_end: '2029-06-30',
    products: ['IST Administration'], ...o,
  });
  const allSeg = ['Förskola', ...F9, 'Gymnasiet', 'Komvux'];
  it('GGVV shape: the same IST avtal from two kommuner counts once, split by elever', () => {
    const a = ist('0662'); const b = ist('0617', { annual_value_sek: 2300000.51 });
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'IST Administration', allSeg), ...covFor(b.contract_id, 'IST Administration', allSeg)] });
    const ra = row(facts, a.contract_id); const rb = row(facts, b.contract_id);
    // elever 1950 and 610 in the covered school forms: 76.17 % and 23.83 %.
    expect(ra.annual_value_sek + rb.annual_value_sek).toBe(2300000);
    expect(ra.annual_value_sek).toBe(Math.round(2300000 * 1950 / 2560));
    expect(ra.joint).toMatchObject({ n_kommuner: 2, kommun_kods: ['0617', '0662'], by: 'elever' });
    expect(ra.kr_per_elev).toBe(898.44); // 2 300 000 / 2 560 combined elever
    expect(rb.kr_per_elev).toBe(898.44);
    expect(ra.avtal_key).toBe(rb.avtal_key);
    const sk = companyShares(facts, { category: 'skoladministration' }).find((s) => s.slug === 'ist');
    expect(sk).toMatchObject({ value_known_sek: 2300000, n_avtal: 1, kommuner: 2 });
    expect(marketByCategory(facts).find((m) => m.category === 'skoladministration').n_avtal).toBe(1);
    expect(dataBasis(facts).active).toBe(1);
  });
  it('the kommun page shows its share and says samverkansavtal med 2 kommuner', () => {
    const a = ist('0662'); const b = ist('0617');
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'IST Administration', allSeg), ...covFor(b.contract_id, 'IST Administration', allSeg)] });
    const html = text(renderKommun({ kod: '0617', stats, facts, statusMap: new Map([['0617', 'done']]), today: TODAY }));
    expect(html).toContain('samverkansavtal med 2 kommuner');
    expect(html).toMatch(/Känt årsvärde 548 tkr/);
    expect(html).not.toMatch(/2,3 mkr/);
  });
  it('even split when a member has no elever for the covered school forms; then kr/elev is unknown', () => {
    const a = ist('0662'); const b = ist('0617');
    const facts = build([a, b]); // no coverage: no segments, no elever
    expect(row(facts, a.contract_id)).toMatchObject({ annual_value_sek: 1150000, kr_per_elev: null, joint: { by: 'jamnt' } });
  });
  it('kommuner in different län, or with different values or dates, are separate avtal', () => {
    const facts = build([ist('0662'), ist('2480'), ist('0617', { annual_value_sek: 900000 }), ist('0114', { period_end: '2029-07-31' })]);
    expect(facts.every((f) => f.joint == null)).toBe(true);
  });
});

// ------------------------------------------------------------------ Q1
describe('Q1. styckpris: the main elev line, and the period rule on the avtal level too', () => {
  it('Gleerups shape: the all-subject line wins over a small Matematikportalen line that comes first', () => {
    const c = C({ vendor_name: 'Gleerups', pricing_model: 'per_student', annual_value_sek: 1185000, products: [] });
    const facts = build([c], {
      lineItems: [
        LI(c.contract_id, 'Matematikportalen F-9, elevlicens 12 mån', 5340, { unit: 'elev', unit_price_sek: 35.6, quantity: 150, period_months: 12 }),
        LI(c.contract_id, 'Gleerups digitala läromedel 4-6, alla ämnen, elev, 12 mån', 486000, { unit: 'elev', unit_price_sek: 505, quantity: 962, period_months: 12 }),
        LI(c.contract_id, 'Gleerups digitala läromedel 7-9, alla ämnen, elev, 12 mån', 498000, { unit: 'elev', unit_price_sek: 590, quantity: 843, period_months: 12 }),
      ],
    });
    expect(row(facts, c.contract_id)).toMatchObject({ kr_per_elev: 590, kr_per_elev_basis: 'styckpris', kr_per_elev_product_slug: 'gleerups-digitala-laromedel' });
  });
  it('NE shape: an avtal unit price whose elev lines are 6-month lines is not a styckpris', () => {
    const c = C({ vendor_name: 'NE', pricing_model: 'per_student', unit: 'elev', unit_price_sek: 250, quantity: 1310, annual_value_sek: 335000, products: ['NE 360'] });
    const facts = build([c], { lineItems: [LI(c.contract_id, 'NE 360 Åk 1-9', 327500, { unit: 'elev', unit_price_sek: 250, quantity: 1310, period_months: 6 })] });
    expect(row(facts, c.contract_id).kr_per_elev_basis).not.toBe('styckpris');
  });
  it('an avtal running under 12 months gives no avtal-level styckpris', () => {
    const c = C({ vendor_name: 'PictureMyLife', pricing_model: 'per_student', unit: 'elev', unit_price_sek: 237.5, quantity: 40, annual_value_sek: 9500, period_start: '2026-08-01', period_end: '2026-12-31' });
    expect(row(build([c]), c.contract_id).kr_per_elev_basis).not.toBe('styckpris');
  });
  it('a 12-month avtal with an elev unit price keeps it', () => {
    const c = C({ vendor_name: 'PictureMyLife', pricing_model: 'per_student', unit: 'elev', unit_price_sek: 240, quantity: 40, annual_value_sek: 9600 });
    expect(row(build([c]), c.contract_id)).toMatchObject({ kr_per_elev: 240, kr_per_elev_basis: 'styckpris' });
  });
});
