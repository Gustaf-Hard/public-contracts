#!/usr/bin/env node
// Vacation mode (2026-07-17) — one-shot cleanup: supersede the currently-open
// escalations that are purely staleness-driven (classifier_class =
// 'followup_stale'), which the vacation gate would otherwise have suppressed.
// Real-inbound escalations (any other class, or NULL) are left untouched.
//
// This is an append-only status change (open → superseded); nothing is
// deleted and there is NO schema change. Run it supervised, backup-first:
//
//   cp data/pilot.db data/pilot.db.bak-$(date +%Y%m%d-%H%M%S)
//   node scripts/09-clear-stale-escalations.js [--db=data/pilot.db] [--dry-run]
//
// --dry-run reports how many rows WOULD be superseded without writing.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/storage.js';

export function parseArgs(argv) {
  const args = { db: 'data/pilot.db', dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--db=')) {
      args.db = a.slice('--db='.length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    console.error(`No database at ${args.db} — nothing to clear.`);
    process.exitCode = 1;
    return;
  }
  const db = openDb(args.db);
  try {
    if (args.dryRun) {
      const n = db.raw.prepare(
        "SELECT COUNT(*) n FROM escalations WHERE status = 'open' AND classifier_class = 'followup_stale'"
      ).get().n;
      console.log(`[dry-run] ${n} open staleness escalation(s) would be superseded.`);
      return;
    }
    const count = db.supersedeStaleNudgeEscalations();
    console.log(`Superseded ${count} open staleness escalation(s) (classifier_class='followup_stale').`);
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
