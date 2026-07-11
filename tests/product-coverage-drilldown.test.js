// tests/product-coverage-drilldown.test.js
// Product-coverage drill-down: the dossier's product×grade matrix pivoted to
// kommun×grade for ONE product. Rows are every kommun we hold ANY collected
// contract data for — so an all-red row honestly means "has given us
// contracts, but none for this product", never "unknown". Pure analytics
// here; views and the route are tested further down.
import { describe, it, expect } from 'vitest';
import {
  GRADE_LEVELS,
  buildContractFacts,
  buildProductCoverageByKommun,
  slugifyProductName,
} from '../src/vendor-analytics.js';

const NOW = new Date('2026-07-11T12:00:00Z');
const LAN = new Map([
  ['1440', 'Västra Götalands län'],
  ['1489', 'Västra Götalands län'],
  ['1470', 'Västra Götalands län'],
]);

// ILT-shaped vendor slice: Ale buys Begreppa with full coverage, Alingsås
// with partial coverage. Vara (1470) appears only in dataKommuner — it has
// stored contracts (another vendor's), but nothing from ILT.
function iltFacts() {
  return buildContractFacts([
    {
      contract_id: 1, vendor_id: 7, vendor_name: 'ILT Education', vendor_slug: 'ilt-education',
      kommun_kod: '1440', kommun_namn: 'Ale',
      avtalsvarde: null, valuta: 'SEK',
      period_start: '2025-01-31', period_end: '2028-01-30',
      auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
      annual_value_sek: 585649, one_time_value_sek: null, pricing_model: 'tiered',
      unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
      confidence: 0.95, summary: 'ILT', attachment_id: 101, filename: 'ILT-Ale.pdf',
      received_at: '2026-06-01T10:00:00Z', products: ['Begreppa', 'Polyglutt'],
    },
    {
      contract_id: 2, vendor_id: 7, vendor_name: 'ILT Education', vendor_slug: 'ilt-education',
      kommun_kod: '1489', kommun_namn: 'Alingsås',
      avtalsvarde: null, valuta: 'SEK',
      period_start: '2025-08-01', period_end: '2026-07-31',
      auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
      annual_value_sek: 100000, one_time_value_sek: null, pricing_model: 'fixed',
      unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
      confidence: 0.9, summary: 'Begreppa', attachment_id: 102, filename: 'ILT-Alingsas.pdf',
      received_at: '2026-06-02T10:00:00Z', products: ['Begreppa'],
    },
  ], { lanByKommunKod: LAN, now: NOW });
}

const ALE_GRADES = ['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'];

