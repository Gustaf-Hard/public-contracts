// One run of purchase-list extraction over candidate attachments (driven by
// scripts/17-extract-purchases.js, never by the tick). Follows the bounded,
// loud failure rules of contract analysis where they fit:
//   - dry run by default: nothing is written and the LLM is never called; an
//     xlsx with recognisable headers is still read, so the dry run shows what
//     --apply would store.
//   - a permanent failure parks the document at once, a transient one books
//     an attempt up to MAX_PURCHASE_ATTEMPTS, a backoff (429/529) books none.
//   - every candidate missing on disk (>= MIN_ENV_FAULT_MISSING) is an
//     environment fault: nothing is booked.
//   - every attempt (>= 3) failing transiently or on backoff is reported as
//     systemic.
// Bookkeeping lives on purchase_documents, never on attachments, so this run
// cannot park a file for the contract analysis.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PURCHASE_ATTEMPTS } from './storage.js';
import { resolveAttachmentPath, MIN_ENV_FAULT_MISSING } from './analyse-contract.js';
import { extractPurchases, judgeXlsx } from './purchase-list.js';
import { xlsxSheetsFromBuffer } from './office-text.js';

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(String(name ?? '')) || [])[1]?.toLowerCase() ?? null;
const SUPPORTED = new Set(['pdf', 'xlsx', 'docx']);
// Settled documents a normal run leaves alone (--force re-reads them).
const DONE = new Set(['rows', 'not_list', 'partial', 'skipped']);

// Where the file is: <filesDir>/<id>.<ext> when a directory of copies named
// by attachment id is given, else the stored path re-rooted like the
// contract analysis does.
export function purchaseFilePath(att, { contractsDir = null, filesDir = null } = {}) {
  const ext = extOf(att.filename) ?? extOf(att.saved_path);
  if (filesDir && ext) {
    const p = join(filesDir, `${att.id}.${ext}`);
    if (existsSync(p)) return p;
  }
  return resolveAttachmentPath(att.saved_path, contractsDir);
}

