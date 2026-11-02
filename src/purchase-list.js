// Purchase and licence lists (2026-10-27).
//
// Many kommuner buy digital läromedel as ORDERS inside a channel platform
// (Skolon, Atea, Läromedia), not as avtal of their own. What they send back is
// a list: a Skolon order history, an Excel sheet of licences, a PDF
// compilation per supplier. Contract analysis files these as
// "följebrev_sammanställning" with is_contract = 0 and keeps no rows, so the
// purchases were invisible. This module reads the rows out of such a list.
//
//   - XLSX: deterministic column mapping when the header row is recognisable
//     (xlsxSheetsFromBuffer keeps the cell geometry). The LLM is only the
//     fallback for a sheet whose headers we do not recognise.
//   - PDF: the LLM, with the same client, model and structured-output pattern
//     as analyse-contract. The schema is kept small: Anthropic rejects more
//     than 16 union-typed parameters, so row fields use "" / 0 for unknown.
//
// Honesty rules: rows are never summed into a total. A total the document
// states itself is kept separately (stated_total_sek). Unknown is null, never
// 0: a zero invoiced amount in an order history means "not invoiced", not
// "free". A licence period is only derived from a length the row states
// ("12 mån", "365 dagar").

import Anthropic from '@anthropic-ai/sdk';
import { classifyLine, classifyVendor, companyBySlug, normName, productBySlug } from './catalogue.js';
import { GRADE_LEVELS, mapUnitToGradeLevels } from './vendor-analytics.js';
import { classifyAnalysisFailure } from './analyse-contract.js';
import { isOfficeDoc, officeTextFromBuffer, xlsxSheetsFromBuffer } from './office-text.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
export const CHANNELS = Object.freeze(['skolon', 'atea', 'laromedia']);

// Document types a purchase list is filed under. An avtal, a PUB-avtal, a
// bilaga or a sekretessbeslut is never one.
export const PURCHASE_DOC_TYPES = Object.freeze(['följebrev_sammanställning', 'prislista', 'övrigt']);

const blank = (v) => v == null || (typeof v === 'string' && !v.trim());
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (blank(v) ? null : String(v).replace(/\s+/g, ' ').trim());

export function isPurchaseListCandidate({ document_type, is_contract } = {}) {
  return Number(is_contract) === 0 && PURCHASE_DOC_TYPES.includes(document_type);
}

// ---------------------------------------------------------------- parsers

const CHANNEL_RE = [
  ['skolon', /\bskolon\b/],
  ['atea', /\batea\b/],
  ['laromedia', /\blaro\s*media\b/],
];

// The channel a document or row names: the first text that names one wins.
export function channelFrom(...texts) {
  for (const t of texts) {
    if (blank(t)) continue;
    const n = ` ${normName(t)} `;
    for (const [slug, re] of CHANNEL_RE) if (re.test(n)) return slug;
  }
  return null;
}

// "läsår 25/26", "2025/2026", "2023-24", "läsåret 2024-2025" -> "2025/26".
// The two years must be consecutive, so a date range or "23-26" is not one.
export function parseSchoolYear(text) {
  if (blank(text)) return null;
  const t = String(text);
  // "läsår-2526" in a filename: two two-digit years run together.
  const run = /l[äa]s[åa]r(?:et)?[\s_-]*(\d{2})(\d{2})(?!\d)/i.exec(t);
  if (run && Number(run[2]) === Number(run[1]) + 1) return `20${run[1]}/${run[2]}`;
  for (const m of t.matchAll(/(?<![\d-])(\d{2}|\d{4})\s*[/\-–]\s*(\d{2}|\d{4})(?![\d-])/g)) {
    const a = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
    const b = m[2].length === 2 ? Math.floor(a / 100) * 100 + Number(m[2]) : Number(m[2]);
    if (a < 2000 || a > 2099 || b !== a + 1) continue;
    return `${a}/${String(b % 100).padStart(2, '0')}`;
  }
  return null;
}

// End of a läsår: 30 June of its second year.
export function schoolYearEnd(sy) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(sy ?? ''));
  return m ? `${Number(m[1]) + 1}-06-30` : null;
}

// Licence length a row states, in months: "12 mån", "365 dagar", "1 år".
export function licenceMonths(text) {
  if (blank(text)) return null;
  const n = normName(text);
  let m = /\b(\d{1,2}) (man|manad|manader|manaders)\b/.exec(n);
  if (m) return Number(m[1]) > 0 ? Number(m[1]) : null;
  m = /\b(365|366|360) dagar\b/.exec(n);
  if (m) return 12;
  m = /\b(\d) (ar|ars)\b/.exec(n);
  if (m && /licens|abonnemang|prenumeration|avtal/.test(n)) return Number(m[1]) * 12;
  return null;
}

