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

describe('lifecycle + refresh columns (2026-07-09 perpetual-refresh design)', () => {
  it('migrate is idempotent — running twice leaves each new column present once', () => {
    expect(() => { db.migrate(); db.migrate(); }).not.toThrow();
    const cCols = db.raw.prepare("PRAGMA table_info(contracts)").all().map((r) => r.name);
    for (const col of ['auto_renews', 'renewal_term', 'last_cancellation_date', 'extension_option_until']) {
      expect(cCols.filter((n) => n === col)).toHaveLength(1);
    }
    const convCols = db.raw.prepare("PRAGMA table_info(conversations)").all().map((r) => r.name);
    for (const col of ['next_review_at', 'next_review_source', 'refresh_round']) {
      expect(convCols.filter((n) => n === col)).toHaveLength(1);
    }
  });

  it('recordContract round-trips the lifecycle fields (auto_renews stored as 0/1)', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Tieto');
    db.recordContract({
      attachment_id: attId, vendor_id: v.id, is_contract: 1,
      period_end: '2026-12-31', auto_renews: true, renewal_term: '1 år',
      last_cancellation_date: '2026-09-30', extension_option_until: null,
    });
    const row = db.listContractsForKommun('1980').find((r) => r.vendor_name === 'Tieto');
    expect(row.auto_renews).toBe(1);
    expect(row.renewal_term).toBe('1 år');
    expect(row.last_cancellation_date).toBe('2026-09-30');
    expect(row.extension_option_until).toBeNull();
  });

  it('recordContract with auto_renews undefined stores NULL (not 0)', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Okänd');
    db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    const row = db.listContractsForKommun('1980')[0];
    expect(row.auto_renews).toBeNull();
  });

  it('updateConversationState persists next_review_at / source / refresh_round', () => {
    const id = db.createConversation({
      kommun_kod: '1489', kommun_namn: 'Alingsås', role: 'central',
      contact_email: 'reg@alingsas.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.updateConversationState(id, 'DONE', {
      next_review_at: '2026-10-01', next_review_source: 'Skola24', refresh_round: 1,
    });
    const conv = db.getConversation(id);
    expect(conv.next_review_at).toBe('2026-10-01');
    expect(conv.next_review_source).toBe('Skola24');
    expect(conv.refresh_round).toBe(1);
  });

  it('listConversationsDueForRefresh selects only armed DONE convs at/before today', () => {
    const mk = (kod, state, review) => {
      const id = db.createConversation({
        kommun_kod: kod, kommun_namn: `K${kod}`, role: 'central',
        contact_email: `reg@${kod}.se`, scheduled_send_at: '2026-04-01T08:00:00Z',
      });
      db.updateConversationState(id, state, review ? { next_review_at: review } : {});
      return id;
    };
    const due = mk('0001', 'DONE', '2026-07-01');
    mk('0002', 'DONE', '2026-08-01');       // future → not due
    mk('0003', 'SENT', '2026-07-01');       // not DONE
    mk('0004', 'DONE', null);               // not armed
    const rows = db.listConversationsDueForRefresh('2026-07-09');
    expect(rows.map((r) => r.id)).toEqual([due]);
  });
});

