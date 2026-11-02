// Fix wave 2 (2026-10-29), E1 E5 E6: the xlsx path writes rows only for a
// document it positively recognises as a purchase or licence list. Supplier
// ledgers and avtal registers are skipped, an oversized table is skipped, a
// workbook with unread data sheets is partial, and a truncated text never
// reaches the LLM. Hand-written, synthetic fixtures only.
import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { judgeXlsx, extractPurchases, PURCHASE_ROW_CAP, PURCHASE_TEXT_MAX } from '../src/purchase-list.js';

const sheet = (rows, name = 'Blad1') => ({ name, rows, rowNumbers: rows.map((_, i) => i + 1) });
const LIST = [['Leverantör', 'Produkt', 'Belopp'], ['Binogi', 'Binogi', 100], ['Exempel AB', 'Exempel', 50]];

describe('judgeXlsx: positive recognition', () => {
  it('a channel in the filename, a sheet name or a header makes a list', () => {
    expect(judgeXlsx([sheet(LIST)], { filename: 'Skolon 2025.xlsx' }).verdict).toBe('rows');
    expect(judgeXlsx([sheet(LIST, 'Atea-köp')], { filename: 'x.xlsx' }).verdict).toBe('rows');
    expect(judgeXlsx([sheet([['Inköpt via Läromedia'], ...LIST])], { filename: 'x.xlsx' }).verdict).toBe('rows');
  });

  it('licence or order columns make a list', () => {
    expect(judgeXlsx([sheet([['Leverantör', 'Produkt', 'Antal', 'Belopp'], ['Binogi', 'Binogi', 10, 100], ['Exempel AB', 'Exempel', 2, 50]])], { filename: 'x.xlsx' }).verdict).toBe('rows');
    expect(judgeXlsx([sheet([['Ordernummer', 'Leverantör', 'Belopp'], ['EX-1', 'Binogi', 100], ['EX-2', 'Exempel AB', 50]])], { filename: 'x.xlsx' }).verdict).toBe('rows');
    expect(judgeXlsx([sheet([['Leverantör', 'Produkt', 'Licensperiod'], ['Binogi', 'Binogi', '2025-08-01 till 2026-07-31'], ['Exempel AB', 'Exempel', '2025-08-01 till 2026-07-31']])], { filename: 'x.xlsx' }).verdict).toBe('rows');
  });

  it('a table with no such signal is not written: the LLM judges it', () => {
    const j = judgeXlsx([sheet(LIST)], { filename: 'Sammanställning.xlsx' });
    expect(j.verdict).toBe('llm');
  });
});

describe('judgeXlsx: rejected documents', () => {
  it('a supplier ledger is skipped, by name or by its columns', () => {
    const ledger = [['Leverantörsnamn', 'Leverantörens fakturanr', 'Fakturadatum', 'Fakturabelopp'], ['Exempel El AB', 'F-1', '2025-09-01', 500], ['Exempel Bygg AB', 'F-2', '2025-09-02', 900]];
    expect(judgeXlsx([sheet(ledger)], { filename: 'Levreskontra 2025.xlsx' })).toMatchObject({ verdict: 'skip' });
    expect(judgeXlsx([sheet(ledger)], { filename: 'Fakturor.xlsx' }).verdict).toBe('skip');
    const vouchers = [['Verifikationsnr', 'Verifikationsdatum', 'Belopp', 'LEV.NR (T)', 'Beskrivning'], ['V1', '2025-01-02', 10, 'Exempel AB', 'x'], ['V2', '2025-01-03', 20, 'Annan AB', 'y']];
    expect(judgeXlsx([sheet(vouchers)], { filename: 'Licenser 2026.xlsx' }).verdict).toBe('skip');
  });

  it('an avtal register is skipped, by name or by an "Avtalsnamn" column', () => {
    const reg = [['Avtalsnamn', 'Leverantörsnamn', 'Slutdatum'], ['Exempelavtal', 'Exempel AB', '2027-01-01'], ['Annat avtal', 'Annan AB', '2028-01-01']];
    expect(judgeXlsx([sheet(reg)], { filename: 'Lista avtalskatalog.xlsx' }).verdict).toBe('skip');
    expect(judgeXlsx([sheet(reg)], { filename: 'Skolon export.xlsx' }).verdict).toBe('skip');
    expect(judgeXlsx([sheet(LIST)], { filename: 'Avtalsregister 2026.xlsx' }).verdict).toBe('skip');
  });

  it(`a table over ${PURCHASE_ROW_CAP} rows with no channel or licence signal is not a purchase list`, () => {
    expect(PURCHASE_ROW_CAP).toBe(2000);
    const big = [['Leverantör', 'Produkt', 'Belopp'], ...Array.from({ length: PURCHASE_ROW_CAP + 1 }, (_, i) => [`Exempel ${i} AB`, `Vara ${i}`, i + 1])];
    const j = judgeXlsx([sheet(big)], { filename: 'Sammanställning.xlsx' });
    expect(j.verdict).toBe('skip');
    expect(j.reason).toMatch(/2000/);
  });
});

