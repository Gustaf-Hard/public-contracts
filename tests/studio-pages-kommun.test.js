import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';

// Hand-written fixture data only (the repo is public). Kommun names and kods
// are open data, the kommungrupper below are assigned for the test; vendor
// and product names come from the committed catalogue; every price, date and
// count is invented.
const P = 'Pendlingskommun nära storstad';
const KOMMUNER = [
  ['1440', 'Ale', P],
  ['1401', 'Härryda', P],
  ['1402', 'Partille', P],
  ['1407', 'Öckerö', P],
  ['1415', 'Stenungsund', P],
  ['1441', 'Lerum', P],
  ['1482', 'Kungälv', P],
  ['1419', 'Tjörn', P],
  ['0560', 'Boxholm', 'Landsbygdskommun, ej nära större stad'],
  ['0180', 'Stockholm', 'Storstäder'],
  ['0380', 'Uppsala', 'Större stad'],
];
const PEER_NAMES = ['Härryda', 'Partille', 'Öckerö', 'Stenungsund', 'Lerum', 'Kungälv'];
const ELEVER = { 'Förskola': 900, 'Förskoleklass': 300, '1-3': 900, '4-6': 900, '7-9': 900, Gymnasiet: 800, Komvux: 300 };
const STATS = loadKommunStats({
  data: {
    kommuner: Object.fromEntries(KOMMUNER.map(([kod, namn, grupp]) => [kod, {
      namn, lan: 'Västra Götalands län', folkmangd: 30000, kommungrupp: grupp, elever: ELEVER,
    }])),
  },
});

let tmp, db, contractsDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'studio-kommun-'));
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
function conversation(kod, state) {
  const namn = KOMMUNER.find((k) => k[0] === kod)[1];
  const existing = db.raw.prepare('SELECT id FROM conversations WHERE kommun_kod = ?').get(kod);
  const id = existing ? existing.id : db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role: 'central',
    contact_email: 'registrator@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  db.raw.prepare('UPDATE conversations SET state = ? WHERE id = ?').run(state, id);
  return id;
}

