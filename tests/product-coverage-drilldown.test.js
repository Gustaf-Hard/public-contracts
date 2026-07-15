// tests/product-coverage-drilldown.test.js
// Product-coverage drill-down: the dossier's product×grade matrix pivoted to
// kommun×grade for ONE product. Rows are every kommun we hold ANY collected
// contract data for — so an all-red row honestly means "has given us
// contracts, but none for this product", never "unknown". Pure analytics
// here; views and the route are tested further down.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import {
  GRADE_LEVELS,
  buildContractFacts,
  buildProductCoverageByKommun,
  slugifyProductName,
} from '../src/vendor-analytics.js';
import { renderProductCoverage, renderVendorDossier } from '../src/dashboard-views.js';
import { buildProductRollups, buildVendorRollups } from '../src/vendor-analytics.js';

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
// vendor, so it belongs here even though ILT never appears there. All three
// are collection-complete (every conversation DONE), so a missing product
// honestly renders as 'none'.
const DATA_KOMMUNER = [
  { kommun_kod: '1470', kommun_namn: 'Vara', collection_done: true },
  { kommun_kod: '1440', kommun_namn: 'Ale', collection_done: true },
  { kommun_kod: '1489', kommun_namn: 'Alingsås', collection_done: true },
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

// Regression for the data-honesty bug (2026-07-11): a kommun whose collection
// is still in progress (any conversation not DONE) must NOT be painted red
// ("not sold here") for products it lacks — we simply don't know yet. Fixture
// mirrors the live Begreppa case: Ale is DONE, Arjeplog is still DELIVERING.
// Arjeplog holds a contract (so it IS a data-kommun) but its conversation is
// still DELIVERING — more contracts may arrive.
const IN_PROGRESS_KOMMUNER = [
  { kommun_kod: '1440', kommun_namn: 'Ale', collection_done: true },
  { kommun_kod: '1489', kommun_namn: 'Alingsås', collection_done: false },
  { kommun_kod: '2506', kommun_namn: 'Arjeplog', collection_done: false },
];

function begreppaInProgress() {
  return buildProductCoverageByKommun({
    vendorName: 'ILT Education', productName: 'Begreppa',
    facts: iltFacts(), coverage: COVERAGE, dataKommuner: IN_PROGRESS_KOMMUNER,
  });
}

describe('buildProductCoverageByKommun — collection_done gates none vs unknown', () => {
  it('a DONE kommun lacking the product/level → none (confident red)', () => {
    const ale = begreppaInProgress().kommuner.find((k) => k.kommun_namn === 'Ale');
    expect(ale.coverageByGrade['Förskola']).toBe('none'); // Polyglutt-only level, Ale is DONE
  });

  it('an in-progress kommun lacking the product entirely → unknown everywhere applicable (Arjeplog, DELIVERING)', () => {
    const arjeplog = begreppaInProgress().kommuner.find((k) => k.kommun_namn === 'Arjeplog');
    for (const g of GRADE_LEVELS) {
      expect(arjeplog.coverageByGrade[g]).toBe(NA_GRADES.includes(g) ? 'na' : 'unknown');
    }
  });

  it('a kommun that HAS the product keeps full/partial even while not DONE (Alingsås)', () => {
    const alingsas = begreppaInProgress().kommuner.find((k) => k.kommun_namn === 'Alingsås');
    expect(alingsas.coverageByGrade['1-3']).toBe('partial');
    expect(alingsas.coverageByGrade['4-6']).toBe('partial');
    // …but its UNcovered applicable levels are unknown, not none.
    expect(alingsas.coverageByGrade['7-9']).toBe('unknown');
    expect(alingsas.coverageByGrade['Gymnasiet']).toBe('unknown');
  });

  it('na is still na regardless of completion state', () => {
    for (const k of begreppaInProgress().kommuner) {
      for (const g of NA_GRADES) expect(k.coverageByGrade[g]).toBe('na');
    }
  });

  it('a data-kommun without a collection_done flag is treated as complete (legacy callers)', () => {
    const r = buildProductCoverageByKommun({
      vendorName: 'ILT Education', productName: 'Begreppa',
      facts: iltFacts(), coverage: COVERAGE,
      dataKommuner: [{ kommun_kod: '1470', kommun_namn: 'Vara' }],
    });
    expect(r.kommuner[0].coverageByGrade['1-3']).toBe('none');
  });
});

// Framework/reseller awareness (Alingsås-via-Atea style): a kommun with a
// non-empty reseller_channels procures via a framework/reseller channel, so
// it can HAVE a product without us seeing a direct contract. Even when its
// collection is COMPLETE, its missing cells must say 'unknown' (kan finnas
// via ramavtal) — never a confident 'none'.
const RESELLER_KOMMUNER = [
  { kommun_kod: '1440', kommun_namn: 'Ale', collection_done: true, reseller_channels: [] },
  { kommun_kod: '1489', kommun_namn: 'Alingsås', collection_done: true, reseller_channels: ['Atea'] },
  { kommun_kod: '1470', kommun_namn: 'Vara', collection_done: true, reseller_channels: [] },
];

function begreppaWithResellers() {
  return buildProductCoverageByKommun({
    vendorName: 'ILT Education', productName: 'Begreppa',
    facts: iltFacts(), coverage: COVERAGE, dataKommuner: RESELLER_KOMMUNER,
  });
}

describe('buildProductCoverageByKommun — reseller channels soften none to unknown', () => {
  it('a collection-COMPLETE kommun procuring via a reseller: lacking cells → unknown, NOT none (the key regression)', () => {
    const alingsas = begreppaWithResellers().kommuner.find((k) => k.kommun_namn === 'Alingsås');
    expect(alingsas.coverageByGrade['7-9']).toBe('unknown');
    expect(alingsas.coverageByGrade['Gymnasiet']).toBe('unknown');
    expect(alingsas.coverageByGrade['Komvux']).toBe('unknown');
    expect(alingsas.coverageByGrade['Förskola']).toBe('unknown'); // Polyglutt-owned level
  });

  it('positives stand regardless: the reseller kommun keeps its full/partial cells', () => {
    const alingsas = begreppaWithResellers().kommuner.find((k) => k.kommun_namn === 'Alingsås');
    expect(alingsas.coverageByGrade['1-3']).toBe('partial');
    expect(alingsas.coverageByGrade['4-6']).toBe('partial');
  });

  it('a complete NON-reseller kommun lacking the product is still confidently none (Vara)', () => {
    const vara = begreppaWithResellers().kommuner.find((k) => k.kommun_namn === 'Vara');
    for (const g of GRADE_LEVELS) {
      expect(vara.coverageByGrade[g]).toBe(NA_GRADES.includes(g) ? 'na' : 'none');
    }
  });

  it('a kommun that HAS the product stays full (Ale)', () => {
    const ale = begreppaWithResellers().kommuner.find((k) => k.kommun_namn === 'Ale');
    for (const g of ALE_GRADES) expect(ale.coverageByGrade[g]).toBe('full');
  });

  it('na stays na for reseller kommuner too', () => {
    const alingsas = begreppaWithResellers().kommuner.find((k) => k.kommun_namn === 'Alingsås');
    for (const g of NA_GRADES) expect(alingsas.coverageByGrade[g]).toBe('na');
  });

  it('rows carry reseller_channels + collection_done so the view can badge and word tooltips', () => {
    const r = begreppaWithResellers();
    expect(r.kommuner.find((k) => k.kommun_namn === 'Alingsås').reseller_channels).toEqual(['Atea']);
    expect(r.kommuner.find((k) => k.kommun_namn === 'Alingsås').collection_done).toBe(true);
    expect(r.kommuner.find((k) => k.kommun_namn === 'Vara').reseller_channels).toEqual([]);
  });

  it('an in-progress reseller kommun is unknown as well (both reasons point the same way)', () => {
    const r = buildProductCoverageByKommun({
      vendorName: 'ILT Education', productName: 'Begreppa',
      facts: iltFacts(), coverage: COVERAGE,
      dataKommuner: [{ kommun_kod: '2506', kommun_namn: 'Arjeplog', collection_done: false, reseller_channels: ['Skolon'] }],
    });
    expect(r.kommuner[0].coverageByGrade['1-3']).toBe('unknown');
  });
});

describe('slugifyProductName — same rule as vendor slugs', () => {
  it('folds å/ä/ö and kebab-cases', () => {
    expect(slugifyProductName('Inlästa läromedel')).toBe('inlasta-laromedel');
    expect(slugifyProductName('Begreppa')).toBe('begreppa');
    expect(slugifyProductName('Skolon Plattform 2.0')).toBe('skolon-plattform-2-0');
  });
});

// ---- View: renderProductCoverage --------------------------------------------

const VENDOR = { id: 7, name: 'ILT Education', slug: 'ilt-education' };

// The <tr> for one kommun (matrix rows carry a /kommun/:kod link first).
function rowFor(html, kod) {
  const m = html.match(new RegExp(`<tr>\\s*<td><a href="/kommun/${kod}"[\\s\\S]*?</tr>`));
  return m ? m[0] : null;
}

describe('renderProductCoverage — kommun×grade matrix view', () => {
  const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppa() });

  it('header names product + vendor, and links back to the dossier', () => {
    expect(html).toContain('Begreppa — ILT Education · täckning per kommun');
    expect(html).toContain('href="/leverantor/ilt-education"');
  });

  it('summary line is honest about the row universe', () => {
    expect(html).toContain('2 av 3 kommuner (med data) har produkten');
    expect(html).toContain('endast kommuner vi hämtat avtal från');
  });

  it('renders all nine grade columns and one row per data-kommun', () => {
    for (const label of ['Förskola', 'F-klass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux', 'IM', 'Högskola']) {
      expect(html).toContain(`>${label}</th>`);
    }
    for (const kod of ['1440', '1489', '1470']) expect(rowFor(html, kod)).not.toBeNull();
  });

  it('full/partial cells carry cov-full/cov-partial (Ale full, Alingsås partial)', () => {
    const ale = rowFor(html, '1440');
    expect((ale.match(/cov-cell cov-full/g) ?? [])).toHaveLength(5); // 1-3..Komvux
    const alingsas = rowFor(html, '1489');
    expect((alingsas.match(/cov-cell cov-partial/g) ?? [])).toHaveLength(2); // 1-3, 4-6
    expect(alingsas).toContain('cov-cell cov-none');
  });

  it('the "not sold" kommun renders an all-red row (none everywhere applicable, na elsewhere)', () => {
    const vara = rowFor(html, '1470');
    expect((vara.match(/cov-cell cov-none/g) ?? [])).toHaveLength(6);
    expect((vara.match(/cov-cell cov-na/g) ?? [])).toHaveLength(3);
    expect(vara).not.toContain('cov-full');
    expect(vara).not.toContain('cov-partial');
  });

  it('legend adapts red to "har avtal med oss men inte denna produkt/nivå"', () => {
    expect(html).toContain('har avtal med oss men inte denna produkt/nivå');
    expect(html).toContain('nivån förekommer inte i leverantörens avtal');
  });
});

