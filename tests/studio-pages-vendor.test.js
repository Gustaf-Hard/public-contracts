import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';

// Hand-written fixture data only (the repo is public). Kommun names, kods and
// kommungrupper are open data; vendor and product names come from the
// committed catalogue; every price, date and count below is invented.
const KOMMUNER = [
  ['1440', 'Ale', 'Pendlingskommun nära storstad'],
  ['0560', 'Boxholm', 'Landsbygdskommun, ej nära större stad'],
  ['0180', 'Stockholm', 'Storstäder'],
  ['1480', 'Göteborg', 'Storstäder'],
  ['1280', 'Malmö', 'Storstäder'],
  ['0380', 'Uppsala', 'Större stad'],
  ['2480', 'Umeå', 'Större stad'],
];
const ELEVER = { 'Förskola': 900, 'Förskoleklass': 300, '1-3': 900, '4-6': 900, '7-9': 900, Gymnasiet: 800, Komvux: 300 };
const STATS = loadKommunStats({
  data: {
    kommuner: Object.fromEntries(KOMMUNER.map(([kod, namn, grupp]) => [kod, {
      namn, lan: 'Testlän', folkmangd: 30000, kommungrupp: grupp, elever: ELEVER,
    }])),
  },
});

let tmp, db, contractsDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'studio-vendor-'));
  contractsDir = join(tmp, 'contracts');
  mkdirSync(contractsDir, { recursive: true });
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

