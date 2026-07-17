import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analysePendingContracts } from '../src/analyse-contract.js';
import { parseArgs, formatIntelligenceCounts } from '../scripts/07-reanalyse-lifecycle.js';
import { mergePreserving, storeContractAnalysis } from '../src/analyse-contract.js';
import { openDb } from '../src/storage.js';

describe('07-reanalyse-lifecycle parseArgs (pure)', () => {
  it('defaults: no dry-run, no db override, no onlyId, no counts', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, dbPath: null, onlyId: null, counts: false });
  });
  it('parses --dry-run', () => {
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
  });
  it('parses --db= override', () => {
    expect(parseArgs(['--db=/tmp/x.db']).dbPath).toBe('/tmp/x.db');
  });
  it('parses --only= as an integer attachment id', () => {
    expect(parseArgs(['--only=42']).onlyId).toBe(42);
  });
  it('ignores a non-numeric --only=', () => {
    expect(parseArgs(['--only=abc']).onlyId).toBeNull();
  });
  it('parses --counts (read-only verify mode for the product-intelligence backfill)', () => {
    expect(parseArgs(['--counts']).counts).toBe(true);
  });
});

describe('formatIntelligenceCounts (pure)', () => {
  it('renders the countProductIntelligence shape as one auditable line', () => {
    const s = formatIntelligenceCounts({
      line_items: 12, coverage: 34, contracts_with_line_items: 5, contracts_with_coverage: 7,
    });
    expect(s).toContain('12 line items');
    expect(s).toContain('5 contracts');
    expect(s).toContain('34 coverage rows');
    expect(s).toContain('7 contracts');
  });
});

