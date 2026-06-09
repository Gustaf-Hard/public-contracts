// tests/contracts-storage.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'contracts-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Helper: a contract row needs an attachment, which needs a message + conversation.
function seedAttachment({ kommun_kod = '1980', kommun_namn = 'Västerås', filename = 'Avtal X.pdf' } = {}) {
  const convId = db.createConversation({
    kommun_kod, kommun_namn, role: 'central',
    contact_email: 'reg@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`,
    direction: 'inbound', from_email: 'reg@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Se bifogat', classification: null,
    classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const attId = db.recordAttachment({
    message_id: msgId, filename,
    saved_path: `data/contracts/${kommun_kod}/${filename}`,
    mime_type: 'application/pdf', size_bytes: 1000,
  });
  return { convId, msgId, attId };
}

describe('vendors', () => {
  it('upsertVendor creates with kebab-case slug (å/ä/ö folded)', () => {
    const v = db.upsertVendor('Lärömedia Önline');
    expect(v.slug).toBe('laromedia-online');
    expect(v.name).toBe('Lärömedia Önline');
  });

  it('upsertVendor is case-insensitive on name', () => {
    const a = db.upsertVendor('Skolon');
    const b = db.upsertVendor('SKOLON');
    expect(b.id).toBe(a.id);
  });
});

describe('contracts', () => {
  it('recordContract + listContractsForVendor round-trips with kommun info', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Skolon');
    const contractId = db.recordContract({
      attachment_id: attId, vendor_id: v.id,
      avtalsvarde: '120 000', valuta: 'SEK',
      period_start: '2025-08-01', period_end: '2027-07-31',
      is_contract: 1, summary: 'Lärplattform', confidence: 0.95,
      analysis_json: { vendor_name: 'Skolon' }, model: 'claude-opus-4-8',
    });
    db.linkContractProduct(contractId, db.upsertProduct(v.id, 'Skolon Plattform'));

    const rows = db.listContractsForVendor(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kommun_namn).toBe('Västerås');
    expect(rows[0].filename).toBe('Avtal X.pdf');
    expect(rows[0].products).toEqual(['Skolon Plattform']);
  });

  it('recordContract replaces on same attachment_id (re-analysis)', () => {
    const { attId } = seedAttachment();
    const v1 = db.upsertVendor('Fel AB');
    db.recordContract({ attachment_id: attId, vendor_id: v1.id, is_contract: 1 });
    const v2 = db.upsertVendor('Rätt AB');
    db.recordContract({ attachment_id: attId, vendor_id: v2.id, is_contract: 1 });
    expect(db.listContractsForVendor(v1.id)).toHaveLength(0);
    expect(db.listContractsForVendor(v2.id)).toHaveLength(1);
  });

  it('listPendingContractAttachments returns PDFs without contracts row only', () => {
    const a = seedAttachment({ filename: 'A.pdf' });
    // Distinct kommun_kod so the second conversation doesn't collide on the
    // conversations(kommun_kod, role) unique constraint; same kommun_namn.
    const b = seedAttachment({ filename: 'B.pdf', kommun_kod: '0180' });
    db.recordContract({ attachment_id: a.attId, vendor_id: null, is_contract: 0 });
    const pending = db.listPendingContractAttachments();
    expect(pending.map((p) => p.id)).toEqual([b.attId]);
    expect(pending[0].kommun_namn).toBe('Västerås');
  });
});

describe('listVendorsOverview', () => {
  it('aggregates contract count, kommun count, products', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Skolon');
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    db.linkContractProduct(cId, db.upsertProduct(v.id, 'Plattform'));
    const rows = db.listVendorsOverview();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Skolon', slug: 'skolon', contract_count: 1, kommun_count: 1 });
    expect(rows[0].products).toEqual(['Plattform']);
  });

  it('getVendorBySlug finds vendor, returns undefined otherwise', () => {
    db.upsertVendor('Skolon');
    expect(db.getVendorBySlug('skolon').name).toBe('Skolon');
    expect(db.getVendorBySlug('nope')).toBeUndefined();
  });
});

describe('listHandoffContacts', () => {
  function seedConvWithHandoff({ kommun_kod = '1984', role = 'central', handoff_email = 'barn.utbildning@arboga.se', handoff_forv = 'Barn- och utbildningsförvaltningen' } = {}) {
    const convId = db.createConversation({
      kommun_kod, kommun_namn: 'Arboga', role,
      contact_email: 'arboga.kommun@arboga.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta BoU',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: handoff_email, handoff_to_forvaltning: handoff_forv } },
    });
    return convId;
  }

  it('extracts handoff_to_email + forvaltning + role for a kommun', () => {
    seedConvWithHandoff();
    const rows = db.listHandoffContacts('1984');
    expect(rows).toEqual([
      { email: 'barn.utbildning@arboga.se', forvaltning: 'Barn- och utbildningsförvaltningen', role: 'central' },
    ]);
  });

  it('dedups repeated handoff addresses (case-insensitive)', () => {
    seedConvWithHandoff();
    seedConvWithHandoff({ role: 'utbildning', handoff_email: 'BARN.UTBILDNING@arboga.se' });
    const rows = db.listHandoffContacts('1984');
    expect(rows).toHaveLength(1);
  });

  it('ignores messages without a handoff address; empty for unknown kommun', () => {
    const convId = db.createConversation({
      kommun_kod: '1980', kommun_namn: 'Västerås', role: 'central',
      contact_email: 'r@v.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'r@v.se', to_email: 'me@x.com', subject: 'Re', body_text: 'hej',
      classification: 'auto_ack', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'auto_ack', extracted: { handoff_to_email: null } },
    });
    expect(db.listHandoffContacts('1980')).toEqual([]);
    expect(db.listHandoffContacts('0000')).toEqual([]);
  });
});
