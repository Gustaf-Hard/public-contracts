// xlsx/docx are zip archives of XML. Contract analysis was PDF-only, so a
// kommun that answered with a spreadsheet ("Avtalslista Lärresurser 2026.xlsx"
// — Essunga's list of digitala läromedel) had it stored and never read, while
// the draft went on to ask whether they had any läromedel at all.
import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { officeTextFromBuffer, isOfficeDoc } from '../src/office-text.js';

function xlsx({ shared = [], rows = [] } = {}) {
  const sst = `<?xml version="1.0"?><sst xmlns="x">${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="x"><sheetData>${rows.map((cells, r) => `<row r="${r + 1}">${cells.map((c, i) => (typeof c === 'number'
    ? `<c r="A${r}" t="s"><v>${c}</v></c>`
    : `<c r="B${r}"><is><t>${c}</t></is></c>`)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  return Buffer.from(zipSync({
    'xl/sharedStrings.xml': strToU8(sst),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  }));
}

describe('isOfficeDoc', () => {
  it('recognises spreadsheets and documents, not PDFs', () => {
    expect(isOfficeDoc('Avtalslista Lärresurser 2026.xlsx')).toBe(true);
    expect(isOfficeDoc('Sammanställning.XLSX')).toBe(true);
    expect(isOfficeDoc('avtal.docx')).toBe(true);
    expect(isOfficeDoc('avtal.pdf')).toBe(false);
    expect(isOfficeDoc('bild.png')).toBe(false);
    expect(isOfficeDoc(null)).toBe(false);
  });
});

describe('officeTextFromBuffer', () => {
  it('reads shared strings and inline text out of a spreadsheet', () => {
    const buf = xlsx({ shared: ['Leverantör', 'Inläsningstjänst', 'Binogi'], rows: [[0], [1], [2]] });
    const text = officeTextFromBuffer(buf, 'lista.xlsx');
    expect(text).toContain('Leverantör');
    expect(text).toContain('Inläsningstjänst');
    expect(text).toContain('Binogi');
  });

  it('reads paragraphs out of a docx', () => {
    const doc = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
      <w:p><w:r><w:t>Avtal med Gleerups</w:t></w:r></w:p>
      <w:p><w:r><w:t>Årskostnad 45 000 kr</w:t></w:r></w:p></w:body></w:document>`;
    const buf = Buffer.from(zipSync({ 'word/document.xml': strToU8(doc) }));
    const text = officeTextFromBuffer(buf, 'avtal.docx');
    expect(text).toContain('Avtal med Gleerups');
    expect(text).toContain('45 000 kr');
  });

  it('returns null rather than throwing on junk, so one bad file cannot stop a tick', () => {
    expect(officeTextFromBuffer(Buffer.from('not a zip'), 'x.xlsx')).toBeNull();
    expect(officeTextFromBuffer(Buffer.from(''), 'x.docx')).toBeNull();
  });

  it('decodes XML entities so vendor names survive intact', () => {
    const buf = xlsx({ shared: ['Ekonomi &amp; IT', 'M&#246;lndal'], rows: [[0], [1]] });
    const text = officeTextFromBuffer(buf, 'l.xlsx');
    expect(text).toContain('Ekonomi & IT');
    expect(text).toContain('Mölndal');
  });
});

describe('xlsx cell types', () => {
  it('resolves shared-string cells instead of emitting their index as a number', () => {
    // A t="s" cell's <v> is an index into the shared table. Emitted raw it puts
    // stray integers in the text, which an extractor can read as an amount.
    const sst = '<?xml version="1.0"?><sst><si><t>Inläsningstjänst</t></si><si><t>Binogi</t></si></sst>';
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>45000</v></c></row>
      <row><c r="A2" t="s"><v>1</v></c><c r="B2"><v>12000</v></c></row>
    </sheetData></worksheet>`;
    const buf = Buffer.from(zipSync({
      'xl/sharedStrings.xml': strToU8(sst),
      'xl/worksheets/sheet1.xml': strToU8(sheet),
    }));
    const text = officeTextFromBuffer(buf, 'lista.xlsx');
    expect(text).toContain('Inläsningstjänst');
    expect(text).toContain('Binogi');
    expect(text).toContain('45000');
    // The indices 0 and 1 must not survive as free-standing numbers.
    expect(text.split(/\s+/)).not.toContain('0');
    expect(text.split(/\s+/)).not.toContain('1');
  });
});

describe('attachment path resolution', () => {
  // Rows written before the AWS migration hold laptop-relative paths
  // ("data/contracts/0381/..."). On the box those resolve to nothing, so the
  // file is skipped forever — invisible, because the only symptom is an
  // attachment that never gets analysed.
  it('re-roots a legacy relative path onto the configured contracts dir', async () => {
    const { resolveAttachmentPath } = await import('../src/analyse-contract.js');
    expect(resolveAttachmentPath('data/contracts/0381/a.xlsx', '/var/lib/mediagraf/contracts'))
      .toBe('/var/lib/mediagraf/contracts/0381/a.xlsx');
  });

  it('leaves an absolute path untouched', async () => {
    const { resolveAttachmentPath } = await import('../src/analyse-contract.js');
    expect(resolveAttachmentPath('/var/lib/mediagraf/contracts/1445/b.xlsx', '/var/lib/mediagraf/contracts'))
      .toBe('/var/lib/mediagraf/contracts/1445/b.xlsx');
  });

  it('is a no-op when the contracts dir is the legacy one', async () => {
    const { resolveAttachmentPath } = await import('../src/analyse-contract.js');
    expect(resolveAttachmentPath('data/contracts/0381/a.pdf', 'data/contracts'))
      .toContain('data/contracts/0381/a.pdf');
  });
});

describe('xlsx shared-string edge cases that corrupt real files', () => {
  // Aneby's supplier ledger came back with literal "</si><si><t>" inside the
  // text. Cause: an empty shared string is written self-closing (<t/>), which
  // has no </t>, so a naive <t...>(.*?)</t> match swallows everything up to the
  // NEXT cell's closing tag and drags the markup along with it.
  it('does not swallow markup when a shared string is self-closing', () => {
    const sst = '<?xml version="1.0"?><sst><si><t/></si><si><t>Advania</t></si><si><t>Tietoevry</t></si></sst>';
    const sheet = `<?xml version="1.0"?><worksheet><sheetData>
      <row><c r="A1" t="s"><v>1</v></c><c r="A2" t="s"><v>2</v></c></row>
    </sheetData></worksheet>`;
    const buf = Buffer.from(zipSync({
      'xl/sharedStrings.xml': strToU8(sst), 'xl/worksheets/sheet1.xml': strToU8(sheet),
    }));
    const text = officeTextFromBuffer(buf, 'ledger.xlsx');
    expect(text).not.toMatch(/<\/?si>|<\/?t>|<c |<v>/);
    expect(text).toContain('Advania');
    expect(text).toContain('Tietoevry');
  });

  // A rich-text shared string is <si><r><t>a</t></r><r><t>b</t></r></si> — ONE
  // entry made of two <t>. Counting <t> instead of <si> shifts every later
  // index, so cells resolve to the wrong supplier entirely.
  it('keeps shared-string indices aligned when an entry has rich-text runs', () => {
    const sst = '<?xml version="1.0"?><sst>'
      + '<si><r><t>Konica</t></r><r><t> Minolta</t></r></si>'
      + '<si><t>Axiell</t></si></sst>';
    const sheet = '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>';
    const buf = Buffer.from(zipSync({
      'xl/sharedStrings.xml': strToU8(sst), 'xl/worksheets/sheet1.xml': strToU8(sheet),
    }));
    // Index 1 is Axiell. Flat <t> counting would have made it " Minolta".
    expect(officeTextFromBuffer(buf, 'x.xlsx')).toContain('Axiell');
  });
});
