import { describe, it, expect } from 'vitest';
import {
  buildStudioFacts, companyShares, marketByCategory, dataBasis, collectionStatus, whiteSpots,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renderKommun, perElevByCategory, withOwnPoint } from '../src/studio/pages/kommun.js';
import { priceDistribution } from '../src/studio-data.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { renderKommuner } from '../src/studio/pages/lists.js';

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
  // 'a later avtal with no known segments still replaces one with segments'
  // was removed in round 3 (R1): a tilläggsavtal has that shape. See
  // studio-final-fixes-r3.test.js.
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
  // The elever split (GGVV, kommun share, even split) was replaced in round
  // 3 (R3): a samverkansavtal is shown whole with "andel okänd" and gives no
  // price per elev. See studio-final-fixes-r3.test.js.
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

// ------------------------------------------------------------------ P8
describe('P8. an annual value derived from a monthly unit price is x 12', () => {
  it('per_student, elev/månad, 10 kr x 500 elever and no stated value: 60 000 kr a year, 120 kr/elev', () => {
    const c = C({ vendor_name: 'Quiculum', pricing_model: 'per_student', unit: 'elev/månad', unit_price_sek: 10, quantity: 500, annual_value_sek: null });
    expect(row(build([c]), c.contract_id)).toMatchObject({ annual_value_sek: 60000, kr_per_elev: 120, kr_per_elev_basis: 'styckpris' });
  });
});
describe('P8. the unit period rule is shared', () => {
  it('a "huvudman" unit is not a monthly price', () => {
    const c = C({ vendor_name: 'Quiculum', pricing_model: 'per_student', annual_value_sek: 40000 });
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Quiculum', 40000, { unit: 'elev huvudman', unit_price_sek: 100, quantity: 400, period_months: 12 })] });
    expect(row(facts, c.contract_id).kr_per_elev).toBe(100);
  });
});

// ------------------------------------------------------------------ P3
describe('P3. Chas Visual Management is a channel, not Unikum', () => {
  it('a Chas avtal with an Alvis line and a Unikum line books each to its owner, Chas as the channel', () => {
    const c = C({ vendor_name: 'Chas Visual Management AB', annual_value_sek: 300000, products: [] });
    const facts = build([c], {
      lineItems: [
        LI(c.contract_id, 'Alvis elevadministration vuxenutbildning', 200000, { period_months: 12 }),
        LI(c.contract_id, 'Unikum Grundskola - Start Kommun', 100000, { period_months: 12 }),
      ],
    });
    const by = Object.fromEntries(facts.map((f) => [f.company_slug, f]));
    expect(Object.keys(by).sort()).toEqual(['gotit', 'unikum']);
    expect(by.gotit).toMatchObject({ annual_value_sek: 200000, channel_slug: 'chas', category: 'skoladministration' });
    expect(by.unikum).toMatchObject({ annual_value_sek: 100000, channel_slug: 'chas', category: 'larplattform' });
    expect(companyShares(facts, { category: 'larplattform' }).map((s) => [s.slug, s.value_known_sek])).toEqual([['unikum', 100000]]);
  });
  it('a Chas avtal reselling Royal Schedule never becomes Unikum value', () => {
    const c = C({ vendor_name: 'Chas Visual Management AB', annual_value_sek: 96000, products: ['Royal Schedule'] });
    const facts = build([c], { lineItems: [LI(c.contract_id, 'Abonnemangsavgift', 96000, { period_months: 12 })] });
    expect(facts.some((f) => f.company_slug === 'unikum')).toBe(false);
    expect(facts.find((f) => f.company_slug === 'chas')).toMatchObject({ annual_value_sek: 96000, value_basis: 'unsplit_channel', category: 'skoladministration' });
  });
});

