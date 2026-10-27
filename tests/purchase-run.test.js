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
const LIST = [['Leverantör', 'Produkt', 'Belopp'], ['Binogi', 'Binogi', 100], ['Exempel AB', 'Exempel', 50]];

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
});
