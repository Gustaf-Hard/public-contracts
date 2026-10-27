import { describe, it, expect } from 'vitest';
import {
  buildStudioFacts, priceDistribution, whiteSpots, collectionStatus, dataBasis,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { companyBySlug } from '../src/catalogue.js';
import { renderKommun } from '../src/studio/pages/kommun.js';
import { renderLeverantor } from '../src/studio/pages/leverantor.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { consolidateByContract } from '../src/studio/pages/common.js';

// Regression tests for the final whole-branch review (items A to K).
// Hand-written fixtures only (the repo is public): real kommun codes (open
// data, so the tile map can place them) with made-up names, values and dates; company and product names come from the committed
// catalogue. Shapes mirror the cases the reviewers found, not their data.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 50 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126'];
const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries(KODS.map((kod, i) => [kod, {
      namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
      peers: KODS.filter((k) => k !== kod), elever: E,
    }])),
  },
});

let nextId = 1;
const C = (o = {}) => ({
  contract_id: nextId++,
  vendor_id: 1,
  vendor_name: 'ILT Inläsningstjänst AB',
  kommun_kod: '0114',
  kommun_namn: 'Testby 1',
  period_start: '2026-01-01',
  period_end: '2027-12-31',
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
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id, slug) => facts.find((f) => f.contract_id === id && (slug === undefined || f.company_slug === slug));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// ------------------------------------------------------------------ A
describe('A. only an active newer avtal supersedes, on like clocks', () => {
  it('IST shape: an inactive addendum with a later start and no end never hides the running main avtal', () => {
    const main = C({ vendor_name: 'IST', period_start: '2022-07-01', period_end: '2029-06-30', annual_value_sek: 2000000 });
    const add = C({ vendor_name: 'IST', period_start: '2022-07-31', period_end: null, annual_value_sek: null });
    const facts = build([main, add]);
    expect(row(facts, add.contract_id).active).toBe(false);
    expect(row(facts, main.contract_id)).toMatchObject({ active: true, superseded: false });
  });
  it('SchoolSoft shape: an expired avtal with a later start never hides one running to 2027', () => {
    const long = C({ vendor_name: 'SchoolSoft AB', period_start: '2021-07-01', period_end: '2027-06-30' });
    const old = C({ vendor_name: 'SchoolSoft AB', period_start: '2023-08-01', period_end: '2024-06-30' });
    const facts = build([long, old]);
    expect(row(facts, long.contract_id)).toMatchObject({ active: true, superseded: false });
  });
  it('ProReNata shape: same start, the ended one does not beat the one with no end date', () => {
    const ended = C({ vendor_name: 'ProReNata AB', period_start: '2023-06-13', period_end: '2024-06-13' });
    const open = C({ vendor_name: 'ProReNata AB', period_start: '2023-06-13', period_end: null });
    const facts = build([ended, open]);
    expect(row(facts, open.contract_id)).toMatchObject({ active: true, superseded: false });
    // Same start: neither is clearly newer (r2 P1), the ended one is simply expired.
    expect(row(facts, ended.contract_id)).toMatchObject({ active: false, superseded: false });
  });
  it('an undated avtal received later never hides a running avtal (received_at is not a period start)', () => {
    const running = C({ vendor_name: 'Teachiq', period_start: '2026-07-01', period_end: '2027-06-30', received_at: '2026-07-10T10:00:00Z' });
    const undated = C({ vendor_name: 'Teachiq', period_start: null, period_end: null, received_at: '2026-09-25T10:00:00Z' });
    const facts = build([running, undated]);
    expect(row(facts, running.contract_id)).toMatchObject({ active: true, superseded: false });
  });
  it('of two active avtal the later start still wins', () => {
    const a = C({ vendor_name: 'IST', period_start: '2024-01-01', period_end: '2027-12-31' });
    const b = C({ vendor_name: 'IST', period_start: '2025-01-01', period_end: '2027-12-31' });
    const facts = build([a, b]);
    expect(row(facts, a.contract_id).superseded).toBe(true);
    expect(row(facts, b.contract_id).superseded).toBe(false);
  });
});

// ------------------------------------------------------------------ B
describe('B. kr/elev only for prices comparable per elev', () => {
  const seg = (id, name) => ['4-6', '7-9'].map((g) => COV(id, name, g, 0));
  it('Natur & Kultur "Lärarens guide" per_user is never divided by every pupil', () => {
    const c = C({ vendor_name: 'Natur & Kultur', pricing_model: 'per_user', annual_value_sek: 106, products: ['Lärarens guide till hem- och konsumentkunskap'] });
    const facts = build([c], { coverage: seg(c.contract_id, 'Lärarens guide till hem- och konsumentkunskap') });
    // elever_in_scope is the pupils the avtal covers (r2 P5: spend per elev
    // uses it for any model); the price per elev stays unknown.
    expect(row(facts, c.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: null, elever_in_scope: 600 });
  });
  it('Haldor staff licence: a personallicens line blocks value per elev even on a fixed avtal', () => {
    const c = C({ vendor_name: 'Haldor', pricing_model: 'fixed', annual_value_sek: 60000 });
    const facts = build([c], {
      lineItems: [LI(c.contract_id, 'Licenser Haldor Education', 60000, { unit: 'personallicens', unit_price_sek: 1000, quantity: 60, period_months: 12 })],
      coverage: seg(c.contract_id, 'Haldor Education'),
    });
    expect(row(facts, c.contract_id).kr_per_elev).toBeNull();
  });
  it('per_user, usage and one_time avtal get no kr/elev; per_student, fixed and tiered do', () => {
    const models = ['per_user', 'usage', 'one_time', 'per_student', 'fixed', 'tiered'];
    const cs = models.map((m) => C({ pricing_model: m, products: ['Polylino'] }));
    const facts = build(cs, { coverage: cs.flatMap((c) => seg(c.contract_id, 'Polylino')) });
    const kpe = Object.fromEntries(cs.map((c, i) => [models[i], row(facts, c.contract_id).kr_per_elev]));
    expect(kpe).toEqual({ per_user: null, usage: null, one_time: null, per_student: 166.67, fixed: 166.67, tiered: 166.67 });
  });
  it('a null pricing model needs the avtal unit to be elev', () => {
    const plain = C({ pricing_model: null, products: ['Polylino'] });
    const perElev = C({ pricing_model: null, unit: 'elev', products: ['Polylino'] });
    const facts = build([plain, perElev], { coverage: [...seg(plain.contract_id, 'Polylino'), ...seg(perElev.contract_id, 'Polylino')] });
    expect(row(facts, plain.contract_id).kr_per_elev).toBeNull();
    expect(row(facts, perElev.contract_id).kr_per_elev).toBe(166.67);
  });
});

// ------------------------------------------------------------------ C
describe('C. free and 0 kr are not price points', () => {
  const seg = (id) => ['4-6', '7-9'].map((g) => COV(id, 'Polylino', g, 0));
  it('a free avtal and a fixed 0 kr avtal keep their value but get no kr/elev and stay out of distributions', () => {
    const free = C({ pricing_model: 'free', annual_value_sek: 0, products: ['Polylino'] });
    const zero = C({ kommun_kod: '0115', annual_value_sek: 0, products: ['Polylino'] });
    const facts = build([free, zero], { coverage: [...seg(free.contract_id), ...seg(zero.contract_id)] });
    expect(row(facts, free.contract_id)).toMatchObject({ annual_value_sek: 0, kr_per_elev: null });
    expect(row(facts, zero.contract_id)).toMatchObject({ annual_value_sek: 0, kr_per_elev: null });
    expect(priceDistribution(facts, { productSlug: 'polylino' }).n).toBe(0);
  });
  it('a channel remainder of 0 creates no channel row', () => {
    const c = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000 });
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Polylino', 60000), LI(c.contract_id, 'Magma', 40000)] });
    expect(facts.map((f) => f.company_slug).sort()).toEqual(['ilt', 'radish']);
    expect(facts.every((f) => f.channel_slug === 'laromedia')).toBe(true);
  });
  it('ILT shape: a vendor naming its own product with nothing left over has an unknown value, not 0 kr/elev', () => {
    const c = C({ vendor_name: 'ILT Inläsningstjänst AB', annual_value_sek: 5200, products: ['Inlästa läromedel'] });
    const facts = build([c], {
      lineItems: [LI(c.contract_id, 'Kide Science', 5200, { period_months: 12 })],
      coverage: ['4-6', '7-9'].map((g) => COV(c.contract_id, 'Inlästa läromedel', g, 0)),
    });
    expect(row(facts, c.contract_id, 'ilt')).toMatchObject({ annual_value_sek: null, value_basis: null, kr_per_elev: null });
    expect(row(facts, c.contract_id, 'kide-science').annual_value_sek).toBe(5200);
  });
});

