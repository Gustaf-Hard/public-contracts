#!/usr/bin/env node
// Backfill the perpetual-refresh lifecycle fields (auto_renews, renewal_term,
// last_cancellation_date, extension_option_until) AND the vendor-data-center
// pricing fields (annual_value_sek, one_time_value_sek, pricing_model,
// unit_price_sek, unit, quantity, value_incl_moms) over already-stored
// contract PDFs by re-running the Opus analyser (2026-07-09 refresh design
// Part A §2.3 + 2026-07-09 vendor-data-center design §1).
//
// This re-analyses EVERY PDF attachment so the new fields are populated from
// the current prompt/schema. It is the analyser's existing `force` path with a
// clearer name and a dry-run guard.
//
// NON-DESTRUCTIVE (finding 6): storeContractAnalysis MERGES each re-run against
// the existing row — a degraded second pass can never flip a good is_contract=1
// to false or null out a set period/vendor/lifecycle field. Only NULL fields
// are filled; genuine improvements overwrite. Every preserved/overwritten field
// is logged per contract (REANALYSE …) so the operator can audit the diff.
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
