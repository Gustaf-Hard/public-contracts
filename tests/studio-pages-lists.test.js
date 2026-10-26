import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renewalsCsv, termsText } from '../src/studio/pages/fornyelser.js';

// Hand-written fixture data only (the repo is public). Kommun names and kods
// are open data, kommungrupper and län are assigned for the test; vendor and
// product names come from the committed catalogue; every price, date and
// count is invented.
const KOMMUNER = [
  ['1440', 'Ale', 'Pendlingskommun nära storstad', 'Västra Götalands län'],
  ['1401', 'Härryda', 'Pendlingskommun nära storstad', 'Västra Götalands län'],
  ['1402', 'Partille', 'Pendlingskommun nära storstad', 'Västra Götalands län'],
  ['0560', 'Boxholm', 'Landsbygdskommun, ej nära större stad', 'Östergötlands län'],
  ['0180', 'Stockholm', 'Storstäder', 'Stockholms län'],
  ['0380', 'Uppsala', 'Större stad', 'Uppsala län'],
];
const ELEVER = { 'Förskola': 900, 'Förskoleklass': 300, '1-3': 900, '4-6': 900, '7-9': 900, Gymnasiet: 800, Komvux: 300 };
const STATS = loadKommunStats({
  data: {
    fetched_at: '2026-10-20T08:00:00.000Z',
    kommuner: Object.fromEntries(KOMMUNER.map(([kod, namn, grupp, lan]) => [kod, {
      namn, lan, folkmangd: 30000, kommungrupp: grupp, elever: ELEVER,
    }])),
  },
});