// ------------------------------------------------------------------ D
describe('D. unit prices are annualised by what the line says', () => {
  const quiculum = (line, o = {}) => {
    const c = C({ vendor_name: 'Quiculum', pricing_model: 'tiered', annual_value_sek: 40920, ...o });
    return row(build([c], { lineItems: [LI(c.contract_id, 'Quiculum', line.amount ?? null, line)] }), c.contract_id);
  };
  it('Quiculum shape: 10 kr x 341 elever x 12 = the line amount, so the price is monthly: 120 kr/elev', () => {
    const f = quiculum({ unit: 'elev', unit_price_sek: 10, quantity: 341, amount: 40920, period_months: 12 });
    expect(f).toMatchObject({ kr_per_elev: 120, kr_per_elev_basis: 'styckpris' });
  });
  it('an explicit per-month unit is scaled to a year', () => {
    expect(quiculum({ unit: 'elev/månad', unit_price_sek: 10, period_months: 12 }).kr_per_elev).toBe(120);
  });
  it('an annual unit price whose amount matches stays as it is', () => {
    expect(quiculum({ unit: 'elev', unit_price_sek: 120, quantity: 341, amount: 40920, period_months: 12 }).kr_per_elev).toBe(120);
  });
  it('36 months: 300 kr x 100 elever = the line amount, so it is the price for the period: 100 kr/elev and year', () => {
    const f = quiculum({ unit: 'elev', unit_price_sek: 300, quantity: 100, amount: 30000, period_months: 36 }, { annual_value_sek: 10000 });
    expect(f).toMatchObject({ kr_per_elev: 100, kr_per_elev_basis: 'styckpris' });
  });
  it('36 months with nothing to check against is ambiguous: not a styckpris', () => {
    const f = quiculum({ unit: 'elev', unit_price_sek: 300, period_months: 36 }, { annual_value_sek: 10000 });
    expect(f.kr_per_elev_basis).not.toBe('styckpris');
  });
});

