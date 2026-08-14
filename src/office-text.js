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

// Text nodes in document order, tags dropped, runs joined with a space.
function textFromXml(xml, tagRe) {
  const out = [];
  for (const m of xml.matchAll(tagRe)) {
    const t = decodeXml(m[1]).trim();
    if (t) out.push(t);
  }
  return out;
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
      const shared = sst ? textFromXml(strFromU8(sst), /<t[^>]*>([\s\S]*?)<\/t>/g) : [];
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
            parts.push(...textFromXml(inner, /<t[^>]*>([\s\S]*?)<\/t>/g));
          } else {
            const v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '').trim();
            if (v) parts.push(v);
          }
        }
      }
      // A sheet we could not walk cell-wise still yields its vocabulary.
      if (parts.length === 0) parts.push(...shared);
    } else {
      const doc = files['word/document.xml'];
      if (doc) parts.push(...textFromXml(strFromU8(doc), /<w:t[^>]*>([\s\S]*?)<\/w:t>/g));
    }
  } catch {
    return null;
  }

  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