const pad = (x) => String(x).padStart(2, '0');
function validYmd(y, m, d) {
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

// A date from a cell: ISO, "YYYYMMDD", "YYMMDD" (order systems), or an Excel
// serial when the column is a date column (serial: true).
export function parseDate(v, { serial = false } = {}) {
  if (blank(v)) return null;
  if (isNum(v)) {
    if (serial && v > 30000 && v < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000);
      return d.toISOString().slice(0, 10);
    }
    if (!Number.isInteger(v)) return null;
    return parseDate(String(v));
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return validYmd(2000 + +m[1], +m[2], +m[3]);
  return null;
}

// Two ISO dates out of free text ("AV 0000-01 2025-01-01 till 2026-12-31").
function dateRange(text) {
  if (blank(text)) return [null, null];
  const ds = [...String(text).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => parseDate(m[1])).filter(Boolean);
  if (ds.length >= 2 && ds[0] <= ds[1]) return [ds[0], ds[1]];
  return [null, null];
}

// "1 234 567,89 kr" -> 1234567.89. A cell with no number is null.
export function parseAmount(v) {
  if (isNum(v)) return v;
  if (blank(v)) return null;
  const s = String(v).replace(/\s| /g, '').replace(/kr|sek|:-/gi, '');
  if (!/^-?[\d.,]+$/.test(s)) return null;
  let t = s;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function addMonths(iso, k) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
}

// Grades in the studio's levels ("Förskoleklass", "1-3" ...), from a list of
// labels or a text ("F-3", "åk 4-6").
function gradesOf(...inputs) {
  const out = new Set();
  for (const x of inputs) {
    for (const t of Array.isArray(x) ? x : [x]) {
      if (blank(t)) continue;
      if (GRADE_LEVELS.includes(t)) { out.add(t); continue; }
      for (const g of mapUnitToGradeLevels(String(t))) out.add(g);
    }
  }
  return GRADE_LEVELS.filter((g) => out.has(g));
}

// ---------------------------------------------------------------- header mapping

// Header patterns on normName text. Order matters inside a field: the first
// pattern that matches a column wins, so the annual cost beats a start-up cost.
const HEADERS = {
  order_ref: [/^(order ?nr|ordernummer|order|best(allnings)? ?nr|verifikationsnr|fakturanr|fakturanummer|order id)$/],
  line: [/^(rad|radnr|orderrad)$/],
  product: [/^(benamning|titel|produkt|produktnamn|produkt projekt|artikelnamn|artikelbenamning|tjanst|verktyg|laromedel|beskrivning|description|product)$/],
  supplier: [/^(lev namn|leverantor|leverantorsnamn|leverantor namn|lev nr t|manufacturer|tillverkare|forlag|supplier|vendor)$/],
  amount: [
    /^(fakt belopp|fakturerat belopp|tot arskostnad|total arskostnad|arskostnad|sales amount|summa kr exkl moms|summa|totalt|total|belopp|kostnad|summa kr|pris totalt|totalpris|utfall)$/,
    /\b(arskostnad|belopp|summa)\b/,
  ],
  unit_price: [/^(pris st|a pris|apris|styckpris|pris per st|enhetspris|pris)$/],
  quantity: [/^(bestallt antal|antal|levererat antal|antal licenser|quantity|qty)$/],
  unit: [/^(enhet|unit|licenstyp)$/],
  order_date: [/^(regdatum|orderdatum|bestallningsdatum|verifikationsdatum|datum|fakturadatum|inkopsdatum)$/],
  period_start: [/^(startdatum|start date|giltig fran|fran|licens fran|start)$/],
  period_end: [/^(slutdatum|end date|giltig till|till|licens till|slut|forfaller)$/],
  period_text: [/^(avtalstid|avtalstid avtal|licensperiod|period|giltighet)$/],
  grades: [/^(arskurs|arskurser|stadium|skolform|ak)$/],
  school_year: [/^(lasar)$/],
};

export function mapHeaderRow(cells = []) {
  const columns = {};
  const used = new Set();
  for (const [field, patterns] of Object.entries(HEADERS)) {
    for (const re of patterns) {
      const i = cells.findIndex((c, idx) => !used.has(idx) && typeof c === 'string' && re.test(normName(c)));
      if (i !== -1) { columns[field] = i; used.add(i); break; }
    }
  }
  const has = (f) => columns[f] != null;
  const recognised = (has('product') || has('supplier')) && (has('amount') || has('quantity') || has('order_date') || has('unit_price') || has('period_start') || has('period_end') || has('period_text'));
  return { columns, recognised, score: Object.keys(columns).length };
}

const TOTAL_WORD = /^(totalt|total|totalsumma|summa|summa totalt|totalbelopp|grand total)$/;

// The table in one sheet: the first recognisable header row in its first 20
// rows. Returns { header, rows, total } or null.
function readTable(sheet, { filename }) {
  const rows = sheet.rows ?? [];
  let h = -1;
  let map = null;
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const m = mapHeaderRow(rows[i]);
    if (m.recognised && (!map || m.score > map.score)) { h = i; map = m; break; }
  }
  if (!map) return null;
  const col = map.columns;
  const cellAt = (r, f) => (col[f] == null ? null : r[col[f]] ?? null);
  // Document-level school year from the lines above the header ("År 2023-24"),
  // else the filename.
  const above = rows.slice(0, h).flat().filter((c) => typeof c === 'string');
  // A sheet named for its läsår ("2024-25") dates its rows too.
  const docYear = parseSchoolYear(above.join(' ')) ?? parseSchoolYear(sheet.name) ?? parseSchoolYear(filename);
  const docChannel = channelFrom(filename, above.join(' '));
  const out = [];
  let total = null;
  let lastSupplier = null;
  for (const r of rows.slice(h + 1)) {
    const supplier0 = str(cellAt(r, 'supplier'));
    const product = str(cellAt(r, 'product'));
    const amountRaw = parseAmount(cellAt(r, 'amount'));
    const label = normName(supplier0 ?? product ?? (typeof r[0] === 'string' ? r[0] : ''));
    if (TOTAL_WORD.test(label)) {
      if (isNum(amountRaw)) total = amountRaw;
      continue;
    }
    if (!product && !supplier0) { lastSupplier = null; continue; }
    // A footnote under the table ("* Avrop via ...", "^DU = ...").
    if (!product && /^[*^]/.test(supplier0 ?? '')) continue;
    const supplier = supplier0 ?? (product ? lastSupplier : null);
    if (supplier0) lastSupplier = supplier0;
    const unitPrice = parseAmount(cellAt(r, 'unit_price'));
    const quantity = parseAmount(cellAt(r, 'quantity'));
    const ref = str(cellAt(r, 'order_ref'));
    const line = str(cellAt(r, 'line'));
    const [ps, pe] = dateRange(cellAt(r, 'period_text'));
    const row = normalisePurchaseRow({
      supplier,
      product,
      channel: channelFrom(supplier) ?? docChannel,
      quantity,
      unit: str(cellAt(r, 'unit')),
      unit_price_sek: unitPrice,
      amount_sek: amountRaw,
      order_date: parseDate(cellAt(r, 'order_date'), { serial: true }),
      period_start: parseDate(cellAt(r, 'period_start'), { serial: true }) ?? ps,
      period_end: parseDate(cellAt(r, 'period_end'), { serial: true }) ?? pe,
      school_year: parseSchoolYear(str(cellAt(r, 'school_year'))) ?? docYear,
      grades: gradesOf(cellAt(r, 'grades')),
      order_ref: ref && line ? `${ref}/${line}` : ref,
    }, { filename });
    if (row) out.push(row);
  }
  return { rows: out, total, map, header: rows[h], above, docChannel };
}

