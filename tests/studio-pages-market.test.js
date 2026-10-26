import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renewalWave, ADDA_NOTE } from '../src/studio/pages/marknad.js';

// Hand-written fixture data only (the repo is public). Kommun names and kods
// are open data, the kommungrupper are assigned for the test; vendor and
// product names come from the committed catalogue; every price, date and
// count is invented.
const KOMMUNER = [
  ['1440', 'Ale', 'Pendlingskommun nära storstad'],
  ['1401', 'Härryda', 'Pendlingskommun nära storstad'],
  ['1402', 'Partille', 'Pendlingskommun nära storstad'],
  ['1407', 'Öckerö', 'Pendlingskommun nära storstad'],
  ['1415', 'Stenungsund', 'Pendlingskommun nära storstad'],
  ['1441', 'Lerum', 'Pendlingskommun nära storstad'],
  ['0560', 'Boxholm', 'Landsbygdskommun, ej nära större stad'],
  ['0180', 'Stockholm', 'Storstäder'],
  ['0380', 'Uppsala', 'Större stad'],
];
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
  tmp = mkdtempSync(join(tmpdir(), 'studio-market-'));
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

function seedContract({
  kod, vendor, value = 100000, start = '2025-08-01', end = '2027-07-31', model = 'per_student',
  lines = [], state = 'DELIVERING', received = '2026-04-13T10:00:00Z',
}) {
  const convId = conversation(kod, state);
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${++seq}`,
    direction: 'inbound', from_email: 'anna.andersson@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Hej, se bifogat. Anna Andersson, 070-123 45 67', classification: null,
    classification_confidence: null, received_at: received, attachment_count: 1,
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
  return cid;
}

// Läromedel: Polyglutt priced per elev in five kommuner (n = 5, median
// shows), Binogi in two. Lärplattform: Vklass in three, Unikum in one with an
// unknown value. One expired avtal. Stockholm done without avtal, Uppsala
// open without avtal, Boxholm only INITIAL.
function seedMarket() {
  const poly = { '1440': 140, '1401': 110, '1402': 120, '1407': 150, '1415': 170 };
  let d = 1;
  for (const [kod, p] of Object.entries(poly)) {
    seedContract({
      kod, vendor: 'ILT Education AB', value: 300000, end: '2027-01-31',
      // Distinct starts: same vendor, dates and value in two kommuner is one
      // samverkansavtal (r2 P2); these are separate avtal.
      start: `2025-08-0${d}`, received: `2026-05-0${d++}T10:00:00Z`,
      lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: p, period_months: 12 }],
    });
  }
  seedContract({ kod: '1440', vendor: 'Binogi AB', value: 80000, end: '2027-06-30', lines: [{ product_name: 'Binogi' }] });
  seedContract({ kod: '1441', vendor: 'Binogi AB', value: 60000, end: '2027-06-30', lines: [{ product_name: 'Binogi' }] });
  for (const kod of ['1401', '1402', '1441']) {
    seedContract({ kod, vendor: 'Vklass AB', value: 120000, model: 'fixed', end: '2028-03-31', start: `2025-07-0${d++ - 5}`, lines: [{ product_name: 'Vklass' }] });
  }
  seedContract({ kod: '1440', vendor: 'Unikum', value: null, model: 'tiered', end: '2027-12-31', lines: [{ product_name: 'Unikum' }], received: '2026-09-20T10:00:00Z' });
  seedContract({ kod: '1407', vendor: 'Vklass AB', value: 90000, model: 'fixed', start: '2019-01-01', end: '2022-12-31', lines: [{ product_name: 'Vklass' }] });
  conversation('0180', 'DONE');
  conversation('0380', 'SENT');
  conversation('0560', 'INITIAL');
}

function app(now = '2026-10-26T09:00:00Z') {
  return createDashboardApp({
    db,
    municipalitiesLoader: () => [],
    env: {},
    slackClient: null,
    gmailClient: {},
    contractsDir,
    studioDeps: { statsLoader: () => STATS, now: () => new Date(now) },
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
const body = async (path, now) => get(app(now), `${path}${path.includes('?') ? '&' : '?'}partial=1`);

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

describe('/studio (Marknad)', () => {
  it('shows the basis sentence with active and collected counts', async () => {
    seedMarket();
    const r = await body('/studio');
    expect(r.status).toBe(200);
    // 11 avtal active, 12 collected, 6 kommuner with an active avtal
    expect(r.text).toContain('11 aktiva avtal (12 insamlade)');
    expect(r.text).toMatch(/6 av 290 kommuner/);
    // the vendor KPI says how many of them are in the catalogue (the Leverantörer page count)
    expect(r.text).toContain('4 i katalogen, 3 med känt värde');
    noLeaks(r.text);
  });

  it('"Insamling klar" counts done only and names the kommuner that released no avtal apart', async () => {
    seedMarket();
    conversation('0180', 'DEAD_END'); // Stockholm: closed without avtal
    const html = (await body('/studio')).text;
    expect(html).toMatch(/Insamling klar<\/dt><dd><b>0<\/b> kommuner, och 1 utan utlämnade avtal/);
  });

  it('known market value never counts the unknown Unikum value as 0', async () => {
    seedMarket();
    const html = (await body('/studio')).text;
    // 5 x 300 000 + 80 000 + 60 000 + 3 x 120 000 = 2 000 000
    expect(html).toContain('mk-num">2 mkr<');
    expect(html).toContain('känt för 10 av 11 aktiva avtal');
  });

  it('category tiles show value, kommuner, top-3 shares and median or the hatched reason', async () => {
    seedMarket();
    const html = (await body('/studio')).text;
    const tiles = html.slice(html.indexOf('id="kategorier"'), html.indexOf('id="fornyelser"'));
    expect(tiles).toContain('href="/studio/kategori/laromedel"');
    expect(tiles).toContain('href="/studio/kategori/larplattform"');
    expect(tiles).toContain('ILT Education');
    expect(tiles).toMatch(/median <b>140<\/b> kr\/elev/);
    // Lärplattform: no avtal priced per elev
    expect(tiles).toMatch(/ct-price is-unknown hatch/);
  });

  it('annotates the Adda cliff when the renewal window includes 2027-01', async () => {
    seedMarket();
    const html = (await body('/studio')).text;
    expect(html).toContain('Addas ramavtal Digitala läromedel 2022 löper ut 31 jan 2027');
    const later = (await body('/studio', '2027-03-01T09:00:00Z')).text;
    expect(later).not.toContain('Addas ramavtal');
  });

  it('renewal wave counts per month and never adds an unknown value as 0', () => {
    const buckets = [
      { month: '2026-12', n: 2, n_known: 1, value_known_sek: 50000 },
      { month: '2027-01', n: 3, n_known: 0, value_known_sek: 0 },
    ];
    const html = renewalWave({ buckets, today: '2026-11-15' });
    expect(html).toContain(ADDA_NOTE);
    expect(html).toContain('3 avtal, värde okänt');
    expect(html).toContain('känt för 1 av 2');
  });

  it('ranks the largest vendors and lists the latest avtal without prices', async () => {
    seedMarket();
    const html = (await body('/studio')).text;
    const rank = html.slice(html.indexOf('id="leverantorer"'), html.indexOf('id="senaste"'));
    expect(rank).toContain('class="viz rank"');
    expect(rank.indexOf('ILT Education')).toBeLessThan(rank.indexOf('Vklass'));
    const latest = html.slice(html.indexOf('id="senaste"'));
    expect(latest.indexOf('Unikum')).toBeGreaterThan(-1);
    expect(latest.indexOf('2026-09-20')).toBeLessThan(latest.indexOf('2026-05-05'));
    expect(latest).not.toMatch(/kr\/elev|mkr|tkr/);
  });

  it('renders with an empty database', async () => {
    const r = await body('/studio');
    expect(r.status).toBe(200);
    expect(r.text).toContain('0 aktiva avtal (0 insamlade)');
    noLeaks(r.text);
  });

  it('escapes hostile vendor names, in text and in attributes', async () => {
    // A Polyglutt line puts the avtal in läromedel; the unsplit remainder
    // stays on the hostile vendor, which then leads the category.
    seedContract({ kod: '1440', vendor: '<script>alert(1)</script> "Evil" AB', value: 90000, model: 'fixed', lines: [{ product_name: 'Polyglutt' }] });
    for (const path of ['/studio', '/studio/kategorier', '/studio/kategori/laromedel']) {
      const html = (await body(path)).text;
      expect(html, path).not.toContain('<script>alert');
      expect(html, path).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html, path).not.toMatch(/"Evil"/);
      // inside an attribute (share bar aria-label) the quotes are entities
      expect(html, path).toMatch(/aria-label="[^"]*&quot;Evil&quot;[^"]*"/);
    }
  });
});

describe('/studio/kategorier', () => {
  it('one tile per category with the same numbers as the landing', async () => {
    seedMarket();
    const r = await body('/studio/kategorier');
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/studio/kategori/laromedel"');
    expect(r.text).toContain('href="/studio/kategori/prov"');
    expect(r.text).toMatch(/median <b>140<\/b> kr\/elev/);
    noLeaks(r.text);
  });
});

describe('/studio/kategori/:slug', () => {
  it('läromedel shows a share ranking and a coverage map with the three underlag classes', async () => {
    seedMarket();
    const r = await body('/studio/kategori/laromedel');
    expect(r.status).toBe(200);
    const html = r.text;
    expect(html).toContain('Läromedel');
    expect(html).toContain('class="viz rank"');
    expect(html.indexOf('ILT Education')).toBeLessThan(html.indexOf('Binogi'));
    expect(html).toContain('class="viz tilemap"');
    const legend = html.slice(html.indexOf('tm-legend'));
    for (const l of ['Aktivt avtal i underlaget', 'Bara utgångna eller ersatta avtal i underlaget', 'Inget avtal i underlaget']) {
      expect(legend).toContain(l);
    }
    expect(html).toContain('t-none');
    expect(html).not.toContain('t-none-open');
    expect(html).not.toContain('t-none-done');
    noLeaks(html);
  });

  it('the coverage KPI is "Utan avtal i underlaget" with a basis, never a safe white spot (r4 W1)', async () => {
    seedMarket();
    const html = (await body('/studio/kategori/laromedel')).text;
    expect(html).toContain('Utan avtal i underlaget');
    expect(html).toMatch(/varav \d+ med klar insamling; mejl och sammanställningar kan nämna leverantörer vi inte har avtal för/);
    expect(html).not.toMatch(/Säkra vita fläckar|insamlingen klar, inga avtal/);
    expect(html).toMatch(/\d+ i katalogen, \d+ med känt värde/);
  });

  it('white-spot legend counts add up to the tiles, and an expired avtal is not "has"', async () => {
    seedMarket();
    const html = (await body('/studio/kategori/larplattform')).text;
    const map = html.slice(html.indexOf('id="tackning"'), html.indexOf('id="fornyelser"'));
    const tiles = (map.match(/<span class="tile t-/g) || []).length;
    expect(tiles).toBeGreaterThan(200);
    const legend = map.slice(map.indexOf('tm-legend'), map.indexOf('</ul>', map.indexOf('tm-legend')));
    const counts = [...legend.matchAll(/<b>([\d\s\u00a0]+)<\/b>/g)].map((m) => Number(m[1].replace(/\D/g, '')));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(tiles);
    // Öckerö: only an expired Vklass avtal in lärplattform, collection open
    expect(map).toMatch(/class="tile t-expired[^"]*"[^>]*aria-label="Öckerö: bara utgångna eller ersatta avtal i lärplattform i underlaget; insamling pågår/);
    expect(map).not.toMatch(/class="tile t-has[^"]*"[^>]*aria-label="Öckerö/);
    expect(map).toMatch(/class="tile t-has[^"]*"[^>]*aria-label="Partille/);
  });

  it('has the segment matrix, pricing-model mix, renewal lanes per company and product cards', async () => {
    seedMarket();
    const html = (await body('/studio/kategori/laromedel')).text;
    const order = ['id="andelar"', 'id="pris"', 'id="prismodell"', 'id="tackning"', 'id="fornyelser"', 'id="produkter"', 'id="underlag"'];
    const pos = order.map((id) => html.indexOf(id));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(html).toContain('class="viz sm"');
    expect(html).toContain('Per elev');
    const tl = html.slice(html.indexOf('id="fornyelser"'), html.indexOf('id="produkter"'));
    expect(tl).toContain('Leverantör');
    expect(tl).toContain('ILT Education');
    const cards = html.slice(html.indexOf('id="produkter"'), html.indexOf('id="underlag"'));
    expect(cards).toContain('href="/studio/produkt/polyglutt"');
  });

  it('a category with no avtal still renders a full page', async () => {
    seedMarket();
    const r = await body('/studio/kategori/elevhalsa');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Elevhälsa');
    expect(r.text).toContain('class="viz tilemap"');
    noLeaks(r.text);
  });

  it('an unknown category is a 404 studio page', async () => {
    for (const slug of ['finns-inte', 'okand']) {
      const r = await get(app(), `/studio/kategori/${slug}`);
      expect(r.status).toBe(404);
      expect(r.text).toContain('data-studio');
      expect(r.text).toContain('Kategorin finns inte');
    }
  });
});
