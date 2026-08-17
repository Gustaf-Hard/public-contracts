#!/usr/bin/env node
// Analyse contract PDFs in pilot.db with Claude and populate
// vendors/products/contracts. Idempotent: only attachments without a
// contracts row are analysed. --force re-analyses everything (use after
// prompt/schema changes); --only=<attachment_id> targets one attachment.
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { analysePendingContracts } from '../src/analyse-contract.js';

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

const onlyArg = arg('only');
const res = await analysePendingContracts({
  db,
  force: flag('force'),
  onlyId: onlyArg != null ? parseInt(onlyArg, 10) : null,
  log: (msg) => console.log(msg),
});
console.log(`Done. ${res.analysed} attachment(s) analysed, ${res.failed} failed (${res.parked.length} parked`
  + `${res.backoff ? `, ${res.backoff} deferred by rate limiting — no attempt booked` : ''}).`);
if (res.env_fault === 'contracts_dir_unavailable') {
  console.log(`WARNING: all ${res.missing_all} pending attachments are missing on disk — nothing was booked or parked.`
    + ' Check that the contracts volume is mounted and PILOT_CONTRACTS_DIR points at it.');
}
db.close();