// A row's full identity (fix wave 2 E4): every field that can tell two
// orders apart. Equal supplier and product is not a repeat: a later läsår,
// another budget unit or a new order has its own row. With an order
// reference (fix wave 3 Q4) the identity is the reference plus product,
// amount, period, quantity and läsår (fix wave 4), never the reference alone:
// one order (or invoice) number can carry several products with no line
// column, and a recurring order number can sit on two läsår tabs.
const dupKey = (r) => (r.order_ref
  ? ['ref', normName(r.order_ref), normName(r.product), r.amount_sek, r.period_start, r.period_end, r.quantity, r.school_year]
  : [normName(r.supplier), normName(r.product), r.amount_sek, r.period_start, r.period_end, r.quantity, r.school_year, r.order_date])
  .map((v) => (v == null ? '' : String(v))).join('\u0000');

// Every recognisable table in the workbook. A later sheet that repeats a row
// already read (the same identity: a summary tab of the first) adds only its
// new rows. No rows are summed; a total row is the stated total.
export function extractXlsxPurchases(sheets = [], { filename = '' } = {}) {
  const rows = [];
  const seen = new Set();
  let total = null;
  let recognised = false;
  for (const s of sheets ?? []) {
    const t = readTable(s, { filename });
    if (!t) continue;
    recognised = true;
    if (total == null && t.total != null) total = t.total;
    const fresh = [];
    for (const r of t.rows) {
      const k = dupKey(r);
      if (seen.has(k) && rows.length) continue;
      fresh.push(r);
    }
    for (const r of fresh) seen.add(dupKey(r));
    rows.push(...fresh);
  }
  // A total the workbook states outside the table (a pivot tab's
  // "Totalsumma"): the first total row with an amount beside it.
  if (recognised && total == null) {
    for (const s of sheets ?? []) {
      for (const r of s.rows ?? []) {
        const i = r.findIndex((c) => typeof c === 'string' && TOTAL_WORD.test(normName(c)));
        if (i === -1) continue;
        const n = r.slice(i + 1).map(parseAmount).find(isNum);
        if (isNum(n)) { total = n; break; }
      }
      if (total != null) break;
    }
  }
  return { recognised, rows, stated_total_sek: total, channel: channelFrom(filename) };
}

// ---------------------------------------------------------------- the judge