describe('pricing columns (2026-07-09 vendor-data-center design)', () => {
  const PRICING_COLS = ['annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek', 'unit', 'quantity', 'value_incl_moms'];

  it('migrate is idempotent — pricing columns present exactly once after two runs', () => {
    expect(() => { db.migrate(); db.migrate(); }).not.toThrow();
    const cols = db.raw.prepare("PRAGMA table_info(contracts)").all().map((r) => r.name);
    for (const col of PRICING_COLS) {
      expect(cols.filter((n) => n === col)).toHaveLength(1);
    }
  });

  it('migrate adds pricing columns to a pre-existing DB created without them', () => {
    // Simulate a live DB from before this feature: contracts table without
    // the pricing (or lifecycle) columns, then migrate — the guarded ALTERs
    // must add them without touching existing rows.
    const path2 = join(tmp, 'old.db');
    const Database = db.raw.constructor;
    const old = new Database(path2);
    old.exec(`
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY,
        attachment_id INTEGER NOT NULL UNIQUE,
        vendor_id INTEGER,
        avtalsvarde TEXT, valuta TEXT, period_start TEXT, period_end TEXT,
        is_contract INTEGER NOT NULL DEFAULT 1,
        summary TEXT, confidence REAL, analysis_json TEXT, model TEXT,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO contracts (attachment_id, avtalsvarde) VALUES (1, '129 tkr/år');
    `);
    old.close();
    const db2 = openDb(path2);
    expect(() => { db2.migrate(); db2.migrate(); }).not.toThrow();
    const cols = db2.raw.prepare("PRAGMA table_info(contracts)").all().map((r) => r.name);
    for (const col of [...PRICING_COLS, 'auto_renews']) expect(cols).toContain(col);
    const row = db2.raw.prepare('SELECT * FROM contracts WHERE attachment_id = 1').get();
    expect(row.avtalsvarde).toBe('129 tkr/år');
    expect(row.annual_value_sek).toBeNull();
    db2.close();
  });

  it('recordContract round-trips the pricing fields', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Radish');
    db.recordContract({
      attachment_id: attId, vendor_id: v.id, is_contract: 1,
      avtalsvarde: '2025: 40 kr/elev (3744 elever)',
      annual_value_sek: 149760, one_time_value_sek: null,
      pricing_model: 'per_student', unit_price_sek: 40, unit: 'elev', quantity: 3744,
      value_incl_moms: false,
    });
    const row = db.raw.prepare('SELECT * FROM contracts WHERE attachment_id = ?').get(attId);
    expect(row.annual_value_sek).toBe(149760);
    expect(row.pricing_model).toBe('per_student');
    expect(row.unit_price_sek).toBe(40);
    expect(row.unit).toBe('elev');
    expect(row.quantity).toBe(3744);
    expect(row.value_incl_moms).toBe(0);
    expect(row.one_time_value_sek).toBeNull();
  });

  it('recordContract with pricing fields absent stores NULLs (never 0)', () => {
    const { attId } = seedAttachment();
    db.recordContract({ attachment_id: attId, vendor_id: null, is_contract: 1 });
    const row = db.raw.prepare('SELECT * FROM contracts WHERE attachment_id = ?').get(attId);
    for (const col of ['annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek', 'unit', 'quantity', 'value_incl_moms']) {
      expect(row[col]).toBeNull();
    }
  });

  it('value_incl_moms true stores 1, null stays NULL', () => {
    const a = seedAttachment({ filename: 'A.pdf' });
    const b = seedAttachment({ filename: 'B.pdf', kommun_kod: '0180' });
    db.recordContract({ attachment_id: a.attId, is_contract: 1, value_incl_moms: true });
    db.recordContract({ attachment_id: b.attId, is_contract: 1, value_incl_moms: null });
    expect(db.raw.prepare('SELECT value_incl_moms FROM contracts WHERE attachment_id = ?').get(a.attId).value_incl_moms).toBe(1);
    expect(db.raw.prepare('SELECT value_incl_moms FROM contracts WHERE attachment_id = ?').get(b.attId).value_incl_moms).toBeNull();
  });
});