// ------------------------------------------------------------------ E
describe('E. price distributions count kommuner, not owner rows', () => {
  const PRODUCTS = ['Polylino', 'Magma', 'Binogi', 'Gleerups', 'Kide Science'];
  it('one Läromedia avtal naming five owners in one kommun is n = 1, suppressed', () => {
    const c = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000 });
    const lines = PRODUCTS.map((p, i) => LI(c.contract_id, p, 20000, { unit: 'elev', unit_price_sek: 100 + i * 10, quantity: 200, period_months: 12 }));
    const facts = build([c], { lineItems: lines });
    expect(facts.filter((f) => f.kr_per_elev != null)).toHaveLength(5);
    const d = priceDistribution(facts, { category: 'laromedel' });
    expect(d).toMatchObject({ n: 1, suppressed: true, values: [] });
  });
  it('a kommun with two priced avtal is one point at its own median', () => {
    const cs = [
      C({ kommun_kod: '0114', unit: 'elev', unit_price_sek: 100, products: ['Polylino'] }),
      C({ kommun_kod: '0114', vendor_name: 'Radish AB', unit: 'elev', unit_price_sek: 300, products: ['Magma'] }),
      // Distinct values: one samverkansavtal otherwise (r2 P2).
      ...['0115', '0117', '0120', '0123'].map((kod, i) => C({ kommun_kod: kod, unit: 'elev', unit_price_sek: 150, annual_value_sek: 100010 + i * 10, products: ['Polylino'] })),
    ];
    const d = priceDistribution(build(cs), { category: 'laromedel' });
    expect(d.n).toBe(5);
    expect(d.n_avtal).toBe(6);
    expect(d.values.find((v) => v.kommun_kod === '0114').kr_per_elev).toBe(200);
  });
});