describe('renderProductCoverage — unknown cells while collection is in progress', () => {
  // In-progress kommuner are hidden by default; showAll surfaces them.
  const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaInProgress(), showAll: true });

  it('an in-progress kommun lacking the product renders cov-unknown "?" — never cov-none (Arjeplog)', () => {
    const arjeplog = rowFor(html, '2506');
    expect((arjeplog.match(/cov-cell cov-unknown/g) ?? [])).toHaveLength(6);
    expect((arjeplog.match(/cov-cell cov-na/g) ?? [])).toHaveLength(3);
    expect(arjeplog).not.toContain('cov-none');
    expect(arjeplog).toContain('>?</td>');
    expect(arjeplog).toContain('insamling pågår');
  });

  it('a DONE kommun keeps confident red cells (Ale at Förskola)', () => {
    expect(rowFor(html, '1440')).toContain('cov-cell cov-none');
  });

  it('positives survive an unfinished collection (Alingsås partial cells)', () => {
    const alingsas = rowFor(html, '1489');
    expect((alingsas.match(/cov-cell cov-partial/g) ?? [])).toHaveLength(2);
    expect(alingsas).toContain('cov-cell cov-unknown');
    expect(alingsas).not.toContain('cov-none');
  });

  it('legend explains the ? state', () => {
    expect(html).toContain('? · insamling pågår (vet inte än)');
  });
});