// Fix wave 3 Q7: the cap is checked before any extraction path, and a big
// list that IS a channel or licence list is recorded partial, not "not a list".
describe('judgeXlsx: the row cap (Q7)', () => {
  const many = (head, row) => [head, ...Array.from({ length: PURCHASE_ROW_CAP + 1 }, (_, i) => row(i))];

  it('a big channel list is partial, "för stor för automatisk läsning", with no rows', () => {
    const j = judgeXlsx([sheet(many(['Leverantör', 'Produkt', 'Antal', 'Belopp'], (i) => [`Exempel ${i} AB`, `Vara ${i}`, 1, i + 1]))], { filename: 'Skolon.xlsx' });
    expect(j.verdict).toBe('partial');
    expect(j.reason).toBe(`för stor för automatisk läsning (${PURCHASE_ROW_CAP + 2} rader)`);
    expect(j.rows).toEqual([]);
    expect(j.reason).not.toMatch(/inte en inköpslista/);
  });

  it('an unrecognised big workbook never reaches the LLM: skipped without a signal, partial with one', () => {
    const big = many(['Namn', 'Värde'], (i) => [`Exempel ${i}`, i]);
    const none = judgeXlsx([sheet(big)], { filename: 'Data.xlsx' });
    expect(none.verdict).toBe('skip');
    expect(none.reason).toMatch(/över 2000 rader/);
    const lic = judgeXlsx([sheet(big, 'Licenser')], { filename: 'Data.xlsx' });
    expect(lic.verdict).toBe('partial');
    expect(lic.reason).toMatch(/^för stor för automatisk läsning \(\d+ rader\)$/);
  });

  it('extractPurchases records an oversized document without calling the LLM', async () => {
    const create = vi.fn();
    const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
    const rows = many(['Namn', 'Värde'], (i) => [`Exempel ${i}`, i]);
    const buf = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'AB'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`) }));
    const skip = await extractPurchases({ buffer: buf, filename: 'Data.xlsx' }, { client: { messages: { create } } });
    expect(skip).toMatchObject({ method: 'xlsx', is_list: false, rows: [] });
    expect(skip.skipped).toMatch(/över 2000 rader/);
    const part = await extractPurchases({ buffer: buf, filename: 'Skolon export.xlsx' }, { client: { messages: { create } } });
    expect(part).toMatchObject({ method: 'xlsx', is_list: false, rows: [] });
    expect(part.too_large).toMatch(/^för stor för automatisk läsning/);
    expect(create).not.toHaveBeenCalled();
  });
});

// Fix wave 3 Q5: each sheet is judged on its own.
describe('judgeXlsx: each sheet on its own (Q5)', () => {
  const LEDGERISH = [['Leverantör', 'Belopp'], ['Exempel El AB', 500], ['Exempel Bygg AB', 900]];

  it('a sheet named as a ledger or register is rejected even beside a real licence sheet', () => {
    for (const name of ['Leverantörsreskontra', 'Verifikationer', 'Avtalsregister', 'Avtalskatalog', 'Fakturor']) {
      const j = judgeXlsx([sheet(LIST, 'Skolon'), sheet(LEDGERISH, name)], { filename: 'x.xlsx' });
      expect(j.verdict, name).toBe('rows');
      expect(j.rows.map((r) => r.supplier), name).toEqual(['Binogi', 'Exempel AB']);
      expect(j.partial, name).toEqual([name]);
    }
  });

  it('a sheet with no signal of its own is not read because another sheet has one', () => {
    const j = judgeXlsx([sheet(LIST, 'Skolon'), sheet([['Leverantör', 'Produkt', 'Belopp'], ['Annan AB', 'Annat', 70], ['Tredje AB', 'Tredje', 80]], 'Övrigt')], { filename: 'x.xlsx' });
    expect(j.verdict).toBe('rows');
    expect(j.rows.map((r) => r.supplier)).toEqual(['Binogi', 'Exempel AB']);
    expect(j.partial).toEqual(['Övrigt']);
  });

  it('a channel in the filename still vouches for every sheet', () => {
    const j = judgeXlsx([sheet(LIST, 'Köp'), sheet([['Leverantör', 'Produkt', 'Belopp'], ['Annan AB', 'Annat', 70], ['Tredje AB', 'Tredje', 80]], 'Mer')], { filename: 'Skolon 2025.xlsx' });
    expect(j.rows).toHaveLength(4);
    expect(j.partial).toEqual([]);
  });
});

describe('judgeXlsx: partial workbooks (E5)', () => {
  it('a recognised sheet beside an unread data sheet is partial, naming the skipped sheet', () => {
    const j = judgeXlsx([sheet(LIST, 'Köp'), sheet([['Radetiketter', 'Utfall'], ['Exempel AB', 10], ['Annan AB', 20]], 'Pivot')], { filename: 'Skolon.xlsx' });
    expect(j.verdict).toBe('rows');
    expect(j.partial).toEqual(['Pivot']);
    expect(j.rows).toHaveLength(2);
  });

  // Fix wave 3 Q6: one populated column is still data we did not read.
  it('a populated single-column sheet is unread data, so the workbook is partial', () => {
    const j = judgeXlsx([sheet(LIST, 'Köp'), sheet([['Produkt'], ['Polyglutt'], ['Unikum']], 'Licenser')], { filename: 'Skolon.xlsx' });
    expect(j.verdict).toBe('rows');
    expect(j.partial).toEqual(['Licenser']);
  });

  it('an empty or one-line extra sheet does not make it partial', () => {
    const j = judgeXlsx([sheet(LIST, 'Köp'), sheet([['Anteckning']], 'Info'), sheet([], 'Tom')], { filename: 'Skolon.xlsx' });
    expect(j.partial).toEqual([]);
  });
});

describe('extractPurchases with the judge', () => {
  const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const xbuf = (rows) => Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`) }));

  it('a rejected xlsx returns a skip and never calls the LLM', async () => {
    const create = vi.fn();
    const out = await extractPurchases({ buffer: xbuf([['Avtalsnamn', 'Leverantörsnamn', 'Slutdatum'], ['A', 'Exempel AB', '2027-01-01'], ['B', 'Annan AB', '2027-02-01']]), filename: 'avtal.xlsx' }, { client: { messages: { create } } });
    expect(out).toMatchObject({ method: 'xlsx', is_list: false, rows: [] });
    expect(out.skipped).toMatch(/avtalsregister/);
    expect(create).not.toHaveBeenCalled();
  });

  it(`E6: an office text over ${PURCHASE_TEXT_MAX} characters fails as truncated, before any LLM call`, async () => {
    const create = vi.fn();
    const onFailure = vi.fn();
    const words = Array.from({ length: 30000 }, (_, i) => `ord${i}`).join(' ');
    const docx = Buffer.from(zipSync({ 'word/document.xml': strToU8(`<w:document><w:body><w:p><w:r><w:t>${words}</w:t></w:r></w:p></w:body></w:document>`) }));
    expect(words.length).toBeGreaterThan(PURCHASE_TEXT_MAX);
    const out = await extractPurchases({ buffer: docx, filename: 'lista.docx' }, { client: { messages: { create } }, onFailure });
    expect(out).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ permanent: true, reason: 'permanent:truncated' });
  });
});

