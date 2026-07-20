// One-time inbox backfill (2026-07-20 archive-on-ingest design §3).
//
// Archives every tracked Gmail thread (removes the INBOX label — reversible,
// never deletes) so the operator's inbox holds only mail the tool hasn't
// captured. Idempotent. DRY-RUN by default: it lists the thread ids that WOULD
// be archived without touching Gmail. Pass `--run` to actually archive.
//
//   node scripts/12-archive-backfill.js          # dry-run, prints the count
//   node scripts/12-archive-backfill.js --run     # real sweep
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { archiveTrackedThreads } from '../src/tick.js';
import { buildOAuthClient, loadStoredToken, makeGmail, archiveThread } from '../src/gmail.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const run = process.argv.includes('--run');

const db = openDb(DB_PATH);
db.migrate();

let gmail = null;
if (run) {
  const oauth = buildOAuthClient(process.env);
  const stored = loadStoredToken(TOKEN_PATH);
  if (!stored) throw new Error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  oauth.setCredentials(stored);
  gmail = makeGmail(oauth);
}

console.log(run ? '=== ARCHIVING (real sweep) ===' : '=== DRY-RUN (no changes) ===');
const count = await archiveTrackedThreads(db, {
  archiveThreadImpl: archiveThread,
  gmail,
  dryRun: !run,
  log: console.log,
});
console.log(`\n${run ? 'Archived' : 'Would archive'} ${count} tracked thread(s).`);
