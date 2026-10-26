import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { makeStudioData } from '../src/studio/routes.js';
import { footprintMap } from '../src/studio/pages/common.js';
import {
  buildStudioFacts, companyShares, marketByCategory, dataBasis, whiteSpots, priceDistribution, isRenewalOf,
  underlagEvidence,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renderKommun, perElevByCategory } from '../src/studio/pages/kommun.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { renderProdukt } from '../src/studio/pages/produkt.js';
import { productBySlug } from '../src/catalogue.js';

// Regression tests for the third final review (R1 to R5, S1, S2).
// Hand-written fixtures only (the repo is public): real kommun codes (open
// data) with made-up names, elever, values and dates; company and product
// names come from the committed catalogue. The shapes mirror what the
// reviewers found, the numbers do not.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 50 };
const SMALL = { 'Förskola': 50, 'Förskoleklass': 50, '1-3': 100, '4-6': 100, '7-9': 100, Gymnasiet: 200, Komvux: 10 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126'];
const OTHER = { '0862': E, '1472': E, '1462': E, '1439': E, '0662': E, '0617': SMALL, '0665': E, '0683': E };
export const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries([
      ...KODS.map((kod, i) => [kod, {
        namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
        peers: KODS.filter((k) => k !== kod), elever: E,
      }]),
      ...Object.entries(OTHER).map(([kod, elever], i) => [kod, {
        namn: `Annanby ${i + 1}`, lan: 'Annat län', folkmangd: 10000, kommungrupp: 'G2',
        peers: kod === '0662' ? ['0617', '0665', '0683'] : kod === '0617' ? ['0662', '0665', '0683'] : [], elever,
      }]),
    ]),
  },
});

let nextId = 1;
const C = (o = {}) => ({
  contract_id: nextId++,
  vendor_id: 1,
  vendor_name: 'Binogi AB',
  kommun_kod: '0114',
  kommun_namn: 'Testby 1',
  period_start: '2025-01-01',
  period_end: '2028-06-30',
  annual_value_sek: 100000,
  one_time_value_sek: null,
  pricing_model: 'fixed',
  unit_price_sek: null,
  unit: null,
  quantity: null,
  attachment_id: 500,
  received_at: '2026-02-01T10:00:00Z',
  products: [],
  ...o,
});
const COV = (contract_id, product_name, grade_level, student_count = 0, status = 'full') => ({
  contract_id, product_name, grade_level, student_count, status,
});
const covFor = (id, name, grades) => grades.map((g) => COV(id, name, g));
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id, slug) => facts.find((f) => f.contract_id === id && (slug === undefined || f.company_slug === slug));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const F9 = ['Förskoleklass', '1-3', '4-6', '7-9'];
const ALL = ['Förskola', ...F9, 'Gymnasiet', 'Komvux', 'Introduktionsprogrammet'];
const head = (facts) => facts.filter((f) => f.active && !f.superseded);

