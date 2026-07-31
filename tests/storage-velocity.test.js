import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vel-'));
  db = openDb(join(dir, 'test.db'));
  db.migrate();
});
afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

function seedCase({ kod, namn, out, inbounds = [] }) {
  const convId = db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role: 'central',
    contact_email: `k@${kod}.se`, scheduled_send_at: out,
  });
  db.recordMessage({
    conversation_id: convId, gmail_message_id: `out-${kod}`, direction: 'outbound',
    from_email: 'me@x.se', to_email: `k@${kod}.se`, subject: 'B', body_text: 'b',
    classification: null, classification_confidence: null, received_at: out, attachment_count: 0,
  });
  for (const [i, m] of inbounds.entries()) {
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `in-${kod}-${i}`, direction: 'inbound',
      from_email: `k@${kod}.se`, to_email: 'me@x.se', subject: 'Sv', body_text: 'b',
      classification: m.cls, classification_confidence: 0.9, received_at: m.at, attachment_count: 0,
    });
  }
  return convId;
}

// attachments.saved_path is NOT NULL, so every fixture attachment needs one.
function addAttachment(msgId, filename) {
  return db.raw.prepare(
    'INSERT INTO attachments (message_id, filename, saved_path, mime_type, size_bytes) VALUES (?,?,?,?,?)'
  ).run(msgId, filename, `/tmp/${filename}`, 'application/pdf', 10).lastInsertRowid;
}

function addContract(attachmentId, vendorId, isContract, documentType) {
  db.raw.prepare(
    'INSERT INTO contracts (attachment_id, vendor_id, is_contract, document_type, analysis_json) VALUES (?,?,?,?,?)'
  ).run(attachmentId, vendorId, isContract, documentType, '{}');
}

describe('velocity storage queries', () => {
  it('first_human_inbound_at skips auto_ack and auto_reply but accepts unknown', () => {
    seedCase({ kod: '0001', namn: 'Alfa', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'auto_ack', at: '2026-07-01T01:00:00Z' },    // robot — skipped
      { cls: 'auto_reply', at: '2026-07-02T00:00:00Z' },  // robot — skipped
      { cls: 'unknown', at: '2026-07-04T00:00:00Z' },     // human — this one counts
      { cls: 'delivery', at: '2026-07-05T00:00:00Z' },
    ] });
    const [row] = db.listCaseTimings();
    expect(row.first_outbound_at).toBe('2026-07-01T00:00:00Z');
    expect(row.first_human_inbound_at).toBe('2026-07-04T00:00:00Z');
  });

  it('treats a NULL classification as human, not as a robot', () => {
    seedCase({ kod: '0004', namn: 'Delta', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: null, at: '2026-07-02T00:00:00Z' },
    ] });
    expect(db.listCaseTimings()[0].first_human_inbound_at).toBe('2026-07-02T00:00:00Z');
  });

  it('reports a contacted kommun with no human reply as null, not missing', () => {
    seedCase({ kod: '0002', namn: 'Beta', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'auto_ack', at: '2026-07-01T02:00:00Z' },
    ] });
    const rows = db.listCaseTimings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kommun_namn: 'Beta', first_human_inbound_at: null, first_contract_at: null });
  });

  it('counts only is_contract=1 as a delivery event, and splits files by type', () => {
    const convId = seedCase({ kod: '0003', namn: 'Gamma', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'delivery', at: '2026-07-08T00:00:00Z' },
    ] });
    const msgId = db.raw.prepare("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'inbound'").get(convId).id;
    const a1 = addAttachment(msgId, 'avtal.pdf');
    const a2 = addAttachment(msgId, 'bilaga.pdf');
    const vId = db.upsertVendor('Testleverantör').id;
    addContract(a1, vId, 1, 'avtal');
    addContract(a2, vId, 0, 'bilaga');

    const events = db.listContractDeliveryEvents();
    expect(events).toEqual([{ conversation_id: convId, kommun_namn: 'Gamma', received_at: '2026-07-08T00:00:00Z' }]);
    expect(db.listCaseTimings()[0].first_contract_at).toBe('2026-07-08T00:00:00Z');

    const files = db.countFilesByDocumentType();
    expect(files.total).toBe(2);
    expect(files.by_type).toEqual(expect.arrayContaining([
      { document_type: 'avtal', n: 1 }, { document_type: 'bilaga', n: 1 },
    ]));
  });

  it('labels an attachment with no contract row as not analysed rather than dropping it', () => {
    const convId = seedCase({ kod: '0005', namn: 'Epsilon', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'delivery', at: '2026-07-08T00:00:00Z' },
    ] });
    const msgId = db.raw.prepare("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'inbound'").get(convId).id;
    addAttachment(msgId, 'vantar.pdf');
    const files = db.countFilesByDocumentType();
    expect(files.total).toBe(1);
    expect(files.by_type).toEqual([{ document_type: 'ej analyserad', n: 1 }]);
  });
});
