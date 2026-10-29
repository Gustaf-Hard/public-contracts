// Fix wave 2 E7: scripts/17-extract-purchases.js without --apply opens the DB
// read-only and never migrates. Runs the real CLI entry point against a
// temp-dir DB that predates the purchase tables. Synthetic data only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/storage.js';

const SCRIPT = resolve('scripts/17-extract-purchases.js');
let tmp; let dbPath;
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const tables = (p) => { const d = new Database(p, { readonly: true }); const t = d.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name); d.close(); return t; };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pcli-'));
  dbPath = join(tmp, 'pilot.db');
  const db = openDb(dbPath);
  db.migrate();
  const conv = db.createConversation({ kommun_kod: '9001', kommun_namn: 'Exempelby', role: 'central', contact_email: 'r@example.se', scheduled_send_at: '2026-04-01T08:00:00Z' });
  const msg = db.recordMessage({ conversation_id: conv, gmail_message_id: 'g1', direction: 'inbound', from_email: 'r@example.se', to_email: 'me@example.com', subject: 's', body_text: 'b', received_at: '2026-05-01T10:00:00Z', attachment_count: 1 });
  const att = db.recordAttachment({ message_id: msg, filename: 'lista.pdf', saved_path: join(tmp, 'saknas.pdf'), mime_type: 'application/pdf', size_bytes: 1 });
  db.recordContract({ attachment_id: att, is_contract: 0, document_type: 'följebrev_sammanställning' });
  // A DB from before the purchase tables existed.
  db.raw.exec('DROP TABLE purchase_rows; DROP TABLE purchase_documents;');
  db.raw.pragma('journal_mode = DELETE');
  db.close();
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const run = (args = []) => execFileSync(process.execPath, [SCRIPT, ...args], {
  cwd: tmp, encoding: 'utf8',
  env: { PATH: process.env.PATH, PILOT_DB_PATH: dbPath, PILOT_CONTRACTS_DIR: join(tmp, 'contracts') },
});

describe('17-extract-purchases dry run', () => {
  it('writes nothing, migrates nothing, and says --apply would create the tables', () => {
    const before = hash(dbPath);
    const out = run();
    expect(hash(dbPath)).toBe(before);
    expect(tables(dbPath)).not.toContain('purchase_rows');
    expect(out).toMatch(/--apply skapar/);
    expect(out).toMatch(/Torrkörning klar/);
  });

  it('--apply migrates and books', () => {
    run(['--apply']);
    expect(tables(dbPath)).toContain('purchase_rows');
  });
});