describe('renderProductCoverage — done-only default + show-all toggle', () => {
  // begreppaInProgress: Ale done; Alingsås + Arjeplog still in progress.
  it('default view hides in-progress kommuner, showing only complete ones (Ale)', () => {
    const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaInProgress() });
    expect(rowFor(html, '1440')).not.toBeNull();       // Ale — done
    expect(rowFor(html, '1489')).toBeNull();           // Alingsås — in progress, hidden
    expect(rowFor(html, '2506')).toBeNull();           // Arjeplog — in progress, hidden
  });

  it('default summary counts only complete kommuner and names how many are hidden', () => {
    const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaInProgress() });
    expect(html).toContain('1 av 1 klara kommuner har produkten');
    expect(html).toContain('2 med pågående insamling är dolda');
  });

  it('default view offers a "visa alla" toggle carrying the in-progress count', () => {
    const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaInProgress() });
    expect(html).toContain('href="/leverantor/ilt-education/produkt/begreppa?visa=alla"');
    expect(html).toContain('Visa alla (inkl. 2 med insamling pågår)');
  });

  it('showAll reveals every kommun and offers the reverse toggle', () => {
    const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaInProgress(), showAll: true });
    for (const kod of ['1440', '1489', '2506']) expect(rowFor(html, kod)).not.toBeNull();
    expect(html).toContain('Visa endast klara kommuner');
    expect(html).toContain('kommuner (med data) har produkten');
  });

  it('no toggle and classic wording when nothing is in progress', () => {
    const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppa() });
    expect(html).not.toContain('class="cov-toggle"');   // the CSS rule is always present; the link is not
    expect(html).not.toContain('visa=alla');
    expect(html).toContain('2 av 3 kommuner (med data) har produkten');
  });
});

