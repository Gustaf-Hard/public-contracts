// Plain text out of .xlsx / .docx, so contract analysis is not PDF-only.
//
// A kommun that answers with a spreadsheet ("Avtalslista Lärresurser 2026.xlsx"
// — Essunga's list of digitala läromedel) used to have it stored and never
// read, while the follow-up went on to ask whether they had any läromedel at
// all. Both formats are zip archives of XML, and fflate is already a dependency
// for expanding delivered zips, so this needs no new package and no conversion
// service.
//
// Deliberately crude: strip tags, keep text. The LLM reads the result, so cell
// geometry does not matter — vendor names, products and amounts do.
import { unzipSync, strFromU8 } from 'fflate';

export function isOfficeDoc(filename) {
  return /\.(xlsx|docx)$/i.test(String(filename ?? ''));
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

// Text nodes in document order, tags dropped.
//
// The `<tag/>` alternative is not cosmetic: an empty cell is written
// self-closing, and without it a `(.*?)</t>` match starting at `<t/>` runs on
// to the NEXT element's closing tag and drags the markup in with it. Aneby's
// supplier ledger came out full of literal "</si><si><t>" that way.
function textFromXml(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*?/>|<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  for (const m of xml.matchAll(re)) {
    if (m[1] === undefined) continue;          // self-closing: empty by definition
    const t = decodeXml(m[1]).trim();
    if (t) out.push(t);
  }
  return out;
}

// The shared-string table, indexed the way cells reference it: one entry per
// <si>. An <si> may hold several <t> (rich text runs), so counting <t> shifts
// every later index and cells resolve to the wrong supplier.
function sharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si\b[^>]*?\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    out.push(si[1] === undefined ? '' : textFromXml(si[1], 't').join(''));
  }
  return out;
}


// Excel stores dates as a day count from 1899-12-30, so a raw sheet reads
// "Slutdatum 46731". period_end drives renewal tracking, so handing the
// extractor a five-digit number where a date belongs is worse than handing it
// nothing. Only cells the workbook FORMATS as a date are converted — a plain
// number (an amount, an org number) must survive untouched.
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