describe('listContractFacts', () => {
  it('returns one row per stored contract (is_contract=1) with vendor, kommun, pricing, lifecycle and products', () => {
    const a = seedAttachment({ filename: 'Skolon.pdf' });                       // Västerås
    const b = seedAttachment({ filename: 'Radish.pdf', kommun_kod: '0180', kommun_namn: 'Stockholm' });
    const c = seedAttachment({ filename: 'Brev.pdf', kommun_kod: '1489', kommun_namn: 'Alingsås' });
    const skolon = db.upsertVendor('Skolon');
    const radish = db.upsertVendor('Radish');
    const c1 = db.recordContract({
      attachment_id: a.attId, vendor_id: skolon.id, is_contract: 1,
      avtalsvarde: '170 000 SEK/år', annual_value_sek: 170000, pricing_model: 'per_user',
      unit_price_sek: 50, unit: 'användare', quantity: 3400,
      period_start: '2024-03-01', period_end: '2026-03-01',
      auto_renews: true, last_cancellation_date: '2025-12-01',
    });
    db.linkContractProduct(c1, db.upsertProduct(skolon.id, 'Skolon Plattform'));
    db.recordContract({
      attachment_id: b.attId, vendor_id: radish.id, is_contract: 1,
      pricing_model: 'per_student', period_end: '2028-12-31',
    });
    // Non-contract (följebrev) must be excluded.
    db.recordContract({ attachment_id: c.attId, vendor_id: null, is_contract: 0 });

    const facts = db.listContractFacts();
    expect(facts).toHaveLength(2);
    const f1 = facts.find((f) => f.filename === 'Skolon.pdf');
    expect(f1).toMatchObject({
      vendor_name: 'Skolon', vendor_slug: 'skolon',
      kommun_kod: '1980', kommun_namn: 'Västerås',
      annual_value_sek: 170000, pricing_model: 'per_user',
      unit_price_sek: 50, unit: 'användare', quantity: 3400,
      period_start: '2024-03-01', period_end: '2026-03-01',
      auto_renews: 1, last_cancellation_date: '2025-12-01',
    });
    expect(f1.products).toEqual(['Skolon Plattform']);
    expect(f1.attachment_id).toBe(a.attId);
    const f2 = facts.find((f) => f.filename === 'Radish.pdf');
    expect(f2.vendor_name).toBe('Radish');
    expect(f2.annual_value_sek).toBeNull();
    expect(f2.products).toEqual([]);
  });

  it('includes vendor-less contract rows (vendor unknown, still a contract)', () => {
    const a = seedAttachment();
    db.recordContract({ attachment_id: a.attId, vendor_id: null, is_contract: 1 });
    const facts = db.listContractFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0].vendor_name).toBeNull();
  });
});