// ------------------------------------------------------------------ F, G, H, K
const splitAvtal = (o = {}) => C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, ...o });

describe('G. kommun page totals and evidence add up every owner row of an avtal', () => {
  it('100 000 split 20/30/50 shows 100 tkr, känd för 1 av 1', () => {
    const c = splitAvtal();
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Polylino', 30000), LI(c.contract_id, 'Magma', 50000)] });
    expect(facts.map((f) => f.annual_value_sek).sort((a, b) => a - b)).toEqual([20000, 30000, 50000]);
    const html = text(renderKommun({ kod: '0114', stats, facts, statusMap: new Map([['0114', 'open']]), today: TODAY }));
    expect(html).toMatch(/Känt årsvärde 100 tkr känd för 1 av 1 avtal/);
    expect(html).toContain('100 tkr/år');
    expect(html).not.toMatch(/Känt årsvärde 20 tkr/);
  });
  it('consolidateByContract names the avtal vendor even when its own row was dropped', () => {
    const c = splitAvtal();
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Polylino', 60000), LI(c.contract_id, 'Magma', 40000)] });
    const [one] = consolidateByContract(facts);
    expect(one).toMatchObject({ company_slug: 'laromedia', company_name: 'LäroMedia Bokhandel Örebro', annual_value_sek: 100000, kr_per_elev: null });
    expect(one.product_slugs.sort()).toEqual(['magma', 'polylino']);
  });
});

describe('H. a reseller page counts the avtal it is the vendor of', () => {
  const company = companyBySlug('laromedia');
  it('a fully allocated avtal (zero remainder) and a partly allocated one both count, at their whole value', () => {
    const full = splitAvtal({ kommun_kod: '0114' });
    // A different value: the same vendor, dates and value in two kommuner
    // would be one samverkansavtal (r2 P2).
    const part = splitAvtal({ kommun_kod: '0115', annual_value_sek: 90000 });
    const facts = build([full, part], {
      lineItems: [
        LI(full.contract_id, 'Polylino', 60000), LI(full.contract_id, 'Magma', 40000),
        LI(part.contract_id, 'Polylino', 30000),
      ],
    });
    expect(facts.some((f) => f.contract_id === full.contract_id && f.company_slug === 'laromedia')).toBe(false);
    const raw = renderLeverantor({ company, facts, stats, statusMap: new Map(), today: TODAY });
    const html = text(raw);
    expect(html).toContain('har aktiva avtal med 2 kommuner i vårt underlag, värda minst 190 tkr per år i underlaget.');
    expect(html).toMatch(/2 aktiva, 0 utgångna eller ersatta/);
    expect(raw).toContain('aria-label="Testby 1: aktivt avtal med LäroMedia Bokhandel Örebro i underlaget');
    expect(raw).toContain('aria-label="Testby 2: aktivt avtal med LäroMedia Bokhandel Örebro i underlaget');
  });
  it('a reseller product inside another vendor\'s avtal counts only its own row, never that avtal\'s whole value', () => {
    const own = C({ vendor_name: 'Skolon AB', kommun_kod: '0114', annual_value_sek: 50000, products: ['Skolon'] });
    const other = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '0115', annual_value_sek: 400000, products: ['SchoolSoft', 'Skolon'] });
    const facts = build([own, other], { lineItems: [LI(other.contract_id, 'SchoolSoft', 380000), LI(other.contract_id, 'Skolon', 20000)] });
    expect(row(facts, other.contract_id, 'skolon').annual_value_sek).toBe(20000);
    const html = text(renderLeverantor({ company: companyBySlug('skolon'), facts, stats, statusMap: new Map(), today: TODAY }));
    expect(html).toContain('har aktiva avtal med 2 kommuner i vårt underlag, värda minst 70 tkr per år i underlaget.');
  });
});