// ------------------------------------------------------------------ R1
describe('R1. only a clear renewal supersedes an older avtal', () => {
  const tieto = (kod, o) => C({ vendor_name: 'Tieto', kommun_kod: kod, products: ['Edlevo'], ...o });

  it('Emmaboda shape: a main Edlevo avtal and two tilläggsavtal all stay active', () => {
    const main = tieto('0862', { annual_value_sek: 400000, period_start: '2022-09-01', period_end: '2026-12-31' });
    const big = tieto('0862', { annual_value_sek: 120000, period_start: '2022-10-28', period_end: null });
    const small = tieto('0862', { annual_value_sek: 9000, period_start: '2023-06-14', period_end: null, products: ['Edlevo', 'Webmodul Nationella prov kursprov gy-kurser'] });
    const facts = build([main, big, small], {
      coverage: [...covFor(big.contract_id, 'Edlevo', ALL), ...covFor(small.contract_id, 'Edlevo', ['Gymnasiet', 'Komvux'])],
    });
    for (const c of [main, big, small]) expect(row(facts, c.contract_id)).toMatchObject({ active: true, superseded: false });
    const html = text(renderKommun({ kod: '0862', stats, facts, statusMap: new Map([['0862', 'done']]), today: TODAY }));
    expect(html).toMatch(/Känt årsvärde 529 tkr/);
  });

  it('Tibro shape: a tillägg with no school forms never hides the main avtal', () => {
    const main = tieto('1472', { annual_value_sek: 300000, period_start: '2022-01-01', period_end: '2029-12-31' });
    const add = tieto('1472', { annual_value_sek: 20000, period_start: '2023-11-09', period_end: null });
    const facts = build([main, add], { coverage: covFor(main.contract_id, 'Edlevo', ['Förskola', ...F9, 'Gymnasiet']) });
    expect(row(facts, main.contract_id).superseded).toBe(false);
    expect(row(facts, add.contract_id).superseded).toBe(false);
  });

  it('Lilla Edet shape: a later vuxenutbildning system with no school forms and a lower value is an addition', () => {
    const main = tieto('1462', { annual_value_sek: 480000, period_start: '2021-01-01', period_end: '2027-12-31' });
    const vux = tieto('1462', { annual_value_sek: 80000, period_start: '2024-01-29', period_end: '2028-01-29' });
    const facts = build([main, vux], { coverage: covFor(main.contract_id, 'Edlevo', ALL) });
    expect(new Set(head(facts).map((f) => f.contract_id))).toEqual(new Set([main.contract_id, vux.contract_id]));
  });

  it('Färgelanda shape: the option for SchoolSoft\'s lärplattform does not replace the SchoolSoft avtal', () => {
    const main = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '1439', annual_value_sek: 110000, period_start: '2024-01-01', period_end: '2028-12-31', products: ['SchoolSoft'] });
    const opt = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '1439', annual_value_sek: 40000, period_start: '2025-05-09', period_end: null, products: ['SchoolSoft'] });
    const facts = build([main, opt], { coverage: [...covFor(main.contract_id, 'SchoolSoft', ALL), ...covFor(opt.contract_id, 'SchoolSoft', ALL)] });
    expect(row(facts, main.contract_id).superseded).toBe(false);
  });

  it('a re-signing at the same value (within 2 %) supersedes, even when the older still runs', () => {
    const old = C({ annual_value_sek: 100000, period_start: '2024-01-01', period_end: '2028-06-30', products: ['Binogi'] });
    const neu = C({ annual_value_sek: 101500, period_start: '2025-08-01', period_end: '2029-06-30', products: ['Binogi'] });
    const facts = build([old, neu], { coverage: [...covFor(old.contract_id, 'Binogi', F9), ...covFor(neu.contract_id, 'Binogi', F9)] });
    expect(row(facts, old.contract_id).superseded).toBe(true);
  });

  it('a different value supersedes only when the older ends within 92 days of the newer start', () => {
    const mk = (end) => {
      const old = C({ annual_value_sek: 100000, period_start: '2024-01-01', period_end: end, products: ['Binogi'] });
      const neu = C({ annual_value_sek: 150000, period_start: '2026-08-01', period_end: '2029-07-31', products: ['Binogi'] });
      const facts = build([old, neu], { coverage: [...covFor(old.contract_id, 'Binogi', F9), ...covFor(neu.contract_id, 'Binogi', F9)] });
      return row(facts, old.contract_id).superseded;
    };
    expect(mk('2026-10-31')).toBe(true); // 91 days after 2026-08-01
    expect(mk('2026-11-01')).toBe(true); // 92 days
    expect(mk('2026-11-02')).toBe(false); // 93 days
    expect(mk('2028-06-30')).toBe(false);
  });

  it('an older avtal with no end date is replaced only by a re-signing', () => {
    const r = { period_start: '2024-01-01', period_end: null, segments: F9, product_slugs: ['binogi'], annual_value_sek: 100000 };
    const s = { period_start: '2025-01-01', period_end: '2027-12-31', segments: F9, product_slugs: ['binogi'], active: true };
    expect(isRenewalOf(r, { ...s, annual_value_sek: 300000 })).toBe(false);
    expect(isRenewalOf(r, { ...s, annual_value_sek: 99000 })).toBe(true);
    expect(isRenewalOf({ ...r, annual_value_sek: null }, { ...s, annual_value_sek: 300000 })).toBe(true);
  });

  it('a newer avtal with no school forms never covers an older one that has them, even at the same value', () => {
    const r = { period_start: '2024-01-01', period_end: '2028-01-01', segments: F9, product_slugs: ['binogi'], annual_value_sek: 100000 };
    const s = { period_start: '2025-01-01', period_end: '2028-01-01', segments: [], product_slugs: ['binogi'], annual_value_sek: 100000, active: true };
    expect(isRenewalOf(r, s)).toBe(false);
    expect(isRenewalOf({ ...r, segments: [] }, s)).toBe(true);
  });

  it('of two copies of one avtal, the copy with school forms is kept', () => {
    const a = C({ vendor_name: 'Vklass', annual_value_sek: 200000, products: ['Vklass'] });
    const b = C({ vendor_name: 'Vklass', annual_value_sek: 200000, products: ['Vklass'] });
    const facts = build([a, b], { coverage: covFor(b.contract_id, 'Vklass', F9) });
    expect(row(facts, a.contract_id).duplicate_of).toBe(b.contract_id);
    expect(row(facts, b.contract_id)).toMatchObject({ superseded: false, segments: F9 });
  });
});