describe('renderProductCoverage — reseller badge + softened cells', () => {
  const html = renderProductCoverage({ vendor: VENDOR, drilldown: begreppaWithResellers() });

  it('a reseller-procuring kommun carries the 🛒 via ramavtal badge with its channels', () => {
    const alingsas = rowFor(html, '1489');
    expect(alingsas).toContain('pill-reseller');
    expect(alingsas).toContain('🛒 via ramavtal: Atea');
  });

  it('non-reseller kommuner carry no badge', () => {
    expect(rowFor(html, '1440')).not.toContain('pill-reseller');
    expect(rowFor(html, '1470')).not.toContain('pill-reseller');
    expect(rowFor(html, '1470')).not.toContain('via ramavtal');
  });

  it('the complete reseller kommun renders ? with a ramavtal tooltip — never ✕ (key regression)', () => {
    const alingsas = rowFor(html, '1489');
    expect(alingsas).toContain('cov-cell cov-unknown');
    expect(alingsas).toContain('kan finnas via ramavtal (Atea)');
    expect(alingsas).not.toContain('cov-none');
    // …while its positives stand.
    expect((alingsas.match(/cov-cell cov-partial/g) ?? [])).toHaveLength(2);
  });

  it('a plain complete kommun keeps its confident red row (Vara)', () => {
    const vara = rowFor(html, '1470');
    expect(vara).toContain('cov-cell cov-none');
    expect(vara).not.toContain('cov-unknown');
  });

  it('legend explains that a ? on a reseller kommun means "kan finnas via ramavtal"', () => {
    expect(html).toContain('🛒 via ramavtal');
    expect(html).toContain('kan finnas via ramavtal');
  });

  it('no reseller kommuner → no ramavtal legend noise', () => {
    const plain = renderProductCoverage({ vendor: VENDOR, drilldown: begreppa() });
    expect(plain).not.toContain('via ramavtal');
  });
});

// ---- Dossier: product names in the coverage matrix link to the drill-down ---

describe('dossier coverage matrix links each product to its drill-down', () => {
  const facts = iltFacts();
  const html = renderVendorDossier({
    vendor: VENDOR,
    rollup: buildVendorRollups(facts, { now: NOW })[0],
    facts,
    productRollups: buildProductRollups(facts, [], COVERAGE),
    todayIso: '2026-07-11',
  });

  it('PRODUKT-column cells are links to /leverantor/<slug>/produkt/<productSlug>', () => {
    expect(html).toContain('href="/leverantor/ilt-education/produkt/begreppa"');
    expect(html).toContain('href="/leverantor/ilt-education/produkt/polyglutt"');
  });

  it('the link wraps the product name in the coverage matrix row', () => {
    expect(html).toMatch(/<a href="\/leverantor\/ilt-education\/produkt\/begreppa"[^>]*>Begreppa<\/a>/);
  });
});

// ---- Route: GET /leverantor/:slug/produkt/:productSlug -----------------------

