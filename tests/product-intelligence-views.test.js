// tests/product-intelligence-views.test.js
// The vendor dossier's product-intelligence surfaces
// (2026-07-10-product-intelligence-design.md): the per-product price table,
// the grade-coverage matrix and the "Snitt per kommun" KPI. Rendering is
// pure; the route test runs against a temp-dir SQLite DB — never the live one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { renderVendorDossier } from '../src/dashboard-views.js';
import {
  buildContractFacts,
  buildVendorRollups,
  buildProductRollups,
} from '../src/vendor-analytics.js';

const NOW = new Date('2026-07-10T12:00:00Z');
const TODAY = '2026-07-10';
const sek = (n) => n.toLocaleString('sv-SE');

const MUNICIPALITIES = [
  { kommun_kod: '1440', kommun_namn: 'Ale', lan: 'Västra Götalands län', folkmangd: 33000, contacts: [] },
  { kommun_kod: '1489', kommun_namn: 'Alingsås', lan: 'Västra Götalands län', folkmangd: 42186, contacts: [] },
];

// The ILT-shaped fixture: Ale with the real line-item breakdown, Alingsås
// buying only Begreppa as a lump sum with partial coverage.
const FACT_ROWS = [
  {
    contract_id: 1, vendor_id: 7, vendor_name: 'ILT Education', vendor_slug: 'ilt-education',
    kommun_kod: '1440', kommun_namn: 'Ale',
    avtalsvarde: '585 649 SEK år 1', valuta: 'SEK',
    period_start: '2025-01-31', period_end: '2028-01-30',
    auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
    annual_value_sek: 585649, one_time_value_sek: null, pricing_model: 'tiered',
    unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
    confidence: 0.95, summary: 'ILT', attachment_id: 101, filename: 'ILT-Ale.pdf',
    received_at: '2026-06-01T10:00:00Z', products: ['Begreppa', 'Inlästa läromedel', 'Polyglutt'],
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
];

const LINE_ITEMS = [
  { id: 1, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', description: '65,40 kr/elev, 7 månader', unit_price_sek: 65.4, unit: 'elev', quantity: null, period_months: 7, amount_sek: 161909 },
  { id: 2, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', description: '55 kr/elev, 5 månader', unit_price_sek: 55, unit: 'elev', quantity: null, period_months: 5, amount_sek: 88855 },
  { id: 3, contract_id: 1, product_id: null, product_name: 'Begreppa', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 116244 },
  { id: 4, contract_id: 1, product_id: null, product_name: 'Begreppa', description: '3,5 mån tidigare pris', unit_price_sek: null, unit: null, quantity: null, period_months: 3.5, amount_sek: 50341 },
  { id: 5, contract_id: 1, product_id: null, product_name: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, period_months: null, amount_sek: 168300 },
];

const ALE_GRADES = ['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'];
const COVERAGE = [
  ...ALE_GRADES.map((g, i) => ({ id: 10 + i, contract_id: 1, product_id: null, product_name: 'Inlästa läromedel', grade_level: g, status: 'full', student_count: 4244 })),
  ...ALE_GRADES.map((g, i) => ({ id: 20 + i, contract_id: 1, product_id: null, product_name: 'Begreppa', grade_level: g, status: 'full', student_count: 4244 })),
  { id: 30, contract_id: 1, product_id: null, product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
  { id: 40, contract_id: 2, product_id: null, product_name: 'Begreppa', grade_level: '1-3', status: 'partial', student_count: 800 },
];

function renderedDossier({ lineItems = LINE_ITEMS, coverage = COVERAGE, doneKods = null } = {}) {
  const lan = new Map(MUNICIPALITIES.map((m) => [m.kommun_kod, m.lan]));
  const facts = buildContractFacts(FACT_ROWS, { lanByKommunKod: lan, now: NOW });
  const rollups = buildVendorRollups(facts, { now: NOW });
  return renderVendorDossier({
    vendor: { id: 7, name: 'ILT Education', slug: 'ilt-education' },
    rollup: rollups[0],
    facts,
    productRollups: buildProductRollups(facts, lineItems, coverage, { doneKods }),
    todayIso: TODAY,
  });
}

describe('dossier product table (Produkt · Kommuner · Pris · Prismodell)', () => {
  it('renders a row per product with the summed line-item price', () => {
    const html = renderedDossier();
    expect(html).toContain('<th>Produkt</th>');
    expect(html).toContain('Kommuner');
    expect(html).toContain('Pris');
    expect(html).toContain('Prismodell');
    expect(html).toContain('Begreppa');
    expect(html).toContain(`${sek(166585)} kr`);
    expect(html).toContain(`${sek(168300)} kr`);
    expect(html).toContain(`${sek(250764)} kr`);
  });

  it('a product sold only as part of a lump sum shows "ingår, ospecificerat pris"', () => {
    const html = renderedDossier({ lineItems: [] });
    expect(html).toContain('ingår, ospecificerat pris');
    expect(html).not.toContain(`${sek(166585)} kr`);
  });

  it('is honest about per-kommun price completeness (Begreppa known in 1 of 2)', () => {
    const html = renderedDossier();
    expect(html).toContain('känd för 1 av 2 kommuner');
  });
});

describe('dossier coverage matrix', () => {
  it('renders all nine grade columns', () => {
    const html = renderedDossier();
    for (const label of ['Förskola', 'F-klass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux', 'IM', 'Högskola']) {
      expect(html).toContain(`>${label}</th>`);
    }
  });

  it('colours cells green / yellow / red / neutral with the right classes', () => {
    const html = renderedDossier();
    expect(html).toContain('cov-cell cov-full');     // Inlästa läromedel all-full
    expect(html).toContain('cov-cell cov-partial');  // Begreppa mixed
    expect(html).toContain('cov-cell cov-none');     // Polyglutt outside Förskola
    expect(html).toContain('cov-cell cov-na');       // Högskola never referenced
  });

  it('a cell expands to per-kommun detail (who is full vs partial)', () => {
    const html = renderedDossier();
    expect(html).toContain('<details class="cov-detail">');
    expect(html).toContain('Ale: full täckning');
    expect(html).toContain('Alingsås: delvis');
  });

  it('no extracted coverage at all → an honest note instead of a fabricated matrix', () => {
    const html = renderedDossier({ coverage: [] });
    expect(html).toContain('Ingen täckningsdata');
    expect(html).not.toContain('cov-cell cov-full');
  });

  // Data honesty (2026-07-11): the aggregate goes red only when a
  // collection-COMPLETE kommun lacks the level; while only in-progress
  // kommuner lack it, the cell must say "?" (unknown), not "✕".
  it('unknown aggregate → cov-unknown "?" when only in-progress kommuner lack the level', () => {
    const html = renderedDossier({ doneKods: new Set() }); // nobody's collection is done
    expect(html).toContain('cov-cell cov-unknown');
    expect(html).toContain('insamling pågår');
    expect(html).not.toContain('cov-cell cov-none'); // no confident red anywhere
  });

  it('a collection-complete kommun keeps the confident red aggregate', () => {
    const html = renderedDossier({ doneKods: new Set(['1440', '1489']) });
    expect(html).toContain('cov-cell cov-none'); // Polyglutt outside Förskola
    expect(html).not.toContain('cov-cell cov-unknown');
  });

  it('legend explains the ? state', () => {
    const html = renderedDossier();
    expect(html).toContain('? · insamling pågår (vet inte än)');
  });
});

describe('dossier "Snitt per kommun" KPI', () => {
  it('shows total known annual ÷ distinct kommuner with a completeness note', () => {
    const html = renderedDossier();
    expect(html).toContain('Snitt per kommun');
    expect(html).toContain('343 tkr/år'); // round(685 649 / 2) compact
  });

  it('unknown values render okänt, never 0', () => {
    const lan = new Map(MUNICIPALITIES.map((m) => [m.kommun_kod, m.lan]));
    const facts = buildContractFacts(
      FACT_ROWS.map((r) => ({ ...r, annual_value_sek: null, avtalsvarde: null })),
      { lanByKommunKod: lan, now: NOW },
    );
    const html = renderVendorDossier({
      vendor: { id: 7, name: 'ILT Education', slug: 'ilt-education' },
      rollup: buildVendorRollups(facts, { now: NOW })[0],
      facts,
      productRollups: buildProductRollups(facts, [], []),
      todayIso: TODAY,
    });
    expect(html).toContain('Snitt per kommun');
    expect(html).not.toContain('0 kr/år');
  });
});

describe('route: GET /leverantor/:slug serves the product intelligence from the DB', () => {
  let tmp, db;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pi-views-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  // Collection state matters for the matrix: DONE kommuner may be painted
  // confidently red for missing products; anything else renders unknown.
  function seedAttachment(kod, namn, filename, { state = 'DONE' } = {}) {
    const convId = db.createConversation({
      kommun_kod: kod, kommun_namn: namn, role: 'central',
      contact_email: `reg@${kod}.se`, scheduled_send_at: '2026-04-01T08:00:00Z',
    });
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

  it('renders the product table and coverage matrix from stored rows', async () => {
    const v = db.upsertVendor('ILT Education');
    const attId = seedAttachment('1440', 'Ale', 'ILT.pdf');
    const cId = db.recordContract({
      attachment_id: attId, vendor_id: v.id, is_contract: 1,
      annual_value_sek: 585649, pricing_model: 'tiered',
      period_start: '2025-01-31', period_end: '2028-01-30',
    });
    for (const p of ['Begreppa', 'Polyglutt']) {
      db.linkContractProduct(cId, db.upsertProduct(v.id, p));
    }
    db.replaceContractLineItems(cId, [
      { product_name: 'Begreppa', amount_sek: 116244 },
      { product_name: 'Begreppa', description: '3,5 mån tidigare pris', amount_sek: 50341 },
      { product_name: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, amount_sek: 168300 },
    ]);
    db.replaceContractCoverage(cId, [
      { product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null },
      { product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
    ]);

    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/ilt-education');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`${sek(166585)} kr`);
    expect(res.text).toContain(`${sek(168300)} kr`);
    expect(res.text).toContain('Snitt per kommun');
    expect(res.text).toContain('cov-cell cov-full');
    expect(res.text).toContain('cov-cell cov-none'); // Begreppa at Förskola
  });

  it('an in-progress kommun (DELIVERING) yields cov-unknown, never cov-none, in the dossier matrix', async () => {
    const v = db.upsertVendor('ILT Education');
    // Ale is still DELIVERING — more contracts may arrive, so Begreppa's
    // absence at Förskola is not a confident red.
    const attId = seedAttachment('1440', 'Ale', 'ILT.pdf', { state: 'DELIVERING' });
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    for (const p of ['Begreppa', 'Polyglutt']) db.linkContractProduct(cId, db.upsertProduct(v.id, p));
    db.replaceContractCoverage(cId, [
      { product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null },
      { product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
    ]);
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/ilt-education');
    expect(res.status).toBe(200);
    expect(res.text).toContain('cov-cell cov-unknown'); // Begreppa at Förskola: vet inte än
    expect(res.text).not.toContain('cov-cell cov-none');
  });

  it('a vendor without line items or coverage still renders (all honest fallbacks)', async () => {
    const v = db.upsertVendor('Skolon');
    const attId = seedAttachment('1489', 'Alingsås', 'Skolon.pdf');
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    db.linkContractProduct(cId, db.upsertProduct(v.id, 'Skolon Plattform'));
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
    const res = await get(app, '/leverantor/skolon');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ingår, ospecificerat pris');
    expect(res.text).toContain('Ingen täckningsdata');
  });
});
