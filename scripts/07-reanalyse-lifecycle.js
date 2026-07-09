#!/usr/bin/env node
// Backfill the perpetual-refresh lifecycle fields (auto_renews, renewal_term,
// last_cancellation_date, extension_option_until) over already-stored contract
// PDFs by re-running the Opus analyser (2026-07-09 design Part A §2.3).
//
// This re-analyses EVERY PDF attachment (recordContract replaces the row in
// place, preserving contract ids where the attachment is unchanged) so the new
// fields are populated from the current prompt/schema. It is the analyser's
// existing `force` path with a clearer name and a dry-run guard.
//
// HARD CONSTRAINT: not run automatically. See
// docs/superpowers/runbooks/2026-07-09-refresh-activation.md — the owner runs
// this under supervision after backing up data/pilot.db.

import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { analysePendingContracts } from '../src/analyse-contract.js';

// Pure argument parsing — unit-tested; keeps the IO shell trivial.
export function parseArgs(argv) {
  const dbPath = (argv.find((x) => x.startsWith('--db=')) ?? '').slice('--db='.length) || null;
  const onlyRaw = (argv.find((x) => x.startsWith('--only=')) ?? '').slice('--only='.length);
  const only = onlyRaw ? parseInt(onlyRaw, 10) : null;
  return {
    dryRun: argv.includes('--dry-run'),
    dbPath,
    onlyId: Number.isFinite(only) ? only : null,
  };
}

// Only run the IO when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dryRun, dbPath, onlyId } = parseArgs(process.argv.slice(2));
  const path = dbPath ?? process.env.PILOT_DB_PATH ?? 'data/pilot.db';

  if (dryRun) {
    console.log(`[dry-run] would re-analyse all contract PDFs in ${path} to backfill lifecycle fields. No changes made.`);
    process.exit(0);
  }

  const db = openDb(path);
  db.migrate();
  const n = await analysePendingContracts({
    db,
    force: true, // re-analyse every PDF, not only those without a contracts row
    onlyId,
    log: (msg) => console.log(msg),
  });
  console.log(`Done. ${n} attachment(s) re-analysed for lifecycle fields.`);
  db.close();
}