// ------------------------------------------------------------------ R3
describe('R3. a samverkansavtal is shown whole, with andel okänd, and never as a member\'s price', () => {
  const ALLSEG = ['Förskola', ...F9, 'Gymnasiet', 'Komvux'];
  const ist = (kod, o = {}) => C({
    vendor_name: 'IST', kommun_kod: kod, annual_value_sek: 2000000, period_start: '2022-07-01', period_end: '2029-06-30',
    products: ['IST Administration'], ...o,
  });
  const ggvv = () => {
    const a = ist('0662'); const b = ist('0617', { annual_value_sek: 2000000.4 });
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'IST Administration', ALLSEG), ...covFor(b.contract_id, 'IST Administration', ALLSEG)] });
    return { a, b, facts };
  };

  it('GGVV shape: one avtal, the whole value counted once, no copy priced per elev', () => {
    const { a, b, facts } = ggvv();
    const ra = row(facts, a.contract_id); const rb = row(facts, b.contract_id);
    expect(ra).toMatchObject({ annual_value_sek: 2000000, kr_per_elev: null, joint: { n_kommuner: 2, kommun_kods: ['0617', '0662'], whole_value_sek: 2000000, counted_here: true } });
    expect(rb).toMatchObject({ annual_value_sek: null, kr_per_elev: null, joint: { whole_value_sek: 2000000, counted_here: false } });
    expect(ra.avtal_key).toBe(rb.avtal_key);
    const sk = companyShares(facts, { category: 'skoladministration' }).find((s) => s.slug === 'ist');
    expect(sk).toMatchObject({ value_known_sek: 2000000, n_avtal: 1, kommuner: 2 });
    expect(marketByCategory(facts).find((m) => m.category === 'skoladministration')).toMatchObject({ n_avtal: 1, value_known_sek: 2000000 });
    expect(dataBasis(facts).active).toBe(1);
    expect(priceDistribution(facts, { productSlug: 'ist-administration' }).n).toBe(0);
  });

  it('both member pages say samverkansavtal (2 kommuner), andel okänd, show the whole value as the whole avtal, and give no ert pris', () => {
    const { facts } = ggvv();
    for (const kod of ['0662', '0617']) {
      const html = text(renderKommun({ kod, stats, facts, statusMap: new Map([[kod, 'done']]), today: TODAY }));
      expect(html).toContain('samverkansavtal (2 kommuner), andel okänd');
      expect(html).toMatch(/2 mkr\/år för hela avtalet/);
      expect(html).not.toContain('ert pris');
      // The kommun's known spend leaves the samverkansavtal out.
      expect(html).toMatch(/Känt årsvärde okänt känd för 0 av 1 avtal, 1 samverkansavtal med okänd andel räknas inte/);
      expect(html).toContain('1 samverkansavtal med okänd andel räknas inte');
    }
  });

  it('spend per elev leaves a samverkansavtal out, and a peer whose category holds one is not compared', () => {
    const { a, facts } = ggvv();
    const rows = facts.filter((f) => f.contract_id === a.contract_id).map((f) => ({ ...f, annual_value_sek: null }));
    const own = perElevByCategory(rows, { eleverIn: () => 1000 }).get('skoladministration');
    expect(own).toMatchObject({ counted: 0, joint: 1, perElev: null });
    expect(perElevByCategory(rows, { eleverIn: () => 1000, completeOnly: true }).has('skoladministration')).toBe(false);
    // A joint row carries a whole value only on one copy; spend still excludes it.
    const withValue = facts.filter((f) => f.contract_id === a.contract_id);
    expect(perElevByCategory(withValue, { eleverIn: () => 1000 }).get('skoladministration')).toMatchObject({ counted: 0, joint: 1 });
  });

  it('partners are never each other\'s peers in a price strip: a joint styckpris is not a price', () => {
    // Tempus shape: two copies of one avtal with a per-elev line price.
    const line = (id) => ({ contract_id: id, product_name: 'Tempus Barn', amount_sek: null, unit_price_sek: 75, unit: 'elev', quantity: null, period_months: 12 });
    const a = C({ vendor_name: 'Tempus', kommun_kod: '0662', annual_value_sek: 170000, pricing_model: 'per_student', products: ['Tempus Barn'] });
    const b = C({ vendor_name: 'Tempus', kommun_kod: '0617', annual_value_sek: 170000, pricing_model: 'per_student', products: ['Tempus Barn'] });
    const facts = build([a, b], { lineItems: [line(a.contract_id), line(b.contract_id)] });
    expect(facts.every((f) => f.kr_per_elev == null)).toBe(true);
    expect(row(facts, a.contract_id).joint.n_kommuner).toBe(2);
    expect(priceDistribution(facts, { productSlug: 'tempus-barn' }).n).toBe(0);
    // Separate avtal (different value) keep their price.
    const c = C({ vendor_name: 'Tempus', kommun_kod: '0665', annual_value_sek: 99000, pricing_model: 'per_student', products: ['Tempus Barn'] });
    const f2 = build([c], { lineItems: [line(c.contract_id)] });
    expect(row(f2, c.contract_id).kr_per_elev).toBe(75);
  });
});

