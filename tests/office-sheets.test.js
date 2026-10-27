// xlsxSheetsFromBuffer: the same parse as officeTextFromBuffer, but keeping
// cell geometry, so a purchase list can be read column by column instead of
// by an LLM. Synthetic workbooks only.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { xlsxSheetsFromBuffer } from '../src/office-text.js';

function book(sheets, { shared = [], styles = null, names = null } = {}) {
  const files = {};
  files['xl/sharedStrings.xml'] = strToU8(`<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`);
  sheets.forEach((xml, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet><sheetData>${xml}</sheetData></worksheet>`); });
  if (styles) files['xl/styles.xml'] = strToU8(styles);
  if (names) files['xl/workbook.xml'] = strToU8(`<workbook><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  return Buffer.from(zipSync(files));
}

describe('xlsxSheetsFromBuffer', () => {
  it('places cells in their columns, keeps gaps, and resolves shared strings', () => {
    const buf = book([
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Exempelprodukt</t></is></c><c r="B3"><v>12.5</v></c><c r="C3" t="s"><v>2</v></c></row>',
    ], { shared: ['Produkt', 'Leverantör', 'Exempel &amp; Co'] });
    const [s] = xlsxSheetsFromBuffer(buf, 'lista.xlsx');
    expect(s.rows).toEqual([
      ['Produkt', null, 'Leverantör'],
      ['Exempelprodukt', 12.5, 'Exempel & Co'],
    ]);
    expect(s.rowNumbers).toEqual([1, 3]);
  });

  it('turns date-formatted cells into ISO dates and leaves other numbers alone', () => {
    const styles = '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
    const buf = book(['<row r="1"><c r="A1" s="1"><v>45658</v></c><c r="B1" s="0"><v>45658</v></c></row>'], { styles });
    const [s] = xlsxSheetsFromBuffer(buf, 'x.xlsx');
    expect(s.rows[0]).toEqual(['2025-01-01', 45658]);
  });

  it('names sheets from the workbook when it lists them, in sheet order', () => {
    const buf = book(['<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c></row>', '<row r="1"><c r="A1" t="inlineStr"><is><t>b</t></is></c></row>'], { names: ['Första', 'Andra'] });
    const sheets = xlsxSheetsFromBuffer(buf, 'x.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['Första', 'Andra']);
    expect(sheets[1].rows).toEqual([['b']]);
  });

  it('returns null for junk and for non-xlsx files', () => {
    expect(xlsxSheetsFromBuffer(Buffer.from('not a zip'), 'x.xlsx')).toBeNull();
    expect(xlsxSheetsFromBuffer(Buffer.from('x'), 'x.docx')).toBeNull();
  });
});