// Finding 6: re-analysis must be NON-DESTRUCTIVE — a degraded second pass may
// never flip a good is_contract=1 to false or null out a set period/vendor.
describe('mergePreserving (pure) — guards a good row against a degraded re-run', () => {
  const good = {
    is_contract: 1, vendor_name: 'Skolon', period_start: '2024-01-01', period_end: '2026-12-31',
    avtalsvarde: '100 000 kr/år', valuta: 'SEK', auto_renews: 1, renewal_term: '1 år',
    last_cancellation_date: '2026-09-30', extension_option_until: null,
  };

  it('no existing row → fresh analysis passes through unchanged', () => {
    const fresh = { is_contract: true, vendor_name: 'Ny', period_end: '2027-01-01' };
    expect(mergePreserving(null, fresh).merged).toBe(fresh);
  });

  it('never flips a good is_contract=1 to false', () => {
    const degraded = { is_contract: false, vendor_name: null, period_end: null, auto_renews: false };
    const { merged, changes } = mergePreserving(good, degraded);
    expect(merged.is_contract).toBe(true);
    expect(changes.some(([f]) => f === 'is_contract')).toBe(true);
  });

  // 2026-07-15 contract-validation: a CONFIDENT non-avtal re-classification must
  // flip is_contract 1 → 0 and adopt the new document_type. This resolves the
  // Huddinge contradiction (rows stuck at is_contract=1 + document_type='övrigt'/
  // 'bilaga'). Only the classification flips — extracted data stays fill-only.
  it('flips is_contract 1 → 0 on a confident non-avtal verdict (Huddinge: bilaga)', () => {
    const fresh = { is_contract: false, document_type: 'bilaga', vendor_name: null, confidence: 0.9 };
    const { merged, changes } = mergePreserving(good, fresh);
    expect(merged.is_contract).toBe(false);
    expect(merged.document_type).toBe('bilaga');
    // data preserved fill-only — the flip must not wipe a known vendor/period
    expect(merged.vendor_name).toBe('Skolon');
    expect(merged.period_end).toBe('2026-12-31');
    expect(changes.some(([f]) => f === 'is_contract')).toBe(true);
  });

  it('flips is_contract 1 → 0 on a confident övrigt verdict too', () => {
    const fresh = { is_contract: false, document_type: 'övrigt', confidence: 0.85 };
    expect(mergePreserving(good, fresh).merged.is_contract).toBe(false);
    expect(mergePreserving(good, fresh).merged.document_type).toBe('övrigt');
  });

  it('does NOT flip on a LOW-confidence non-contract verdict (stays consistent avtal)', () => {
    const shaky = { is_contract: false, document_type: 'övrigt', confidence: 0.4 };
    const { merged } = mergePreserving(good, shaky);
    expect(merged.is_contract).toBe(true);
    // consistency: a preserved positive must not carry a non-avtal document_type
    expect(merged.document_type).not.toBe('övrigt');
  });

  it('preserves a set period/vendor when the new pass returns null (fill-only)', () => {
    const degraded = { is_contract: true, vendor_name: null, period_end: null, period_start: null, auto_renews: true };
    const { merged } = mergePreserving(good, degraded);
    expect(merged.vendor_name).toBe('Skolon');
    expect(merged.period_end).toBe('2026-12-31');
    expect(merged.period_start).toBe('2024-01-01');
  });

  it('does not clear a known auto_renews=true', () => {
    const degraded = { is_contract: true, vendor_name: 'Skolon', period_end: '2026-12-31', auto_renews: false };
    expect(mergePreserving(good, degraded).merged.auto_renews).toBe(true);
  });

  it('a genuinely improved (non-null) field DOES overwrite', () => {
    const better = { is_contract: true, vendor_name: 'Skolon', period_end: '2027-06-30', auto_renews: true };
    const { merged, changes } = mergePreserving(good, better);
    expect(merged.period_end).toBe('2027-06-30');
    expect(changes.some(([f]) => f === 'period_end')).toBe(true);
  });

  // Product intelligence (2026-07-10 design): line_items / coverage arrays are
  // fill-only too — an empty array from a degraded re-run is "no signal".
  it('preserves existing line_items / coverage rows when the new pass returns empty arrays', () => {
    const withRows = {
      ...good,
      line_items: [{ product_name: 'Begreppa', amount_sek: 166585 }],
      coverage: [{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null }],
    };
    const degraded = { is_contract: true, vendor_name: 'Skolon', line_items: [], coverage: [] };
    const { merged, changes } = mergePreserving(withRows, degraded);
    expect(merged.line_items).toEqual(withRows.line_items);
    expect(merged.coverage).toEqual(withRows.coverage);
    expect(changes.some(([f]) => f === 'line_items')).toBe(true);
    expect(changes.some(([f]) => f === 'coverage')).toBe(true);
  });

  it('non-empty new line_items / coverage DO replace the old rows', () => {
    const withRows = {
      ...good,
      line_items: [{ product_name: 'Begreppa', amount_sek: 166585 }],
      coverage: [{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: null }],
    };
    const better = {
      is_contract: true, vendor_name: 'Skolon',
      line_items: [{ product_name: 'Polyglutt', amount_sek: 168300 }],
      coverage: [{ product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full', student_count: 1683 }],
    };
    const { merged } = mergePreserving(withRows, better);
    expect(merged.line_items).toEqual(better.line_items);
    expect(merged.coverage).toEqual(better.coverage);
  });
});

describe('storeContractAnalysis — a degraded re-run preserves the good stored row', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pilot-reanalyse-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  function seedAttachment() {
    const convId = db.createConversation({ kommun_kod: '1489', kommun_namn: 'Alingsås', role: 'central', contact_email: 'r@a.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: 'g1', direction: 'inbound', from_email: 'r@a.se', to_email: 'me@x.se', subject: 's', body_text: '', classification: null, classification_confidence: null, received_at: '2026-05-01T00:00:00Z', attachment_count: 1 });
    return db.recordAttachment({ message_id: msgId, filename: 'skolon.pdf', saved_path: '/tmp/skolon.pdf', mime_type: 'application/pdf', size_bytes: 10 });
  }

  it('a good is_contract=1 with a period survives a degraded (is_contract=false, null period) re-analysis', () => {
    const attId = seedAttachment();
    // First pass — a good contract.
    storeContractAnalysis(db, attId, {
      is_contract: true, vendor_name: 'Skolon', products: [], avtalsvarde: '100 000 kr/år', valuta: 'SEK',
      period_start: '2024-01-01', period_end: '2026-12-31', auto_renews: true, renewal_term: '1 år',
      last_cancellation_date: '2026-09-30', extension_option_until: null, summary: 'ok', confidence: 0.95, mentioned_agreements: [],
    }, { model: 'm1' });

    // Degraded re-run (simulating a flaky LLM second pass).
    storeContractAnalysis(db, attId, {
      is_contract: false, vendor_name: null, products: [], avtalsvarde: null, valuta: null,
      period_start: null, period_end: null, auto_renews: false, renewal_term: null,
      last_cancellation_date: null, extension_option_until: null, summary: 'osäker', confidence: 0.3, mentioned_agreements: [],
    }, { model: 'm2' });

    const row = db.raw.prepare(`
      SELECT c.is_contract, c.period_start, c.period_end, c.auto_renews, v.name AS vendor_name
      FROM contracts c LEFT JOIN vendors v ON v.id = c.vendor_id WHERE c.attachment_id = ?
    `).get(attId);
    expect(row.is_contract).toBe(1);          // NOT flipped to 0
    expect(row.vendor_name).toBe('Skolon');   // NOT nulled
    expect(row.period_end).toBe('2026-12-31'); // NOT nulled
    expect(row.period_start).toBe('2024-01-01');
    expect(row.auto_renews).toBe(1);          // NOT cleared
  });
});

// The product-intelligence backfill IS the existing force re-analysis: one
// pass over stored PDFs populates contract_line_items + contract_coverage
// (2026-07-10 design). Verified offline with a fake client.
describe('force re-analysis populates line items + coverage (backfill path)', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pilot-backfill-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  it('re-analysing an already-stored contract fills the new tables; counts never regress', async () => {
    const convId = db.createConversation({ kommun_kod: '1440', kommun_namn: 'Ale', role: 'central', contact_email: 'r@ale.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: 'g1', direction: 'inbound', from_email: 'r@ale.se', to_email: 'me@x.se', subject: 's', body_text: '', classification: null, classification_confidence: null, received_at: '2026-06-01T00:00:00Z', attachment_count: 1 });
    const savedPath = join(tmp, 'contracts', '1440', 'ilt.pdf');
    mkdirSync(dirname(savedPath), { recursive: true });
    writeFileSync(savedPath, '%PDF-1.4 fake');
    const attId = db.recordAttachment({ message_id: msgId, filename: 'ilt.pdf', saved_path: savedPath, mime_type: 'application/pdf', size_bytes: 12 });

    // Pre-backfill state: analysed with the OLD schema (no line items).
    storeContractAnalysis(db, attId, {
      is_contract: true, vendor_name: 'ILT Education', products: ['Begreppa', 'Polyglutt'],
      avtalsvarde: '585 649 SEK år 1', valuta: 'SEK', period_start: '2025-01-31', period_end: '2028-01-30',
      summary: 'ok', confidence: 0.95, mentioned_agreements: [],
    }, { model: 'old' });
    expect(db.countProductIntelligence()).toMatchObject({ line_items: 0, coverage: 0 });

    // The backfill: force re-analysis with the new-schema output.
    const client = {
      messages: {
        create: vi.fn(async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              is_contract: true, document_type: 'avtal', vendor_name: 'ILT Education',
              products: ['Begreppa', 'Polyglutt'], avtalsvarde: '585 649 SEK år 1', valuta: 'SEK',
              period_start: '2025-01-31', period_end: '2028-01-30',
              auto_renews: false, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
              annual_value_sek: 585649, one_time_value_sek: null, pricing_model: 'tiered',
              unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
              line_items: [
                { product: 'Begreppa', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 116244 },
                { product: 'Begreppa', description: '3,5 mån tidigare pris', unit_price_sek: null, unit: null, quantity: null, period_months: 3.5, amount_sek: 50341 },
                { product: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, period_months: null, amount_sek: 168300 },
              ],
              coverage: [
                { product: 'Polyglutt', unit_text: 'Alla kommunala förskolor (1 683)', grade_levels: ['Förskola'], status: 'full', student_count: 1683 },
              ],
              whole_municipality: false,
              summary: 'ok', confidence: 0.95, mentioned_agreements: [],
            }),
          }],
        })),
      },
    };
    const n = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client, force: true });
    expect(n).toBe(1);
    const counts = db.countProductIntelligence();
    expect(counts).toEqual({ line_items: 3, coverage: 1, contracts_with_line_items: 1, contracts_with_coverage: 1 });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    expect(db.listLineItemsForContract(cId).filter((i) => i.product_name === 'Begreppa')
      .reduce((s, i) => s + i.amount_sek, 0)).toBe(166585);
  });
});