const COVERAGE = [
  // Ale: Begreppa full across the school levels; Polyglutt owns Förskola
  // (which makes Förskola vendor-applicable, so its Begreppa cells are
  // "none", not "na").
  ...ALE_GRADES.map((g, i) => ({ id: 10 + i, contract_id: 1, product_id: null, product_name: 'Begreppa', grade_level: g, status: 'full', student_count: 4244 })),
  { id: 30, contract_id: 1, product_id: null, product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
  // Alingsås: Begreppa only partially, only lower/middle years.
  { id: 40, contract_id: 2, product_id: null, product_name: 'Begreppa', grade_level: '1-3', status: 'partial', student_count: 800 },
  { id: 41, contract_id: 2, product_id: null, product_name: 'Begreppa', grade_level: '4-6', status: 'partial', student_count: null },
];

// Every kommun with ANY stored contract — Vara has contracts from some other
// vendor, so it belongs here even though ILT never appears there.
const DATA_KOMMUNER = [
  { kommun_kod: '1470', kommun_namn: 'Vara' },
  { kommun_kod: '1440', kommun_namn: 'Ale' },
  { kommun_kod: '1489', kommun_namn: 'Alingsås' },
];

// Levels no ILT contract ever references → "–" for every kommun.
const NA_GRADES = ['Förskoleklass', 'Introduktionsprogrammet', 'Högskola'];

function begreppa() {
  return buildProductCoverageByKommun({
    vendorName: 'ILT Education',
    productName: 'Begreppa',
    facts: iltFacts(),
    coverage: COVERAGE,
    dataKommuner: DATA_KOMMUNER,
  });
}

describe('buildProductCoverageByKommun — kommun×grade pivot for one product', () => {
  it('one row per data-kommun, sorted sv-locale by name', () => {
    const r = begreppa();
    expect(r.kommuner.map((k) => k.kommun_namn)).toEqual(['Ale', 'Alingsås', 'Vara']);
    expect(r.vendorName).toBe('ILT Education');
    expect(r.productName).toBe('Begreppa');
  });

  it('full coverage → full cells (Ale across the covered levels)', () => {
    const ale = begreppa().kommuner.find((k) => k.kommun_namn === 'Ale');
    for (const g of ALE_GRADES) expect(ale.coverageByGrade[g]).toBe('full');
  });

  it('partial coverage → partial cells; uncovered applicable levels → none (Alingsås)', () => {
    const alingsas = begreppa().kommuner.find((k) => k.kommun_namn === 'Alingsås');
    expect(alingsas.coverageByGrade['1-3']).toBe('partial');
    expect(alingsas.coverageByGrade['4-6']).toBe('partial');
    expect(alingsas.coverageByGrade['7-9']).toBe('none');
    expect(alingsas.coverageByGrade['Gymnasiet']).toBe('none');
    expect(alingsas.coverageByGrade['Komvux']).toBe('none');
  });

  it('a kommun with contract data but no trace of the product is all-none (honest "not sold")', () => {
    const vara = begreppa().kommuner.find((k) => k.kommun_namn === 'Vara');
    for (const g of GRADE_LEVELS) {
      expect(vara.coverageByGrade[g]).toBe(NA_GRADES.includes(g) ? 'na' : 'none');
    }
  });

  it('na exactly where the product×grade matrix says na (vendor never references the level)', () => {
    for (const k of begreppa().kommuner) {
      for (const g of NA_GRADES) expect(k.coverageByGrade[g]).toBe('na');
    }
    // Förskola IS vendor-applicable (Polyglutt), so Begreppa there is none — not na.
    const ale = begreppa().kommuner.find((k) => k.kommun_namn === 'Ale');
    expect(ale.coverageByGrade['Förskola']).toBe('none');
  });

  it('summary counts: 3 data-kommuner, 2 with the product', () => {
    expect(begreppa().summary).toEqual({ kommun_total: 3, kommun_with_product: 2 });
  });

  it('product match is case-insensitive; output carries the canonical name', () => {
    const r = buildProductCoverageByKommun({
      vendorName: 'ILT Education', productName: 'bEgReppa',
      facts: iltFacts(), coverage: COVERAGE, dataKommuner: DATA_KOMMUNER,
    });
    expect(r).not.toBeNull();
    expect(r.productName).toBe('Begreppa');
  });

  it('unknown product → null (route turns this into a 404)', () => {
    expect(buildProductCoverageByKommun({
      vendorName: 'ILT Education', productName: 'Okänd Produkt',
      facts: iltFacts(), coverage: COVERAGE, dataKommuner: DATA_KOMMUNER,
    })).toBeNull();
  });

  it('a product with no extracted coverage at all is honestly all-na', () => {
    const r = buildProductCoverageByKommun({
      vendorName: 'ILT Education', productName: 'Begreppa',
      facts: iltFacts(), coverage: [], dataKommuner: DATA_KOMMUNER,
    });
    for (const k of r.kommuner) {
      for (const g of GRADE_LEVELS) expect(k.coverageByGrade[g]).toBe('na');
    }
  });
});

describe('slugifyProductName — same rule as vendor slugs', () => {
  it('folds å/ä/ö and kebab-cases', () => {
    expect(slugifyProductName('Inlästa läromedel')).toBe('inlasta-laromedel');
    expect(slugifyProductName('Begreppa')).toBe('begreppa');
    expect(slugifyProductName('Skolon Plattform 2.0')).toBe('skolon-plattform-2-0');
  });
});