// Fix wave 4 R1: a rejected sheet never reaches any path. When the accepted
// sheets are too thin for the deterministic path, the LLM gets only the text
// of the sheets the judge did not reject.
describe('judgeXlsx: a rejected sheet never reaches the LLM (R1)', () => {
  const WEAK = [['Produkt', 'Antal'], ['Polyglutt', '30 st'], ['Unikum', 'obegränsat']];
  const LEDGER = [['Leverantör', 'Belopp'], ['Exempel Person', 500], ['Exempel Bygg AB', 900]];
  const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const sheetXml = (rows) => `<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const book = (named) => Buffer.from(zipSync({
    'xl/workbook.xml': strToU8(`<workbook><sheets>${named.map(([n], i) => `<sheet name="${n}" sheetId="${i + 1}"/>`).join('')}</sheets></workbook>`),
    ...Object.fromEntries(named.map(([, rows], i) => [`xl/worksheets/sheet${i + 1}.xml`, strToU8(sheetXml(rows))])),
  }));

  it('the judge hands the LLM only the non-rejected sheets and names the rejected one as partial', () => {
    const j = judgeXlsx([sheet(WEAK, 'Skolon'), sheet(LEDGER, 'Leverantörsreskontra')], { filename: 'licenser.xlsx' });
    expect(j.verdict).toBe('llm');
    expect(j.llm_sheets).toEqual(['Skolon']);
    expect(j.partial).toEqual(['Leverantörsreskontra']);
  });

  it('the LLM input holds no text from the rejected ledger sheet', async () => {
    const seen = [];
    const create = vi.fn(async (params) => {
      seen.push(JSON.stringify(params.messages));
      return { content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: true, channel: 'skolon', school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows: [{ supplier: '', product: 'Polyglutt', quantity: 30, unit: '', amount_sek: null, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' }] }) }] };
    });
    const out = await extractPurchases({ buffer: book([['Skolon', WEAK], ['Leverantörsreskontra', LEDGER]]), filename: 'licenser.xlsx' }, { client: { messages: { create } } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(seen[0]).toMatch(/Polyglutt/);
    for (const s of ['Exempel Person', 'Exempel Bygg', 'Leverantörsreskontra', '500', '900']) expect(seen[0]).not.toContain(s);
    expect(out.partial).toEqual(['Leverantörsreskontra']);
  });

  it('a one-row licence sheet beside a ledger also keeps the ledger out', async () => {
    const seen = [];
    const create = vi.fn(async (params) => { seen.push(JSON.stringify(params.messages)); return { content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: false, channel: null, school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows: [] }) }] }; });
    await extractPurchases({ buffer: book([['Licenser', [['Leverantör', 'Produkt', 'Antal', 'Orderdatum'], ['Binogi', 'Binogi', 10, '2025-08-01']]], ['Leverantörsreskontra', LEDGER]]), filename: 'x.xlsx' }, { client: { messages: { create } } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('Exempel Person');
  });

  it('no usable data outside the rejected sheets: skipped, no LLM call', async () => {
    const create = vi.fn();
    const j = judgeXlsx([sheet([['Licenser 2025']], 'Skolon'), sheet(LEDGER, 'Leverantörsreskontra')], { filename: 'licenser.xlsx' });
    expect(j.verdict).toBe('skip');
    const out = await extractPurchases({ buffer: book([['Skolon', [['Licenser 2025']]], ['Leverantörsreskontra', LEDGER]]), filename: 'licenser.xlsx' }, { client: { messages: { create } } });
    expect(out.skipped).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
  });
});

// Fix wave 4 R6: common ledger and register header spellings, which win over
// a channel or licence word in the filename. Invented rows.
describe('judgeXlsx: ledger and register header variants (R6)', () => {
  const rowsOf = (head, row) => [head, ...Array.from({ length: 5 }, (_, i) => row(i))];
  const ledger = (col) => rowsOf([col, 'Leverantör', 'Belopp', 'Datum'], (i) => [`V${i}`, `Exempel ${i} AB`, 100 + i, '2024-03-01']);

  it('a ledger header is skipped under a licence or channel filename', () => {
    for (const col of ['Ver.nr', 'Vernr', 'Ver nr', 'Verifikationsnummer', 'Lev.fakt.nr', 'Fakturanr', 'Fakturanummer']) {
      for (const filename of ['Licenser 2024.xlsx', 'Atea 2024.xlsx', 'Utbetalningar licenser 2024.xlsx']) {
        const j = judgeXlsx([sheet(ledger(col))], { filename });
        expect(j.verdict, `${col} / ${filename}`).toBe('skip');
        expect(j.rows, col).toEqual([]);
      }
    }
  });

  it('a supplier invoice number is a ledger even beside an Antal column', () => {
    const j = judgeXlsx([sheet(rowsOf(['Lev.fakt.nr', 'Leverantör', 'Antal', 'Belopp'], (i) => [`F${i}`, `Exempel ${i} AB`, 1, 100 + i]))], { filename: 'licensuppföljning.xlsx' });
    expect(j.verdict).toBe('skip');
  });

  it('an avtal register header is skipped under a licence filename, Antal or not', () => {
    const reg = (col, third) => rowsOf([col, 'Leverantör', third, 'Slutdatum'], (i) => [`Avtal ${i}`, `Exempel ${i} AB`, third === 'Antal' ? 3 : '2024-01-01', '2026-12-31']);
    for (const col of ['Avtal', 'Avtalsbenämning', 'Avtalsnamn']) {
      expect(judgeXlsx([sheet(reg(col, 'Startdatum'))], { filename: 'licensavtal.xlsx' }).verdict, col).toBe('skip');
      expect(judgeXlsx([sheet(reg(col, 'Antal'), 'Avtal')], { filename: 'Skolon.xlsx' }).verdict, `${col} + Antal`).toBe('skip');
    }
  });

  it('a real licence list is still read', () => {
    const j = judgeXlsx([sheet(rowsOf(['Ordernummer', 'Leverantör', 'Produkt', 'Antal', 'Belopp'], (i) => [`EX-${i}`, 'Exempel AB', `Vara ${i}`, 2, 100 + i]))], { filename: 'Licenser 2024.xlsx' });
    expect(j.verdict).toBe('rows');
    expect(j.rows).toHaveLength(5);
  });
});
