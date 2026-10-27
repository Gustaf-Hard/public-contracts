// Purchase rows on the studio pages (2026-10-27): "Köpt via <kanal>" /
// "Finns i kommunens inköpslista" is its own evidence level. It never makes a
// kommun "has avtal", never enters a count of avtal or a median, and rows are
// never summed. Hand-written fixture data only: kommun names and kods are
// open data, every price, date and count is invented.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';

const P = 'Pendlingskommun nära storstad';
const KOMMUNER = [['1440', 'Ale', P], ['1401', 'Härryda', P], ['1402', 'Partille', P]];
const ELEVER = { 'Förskoleklass': 300, '1-3': 900, '4-6': 900, '7-9': 900 };
const STATS = loadKommunStats({
  data: { kommuner: Object.fromEntries(KOMMUNER.map(([kod, namn, grupp]) => [kod, { namn, lan: 'Västra Götalands län', folkmangd: 30000, kommungrupp: grupp, elever: ELEVER }])) },
});

let tmp; let db; let contractsDir; let seq = 0;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'studio-purch-'));
  contractsDir = join(tmp, 'contracts');
  mkdirSync(contractsDir, { recursive: true });
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function attachment(kod, filename) {
  const namn = KOMMUNER.find((k) => k[0] === kod)[1];
  const existing = db.raw.prepare('SELECT id FROM conversations WHERE kommun_kod = ?').get(kod);
  const convId = existing ? existing.id : db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: 'registrator@example.se', scheduled_send_at: '2026-04-01T08:00:00Z' });
  db.raw.prepare("UPDATE conversations SET state = 'DONE' WHERE id = ?").run(convId);
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${++seq}`, direction: 'inbound', from_email: 'anna.andersson@example.se', to_email: 'me@example.com',
    subject: 'Svar', body_text: 'Se bifogat', classification: null, classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const saved = join(contractsDir, kod, `${seq}.pdf`);
  mkdirSync(join(saved, '..'), { recursive: true });
  writeFileSync(saved, '%PDF-1.4 fixture\n');
  return db.recordAttachment({ message_id: msgId, filename, saved_path: saved, mime_type: 'application/pdf', size_bytes: 20 });
}

function seedAvtal(kod, vendor, value) {
  const attId = attachment(kod, 'Avtal_Anna_Andersson.pdf');
  const v = db.upsertVendor(vendor);
  db.recordContract({ attachment_id: attId, vendor_id: v.id, annual_value_sek: value, pricing_model: 'fixed', period_start: '2025-08-01', period_end: '2027-07-31', is_contract: 1, summary: 'Licens', confidence: 0.9 });
}

function seedList(kod, rows, { statedTotal = null, method = 'llm', channel = 'skolon' } = {}) {
  const attId = attachment(kod, 'Inköp_Anna_Andersson.pdf');
  db.recordContract({ attachment_id: attId, is_contract: 0, document_type: 'följebrev_sammanställning', summary: 'Lista' });
  db.replacePurchaseRows(attId, { rows, method, channel, stated_total_sek: statedTotal });
  return attId;
}

const row = (over = {}) => ({
  supplier: 'Skolon AB', product: 'Huvudmanslicens 1 år Binogi', channel: 'skolon', quantity: null, unit: null, unit_price_sek: null,
  amount_sek: 1111, order_date: null, period_start: null, period_end: null, school_year: '2025/26', grades: [], order_ref: null, ...over,
});

function app() {
  return createDashboardApp({
    db, municipalitiesLoader: () => [], env: {}, slackClient: null, gmailClient: {}, contractsDir,
    studioDeps: { statsLoader: () => STATS, now: () => new Date('2026-10-26T09:00:00Z') },
  });
}
async function get(path) {
  const a = app();
  return new Promise((resolve, reject) => {
    const server = a.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}${path.includes('?') ? '&' : '?'}partial=1`, { redirect: 'manual' }).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

