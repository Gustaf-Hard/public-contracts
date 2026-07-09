import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../scripts/07-reanalyse-lifecycle.js';
import { mergePreserving, storeContractAnalysis } from '../src/analyse-contract.js';
import { openDb } from '../src/storage.js';

describe('07-reanalyse-lifecycle parseArgs (pure)', () => {
  it('defaults: no dry-run, no db override, no onlyId', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, dbPath: null, onlyId: null });
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
