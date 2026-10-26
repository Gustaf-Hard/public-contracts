import { describe, it, expect } from 'vitest';
import {
  buildStudioFacts, companyShares, marketByCategory, whiteSpots, priceDistribution, underlagEvidence,
  sameDocument, namesOther,
} from '../src/studio-data.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { renderKommun } from '../src/studio/pages/kommun.js';
import { renderKategori, findCategory } from '../src/studio/pages/kategori.js';
import { renderLeverantor } from '../src/studio/pages/leverantor.js';
import { renderOm } from '../src/studio/pages/om.js';
import { renewalRows, renewalsCsv, renderFornyelser } from '../src/studio/pages/fornyelser.js';
import { footprintMap } from '../src/studio/pages/common.js';
import { companyBySlug } from '../src/catalogue.js';

// Regression tests for the fourth final review (W1 to W5, X1, X2).
// Hand-written fixtures only (the repo is public): real kommun codes and
// names (open data) with made-up elever, values, dates and summaries;
// company and product names come from the committed catalogue. The shapes
// mirror what the reviewers found, the numbers do not.
const TODAY = '2026-10-26';
const E = { 'Förskola': 100, 'Förskoleklass': 100, '1-3': 300, '4-6': 300, '7-9': 300, Gymnasiet: 800, Komvux: 100 };
const KODS = ['0114', '0115', '0117', '0120', '0123', '0125', '0126', '0127'];
const stats = loadKommunStats({
  data: {
    kommuner: Object.fromEntries(KODS.map((kod, i) => [kod, {
      namn: `Testby ${i + 1}`, lan: 'Testlän', folkmangd: 20000, kommungrupp: 'G1',
      peers: KODS.filter((k) => k !== kod), elever: E,
    }])),
  },
});
const ALL = ['Förskola', 'Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'];
const ELEVER_ALL = 2000;

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
const covFor = (id, name, grades) => grades.map((g) => ({ contract_id: id, product_name: name, grade_level: g, student_count: 0, status: 'full' }));
const build = (contracts, { lineItems = [], coverage = [] } = {}) =>
  buildStudioFacts({ contracts, lineItems, coverage, stats, today: TODAY });
const row = (facts, id) => facts.find((f) => f.contract_id === id);
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const done = (kods) => new Map(kods.map((k) => [k, 'done']));
const ABSENCE = /insamlingen klar|insamling klar, inga|inga avtal alls|säkra|vita fläck|vit fläck|har lämnat ut sina avtal utan|inget avtal med [^<;]*, insamling/i;

