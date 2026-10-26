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

// ------------------------------------------------------------------ V1
describe('V1. a kommun\'s price for a product is one avtal\'s own price, never a sum', () => {
  const magma = (o) => C({ vendor_name: 'Radish AB', pricing_model: 'per_student', products: ['Magma'], ...o });

  it('two analyses of one document at 120 kr give one point at 120 (the Haparanda shape)', () => {
    const a = magma({ annual_value_sek: 106920, size_bytes: 777001, period_start: '2025-02-01', summary: 'Huvudavtal om Magma.' });
    const b = magma({ annual_value_sek: 133920, size_bytes: 777001, period_start: '2025-03-01', summary: 'Huvudavtal om Magma, inläst igen.' });
    const facts = build([a, b], {
      lineItems: [perElev(a.contract_id, 'Magma', 120), perElev(b.contract_id, 'Magma', 120)],
      coverage: [...covFor(a.contract_id, 'Magma', F9), ...covFor(b.contract_id, 'Magma', F9)],
    });
    expect(points(facts, 'magma').map((f) => [f.contract_id, f.kr_per_elev])).toEqual([[b.contract_id, 120]]);
    expect(row(facts, a.contract_id).kr_per_elev_basis).toBe('annat_avtal');
    const t = text(renderKommun({ kod: '0114', stats, facts, statusMap: done(['0114']), today: TODAY }));
    expect(t).toContain('120 kr per elev och år, ert pris');
    expect(t).not.toMatch(/21[0-9] kr per elev/);
  });

  it('a tillägg that changes the price terms never raises the price (the Lysekil shape)', () => {
    const main = magma({ annual_value_sek: 34650, summary: 'Avtal om Magma.' });
    const add = magma({ annual_value_sek: 50000, period_start: '2025-06-01', summary: 'Tilläggsavtal som justerar prisvillkoren för Magma.' });
    const facts = build([main, add], { lineItems: [perElev(main.contract_id, 'Magma', 90)], coverage: covFor(main.contract_id, 'Magma', F9) });
    expect(points(facts, 'magma').map((f) => f.kr_per_elev)).toEqual([90]);
    expect(row(facts, add.contract_id).kr_per_elev).toBeNull();
  });

  it('two schools\' orders for the same school forms: the larger avtal\'s price, not a blend (the Ystad shape)', () => {
    const sli = (o) => C({ vendor_name: 'SLI Education AB', pricing_model: 'per_student', products: ['SLI Play'], ...o });
    const a = sli({ annual_value_sek: 19470, period_start: '2025-02-01', summary: 'Skola A beställer SLI Play.' });
    const b = sli({ annual_value_sek: 20010, period_start: '2025-03-01', summary: 'Skola B beställer SLI Play.' });
    const facts = build([a, b], {
      lineItems: [perElev(a.contract_id, 'SLI Play', 59), perElev(b.contract_id, 'SLI Play', 69)],
      coverage: [...covFor(a.contract_id, 'SLI Play', F9), ...covFor(b.contract_id, 'SLI Play', F9)],
    });
    expect(points(facts, 'sli-play').map((f) => [f.contract_id, f.kr_per_elev])).toEqual([[b.contract_id, 69]]);
    expect(row(facts, a.contract_id).kr_per_elev_basis).toBe('annat_avtal');
  });

  it('a bundle\'s Polylino price is unchanged by Inlästa and Begreppa avtal, and they keep their own points (the Klippan shape)', () => {
    const bundle = C({ vendor_name: 'ILT Education AB', pricing_model: 'per_student', annual_value_sek: 291330, products: ['Polylino', 'Inlästa läromedel', 'Begreppa'] });
    const inl = C({ vendor_name: 'ILT Education AB', pricing_model: 'per_student', annual_value_sek: 56000, period_start: '2025-02-01', products: ['Inlästa läromedel'] });
    const beg = C({ vendor_name: 'ILT Education AB', pricing_model: 'per_student', annual_value_sek: 12000, period_start: '2025-03-01', products: ['Begreppa'] });
    const facts = build([bundle, inl, beg], {
      lineItems: [perElev(bundle.contract_id, 'Polylino', 90), perElev(inl.contract_id, 'Inlästa läromedel', 65), perElev(beg.contract_id, 'Begreppa', 120)],
      coverage: [...covFor(bundle.contract_id, 'Polylino', F9), ...covFor(inl.contract_id, 'Inlästa läromedel', ['Gymnasiet']), ...covFor(beg.contract_id, 'Begreppa', ['Komvux'])],
    });
    expect(row(facts, bundle.contract_id)).toMatchObject({ kr_per_elev: 90, kr_per_elev_product_slug: 'polylino' });
    expect(points(facts, 'inlasta-laromedel').map((f) => f.kr_per_elev)).toEqual([65]);
    expect(points(facts, 'begreppa').map((f) => f.kr_per_elev)).toEqual([120]);
  });

  it('a multi-product row prices only its own product: a Polyglutt avtal neither raises Polylino nor loses its point (Codex r5 new#1)', () => {
    const both = C({ vendor_name: 'ILT Education AB', pricing_model: 'per_student', annual_value_sek: 30000, products: ['Polylino', 'Polyglutt'] });
    const glutt = C({ vendor_name: 'ILT Education AB', annual_value_sek: 10000, period_start: '2025-02-01', products: ['Polyglutt'] });
    const facts = build([both, glutt], {
      lineItems: [perElev(both.contract_id, 'Polylino', 100)],
      coverage: [...covFor(both.contract_id, 'Polylino', ['1-3']), ...covFor(glutt.contract_id, 'Polyglutt', ['1-3'])],
    });
    expect(points(facts, 'polylino').map((f) => f.kr_per_elev)).toEqual([100]);
    expect(points(facts, 'polyglutt').map((f) => f.kr_per_elev)).toEqual([33.33]); // 10 000 over 300 elever in 1-3
  });

  it('the avtal\'s own elevantal basis is kept: no denominator switch (the Göteborg Alvis shape)', () => {
    const alvis = (o) => C({ vendor_name: 'Göteborgs IT Konsult Gotit AB', products: ['Alvis'], ...o });
    const big = alvis({ annual_value_sek: 401500, summary: 'Alvis för yrkeshögskolan.' });
    const small = alvis({ annual_value_sek: 248400, period_start: '2025-02-01', summary: 'Alvis för prövning inom komvux.' });
    const facts = build([big, small], { coverage: [...covFor(big.contract_id, 'Alvis', ['Gymnasiet'], 4500), ...covFor(small.contract_id, 'Alvis', ['Komvux'], 2000)] });
    expect(points(facts, 'alvis').map((f) => [f.contract_id, f.kr_per_elev, f.kr_per_elev_basis])).toEqual([[big.contract_id, 89.22, 'avtalets_elevantal']]);
    expect(row(facts, small.contract_id).kr_per_elev).toBeNull();
  });

  it('a Komvux avtal under the same product does not dilute the F-9 price (the Landskrona shape)', () => {
    const main = C({ annual_value_sek: 120000, products: ['Binogi'], summary: 'Binogi för grundskolan.' });
    const vux = C({ annual_value_sek: 5000, period_start: '2025-02-01', products: ['Binogi'], summary: 'Språkprojekt för komvux.' });
    const facts = build([main, vux], { coverage: [...covFor(main.contract_id, 'Binogi', F9), ...covFor(vux.contract_id, 'Binogi', ['Komvux'])] });
    expect(points(facts, 'binogi').map((f) => f.kr_per_elev)).toEqual([133.33]); // 120 000 over 900 elever
  });

  it('the same list price for grundskola and komvux stays the list price (the Hjo and Hörby shape)', () => {
    const inl = (o) => C({ vendor_name: 'ILT Education AB', pricing_model: 'per_student', products: ['Inlästa läromedel'], ...o });
    const a = inl({ annual_value_sek: 60660, summary: 'Inlästa läromedel för grundskolan.' });
    const b = inl({ annual_value_sek: 4718, period_start: '2025-02-01', summary: 'Inlästa läromedel för komvux.' });
    const facts = build([a, b], {
      lineItems: [perElev(a.contract_id, 'Inlästa läromedel', 67.4), perElev(b.contract_id, 'Inlästa läromedel', 67.4)],
      coverage: [...covFor(a.contract_id, 'Inlästa läromedel', F9), ...covFor(b.contract_id, 'Inlästa läromedel', ['Komvux'])],
    });
    expect(points(facts, 'inlasta-laromedel').map((f) => f.kr_per_elev)).toEqual([67.4]);
    expect(priceDistribution(facts, { productSlug: 'inlasta-laromedel' }).n_avtal).toBe(1);
  });

  it('Y1: a lone tilläggsavtal with a styckpris has no price point', () => {
    const add = C({ vendor_name: 'SchoolSoft AB', pricing_model: 'per_student', annual_value_sek: 4500, products: ['SchoolSoft'], summary: 'Tilläggsavtal om en modul, 10 kr per elev.' });
    const facts = build([add], { lineItems: [perElev(add.contract_id, 'SchoolSoft', 10)], coverage: covFor(add.contract_id, 'SchoolSoft', F9) });
    expect(row(facts, add.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: 'tillagg' });
  });
});

