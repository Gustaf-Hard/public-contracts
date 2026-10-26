import { describe, it, expect } from 'vitest';
import {
  MIN_N, buildStudioFacts, collectionStatus, distribution, marketByCategory,
  companyShares, priceDistribution, renewalBuckets, whiteSpots, coOccurrence,
  kommunProfile, dataBasis, pricingModelMix, channelMix,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';

// Hand-written fixtures only (the repo is public): made-up kommun codes,
// values and dates; company/product names come from the committed catalogue.
const TODAY = '2026-10-26';

const E = (o = {}) => ({
  'Förskola': 100, 'Förskoleklass': 10, '1-3': 900, '4-6': 1000, '7-9': 1100,
  'Gymnasiet': 800, 'Komvux': 50, ...o,
});
const stats = loadKommunStats({
  data: {
    kommuner: {
      '9001': { namn: 'Ettby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E() },
      '9002': { namn: 'Tvåby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E() },
      '9003': { namn: 'Treby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E() },
      '9004': { namn: 'Fyrby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E({ '4-6': null }) },
      '9005': { namn: 'Femby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E() },
      '9006': { namn: 'Sexby', folkmangd: 20000, kommungrupp: 'G1', peers: [], elever: E() },
    },
  },
});

let nextId = 1;
const C = (o = {}) => ({
  contract_id: nextId++,
  vendor_id: 1,
  vendor_name: 'ILT Inläsningstjänst AB',
  kommun_kod: '9001',
  kommun_namn: 'Ettby',
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
  products: ['Polylino'],
  ...o,
});
const LI = (contract_id, product_name, amount_sek, o = {}) => ({
  contract_id, product_name, amount_sek, unit_price_sek: null, unit: null, quantity: null, ...o,
});
const COV = (contract_id, product_name, grade_level, student_count = null, status = 'full') => ({
  contract_id, product_name, grade_level, student_count, status,
});
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });

describe('distribution', () => {
  it('suppresses below MIN_N, all stats null', () => {
    expect(MIN_N).toBe(5);
    expect(distribution([1, 2, 3, 4])).toEqual({
      n: 4, median: null, p25: null, p75: null, min: null, max: null, suppressed: true,
    });
  });
  it('gives median and quartiles from five values', () => {
    expect(distribution([5, 1, 4, 2, 3])).toEqual({
      n: 5, median: 3, p25: 2, p75: 4, min: 1, max: 5, suppressed: false,
    });
  });
  it('ignores non-finite values', () => {
    expect(distribution([1, 2, NaN, Infinity, null, 3]).n).toBe(3);
  });
});

describe('buildStudioFacts: channel split', () => {
  const c = C({
    vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, products: ['Polylino', 'Magma'],
  });
  const facts = build([c], {
    lineItems: [LI(c.contract_id, 'Polylino', 30000), LI(c.contract_id, 'Magma', 50000), LI(c.contract_id, '  ', 999)],
  });
  const by = (slug) => facts.find((f) => f.company_slug === slug);

  it('one row per avtal x owner company', () => {
    expect(facts.map((f) => f.company_slug).sort()).toEqual(['ilt', 'laromedia', 'radish']);
    expect(new Set(facts.map((f) => f.contract_id))).toEqual(new Set([c.contract_id]));
  });
  it('splits by line amounts and leaves the remainder on the channel', () => {
    expect(by('ilt')).toMatchObject({ annual_value_sek: 30000, value_basis: 'split', channel_slug: 'laromedia', product_slugs: ['polylino'] });
    expect(by('radish')).toMatchObject({ annual_value_sek: 50000, value_basis: 'split', channel_slug: 'laromedia', product_slugs: ['magma'] });
    expect(by('laromedia')).toMatchObject({ annual_value_sek: 20000, value_basis: 'unsplit_channel', product_slugs: [], channel_slug: 'laromedia', category: 'laromedel' });
    expect(facts.every((f) => !('_g' in f) && !('_owner' in f) && !('_received_at' in f))).toBe(true);
  });
  it('blank line names never carry value or products', () => {
    expect(facts.reduce((s, f) => s + f.annual_value_sek, 0)).toBe(100000);
  });
  it('annualises a multi-year line by its period_months', () => {
    const c3 = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, period_start: '2025-01-01', period_end: '2027-12-31', products: [] });
    const f3 = build([c3], { lineItems: [LI(c3.contract_id, 'Polylino', 90000, { period_months: 36 })] });
    expect(f3.find((f) => f.company_slug === 'ilt')).toMatchObject({ annual_value_sek: 30000, value_basis: 'split' });
    expect(f3.find((f) => f.company_slug === 'laromedia')).toMatchObject({ annual_value_sek: 70000, value_basis: 'unsplit_channel' });
  });
  it('annualises lines without a period by the avtal length when they exceed a year of value', () => {
    const c4 = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, period_start: '2025-01-01', period_end: '2027-12-31', products: [] });
    const f4 = build([c4], { lineItems: [LI(c4.contract_id, 'Polylino', 90000), LI(c4.contract_id, 'Magma', 150000)] });
    expect(f4.find((f) => f.company_slug === 'ilt').annual_value_sek).toBe(30000);
    expect(f4.find((f) => f.company_slug === 'radish').annual_value_sek).toBe(50000);
    expect(f4.find((f) => f.company_slug === 'laromedia').annual_value_sek).toBe(20000);
  });
  it('does not split multi-year lines when the avtal length is unknown', () => {
    const c5 = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, period_start: '2025-01-01', period_end: null, products: [] });
    const f5 = build([c5], { lineItems: [LI(c5.contract_id, 'Polylino', 90000), LI(c5.contract_id, 'Magma', 150000)] });
    expect(f5.find((f) => f.company_slug === 'ilt')).toMatchObject({ annual_value_sek: null, value_basis: null });
    expect(f5.find((f) => f.company_slug === 'laromedia')).toMatchObject({ annual_value_sek: 100000, value_basis: 'unsplit_channel' });
  });
  it('does not split when line amounts exceed the avtal value', () => {
    const c2 = C({ vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 10000, products: [] });
    const f2 = build([c2], { lineItems: [LI(c2.contract_id, 'Polylino', 30000)] });
    expect(f2.find((f) => f.company_slug === 'ilt')).toMatchObject({ annual_value_sek: null, value_basis: null });
    expect(f2.find((f) => f.company_slug === 'laromedia')).toMatchObject({ annual_value_sek: 10000, value_basis: 'unsplit_channel' });
  });
  it('a direct avtal is one stated row', () => {
    const f3 = build([C()]);
    expect(f3).toHaveLength(1);
    expect(f3[0]).toMatchObject({
      company_slug: 'ilt', company_name: 'ILT Education', channel_slug: null, category: 'laromedel',
      annual_value_sek: 100000, value_basis: 'stated', product_slugs: ['polylino'],
    });
  });
});

