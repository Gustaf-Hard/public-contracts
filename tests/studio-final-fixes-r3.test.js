import { describe, it, expect } from 'vitest';
import {
  buildStudioFacts, companyShares, marketByCategory, dataBasis, whiteSpots, priceDistribution, isRenewalOf,
  // underlagEvidence,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renderKommun, perElevByCategory } from '../src/studio/pages/kommun.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { renderProdukt } from '../src/studio/pages/produkt.js';
import { productBySlug } from '../src/catalogue.js';

// Regression tests for the third final review (R1 to R5, S1, S2).
// Hand-written fixtures only (the repo is public): real kommun codes (open
// data) with made-up names, elever, values and dates; company and product
// names come from the committed catalogue. The shapes mirror what the
// reviewers found, the numbers do not.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 50 };
const SMALL = { 'Förskola': 50, 'Förskoleklass': 50, '1-3': 100, '4-6': 100, '7-9': 100, Gymnasiet: 200, Komvux: 10 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126'];
const OTHER = { '0862': E, '1472': E, '1462': E, '1439': E, '0662': E, '0617': SMALL, '0665': E, '0683': E };
export const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries([
      ...KODS.map((kod, i) => [kod, {
        namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
        peers: KODS.filter((k) => k !== kod), elever: E,
      }]),
      ...Object.entries(OTHER).map(([kod, elever], i) => [kod, {
        namn: `Annanby ${i + 1}`, lan: 'Annat län', folkmangd: 10000, kommungrupp: 'G2',
        peers: kod === '0662' ? ['0617', '0665', '0683'] : kod === '0617' ? ['0662', '0665', '0683'] : [], elever,
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
const COV = (contract_id, product_name, grade_level, student_count = 0, status = 'full') => ({
  contract_id, product_name, grade_level, student_count, status,
});
const covFor = (id, name, grades) => grades.map((g) => COV(id, name, g));
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id, slug) => facts.find((f) => f.contract_id === id && (slug === undefined || f.company_slug === slug));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const F9 = ['Förskoleklass', '1-3', '4-6', '7-9'];
const ALL = ['Förskola', ...F9, 'Gymnasiet', 'Komvux', 'Introduktionsprogrammet'];
const head = (facts) => facts.filter((f) => f.active && !f.superseded);

// ------------------------------------------------------------------ R1
describe('R1. only a clear renewal supersedes an older avtal', () => {
  const tieto = (kod, o) => C({ vendor_name: 'Tieto', kommun_kod: kod, products: ['Edlevo'], ...o });

  it('Emmaboda shape: a main Edlevo avtal and two tilläggsavtal all stay active', () => {
    const main = tieto('0862', { annual_value_sek: 400000, period_start: '2022-09-01', period_end: '2026-12-31' });
    const big = tieto('0862', { annual_value_sek: 120000, period_start: '2022-10-28', period_end: null });
    const small = tieto('0862', { annual_value_sek: 9000, period_start: '2023-06-14', period_end: null, products: ['Edlevo', 'Webmodul Nationella prov kursprov gy-kurser'] });
    const facts = build([main, big, small], {
      coverage: [...covFor(big.contract_id, 'Edlevo', ALL), ...covFor(small.contract_id, 'Edlevo', ['Gymnasiet', 'Komvux'])],
    });
    for (const c of [main, big, small]) expect(row(facts, c.contract_id)).toMatchObject({ active: true, superseded: false });
    const html = text(renderKommun({ kod: '0862', stats, facts, statusMap: new Map([['0862', 'done']]), today: TODAY }));
    expect(html).toMatch(/Känt årsvärde 529 tkr/);
  });

  it('Tibro shape: a tillägg with no school forms never hides the main avtal', () => {
    const main = tieto('1472', { annual_value_sek: 300000, period_start: '2022-01-01', period_end: '2029-12-31' });
    const add = tieto('1472', { annual_value_sek: 20000, period_start: '2023-11-09', period_end: null });
    const facts = build([main, add], { coverage: covFor(main.contract_id, 'Edlevo', ['Förskola', ...F9, 'Gymnasiet']) });
    expect(row(facts, main.contract_id).superseded).toBe(false);
    expect(row(facts, add.contract_id).superseded).toBe(false);
  });

  it('Lilla Edet shape: a later vuxenutbildning system with no school forms and a lower value is an addition', () => {
    const main = tieto('1462', { annual_value_sek: 480000, period_start: '2021-01-01', period_end: '2027-12-31' });
    const vux = tieto('1462', { annual_value_sek: 80000, period_start: '2024-01-29', period_end: '2028-01-29' });
    const facts = build([main, vux], { coverage: covFor(main.contract_id, 'Edlevo', ALL) });
    expect(new Set(head(facts).map((f) => f.contract_id))).toEqual(new Set([main.contract_id, vux.contract_id]));
  });

  it('Färgelanda shape: the option for SchoolSoft\'s lärplattform does not replace the SchoolSoft avtal', () => {
    const main = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '1439', annual_value_sek: 110000, period_start: '2024-01-01', period_end: '2028-12-31', products: ['SchoolSoft'] });
    const opt = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '1439', annual_value_sek: 40000, period_start: '2025-05-09', period_end: null, products: ['SchoolSoft'] });
    const facts = build([main, opt], { coverage: [...covFor(main.contract_id, 'SchoolSoft', ALL), ...covFor(opt.contract_id, 'SchoolSoft', ALL)] });
    expect(row(facts, main.contract_id).superseded).toBe(false);
  });

  it('a re-signing at the same value (within 2 %) supersedes, even when the older still runs', () => {
    const old = C({ annual_value_sek: 100000, period_start: '2024-01-01', period_end: '2028-06-30', products: ['Binogi'] });
    const neu = C({ annual_value_sek: 101500, period_start: '2025-08-01', period_end: '2029-06-30', products: ['Binogi'] });
    const facts = build([old, neu], { coverage: [...covFor(old.contract_id, 'Binogi', F9), ...covFor(neu.contract_id, 'Binogi', F9)] });
    expect(row(facts, old.contract_id).superseded).toBe(true);
  });

  it('a different value supersedes only when the older ends within 92 days of the newer start', () => {
    const mk = (end) => {
      const old = C({ annual_value_sek: 100000, period_start: '2024-01-01', period_end: end, products: ['Binogi'] });
      const neu = C({ annual_value_sek: 150000, period_start: '2026-08-01', period_end: '2029-07-31', products: ['Binogi'] });
      const facts = build([old, neu], { coverage: [...covFor(old.contract_id, 'Binogi', F9), ...covFor(neu.contract_id, 'Binogi', F9)] });
      return row(facts, old.contract_id).superseded;
    };
    expect(mk('2026-10-31')).toBe(true); // 91 days after 2026-08-01
    expect(mk('2026-11-01')).toBe(true); // 92 days
    expect(mk('2026-11-02')).toBe(false); // 93 days
    expect(mk('2028-06-30')).toBe(false);
  });

  it('an older avtal with no end date is replaced only by a re-signing', () => {
    const r = { period_start: '2024-01-01', period_end: null, segments: F9, product_slugs: ['binogi'], annual_value_sek: 100000 };
    const s = { period_start: '2025-01-01', period_end: '2027-12-31', segments: F9, product_slugs: ['binogi'], active: true };
    expect(isRenewalOf(r, { ...s, annual_value_sek: 300000 })).toBe(false);
    expect(isRenewalOf(r, { ...s, annual_value_sek: 99000 })).toBe(true);
    expect(isRenewalOf({ ...r, annual_value_sek: null }, { ...s, annual_value_sek: 300000 })).toBe(true);
  });

  it('a newer avtal with no school forms never covers an older one that has them, even at the same value', () => {
    const r = { period_start: '2024-01-01', period_end: '2028-01-01', segments: F9, product_slugs: ['binogi'], annual_value_sek: 100000 };
    const s = { period_start: '2025-01-01', period_end: '2028-01-01', segments: [], product_slugs: ['binogi'], annual_value_sek: 100000, active: true };
    expect(isRenewalOf(r, s)).toBe(false);
    expect(isRenewalOf({ ...r, segments: [] }, s)).toBe(true);
  });

  it('of two copies of one avtal, the copy with school forms is kept', () => {
    const a = C({ vendor_name: 'Vklass', annual_value_sek: 200000, products: ['Vklass'] });
    const b = C({ vendor_name: 'Vklass', annual_value_sek: 200000, products: ['Vklass'] });
    const facts = build([a, b], { coverage: covFor(b.contract_id, 'Vklass', F9) });
    expect(row(facts, a.contract_id).duplicate_of).toBe(b.contract_id);
    expect(row(facts, b.contract_id)).toMatchObject({ superseded: false, segments: F9 });
  });
});
