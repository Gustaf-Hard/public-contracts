// tests/explorer-core.test.js
// Pure slice-and-dice logic behind the /leverantorer explorer
// (2026-07-09-vendor-data-center-design.md Part 3). The DOM glue in
// public/explorer.js stays untested by design; everything decision-shaped
// lives here in public/explorer-core.js and is exercised directly.
import { describe, it, expect } from 'vitest';
import {
  valueBand,
  lengthBand,
  renewalWindow,
  deriveOptions,
  applyFilters,
  groupFacts,
  aggregateFacts,
  PRICING_MODEL_LABELS,
} from '../public/explorer-core.js';

const TODAY = '2026-07-09';

function fact(over = {}) {
  return {
    contract_id: 1, vendor_id: 1, vendor_name: 'Skolon', vendor_slug: 'skolon',
    kommun_kod: '1980', kommun_namn: 'Västerås', lan: 'Västmanlands län',
    annual_value_sek: 170000, pricing_model: 'per_user',
    contract_length_months: 24, period_start: '2024-03-01', period_end: '2026-03-01',
    next_review_date: '2026-03-01', auto_renews: false,
    products: ['Skolon Plattform'], attachment_id: 11, filename: 'Avtal.pdf',
    ...over,
  };
}

const FACTS = [
  fact(),
  fact({ contract_id: 2, vendor_id: 2, vendor_name: 'Radish', vendor_slug: 'radish',
         kommun_kod: '0180', kommun_namn: 'Stockholm', lan: 'Stockholms län',
         annual_value_sek: 149760, pricing_model: 'per_student',
         contract_length_months: 48, next_review_date: '2026-09-01', products: ['Läsappen'] }),
  fact({ contract_id: 3, vendor_id: 3, vendor_name: 'IST', vendor_slug: 'ist',
         kommun_kod: '1489', kommun_namn: 'Alingsås', lan: 'Västra Götalands län',
         annual_value_sek: 4955221, pricing_model: 'fixed',
         contract_length_months: null, next_review_date: '2027-06-01', products: [] }),
  fact({ contract_id: 4, vendor_id: null, vendor_name: null, vendor_slug: null,
         kommun_kod: '1980', annual_value_sek: null, pricing_model: null,
         contract_length_months: 10, next_review_date: null, products: [] }),
];

describe('bands', () => {
  it('valueBand buckets SEK/year, with explicit okänt and 0', () => {
    expect(valueBand(null)).toBe('okänt');
    expect(valueBand(0)).toBe('0 kr');
    expect(valueBand(99999)).toBe('< 100 tkr');
    expect(valueBand(100000)).toBe('100–500 tkr');
    expect(valueBand(499999)).toBe('100–500 tkr');
    expect(valueBand(500000)).toBe('0,5–1 mkr');
    expect(valueBand(1000000)).toBe('> 1 mkr');
  });

  it('lengthBand buckets months', () => {
    expect(lengthBand(null)).toBe('okänt');
    expect(lengthBand(12)).toBe('≤ 1 år');
    expect(lengthBand(13)).toBe('1–2 år');
    expect(lengthBand(24)).toBe('1–2 år');
    expect(lengthBand(25)).toBe('2–4 år');
    expect(lengthBand(48)).toBe('2–4 år');
    expect(lengthBand(49)).toBe('> 4 år');
  });

  it('renewalWindow relative to a given today', () => {
    expect(renewalWindow(fact({ next_review_date: null }), TODAY)).toBe('okänt');
    expect(renewalWindow(fact({ next_review_date: '2026-03-01' }), TODAY)).toBe('passerat');
    expect(renewalWindow(fact({ next_review_date: '2026-09-01' }), TODAY)).toBe('inom 3 mån');
    expect(renewalWindow(fact({ next_review_date: '2027-06-01' }), TODAY)).toBe('inom 12 mån');
    expect(renewalWindow(fact({ next_review_date: '2028-01-01' }), TODAY)).toBe('senare');
  });
});

describe('deriveOptions', () => {
  it('collects distinct filter options, sorted, with okänt where nulls exist', () => {
    const opts = deriveOptions(FACTS);
    expect(opts.lan).toEqual(['Stockholms län', 'Västmanlands län', 'Västra Götalands län']);
    expect(opts.vendor).toEqual(['IST', 'Radish', 'Skolon', 'okänt']);
    expect(opts.pricing_model).toEqual(['fixed', 'per_student', 'per_user', 'okänt']);
    expect(opts.product).toEqual(['Läsappen', 'Skolon Plattform']);
  });
});

