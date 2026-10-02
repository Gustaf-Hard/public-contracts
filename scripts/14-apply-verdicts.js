#!/usr/bin/env node
// Apply a reviewed verdict file to the live DB through sendApprovedReply.
// Same Gmail/DB wiring as scripts/pilot-resolve.js, looped over a file, with
// the snapshot checks in src/apply-verdicts.js (reviewedAt, draft_sha256).
//
//   node scripts/14-apply-verdicts.js --file=verdicts.json --reviewed-at=2026-09-26T03:00:14Z            # dry run
//   node scripts/14-apply-verdicts.js --file=verdicts.json --reviewed-at=2026-09-26T03:00:14Z --apply    # sends
//   optional: --only=approve,skip,defer   --limit=N   --log=results.jsonl
import 'dotenv/config';
import fs from 'node:fs';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail } from '../src/gmail.js';
import { makeSlackClient } from '../src/slack.js';
import { applyVerdicts } from '../src/apply-verdicts.js';

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const file = arg('file');
const reviewedAt = arg('reviewed-at');
const apply = process.argv.includes('--apply');
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const limit = arg('limit') ? parseInt(arg('limit'), 10) : Infinity;
const logPath = arg('log') ?? `apply-verdicts-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
if (!file || !reviewedAt) {
  console.error('Usage: 14-apply-verdicts.js --file=<verdicts.json> --reviewed-at=<ISO> [--apply] [--only=approve,edit,skip,defer] [--limit=N] [--log=path]');
  process.exit(1);
}

let verdicts = JSON.parse(fs.readFileSync(file, 'utf8'));
if (only) verdicts = verdicts.filter((v) => only.has(v.verdict));
verdicts = verdicts.slice(0, limit);

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

let gmail = null;
if (apply) {
  const oauth = buildOAuthClient(process.env);
  const stored = loadStoredToken(TOKEN_PATH);
  if (!stored) { console.error(`No Gmail token at ${TOKEN_PATH}`); process.exit(1); }
  oauth.setCredentials(stored);
  gmail = makeGmail(oauth);
}

const out = fs.createWriteStream(logPath, { flags: 'a' });
// A parked row whose Slack message still has live buttons is a second way to
// send the draft the batch just parked, so hand the applier the same client the
// daemon posts with when the token is configured.
const slackClient = process.env.SLACK_BOT_TOKEN ? makeSlackClient(process.env.SLACK_BOT_TOKEN) : null;

const results = await applyVerdicts({
  db, gmail, env: process.env, verdicts, reviewedAt, apply, slackClient,
  log: (r) => { out.write(JSON.stringify(r) + '\n'); console.log(`${r.esc}\t${r.verdict}\t${r.outcome}${r.error ? '\t' + r.error : ''}`); },
});
out.end();
db.close();

const counts = {};
for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${JSON.stringify(counts)} (log: ${logPath})`);