// Fix wave 2 E1. The deterministic xlsx path reads any table with a supplier
// and a date, so a leverantörsreskontra or the kommun's whole avtal register
// would become "purchases". It writes rows only for a document it positively
// recognises: a channel (Skolon, Atea, Läromedia) or the word licens in the
// filename, a sheet name, the lines above the header or a header cell, or
// licence/order columns (antal, licens..., ordernummer, orderdatum,
// licensperiod). Ledgers and registers are skipped outright.
// Fix wave 3 Q5: each sheet is judged on its own. A sheet named or headed as a
// ledger or register is rejected and never contributes rows, whatever the
// other sheets are; a sheet is read only on its own signal or the filename's.
// Fix wave 3 Q7: the row cap is checked before any extraction path, the LLM's
// included.
export const PURCHASE_ROW_CAP = 2000;
// Office text handed to the LLM; longer is truncated, and a truncated list
// is never stored as complete (E6).
export const PURCHASE_TEXT_MAX = 200_000;

const LEDGER_NAME = /reskontra|verifikation|huvudbok|bokforingsorder/;
const REGISTER_NAME = /avtalsregister|avtalskatalog/;
const INVOICE_NAME = /faktur/;
// Fix wave 4 R6: the common spellings. A voucher number ("Ver.nr", "Vernr")
// or the supplier's invoice number ("Lev.fakt.nr") is a ledger column, and an
// avtal name column ("Avtal", "Avtalsbenämning") a register's, whatever else
// the sheet or the filename says. The kommun's own invoice number
// ("Fakturanr") still rejects only a sheet with no Antal column.
const LEDGER_HEADER = /^verifikation|reskontra|^ver ?nr$|^vernr$|^lev ?fakt(ura)? ?nr$|^levfaktnr$|^leverantorens fakturanr/;
const INVOICE_NO_HEADER = /\bfaktura ?nr\b|fakturanummer|fakturanr/;
const REGISTER_HEADER = /^(avtalsnamn|avtal|avtalsbenamning|avtalets namn)$/;
const LICENCE_WORD_RE = /licens/;
const ORDER_HEADER = /^(order ?nr|ordernummer|order|order id|best(allnings)? ?nr|bestallningsnummer|orderdatum|bestallningsdatum)$/;
const filled = (r) => (r ?? []).some((c) => c != null && c !== '');
const dataRows = (sh) => (sh.rows ?? []).filter(filled).length;
// Data we did not read (fix wave 3 Q6): two populated rows, even in a single
// column ("Produkt / Polyglutt / Unikum"). A lone title line is not data.
const hasData = (sh) => dataRows(sh) >= 2;

// A sheet's own name rejects it: a ledger, a register, or an invoice sheet
// that names no channel.
function nameReject(sh, quantityColumn = false) {
  const n = normName(sh.name ?? '');
  if (LEDGER_NAME.test(n)) return 'verifikationslista eller leverantörsreskontra (bladnamnet)';
  if (REGISTER_NAME.test(n)) return 'avtalsregister (bladnamnet)';
  if (INVOICE_NAME.test(n) && !quantityColumn && !channelFrom(sh.name)) return 'leverantörsreskontra (fakturablad, inga antal)';
  return null;
}

function sheetSignals(t, sh) {
  const heads = (t.header ?? []).filter((c) => typeof c === 'string').map((c) => normName(c));
  const reject = nameReject(sh, t.map.columns.quantity != null)
    ?? (heads.some((h) => LEDGER_HEADER.test(h)) ? 'verifikationslista eller leverantörsreskontra'
      : heads.some((h) => REGISTER_HEADER.test(h)) ? 'avtalsregister (kolumnen med avtalets namn)'
        : heads.some((h) => INVOICE_NO_HEADER.test(h)) && t.map.columns.quantity == null ? 'leverantörsreskontra (fakturanummer, inga antal)'
          : null);
  const text = [sh.name, ...(t.above ?? []), ...(t.header ?? []).filter((c) => typeof c === 'string')].join(' ');
  const positive = Boolean(channelFrom(sh.name, (t.above ?? []).join(' '), heads.join(' ')))
    || LICENCE_WORD_RE.test(normName(text))
    || t.map.columns.quantity != null
    || heads.some((h) => ORDER_HEADER.test(h));
  return { reject, positive };
}

// A sheet no table was found in: a channel or the word licens in its name or
// first lines is still a positive signal (for the row cap).
function rawPositive(sh) {
  const top = (sh.rows ?? []).slice(0, 20).flat().filter((c) => typeof c === 'string').join(' ');
  return Boolean(channelFrom(sh.name, top)) || LICENCE_WORD_RE.test(normName(`${sh.name ?? ''} ${top}`));
}

// The cell text of these sheets only, one line per row (R1): what the LLM
// reads when the workbook also holds a rejected sheet.
function sheetsText(sheets) {
  return sheets.map((sh) => [`Blad: ${sh.name ?? ''}`, ...(sh.rows ?? []).filter(filled)
    .map((r) => r.filter((c) => c != null && c !== '').join(' | '))].join('\n')).join('\n\n');
}

