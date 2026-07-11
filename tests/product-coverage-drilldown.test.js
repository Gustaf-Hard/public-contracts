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

  function seedAttachment(kod, namn, filename) {
    const convId = db.createConversation({
      kommun_kod: kod, kommun_namn: namn, role: 'central',
      contact_email: `reg@${kod}.se`, scheduled_send_at: '2026-04-01T08:00:00Z',
    });
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
    const skolon = db.upsertVendor('Skolon');
    db.recordContract({
      attachment_id: seedAttachment('1470', 'Vara', 'Skolon-Vara.pdf'),
      vendor_id: skolon.id, is_contract: 1,
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