describe('buildStudioFacts: active and superseded', () => {
  it('applies the active rule', () => {
    const [ended] = build([C({ period_end: '2026-10-25' })]);
    const [endsToday] = build([C({ period_end: '2026-10-26' })]);
    const [recent] = build([C({ period_end: null, period_start: '2023-10-26' })]);
    const [old] = build([C({ period_end: null, period_start: '2021-10-26' })]);
    const [nothing] = build([C({ period_end: null, period_start: null })]);
    expect(ended.active).toBe(false);
    expect(endsToday.active).toBe(true);
    expect(recent.active).toBe(true);
    expect(old.active).toBe(false);
    expect(nothing.active).toBe(false);
  });
  it('the older of two avtal for kommun x company x product is superseded and leaves headline aggregates', () => {
    const older = C({ period_start: '2025-01-01', annual_value_sek: 40000 });
    const newer = C({ period_start: '2026-01-01', annual_value_sek: 60000 });
    const other = C({ kommun_kod: '9002', kommun_namn: 'Tvåby', period_start: '2024-01-01', annual_value_sek: 10000 });
    const facts = build([older, newer, other]);
    expect(facts.find((f) => f.contract_id === older.contract_id).superseded).toBe(true);
    expect(facts.find((f) => f.contract_id === newer.contract_id).superseded).toBe(false);
    expect(facts.find((f) => f.contract_id === other.contract_id).superseded).toBe(false);
    const [ilt] = companyShares(facts);
    expect(ilt).toMatchObject({ slug: 'ilt', value_known_sek: 70000, kommuner: 2, n_avtal: 2 });
    expect(marketByCategory(facts)[0]).toMatchObject({ category: 'laromedel', value_known_sek: 70000, n_avtal: 2 });
  });
  it('next_renewal follows the lifecycle (auto-renew cancellation day)', () => {
    const [f] = build([C({ auto_renews: 1, last_cancellation_date: '2027-06-30' })]);
    expect(f.next_renewal).toBe('2027-07-01');
    const [g] = build([C({ period_end: '2027-12-31' })]);
    expect(g.next_renewal).toBe('2027-12-31');
  });
});