// ------------------------------------------------------------------ V2
describe('V2. a price cell with no known price over held avtal says "inget känt pris"', () => {
  it('the kategori matrix over one unpriced avtal never says "inga avtal"', () => {
    const facts = build([C({ annual_value_sek: null, products: ['Binogi'] })], { coverage: [] });
    const html = renderKategori({ category: findCategory('laromedel'), facts, stats, statusMap: done(KODS), today: TODAY, underlag: underlagEvidence({}) });
    const cells = new Map([...html.matchAll(/aria-label="([^"]*)"><span class="sm-few">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]));
    expect(cells.get('Alla kommuner · Alla segment')).toBe('inget känt pris');
    // Kommungrupper where the underlag holds no avtal at all may say so.
    for (const [where, c] of cells) if (where !== 'Alla kommuner · Alla segment') expect(c).toBe('inga avtal i underlaget');
    expect(html).not.toMatch(/>inga avtal</);
  });

  it('heldAvtal counts a bundle naming the product; the matrix says "inga avtal i underlaget" only for a known empty cell', () => {
    const facts = build([C({ vendor_name: 'ILT Education AB', products: ['Polylino', 'Polyglutt Home Access'] })]);
    expect(heldAvtal(facts, { productSlug: 'polyglutt-home-access' })).toBe(1);
    expect(heldAvtal(facts, { productSlug: 'polyglutt-home-access', kommunKods: ['0115'] })).toBe(0);
    const empty = { n: 0, suppressed: true, median: null };
    const html = segmentMatrix({
      rows: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], cols: [{ key: '*', label: 'Alla' }], id: 'v2',
      cell: () => empty, held: (r) => (r.key === 'a' ? 1 : 0),
    });
    expect(html.match(/>inget känt pris</g)).toHaveLength(1);
    expect(html.match(/>inga avtal i underlaget</g)).toHaveLength(1);
    expect(html).toContain('1 avtal i underlaget, inget med känt pris per elev än.');
  });
});

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