// ------------------------------------------------------------------ R2
describe('R2. no absence claim while underlag sits unread, or for a category we never asked for', () => {
  // Three done kommuner with no läromedel avtal; one has an unread file,
  // one an order list naming digitala läromedel, one nothing at all.
  const kods = ['0114', '0115', '0117', '0120'];
  const status = new Map(kods.map((k) => [k, 'done']));
  const facts = build([C({ kommun_kod: '0120', vendor_name: 'IST', products: ['IST Administration'] })]);

  it('underlagEvidence: an unread file counts whatever its type, a generic inline image does not', () => {
    const ev = underlagEvidence({
      unread: [
        { kommun_kod: '0114', filename: 'order-history.csv', mime_type: 'application/octet-stream' },
        { kommun_kod: '0115', filename: 'image001.png', mime_type: 'image/png' },
        { kommun_kod: '0115', filename: 'Outlook-qx1y2z3', mime_type: 'image/jpg' },
        { kommun_kod: '0115', filename: 'image (2).png', mime_type: 'image/png' },
        { kommun_kod: '0117', filename: 'Avtalstid.png', mime_type: 'image/png' },
      ],
    });
    expect([...ev.unreadKods].sort()).toEqual(['0114', '0117']);
  });

  it('underlagEvidence: an order list with no vendor points to its category by its summary; an invoice line by its product', () => {
    const ev = underlagEvidence({
      documents: [
        { kommun_kod: '0114', document_type: 'följebrev_sammanställning', vendor_name: null, summary: 'Orderhistorik med beställningar av digitala läromedel och licenser per skola.', products: [], lines: [] },
        { kommun_kod: '0115', document_type: 'övrigt', vendor_name: null, summary: 'Faktura för en kommunlicens.', products: [], lines: ['Kunskapsmatrisen och Exam.net'] },
      ],
    });
    expect([...ev.docs.get('0114').categories]).toEqual(['laromedel']);
    expect(ev.docs.get('0115').categories.has('prov')).toBe(true);
    expect(ev.docs.get('0115').companies.has('teachiq')).toBe(true);
  });

  it('a kommun with an unread file is underlag ej genomgånget in every category; an order list only in its own', () => {
    const underlag = underlagEvidence({
      unread: [{ kommun_kod: '0114', filename: 'order.csv', mime_type: 'text/csv' }],
      documents: [{ kommun_kod: '0115', vendor_name: null, summary: 'Inköp av digitala läromedel via en återförsäljare.', products: [], lines: [] }],
    });
    const lm = whiteSpots(facts, status, { category: 'laromedel', allKods: kods, underlag });
    expect(lm.none_done).toEqual(['0117', '0120']);
    expect(lm.unreviewed).toEqual(['0114', '0115']);
    const lp = whiteSpots(facts, status, { category: 'larplattform', allKods: kods, underlag });
    expect(lp.unreviewed).toEqual(['0114']);
    expect(lp.none_done).toEqual(['0115', '0117', '0120']);
  });

  it('fails closed: when the underlag cannot be read, no kommun is a safe white spot', () => {
    const ws = whiteSpots(facts, status, { category: 'laromedel', allKods: kods, underlag: { unavailable: true } });
    expect(ws.none_done).toEqual([]);
    expect(ws.unreviewed).toEqual(kods);
  });

  it('elevhälsa, övrigt and unknown are outside the request: never a white spot', () => {
    for (const category of ['elevhalsa', 'ovrigt', 'okand']) {
      const ws = whiteSpots(facts, status, { category, allKods: kods, underlag: underlagEvidence({}) });
      expect(ws.none_done).toEqual([]);
      expect(ws.not_in_request.length).toBeGreaterThan(0);
    }
  });

  it('the elevhälsa page shows no safe white spots and says the category is not part of the request', () => {
    const html = renderKategori({ category: findCategory('elevhalsa'), facts, stats, statusMap: status, today: TODAY, underlag: underlagEvidence({}) });
    const t = text(html);
    expect(t).toContain('Elevhälsa ingår inte i vår begäran.');
    expect(t).toMatch(/Säkra vita fläckar okänt Elevhälsa ingår inte i vår begäran, så vi säger inget om var avtal saknas/);
    expect(html).not.toContain('class="tile t-none-done');
    expect(t).not.toContain('Det är de säkra vita fläckarna');
  });

  it('the läromedel page counts an order-list kommun apart, hatched, not as a safe white spot', () => {
    const underlag = underlagEvidence({ documents: [{ kommun_kod: '0115', vendor_name: null, summary: 'Inköp av digitala läromedel.', products: [], lines: [] }] });
    const html = renderKategori({ category: findCategory('laromedel'), facts, stats, statusMap: status, today: TODAY, underlag });
    const t = text(html);
    expect(t).toContain('3 kommuner har klar insamling och inga avtal alls i läromedel.');
    expect(t).toContain('1 kommun med klar insamling har skickat underlag vi inte har gått igenom än');
    expect(t).toMatch(/räknas inte: 1 med underlag ej genomgånget/);
    expect(html).toMatch(/class="tile t-unknown[^"]*"[^>]*aria-label="Testby 2: underlag ej genomgånget/);
  });

  it('a footprint map for an elevhälsa company claims no absence', () => {
    const pr = build([C({ kommun_kod: '0120', vendor_name: 'ProReNata AB', products: [] })]);
    const tiles = { cols: 2, rows: 2, tiles: { '0114': { x: 0, y: 0 }, '0115': { x: 1, y: 0 }, '0117': { x: 0, y: 1 }, '0120': { x: 1, y: 1 } } };
    const html = footprintMap({ tiles, rows: pr, statusMap: status, stats, entity: 'Prorenata', nameOf: (k) => k, underlag: underlagEvidence({}), scope: { category: 'elevhalsa', companySlug: 'prorenata' } });
    expect(html).not.toContain('t-none-done');
    expect(html).toContain('Ingår inte i begäran');
    const lm = footprintMap({ tiles, rows: [], statusMap: status, stats, entity: 'Binogi', nameOf: (k) => k, underlag: underlagEvidence({ unread: [{ kommun_kod: '0114', filename: 'x.pdf', mime_type: 'application/pdf' }] }), scope: { category: 'laromedel', companySlug: 'binogi' } });
    expect((lm.match(/class="tile t-none-done[^"]*" tabindex/g) || []).length).toBe(3);
    expect(lm).toMatch(/aria-label="0114: underlag ej genomgånget/);
  });

  describe('storage listStudioUnderlag and makeStudioData', () => {
    let tmp; let db;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'studio-underlag-'));
      db = openDb(join(tmp, 'pilot.db'));
      db.migrate();
    });
    afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });
    let n = 0;
    const attach = (kod, filename, mime) => {
      const conv = db.raw.prepare('SELECT id FROM conversations WHERE kommun_kod = ?').get(kod)?.id ?? db.createConversation({
        kommun_kod: kod, kommun_namn: `Testby ${kod}`, role: 'central', contact_email: 'registrator@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
      });
      db.raw.prepare("UPDATE conversations SET state = 'DONE' WHERE id = ?").run(conv);
      const msg = db.recordMessage({
        conversation_id: conv, gmail_message_id: `gm-u-${++n}`, direction: 'inbound', from_email: 'registrator@example.se', to_email: 'me@example.com',
        subject: 'Underlag', body_text: 'Se bifogat.', classification: null, classification_confidence: null, received_at: '2026-09-01T10:00:00Z', attachment_count: 1,
      });
      return db.recordAttachment({ message_id: msg, filename, saved_path: join(tmp, `${n}.bin`), mime_type: mime, size_bytes: 10 });
    };

    it('lists pending and parked unread files, and non-avtal documents with their lines; avtal are left out', () => {
      attach('0114', 'Avtal.pdf', 'application/pdf');
      const parked = attach('0115', 'Skannad.pdf', 'application/pdf');
      db.recordAnalysisFailure(parked, { reason: 'zero text', permanent: true });
      const inv = attach('0117', 'Faktura.pdf', 'application/pdf');
      const docId = db.recordContract({ attachment_id: inv, is_contract: 0, document_type: 'övrigt', summary: 'Faktura för en kommunlicens.', confidence: 0.9 });
      db.replaceContractLineItems(docId, [{ product_name: 'Kunskapsmatrisen och Exam.net' }]);
      const av = attach('0120', 'Huvudavtal.pdf', 'application/pdf');
      db.recordContract({ attachment_id: av, is_contract: 1, summary: 'Avtal', confidence: 0.9 });
      const u = db.listStudioUnderlag();
      expect(u.unread.map((r) => r.kommun_kod).sort()).toEqual(['0114', '0115']);
      expect(u.documents).toHaveLength(1);
      expect(u.documents[0]).toMatchObject({ kommun_kod: '0117', document_type: 'övrigt', lines: ['Kunskapsmatrisen och Exam.net'] });
      const data = makeStudioData({ db, statsLoader: () => stats, now: () => new Date('2026-10-26T12:00:00Z') })();
      expect([...data.underlag.unreadKods].sort()).toEqual(['0114', '0115']);
      expect(data.underlag.docs.get('0117').categories.has('prov')).toBe(true);
    });

    it('makeStudioData fails closed when the db cannot list underlag', () => {
      const broken = { ...db, listStudioUnderlag: () => { throw new Error('no table'); } };
      for (const k of ['listContractFacts', 'listLineItems', 'listCoverage', 'listAllConversations']) broken[k] = db[k];
      const data = makeStudioData({ db: broken, statsLoader: () => stats, now: () => new Date('2026-10-26T12:00:00Z') })();
      expect(data.underlag).toEqual({ unavailable: true });
    });
  });
});