// ------------------------------------------------------------------ W1
describe('W1. the studio never claims a kommun has no avtal', () => {
  // Testby 2 (0115) is the Timrå shape: collection done, no Trelson avtal
  // row, but a mail we never read names Trelson. We cannot see the mail, so
  // the page may only say what the underlag holds.
  const trelson = (kod) => C({ vendor_name: 'Trelson AB', kommun_kod: kod, products: ['Trelson Assessment'] });
  const facts = build([trelson('0114')]);
  const status = new Map([['0114', 'done'], ['0115', 'done'], ['0117', 'open'], ['0120', 'not_contacted']]);

  it('whiteSpots: a done kommun and a never-contacted one are the same bucket, the status apart', () => {
    const ws = whiteSpots(facts, status, { category: 'prov', allKods: ['0114', '0115', '0117', '0120'] });
    expect(ws.has).toEqual(['0114']);
    expect(ws.none).toEqual(['0115', '0117', '0120']);
    expect(['0115', '0117', '0120'].map((k) => ws.status.get(k))).toEqual(['done', 'open', 'not_contacted']);
  });

  it('the Trelson footprint: every kommun without a Trelson avtal is one tile class, with the status as a neutral fact', () => {
    const tiles = { cols: 4, rows: 1, tiles: { '0114': { x: 0, y: 0 }, '0115': { x: 1, y: 0 }, '0117': { x: 2, y: 0 }, '0120': { x: 3, y: 0 } } };
    const html = footprintMap({ tiles, rows: facts, statusMap: status, stats, entity: 'Trelson', nameOf: (k) => k, underlag: underlagEvidence({}), scope: { category: 'prov', companySlug: 'trelson' } });
    expect(html).toMatch(/class="tile t-none[^"]*"[^>]*aria-label="0115: inget avtal med Trelson i underlaget; insamling klar"/);
    expect(html).toMatch(/class="tile t-none[^"]*"[^>]*aria-label="0117: inget avtal med Trelson i underlaget; insamling pågår"/);
    expect(html).toMatch(/class="tile t-none[^"]*"[^>]*aria-label="0120: inget avtal med Trelson i underlaget; insamling ej påbörjad"/);
    expect(html).toContain('Det betyder inte att avtal saknas');
    expect(text(html)).not.toMatch(ABSENCE);
  });

  it('the Trelson vendor page makes no absence claim anywhere', () => {
    const html = renderLeverantor({ company: companyBySlug('trelson'), facts, stats, statusMap: status, today: TODAY, underlag: underlagEvidence({}) });
    expect(text(html)).not.toMatch(ABSENCE);
    expect(html).not.toMatch(/t-none-done|t-refused|t-none-open|t-not-contacted/);
  });

  it('kategori page: KPI "Utan avtal i underlaget" with the klar share in its basis; the map has the three underlag classes only', () => {
    const html = renderKategori({ category: findCategory('prov'), facts, stats, statusMap: status, today: TODAY, underlag: underlagEvidence({}) });
    const t = text(html);
    expect(t).toMatch(/Utan avtal i underlaget 7 kommuner varav 1 med klar insamling; mejl och sammanställningar kan nämna leverantörer vi inte har avtal för/);
    expect(t).toContain('7 kommuner har inget avtal i prov och bedömning i underlaget.');
    expect(t).toContain('Det betyder inte att de saknar avtal');
    expect(t).not.toMatch(ABSENCE);
    const classes = new Set([...html.matchAll(/class="tile t-([a-z-]+)/g)].map((m) => m[1]));
    for (const c of classes) expect(['has', 'expired', 'none', 'unknown']).toContain(c);
  });

  it('underlag ej genomgånget is a status beside the same tile, never a different colour', () => {
    const underlag = underlagEvidence({ documents: [{ kommun_kod: '0115', vendor_name: null, summary: 'Sammanställning: Trelson / Provplattform, Exam.net.', products: [], lines: [] }] });
    const ws = whiteSpots(facts, status, { category: 'prov', allKods: ['0114', '0115'], underlag });
    expect(ws.none).toEqual(['0115']);
    expect(ws.status.get('0115')).toBe('unreviewed');
  });

  it('Om datan explains the rule and never speaks of vita fläckar', () => {
    const t = text(renderOm({ facts, stats, statusMap: status, basis: {}, today: TODAY }));
    expect(t).toContain('Studion visar vad underlaget innehåller, aldrig att en kommun saknar avtal.');
    expect(t).not.toMatch(/vita fläck|vit fläck|säker/i);
  });

  it('a kommun page with no avtal in a category says "inget avtal i underlaget"', () => {
    const t = text(renderKommun({ kod: '0115', stats, facts, statusMap: status, today: TODAY }));
    expect(t).not.toMatch(ABSENCE);
  });
});

// ------------------------------------------------------------------ W2
describe('W2. a tilläggsavtal never makes its own price point', () => {
  const tieto = (kod, o) => C({ vendor_name: 'Tieto', kommun_kod: kod, products: ['Edlevo'], ...o });

  // r5 V1: the point is the main avtal's own price, never a sum.
  it('Emmaboda shape: main 456 000 and tillägg 8 700 are one point, the main avtal\'s own price', () => {
    const main = tieto('0114', { annual_value_sek: 456000, summary: 'Avtal om Edlevo.' });
    const add = tieto('0114', { annual_value_sek: 8700, period_start: '2025-06-01', period_end: null, summary: 'Tilläggsavtal om Edlevo-moduler för gymnasiet och vux.' });
    const facts = build([main, add], { coverage: [...covFor(main.contract_id, 'Edlevo', ALL), ...covFor(add.contract_id, 'Edlevo', ['Gymnasiet', 'Komvux'])] });
    expect(row(facts, main.contract_id).kr_per_elev).toBeCloseTo(456000 / ELEVER_ALL, 2);
    expect(row(facts, add.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: 'tillagg' });
    const d = priceDistribution(facts, { productSlug: 'edlevo' });
    expect(d.n).toBe(1);
    const t = text(renderKommun({ kod: '0114', stats, facts, statusMap: done(['0114']), today: TODAY }));
    expect(t).toContain('228 kr per elev och år, ert pris');
    expect(t).not.toMatch(/\b4,4 kr per elev/); // 8 700 over the 2 000 elever is never shown as a price
    expect(t).toContain('tilläggsavtal, inget eget pris per elev');
  });

  it('a main avtal with no school forms leaves the kommun without a price: the tillägg does not stand in', () => {
    const main = tieto('0114', { annual_value_sek: 456000 });
    const add = tieto('0114', { annual_value_sek: 8700, period_start: '2025-06-01', period_end: null });
    const facts = build([main, add], { coverage: covFor(add.contract_id, 'Edlevo', ['Gymnasiet', 'Komvux']) });
    expect(facts.filter((f) => f.kr_per_elev != null)).toHaveLength(0);
    expect(row(facts, add.contract_id).kr_per_elev_basis).toBe('annat_avtal');
    const t = text(renderKommun({ kod: '0114', stats, facts, statusMap: done(['0114']), today: TODAY }));
    expect(t).not.toContain('ert pris');
  });

  it('a lone tilläggsavtal has no price, by value per elev or by a stated styckpris (r5 Y1)', () => {
    const lone = tieto('0115', { annual_value_sek: 30000, summary: 'Tilläggsavtal mellan kommunen och Tieto om modulen ersättningshantering.' });
    const sty = C({ vendor_name: 'SchoolSoft AB', kommun_kod: '0115', annual_value_sek: 48000, pricing_model: 'per_student', products: ['SchoolSoft'], summary: 'Tilläggsavtal om tjänsten, 48 kr per elev.' });
    const facts = build([lone, sty], {
      coverage: [...covFor(lone.contract_id, 'Edlevo', ALL), ...covFor(sty.contract_id, 'SchoolSoft', ALL)],
      lineItems: [{ contract_id: sty.contract_id, product_name: 'SchoolSoft', amount_sek: null, unit_price_sek: 48, unit: 'elev', quantity: null, period_months: 12 }],
    });
    expect(row(facts, lone.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: 'tillagg' });
    expect(row(facts, sty.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: 'tillagg' });
  });

  it('the Edlevo median is not pulled down by module tillägg', () => {
    // Five kommuner pay 200 kr per elev (400 000 over 2 000 elever); two of
    // them also hold a small module tillägg, a sixth holds only a tillägg.
    // Distinct summaries: the same summary text would make them one
    // samverkansavtal (W4).
    const mains = ['0114', '0115', '0117', '0120', '0123'].map((k) => tieto(k, { annual_value_sek: 400000, summary: `Avtal om Edlevo för ${k}.` }));
    const adds = [
      tieto('0114', { annual_value_sek: 6000, period_start: '2025-03-01', period_end: null, summary: 'Tilläggsavtal om en Edlevo-modul.' }),
      tieto('0115', { annual_value_sek: 9000, period_start: '2025-03-01', period_end: null, summary: 'Tilläggsavtal om en Edlevo-modul.' }),
      tieto('0125', { annual_value_sek: 12000, summary: 'Samling av tilläggsavtal avseende Edlevo-moduler.' }),
    ];
    const all = [...mains, ...adds];
    const facts = build(all, { coverage: all.flatMap((c) => covFor(c.contract_id, 'Edlevo', ALL)) });
    const d = priceDistribution(facts, { productSlug: 'edlevo' });
    expect(d.n).toBe(5);
    expect(d.median).toBe(200);
    expect(d.min).toBe(200);
    expect(d.values.map((v) => v.kommun_kod)).not.toContain('0125');
  });

  it('two avtal for different grades: the larger avtal\'s own price is the point (r5 V1)', () => {
    const a = C({ vendor_name: 'ILT Education AB', kommun_kod: '0117', annual_value_sek: 60000, products: ['Polylino'] });
    const b = C({ vendor_name: 'ILT Education AB', kommun_kod: '0117', annual_value_sek: 30000, period_start: '2025-02-01', products: ['Polylino'] });
    const facts = build([a, b], { coverage: [...covFor(a.contract_id, 'Polylino', ['1-3']), ...covFor(b.contract_id, 'Polylino', ['4-6'])] });
    expect(row(facts, a.contract_id).kr_per_elev).toBe(200); // 60 000 over the 300 elever in 1-3
    expect(row(facts, b.contract_id)).toMatchObject({ kr_per_elev: null, kr_per_elev_basis: 'annat_avtal' });
  });
});

// ------------------------------------------------------------------ W3, X1
describe('W3 and X1. a samverkansavtal on Förnyelser is the whole avtal, status samverkan', () => {
  const mk = (kod, namn, o = {}) => C({ vendor_name: 'Tempus', kommun_kod: kod, kommun_namn: namn, annual_value_sek: 177000, period_start: '2023-08-01', period_end: '2027-07-19', products: ['Tempus Barn'], size_bytes: 424242, ...o });
  const facts = build([mk('0114', 'Testby 1'), mk('0115', 'Testby 2')]);

  it('both member rows show the whole value, never "känt" for one member, and list the kommuner we hold copies from', () => {
    const rows = renewalRows({ facts, stats, today: TODAY });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ value: 177000, valuePartial: false, joint: { members: ['Testby 1', 'Testby 2'] } });
    const lines = renewalsCsv(rows).trim().split('\r\n');
    expect(lines[0].endsWith(';Samverkansavtal, kopior från')).toBe(true);
    // r5 V6: the value is on the first copy only, so a SUM counts it once.
    expect(lines[1]).toContain(';177000;samverkan;');
    expect(lines[2]).toContain(';;samverkan, se Testby 1;');
    for (const l of lines.slice(1)) {
      expect(l).not.toContain(';känt;');
      expect(l.endsWith(';Testby 1, Testby 2')).toBe(true);
    }
  });

  it('the page counts the whole value once and labels each row', () => {
    const t = text(renderFornyelser({ facts, stats, today: TODAY }));
    expect(t).toContain('Känt årsvärde 177 tkr');
    expect(t).toContain('hela avtalet, samverkansavtal, kopior från Testby 1, Testby 2, andel okänd');
  });

  it('the kommun page says kopior från N kommuner, not N kommuner', () => {
    const t = text(renderKommun({ kod: '0114', stats, facts, statusMap: done(['0114', '0115']), today: TODAY }));
    expect(t).toContain('samverkansavtal, kopior från 2 kommuner, andel okänd');
    expect(t).not.toMatch(/samverkansavtal \(2 kommuner\)/);
  });
});

// ------------------------------------------------------------------ W4
describe('W4. a samverkansavtal needs document evidence, not equal list prices', () => {
  const binogi = (kod, namn, o = {}) => C({ vendor_name: 'Binogi AB', kommun_kod: kod, kommun_namn: namn, annual_value_sek: 100000, period_start: '2025-08-01', period_end: '2027-07-31', products: ['Binogi'], ...o });

  it('two independent 100 000 kr Binogi avtal in Upplands Väsby and Vallentuna stay two avtal', () => {
    const a = binogi('0114', 'Upplands Väsby', { size_bytes: 210000, filename: 'avtal-binogi.pdf', summary: 'Avtal mellan Upplands Väsby kommun och Binogi.' });
    const b = binogi('0115', 'Vallentuna', { size_bytes: 199000, filename: 'Binogi licens.pdf', summary: 'Avtal mellan Vallentuna kommun och Binogi.' });
    const facts = build([a, b]);
    expect(facts.every((f) => f.joint == null)).toBe(true);
    expect(marketByCategory(facts).find((m) => m.category === 'laromedel')).toMatchObject({ n_avtal: 2, value_known_sek: 200000 });
  });

  it('the same document (equal size, with or without the same file name, or the same summary) is one avtal', () => {
    for (const ev of [{ size_bytes: 333 }, { filename: 'Samverkan.pdf', size_bytes: 334 }, { summary: 'Gemensamt avtal för två kommuner.' }]) {
      const facts = build([binogi('0114', 'Upplands Väsby', ev), binogi('0115', 'Vallentuna', ev)]);
      expect(marketByCategory(facts).find((m) => m.category === 'laromedel')).toMatchObject({ n_avtal: 1, value_known_sek: 100000 });
    }
  });

  it('a summary naming the other kommun is evidence too (the GGVV shape)', () => {
    const a = binogi('0114', 'Upplands Väsby', { summary: 'Avtal för Upplands Väsby och Vallentuna med Binogi.' });
    const b = binogi('0115', 'Vallentuna', { summary: 'Avtal mellan Vallentuna kommun och Binogi.' });
    expect(build([a, b]).every((f) => f.joint)).toBe(true);
    expect(namesOther({ summary: 'Avtal för Vallentunas skolor', kommun: 'x' }, { kommun: 'vallentuna' })).toBe(true);
    expect(namesOther({ summary: 'Avtal för Vallentunavägen', kommun: 'x' }, { kommun: 'vallentuna' })).toBe(false);
    expect(sameDocument({ size: null, name: null, summary: null }, { size: null, name: null, summary: null })).toBe(false);
  });

  it('no filename or summary reaches the facts', () => {
    const facts = build([binogi('0114', 'Upplands Väsby', { filename: 'Hemligt namn.pdf', summary: 'Text', size_bytes: 1 })]);
    expect(JSON.stringify(facts)).not.toMatch(/Hemligt namn|"_doc"|"summary"/);
  });
});

// ------------------------------------------------------------------ W5
describe('W5. the value of a samverkansavtal stays on an active, non-superseded copy', () => {
  const ist = (kod, o = {}) => C({ vendor_name: 'IST', kommun_kod: kod, annual_value_sek: 100000, period_start: '2023-01-01', period_end: '2028-12-31', products: ['IST Administration'], size_bytes: 5555, ...o });

  it('when the lowest-id copy is replaced in its kommun, the other copy carries the value', () => {
    const a = ist('0114'); const b = ist('0115');
    // 0114 re-signs the same avtal on its own at the same value.
    const renew = ist('0114', { period_start: '2025-01-01', period_end: '2030-12-31', size_bytes: 9999 });
    const facts = build([a, b, renew]);
    expect(row(facts, a.contract_id)).toMatchObject({ superseded: true, annual_value_sek: null, joint: { counted_here: false } });
    expect(row(facts, b.contract_id)).toMatchObject({ superseded: false, annual_value_sek: 100000, joint: { counted_here: true } });
    const sk = companyShares(facts, { category: 'skoladministration' }).find((s) => s.slug === 'ist');
    expect(sk.value_known_sek).toBe(200000); // the joint avtal once, plus 0114's own renewal
  });

  it('when no copy is active, no copy carries the value', () => {
    const a = ist('0114', { period_start: '2018-01-01', period_end: '2021-12-31' });
    const b = ist('0115', { period_start: '2018-01-01', period_end: '2021-12-31' });
    const facts = build([a, b]);
    expect(facts.every((f) => f.joint && f.joint.counted_here === false && f.annual_value_sek == null)).toBe(true);
  });
});

// ------------------------------------------------------------------ X2
describe('X2. summary keywords start at a word; stödverktyg words are the ones summaries use', () => {
  const ev = (summary) => underlagEvidence({ documents: [{ kommun_kod: '0114', vendor_name: null, summary, products: [], lines: [] }] }).docs.get('0114');

  it('"sekretessbedömning" is not prov, "bedömningsstöd" is', () => {
    expect(ev('Sekretessbedömning av handlingar.').categories.has('prov')).toBe(false);
    expect(ev('Prislista för ett bedömningsstöd.').categories.has('prov')).toBe(true);
  });

  it('bildstöd and a catalogue product name point to stödverktyg, the name also to its company', () => {
    expect(ev('Tjänst för bildstödsmaterial.').categories.has('stodverktyg')).toBe(true);
    const w = ev('Orderhistorik: Widgit Online och LexiFlow per skola.');
    expect(w.categories.has('stodverktyg')).toBe(true);
    expect(w.companies.has('symbolbruket')).toBe(true);
  });

  it('a sammanställning naming Trelson points to prov and to Trelson', () => {
    const t = ev('Avtalslista: Trelson / Provplattform.');
    expect(t.categories.has('prov')).toBe(true);
    expect(t.companies.has('trelson')).toBe(true);
  });
});
