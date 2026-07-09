// tests/vendor-datacenter-views.test.js
// The three /leverantorer surfaces (2026-07-09-vendor-data-center-design.md
// Part 3): market overview, vendor dossier, and the slice & dice explorer
// shell (embedded facts JSON). Routes run against a temp-dir SQLite DB —
// never the live one — with a fake municipalities loader for län.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp, sortVendorRollups } from '../src/dashboard.js';
import { renderVendorMarket, renderVendorDossier } from '../src/dashboard-views.js';
import { buildContractFacts, buildVendorRollups, buildMarketSummary } from '../src/vendor-analytics.js';

const NOW = new Date('2026-07-09T12:00:00Z');
const TODAY = '2026-07-09';

// sv-SE thousands separator is a non-breaking space — build expected strings
// through the same formatter the views use.
const sek = (n) => n.toLocaleString('sv-SE');

const MUNICIPALITIES = [
  { kommun_kod: '1980', kommun_namn: 'Västerås', lan: 'Västmanlands län', folkmangd: 158653, contacts: [] },
  { kommun_kod: '0180', kommun_namn: 'Stockholm', lan: 'Stockholms län', folkmangd: 984748, contacts: [] },
  { kommun_kod: '1489', kommun_namn: 'Alingsås', lan: 'Västra Götalands län', folkmangd: 42186, contacts: [] },
];

let tmp, db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vdc-'));
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
    received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  return db.recordAttachment({
    message_id: msgId, filename, saved_path: join(tmp, 'contracts', kod, filename),
    mime_type: 'application/pdf', size_bytes: 1000,
  });
}

// Two vendors + one value-unknown contract → completeness is 2 of 3.
function seedMarket() {
  const skolon = db.upsertVendor('Skolon');
  const radish = db.upsertVendor('Radish');
  const a1 = seedAttachment('1980', 'Västerås', 'Skolon.pdf');
  const c1 = db.recordContract({
    attachment_id: a1, vendor_id: skolon.id, is_contract: 1,
    avtalsvarde: '170 000 SEK/år', annual_value_sek: 170000, pricing_model: 'per_user',
    unit_price_sek: 50, unit: 'användare', quantity: 3400,
    period_start: '2024-03-01', period_end: '2026-03-01',
    auto_renews: true, last_cancellation_date: '2026-09-30',
  });
  db.linkContractProduct(c1, db.upsertProduct(skolon.id, 'Skolon Plattform'));
  const a2 = seedAttachment('0180', 'Stockholm', 'Radish.pdf');
  const c2 = db.recordContract({
    attachment_id: a2, vendor_id: radish.id, is_contract: 1,
    avtalsvarde: '40 kr/elev (3744 elever)', annual_value_sek: 149760, pricing_model: 'per_student',
    unit_price_sek: 40, unit: 'elev', quantity: 3744,
    period_start: '2025-01-01', period_end: '2028-12-31',
  });
  db.linkContractProduct(c2, db.upsertProduct(radish.id, 'Läsappen'));
  // Value-unknown Skolon contract in a third kommun.
  const a3 = seedAttachment('1489', 'Alingsås', 'Skolon-Alingsas.pdf');
  db.recordContract({
    attachment_id: a3, vendor_id: skolon.id, is_contract: 1,
    avtalsvarde: '121 272 SEK',
  });
  return { skolon, radish, a1, a2, a3 };
}

function factsFromDb() {
  const lanByKommunKod = new Map(MUNICIPALITIES.map((m) => [m.kommun_kod, m.lan]));
  return buildContractFacts(db.listContractFacts(), { lanByKommunKod, now: NOW });
}