// ------------------------------------------------------------------ P4, P7
describe('P4. a safe white spot has no avtal at all in the category', () => {
  const status = new Map(['0114', '0115', '0117', '0120'].map((k) => [k, 'done']));
  const facts = build([
    C({ kommun_kod: '0114', vendor_name: 'Vklass AB', period_start: '2018-01-01', period_end: '2021-12-31', products: ['Vklass'] }), // expired only
    C({ kommun_kod: '0115', vendor_name: 'Okänd Firma AB', products: [] }), // active, unknown category
    C({ kommun_kod: '0120', vendor_name: 'Vklass AB', products: ['Vklass'] }), // active
  ]);
  it('buckets: expired-only and unknown-category kommuner are not safe', () => {
    const ws = whiteSpots(facts, status, { category: 'larplattform', allKods: ['0114', '0115', '0117', '0120'] });
    expect(ws).toMatchObject({ has: ['0120'], none_done: ['0117'], none_done_expired: ['0114'], none_done_uncertain: ['0115'] });
  });
  it('without a category, unknown-category avtal are not a reason to doubt (footprint maps)', () => {
    const ws = whiteSpots(facts.filter((f) => f.company_slug === 'vklass'), status, { allKods: ['0114', '0115', '0117', '0120'] });
    expect(ws.none_done).toEqual(['0115', '0117']);
  });
  it('kategori page: the KPI counts the safe ones, expired get their own tile and sales copy', () => {
    const html = renderKategori({ category: findCategory('larplattform'), facts, stats, statusMap: status, today: TODAY });
    const t = text(html);
    expect(t).toContain('1 kommun har klar insamling och inga avtal alls i lärplattform.');
    expect(t).toContain('1 kommun har klar insamling där avtalet i lärplattform har löpt ut eller ersatts.');
    expect(t).toContain('ett läge att höra av sig');
    expect(t).toContain('1 kommun med klar insamling har aktiva avtal med okänd kategori');
    expect(t).toMatch(/Säkra vita fläckar 1 kommuner insamlingen klar, inga avtal alls i kategorin; räknas inte: 1 där avtalet har löpt ut, 1 med avtal av okänd kategori/);
    expect(html).toMatch(/class="tile t-expired[^"]*"[^>]*aria-label="Testby 1: avtalet i lärplattform har löpt ut/);
  });
});

describe('P7. any DEAD_END means the collection is not complete evidence of absence', () => {
  const convs = [
    { kommun_kod: '0114', state: 'DONE' }, { kommun_kod: '0114', state: 'DEAD_END' },
    { kommun_kod: '0115', state: 'DONE' },
  ];
  const facts = build([C({ kommun_kod: '0114', vendor_name: 'ILT Inläsningstjänst AB', products: ['Polylino'] })]);
  const status = collectionStatus(convs, { kodsWithAvtal: new Set(facts.map((f) => f.kommun_kod)) });
  it('DONE + DEAD_END with one läromedel avtal is partial, not a safe white spot for lärplattform', () => {
    expect(status.get('0114')).toBe('partial');
    const ws = whiteSpots(facts, status, { category: 'larplattform', allKods: ['0114', '0115'] });
    expect(ws.none_done).toEqual(['0115']);
    expect(ws.partial).toEqual(['0114']);
    expect(dataBasis(facts, status)).toMatchObject({ done: 1, partial: 1, dead_end: 0 });
  });
  it('the kommun page says delvis utlämnat, the directory counts it apart from klar', () => {
    const k = text(renderKommun({ kod: '0114', stats, facts, statusMap: status, today: TODAY }));
    expect(k).toContain('Delvis utlämnat');
    expect(k).not.toContain('Insamling klar');
    const list = text(renderKommuner({ facts, stats, statusMap: status, tiles: { cols: 1, rows: 1, tiles: {} } }));
    expect(list).toMatch(/Insamling klar 1 och 1 delvis utlämnade/);
    expect(list).toContain('1 har lämnat ut en del men inte alla');
  });
  it('a partial peer is not a peer with finished collection', () => {
    const peerConvs = [...KODS.slice(1).map((k) => ({ kommun_kod: k, state: 'DONE' })), { kommun_kod: '0115', state: 'DEAD_END' }];
    const st = collectionStatus(peerConvs, { kodsWithAvtal: new Set(KODS) });
    const html = text(renderKommun({ kod: '0114', stats, facts, statusMap: st, today: TODAY }));
    expect(html).toContain('bara de 5 av 6 där insamlingen är klar');
  });
});