let tmp, db, contractsDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'studio-lists-'));
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
  kod, vendor, value = 100000, start = '2025-08-01', end = '2027-07-31', model = 'fixed',
  lines = [], state = 'DELIVERING', extra = {},
}) {
  const convId = conversation(kod, state);
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${++seq}`,
    direction: 'inbound', from_email: 'anna.andersson@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Hej, se bifogat. Anna Andersson, 070-123 45 67', classification: null,
    classification_confidence: null, received_at: '2026-05-01T10:00:00Z', attachment_count: 1,
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
    period_start: start, period_end: end, is_contract: 1, summary: 'Licens', confidence: 0.9, ...extra,
  });
  if (lines.length) db.replaceContractLineItems(cid, lines);
  return cid;
}

// today = 2026-10-26. Polyglutt (läromedel) ends 2027-01-31 in Ale and
// Härryda; Vklass (lärplattform) ends 2027-03-31 in Partille; Binogi
// (läromedel) ends 2028-02-29 in Ale (inside 18 months, outside 12); a Skolon
// avtal in Partille split between Gleerups and NE ends 2027-05-31; one
// expired avtal; Upplands-Bro kommun (hidden in the studio) as a vendor.
function seedRenewals() {
  for (const kod of ['1440', '1401']) {
    seedContract({ kod, vendor: 'ILT Education AB', value: 300000, end: '2027-01-31', model: 'per_student', lines: [{ product_name: 'Polyglutt', unit: 'elev', unit_price_sek: 140, period_months: 12 }] });
  }
  seedContract({ kod: '1402', vendor: 'Vklass AB', value: 120000, end: '2027-03-31', lines: [{ product_name: 'Vklass' }], extra: { extension_option_until: '2028-03-31' } });
  seedContract({ kod: '1440', vendor: 'Binogi AB', value: null, end: '2028-02-29', lines: [{ product_name: 'Binogi' }] });
  seedContract({
    kod: '1402', vendor: 'Skolon AB', value: 70000, end: '2027-05-31',
    lines: [
      { product_name: 'Gleerups Digitala läromedel', amount_sek: 40000, period_months: 12 },
      { product_name: 'NE Kunskapstjänster', amount_sek: 30000, period_months: 12 },
    ],
  });
  seedContract({ kod: '1401', vendor: 'Vklass AB', value: 90000, start: '2019-01-01', end: '2022-12-31', lines: [{ product_name: 'Vklass' }] });
  seedContract({ kod: '1402', vendor: 'Upplands-Bro kommun', value: 50000, end: '2027-02-28' });
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
        const buf = Buffer.from(await r.arrayBuffer());
        server.close(() => resolve({ status: r.status, text: buf.toString('utf8'), raw: buf, headers: r.headers }));
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
  expect(html).not.toMatch(/[–—≤]/);
  expect(html).not.toMatch(/NaN|Infinity|undefined/);
}

const listPart = (html) => html.slice(html.indexOf('id="lista"'));

describe('/studio/fornyelser', () => {
  it('kategori=laromedel&man=12 lists only läromedel avtal within 12 months', async () => {
    seedRenewals();
    const r = await body('/studio/fornyelser?kategori=laromedel&man=12');
    expect(r.status).toBe(200);
    const list = listPart(r.text);
    expect(list.match(/class="fx-row"/g)).toHaveLength(3); // two Polyglutt + the Skolon split
    expect(list).toContain('ILT Education');
    expect(list).toContain('Härryda');
    expect(list).not.toContain('Vklass');
    expect(list).not.toContain('Binogi');
    noLeaks(r.text);
  });

  it('defaults to 18 months, lists by date, and lists split owners together on one row', async () => {
    seedRenewals();
    const r = await body('/studio/fornyelser');
    const list = listPart(r.text);
    // 2 Polyglutt + Vklass + Skolon split + Binogi; the expired avtal and the
    // hidden vendor are not listed
    expect(list.match(/class="fx-row"/g)).toHaveLength(5);
    expect(list).not.toContain('Upplands-Bro');
    // Vklass is dated by its extension option (2028-03-31), after Binogi
    expect(list.indexOf('Polyglutt')).toBeLessThan(list.indexOf('Gleerups'));
    expect(list.indexOf('Gleerups')).toBeLessThan(list.indexOf('Binogi'));
    expect(list.indexOf('Binogi')).toBeLessThan(list.indexOf('Vklass'));
    const row = list.split('class="fx-row"').find((s) => s.includes('Gleerups'));
    expect(row).toContain('Nationalencyklopedin');
    expect(row).toContain('via Skolon');
    expect(row).toContain('70 tkr');
    // Binogi: value unknown, never 0
    const bin = list.split('class="fx-row"').find((s) => s.includes('Binogi'));
    expect(bin).toContain('värde okänt');
    // Vklass states an extension option
    const vk = list.split('class="fx-row"').find((s) => s.includes('Vklass'));
    expect(vk).toContain('kan förlängas till 2028-03-31');
    expect(r.text).toContain('class="viz rw fx-chart"');
    expect(r.text).toContain('href="/studio/fornyelser.csv"');
    noLeaks(r.text);
  });

  it('serves a CSV with BOM, Swedish header and ; separated rows', async () => {
    seedRenewals();
    const r = await get(app(), '/studio/fornyelser.csv?kategori=laromedel&man=12');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/csv/);
    expect(r.headers.get('content-disposition')).toContain('fornyelser-2026-10-26.csv');
    expect([...r.raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = r.text.replace(/^﻿/, '');
    expect(text.startsWith('Kommun;Leverantör;')).toBe(true);
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^Ale;ILT Education;Polyglutt;Läromedel;Västra Götalands län;Pendlingskommun nära storstad;Direkt;300000;känt;2027-01-31;/);
    expect(text).not.toMatch(EMAIL);
  });

  it('CSV cells that would run as formulas are neutralised and quotes escaped', () => {
    const csv = renewalsCsv([{
      kommun: '=HYPERLINK("x")', owners: [{ slug: null, name: 'A;B "C"' }], products: [], categories: ['okand'],
      lan: null, kommungrupp: null, channel: null, value: null, valuePartial: false, date: '2027-01-01',
      period_end: null, extension_option_until: null, auto_renews: null, last_cancellation_date: null,
    }]);
    const row = csv.split('\r\n')[1];
    expect(row.startsWith(`"'=HYPERLINK(""x"")";"A;B ""C""";`)).toBe(true);
    expect(row).toContain(';okänt;');
  });

  it('describes auto renewal with the cancellation date', () => {
    expect(termsText({ auto_renews: true, last_cancellation_date: '2027-03-31' })).toBe('förlängs automatiskt om det inte sägs upp senast 2027-03-31');
  });

  it('renders an empty state with an empty database', async () => {
    const r = await body('/studio/fornyelser');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Inga förnyelser i urvalet');
    noLeaks(r.text);
  });
});

describe('/studio/utforska', () => {
  it('page 1 has 50 rows and links to page 2', async () => {
    const vendors = [['ILT Education AB', 'Polyglutt'], ['Vklass AB', 'Vklass'], ['Binogi AB', 'Binogi']];
    let k = 0;
    for (let i = 0; i < 20; i++) {
      for (const [vendor, product] of vendors) {
        const kod = KOMMUNER[k++ % 3][0];
        seedContract({ kod, vendor, value: 10000 + i * 1000, start: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`, end: '2028-06-30', lines: [{ product_name: product }] });
      }
    }
    const r = await body('/studio/utforska');
    expect(r.status).toBe(200);
    // newest avtal per kommun x company x product counts: 3 kommuner x 3 vendors
    const all = await body('/studio/utforska?urval=alla');
    const rows = all.text.slice(all.text.indexOf('<tbody>'), all.text.indexOf('</tbody>'));
    expect(rows.match(/<tr/g)).toHaveLength(50);
    expect(all.text).toMatch(/href="\/studio\/utforska\?urval=alla&amp;sida=2"/);
    expect(all.text).toContain('class="viz rank"');
    const p2 = await body('/studio/utforska?urval=alla&sida=2');
    const rows2 = p2.text.slice(p2.text.indexOf('<tbody>'), p2.text.indexOf('</tbody>'));
    expect(rows2.match(/<tr/g)).toHaveLength(10);
    noLeaks(r.text);
    noLeaks(all.text);
  });

  it('filters and groups through explorer-core, with dash-free band labels', async () => {
    seedRenewals();
    const r = await body('/studio/utforska?grupp=kategori&value_band=100%20till%20500%20tkr');
    expect(r.status).toBe(200);
    const rows = r.text.slice(r.text.indexOf('<tbody>'), r.text.indexOf('</tbody>'));
    expect(rows.match(/<tr/g)).toHaveLength(3); // 2 Polyglutt at 300 tkr + Vklass at 120 tkr
    expect(r.text).toContain('Efter kategori');
    noLeaks(r.text);
  });
});