// judgeXlsx(sheets, { filename }) -> { verdict, reason?, rows, partial,
// stated_total_sek, channel }
//   verdict 'rows'     write these rows (method xlsx); `partial` names sheets
//                      that hold data we did not read (E5): rejected sheets,
//                      sheets with no signal of their own, sheets with no
//                      table. The document is recorded partial, never fully
//                      extracted
//   verdict 'partial'  (Q7) a channel or licence list over the row cap: no
//                      rows, recorded partial with `reason` ("för stor för
//                      automatisk läsning (N rader)") so the operator sees it
//   verdict 'skip'     not a purchase list (ledger, register, over the row cap
//                      with no signal): recorded skipped with `reason`, no rows
//   verdict 'llm'      no deterministic reading: the LLM, which asks
//                      is_purchase_list, decides. With a rejected sheet in the
//                      workbook (R1) it carries `llm_text`, the text of the
//                      non-rejected sheets only, and `partial` naming the
//                      sheets the LLM never sees
export function judgeXlsx(sheets = [], { filename = '' } = {}) {
  const fname = normName(filename);
  const empty = { rows: [], partial: [], stated_total_sek: null, channel: channelFrom(filename) };
  if (LEDGER_NAME.test(fname)) return { ...empty, verdict: 'skip', reason: 'leverantörsreskontra eller verifikationslista (filnamnet)' };
  if (REGISTER_NAME.test(fname)) return { ...empty, verdict: 'skip', reason: 'avtalsregister (filnamnet)' };
  const docPositive = Boolean(channelFrom(filename)) || LICENCE_WORD_RE.test(fname);
  const accepted = []; const unread = []; const unreadSheets = []; const rejected = []; const quiet = [];
  let positive = docPositive;
  for (const sh of sheets ?? []) {
    const t = readTable(sh, { filename });
    if (!t) {
      const why = hasData(sh) ? nameReject(sh) : null;
      if (why) { rejected.push({ name: sh.name, reason: why }); continue; }
      if (rawPositive(sh)) positive = true;
      if (hasData(sh)) { unread.push(sh.name); unreadSheets.push(sh); }
      continue;
    }
    const sig = sheetSignals(t, sh);
    if (sig.reject) { rejected.push({ name: sh.name, reason: sig.reject }); continue; }
    if (sig.positive) positive = true;
    if (sig.positive || docPositive) accepted.push(sh); else quiet.push(sh);
  }
  // The row cap (Q7), on what a path would actually read (fix wave 4 R7): the
  // LLM reads raw text, so its sheets count raw rows; the deterministic path
  // counts the accepted sheets' rows after identical rows are deduped, so a
  // summary tab repeating the list does not double it, and a big quiet or
  // rejected sheet never hides a small licence sheet.
  const overCap = (n) => (positive
    ? { ...empty, verdict: 'partial', reason: `för stor för automatisk läsning (${n} rader)` }
    : { ...empty, verdict: 'skip', reason: `över ${PURCHASE_ROW_CAP} rader (${n}): inte en inköpslista` });
  const rawOf = (list) => list.reduce((n, sh) => n + dataRows(sh), 0);
  // Fix wave 4 R1: once a sheet is rejected, the LLM gets only the sheets
  // read on their own signal (and data sheets with no table), never the whole
  // workbook. A quiet sheet beside a rejected one stays unread. Nothing usable
  // left: skipped.
  const llmWithout = () => {
    const llm = [...accepted, ...unreadSheets].filter(hasData);
    if (!llm.length) return { ...empty, verdict: 'skip', reason: rejected[0].reason };
    const n = rawOf(llm);
    if (n > PURCHASE_ROW_CAP) return overCap(n);
    return { ...empty, verdict: 'llm', llm_sheets: llm.map((sh) => sh.name), llm_text: sheetsText(llm), partial: [...rejected.map((r) => r.name), ...quiet.map((q) => q.name)] };
  };
  const llmWhole = () => {
    const n = rawOf([...quiet, ...accepted, ...unreadSheets]);
    return n > PURCHASE_ROW_CAP ? overCap(n) : { ...empty, verdict: 'llm' };
  };
  if (!accepted.length) {
    if (rejected.length) return { ...empty, verdict: 'skip', reason: rejected[0].reason };
    return llmWhole();
  }
  const x = extractXlsxPurchases(accepted, { filename });
  if (x.rows.length > PURCHASE_ROW_CAP) return overCap(x.rows.length);
  if (!looksLikePurchaseList(x.rows)) return rejected.length ? llmWithout() : llmWhole();
  return { verdict: 'rows', rows: x.rows, partial: [...rejected.map((r) => r.name), ...quiet.map((q) => q.name), ...unread], stated_total_sek: x.stated_total_sek, channel: x.channel };
}

// A list is rows of product (or supplier) with an amount, a quantity or a
// date: at least two such rows.
export function looksLikePurchaseList(rows = []) {
  const ok = rows.filter((r) => (!blank(r.product) || !blank(r.supplier))
    && (isNum(r.amount_sek) || isNum(r.quantity) || !blank(r.order_date) || !blank(r.period_start) || !blank(r.period_end)));
  return ok.length >= 2;
}