let seq = 0;
function seedContract({
  kod, vendor, value = 100000, start = '2025-08-01', end = '2027-07-31', model = 'per_student',
  lines = [], filename = 'Avtal_Anna_Andersson.pdf', state = 'DELIVERING',
}) {
  const namn = KOMMUNER.find((k) => k[0] === kod)[1];
  const existing = db.raw.prepare('SELECT id FROM conversations WHERE kommun_kod = ?').get(kod);
  const convId = existing ? existing.id : db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role: 'central',
    contact_email: 'registrator@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  db.raw.prepare('UPDATE conversations SET state = ? WHERE id = ?').run(state, convId);
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${++seq}`,
    direction: 'inbound', from_email: 'anna.andersson@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Hej, se bifogat. Anna Andersson', classification: null,
    classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const saved = join(contractsDir, kod, `${seq}.pdf`);
  mkdirSync(join(contractsDir, kod), { recursive: true });
  writeFileSync(saved, `%PDF-1.4 fixture ${seq}\n`);
  const attId = db.recordAttachment({
    message_id: msgId, filename, saved_path: saved, mime_type: 'application/pdf', size_bytes: 20,
  });
  const v = db.upsertVendor(vendor);
  const cid = db.recordContract({
    attachment_id: attId, vendor_id: v.id, annual_value_sek: value, pricing_model: model,
    period_start: start, period_end: end, is_contract: 1, summary: 'Licens', confidence: 0.9,
  });
  if (lines.length) db.replaceContractLineItems(cid, lines);
  return { cid, attId };
}

// ILT with Polyglutt priced per elev in five kommuner (n = 5, plot shows) and
// Begreppa priced in four (n = 4, hatched), plus a discount line and a
// segment-named line that must never surface as a product.
function seedIlt() {
  const prices = { '1440': 110, '0560': 130, '0180': 150, '1480': 170, '1280': 190 };
  for (const [kod, p] of Object.entries(prices)) {
    seedContract({
      kod, vendor: 'ILT Education AB', value: 300000,
      lines: [
        { product_name: 'Polyglutt skola F-3', unit: 'elev', unit_price_sek: p, period_months: 12 },
        { product_name: 'Polylino' },
        { product_name: 'Rabatt', amount_sek: -5000 },
      ],
    });
    if (kod !== '1280') {
      seedContract({ kod, vendor: 'ILT Education AB', value: 40000, end: '2027-01-31',
        lines: [{ product_name: 'Begreppa', unit: 'elev', unit_price_sek: p - 60, period_months: 12 }] });
    }
  }
  // Expired ILT avtal: evidence only.
  seedContract({ kod: '0380', vendor: 'ILT Education AB', value: 90000, start: '2019-01-01', end: '2021-12-31',
    lines: [{ product_name: 'Begreppa', unit: 'elev', unit_price_sek: 99, period_months: 12 }] });
  // Competitor in the same category and a complement in another category.
  seedContract({ kod: '1440', vendor: 'Radish AB', value: 50000, lines: [{ product_name: 'Magma' }] });
  seedContract({ kod: '0560', vendor: 'Radish AB', value: 40000, lines: [{ product_name: 'Magma' }] });
  seedContract({ kod: '1440', vendor: 'Unikum', value: 80000, model: 'fixed' });
}

function app() {
  return createDashboardApp({
    db,
    municipalitiesLoader: () => [],
    env: {},
    slackClient: null,
    gmailClient: {},
    contractsDir,
    studioDeps: {
      statsLoader: () => STATS,
      now: () => new Date('2026-10-26T09:00:00Z'),
    },
  });
}

async function get(a, path) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual' }).then(async (r) => {
        const buf = Buffer.from(await r.arrayBuffer());
        server.close(() => resolve({ status: r.status, text: buf.toString('utf8'), buf, headers: r.headers }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function noLeaks(html) {
  expect(html).not.toMatch(EMAIL);
  expect(html).not.toMatch(/\.pdf\b/i);
  expect(html).not.toContain('Anna');
  expect(html).not.toContain('Andersson');
  expect(html).not.toMatch(/href="\/(attachments|kommun|leverantor|avtal|ramavtal)\//);
  expect(html).not.toMatch(/[–—]/);
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

describe('/studio/leverantor/:slug', () => {
  it('renders ILT with catalogue product names, kommun count and a tile map', async () => {
    seedIlt();
    const r = await get(app(), '/studio/leverantor/ilt');
    expect(r.status).toBe(200);
    const html = r.text;
    expect(html).toContain('ILT Education');
    expect(html).toContain('Polyglutt');
    expect(html).toContain('Polylino');
    expect(html).not.toContain('skola F-3');
    expect(html).not.toContain('Rabatt');
    // five kommuner with active ILT avtal (Uppsala's avtal has expired)
    expect(html).toMatch(/<dt>Kommuner<\/dt>\s*<dd class="eh-val">5</);
    expect(html).toContain('class="viz tilemap"');
    expect(html).toContain('t-has');
    noLeaks(html);
  });

  it('shows sections in the planned order with prices, competitors and evidence', async () => {
    seedIlt();
    const html = (await get(app(), '/studio/leverantor/ilt')).text;
    const order = ['id="produkter"', 'id="karta"', 'id="pris"', 'id="konkurrenter"', 'id="fornyelser"', 'id="kanaler"', 'id="underlag"'];
    const pos = order.map((id) => html.indexOf(id));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    // Polyglutt: n = 5 priced -> plot with median; Begreppa: n = 4 -> hatched.
    expect(html).toContain('median <b>150 kr/elev</b>');
    expect(html).toContain('för få avtal (n = 4)');
    // Radish competes (same category, shared kommuner); Unikum is bought alongside.
    const comp = html.slice(html.indexOf('id="konkurrenter"'), html.indexOf('id="fornyelser"'));
    expect(comp).toMatch(/Konkurrerar med[\s\S]*Radish[\s\S]*Köps ofta tillsammans med[\s\S]*Unikum/);
    // Evidence links through the studio route, active first, expired last.
    expect(html).toMatch(/href="\/studio\/underlag\/\d+"/);
    const ev = html.slice(html.indexOf('id="underlag"'));
    expect(ev.indexOf('Uppsala')).toBeGreaterThan(ev.indexOf('Malmö'));
    expect(ev).toContain('utgånget');
  });

  it('a company with one avtal renders hatched tiles and the category context', async () => {
    seedIlt();
    seedContract({ kod: '2480', vendor: 'Binogi AB', value: 60000, model: 'fixed' });
    const r = await get(app(), '/studio/leverantor/binogi');
    expect(r.status).toBe(200);
    const html = r.text;
    expect(html).toContain('Binogi');
    expect(html).toContain('kpi is-unknown hatch');
    expect(html).toContain('inga avtal med känt pris än');
    // the category around it: Läromedel prices and the other vendors there
    expect(html).toContain('Så ser Läromedel ut');
    expect(html).toContain('ILT Education');
    expect(html).toContain('class="viz tilemap"');
    noLeaks(html);
  });

  it('an unknown slug is a 404 studio page', async () => {
    const r = await get(app(), '/studio/leverantor/finns-inte');
    expect(r.status).toBe(404);
    expect(r.text).toContain('data-studio');
    expect(r.text).toContain('Leverantören finns inte');
  });

  it('returns the body only for a pane swap', async () => {
    seedIlt();
    const r = await get(app(), '/studio/leverantor/ilt?partial=1');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('<html');
    expect(r.text).toContain('class="viz tilemap"');
  });
});

describe('/studio/produkt/:slug', () => {
  it('renders the product with owner, strip per segment, matrix, substitutes and evidence', async () => {
    seedIlt();
    const r = await get(app(), '/studio/produkt/polyglutt');
    expect(r.status).toBe(200);
    const html = r.text;
    expect(html).toContain('Polyglutt');
    expect(html).toContain('href="/studio/leverantor/ilt"');
    expect(html).toContain('class="viz strip"');
    expect(html).toContain('class="viz sm"');
    expect(html).toContain('class="viz tilemap"');
    expect(html).toContain('id="alternativ"');
    expect(html).toContain('Polylino');
    expect(html).toMatch(/href="\/studio\/underlag\/\d+"/);
    expect(html).not.toContain('skola F-3');
    noLeaks(html);
  });

  it('an unknown product is a 404 studio page', async () => {
    const r = await get(app(), '/studio/produkt/finns-inte');
    expect(r.status).toBe(404);
    expect(r.text).toContain('Produkten finns inte');
  });

  it('a product with no avtal still renders its header and the category', async () => {
    seedIlt();
    const r = await get(app(), '/studio/produkt/trovy');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Trovy');
    expect(r.text).toContain('Så ser Läromedel ut');
    noLeaks(r.text);
  });
});

describe('/studio/underlag/:attachmentId', () => {
  it('serves the avtal PDF bytes without the filename', async () => {
    const { attId } = seedContract({ kod: '1440', vendor: 'Binogi AB' });
    const r = await get(app(), `/studio/underlag/${attId}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/pdf/);
    expect(r.buf.toString('utf8')).toMatch(/^%PDF-1\.4 fixture/);
    expect(r.headers.get('content-disposition') ?? '').not.toContain('Anna');
  });

  it('refuses attachments that are not a stored avtal, and unknown ids', async () => {
    expect((await get(app(), '/studio/underlag/999')).status).toBe(404);
    expect((await get(app(), '/studio/underlag/abc')).status).toBe(404);
  });
});
