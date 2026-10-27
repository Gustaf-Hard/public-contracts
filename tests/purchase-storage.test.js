// purchase_rows / purchase_documents (2026-10-27): additive tables for rows
// read out of purchase and licence lists. Temp-dir DB, synthetic data.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, PURCHASE_DOC_TYPES, MAX_PURCHASE_ATTEMPTS } from '../src/storage.js';
import { PURCHASE_DOC_TYPES as LIST_TYPES } from '../src/purchase-list.js';

let tmp; let db;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'purchases-')); db = openDb(join(tmp, 'pilot.db')); db.migrate(); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

function seed({ kod = '9001', namn = 'Exempelby', filename = 'Inköp.xlsx', documentType = 'följebrev_sammanställning', isContract = 0 } = {}) {
  const convId = db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: 'reg@example.se', scheduled_send_at: '2026-04-01T08:00:00Z' });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound', from_email: 'reg@example.se', to_email: 'me@example.com',
    subject: 'Svar', body_text: 'Se bifogat', classification: null, classification_confidence: null, received_at: '2026-05-02T10:00:00Z', attachment_count: 1,
  });
  const attId = db.recordAttachment({ message_id: msgId, filename, saved_path: `data/contracts/${kod}/${filename}`, mime_type: 'application/octet-stream', size_bytes: 10 });
  if (documentType) db.recordContract({ attachment_id: attId, is_contract: isContract, document_type: documentType, summary: 'Lista' });
  return attId;
}

const row = (over = {}) => ({
  supplier: 'Exempel AB', product: 'Exempelverktyg', channel: 'skolon', quantity: 2, unit: 'licens', unit_price_sek: 50,
  amount_sek: 100, order_date: '2025-08-01', period_start: '2025-08-01', period_end: '2026-08-01', school_year: '2025/26',
  grades: ['4-6'], order_ref: 'IN1/001', ...over,
});

describe('purchase storage', () => {
  it('the candidate document types match the extractor', () => {
    expect([...PURCHASE_DOC_TYPES]).toEqual([...LIST_TYPES]);
  });

  it('migrate is idempotent and leaves the contracts tables alone', () => {
    db.migrate();
    const cols = db.raw.prepare('PRAGMA table_info(purchase_rows)').all().map((r) => r.name);
    expect(cols).toEqual(expect.arrayContaining(['attachment_id', 'supplier', 'product', 'channel', 'quantity', 'unit', 'amount_sek', 'period_start', 'period_end', 'school_year', 'grades', 'order_ref', 'extracted_at', 'method']));
  });

  it('replace writes rows and the document record, and lists them with the kommun', () => {
    const att = seed();
    db.replacePurchaseRows(att, { rows: [row(), row({ product: 'Annat', amount_sek: null, grades: [] })], method: 'xlsx', channel: 'skolon', stated_total_sek: 300 });
    const rows = db.listPurchaseRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ attachment_id: att, kommun_kod: '9001', kommun_namn: 'Exempelby', supplier: 'Exempel AB', grades: ['4-6'], method: 'xlsx', stated_total_sek: 300 });
    expect(rows[1].amount_sek).toBeNull();
    expect(rows[0]).not.toHaveProperty('filename');
    expect(db.getPurchaseDocument(att)).toMatchObject({ status: 'rows', row_count: 2, method: 'xlsx', attempts: 0 });
  });

  it('re-extraction replaces an attachment\'s rows and leaves other attachments alone', () => {
    const a = seed(); const b = seed({ kod: '9002', namn: 'Annanby' });
    db.replacePurchaseRows(a, { rows: [row(), row()], method: 'xlsx' });
    db.replacePurchaseRows(b, { rows: [row()], method: 'llm' });
    db.replacePurchaseRows(a, { rows: [row({ product: 'Ny' })], method: 'llm' });
    const rows = db.listPurchaseRows();
    expect(rows.filter((r) => r.attachment_id === a).map((r) => r.product)).toEqual(['Ny']);
    expect(rows.filter((r) => r.attachment_id === b)).toHaveLength(1);
  });

  it('a failed insert rolls back: the old rows survive', () => {
    const a = seed();
    db.replacePurchaseRows(a, { rows: [row()], method: 'xlsx' });
    expect(() => db.replacePurchaseRows(a, { rows: [row(), { ...row(), supplier: { bad: true } }], method: 'xlsx' })).toThrow();
    expect(db.listPurchaseRows()).toHaveLength(1);
  });

  it('a not-a-list verdict stores no rows and is remembered', () => {
    const a = seed();
    db.replacePurchaseRows(a, { rows: [], method: 'llm', isList: false });
    expect(db.listPurchaseRows()).toHaveLength(0);
    expect(db.getPurchaseDocument(a)).toMatchObject({ status: 'not_list', row_count: 0 });
  });

  it('candidates are non-avtal compilations; failures are booked and bounded', () => {
    const a = seed();
    seed({ kod: '9003', filename: 'Avtal.pdf', documentType: 'avtal', isContract: 1 });
    seed({ kod: '9004', filename: 'PUB.pdf', documentType: 'personuppgiftsbiträdesavtal' });
    seed({ kod: '9005', filename: 'Oläst.pdf', documentType: null });
    let c = db.listPurchaseCandidates();
    expect(c.map((x) => x.id)).toEqual([a]);
    expect(c[0]).toMatchObject({ kommun_namn: 'Exempelby', purchase_status: null, purchase_attempts: 0 });

    expect(db.recordPurchaseFailure(a, { reason: 'transient:api_5xx', permanent: false })).toBe(1);
    expect(db.recordPurchaseFailure(a, { reason: 'permanent:document_rejected', permanent: true })).toBe(MAX_PURCHASE_ATTEMPTS);
    c = db.listPurchaseCandidates();
    expect(c[0]).toMatchObject({ purchase_status: 'failed', purchase_attempts: MAX_PURCHASE_ATTEMPTS, purchase_error: 'permanent:document_rejected' });
    // A later success clears the failure.
    db.replacePurchaseRows(a, { rows: [row()], method: 'xlsx' });
    expect(db.getPurchaseDocument(a)).toMatchObject({ status: 'rows', attempts: 0, last_error: null });
  });

  it('a failure after a success keeps the rows already stored', () => {
    const a = seed();
    db.replacePurchaseRows(a, { rows: [row()], method: 'xlsx' });
    db.recordPurchaseFailure(a, { reason: 'transient:api_5xx', permanent: false });
    expect(db.listPurchaseRows()).toHaveLength(1);
  });
});