// ------------------------------------------------------------------ P5
describe('P5. spend per elev divides by the elever in the school forms the avtal cover', () => {
  const kod = '0114';
  const rows = () => {
    const poly = C({ vendor_name: 'ILT Inläsningstjänst AB', annual_value_sek: 100000, products: ['Polylino'] });
    const gy = C({ annual_value_sek: 40000, products: ['Binogi'] });
    const noSeg = C({ vendor_name: 'Gleerups', annual_value_sek: 50000, products: ['Gleerups digitala läromedel'] });
    return build([poly, gy, noSeg], {
      coverage: [...covFor(poly.contract_id, 'Polylino', F9), ...covFor(gy.contract_id, 'Binogi', ['Gymnasiet'])],
    });
  };
  it('F-9 avtal plus a gymnasium avtal: 140 000 kr over 1 000 + 800 elever, the avtal without school forms is left out', () => {
    const m = perElevByCategory(rows(), { eleverIn: (segs) => stats.eleverIn(kod, segs) }).get('laromedel');
    expect(m).toMatchObject({ value: 140000, elever: 1800, counted: 2, leftOut: 1 });
    expect(m.perElev).toBeCloseTo(77.78, 2);
  });
  it('two avtal for the same pupils are not twice the pupils', () => {
    const a = C({ vendor_name: 'ILT Inläsningstjänst AB', annual_value_sek: 60000, products: ['Polylino'] });
    const b = C({ annual_value_sek: 40000, products: ['Binogi'] });
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'Polylino', F9), ...covFor(b.contract_id, 'Binogi', F9)] });
    expect(perElevByCategory(facts, { eleverIn: (segs) => stats.eleverIn(kod, segs) }).get('laromedel').perElev).toBe(100);
  });
  it('for peers a category with any avtal left out is dropped', () => {
    expect(perElevByCategory(rows(), { eleverIn: (segs) => stats.eleverIn(kod, segs), completeOnly: true }).has('laromedel')).toBe(false);
  });
  it('the page names the basis and how many avtal were left out', () => {
    const html = text(renderKommun({ kod, stats, facts: rows(), statusMap: new Map([[kod, 'done']]), today: TODAY }));
    expect(html).toContain('Känt årsvärde per elev i de skolformer avtalen gäller');
    expect(html).toContain('1 utan känt värde eller skolformer räknas inte');
    expect(html).toContain('78 kr/elev');
    expect(html).not.toContain('gäller inte F-9');
  });
});

// ------------------------------------------------------------------ P6
describe('P6. the kommun\'s own price is not part of its peer benchmark', () => {
  const priced = (kommun_kod, price) => C({ kommun_kod, vendor_name: 'ILT Inläsningstjänst AB', pricing_model: 'per_student', unit: 'elev', unit_price_sek: price, annual_value_sek: price * 1000 + Number(kommun_kod), products: ['Polylino'] });
  it('peers 100 to 500 have median 300; a kommun paying 1 000 still sees 300', () => {
    const facts = build([priced('0114', 1000), ...['0115', '0117', '0120', '0123', '0125'].map((k, i) => priced(k, 100 * (i + 1)))]);
    const peers = priceDistribution(facts, { productSlug: 'polylino', kommunKods: ['0115', '0117', '0120', '0123', '0125'] });
    const shown = withOwnPoint(peers, '0114', 1000);
    expect(shown).toMatchObject({ n: 5, median: 300, p25: 200, p75: 400, max: 1000 });
    expect(shown.values).toHaveLength(6);
    const html = renderKommun({ kod: '0114', stats, facts, statusMap: new Map(), today: TODAY });
    const card = html.slice(html.indexOf('class="card kp-row"'));
    expect(card).toContain('median <b>300 kr/elev</b>');
    expect(card).not.toContain('median <b>350 kr/elev</b>');
    expect(card).toMatch(/is-highlight[^>]*><title>Testby 1: 1\s?000 kr\/elev/);
  });
});

// ------------------------------------------------------------------ P9
describe('P9. the kommun price list shows every priced owner row', () => {
  it('ILT and Magma inside one Läromedia avtal both appear; the KPI counts one avtal', () => {
    const c = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000 });
    const facts = build([c], {
      lineItems: [
        LI(c.contract_id, 'Polylino', 60000, { unit: 'elev', unit_price_sek: 60, quantity: 1000, period_months: 12 }),
        LI(c.contract_id, 'Magma', 20000, { unit: 'elev', unit_price_sek: 100, quantity: 200, period_months: 12 }),
      ],
    });
    const html = text(renderKommun({ kod: '0114', stats, facts, statusMap: new Map([['0114', 'done']]), today: TODAY }));
    expect(html).not.toContain('Inget av avtalen anger pris per elev');
    expect(html).toContain('Polylino');
    expect(html).toContain('Magma');
    expect(html).toContain('via LäroMedia Bokhandel Örebro');
    expect(html).toMatch(/Pris per elev känt 1 av 1 aktiva avtal, 2 priser i dem/);
    expect(html).toContain('Går att jämföra okänt För få jämförbara kommuner');
  });
});