describe('buildStudioFacts: kr_per_elev', () => {
  it('stated unit price per elev is styckpris', () => {
    const [f] = build([C({ unit: 'elev', unit_price_sek: 120, pricing_model: 'per_student' })]);
    expect(f).toMatchObject({ kr_per_elev: 120, kr_per_elev_basis: 'styckpris' });
  });
  it('annual value over the avtal student count', () => {
    const c = C({ annual_value_sek: 100000 });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', 500)] });
    expect(f).toMatchObject({ segments: ['4-6'], elever_in_scope: 500, kr_per_elev: 200, kr_per_elev_basis: 'avtalets_elevantal' });
  });
  it('one count on several grades of a product is ambiguous: Skolverket, not the count', () => {
    // "1-3 300 + 4-6 300" may be one entry of 300 or two of 300 each.
    const c = C({ annual_value_sek: 95000 });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '1-3', 300), COV(c.contract_id, 'Polylino', '4-6', 300)] });
    expect(f).toMatchObject({ segments: ['1-3', '4-6'], elever_in_scope: 1900, kr_per_elev: 50, kr_per_elev_basis: 'skolverket' });
  });
  it('different counts per grade and per product are summed', () => {
    const c = C({ annual_value_sek: 70000, vendor_name: 'Gleerups Utbildning AB', products: [] });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Gleerupsportal', '4-6', 300), COV(c.contract_id, 'Gleerups digitala läromedel', '7-9', 400)] });
    expect(f).toMatchObject({ segments: ['4-6', '7-9'], elever_in_scope: 700, kr_per_elev: 100, kr_per_elev_basis: 'avtalets_elevantal' });
  });
  it('products agreeing on a grade count the same pupils once', () => {
    const c = C({ annual_value_sek: 50000, vendor_name: 'Gleerups Utbildning AB', products: [] });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Gleerupsportal', '4-6', 500), COV(c.contract_id, 'Gleerups digitala läromedel', '4-6', 500)] });
    expect(f).toMatchObject({ elever_in_scope: 500, kr_per_elev: 100, kr_per_elev_basis: 'avtalets_elevantal' });
  });
  it('a partly known count is not used as the whole', () => {
    const c = C({ annual_value_sek: 210000, vendor_name: 'Gleerups Utbildning AB', products: [] });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Gleerupsportal', '4-6', 300), COV(c.contract_id, 'Gleerups digitala läromedel', '7-9', null)] });
    expect(f).toMatchObject({ elever_in_scope: 2100, kr_per_elev: 100, kr_per_elev_basis: 'skolverket' });
  });
  it('styckpris uses a product line of at least 12 months', () => {
    const c = C({ annual_value_sek: null, pricing_model: 'per_student', products: [] });
    const [f] = build([c], { lineItems: [
      LI(c.contract_id, 'Utbildning', 5000, { unit: 'elev', unit_price_sek: 9 }),
      LI(c.contract_id, 'Polylino', 6540, { unit: 'elev', unit_price_sek: 65.4, period_months: 7 }),
      LI(c.contract_id, 'Polylino', 11000, { unit: 'elev', unit_price_sek: 110, period_months: 12 }),
    ] });
    expect(f).toMatchObject({ kr_per_elev: 110, kr_per_elev_basis: 'styckpris' });
  });
  it('falls back to Skolverket elever for the segments', () => {
    const c = C({ annual_value_sek: 100000 });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', null)] });
    expect(f).toMatchObject({ elever_in_scope: 1000, kr_per_elev: 100, kr_per_elev_basis: 'skolverket' });
  });
  it('student_count 0 gives null, never Infinity', () => {
    const c = C();
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', 0)] });
    expect(f.kr_per_elev).toBe(null);
    expect(f.kr_per_elev_basis).toBe(null);
  });
  it('no segments gives null', () => {
    const [f] = build([C()]);
    expect(f).toMatchObject({ segments: [], elever_in_scope: null, kr_per_elev: null, kr_per_elev_basis: null });
  });
  it('missing Skolverket elever for a segment gives null', () => {
    const c = C({ kommun_kod: '9004', kommun_namn: 'Fyrby' });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', null)] });
    expect(f.kr_per_elev).toBe(null);
  });
  it('partial coverage without a student count is not normalised', () => {
    const c = C();
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', null, 'partial')] });
    expect(f.kr_per_elev).toBe(null);
  });
  it('unknown value gives null', () => {
    const c = C({ annual_value_sek: null, pricing_model: null });
    const [f] = build([c], { coverage: [COV(c.contract_id, 'Polylino', '4-6', 500)] });
    expect(f.kr_per_elev).toBe(null);
    expect(f.value_basis).toBe(null);
  });
});