describe('/studio/utforska never ranks kommuner by price', () => {
  it('grupp=kommun counts avtal, and the table is alphabetical by kommun', async () => {
    seedRenewals();
    const r = await body('/studio/utforska?grupp=kommun');
    expect(r.text).toContain('Antal avtal per kommun');
    const chart = r.text.slice(r.text.indexOf('id="gruppering"'), r.text.indexOf('id="avtal"'));
    expect(chart).not.toMatch(/tkr|mkr/);
    const rows = r.text.slice(r.text.indexOf('<tbody>'), r.text.indexOf('</tbody>'));
    const names = [...rows.matchAll(/data-label="Kommun"><a[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'sv')));
  });
});

describe('/studio/leverantorer', () => {
  it('cards grouped by category, hiddenInStudio companies excluded, uncatalogued names folded', async () => {
    seedRenewals();
    seedContract({ kod: '1440', vendor: 'Helt Okänd Firma AB', value: 20000, lines: [{ product_name: 'Något' }] });
    const r = await body('/studio/leverantorer');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain('Upplands-Bro');
    expect(r.text).toContain('id="grupp-laromedel"');
    expect(r.text).toContain('href="/studio/leverantor/ilt"');
    const others = r.text.slice(r.text.indexOf('id="ovriga"'));
    expect(others).toContain('Helt Okänd Firma');
    expect(others).toContain('<details');
    noLeaks(r.text);
  });

  it('narrows with q', async () => {
    seedRenewals();
    const r = await body('/studio/leverantorer?q=vklass');
    expect(r.text).toContain('Vklass');
    expect(r.text).not.toContain('href="/studio/leverantor/ilt"');
  });
});