// ------------------------------------------------------------------ V4, V6
describe('V4 and V6. a samverkansavtal counts once on Utforska and sums once in the CSV', () => {
  const mk = (kod, namn) => C({ kommun_kod: kod, kommun_namn: namn, size_bytes: 4242, period_start: '2025-08-01', period_end: '2027-07-31', next_review_date: null, products: ['Binogi'] });
  const facts = build([mk('0114', 'Testby 1'), mk('0115', 'Testby 2')]);

  it('Utforska: 1 avtal, known for 1 of 1', () => {
    const t = text(renderUtforska({ facts, stats, today: TODAY, query: parseUtforskaQuery({}) }));
    expect(t).toContain('känt för 1 av 1');
    expect(t).not.toContain('känt för 1 av 2');
    expect(t).toContain('1 aktivt avtal från 2 kommuner matchar');
  });

  it('CSV: the value column sums to the whole avtal once', () => {
    const rows = renewalRows({ facts, stats, today: TODAY, query: undefined });
    const lines = renewalsCsv(rows).trim().split('\r\n').slice(1).map((l) => l.split(';'));
    const sum = lines.reduce((s, l) => s + (Number(l[7]) || 0), 0);
    expect(sum).toBe(100000);
    expect(lines.map((l) => l[8])).toEqual(['samverkan', 'samverkan, se Testby 1']);
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

// ------------------------------------------------------------------ V7
describe('V7. copy', () => {
  it('"1 delvis utlämnad" is singular', () => {
    expect(notDone(0, 1)).toBe('och 1 delvis utlämnad');
    expect(notDone(0, 2)).toBe('och 2 delvis utlämnade');
  });

  it('the spend panel says "inga aktiva avtal i underlaget", never "här"', () => {
    const own = C({ products: ['Binogi'] });
    // Five peers buy Edlevo with a known value, so the row is shown for 0114.
    const peers = ['0115', '0117', '0120', '0123', '0125'].map((kod, i) => C({ vendor_name: 'Tieto', kommun_kod: kod, kommun_namn: `Testby ${i + 2}`, products: ['Edlevo'], summary: `Edlevo för ${kod}.` }));
    const facts = build([own, ...peers], { coverage: [own, ...peers].flatMap((c) => covFor(c.contract_id, c === own ? 'Binogi' : 'Edlevo', F9)) });
    const t = text(renderKommun({ kod: '0114', stats, facts, statusMap: done(KODS), today: TODAY }));
    expect(t).not.toContain('inga aktiva avtal här');
    expect(t).toContain('inga aktiva avtal i underlaget');
  });
});