describe('product intelligence tables (2026-07-10 design)', () => {
  it('migrate is idempotent — line-item/coverage tables + indexes exist once after two runs', () => {
    expect(() => { db.migrate(); db.migrate(); }).not.toThrow();
    const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(tables.filter((n) => n === 'contract_line_items')).toHaveLength(1);
    expect(tables.filter((n) => n === 'contract_coverage')).toHaveLength(1);
    const indexes = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(indexes.filter((n) => n === 'idx_line_items_contract')).toHaveLength(1);
    expect(indexes.filter((n) => n === 'idx_coverage_contract')).toHaveLength(1);
  });

  it('migrate adds the tables to a pre-existing DB created without them', () => {
    const path2 = join(tmp, 'old-pi.db');
    const Database = db.raw.constructor;
    const old = new Database(path2);
    old.exec(`
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY,
        attachment_id INTEGER NOT NULL UNIQUE,
        vendor_id INTEGER,
        avtalsvarde TEXT, valuta TEXT, period_start TEXT, period_end TEXT,
        is_contract INTEGER NOT NULL DEFAULT 1,
        summary TEXT, confidence REAL, analysis_json TEXT, model TEXT,
        analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO contracts (attachment_id, avtalsvarde) VALUES (1, '129 tkr/år');
    `);
    old.close();
    const db2 = openDb(path2);
    expect(() => { db2.migrate(); db2.migrate(); }).not.toThrow();
    const tables = db2.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(tables).toContain('contract_line_items');
    expect(tables).toContain('contract_coverage');
    expect(db2.raw.prepare('SELECT avtalsvarde FROM contracts WHERE attachment_id = 1').get().avtalsvarde).toBe('129 tkr/år');
    db2.close();
  });

  it('replaceContractLineItems + listLineItemsForContract round-trip (Ale ILT shape)', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('ILT Education');
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    const pid = db.upsertProduct(v.id, 'Begreppa');
    db.replaceContractLineItems(cId, [
      { product_id: pid, product_name: 'Begreppa', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 116244 },
      { product_id: pid, product_name: 'Begreppa', description: '3,5 mån tidigare pris', unit_price_sek: null, unit: null, quantity: null, period_months: 3.5, amount_sek: 50341 },
      { product_id: null, product_name: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, period_months: null, amount_sek: 168300 },
    ]);
    const rows = db.listLineItemsForContract(cId);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ contract_id: cId, product_id: pid, product_name: 'Begreppa', amount_sek: 116244 });
    expect(rows[1]).toMatchObject({ description: '3,5 mån tidigare pris', period_months: 3.5, amount_sek: 50341 });
    expect(rows[2]).toMatchObject({ product_id: null, product_name: 'Polyglutt', unit_price_sek: 100, unit: 'barn', quantity: 1683, amount_sek: 168300 });
    // Replace is idempotent, not additive.
    db.replaceContractLineItems(cId, [
      { product_name: 'Polyglutt', amount_sek: 168300 },
    ]);
    expect(db.listLineItemsForContract(cId)).toHaveLength(1);
  });

  it('replaceContractCoverage + listCoverageForContract round-trip (one row per product × grade)', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('ILT Education');
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    db.replaceContractCoverage(cId, [
      { product_id: null, product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 },
      { product_id: null, product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null },
      { product_id: null, product_name: 'Begreppa', grade_level: 'Gymnasiet', status: 'partial', student_count: 120 },
    ]);
    const rows = db.listCoverageForContract(cId);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.grade_level === 'Förskola')).toMatchObject({ product_name: 'Polyglutt', status: 'full', student_count: 1683 });
    expect(rows.find((r) => r.grade_level === 'Gymnasiet')).toMatchObject({ product_name: 'Begreppa', status: 'partial' });
    db.replaceContractCoverage(cId, []);
    expect(db.listCoverageForContract(cId)).toHaveLength(0);
  });

  it('recordContract re-analysis replacement clears the old contract line items + coverage (no FK error)', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('ILT Education');
    const c1 = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    db.replaceContractLineItems(c1, [{ product_name: 'Begreppa', amount_sek: 166585 }]);
    db.replaceContractCoverage(c1, [{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null }]);
    // Re-analysis re-records for the same attachment — must not throw on FK
    // (foreign_keys=ON would block deleting a contracts row with children).
    // Note SQLite may reuse the freed rowid, so assert on emptiness, not ids.
    let c2;
    expect(() => { c2 = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 }); }).not.toThrow();
    expect(db.listLineItemsForContract(c1)).toHaveLength(0);
    expect(db.listLineItemsForContract(c2)).toHaveLength(0); // caller re-writes explicitly
    expect(db.listCoverageForContract(c1)).toHaveLength(0);
    expect(db.listCoverageForContract(c2)).toHaveLength(0);
  });

  it('listLineItems / listCoverage return all rows for stored contracts (is_contract=1 only)', () => {
    const a = seedAttachment({ filename: 'ILT.pdf' });
    const b = seedAttachment({ filename: 'Brev.pdf', kommun_kod: '0180' });
    const v = db.upsertVendor('ILT Education');
    const c1 = db.recordContract({ attachment_id: a.attId, vendor_id: v.id, is_contract: 1 });
    const c2 = db.recordContract({ attachment_id: b.attId, vendor_id: null, is_contract: 0 });
    db.replaceContractLineItems(c1, [{ product_name: 'Begreppa', amount_sek: 166585 }]);
    db.replaceContractLineItems(c2, [{ product_name: 'Spök', amount_sek: 1 }]);
    db.replaceContractCoverage(c1, [{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null }]);
    db.replaceContractCoverage(c2, [{ product_name: 'Spök', grade_level: '1-3', status: 'full', student_count: null }]);
    const items = db.listLineItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ contract_id: c1, product_name: 'Begreppa', amount_sek: 166585 });
    const cov = db.listCoverage();
    expect(cov).toHaveLength(1);
    expect(cov[0]).toMatchObject({ contract_id: c1, product_name: 'Begreppa', grade_level: '1-3', status: 'full' });
  });

  it('countProductIntelligence reports row + contract counts for the backfill verify step', () => {
    const a = seedAttachment({ filename: 'ILT.pdf' });
    const v = db.upsertVendor('ILT Education');
    const c1 = db.recordContract({ attachment_id: a.attId, vendor_id: v.id, is_contract: 1 });
    expect(db.countProductIntelligence()).toEqual({
      line_items: 0, coverage: 0, contracts_with_line_items: 0, contracts_with_coverage: 0,
    });
    db.replaceContractLineItems(c1, [
      { product_name: 'Begreppa', amount_sek: 116244 },
      { product_name: 'Begreppa', amount_sek: 50341 },
    ]);
    db.replaceContractCoverage(c1, [{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null }]);
    expect(db.countProductIntelligence()).toEqual({
      line_items: 2, coverage: 1, contracts_with_line_items: 1, contracts_with_coverage: 1,
    });
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