function appWithFakes() {
  return createDashboardApp({ db, municipalitiesLoader: () => MUNICIPALITIES });
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

describe('renderVendorMarket (surface 1 + 3)', () => {
  function rendered() {
    const facts = factsFromDb();
    return renderVendorMarket({
      summary: buildMarketSummary(facts, { now: NOW }),
      rollups: buildVendorRollups(facts, { now: NOW }),
      facts, todayIso: TODAY,
    });
  }

  it('shows market KPIs with an honest completeness line', () => {
    seedMarket();
    const html = rendered();
    expect(html).toContain('Kommuner med avtal');
    expect(html).toContain('årlig kostnad känd för 2 av 3 avtal');
    expect(html).toContain('320 tkr/år'); // 170 000 + 149 760 compact
  });

  it('rollup table: per-vendor totals, per-vendor completeness, dossier links', () => {
    seedMarket();
    const html = rendered();
    expect(html).toContain('href="/leverantor/skolon"');
    expect(html).toContain(`${sek(170000)} kr/år`);
    expect(html).toContain('(1 av 2 kända)'); // Skolon: one of two values known
    expect(html).toContain(`${sek(149760)} kr/år`);
  });

  it('embeds the contract-facts dataset as parseable JSON with today anchor', () => {
    seedMarket();
    const html = rendered();
    const m = html.match(/<script type="application\/json" data-contract-facts>(.*?)<\/script>/s);
    expect(m).toBeTruthy();
    const facts = JSON.parse(m[1]);
    expect(facts).toHaveLength(3);
    expect(facts.map((f) => f.vendor_name).sort()).toEqual(['Radish', 'Skolon', 'Skolon']);
    expect(facts.find((f) => f.kommun_kod === '1489').annual_value_sek).toBeNull();
    expect(facts.find((f) => f.kommun_kod === '1980').lan).toBe('Västmanlands län');
    expect(html).toContain(`data-today="${TODAY}"`);
  });

  it('a hostile product name cannot break out of the JSON script element', () => {
    const { skolon, a1 } = seedMarket();
    db.linkContractProduct(
      db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(a1).id,
      db.upsertProduct(skolon.id, '</script><script>alert(1)</script>'),
    );
    const html = rendered();
    const blob = html.match(/<script type="application\/json" data-contract-facts>(.*?)<\/script>/s)[1];
    expect(blob).not.toContain('</script');
    expect(JSON.parse(blob).some((f) => f.products.some((p) => p.includes('alert(1)')))).toBe(true);
  });

  it('renders explorer controls, group-by and an initial full row set', () => {
    seedMarket();
    const html = rendered();
    expect(html).toContain('data-x-filter="lan"');
    expect(html).toContain('data-x-filter="pricing_model"');
    expect(html).toContain('data-x-filter="renewal_window"');
    expect(html).toContain('data-x-group');
    expect(html).toContain('data-x-reset');
    // Initial rows server-rendered (works without JS): all three kommuner.
    expect(html).toContain('Alingsås');
    expect(html).toContain('Stockholm');
    // Unknown values render as okänt, never 0 kr.
    expect(html).toMatch(/okänt/);
  });

  it('empty dataset renders an empty state, not fabricated zeros as values', () => {
    const html = renderVendorMarket({
      summary: buildMarketSummary([], { now: NOW }), rollups: [], facts: [], todayIso: TODAY,
    });
    expect(html).toContain('Inga leverantörer ännu');
    expect(html).toContain('årlig kostnad känd för 0 av 0 avtal');
  });
});

describe('renderVendorDossier (surface 2)', () => {
  function renderedDossier(slug) {
    const facts = factsFromDb();
    const rollups = buildVendorRollups(facts, { now: NOW });
    const vendor = db.getVendorBySlug(slug);
    return renderVendorDossier({
      vendor,
      rollup: rollups.find((r) => r.vendor_id === vendor.id) ?? null,
      facts: facts.filter((f) => f.vendor_id === vendor.id),
      todayIso: TODAY,
    });
  }

  it('shows ARR across kommuner with completeness, and every kommun contract', () => {
    seedMarket();
    const html = renderedDossier('skolon');
    expect(html).toContain('170 tkr/år');
    expect(html).toContain('årlig kostnad känd för 1 av 2 avtal');
    expect(html).toContain('Västerås');
    expect(html).toContain('Alingsås');
    expect(html).toContain('href="/kommun/1980"');
  });

  it('unknown values render as okänt with the raw avtalsvarde as tooltip', () => {
    seedMarket();
    const html = renderedDossier('skolon');
    expect(html).toContain('okänt');
    expect(html).toContain('Ur avtalet: 121 272 SEK');
  });

  it('renewal calendar lists upcoming review dates with auto-renew flag', () => {
    seedMarket();
    const html = renderedDossier('skolon');
    expect(html).toContain('Förnyelsekalender');
    // auto-renew + last_cancellation 2026-09-30 → next review 2026-10-01
    expect(html).toContain('2026-10-01');
    expect(html).toContain('förlängs automatiskt');
  });

  it('links every contract to its source PDF', () => {
    const { a1, a3 } = seedMarket();
    const html = renderedDossier('skolon');
    expect(html).toContain(`href="/attachments/${a1}"`);
    expect(html).toContain(`href="/attachments/${a3}"`);
  });

  it('vendor without stored contracts renders an empty dossier, all-okänt KPIs', () => {
    db.upsertVendor('Tom AB');
    const html = renderedDossier('tom-ab');
    expect(html).toContain('Tom AB');
    expect(html).toContain('Inga lagrade avtal');
    expect(html).not.toContain('NaN');
  });
});

describe('sortVendorRollups', () => {
  const rollups = [
    { vendor_name: 'A', kommun_count: 1, contract_count: 1, total_annual_sek: 100, dominant_pricing_model: 'fixed', next_renewal_date: '2027-01-01' },
    { vendor_name: 'B', kommun_count: 3, contract_count: 2, total_annual_sek: null, dominant_pricing_model: null, next_renewal_date: null },
    { vendor_name: 'C', kommun_count: 2, contract_count: 5, total_annual_sek: 900, dominant_pricing_model: 'per_student', next_renewal_date: '2026-08-01' },
  ];

  it('no sort keeps input order', () => {
    expect(sortVendorRollups(rollups, {}).map((r) => r.vendor_name)).toEqual(['A', 'B', 'C']);
  });

  it('sorts by name asc/desc', () => {
    expect(sortVendorRollups(rollups, { sort: 'vendor_name', order: 'asc' }).map((r) => r.vendor_name)).toEqual(['A', 'B', 'C']);
    expect(sortVendorRollups(rollups, { sort: 'vendor_name', order: 'desc' }).map((r) => r.vendor_name)).toEqual(['C', 'B', 'A']);
  });

  it('unknown totals and renewal dates always sort last', () => {
    expect(sortVendorRollups(rollups, { sort: 'total_annual_sek', order: 'desc' }).map((r) => r.vendor_name)).toEqual(['C', 'A', 'B']);
    expect(sortVendorRollups(rollups, { sort: 'total_annual_sek', order: 'asc' }).map((r) => r.vendor_name)).toEqual(['A', 'C', 'B']);
    expect(sortVendorRollups(rollups, { sort: 'next_renewal_date', order: 'asc' }).map((r) => r.vendor_name)).toEqual(['C', 'A', 'B']);
  });

  it('does not mutate the input', () => {
    sortVendorRollups(rollups, { sort: 'vendor_name', order: 'desc' });
    expect(rollups.map((r) => r.vendor_name)).toEqual(['A', 'B', 'C']);
  });
});

describe('routes', () => {
  it('GET /leverantorer serves the data center with facts from the DB', async () => {
    seedMarket();
    const res = await get(appWithFakes(), '/leverantorer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-contract-facts');
    expect(res.text).toContain('Skolon');
    expect(res.text).toContain('Radish');
    expect(res.text).toContain('årlig kostnad känd för 2 av 3 avtal');
  });

  it('GET /leverantorer?sort=vendor_name&order=asc orders the rollup table', async () => {
    seedMarket();
    const res = await get(appWithFakes(), '/leverantorer?sort=vendor_name&order=asc');
    const radish = res.text.indexOf('href="/leverantor/radish"');
    const skolon = res.text.indexOf('href="/leverantor/skolon"');
    expect(radish).toBeGreaterThan(-1);
    expect(radish).toBeLessThan(skolon);
  });

  it('GET /leverantor/:slug serves the dossier; unknown slug → 404 market page', async () => {
    seedMarket();
    const app = appWithFakes();
    const ok = await get(app, '/leverantor/skolon');
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Förnyelsekalender');
    const missing = await get(app, '/leverantor/finns-inte');
    expect(missing.status).toBe(404);
    expect(missing.text).toContain('Leverantörer');
  });

  it('works with an empty DB (no contracts at all)', async () => {
    const res = await get(appWithFakes(), '/leverantorer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Inga leverantörer ännu');
  });
});
