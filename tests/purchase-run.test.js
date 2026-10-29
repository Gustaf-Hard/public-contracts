// runPurchaseExtraction (scripts/17-extract-purchases.js): dry run by
// default, bounded and loud failures. Temp-dir DB and files, synthetic data.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { openDb, MAX_PURCHASE_ATTEMPTS } from '../src/storage.js';
import { runPurchaseExtraction } from '../src/purchase-run.js';

let tmp; let db; let dir; let n = 0;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'prun-')); dir = join(tmp, 'contracts'); mkdirSync(dir); db = openDb(join(tmp, 'pilot.db')); db.migrate(); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const cell = (ref, v) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
const xlsx = (rows) => Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`) }));
// An Antal column is a licence signal (judgeXlsx, fix wave 2 E1).
const LIST = [['Leverantör', 'Produkt', 'Antal', 'Belopp'], ['Binogi', 'Binogi', 10, 100], ['Exempel AB', 'Exempel', 2, 50]];
const REGISTER = [['Avtalsnamn', 'Leverantörsnamn', 'Slutdatum'], ['Exempelavtal', 'Exempel AB', '2027-01-01'], ['Annat', 'Annan AB', '2028-01-01']];
const twoSheets = (a, b) => Buffer.from(zipSync({
  'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Köp" r:id="rId1"/><sheet name="Pivot" r:id="rId2"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${a.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`),
  'xl/worksheets/sheet2.xml': strToU8(`<worksheet><sheetData>${b.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABCD'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`),
}));

function seed(filename, content) {
  n += 1;
  const convId = db.createConversation({ kommun_kod: String(9000 + n), kommun_namn: `Exempelby ${n}`, role: 'central', contact_email: 'r@example.se', scheduled_send_at: '2026-04-01T08:00:00Z' });
  const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: `g${n}`, direction: 'inbound', from_email: 'r@example.se', to_email: 'me@example.com', subject: 's', body_text: 'b', classification: null, classification_confidence: null, received_at: '2026-05-01T10:00:00Z', attachment_count: 1 });
  const path = join(dir, `${n}-${filename}`);
  if (content) writeFileSync(path, content);
  const id = db.recordAttachment({ message_id: msgId, filename, saved_path: path, mime_type: null, size_bytes: 1 });
  db.recordContract({ attachment_id: id, is_contract: 0, document_type: 'följebrev_sammanställning' });
  return id;
}

const answer = (rows) => ({ content: [{ type: 'text', text: JSON.stringify({ is_purchase_list: true, channel: 'skolon', school_year: null, period_start: null, period_end: null, stated_total_sek: null, rows }) }] });
const llmRow = (supplier) => ({ supplier, product: '', quantity: 0, unit: '', amount_sek: 10, period_start: '', period_end: '', school_year: '', grades: [], order_ref: '' });