function seedContract({ kod, vendor, value = 100000, start = '2025-08-01', end = '2027-07-31', model = 'per_student', lines = [], state = 'DELIVERING' }) {
  const convId = conversation(kod, state);
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${++seq}`,
    direction: 'inbound', from_email: 'anna.andersson@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Hej, se bifogat. Anna Andersson, 070-123 45 67', classification: null,
    classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const saved = join(contractsDir, kod, `${seq}.pdf`);
  mkdirSync(join(saved, '..'), { recursive: true });
  writeFileSync(saved, `%PDF-1.4 fixture ${seq}\n`);
  const attId = db.recordAttachment({
    message_id: msgId, filename: 'Avtal_Anna_Andersson.pdf', saved_path: saved, mime_type: 'application/pdf', size_bytes: 20,
  });
  const v = db.upsertVendor(vendor);
  const cid = db.recordContract({
    attachment_id: attId, vendor_id: v.id, annual_value_sek: value, pricing_model: model,
    period_start: start, period_end: end, is_contract: 1, summary: 'Licens', confidence: 0.9,
  });
  if (lines.length) db.replaceContractLineItems(cid, lines);
  return { cid, attId };
}

// Polyglutt priced per elev in Ale and five peers (peer n = 5, plot shows),
// Begreppa in Ale and three peers (n = 3, too few), Ale on two lärplattformar.
function seedAle() {
  const poly = { '1440': 140, '1401': 110, '1402': 120, '1407': 150, '1415': 170, '1441': 190 };
  for (const [kod, p] of Object.entries(poly)) {
    seedContract({ kod, vendor: 'ILT Education AB', value: 300000,
      lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: p, period_months: 12 }] });
  }
  for (const [kod, p] of Object.entries({ '1440': 80, '1401': 70, '1402': 90, '1482': 60 })) {
    seedContract({ kod, vendor: 'ILT Education AB', value: 40000, end: '2027-03-31',
      lines: [{ product_name: 'Begreppa', unit: 'elev', unit_price_sek: p, period_months: 12 }] });
  }
  seedContract({ kod: '1440', vendor: 'Unikum', value: 200000, model: 'fixed', end: '2027-01-31', lines: [{ product_name: 'Unikum' }] });
  seedContract({ kod: '1440', vendor: 'Vklass AB', value: 150000, model: 'fixed', lines: [{ product_name: 'Vklass' }] });
  for (const kod of ['1401', '1402', '1482']) {
    seedContract({ kod, vendor: 'Vklass AB', value: 120000, model: 'fixed', lines: [{ product_name: 'Vklass' }] });
  }
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
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function noLeaks(html) {
  expect(html).not.toMatch(EMAIL);
  expect(html).not.toMatch(/\.pdf\b/i);
  expect(html).not.toMatch(/070-123/);
  expect(html).not.toContain('Anna');
  expect(html).not.toContain('Andersson');
  expect(html).not.toMatch(/href="\/(attachments|kommun|leverantor|avtal|ramavtal)\//);
  expect(html).not.toMatch(/[–—]/);
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

// The page body (pane swap) holds everything the page says; the full shell
// adds the search datalist, which lists every kommun by design.
const body = async (path) => get(app(), `${path}${path.includes('?') ? '&' : '?'}partial=1`);

describe('/studio/kommun/:kod', () => {
  it('a kommun with avtal shows its own products and an anonymous peer comparison', async () => {
    seedAle();
    const full = await get(app(), '/studio/kommun/1440');
    expect(full.status).toBe(200);
    const r = await body('/studio/kommun/1440');
    const html = r.text;
    expect(html).toContain('Ale');
    expect(html).toContain('Polyglutt');
    expect(html).toContain('Begreppa');
    expect(html).toContain('Västra Götalands län');
    expect(html).toContain('Pendlingskommun nära storstad');
    // Elever F-9: 300 + 900 + 900 + 900
    expect(html).toMatch(/3 000/);
    expect(html).toContain('Ert pris vs liknande kommuner');
    // Polyglutt: five priced peers -> strip with Ale highlighted
    expect(html).toContain('class="viz strip"');
    expect(html).toContain('strip-dot fade-in is-highlight');
    expect(html).toContain('140 kr/elev');
    // Begreppa: three priced peers -> own number only
    expect(html).toContain('för få jämförbara kommuner');
    expect(html).toMatch(/kp-own-num">80</);
    // Two lärplattformar -> overlap warning
    expect(html).toContain('id="overlapp"');
    expect(html).toMatch(/Unikum[\s\S]*Vklass/);
    for (const name of PEER_NAMES) expect(html).not.toContain(name);
    for (const name of PEER_NAMES) expect(full.text.replace(/<datalist[\s\S]*?<\/datalist>/, '')).not.toContain(name);
    noLeaks(html);
  });

  it('shows sections in order: spend, prices, alternatives, renewals, map, evidence', async () => {
    seedAle();
    const html = (await body('/studio/kommun/1440')).text;
    const order = ['id="kop"', 'id="pris"', 'id="alternativ"', 'id="fornyelser"', 'id="karta"', 'id="underlag"'];
    const pos = order.map((id) => html.indexOf(id));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(html).toContain('Så här köper ni');
    expect(html).toMatch(/upphandla (om \d+ mån|nu|inom en månad)/);
    expect(html).toContain('t-highlight');
    expect(html).toMatch(/href="\/studio\/underlag\/\d+"/);
  });

  it('alternatives list what peers use, with counts and no peer names', async () => {
    seedAle();
    const html = (await body('/studio/kommun/1440')).text;
    const alt = html.slice(html.indexOf('id="alternativ"'), html.indexOf('id="fornyelser"'));
    expect(alt).toContain('Vklass');
    expect(alt).toMatch(/3 av 7 liknande/);
    for (const name of PEER_NAMES) expect(alt).not.toContain(name);
  });

  it('a kommun not contacted renders 200 with the category landscape', async () => {
    seedAle();
    const r = await body('/studio/kommun/1419');
    expect(r.status).toBe(200);
    const html = r.text;
    expect(html).toContain('Tjörn');
    expect(html).toContain('vi har inte begärt ut avtal här än');
    expect(html).toContain('id="alternativ"');
    expect(html).toContain('Polyglutt');
    expect(html).toContain('Vklass');
    expect(html).toContain('t-highlight');
    expect(html).not.toContain('Ale');
    for (const name of PEER_NAMES) expect(html).not.toContain(name);
    noLeaks(html);
  });

  it('a kommun whose only conversation is INITIAL counts as not contacted', async () => {
    conversation('0560', 'INITIAL');
    const html = (await body('/studio/kommun/0560')).text;
    expect(html).toContain('vi har inte begärt ut avtal här än');
  });

  it('a collection-open kommun with no avtal says insamling pågår, never "inga avtal"', async () => {
    seedAle();
    conversation('0380', 'SENT');
    const r = await body('/studio/kommun/0380');
    expect(r.status).toBe(200);
    expect(r.text).toContain('insamling pågår');
    expect(r.text).not.toContain('vi har inte begärt ut avtal här än');
    noLeaks(r.text);
  });

  it('a done kommun with no active avtal says so, distinct from open and not contacted', async () => {
    conversation('0180', 'DONE');
    const html = (await body('/studio/kommun/0180')).text;
    expect(html).toContain('insamling klar');
    expect(html).not.toContain('insamling pågår');
    expect(html).not.toContain('vi har inte begärt ut avtal här än');
    noLeaks(html);
  });

  it('four priced peers (distinct kommuner) get no strip; the own price stands alone', async () => {
    for (const [kod, p] of Object.entries({ '1440': 140, '1401': 110, '1402': 120, '1407': 150, '1415': 170 })) {
      seedContract({ kod, vendor: 'ILT Education AB', lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: p, period_months: 12 }] });
    }
    const html = (await body('/studio/kommun/1440')).text;
    expect(html).toMatch(/kp-own-num">140</);
    expect(html).toContain('4 liknande och 4 kommuner totalt med känt pris');
    expect(html).not.toContain('strip-dot');
    expect(html).not.toContain('class="viz strip"');
  });

  it('five priced peers get the strip with the kommun highlighted', async () => {
    for (const [kod, p] of Object.entries({ '1440': 140, '1401': 110, '1402': 120, '1407': 150, '1415': 170, '1441': 190 })) {
      seedContract({ kod, vendor: 'ILT Education AB', lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: p, period_months: 12 }] });
    }
    const html = (await body('/studio/kommun/1440')).text;
    expect(html).toContain('Polyglutt hos 5 liknande kommuner');
    expect((html.match(/class="mark strip-dot/g) || []).length).toBe(6);
    expect(html).toContain('strip-dot fade-in is-highlight');
  });

  it('too few peers but enough other kommuner falls back to all kommuner, the kommun excluded from n', async () => {
    const prices = { '1440': 140, '1401': 110, '1402': 120, '0560': 150, '0180': 170 };
    for (const [kod, p] of Object.entries(prices)) {
      seedContract({ kod, vendor: 'ILT Education AB', lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: p, period_months: 12 }] });
    }
    let html = (await body('/studio/kommun/1440')).text;
    expect(html).not.toContain('strip-dot');
    expect(html).toContain('4 kommuner totalt');
    seedContract({ kod: '1482', vendor: 'ILT Education AB', lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: 160, period_months: 12 }] });
    html = (await body('/studio/kommun/1440')).text;
    expect(html).toContain('Jämfört med alla kommuner (för få liknande)');
    expect(html).toContain('Bara 3 liknande kommuner har känt pris');
    expect(html).toContain('Här jämförs med 5 andra kommuner');
    expect(html).not.toContain('i liknande kommuner</span>');
    for (const name of ['Härryda', 'Partille', 'Kungälv', 'Boxholm', 'Stockholm']) expect(html).not.toContain(name);
  });

  it('peer spend medians use only peers whose collection is done', async () => {
    seedAle();
    let html = (await body('/studio/kommun/1440')).text;
    const kop = () => html.slice(html.indexOf('id="kop"'), html.indexOf('id="pris"'));
    expect(kop()).toContain('för få liknande med klar insamling');
    expect(kop()).not.toContain('liknande med klar insamling:');
    for (const kod of ['1401', '1402', '1407', '1415', '1441', '1482']) db.raw.prepare('UPDATE conversations SET state = ? WHERE kommun_kod = ?').run('DONE', kod);
    html = (await body('/studio/kommun/1440')).text;
    expect(kop()).toContain('median bland 6 liknande med klar insamling: 100 kr/elev');
    expect(kop()).toContain('bara de 6 av 7 där insamlingen är klar');
  });

  it('a kommun that closed with a dead end and no avtal is not shown as delivered', async () => {
    seedAle();
    conversation('0560', 'DEAD_END');
    const html = (await body('/studio/kommun/0560')).text;
    expect(html).toContain('Inga avtal utlämnade');
    expect(html).toContain('kommunen har inte lämnat ut avtal');
    expect(html).not.toContain('insamling klar');
    expect(html).not.toMatch(/tolkade|inlagda/);
    noLeaks(html);
  });

  it('avtal from a kommun with only an INITIAL conversation is not called not contacted', async () => {
    seedContract({ kod: '0560', vendor: 'ILT Education AB', lines: [{ product_name: 'Polyglutt' }] });
    conversation('0560', 'INITIAL');
    const html = (await body('/studio/kommun/0560')).text;
    expect(html).toContain('Polyglutt');
    expect(html).not.toContain('vi har inte begärt ut avtal här än');
    expect(html).toContain('Status okänd');
  });

  it('hostile vendor names are escaped', async () => {
    seedContract({ kod: '1440', vendor: '<script>alert(1)</script> "Evil" AB', value: 90000, model: 'fixed' });
    const html = (await body('/studio/kommun/1440')).text;
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('an unknown kod is a 404 studio page', async () => {
    for (const kod of ['9999', 'abc']) {
      const r = await get(app(), `/studio/kommun/${kod}`);
      expect(r.status).toBe(404);
      expect(r.text).toContain('data-studio');
      expect(r.text).toContain('Kommunen finns inte');
    }
  });

  it('returns the body only for a pane swap', async () => {
    seedAle();
    const r = await body('/studio/kommun/1440');
    expect(r.text).not.toContain('<html');
    expect(r.text).toContain('class="viz tilemap"');
  });
});