describe('buildStudioFacts: unknown and uncatalogued vendors', () => {
  it('vendor_id null is Okänd leverantör, never crashes', () => {
    const facts = build([C({ vendor_id: null, vendor_name: null, products: [] })]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ company_slug: null, company_name: 'Okänd leverantör', category: null });
    const cats = marketByCategory(facts);
    expect(cats.map((m) => m.category)).toEqual(['okand']);
    expect(companyShares(facts)[0]).toMatchObject({ slug: null, name: 'Okänd leverantör' });
  });
  it('uncatalogued vendor passes through as its cleaned name', () => {
    const [f] = build([C({ vendor_name: 'Zebrafy Analytics AB', products: [] })]);
    expect(f).toMatchObject({ company_slug: null, company_name: 'Zebrafy Analytics' });
  });
});

describe('collectionStatus and whiteSpots', () => {
  const status = collectionStatus([
    { kommun_kod: '9001', state: 'DONE' },
    { kommun_kod: '9002', state: 'DONE' }, { kommun_kod: '9002', state: 'DEAD_END' },
    { kommun_kod: '9003', state: 'DONE' }, { kommun_kod: '9003', state: 'SENT' },
    { kommun_kod: '9005', state: 'INITIAL' },
  ]);
  it('done only when every conversation is DONE/DEAD_END', () => {
    expect(status.get('9001')).toBe('done');
    expect(status.get('9002')).toBe('done');
    expect(status.get('9003')).toBe('open');
    expect(status.get('9005')).toBe('not_contacted');
    expect(status.has('9004')).toBe(false);
  });
  it('separates the four buckets', () => {
    const facts = build([C({ kommun_kod: '9001' })]);
    const ws = whiteSpots(facts, status, { category: 'laromedel', allKods: ['9001', '9002', '9003', '9004', '9005'] });
    expect(ws).toEqual({ has: ['9001'], none_done: ['9002'], none_open: ['9003'], not_contacted: ['9004', '9005'] });
  });
  it('an avtal in another category is a white spot here', () => {
    const facts = build([C({ kommun_kod: '9002', vendor_name: 'IST', products: [] })]);
    const ws = whiteSpots(facts, status, { category: 'laromedel', allKods: ['9002'] });
    expect(ws.none_done).toEqual(['9002']);
  });
});