// ------------------------------------------------------------------ R4
describe('R4. category and product counts are avtal, not copies or kommuner', () => {
  it('a samverkansavtal from two kommuner is one active avtal on the category page, as on Marknad', () => {
    const mk = (kod) => C({ vendor_name: 'IST', kommun_kod: kod, annual_value_sek: 1500000, period_start: '2023-01-01', period_end: '2029-12-31', products: ['IST Administration'] });
    const facts = build([mk('0662'), mk('0617')]);
    expect(marketByCategory(facts).find((m) => m.category === 'skoladministration').n_avtal).toBe(1);
    const t = text(renderKategori({ category: findCategory('skoladministration'), facts, stats, statusMap: new Map(), today: TODAY }));
    expect(t).toMatch(/Aktiva avtal 1 avtal 1 insamlade totalt/);
    expect(t).toMatch(/känt för 1 av 1 avtal/);
  });

  it('product price coverage counts priced avtal: two priced avtal in one kommun are 2 of 2', () => {
    const line = (id, p) => ({ contract_id: id, product_name: 'Polylino', amount_sek: null, unit_price_sek: p, unit: 'elev', quantity: null, period_months: 12 });
    const a = C({ vendor_name: 'ILT Education AB', annual_value_sek: 50000, pricing_model: 'per_student', products: ['Polylino'] });
    const b = C({ vendor_name: 'ILT Education AB', annual_value_sek: 70000, period_start: '2025-01-01', period_end: '2028-07-31', pricing_model: 'per_student', products: ['Polylino'] });
    const facts = build([a, b], { lineItems: [line(a.contract_id, 60), line(b.contract_id, 80)], coverage: [...covFor(a.contract_id, 'Polylino', ['1-3']), ...covFor(b.contract_id, 'Polylino', ['4-6'])] });
    expect(head(facts)).toHaveLength(2);
    const hit = productBySlug('polylino');
    const t = text(renderProdukt({ product: hit.product, company: hit.company, facts, stats, statusMap: new Map(), today: TODAY }));
    expect(t).toMatch(/Pris per elev känt 2 av 2 aktiva avtal/);
    expect(priceDistribution(facts, { productSlug: 'polylino' }).n).toBe(1);
  });
});

