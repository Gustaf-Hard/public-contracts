// Purchase and licence lists (2026-10-27): order histories, licence overviews
// and cost compilations that kommuner send instead of, or beside, avtal. All
// fixtures are hand-written and synthetic: no real kommun data.
import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  channelFrom, isPurchaseListCandidate, parseSchoolYear, schoolYearEnd, licenceMonths, parseDate, parseAmount,
  mapHeaderRow, extractXlsxPurchases, looksLikePurchaseList, normalisePurchaseRow, classifyPurchaseRow,
  PURCHASE_SCHEMA, countUnionParams, extractPurchasesWithLlm, extractPurchases, rowsFromLlm,
} from '../src/purchase-list.js';

const sheet = (rows, name = 'Blad1') => ({ name, rows, rowNumbers: rows.map((_, i) => i + 1) });

describe('document detection', () => {
  it('only non-avtal compilations are candidates', () => {
    expect(isPurchaseListCandidate({ document_type: 'följebrev_sammanställning', is_contract: 0 })).toBe(true);
    expect(isPurchaseListCandidate({ document_type: 'prislista', is_contract: 0 })).toBe(true);
    expect(isPurchaseListCandidate({ document_type: 'övrigt', is_contract: 0 })).toBe(true);
    expect(isPurchaseListCandidate({ document_type: 'avtal', is_contract: 1 })).toBe(false);
    expect(isPurchaseListCandidate({ document_type: 'följebrev_sammanställning', is_contract: 1 })).toBe(false);
    expect(isPurchaseListCandidate({ document_type: 'personuppgiftsbiträdesavtal', is_contract: 0 })).toBe(false);
    expect(isPurchaseListCandidate({ document_type: 'sekretessbeslut', is_contract: 0 })).toBe(false);
  });

  it('content must look like rows of product with an amount, quantity or date', () => {
    const rich = [{ product: 'A', amount_sek: 10 }, { product: 'B', quantity: 2 }];
    expect(looksLikePurchaseList(rich)).toBe(true);
    expect(looksLikePurchaseList([{ product: 'A', amount_sek: 10 }])).toBe(false);
    expect(looksLikePurchaseList([{ product: 'A' }, { product: 'B' }])).toBe(false);
    expect(looksLikePurchaseList([{ supplier: 'X', amount_sek: 1 }, { supplier: 'Y', amount_sek: 2 }])).toBe(true);
  });
});