describe('runPurchaseExtraction', () => {
  it('dry run writes nothing and never calls the LLM', async () => {
    seed('lista.xlsx', xlsx(LIST));
    seed('lista.pdf', Buffer.from('%PDF-1.4'));
    const create = vi.fn();
    const res = await runPurchaseExtraction({ db, client: { messages: { create } } });
    expect(create).not.toHaveBeenCalled();
    expect(db.listPurchaseRows()).toHaveLength(0);
    expect(res.documents.find((d) => d.method === 'xlsx').rows).toHaveLength(2);
    expect(res.would_call_llm).toBe(1);
  });

  it('--apply writes xlsx and LLM rows, and a second run skips what is done', async () => {
    const a = seed('lista.xlsx', xlsx(LIST));
    const b = seed('lista.pdf', Buffer.from('%PDF-1.4'));
    const create = vi.fn(async () => answer([llmRow('Exempel AB'), llmRow('Annan AB')]));
    const res = await runPurchaseExtraction({ db, apply: true, client: { messages: { create } } });
    expect(res.written).toBe(2);
    const rows = db.listPurchaseRows();
    expect(rows.filter((r) => r.attachment_id === a).every((r) => r.method === 'xlsx')).toBe(true);
    expect(rows.filter((r) => r.attachment_id === b).every((r) => r.method === 'llm' && r.channel === 'skolon')).toBe(true);
    const again = await runPurchaseExtraction({ db, apply: true, client: { messages: { create } } });
    expect(again.candidates).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('--attachment targets one document, --force re-extracts it', async () => {
    const a = seed('lista.xlsx', xlsx(LIST));
    seed('annan.xlsx', xlsx(LIST));
    await runPurchaseExtraction({ db, apply: true, onlyId: a });
    expect(new Set(db.listPurchaseRows().map((r) => r.attachment_id))).toEqual(new Set([a]));
    const res = await runPurchaseExtraction({ db, apply: true, onlyId: a, force: true });
    expect(res.written).toBe(1);
    expect(db.listPurchaseRows()).toHaveLength(2);
  });

  it('a transient failure books an attempt up to the cap, a backoff books none', async () => {
    const a = seed('lista.pdf', Buffer.from('%PDF-1.4'));
    const err = (status) => { const e = new Error('x'); e.status = status; return e; };
    const busy = { messages: { create: vi.fn(async () => { throw err(529); }) } };
    await runPurchaseExtraction({ db, apply: true, client: busy });
    expect(db.getPurchaseDocument(a)).toBeNull();
    const broken = { messages: { create: vi.fn(async () => { throw err(500); }) } };
    for (let i = 0; i < MAX_PURCHASE_ATTEMPTS + 1; i += 1) await runPurchaseExtraction({ db, apply: true, client: broken });
    expect(db.getPurchaseDocument(a)).toMatchObject({ status: 'failed', attempts: MAX_PURCHASE_ATTEMPTS });
    expect(broken.messages.create).toHaveBeenCalledTimes(MAX_PURCHASE_ATTEMPTS);
  });

  it('every file missing is an environment fault, nothing booked; one missing file parks', async () => {
    seed('a.xlsx', null); seed('b.xlsx', null); seed('c.xlsx', null);
    const res = await runPurchaseExtraction({ db, apply: true });
    expect(res.env_fault).toBe('contracts_dir_unavailable');
    expect(db.listPurchaseCandidates().every((c) => c.purchase_attempts === 0)).toBe(true);
    const ok = seed('d.xlsx', xlsx(LIST));
    const res2 = await runPurchaseExtraction({ db, apply: true });
    expect(res2.env_fault).toBeNull();
    expect(res2.parked).toHaveLength(3);
    expect(db.listPurchaseRows().every((r) => r.attachment_id === ok)).toBe(true);
  });

  it('every attempt failing transiently is reported as systemic', async () => {
    seed('a.pdf', Buffer.from('%PDF')); seed('b.pdf', Buffer.from('%PDF')); seed('c.pdf', Buffer.from('%PDF'));
    const e = new Error('x'); e.status = 503;
    const res = await runPurchaseExtraction({ db, apply: true, client: { messages: { create: vi.fn(async () => { throw e; }) } } });
    expect(res.systemic).toBe(true);
  });

  it('no API key: the PDF is skipped without an attempt', async () => {
    const a = seed('a.pdf', Buffer.from('%PDF'));
    const res = await runPurchaseExtraction({ db, apply: true, env: {} });
    expect(res.attempted).toBe(0);
    expect(db.getPurchaseDocument(a)).toBeNull();
  });

  // Fix wave 2 E1/E5.
  it('a rejected xlsx is recorded skipped with its reason, never as rows, and is not retried', async () => {
    const a = seed('Lista avtal.xlsx', xlsx(REGISTER));
    const create = vi.fn();
    const res = await runPurchaseExtraction({ db, apply: true, client: { messages: { create } } });
    expect(create).not.toHaveBeenCalled();
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(1);
    expect(db.getPurchaseDocument(a)).toMatchObject({ status: 'skipped', row_count: 0, attempts: 0 });
    expect(db.getPurchaseDocument(a).last_error).toMatch(/avtalsregister/);
    expect(db.listPurchaseRows()).toHaveLength(0);
    expect((await runPurchaseExtraction({ db, apply: true })).candidates).toBe(0);
  });

  it('a forced re-run that now rejects a document removes its old rows', async () => {
    const a = seed('Lista avtal.xlsx', xlsx(REGISTER));
    db.replacePurchaseRows(a, { rows: [{ supplier: 'Exempel AB', product: 'X' }], method: 'xlsx' });
    await runPurchaseExtraction({ db, apply: true, force: true });
    expect(db.listPurchaseRows()).toHaveLength(0);
    expect(db.getPurchaseDocument(a).status).toBe('skipped');
  });

  it('a workbook with an unread data sheet is recorded partial, naming the sheet', async () => {
    const a = seed('Skolon.xlsx', twoSheets(LIST, [['Radetiketter', 'Utfall'], ['Exempel AB', 10], ['Annan AB', 20]]));
    const res = await runPurchaseExtraction({ db, apply: true });
    expect(res.partial).toBe(1);
    expect(db.getPurchaseDocument(a)).toMatchObject({ status: 'partial', row_count: 2 });
    expect(db.getPurchaseDocument(a).last_error).toMatch(/Pivot/);
    expect(db.listPurchaseRows()).toHaveLength(2);
    expect((await runPurchaseExtraction({ db, apply: true })).candidates).toBe(0);
  });

  it('the dry run reports a skip without writing it', async () => {
    const a = seed('Lista avtal.xlsx', xlsx(REGISTER));
    const res = await runPurchaseExtraction({ db });
    expect(res.skipped).toBe(1);
    expect(res.documents[0]).toMatchObject({ id: a, method: 'xlsx', written: false });
    expect(res.documents[0].skipped).toMatch(/avtalsregister/);
    expect(db.getPurchaseDocument(a)).toBeNull();
  });
});