// K was reworked in round 2 (P5): spend per elev uses the avtal's own school
// forms, not F-9; see tests/studio-final-fixes-r2.test.js.

describe('F. segment matrices say multi-segment avtal count in each segment', () => {
  it('kategori matrix carries the note', () => {
    const facts = build([C({ products: ['Polylino'] })]);
    const html = renderKategori({ category: findCategory('laromedel'), facts, stats, statusMap: new Map(), today: TODAY });
    expect(text(html)).toContain('Ett avtal som gäller flera segment räknas i varje segment det omfattar.');
  });
});

// ------------------------------------------------------------------ I
describe('I. dead_end is not evidence of absence', () => {
  const status = collectionStatus([
    { kommun_kod: '0114', state: 'DONE' },
    { kommun_kod: '0115', state: 'DEAD_END' },
    { kommun_kod: '0117', state: 'DONE' },
  ], { kodsWithAvtal: new Set(['0114', '0117']) });
  const facts = build([
    C({ kommun_kod: '0114', period_start: '2020-01-01', period_end: '2022-12-31', products: ['Polylino'] }), // expired only
    C({ kommun_kod: '0117', products: ['Polylino'] }),
  ]);
  it('whiteSpots keeps dead_end as a status, never klar, and flags kommuner with only expired avtal', () => {
    const ws = whiteSpots(facts, status, { category: 'laromedel', allKods: ['0114', '0115', '0117'] });
    // r4 W1: buckets say what the underlag holds; dead_end is a status.
    expect(ws).toMatchObject({ has: ['0117'], expired: ['0114'], none: ['0115'] });
    expect(ws.status.get('0115')).toBe('dead_end');
    expect(dataBasis(facts, status)).toMatchObject({ done: 2, dead_end: 1 });
  });
  it('kategori page: a dead_end kommun is the same "inget avtal i underlaget" tile, its status in the name, no claim', () => {
    const html = renderKategori({ category: findCategory('laromedel'), facts, stats, statusMap: status, today: TODAY });
    const t = text(html);
    expect(t).toMatch(/\d+ kommuner har inget avtal i läromedel i underlaget\./);
    expect(t).toContain('1 utan utlämnade avtal');
    expect(t).toContain('1 kommun har bara utgångna eller ersatta avtal i läromedel i underlaget.');
    expect(t).not.toContain('har lämnat ut sina avtal');
    expect(html).toMatch(/class="tile t-none[^"]*"[^>]*aria-label="Testby 2: inget avtal i läromedel i underlaget; inga avtal utlämnade/);
    expect(html).not.toContain('t-refused');
  });
});

// ------------------------------------------------------------------ J
describe('J. add-on and integration lines never create owners', () => {
  it('"Integration ProReNata" on a Unikum avtal stays Unikum, with no channel', () => {
    const c = C({ vendor_name: 'Unikum', annual_value_sek: 100000, products: ['Unikum'] });
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Unikum', 100000), LI(c.contract_id, 'Integration ProReNata', 0)] });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ company_slug: 'unikum', channel_slug: null, annual_value_sek: 100000 });
  });
  it('a Skola24 setup fee on a Haldor avtal is Haldor money, not a Nova Software avtal', () => {
    const c = C({ vendor_name: 'Haldor', annual_value_sek: 120000, products: ['Haldor Education'] });
    const facts = build([c], {
      lineItems: [LI(c.contract_id, 'Haldor Education', 100000, { period_months: 12 }), LI(c.contract_id, 'Uppstart integration Skola24', 20000, { period_months: 12 })],
    });
    expect(facts.map((f) => f.company_slug)).toEqual(['haldor']);
    expect(facts[0].annual_value_sek).toBe(120000);
  });
  it('a reseller line naming a company outright still opens that owner', () => {
    const c = C({ vendor_name: 'Atea', annual_value_sek: null, products: ['Adobelicenser'] });
    expect(build([c]).map((f) => f.company_slug)).toContain('adobe');
  });
});