// ---------------------------------------------------------------- row shape

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// One stored row. Unknown is null. Derived: a licence length the product text
// states gives period_end from the order date (or start). A school year alone
// does not set period_end; the studio reads it as the licensperiod.
export function normalisePurchaseRow(raw = {}, { channel = null } = {}) {
  const supplier = str(raw.supplier);
  const product = str(raw.product);
  if (!supplier && !product) return null;
  const num = (v, { positive = false } = {}) => {
    const n = parseAmount(v);
    if (!isNum(n)) return null;
    if (positive && n <= 0) return null;
    return n;
  };
  const amount = num(raw.amount_sek);
  const orderDate = ISO.test(raw.order_date ?? '') ? raw.order_date : null;
  let start = ISO.test(raw.period_start ?? '') ? raw.period_start : null;
  let end = ISO.test(raw.period_end ?? '') ? raw.period_end : null;
  if (start && end && start > end) { start = null; end = null; }
  const months = licenceMonths(product);
  if (!end && months) {
    const from = start ?? orderDate;
    if (from) { start = from; end = addMonths(from, months); }
  }
  const sy = raw.school_year && /^\d{4}\/\d{2}$/.test(raw.school_year) ? raw.school_year : parseSchoolYear(raw.school_year);
  return {
    supplier,
    product,
    channel: CHANNELS.includes(raw.channel) ? raw.channel : channelFrom(supplier) ?? (CHANNELS.includes(channel) ? channel : null),
    quantity: num(raw.quantity, { positive: true }),
    unit: str(raw.unit),
    unit_price_sek: num(raw.unit_price_sek, { positive: true }),
    // 0 kr in an order history is "not invoiced", not a known price.
    amount_sek: amount === 0 ? null : amount,
    order_date: orderDate,
    period_start: start,
    period_end: end,
    school_year: sy,
    grades: gradesOf(raw.grades, product),
    order_ref: str(raw.order_ref),
  };
}

// ---------------------------------------------------------------- catalogue

const OWNER_KINDS = new Set(['product', 'bundle', 'unresolved', 'segment', 'addon']);

// Fix wave 2 E2: the supplier column of a list can be anything (a ledger's
// payees, a private person), so a supplier names a catalogue company only by
// EXACT equality with one of its aliases, after lower case, punctuation and
// the company-form words (AB, Aktiebolag, Sverige, Sweden) are stripped. No
// token or substring matching: "Magma Exempelbygg AB" is not Magma.
// Fix wave 4 R4: the foreign forms (AS, A/S, ApS, Oy, Ltd, Limited, Inc,
// GmbH) and "Group" are stripped too, from the end only, and what remains
// must still equal an alias: "IST Group AB" is IST, "Exempel Group AB" is
// nobody. "Media" is a name word, not a form, so "Radish Media" is an alias.
const FORM_WORDS = /(?:^| )(ab|aktiebolag|sverige|sweden|as|a s|aps|oy|ltd|limited|inc|gmbh|group)$/;
export function supplierCompany(raw) {
  if (blank(raw)) return null;
  let n = normName(raw);
  while (FORM_WORDS.test(n)) n = n.replace(FORM_WORDS, '').trim();
  return n ? classifyVendor(n) : null;
}
const productCategory = (slug) => productBySlug(slug)?.product.category ?? null;

// The catalogue company and product a row is about. Bought through a channel,
// a row belongs to the product's owner: the line is classified without the
// channel as owner, or every unknown title would become the channel's own
// platform. A supplier that is not a channel owns the row when the product
// line names nobody else. The supplier is matched strictly (supplierCompany);
// only the PRODUCT text goes through classifyLine.
export function classifyPurchaseRow(row = {}) {
  const vendor = supplierCompany(row.supplier);
  const supplierIsChannel = vendor?.role === 'channel';
  const channel = CHANNELS.includes(row.channel) ? row.channel : supplierIsChannel ? vendor.slug : channelFrom(row.supplier);
  const owner = vendor && !supplierIsChannel ? vendor.slug : null;
  let company = null;
  let product = null;
  let kind = 'uncatalogued';
  if (!blank(row.product)) {
    const r = classifyLine(owner, row.product);
    kind = r.kind;
    if (OWNER_KINDS.has(r.kind) && r.companySlug) {
      company = r.companySlug;
      if (r.kind === 'product' || (r.kind === 'segment' && r.companySlug === owner)) product = r.productSlug ?? null;
    }
  }
  if (!company && owner) company = owner;
  // A channel's own product only when the line names it (Skolon's platform).
  if (!company && supplierIsChannel && blank(row.product)) company = null;
  const c = company ? companyBySlug(company) : null;
  return {
    company_slug: company,
    company_name: c?.canonical ?? null,
    product_slug: product,
    channel_slug: channel ?? null,
    category: productCategory(product) ?? c?.category ?? null,
    kind,
  };
}

// ---------------------------------------------------------------- LLM path