describe('route: GET /leverantor/:slug/produkt/:productSlug', () => {
  let tmp, db;

  const MUNICIPALITIES = [
    { kommun_kod: '1440', kommun_namn: 'Ale', lan: 'Västra Götalands län', folkmangd: 33000, contacts: [] },
    { kommun_kod: '1489', kommun_namn: 'Alingsås', lan: 'Västra Götalands län', folkmangd: 42186, contacts: [] },
    { kommun_kod: '1470', kommun_namn: 'Vara', lan: 'Västra Götalands län', folkmangd: 16000, contacts: [] },
  ];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pcov-route-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function seedAttachment(kod, namn, filename, { state = 'DONE' } = {}) {
    const convId = db.createConversation({
      kommun_kod: kod, kommun_namn: namn, role: 'central',
      contact_email: `reg@${kod}.se`, scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    // Collection state matters now: DONE kommuner may be painted red for
    // missing products; anything else must render as unknown.
    db.updateConversationState(convId, state);
    const msgId = db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: `reg@${kod}.se`, to_email: 'me@x.com', subject: 'Avtal', body_text: '',
      classification: null, classification_confidence: null,
      received_at: '2026-06-01T10:00:00Z', attachment_count: 1,
    });
    return db.recordAttachment({
      message_id: msgId, filename, saved_path: join(tmp, kod, filename),
      mime_type: 'application/pdf', size_bytes: 1000,
    });
  }

  function seedIltWorld() {
    const ilt = db.upsertVendor('ILT Education');
    // Ale: Begreppa, full coverage 1-3.
    const cAle = db.recordContract({
      attachment_id: seedAttachment('1440', 'Ale', 'ILT-Ale.pdf'),
      vendor_id: ilt.id, is_contract: 1, annual_value_sek: 585649, pricing_model: 'tiered',
    });
    db.linkContractProduct(cAle, db.upsertProduct(ilt.id, 'Begreppa'));
    db.replaceContractCoverage(cAle, [
      { product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: 4244 },
    ]);
    // Alingsås: Begreppa, partial coverage 1-3.
    const cAli = db.recordContract({
      attachment_id: seedAttachment('1489', 'Alingsås', 'ILT-Alingsas.pdf'),
      vendor_id: ilt.id, is_contract: 1, annual_value_sek: 100000, pricing_model: 'fixed',
    });
    db.linkContractProduct(cAli, db.upsertProduct(ilt.id, 'Begreppa'));
    db.replaceContractCoverage(cAli, [
      { product_name: 'Begreppa', grade_level: '1-3', status: 'partial', student_count: 800 },
    ]);
    // Vara: has stored contract data — but from ANOTHER vendor entirely.
    // Deliberately a NON-reseller vendor: a Skolon/Atea contract would make
    // Vara reseller-procuring and honestly soften its red to unknown.
    const gleerups = db.upsertVendor('Gleerups');
    db.recordContract({
      attachment_id: seedAttachment('1470', 'Vara', 'Gleerups-Vara.pdf'),
      vendor_id: gleerups.id, is_contract: 1,
    });
    return db;
  }

  async function get(app, path) {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => {
          const text = await r.text();
          server.close(() => resolve({ status: r.status, text }));
        }).catch((e) => server.close(() => reject(e)));
      });
    });
  }

  it('200 for a real product: kommun rows from ALL data-kommuner, incl. the all-red one', async () => {
    seedIltWorld();
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/ilt-education/produkt/begreppa');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Begreppa — ILT Education · täckning per kommun');
    expect(res.text).toContain('2 av 3 kommuner (med data) har produkten');
    // Ale full, Alingsås partial — Vara (other vendor's kommun) appears all-red.
    expect(res.text).toContain('cov-cell cov-full');
    expect(res.text).toContain('cov-cell cov-partial');
    expect(res.text).toContain('href="/kommun/1470"');
    const vara = res.text.match(/<tr>\s*<td><a href="\/kommun\/1470"[\s\S]*?<\/tr>/)[0];
    expect(vara).toContain('cov-cell cov-none');
    expect(vara).not.toContain('cov-full');
    // Back link to the dossier.
    expect(res.text).toContain('href="/leverantor/ilt-education"');
  });

  it('an in-progress kommun is hidden by default but shown (cov-unknown, never cov-none) under ?visa=alla (Arjeplog DELIVERING regression)', async () => {
    seedIltWorld();
    // Arjeplog delivered ONE contract (another non-reseller vendor's) but its
    // conversation is still DELIVERING — its missing Begreppa is unknown
    // because collection is in progress, not because of any reseller channel.
    const gleerups = db.getVendorBySlug('gleerups') ?? db.upsertVendor('Gleerups');
    db.recordContract({
      attachment_id: seedAttachment('2506', 'Arjeplog', 'Gleerups-Arjeplog.pdf', { state: 'DELIVERING' }),
      vendor_id: gleerups.id, is_contract: 1,
    });
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });

    // Default view hides the in-progress kommun and offers the toggle.
    const def = await get(app, '/leverantor/ilt-education/produkt/begreppa');
    expect(def.status).toBe(200);
    expect(def.text).not.toMatch(/<tr>\s*<td><a href="\/kommun\/2506"/);
    expect(def.text).toContain('?visa=alla');

    // ?visa=alla reveals it, rendered as unknown (insamling pågår), never red.
    const res = await get(app, '/leverantor/ilt-education/produkt/begreppa?visa=alla');
    expect(res.status).toBe(200);
    const arjeplog = res.text.match(/<tr>\s*<td><a href="\/kommun\/2506"[\s\S]*?<\/tr>/)[0];
    expect(arjeplog).toContain('cov-cell cov-unknown');
    expect(arjeplog).toContain('insamling pågår');
    expect(arjeplog).not.toContain('cov-none');
    // Vara's collection IS done — its red stays red.
    const vara = res.text.match(/<tr>\s*<td><a href="\/kommun\/1470"[\s\S]*?<\/tr>/)[0];
    expect(vara).toContain('cov-cell cov-none');
    // The legend explains the new state.
    expect(res.text).toContain('? · insamling pågår (vet inte än)');
  });

  it('a reseller-procuring kommun renders the badge and ? instead of red (Alingsås-via-Atea style)', async () => {
    seedIltWorld();
    // Boden's collection is DONE, but its only contract is with Atea — a
    // reseller channel. Its missing Begreppa must render "?" (kan finnas via
    // ramavtal), never a confident red, and the row carries the badge.
    const atea = db.upsertVendor('Atea Sverige AB');
    db.recordContract({
      attachment_id: seedAttachment('2582', 'Boden', 'Atea-Boden.pdf'),
      vendor_id: atea.id, is_contract: 1,
    });
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/ilt-education/produkt/begreppa');
    expect(res.status).toBe(200);
    const boden = res.text.match(/<tr>\s*<td><a href="\/kommun\/2582"[\s\S]*?<\/tr>/)[0];
    expect(boden).toContain('🛒 via ramavtal: Atea');
    expect(boden).toContain('pill-reseller');
    expect(boden).toContain('cov-cell cov-unknown');
    expect(boden).toContain('kan finnas via ramavtal (Atea)');
    expect(boden).not.toContain('cov-none');
    // Vara buys direct and is complete — its red is untouched.
    const vara = res.text.match(/<tr>\s*<td><a href="\/kommun\/1470"[\s\S]*?<\/tr>/)[0];
    expect(vara).toContain('cov-cell cov-none');
    expect(vara).not.toContain('pill-reseller');
    // Legend explains the reseller ?.
    expect(res.text).toContain('kan finnas via ramavtal utan direktavtal');
  });

  it('the vendor dossier badges reseller-procuring kommuner in its kommun list', async () => {
    seedIltWorld();
    const atea = db.upsertVendor('Atea Sverige AB');
    db.recordContract({
      attachment_id: seedAttachment('2582', 'Boden', 'Atea-Boden.pdf'),
      vendor_id: atea.id, is_contract: 1,
    });
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/atea-sverige-ab');
    expect(res.status).toBe(200);
    expect(res.text).toContain('🛒 via ramavtal: Atea'); // Boden's row badge
    // The ILT dossier lists only direct-buying kommuner → no badge there.
    const ilt = await get(app, '/leverantor/ilt-education');
    expect(ilt.text).not.toContain('🛒 via ramavtal');
  });

  it('404 for an unknown product within a real vendor', async () => {
    seedIltWorld();
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    expect((await get(app, '/leverantor/ilt-education/produkt/okand-produkt')).status).toBe(404);
  });

  it('404 for an unknown vendor', async () => {
    seedIltWorld();
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    expect((await get(app, '/leverantor/nope/produkt/begreppa')).status).toBe(404);
  });
});