describe('priceDistribution', () => {
  const priced = (n) => build(Array.from({ length: n }, (_, i) => C({
    kommun_kod: `900${i + 1}`, unit: 'elev', unit_price_sek: 100 + i * 10, pricing_model: 'per_student',
  })));
  it('n = 4 is suppressed, no values', () => {
    const d = priceDistribution(priced(4), { productSlug: 'polylino' });
    expect(d).toMatchObject({ n: 4, suppressed: true, median: null, values: [] });
  });
  it('n = 5 gives the plot', () => {
    const d = priceDistribution(priced(5), { productSlug: 'polylino' });
    expect(d).toMatchObject({ n: 5, suppressed: false, median: 120 });
    expect(d.values).toHaveLength(5);
    expect(d.values[0]).toEqual({ kommun_kod: '9001', kr_per_elev: 100 });
  });
  it('a bundle row is not part of one product\'s distribution', () => {
    const facts = [...priced(5), ...build([C({ kommun_kod: '9006', unit: 'elev', unit_price_sek: 999, pricing_model: 'per_student', products: ['Polylino', 'Inlästa läromedel'] })])];
    expect(facts.at(-1).product_slugs).toHaveLength(2);
    const d = priceDistribution(facts, { productSlug: 'polylino' });
    expect(d.n).toBe(5);
    expect(d.max).toBe(140);
  });
  it('a bundle row counts for a product when its styckpris came from that product\'s own line', () => {
    const c = C({ kommun_kod: '9006', annual_value_sek: null, products: ['Polylino', 'Inlästa läromedel'] });
    const facts = [...priced(4), ...build([c], { lineItems: [LI(c.contract_id, 'Polylino', 10000, { unit: 'elev', unit_price_sek: 150, period_months: 12 })] })];
    expect(priceDistribution(facts, { productSlug: 'polylino' })).toMatchObject({ n: 5, max: 150 });
  });
  it('filters by kommunKods and category', () => {
    expect(priceDistribution(priced(5), { kommunKods: ['9001', '9002'] }).n).toBe(2);
    expect(priceDistribution(priced(5), { category: 'skoladministration' }).n).toBe(0);
  });
});