const PROMPT = `Du läser dokument som svenska kommuner lämnat ut efter en begäran om allmänna handlingar om digitala läromedel och verktyg. Dokumentet kan vara en inköpslista, en orderhistorik (t.ex. export ur Skolon), en licensöversikt eller en kostnadssammanställning per leverantör eller produkt.

Uppgift: avgör om dokumentet är en sådan lista över köp eller licenser, och skriv i så fall av varje rad.

Regler:
- is_purchase_list: true när dokumentet räknar upp köpta produkter, licenser eller kostnader rad för rad. false för brev, avtalstext, beslut och annat.
- channel: "skolon", "atea" eller "laromedia" när dokumentet säger att köpen gjorts via den kanalen, annars null.
- school_year: läsåret dokumentet gäller som "2025/26", annars null. period_start / period_end: perioden hela dokumentet gäller som ISO-datum (t.ex. perioden köpen gjordes under), annars null. Skriv inte dokumentets period på raderna.
- stated_total_sek: totalsumman ENDAST om dokumentet själv anger den. Räkna aldrig ihop rader själv. null annars.
- rows: en post per rad i listan, i dokumentets ordning. Är en rad en leverantör med underrader per produkt: skriv av underraderna (produktraderna), inte leverantörens summarad. Finns bara leverantörsrader: en post per leverantör med product "".
  - supplier: leverantören som det står. product: produkten eller licensen som det står, "" om raden inte nämner någon.
  - quantity: antal licenser, användare eller elever som raden anger, 0 om det inte står. Antal verktyg eller produkter är inte quantity.
  - unit: enheten för quantity ("elev", "lärare", "licens", "användare"), "" om den saknas.
  - amount_sek: radens belopp i kronor som tal, null om det saknas. Ta beloppet som det står, exklusive moms om dokumentet anger det.
  - period_start / period_end: radens licensperiod som ISO-datum, "" om den inte står.
  - school_year: radens läsår som "2025/26", "" om det inte står.
  - grades: årskurser eller skolformer raden gäller, med värdena i listan, tom lista om det inte står.
  - order_ref: ordernummer eller verifikationsnummer, "" om det saknas.
- Hitta aldrig på värden. Svara ENBART med JSON som matchar schemat.`;

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });
export const PURCHASE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_purchase_list', 'channel', 'school_year', 'period_start', 'period_end', 'stated_total_sek', 'rows'],
  properties: {
    is_purchase_list: { type: 'boolean' },
    channel: { anyOf: [{ type: 'string', enum: [...CHANNELS] }, { type: 'null' }] },
    school_year: nullable('string'),
    period_start: nullable('string'),
    period_end: nullable('string'),
    stated_total_sek: nullable('number'),
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['supplier', 'product', 'quantity', 'unit', 'amount_sek', 'period_start', 'period_end', 'school_year', 'grades', 'order_ref'],
        properties: {
          supplier: { type: 'string' },
          product: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          amount_sek: nullable('number'),
          period_start: { type: 'string' },
          period_end: { type: 'string' },
          school_year: { type: 'string' },
          grades: { type: 'array', items: { type: 'string', enum: [...GRADE_LEVELS] } },
          order_ref: { type: 'string' },
        },
      },
    },
  },
};

// Union-typed parameters (anyOf or a type array), nested ones included: the
// count Anthropic's structured output limits to 16.
export function countUnionParams(schema) {
  let n = 0;
  const walk = (s) => {
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s)) { s.forEach(walk); return; }
    if (Array.isArray(s.anyOf) || Array.isArray(s.type)) n += 1;
    for (const v of Object.values(s)) if (v && typeof v === 'object') walk(v);
  };
  walk(schema);
  return n;
}

// The structured answer as stored rows, with the document's own context
// (channel, school year, period) as the fallback for every row.
export function rowsFromLlm(answer, { filename = '' } = {}) {
  const docChannel = CHANNELS.includes(answer?.channel) ? answer.channel : channelFrom(filename);
  const docYear = parseSchoolYear(answer?.school_year) ?? parseSchoolYear(filename);
  const rows = [];
  for (const r of answer?.rows ?? []) {
    const row = normalisePurchaseRow({
      supplier: r.supplier,
      product: r.product,
      channel: channelFrom(r.supplier) ?? docChannel,
      quantity: r.quantity,
      unit: r.unit,
      amount_sek: r.amount_sek,
      // The document's own period ("inköpta under 2025-01-01 till 2026-12-31")
      // is when the orders were placed, not any row's licensperiod, so it is
      // never copied onto the rows.
      period_start: parseDate(r.period_start),
      period_end: parseDate(r.period_end),
      school_year: parseSchoolYear(r.school_year) ?? docYear,
      grades: r.grades,
      order_ref: r.order_ref,
    }, { channel: docChannel });
    if (row) rows.push(row);
  }
  const total = isNum(answer?.stated_total_sek) && answer.stated_total_sek > 0 ? answer.stated_total_sek : null;
  return { is_purchase_list: !!answer?.is_purchase_list, rows, stated_total_sek: total, channel: docChannel };
}

let cachedClient = null;
function getClient(apiKey) {
  if (!apiKey) return null;
  if (!cachedClient || cachedClient._apiKey !== apiKey) {
    cachedClient = new Anthropic({ apiKey });
    cachedClient._apiKey = apiKey;
  }
  return cachedClient;
}