describe('applyFilters', () => {
  it('empty filters return everything', () => {
    expect(applyFilters(FACTS, {}, TODAY)).toHaveLength(4);
  });

  it('filters by län', () => {
    const out = applyFilters(FACTS, { lan: 'Stockholms län' }, TODAY);
    expect(out.map((f) => f.contract_id)).toEqual([2]);
  });

  it('filters by pricing model, with okänt matching null', () => {
    expect(applyFilters(FACTS, { pricing_model: 'per_student' }, TODAY).map((f) => f.contract_id)).toEqual([2]);
    expect(applyFilters(FACTS, { pricing_model: 'okänt' }, TODAY).map((f) => f.contract_id)).toEqual([4]);
  });

  it('filters by value band and length band', () => {
    expect(applyFilters(FACTS, { value_band: '> 1 mkr' }, TODAY).map((f) => f.contract_id)).toEqual([3]);
    expect(applyFilters(FACTS, { value_band: 'okänt' }, TODAY).map((f) => f.contract_id)).toEqual([4]);
    expect(applyFilters(FACTS, { length_band: '2–4 år' }, TODAY).map((f) => f.contract_id)).toEqual([2]);
  });

  it('filters by renewal window and product', () => {
    expect(applyFilters(FACTS, { renewal_window: 'inom 3 mån' }, TODAY).map((f) => f.contract_id)).toEqual([2]);
    expect(applyFilters(FACTS, { product: 'Läsappen' }, TODAY).map((f) => f.contract_id)).toEqual([2]);
  });

  it('filters by vendor, with okänt matching vendor-less contracts', () => {
    expect(applyFilters(FACTS, { vendor: 'Skolon' }, TODAY).map((f) => f.contract_id)).toEqual([1]);
    expect(applyFilters(FACTS, { vendor: 'okänt' }, TODAY).map((f) => f.contract_id)).toEqual([4]);
  });

  it('free-text q matches vendor, kommun and product (case-insensitive)', () => {
    expect(applyFilters(FACTS, { q: 'läsapp' }, TODAY).map((f) => f.contract_id)).toEqual([2]);
    expect(applyFilters(FACTS, { q: 'västerås' }, TODAY).map((f) => f.contract_id)).toEqual([1, 4]);
  });

  it('filters combine with AND', () => {
    expect(applyFilters(FACTS, { lan: 'Västmanlands län', pricing_model: 'per_user' }, TODAY).map((f) => f.contract_id)).toEqual([1]);
    expect(applyFilters(FACTS, { lan: 'Västmanlands län', pricing_model: 'fixed' }, TODAY)).toHaveLength(0);
  });
});

describe('groupFacts', () => {
  it('groups by a dimension with okänt bucket, sorted by known total desc', () => {
    const groups = groupFacts(FACTS, 'lan', TODAY);
    expect(groups.map((g) => g.key)).toEqual(['Västra Götalands län', 'Västmanlands län', 'Stockholms län']);
    expect(groups[1].facts.map((f) => f.contract_id)).toEqual([1, 4]);
  });

  it('groups by vendor with vendor-less contracts under okänt', () => {
    const groups = groupFacts(FACTS, 'vendor', TODAY);
    expect(groups.find((g) => g.key === 'okänt').facts.map((f) => f.contract_id)).toEqual([4]);
  });

  it('groups by derived bands (value_band, renewal_window)', () => {
    const byBand = groupFacts(FACTS, 'value_band', TODAY);
    expect(byBand.find((g) => g.key === '> 1 mkr').facts.map((f) => f.contract_id)).toEqual([3]);
    const byWindow = groupFacts(FACTS, 'renewal_window', TODAY);
    expect(byWindow.find((g) => g.key === 'passerat').facts.map((f) => f.contract_id)).toEqual([1]);
  });

  it('groups by product with multi-membership and an okänt bucket', () => {
    const groups = groupFacts([
      fact({ contract_id: 9, products: ['A', 'B'] }),
      fact({ contract_id: 10, products: [] }),
    ], 'product', TODAY);
    expect(groups.find((g) => g.key === 'A').facts.map((f) => f.contract_id)).toEqual([9]);
    expect(groups.find((g) => g.key === 'B').facts.map((f) => f.contract_id)).toEqual([9]);
    expect(groups.find((g) => g.key === 'okänt').facts.map((f) => f.contract_id)).toEqual([10]);
  });

  it('no grouping returns a single group', () => {
    const groups = groupFacts(FACTS, '', TODAY);
    expect(groups).toHaveLength(1);
    expect(groups[0].facts).toHaveLength(4);
  });
});

describe('aggregateFacts', () => {
  it('running totals with honest completeness', () => {
    const a = aggregateFacts(FACTS);
    expect(a.count).toBe(4);
    expect(a.value_known).toBe(3);
    expect(a.total_annual_sek).toBe(170000 + 149760 + 4955221);
    expect(a.kommun_count).toBe(3);
    expect(a.vendor_count).toBe(3); // null vendor not counted as a vendor
  });

  it('total is null (not 0) when nothing is known', () => {
    const a = aggregateFacts([fact({ annual_value_sek: null })]);
    expect(a.total_annual_sek).toBeNull();
    expect(a.value_known).toBe(0);
  });

  it('empty input aggregates to zero counts', () => {
    expect(aggregateFacts([])).toMatchObject({ count: 0, value_known: 0, total_annual_sek: null, kommun_count: 0, vendor_count: 0 });
  });
});

describe('PRICING_MODEL_LABELS', () => {
  it('covers every enum value with a Swedish label', () => {
    for (const m of ['per_student', 'per_user', 'fixed', 'tiered', 'usage', 'one_time', 'free', 'unknown']) {
      expect(PRICING_MODEL_LABELS[m]).toBeTruthy();
    }
  });
});