describe('renewals, co-occurrence, profile, basis', () => {
  const facts = build([
    C({ kommun_kod: '9001', period_end: '2027-01-15', annual_value_sek: 10000 }),
    C({ kommun_kod: '9001', vendor_name: 'IST', products: [], period_end: '2027-01-31', annual_value_sek: 5000 }),
    C({ kommun_kod: '9001', vendor_name: 'Gleerups Utbildning AB', products: ['Gleerups digitala läromedel'], period_end: '2029-01-01', annual_value_sek: 2000 }),
    C({ kommun_kod: '9002', period_end: '2027-03-01', annual_value_sek: 20000 }),
    C({ kommun_kod: '9003', period_end: '2020-01-01', annual_value_sek: 99999 }),
  ]);
  it('renewalBuckets: 24 months from today, active only', () => {
    const b = renewalBuckets(facts, { today: TODAY, months: 24 });
    expect(b).toHaveLength(24);
    expect(b[0].month).toBe('2026-10');
    const jan = b.find((x) => x.month === '2027-01');
    expect(jan).toMatchObject({ n: 2, value_known_sek: 15000 });
    expect(jan.byCategory.laromedel).toEqual({ n: 1, value_known_sek: 10000 });
    expect(b.reduce((s, x) => s + x.n, 0)).toBe(3);
  });
  it('coOccurrence lists other companies in the same kommuner', () => {
    expect(coOccurrence(facts, 'ilt')).toEqual([
      { slug: 'gleerups', name: 'Gleerups', kommuner: 1 },
      { slug: 'ist', name: 'IST', kommuner: 1 },
    ]);
  });
  it('kommunProfile', () => {
    const p = kommunProfile(facts, stats, '9001', { today: TODAY });
    expect(p.spendByCategory.find((s) => s.category === 'laromedel')).toMatchObject({ value_known_sek: 12000, n_avtal: 2 });
    expect(p.overlaps).toEqual([{ category: 'laromedel', companies: [{ slug: 'gleerups', name: 'Gleerups' }, { slug: 'ilt', name: 'ILT Education' }] }]);
    expect(p.peerMedianByCategory.laromedel).toMatchObject({ n: 1, suppressed: true, median: null });
    expect(p.renewals.map((r) => r.next_renewal)).toEqual(['2027-01-15', '2027-01-31', '2029-01-01']);
  });
  it('kommunProfile for a kommun with no avtal is empty, not a crash', () => {
    const p = kommunProfile(facts, stats, '9006', { today: TODAY });
    expect(p).toEqual({ spendByCategory: [], peerMedianByCategory: expect.any(Object), overlaps: [], renewals: [] });
    expect(kommunProfile([], null, '0000', { today: TODAY }).spendByCategory).toEqual([]);
  });
  it('kommunProfile renewals only lists dates from today on', () => {
    const f2 = build([C({ kommun_kod: '9001', auto_renews: 1, last_cancellation_date: '2026-06-30', period_end: '2027-06-30' })]);
    expect(f2[0]).toMatchObject({ active: true, next_renewal: '2026-07-01' });
    expect(kommunProfile(f2, stats, '9001', { today: TODAY }).renewals).toEqual([]);
  });
  it('dataBasis', () => {
    const st = collectionStatus([{ kommun_kod: '9001', state: 'DONE' }, { kommun_kod: '9002', state: 'SENT' }]);
    expect(dataBasis(facts, st)).toMatchObject({ active: 4, collected: 5, kommuner_with_avtal: 2, kommuner_collected: 3, kommuner_total: 290, done: 1 });
  });
  it('pricingModelMix counts headline avtal per model, null as okand', () => {
    const f2 = build([C(), C({ kommun_kod: '9002', pricing_model: null }), C({ kommun_kod: '9003', pricing_model: 'per_student' }), C({ kommun_kod: '9004', vendor_name: 'IST', products: [] })]);
    expect(pricingModelMix(f2, { category: 'laromedel' })).toEqual([
      { model: 'fixed', n: 1, share: 1 / 3 }, { model: 'okand', n: 1, share: 1 / 3 }, { model: 'per_student', n: 1, share: 1 / 3 },
    ]);
    expect(pricingModelMix(f2, { companySlug: 'ist' })).toEqual([{ model: 'fixed', n: 1, share: 1 }]);
  });
  it('channelMix splits direct and channel avtal', () => {
    const ch = C({ kommun_kod: '9002', vendor_name: 'Läromedia Bokhandel Örebro AB', annual_value_sek: 100000, period_end: '2026-12-31', products: [] });
    const f2 = build([C({ annual_value_sek: 40000 }), ch], { lineItems: [LI(ch.contract_id, 'Polylino', 30000)] });
    expect(channelMix(f2, { companySlug: 'ilt' })).toEqual([
      { channel_slug: 'direkt', n: 1, value_known_sek: 40000 }, { channel_slug: 'laromedia', n: 1, value_known_sek: 30000 },
    ]);
    expect(channelMix(f2)).toEqual([
      { channel_slug: 'laromedia', n: 1, value_known_sek: 100000 }, { channel_slug: 'direkt', n: 1, value_known_sek: 40000 },
    ]);
  });
});