function noLeaks(html) {
  expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(html).not.toMatch(/\.pdf\b/i);
  expect(html).not.toContain('Anna');
  expect(html).not.toMatch(/[–—]/);
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

function seedBoth() {
  // Ale: an avtal with Binogi AND Binogi in a Skolon list. Härryda: only the
  // Skolon list. Partille: nothing.
  seedAvtal('1440', 'Binogi', 50000);
  seedList('1440', [row({ amount_sek: 2222 })]);
  seedList('1401', [
    row({ amount_sek: 100, period_end: '2027-05-31', order_ref: 'IN1/001' }),
    row({ supplier: 'Skolon AB', product: 'Singellicens 12 mån för Exempelverktyg', amount_sek: 200 }),
  ], { statedTotal: 4321 });
}

describe('kommun page', () => {
  it('a kommun with only a purchase list shows the purchases as köp, never as avtal', async () => {
    seedBoth();
    const r = await get('/studio/kommun/1401');
    expect(r.status).toBe(200);
    const t = r.text;
    noLeaks(t);
    expect(t).toContain('id="inkop"');
    expect(t).toContain('Köpt via Skolon');
    expect(t).toContain('som köp och inte som avtal');
    expect(t).toContain('Inga aktiva avtal härifrån i underlaget');
    expect(t).not.toContain('Aktiva avtal</');
    // The document's own total, never a sum of the rows (100 + 200).
    expect(t).toContain('anger själv totalt');
    expect(t).not.toMatch(/\b300 kr\b/);
    expect(t).toContain('licensperiod till 2027-05-31');
    expect(t).toContain('Licensperioder som löper ut');
    // The unknown title is listed, not attributed to Skolon's own product.
    expect(t).toContain('Singellicens 12 mån för Exempelverktyg');
    expect(t).toMatch(/href="\/studio\/leverantor\/binogi"/);
  });

  it('a kommun with an avtal keeps its avtal figures; the list adds nothing to them', async () => {
    seedBoth();
    const t = (await get('/studio/kommun/1440')).text;
    expect(t).toContain('Vi har 1 aktivt avtal härifrån');
    expect(t).toContain('id="inkop"');
    expect(t).not.toContain('2 aktiva avtal');
  });

  it('no purchase rows: no section at all', async () => {
    seedBoth();
    const t = (await get('/studio/kommun/1402')).text;
    expect(t).not.toContain('id="inkop"');
  });
});

describe('leverantör and produkt pages', () => {
  it('the footprint map marks purchase-only kommuner with their own tile, never as has', async () => {
    seedBoth();
    const t = (await get('/studio/leverantor/binogi')).text;
    noLeaks(t);
    expect(t).toMatch(/class="tile t-purchase[^"]*"[^>]*aria-label="Härryda: inget avtal med Binogi i underlaget; finns i kommunens inköpslista/);
    expect(t).toMatch(/class="tile t-has[^"]*"[^>]*aria-label="Ale: aktivt avtal/);
    expect(t).toContain('Köpt via kanal eller i inköpslista, inget aktivt avtal i underlaget');
    // Kommuner with avtal: 1, not 2.
    expect(t).toContain('har aktiva avtal med 1 kommun i vårt underlag');
    expect(t).toContain('Binogi finns också i inköpslistor från 2 kommuner');
    expect(t).toContain('id="inkop"');
    expect(t).toContain('licensperiod till 2027-05-31');
  });

  it('the channel page lists what was bought through it', async () => {
    seedBoth();
    const t = (await get('/studio/leverantor/skolon')).text;
    noLeaks(t);
    expect(t).toContain('Köpt via Skolon');
    expect(t).toContain('Inköpslistor visar också köp via Skolon i 2 kommuner');
  });

  it('the product page has the section and the marker', async () => {
    seedBoth();
    const t = (await get('/studio/produkt/binogi')).text;
    noLeaks(t);
    expect(t).toContain('id="inkop"');
    expect(t).toContain('t-purchase');
  });

  it('a db without purchase rows renders exactly as before (no marker, no legend entry)', async () => {
    seedAvtal('1440', 'Binogi', 50000);
    const t = (await get('/studio/leverantor/binogi')).text;
    expect(t).not.toContain('t-purchase');
    expect(t).not.toContain('id="inkop"');
  });
});

describe('Om datan', () => {
  it('explains the evidence level and that rows are never summed', async () => {
    seedBoth();
    const t = (await get('/studio/om')).text;
    expect(t).toContain('Finns i kommunens inköpslista');
    expect(t).toContain('Vi summerar aldrig raderna');
    noLeaks(t);
  });
});