describe('/studio/kommuner', () => {
  it('tile map by collection status and a list with län, avtal and status', async () => {
    seedRenewals();
    const r = await body('/studio/kommuner');
    expect(r.status).toBe(200);
    expect(r.text).toContain('class="viz tilemap"');
    expect(r.text).toContain('Insamling klar');
    expect(r.text).toContain('Inte kontaktad');
    const list = listPart(r.text);
    expect(list).toContain('Västra Götalands län');
    expect(list).toContain('href="/studio/kommun/1440"');
    // Uppsala is open with no avtal (hatched), Ale open with avtal (has-open)
    expect(r.text).toMatch(/class="tile t-none-open[^"]*"[^>]*aria-label="Uppsala/);
    expect(r.text).toMatch(/class="tile t-has-open[^"]*"[^>]*aria-label="Ale/);
    const boxholm = list.split('class="kl-row"').find((s) => s.includes('Boxholm'));
    expect(boxholm).toContain('Inte kontaktad');
    noLeaks(r.text);
  });

  it('filters by status', async () => {
    seedRenewals();
    const r = await body('/studio/kommuner?status=done');
    const list = listPart(r.text);
    expect(list).toContain('Stockholm');
    expect(list).not.toContain('href="/studio/kommun/1440"');
  });
});

describe('/studio/sok', () => {
  it('an exact kommun name redirects to the kommun page', async () => {
    const r = await get(app(), '/studio/sok?q=Ale');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/studio/kommun/1440');
    const r2 = await get(app(), '/studio/sok?q=ale%20kommun');
    expect(r2.headers.get('location')).toBe('/studio/kommun/1440');
  });

  it('an exact company or product name redirects to its page', async () => {
    expect((await get(app(), '/studio/sok?q=ILT%20Education')).headers.get('location')).toBe('/studio/leverantor/ilt');
    expect((await get(app(), '/studio/sok?q=polyglutt')).headers.get('location')).toBe('/studio/produkt/polyglutt');
  });

  it('otherwise renders results grouped by kommuner, leverantörer and produkter', async () => {
    const r = await body('/studio/sok?q=poly');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Produkter');
    expect(r.text).toContain('href="/studio/produkt/polyglutt"');
    const none = await body('/studio/sok?q=zzzzqq');
    expect(none.text).toContain('Inga träffar');
    const hidden = await body('/studio/sok?q=upplands-bro%20kommun');
    expect(hidden.text).not.toContain('/studio/leverantor/upplands-bro');
    noLeaks(r.text);
  });
});

describe('/studio/om', () => {
  it('explains active avtal, kr/elev, MIN_N, peers, channels with numbers from the data', async () => {
    seedRenewals();
    const r = await body('/studio/om');
    expect(r.status).toBe(200);
    // 7 collected, 6 active (one expired), from 3 kommuner
    expect(r.text).toContain('Därför är bara 6 av 7 insamlade avtal aktiva');
    expect(r.text).toContain('minst 5 avtal');
    expect(r.text).toContain('Styckpris');
    expect(r.text).toContain('Skolverkets elevantal');
    expect(r.text).toContain('kommungrupp');
    expect(r.text).toContain('ej fördelat');
    expect(r.text).toContain('hämtades 2026-10-20');
    expect(r.text).toContain('insamlingen klar i 1 kommun, pågår i 4');
    noLeaks(r.text);
  });
});
