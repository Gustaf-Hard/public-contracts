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

  it(`a table over ${PURCHASE_ROW_CAP} rows is not a purchase list`, () => {
    expect(PURCHASE_ROW_CAP).toBe(2000);
    const big = [['Leverantör', 'Produkt', 'Antal', 'Belopp'], ...Array.from({ length: PURCHASE_ROW_CAP + 1 }, (_, i) => [`Exempel ${i} AB`, `Vara ${i}`, 1, i + 1])];
    const j = judgeXlsx([sheet(big)], { filename: 'Skolon.xlsx' });
    expect(j.verdict).toBe('skip');
    expect(j.reason).toMatch(/2000/);
  });
});

describe('judgeXlsx: partial workbooks (E5)', () => {
  it('a recognised sheet beside an unread data sheet is partial, naming the skipped sheet', () => {
    const j = judgeXlsx([sheet(LIST, 'Köp'), sheet([['Radetiketter', 'Utfall'], ['Exempel AB', 10], ['Annan AB', 20]], 'Pivot')], { filename: 'Skolon.xlsx' });
    expect(j.verdict).toBe('rows');
    expect(j.partial).toEqual(['Pivot']);
    expect(j.rows).toHaveLength(2);
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