describe('field parsers', () => {
  it('channel from text or filename', () => {
    expect(channelFrom('Inköpt via Skolon 2024')).toBe('skolon');
    expect(channelFrom('lista.xlsx', 'ATEA-licenser.pdf')).toBe('atea');
    expect(channelFrom('Exempel - via läromedia.xlsx')).toBe('laromedia');
    expect(channelFrom('LäroMedia Bokhandel')).toBe('laromedia');
    expect(channelFrom('Avtalslista 2026')).toBeNull();
    expect(channelFrom(null)).toBeNull();
  });

  it('school year in its many spellings', () => {
    expect(parseSchoolYear('Läromedel läsår 25/26')).toBe('2025/26');
    expect(parseSchoolYear('läsår 2025/2026')).toBe('2025/26');
    expect(parseSchoolYear('2023-24')).toBe('2023/24');
    expect(parseSchoolYear('Order 23-24.xlsx')).toBe('2023/24');
    expect(parseSchoolYear('läsåret 2024-2025')).toBe('2024/25');
    expect(parseSchoolYear('Exempel-läsår-2526.pdf')).toBe('2025/26');
    // Not consecutive years, or a plain date range: not a school year.
    expect(parseSchoolYear('2025-01-01 till 2026-12-31')).toBeNull();
    expect(parseSchoolYear('23-26')).toBeNull();
    expect(parseSchoolYear('Licenser 2026')).toBeNull();
    expect(schoolYearEnd('2025/26')).toBe('2026-06-30');
    expect(schoolYearEnd(null)).toBeNull();
  });

  it('licence length stated in the product text', () => {
    expect(licenceMonths('Singellicens 12 mån för Exempel')).toBe(12);
    expect(licenceMonths('Singellicens 365 dagar för Exempel')).toBe(12);
    expect(licenceMonths('Klasslicens 1 år (max 35 användare)')).toBe(12);
    expect(licenceMonths('Huvudmanslicens 12 månader max Exempel')).toBe(12);
    expect(licenceMonths('Singellicens 18 mån (max 1 lärare)')).toBe(18);
    expect(licenceMonths('Abonnemang 3 år')).toBe(36);
    expect(licenceMonths('Exempel åk 4-6')).toBeNull();
    expect(licenceMonths(null)).toBeNull();
  });

  it('dates: ISO, compact order dates, and Excel serials only where asked', () => {
    expect(parseDate('2025-03-04')).toBe('2025-03-04');
    expect(parseDate('230301')).toBe('2023-03-01');
    expect(parseDate('20250108')).toBe('2025-01-08');
    expect(parseDate(230301)).toBe('2023-03-01');
    expect(parseDate(45658.08, { serial: true })).toBe('2025-01-01');
    expect(parseDate(45658)).toBeNull();
    expect(parseDate('202601')).toBeNull();
    expect(parseDate('991340')).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('amounts in Swedish notation, never a bare word', () => {
    expect(parseAmount('1 234 567,89 kr')).toBe(1234567.89);
    expect(parseAmount('19 729 kr')).toBe(19729);
    expect(parseAmount(950)).toBe(950);
    expect(parseAmount('-1 200,50')).toBe(-1200.5);
    expect(parseAmount('per år')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});

describe('header mapping', () => {
  it('recognises an order-history header', () => {
    const m = mapHeaderRow(['År', 'Ordernr', 'Rad', 'Artikel', 'Benämning', 'Lev namn', 'Regdatum', 'Beställt antal', 'Levererat antal', 'Fakt.belopp', 'Pris/st']);
    expect(m.columns).toMatchObject({ order_ref: 1, line: 2, product: 4, supplier: 5, order_date: 6, quantity: 7, amount: 9, unit_price: 10 });
    expect(m.recognised).toBe(true);
  });

  it('prefers the annual cost over a start-up cost, and reads a contract-term column', () => {
    const m = mapHeaderRow(['Leverantör', 'Produkt/Projekt', 'Avtalstid /avtal', 'Uppstartskostnad', 'Tot årskostnad', 'Kommentar']);
    expect(m.columns).toMatchObject({ supplier: 0, product: 1, period_text: 2, amount: 4 });
  });

  it('reads a ledger: supplier text column, amount and voucher date', () => {
    const m = mapHeaderRow(['Verifikationsnr', 'Verifikationsdatum', 'Konto (T)', 'Belopp', 'LEV.NR', 'LEV.NR (T)', 'Beskrivning']);
    expect(m.columns).toMatchObject({ order_ref: 0, order_date: 1, amount: 3, supplier: 5, product: 6 });
  });

  it('a row of labels without a product or supplier is not a table header', () => {
    expect(mapHeaderRow(['client', 'user_id']).recognised).toBe(false);
    expect(mapHeaderRow(['Produkt', 'Kommentar']).recognised).toBe(false);
  });
});

describe('extractXlsxPurchases', () => {
  const orderSheet = sheet([
    ['År', '2023-24'],
    ['Lev namn', 'exempelkanal*'],
    ['År', 'Ordernr', 'Rad', 'Benämning', 'Lev namn', 'Regdatum', 'Beställt antal', 'Fakt.belopp', 'Pris/st'],
    [2023, 'ORD-0001', '001', 'Singellicens 12 mån för Exempelverktyg', 'Skolon AB', '230301', 1, 0, 400],
    [2023, 'ORD-0002', '001', 'Singellicens 12 mån för Binogi', 'Skolon AB', '230901', 2, 1000, 500],
    [null, null, null, null, null, null, 0, 0, 0],
  ]);

  it('maps an order history row by row, deterministically', () => {
    const out = extractXlsxPurchases([orderSheet], { filename: 'Exempel 23-24.xlsx' });
    expect(out.recognised).toBe(true);
    expect(out.rows).toHaveLength(2);
    const [a, b] = out.rows;
    expect(a).toMatchObject({
      supplier: 'Skolon AB', product: 'Singellicens 12 mån för Exempelverktyg', channel: 'skolon',
      quantity: 1, unit_price_sek: 400, order_date: '2023-03-01', order_ref: 'ORD-0001/001',
      period_start: '2023-03-01', period_end: '2024-03-01', school_year: '2023/24',
    });
    // A zero invoiced amount beside a real unit price is "not invoiced", not 0 kr.
    expect(a.amount_sek).toBeNull();
    expect(b.amount_sek).toBe(1000);
    expect(out.stated_total_sek).toBeNull();
  });

  it('takes the stated total from a total row and never sums rows into one', () => {
    const s = sheet([
      ['Leverantör', 'Produkt', 'Årskostnad'],
      ['Binogi', 'Binogi', 1000],
      ['Gleerups', 'Gleerups digitala läromedel 4-6', 2000],
      ['Totalt', null, 5000],
    ]);
    const out = extractXlsxPurchases([s], { filename: 'x.xlsx' });
    expect(out.rows.map((r) => r.supplier)).toEqual(['Binogi', 'Gleerups']);
    expect(out.stated_total_sek).toBe(5000);
    expect(out.rows[1].grades).toEqual(['4-6']);
  });

  it('reads a total stated on another tab, and skips footnotes under the table', () => {
    const t = sheet([['Leverantör', 'Belopp'], ['Exempel AB', 10], ['Annan AB', 20], ['* Avrop via ramavtal', null]]);
    const pivot = sheet([['Radetiketter', 'Utfall'], ['Exempel AB', 10], ['Totalsumma', 30]], 'Pivot');
    const out = extractXlsxPurchases([pivot, t], { filename: 'x.xlsx' });
    expect(out.rows.map((r) => r.supplier)).toEqual(['Exempel AB', 'Annan AB']);
    expect(out.stated_total_sek).toBe(30);
  });

  it('fills a blank supplier down from the row above (merged cells), never across a blank product', () => {
    const s = sheet([
      ['Leverantör', 'Produkt/Projekt', 'Avtalstid', 'Tot årskostnad'],
      ['Binogi', 'Binogi år 1', '2025-01-01 till 2026-12-31', 100],
      [null, 'Binogi år 2', null, 200],
      [null, null, null, null, 'anteckning'],
      ['Gleerups', 'Exempel', 'per år', 300],
    ]);
    const out = extractXlsxPurchases([s], { filename: 'x.xlsx' });
    expect(out.rows.map((r) => [r.supplier, r.product])).toEqual([['Binogi', 'Binogi år 1'], ['Binogi', 'Binogi år 2'], ['Gleerups', 'Exempel']]);
    expect(out.rows[0]).toMatchObject({ period_start: '2025-01-01', period_end: '2026-12-31' });
    expect(out.rows[2].period_end).toBeNull();
  });

  it('reads Excel serial dates in a date column even without a date style', () => {
    const s = sheet([
      ['Orderdatum', 'Kundnamn', 'Titel'],
      [45658.08, 'Exempelskolan', 'Exempelbok digital elevlicens 12 mån'],
      [45659.08, 'Exempelskolan', 'Abonnemang Polylino Skola'],
    ]);
    const out = extractXlsxPurchases([s], { filename: 'Licenser via Läromedia.xlsx' });
    expect(out.recognised).toBe(true);
    expect(out.rows[0]).toMatchObject({ order_date: '2025-01-01', channel: 'laromedia', period_end: '2026-01-01' });
    expect(out.rows[1].period_end).toBeNull();
  });

  it('drops a later sheet\'s repeat of a row already read from an earlier sheet', () => {
    const a = sheet([['Leverantör', 'Produkt', 'Årskostnad'], ['Binogi', 'Binogi', 100], ['Gleerups', 'Exempel', 50]], 'Blad1');
    const b = sheet([['Leverantör', 'Produkt', 'Årskostnad'], ['Binogi ', 'Binogi', 120], ['Widgit', 'Widgit Online', 70]], 'Blad2');
    const out = extractXlsxPurchases([a, b], { filename: 'x.xlsx' });
    expect(out.rows.map((r) => r.product)).toEqual(['Binogi', 'Exempel', 'Widgit Online']);
  });

  it('says unrecognised when no sheet has a usable header', () => {
    const out = extractXlsxPurchases([sheet([['Radetiketter', 'Utfall'], ['Exempel AB', 100]])], { filename: 'x.xlsx' });
    expect(out.recognised).toBe(false);
    expect(out.rows).toEqual([]);
  });

  it('end to end from a real zip built in the test', async () => {
    const { xlsxSheetsFromBuffer } = await import('../src/office-text.js');
    const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
    const rows = [['Leverantör', 'Produkt', 'Antal', 'Belopp'], ['Binogi', 'Binogi åk 4-6 elevlicens', 120, 6000], ['Exempel AB', 'Exempelverktyg', 3, 900]];
    const xml = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('');
    const buf = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${xml}</sheetData></worksheet>`) }));
    const out = extractXlsxPurchases(xlsxSheetsFromBuffer(buf, 'lista.xlsx'), { filename: 'lista.xlsx' });
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ supplier: 'Binogi', quantity: 120, amount_sek: 6000, grades: ['4-6'] });
  });
});

describe('classifyPurchaseRow', () => {
  it('a row bought through a channel belongs to the product owner, not the channel', () => {
    const c = classifyPurchaseRow({ supplier: 'Skolon AB', product: 'Huvudmanslicens 1 år Binogi', channel: null });
    expect(c).toMatchObject({ company_slug: 'binogi', product_slug: 'binogi', channel_slug: 'skolon', category: 'laromedel' });
  });

  it('an unknown title through a channel has no owner rather than the channel\'s own product', () => {
    const c = classifyPurchaseRow({ supplier: 'Skolon AB', product: 'Singellicens 12 mån för Exempelverktyg' });
    expect(c.company_slug).toBeNull();
    expect(c.product_slug).toBeNull();
    expect(c.channel_slug).toBe('skolon');
  });

  it('a supplier-only row is the supplier\'s, and a supplier name can name the product', () => {
    expect(classifyPurchaseRow({ supplier: 'Gleerups Utbildning AB', product: null })).toMatchObject({ company_slug: 'gleerups', product_slug: null });
    expect(classifyPurchaseRow({ supplier: 'Exempel AB/ Matteappen Magma', product: null })).toMatchObject({ company_slug: 'radish', product_slug: 'magma' });
  });

  it('the channel\'s own product stays the channel\'s', () => {
    expect(classifyPurchaseRow({ supplier: 'Skolon AB', product: 'Skolon e-läromedelsplattform Skolon Total' })).toMatchObject({ company_slug: 'skolon', product_slug: 'skolon' });
  });
});

describe('normalisePurchaseRow', () => {
  it('derives school year end as licensperiod only when no period end is stated', () => {
    const r = normalisePurchaseRow({ product: 'Exempel', school_year: '2025/26' }, {});
    expect(r.period_end).toBeNull();
    expect(r.school_year).toBe('2025/26');
  });
  it('drops a row with neither supplier nor product, and junk numbers', () => {
    expect(normalisePurchaseRow({ supplier: '', product: '  ' }, {})).toBeNull();
    const r = normalisePurchaseRow({ product: 'X', quantity: -3, amount_sek: 'abc', grades: ['F-3', 'Gymnasiet', 'nonsense'] }, {});
    expect(r.quantity).toBeNull();
    expect(r.amount_sek).toBeNull();
    expect(r.grades).toEqual(['Förskoleklass', '1-3', 'Gymnasiet']);
  });
});

describe('LLM path', () => {
  it('keeps the schema well under the 16 union-parameter limit', () => {
    expect(countUnionParams(PURCHASE_SCHEMA)).toBeLessThanOrEqual(8);
  });

  it('converts the structured answer to rows with the document context', () => {
    const out = rowsFromLlm({
      is_purchase_list: true, channel: 'skolon', school_year: '2025/26', period_start: null, period_end: null, stated_total_sek: 5000,
      rows: [
        { supplier: 'Binogi Sverige AB', product: '', quantity: 0, unit: '', amount_sek: 4000, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' },
        { supplier: 'Exempel AB', product: 'Exempelverktyg åk 1-3', quantity: 30, unit: 'elev', amount_sek: null, period_start: '2025-08-01', period_end: '2026-07-31', school_year: '', grades: [], order_ref: 'A-1' },
      ],
    }, { filename: 'x.pdf' });
    expect(out.stated_total_sek).toBe(5000);
    expect(out.rows[0]).toMatchObject({ supplier: 'Binogi Sverige AB', product: null, quantity: null, amount_sek: 4000, channel: 'skolon', school_year: '2025/26' });
    expect(out.rows[1]).toMatchObject({ quantity: 30, unit: 'elev', period_end: '2026-07-31', grades: ['1-3'], order_ref: 'A-1' });
  });

  it('never copies the document\'s order window onto the rows as a licensperiod', () => {
    const out = rowsFromLlm({
      is_purchase_list: true, channel: 'skolon', school_year: null, period_start: '2025-01-01', period_end: '2026-12-31', stated_total_sek: null,
      rows: [{ supplier: 'Binogi Sverige AB', product: 'Huvudmanslicens 1 år Binogi', quantity: 0, unit: '', amount_sek: 10, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' }],
    }, { filename: 'x.pdf' });
    expect(out.rows[0].period_end).toBeNull();
    expect(out.rows[0].period_start).toBeNull();
  });

  it('sends a PDF as a document block with the schema, and reports failures through onFailure', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: true, channel: null, school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows: [] }) }] }));
    const client = { messages: { create } };
    const out = await extractPurchasesWithLlm({ pdf: Buffer.from('%PDF-1.4'), ctx: { kommun_namn: 'Exempelby', filename: 'x.pdf' }, client });
    expect(out.is_purchase_list).toBe(true);
    const req = create.mock.calls[0][0];
    expect(req.messages[0].content[0].type).toBe('document');
    expect(req.output_config.format.schema).toBe(PURCHASE_SCHEMA);

    const failing = { messages: { create: vi.fn(async () => { const e = new Error('rate'); e.status = 429; throw e; }) } };
    const onFailure = vi.fn();
    expect(await extractPurchasesWithLlm({ pdf: Buffer.from('%PDF'), ctx: { filename: 'x.pdf' }, client: failing, onFailure })).toBeNull();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ backoff: true });
  });

  it('returns null without calling anything when no client or key is configured', async () => {
    expect(await extractPurchasesWithLlm({ pdf: Buffer.from('%PDF'), ctx: {}, env: {} })).toBeNull();
  });
});

describe('extractPurchases dispatcher', () => {
  const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const xbuf = (rows) => Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`) }));

  it('a recognisable xlsx never reaches the LLM', async () => {
    const create = vi.fn();
    const out = await extractPurchases({ buffer: xbuf([['Leverantör', 'Produkt', 'Belopp'], ['Binogi', 'Binogi', 10], ['Exempel AB', 'Exempel', 20]]), filename: 'a.xlsx' }, { client: { messages: { create } } });
    expect(out.method).toBe('xlsx');
    expect(out.rows).toHaveLength(2);
    expect(create).not.toHaveBeenCalled();
  });

  it('an unrecognisable xlsx falls back to the LLM over its text', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: true, channel: null, school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows: [{ supplier: 'Exempel AB', product: '', quantity: 0, unit: '', amount_sek: 100, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' }, { supplier: 'Annan AB', product: '', quantity: 0, unit: '', amount_sek: 50, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' }] }) }] }));
    const out = await extractPurchases({ buffer: xbuf([['Radetiketter', 'Utfall'], ['Exempel AB', 100], ['Annan AB', 50]]), filename: 'b.xlsx' }, { client: { messages: { create } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].messages[0].content[0].type).toBe('text');
    expect(out.method).toBe('llm');
    expect(out.rows).toHaveLength(2);
  });

  it('a document the LLM says is not a purchase list yields no rows', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: false, channel: null, school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows: [{ supplier: 'X', product: 'Y', quantity: 1, unit: '', amount_sek: 1, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' }] }) }] }));
    const out = await extractPurchases({ buffer: Buffer.from('%PDF-1.4'), filename: 'c.pdf' }, { client: { messages: { create } } });
    expect(out).toMatchObject({ method: 'llm', is_list: false, rows: [] });
  });
});