// ------------------------------------------------------------------ R5, S2
describe('R5 and S2. spend per elev says it is per elev in the kommun; a chart of only "för få" collapses', () => {
  const spendFacts = (kods) => {
    const cs = kods.map((kod, i) => C({ kommun_kod: kod, vendor_name: 'Gleerups', annual_value_sek: 100000 + i * 10000, products: ['Gleerups digitala läromedel'] }));
    return build(cs, { coverage: cs.flatMap((c) => covFor(c.contract_id, 'Gleerups digitala läromedel', F9)) });
  };
  it('with five done peers the chart shows, and the lede says per elev i kommunen i de skolformer avtalen gäller', () => {
    const facts = spendFacts(KODS);
    const st = new Map(KODS.map((k) => [k, 'done']));
    const html = renderKommun({ kod: '0114', stats, facts, statusMap: st, today: TODAY });
    const t = text(html);
    expect(t).toContain('Känt årsvärde per elev i kommunen i de skolformer avtalen gäller');
    expect(t).toContain('inte avtalets pris per elev');
    expect(t).toContain('kr per elev i kommunen och år, i avtalens skolformer');
    expect(html).toContain('class="sc-list"');
    // 100 000 kr over 1 000 F-9 elever.
    expect(t).toMatch(/100 kr\/elev/);
  });
  it('with fewer than five done peers in every category it is one sentence with the counts and the own figure', () => {
    const facts = spendFacts(KODS);
    const st = new Map(KODS.map((k, i) => [k, i < 4 ? 'done' : 'open']));
    const html = renderKommun({ kod: '0114', stats, facts, statusMap: st, today: TODAY });
    const t = text(html);
    expect(html).not.toContain('class="sc-list"');
    expect(t).toContain('För få liknande kommuner att jämföra med');
    expect(t).toContain('3 av 6 liknande kommuner har klar insamling, och i ingen kategori har minst 5 av dem');
    expect(t).toContain('(flest i läromedel: 3)');
    expect(t).toContain('Ert kända årsvärde per elev i kommunen, i de skolformer avtalen gäller: Läromedel 100 kr/elev.');
  });
});