// A long list is many output tokens; stream when the client can, so the SDK
// does not refuse a long non-streaming request.
const MAX_TOKENS = 64000;
async function callModel(client, params) {
  if (typeof client.messages.stream === 'function') {
    return client.messages.stream(params).finalMessage();
  }
  return client.messages.create(params);
}

// One LLM extraction over a PDF (`pdf`) or a text (`text`, an xlsx we could
// not map). Returns the raw structured answer, or null; failures are reported
// through onFailure with analyse-contract's classification (permanent,
// transient, backoff). No key and no client: null without a failure.
export async function extractPurchasesWithLlm({ pdf = null, text = null, ctx = {}, env = process.env, client = null, onFailure = null } = {}) {
  if (pdf != null && !pdf.length) { onFailure?.({ permanent: true, reason: 'permanent:empty_file', message: 'stored file is empty' }); return null; }
  if (pdf == null && blank(text)) { onFailure?.({ permanent: true, reason: 'permanent:no_readable_text', message: 'no extractable text' }); return null; }
  const sdk = client ?? getClient(env?.ANTHROPIC_API_KEY);
  if (!sdk) return null;
  const model = env?.ANTHROPIC_CONTRACT_MODEL ?? DEFAULT_MODEL;
  const head = `Kommun: ${ctx.kommun_namn ?? 'okänd'}\nFilnamn: ${ctx.filename ?? ''}`;
  const content = pdf != null
    ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }, { type: 'text', text: head }]
    : [{ type: 'text', text: `${head}\n\nNedan är textinnehållet ur ett kalkylblad. Radstrukturen kan vara förlorad.\n\n${text}` }];
  try {
    const response = await callModel(sdk, {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: PURCHASE_SCHEMA } },
    });
    if (response?.stop_reason === 'max_tokens') {
      onFailure?.({ permanent: true, reason: 'permanent:output_too_long', message: 'list longer than the output limit' });
      return null;
    }
    const block = (response?.content ?? []).find((b) => b.type === 'text');
    if (!block?.text) { onFailure?.({ permanent: false, reason: 'transient:empty_response', message: 'no text block in response' }); return null; }
    try {
      return JSON.parse(block.text);
    } catch (e) {
      onFailure?.({ permanent: false, reason: 'transient:json_parse_error', message: e.message });
      return null;
    }
  } catch (e) {
    onFailure?.(classifyAnalysisFailure(e));
    return null;
  }
}

// One document to rows. XLSX the judge recognises (judgeXlsx): deterministic,
// no LLM; one it rejects: a skip, no LLM. Anything else (PDF, an xlsx with no
// signal, a docx) goes to the LLM, unless its text would be truncated.
// Returns { method, is_list, rows, stated_total_sek, channel, skipped?,
// partial?, too_large? } or null when nothing could be read (the failure went to
// onFailure, or no key).
export async function extractPurchases({ buffer, filename = '', kommun_namn = null } = {}, { env = process.env, client = null, onFailure = null } = {}) {
  const ctx = { kommun_namn, filename };
  let llmText = null;
  let llmPartial = [];
  if (/\.xlsx$/i.test(filename)) {
    const sheets = xlsxSheetsFromBuffer(buffer, filename);
    if (!sheets) { onFailure?.({ permanent: true, reason: 'permanent:office_parse_error', message: 'not a readable xlsx' }); return null; }
    const j = judgeXlsx(sheets, { filename });
    if (j.verdict === 'skip') return { method: 'xlsx', is_list: false, rows: [], stated_total_sek: null, channel: j.channel, skipped: j.reason };
    if (j.verdict === 'partial') return { method: 'xlsx', is_list: false, rows: [], stated_total_sek: null, channel: j.channel, too_large: j.reason };
    if (j.verdict === 'rows') {
      return { method: 'xlsx', is_list: true, rows: j.rows, stated_total_sek: j.stated_total_sek, channel: j.channel, partial: j.partial };
    }
    if (j.llm_text != null) { llmText = j.llm_text; llmPartial = j.partial; }
  }
  let answer;
  if (isOfficeDoc(filename)) {
    const text = llmText ?? officeTextFromBuffer(buffer, filename, { maxChars: Infinity });
    if (text && text.length > PURCHASE_TEXT_MAX) {
      onFailure?.({ permanent: true, reason: 'permanent:truncated', message: `text ${text.length} tecken, över ${PURCHASE_TEXT_MAX}: listan skulle kapas` });
      return null;
    }
    answer = await extractPurchasesWithLlm({ text, ctx, env, client, onFailure });
  } else {
    answer = await extractPurchasesWithLlm({ pdf: buffer ?? Buffer.alloc(0), ctx, env, client, onFailure });
  }
  if (!answer) return null;
  const out = rowsFromLlm(answer, { filename });
  const isList = out.is_purchase_list && out.rows.length > 0;
  return { method: 'llm', is_list: isList, rows: isList ? out.rows : [], stated_total_sek: isList ? out.stated_total_sek : null, channel: out.channel, partial: llmPartial };
}
