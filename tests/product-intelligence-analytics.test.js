// tests/product-intelligence-analytics.test.js
// Pure analytics for the product-intelligence feature
// (2026-07-10-product-intelligence-design.md): the Swedish-unit → canonical
// grade-band mapper and the per-product rollups (line-item pricing + coverage
// matrix aggregation). Everything here is table-driven and offline.
import { describe, it, expect } from 'vitest';
import {
  GRADE_LEVELS,
  MUNICIPAL_GRADE_LEVELS,
  mapUnitToGradeLevels,
  buildContractFacts,
  buildProductRollups,
  buildVendorRollups,
} from '../src/vendor-analytics.js';

describe('grade schema constants', () => {
  it('exposes the canonical 9-level schema in fixed order', () => {
    expect(GRADE_LEVELS).toEqual([
      'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9',
      'Gymnasiet', 'Komvux', 'Introduktionsprogrammet', 'Högskola',
    ]);
  });

  it('municipal levels are the 9 minus Högskola (kommuner rarely operate one)', () => {
    expect(MUNICIPAL_GRADE_LEVELS).toEqual(GRADE_LEVELS.slice(0, 8));
  });
});

describe('mapUnitToGradeLevels — table tests over real unit phrases', () => {
  const m = mapUnitToGradeLevels;

  it('grundskola → the three compulsory-school bands', () => {
    expect(m('Alla kommunala grundskolor')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('Alla kommunala grundskolor (3 810)')).toEqual(['1-3', '4-6', '7-9']);
  });

  it('förskola → Förskola (the Polyglutt case)', () => {
    expect(m('Alla kommunala förskolor (1 683)')).toEqual(['Förskola']);
    expect(m('förskolan')).toEqual(['Förskola']);
  });

  it('förskoleklass → Förskoleklass, never Förskola', () => {
    expect(m('förskoleklass')).toEqual(['Förskoleklass']);
    expect(m('elever i förskoleklassen')).toEqual(['Förskoleklass']);
  });

  it('gymnasieskola / gymnasiet / gymnasium → Gymnasiet', () => {
    expect(m('gymnasieskolor (120)')).toEqual(['Gymnasiet']);
    expect(m('gymnasiet')).toEqual(['Gymnasiet']);
    expect(m('kommunalt gymnasium')).toEqual(['Gymnasiet']);
  });

  it('vuxenutbildning / Komvux / SFI → Komvux', () => {
    expect(m('vuxenutbildningar (270)')).toEqual(['Komvux']);
    expect(m('Komvux')).toEqual(['Komvux']);
    expect(m('SFI (svenska för invandrare)')).toEqual(['Komvux']);
  });

  it('introduktionsprogram / IM-program → Introduktionsprogrammet', () => {
    expect(m('introduktionsprogrammen')).toEqual(['Introduktionsprogrammet']);
    expect(m('IM-program')).toEqual(['Introduktionsprogrammet']);
  });

  it('högskola → Högskola', () => {
    expect(m('högskolan')).toEqual(['Högskola']);
  });

  // Anpassad skola / särskola folds into the matching age bands (spec §2).
  it('bare anpassad skola / särskola folds into all four age bands', () => {
    expect(m('anpassad skola (44)')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
    expect(m('särskolan')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
  });

  it('qualified anpassad skola folds into only its own age bands', () => {
    expect(m('anpassad grundskola')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('grundsärskolan')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('gymnasiesärskolan')).toEqual(['Gymnasiet']);
    expect(m('anpassad gymnasieskola')).toEqual(['Gymnasiet']);
  });

  it('the full Ale enhets-list maps with anpassad skola folded (no new band)', () => {
    expect(m('Alla kommunala grundskolor (3 810), gymnasieskolor (120), vuxenutbildningar (270), anpassad skola (44)'))
      .toEqual(['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux']);
  });

  // F-3 style ranges.
  it('F-3 → Förskoleklass + 1-3', () => {
    expect(m('F-3')).toEqual(['Förskoleklass', '1-3']);
  });

  it('åk 4-6 → only the 4-6 band', () => {
    expect(m('åk 4-6')).toEqual(['4-6']);
  });

  it('a range spanning band boundaries touches every intersected band: åk 2-5', () => {
    expect(m('åk 2-5')).toEqual(['1-3', '4-6']);
  });

  it('F-9 → Förskoleklass + all compulsory bands', () => {
    expect(m('F-9')).toEqual(['Förskoleklass', '1-3', '4-6', '7-9']);
  });

  it('F-Gy (the Skola24 shape) → Förskoleklass through Gymnasiet', () => {
    expect(m('alla kommunala skolor åk F-Gy')).toEqual(['Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet']);
  });

  // Whole municipality.
  it('whole-municipality phrases expand to all municipal levels (not Högskola)', () => {
    expect(m('hela kommunen')).toEqual([...MUNICIPAL_GRADE_LEVELS]);
    expect(m('samtliga skolformer')).toEqual([...MUNICIPAL_GRADE_LEVELS]);
  });

  it('unknown text, empty and null map to nothing (honest, not a guess)', () => {
    expect(m('IT-avdelningen')).toEqual([]);
    expect(m('')).toEqual([]);
    expect(m(null)).toEqual([]);
    expect(m(undefined)).toEqual([]);
  });

  it('result is deduped and in canonical order regardless of phrase order', () => {
    expect(m('gymnasieskolor och grundskolor')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
    expect(m('vuxenutbildning samt förskola')).toEqual(['Förskola', 'Komvux']);
  });
});

// ---- buildProductRollups: ILT-shaped fixture with the REAL Ale breakdown ----

const NOW = new Date('2026-07-10T12:00:00Z');
const LAN = new Map([['1440', 'Västra Götalands län'], ['1489', 'Västra Götalands län']]);

// Contract 1 = the real Ale / ILT Education contract (live row 101): total
// 585 649 SEK år 1, itemized per product, per-product enhets-lists.
// Contract 2 = a second kommun (Alingsås) buying only Begreppa, with partial
// coverage and NO line items (lump sum) — drives the yellow/"ospecificerat"
// paths.
function iltFacts() {
  return buildContractFacts([
    {
      contract_id: 1, vendor_id: 7, vendor_name: 'ILT Education', vendor_slug: 'ilt-education',
      kommun_kod: '1440', kommun_namn: 'Ale',
      avtalsvarde: '585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3', valuta: 'SEK',
      period_start: '2025-01-31', period_end: '2028-01-30',
      auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
      annual_value_sek: 585649, one_time_value_sek: null, pricing_model: 'tiered',
      unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
      confidence: 0.95, summary: 'ILT-avtal', attachment_id: 101, filename: 'ILT-Ale.pdf',
      received_at: '2026-06-01T10:00:00Z',
      products: ['Begreppa', 'Inlästa läromedel', 'Polyglutt'],
    },
    {
      contract_id: 2, vendor_id: 7, vendor_name: 'ILT Education', vendor_slug: 'ilt-education',
      kommun_kod: '1489', kommun_namn: 'Alingsås',
      avtalsvarde: null, valuta: 'SEK',
      period_start: '2025-08-01', period_end: '2026-07-31',
      auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
      annual_value_sek: 100000, one_time_value_sek: null, pricing_model: 'fixed',
      unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
      confidence: 0.9, summary: 'Begreppa-avtal', attachment_id: 102, filename: 'ILT-Alingsas.pdf',
      received_at: '2026-06-02T10:00:00Z',
      products: ['Begreppa'],
    },
  ], { lanByKommunKod: LAN, now: NOW });
}

// DB-row-shaped line items (as db.listLineItems() returns them).
const ILT_LINE_ITEMS = [
  { id: 1, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', description: '65,40 kr/elev, 7 månader', unit_price_sek: 65.4, unit: 'elev', quantity: null, period_months: 7, amount_sek: 161909 },
  { id: 2, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', description: '55 kr/elev, 5 månader', unit_price_sek: 55, unit: 'elev', quantity: null, period_months: 5, amount_sek: 88855 },
  { id: 3, contract_id: 1, product_id: null, product_name: 'Begreppa', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 116244 },
  { id: 4, contract_id: 1, product_id: null, product_name: 'Begreppa', description: '3,5 mån tidigare pris', unit_price_sek: null, unit: null, quantity: null, period_months: 3.5, amount_sek: 50341 },
  { id: 5, contract_id: 1, product_id: null, product_name: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, period_months: null, amount_sek: 168300 },
];

const FULL_ALE_GRADES = ['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'];

// DB-row-shaped coverage (as db.listCoverage() returns it).
const ILT_COVERAGE = [
  ...FULL_ALE_GRADES.map((g, i) => ({ id: 10 + i, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', grade_level: g, status: 'full', student_count: 4244 })),
  ...FULL_ALE_GRADES.map((g, i) => ({ id: 20 + i, contract_id: 1, product_id: null, product_name: 'Begreppa', grade_level: g, status: 'full', student_count: 4244 })),
  { id: 30, contract_id: 1, product_id: null, product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
  // Alingsås: Begreppa only in SOME grundskolor, only lower/middle years.
  { id: 40, contract_id: 2, product_id: null, product_name: 'Begreppa', grade_level: '1-3', status: 'partial', student_count: 800 },
  { id: 41, contract_id: 2, product_id: null, product_name: 'Begreppa', grade_level: '4-6', status: 'partial', student_count: null },
];

describe('buildProductRollups — line-item pricing (Ale figures)', () => {
  const rollups = buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE);
  const byName = (n) => rollups.find((r) => r.name === n);

  it('one rollup per product, most-sold first', () => {
    expect(rollups.map((r) => r.name)).toEqual(['Begreppa', 'Inlästa läromedel', 'Polyglutt']);
  });

  it('per-product price = Σ its line-item amounts: Begreppa 166 585, Polyglutt 168 300', () => {
    expect(byName('Begreppa').priceByKommun.find((p) => p.kommun_namn === 'Ale').amount_sek).toBe(166585);
    expect(byName('Polyglutt').priceByKommun.find((p) => p.kommun_namn === 'Ale').amount_sek).toBe(168300);
    expect(byName('Inlästa läromedel').priceByKommun.find((p) => p.kommun_namn === 'Ale').amount_sek).toBe(250764);
  });

  it('a kommun without line items for the product prices as null (ingår, ospecificerat)', () => {
    expect(byName('Begreppa').priceByKommun.find((p) => p.kommun_namn === 'Alingsås').amount_sek).toBeNull();
  });

  it('priceRange spans only the KNOWN per-kommun sums; null when nothing is known', () => {
    expect(byName('Begreppa').priceRange).toEqual({ min: 166585, max: 166585 });
    const noItems = buildProductRollups(iltFacts(), [], ILT_COVERAGE);
    expect(noItems.find((r) => r.name === 'Begreppa').priceRange).toBeNull();
  });

  it('counts and names the selling kommuner', () => {
    expect(byName('Begreppa').kommunCount).toBe(2);
    expect(byName('Begreppa').kommuns).toEqual(['Ale', 'Alingsås']);
    expect(byName('Polyglutt').kommunCount).toBe(1);
  });

  it('dominant pricing model across the product-selling contracts', () => {
    expect(byName('Polyglutt').dominantPricingModel).toBe('tiered');
    expect(['fixed', 'tiered']).toContain(byName('Begreppa').dominantPricingModel);
  });
});

describe('buildProductRollups — coverage matrix aggregation (green/yellow/red/na)', () => {
  const rollups = buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE);
  const byName = (n) => rollups.find((r) => r.name === n);

  it('green only when FULL in all selling kommuner (Inlästa läromedel, single kommun)', () => {
    const g = byName('Inlästa läromedel').coverageByGrade;
    for (const grade of FULL_ALE_GRADES) expect(g[grade]).toBe('green');
  });

  it('yellow on partial or mixed across kommuner (Begreppa: Ale full, Alingsås partial/absent)', () => {
    const g = byName('Begreppa').coverageByGrade;
    expect(g['1-3']).toBe('yellow');   // full + partial
    expect(g['4-6']).toBe('yellow');
    expect(g['7-9']).toBe('yellow');   // full in Ale, no row in Alingsås → mixed
    expect(g['Gymnasiet']).toBe('yellow');
    expect(g['Komvux']).toBe('yellow');
  });

  it('red when the vendor sells the level elsewhere but this product reaches no kommun there', () => {
    expect(byName('Begreppa').coverageByGrade['Förskola']).toBe('red');   // Polyglutt owns Förskola
    expect(byName('Polyglutt').coverageByGrade['1-3']).toBe('red');
    expect(byName('Polyglutt').coverageByGrade['Komvux']).toBe('red');
  });

  it('na when NO contract for this vendor ever references the level', () => {
    for (const r of rollups) {
      expect(r.coverageByGrade['Förskoleklass']).toBe('na');
      expect(r.coverageByGrade['Introduktionsprogrammet']).toBe('na');
      expect(r.coverageByGrade['Högskola']).toBe('na');
    }
  });

  it('per-kommun detail behind each cell (who is full vs partial)', () => {
    const detail = byName('Begreppa').coverageDetail['1-3'];
    expect(detail).toEqual([
      { kommun_kod: '1440', kommun_namn: 'Ale', status: 'full', student_count: 4244 },
      { kommun_kod: '1489', kommun_namn: 'Alingsås', status: 'partial', student_count: 800 },
    ]);
  });

  it('a product with no coverage anywhere is honestly all-na, flagged coverageKnown=false', () => {
    const noCov = buildProductRollups(iltFacts(), ILT_LINE_ITEMS,
      ILT_COVERAGE.filter((r) => r.product_name !== 'Polyglutt'));
    const poly = noCov.find((r) => r.name === 'Polyglutt');
    expect(poly.coverageKnown).toBe(false);
    for (const g of GRADE_LEVELS) expect(poly.coverageByGrade[g]).toBe('na');
    expect(noCov.find((r) => r.name === 'Begreppa').coverageKnown).toBe(true);
  });

  it('empty inputs → empty rollups', () => {
    expect(buildProductRollups([], [], [])).toEqual([]);
  });
});

// Red must mean a CONFIDENT "sold elsewhere, not at this level" — which
// requires at least one collection-complete kommun to lack the level. When
// only in-progress kommuner lack it, the honest aggregate is 'unknown'.
// `doneKods` = kommun_kods whose collection is complete (all convs DONE);
// omitted → legacy behavior (every kommun treated as complete).
describe('buildProductRollups — red requires a collection-complete kommun (doneKods)', () => {
  const withDone = (doneKods) =>
    buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE, { doneKods });
  const byName = (rollups, n) => rollups.find((r) => r.name === n);

  it('stays red when a DONE kommun lacks the level (both kommuner done)', () => {
    const r = withDone(new Set(['1440', '1489']));
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('red');
    expect(byName(r, 'Polyglutt').coverageByGrade['1-3']).toBe('red');
  });

  it('unknown, not red, when ONLY in-progress kommuner lack the level', () => {
    const r = withDone(new Set()); // nobody's collection is finished
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('unknown');
    expect(byName(r, 'Polyglutt').coverageByGrade['1-3']).toBe('unknown');
    expect(byName(r, 'Polyglutt').coverageByGrade['Komvux']).toBe('unknown');
  });

  it('one DONE kommun among the lacking ones is enough for red', () => {
    // Only Alingsås is done; it sells Begreppa but lacks Förskola → red.
    const r = withDone(new Set(['1489']));
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('red');
    // Polyglutt is sold only in Ale (not done) → its uncovered levels are unknown.
    expect(byName(r, 'Polyglutt').coverageByGrade['1-3']).toBe('unknown');
  });

  it('green/yellow/na are untouched by completion state', () => {
    const r = withDone(new Set()); // nothing done — positives still stand
    const inlasta = byName(r, 'Inlästa läromedel');
    for (const grade of FULL_ALE_GRADES) expect(inlasta.coverageByGrade[grade]).toBe('green');
    expect(byName(r, 'Begreppa').coverageByGrade['1-3']).toBe('yellow');
    expect(byName(r, 'Begreppa').coverageByGrade['Förskoleklass']).toBe('na');
  });

  it('omitting doneKods keeps the legacy confident-red behavior', () => {
    const r = buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE);
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('red');
  });
});

// Framework/reseller awareness: a kommun that procures via a channel
// (Adda/Atea/Skolon/Läromedia — src/resellers.js) can HAVE a product without
// a direct contract, so it can never anchor a confident red. Red now needs
// >=1 collection-complete AND non-reseller kommun lacking the level; when the
// only lacking kommuner procure via a channel, the honest aggregate is
// 'unknown' (kan finnas via ramavtal).
describe('buildProductRollups — reseller-procuring kommuner cannot anchor red (resellerKods)', () => {
  const allDone = new Set(['1440', '1489']);
  const roll = (resellerKods) =>
    buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE, { doneKods: allDone, resellerKods });
  const byName = (rollups, n) => rollups.find((r) => r.name === n);

  it('unknown, not red, when every lacking kommun procures via a reseller', () => {
    const r = roll(new Set(['1440', '1489']));
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('unknown');
    expect(byName(r, 'Polyglutt').coverageByGrade['1-3']).toBe('unknown');
  });

  it('stays red while at least one complete NON-reseller kommun lacks the level', () => {
    // Ale procures via a channel, Alingsås does not → Alingsås anchors red
    // for Begreppa (sold in both); Polyglutt is Ale-only → unknown.
    const r = roll(new Set(['1440']));
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('red');
    expect(byName(r, 'Polyglutt').coverageByGrade['1-3']).toBe('unknown');
  });

  it('an in-progress reseller kommun is doubly unable to anchor red', () => {
    const r = buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE,
      { doneKods: new Set(['1489']), resellerKods: new Set(['1489']) });
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('unknown');
  });

  it('green/yellow/na are untouched by reseller state', () => {
    const r = roll(new Set(['1440', '1489']));
    const inlasta = byName(r, 'Inlästa läromedel');
    for (const grade of FULL_ALE_GRADES) expect(inlasta.coverageByGrade[grade]).toBe('green');
    expect(byName(r, 'Begreppa').coverageByGrade['1-3']).toBe('yellow');
    expect(byName(r, 'Begreppa').coverageByGrade['Förskoleklass']).toBe('na');
  });

  it('omitting resellerKods keeps the previous behavior', () => {
    const r = buildProductRollups(iltFacts(), ILT_LINE_ITEMS, ILT_COVERAGE, { doneKods: allDone });
    expect(byName(r, 'Begreppa').coverageByGrade['Förskola']).toBe('red');
  });
});

describe('avg annual per kommun (vendor rollup KPI)', () => {
  it('total known annual ÷ distinct kommuner, rounded', () => {
    const rollups = buildVendorRollups(iltFacts(), { now: NOW });
    // 'ILT Education' canonicalizes to the ILT cluster (2026-07-19 design).
    const ilt = rollups.find((r) => r.vendor_name === 'Inläsningstjänst (ILT)');
    expect(ilt.total_annual_sek).toBe(685649);
    expect(ilt.kommun_count).toBe(2);
    expect(ilt.avg_annual_per_kommun).toBe(342825); // round(685649 / 2)
  });

  it('null (never 0) when no contract value is known', () => {
    const facts = iltFacts().map((f) => ({ ...f, annual_value_sek: null, avtalsvarde: null }));
    const rollups = buildVendorRollups(facts, { now: NOW });
    expect(rollups[0].avg_annual_per_kommun).toBeNull();
  });
});