export async function runPurchaseExtraction({
  db, apply = false, onlyId = null, force = false, limit = Infinity,
  contractsDir = null, filesDir = null, env = process.env, client = null, log = () => {},
} = {}) {
  const result = {
    candidates: 0, attempted: 0, written: 0, not_list: 0, skipped: 0, partial: 0, would_call_llm: 0, failed: 0, transient: 0, backoff: 0,
    permanent: 0, parked: [], env_fault: null, systemic: false, documents: [],
  };
  let list = db.listPurchaseCandidates();
  if (onlyId != null) list = list.filter((a) => a.id === onlyId);
  if (!force) {
    list = list.filter((a) => !DONE.has(a.purchase_status) && (a.purchase_attempts ?? 0) < MAX_PURCHASE_ATTEMPTS);
  }
  list = list.filter((a) => SUPPORTED.has(extOf(a.filename) ?? extOf(a.saved_path))).slice(0, limit);
  result.candidates = list.length;

  const book = (att, f) => {
    result.failed += 1;
    if (f.backoff) {
      result.backoff += 1;
      log(`purchases DEFERRED #${att.id} (${att.kommun_namn ?? 'okänd kommun'}): ${f.reason} [inget försök bokfört]`);
      return;
    }
    if (f.permanent) result.permanent += 1; else result.transient += 1;
    if (!apply) { log(`purchases FAILED #${att.id}: ${f.reason} (torrkörning, inget bokfört)`); return; }
    const attempts = db.recordPurchaseFailure(att.id, { reason: f.reason, permanent: !!f.permanent });
    if (attempts >= MAX_PURCHASE_ATTEMPTS) result.parked.push({ id: att.id, reason: f.reason });
    log(`purchases FAILED #${att.id} (${att.kommun_namn ?? 'okänd kommun'}): ${f.reason} — ${f.message ?? ''} [försök ${attempts}/${MAX_PURCHASE_ATTEMPTS}${attempts >= MAX_PURCHASE_ATTEMPTS ? ', PARKERAD' : ''}]`);
  };

  const missing = [];
  for (const att of list) {
    const path = purchaseFilePath(att, { contractsDir, filesDir });
    if (!existsSync(path)) { result.attempted += 1; missing.push(att); continue; }
    let buf;
    try {
      buf = readFileSync(path);
    } catch (e) {
      result.attempted += 1;
      book(att, { permanent: true, reason: 'permanent:file_unreadable', message: e.message });
      continue;
    }
    const filename = att.filename ?? '';
    if (!apply) {
      // Dry run: the deterministic path only. Anything that needs the LLM is
      // counted, not called.
      if (/\.xlsx$/i.test(filename)) {
        const j = judgeXlsx(xlsxSheetsFromBuffer(buf, filename) ?? [], { filename });
        if (j.verdict === 'skip') {
          result.skipped += 1;
          result.documents.push({ id: att.id, kommun_kod: att.kommun_kod, method: 'xlsx', rows: null, skipped: j.reason, written: false });
          log(`purchases DRY #${att.id} (${att.kommun_namn ?? ''}): hoppas över, ${j.reason}`);
          continue;
        }
        if (j.verdict === 'partial') {
          result.partial += 1;
          result.documents.push({ id: att.id, kommun_kod: att.kommun_kod, method: 'xlsx', rows: null, too_large: j.reason, written: false });
          log(`purchases DRY #${att.id} (${att.kommun_namn ?? ''}): delvis, ${j.reason}`);
          continue;
        }
        if (j.verdict === 'rows') {
          if (j.partial.length) result.partial += 1;
          result.documents.push({ id: att.id, kommun_kod: att.kommun_kod, method: 'xlsx', rows: j.rows, stated_total_sek: j.stated_total_sek, partial: j.partial, written: false });
          log(`purchases DRY #${att.id} (${att.kommun_namn ?? ''}): ${j.rows.length} rader ur kalkylbladet${j.partial.length ? `, delvis (oläst blad: ${j.partial.join(', ')})` : ''}`);
          continue;
        }
      }
      result.would_call_llm += 1;
      result.documents.push({ id: att.id, kommun_kod: att.kommun_kod, method: 'llm', rows: null, written: false });
      log(`purchases DRY #${att.id} (${att.kommun_namn ?? ''}): skulle läsas av LLM`);
      continue;
    }
    result.attempted += 1;
    let failure = null;
    const out = await extractPurchases({ buffer: buf, filename, kommun_namn: att.kommun_namn }, { env, client, onFailure: (f) => { failure = f; } });
    if (!out) {
      if (failure) book(att, failure);
      else { result.attempted -= 1; log(`purchases SKIPPED #${att.id}: ingen API-nyckel, inget försök bokfört`); }
      continue;
    }
    const partial = out.partial ?? [];
    db.replacePurchaseRows(att.id, { rows: out.rows, method: out.method, channel: out.channel, stated_total_sek: out.stated_total_sek, isList: out.is_list, partial, skipped: out.skipped ?? null, tooLarge: out.too_large ?? null });
    if (out.skipped) result.skipped += 1;
    else if (out.too_large) result.partial += 1;
    else if (out.is_list) { result.written += 1; if (partial.length) result.partial += 1; } else result.not_list += 1;
    result.documents.push({ id: att.id, kommun_kod: att.kommun_kod, method: out.method, rows: out.skipped || out.too_large ? null : out.rows, stated_total_sek: out.stated_total_sek, ...(out.skipped ? { skipped: out.skipped } : {}), ...(out.too_large ? { too_large: out.too_large } : {}), partial, written: true });
    log(out.skipped
      ? `purchases SKIPPED #${att.id} (${att.kommun_namn ?? ''}): ${out.skipped}`
      : out.too_large ? `purchases PARTIAL #${att.id} (${att.kommun_namn ?? ''}): ${out.too_large}`
      : `purchases ${out.is_list ? 'WROTE' : 'NOT A LIST'} #${att.id} (${att.kommun_namn ?? ''}): ${out.rows.length} rader, ${out.method}${partial.length ? `, delvis (oläst blad: ${partial.join(', ')})` : ''}`);
  }

  if (missing.length >= MIN_ENV_FAULT_MISSING && missing.length === list.length) {
    result.env_fault = 'contracts_dir_unavailable';
    log(`purchases ENVIRONMENT FAULT: alla ${missing.length} filer saknas på disk, inget bokfört. Är kontraktsvolymen monterad?`);
  } else {
    for (const att of missing) book(att, { permanent: true, reason: 'permanent:file_missing', message: purchaseFilePath(att, { contractsDir, filesDir }) });
  }
  const tried = result.attempted - (result.env_fault ? missing.length : 0);
  if (tried >= 3 && result.transient + result.backoff === tried) {
    result.systemic = true;
    log(`purchases SYSTEMIC: alla ${tried} försök misslyckades tillfälligt (API eller schema). Kontrollera innan nästa körning.`);
  }
  return result;
}