// styles.xml → which cell-format index (the `s` attribute) means "date".
function dateStyleIndexes(xml) {
  const dateFmtIds = new Set(BUILTIN_DATE_FMTS);
  for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/?>/g)) {
    // A custom format is a date format when its code has day/month/year parts
    // and no currency-ish escape. Good enough: y/m/d outside quotes.
    if (/[ymd]/i.test(m[2].replace(/"[^"]*"/g, ''))) dateFmtIds.add(Number(m[1]));
  }
  const out = new Set();
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  let i = 0;
  for (const xf of cellXfs.matchAll(/<xf\b[^>]*?\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(xf[0])?.[1] ?? 0);
    if (dateFmtIds.has(id)) out.add(i);
    i += 1;
  }
  return out;
}

// Excel serial → ISO date. Serial 1 is 1900-01-01; the epoch is 1899-12-30
// because Excel keeps Lotus's fictional 1900 leap day.
function serialToIso(n) {
  if (!Number.isFinite(n) || n < 1 || n > 80_000) return null;
  const ms = Math.round(n) * 86_400_000;
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function officeTextFromBuffer(buffer, filename, { maxChars = 200_000 } = {}) {
  if (!buffer?.length || !isOfficeDoc(filename)) return null;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return null;   // not a readable zip; one bad file must not stop a tick
  }

  const parts = [];
  try {
    if (/\.xlsx$/i.test(filename)) {
      // Most cell text lives in the shared-string table; inline strings (<is>)
      // and numbers live in the sheets.
      const sst = files['xl/sharedStrings.xml'];
      const shared = sst ? sharedStrings(strFromU8(sst)) : [];
      const dateStyles = files['xl/styles.xml']
        ? dateStyleIndexes(strFromU8(files['xl/styles.xml']))
        : new Set();
      for (const name of Object.keys(files)) {
        if (!/^xl\/worksheets\/.*\.xml$/i.test(name)) continue;
        const xml = strFromU8(files[name]);
        // Resolve cell by cell. A t="s" cell's <v> is an INDEX into the shared
        // string table, not a value — emitting it raw would put stray integers
        // in the text an LLM then reads as amounts.
        for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = cell[1];
          const inner = cell[2];
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
          if (type === 's') {
            const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
            const v = shared[idx];
            if (v) parts.push(v);
          } else if (type === 'inlineStr') {
            parts.push(...textFromXml(inner, 't'));
          } else {
            const v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim();
            if (!v) continue;
            const styleIdx = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
            const iso = dateStyles.has(styleIdx) ? serialToIso(Number(v)) : null;
            parts.push(iso ?? v);
          }
        }
      }
      // A sheet we could not walk cell-wise still yields its vocabulary.
      if (parts.length === 0) parts.push(...shared.filter(Boolean));
    } else {
      const doc = files['word/document.xml'];
      if (doc) parts.push(...textFromXml(strFromU8(doc), 'w:t'));
    }
  } catch {
    return null;
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Column letters ("A", "AB") to a 0-based index.
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(String(ref ?? ''))?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Worksheet part name -> sheet name, from workbook.xml and its rels. Falls
// back to "sheetN" when the workbook does not say.
function sheetNames(files) {
  const out = new Map();
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const targets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`);
  }
  let i = 0;
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    i += 1;
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? '');
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    const part = (rid && targets.get(rid)) || `xl/worksheets/sheet${i}.xml`;
    out.set(part, name || `sheet${i}`);
  }
  return out;
}

// Every worksheet as rows of cells, cell geometry kept: a purchase list read
// column by column needs to know that "Fakt.belopp" is column R. A cell is a
// string, a number, an ISO date (date-formatted cells only, as in
// officeTextFromBuffer) or null for a gap. Empty rows are dropped;
// rowNumbers[i] is the sheet row number of rows[i]. null when the file is not
// a readable xlsx. Sheets come in workbook order.
export function xlsxSheetsFromBuffer(buffer, filename) {
  if (!buffer?.length || !/\.xlsx$/i.test(String(filename ?? ''))) return null;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    return null;
  }
  try {
    const sst = files['xl/sharedStrings.xml'];
    const shared = sst ? sharedStrings(strFromU8(sst)) : [];
    const dateStyles = files['xl/styles.xml'] ? dateStyleIndexes(strFromU8(files['xl/styles.xml'])) : new Set();
    const names = sheetNames(files);
    const parts = Object.keys(files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/i.test(n));
    const order = [...names.keys()];
    parts.sort((a, b) => {
      const ia = order.indexOf(a); const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      return Number(/(\d+)\.xml$/i.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/i.exec(b)?.[1] ?? 0);
    });
    const sheets = [];
    for (const part of parts) {
      const xml = strFromU8(files[part]);
      const rows = [];
      const rowNumbers = [];
      let lastRow = 0;
      for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const rnum = Number(/\br="(\d+)"/.exec(row[1])?.[1] ?? lastRow + 1);
        lastRow = rnum;
        const cells = [];
        let nextCol = 0;
        for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = cell[1];
          const inner = cell[2] ?? '';
          const col = colIndex(/\br="([A-Z]+)\d*"/.exec(attrs)?.[1]) ?? nextCol;
          nextCol = col + 1;
          const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
          let v = null;
          if (type === 's') {
            const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
            v = shared[idx] ?? null;
          } else if (type === 'inlineStr') {
            v = textFromXml(inner, 't').join('') || null;
          } else if (type === 'str' || type === 'e' || type === 'b') {
            v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim() || null;
          } else {
            const raw = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim();
            if (raw) {
              const n = Number(raw);
              const styleIdx = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
              const iso = dateStyles.has(styleIdx) ? serialToIso(n) : null;
              v = iso ?? (Number.isFinite(n) ? n : raw);
            }
          }
          if (typeof v === 'string') v = v.trim() || null;
          while (cells.length < col) cells.push(null);
          cells[col] = v;
        }
        while (cells.length && cells[cells.length - 1] == null) cells.pop();
        if (!cells.length) continue;
        rows.push(cells);
        rowNumbers.push(rnum);
      }
      sheets.push({ name: names.get(part) ?? part.replace(/^.*\//, '').replace(/\.xml$/i, ''), rows, rowNumbers });
    }
    return sheets;
  } catch {
    return null;
  }
}
