#!/usr/bin/env node
// Re-draft named open escalations under the current analysis prompt
// (src/redraft.js). Sends nothing. Dry run by default.
//
//   node scripts/15-redraft.js --ids=261,269,276            # dry run: prints old → new
//   node scripts/15-redraft.js --ids=261,269,276 --apply    # supersede + new open rows
//   optional: --log=redraft.jsonl
import 'dotenv/config';
import fs from 'node:fs';
import { openDb } from '../src/storage.js';
import { makeSlackClient, updateEscalationResolved } from '../src/slack.js';
import { redraftEscalations } from '../src/redraft.js';

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const ids = (arg('ids') ?? '').split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
const apply = process.argv.includes('--apply');
const logPath = arg('log') ?? `redraft-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
if (!ids.length) {
  console.error('Usage: 15-redraft.js --ids=<id,id,...> [--apply] [--log=path]');
  process.exit(1);
}

const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();
const slackClient = process.env.SLACK_BOT_TOKEN ? makeSlackClient(process.env.SLACK_BOT_TOKEN) : null;

const out = fs.createWriteStream(logPath, { flags: 'a' });
const results = await redraftEscalations({
  db, env: process.env, ids, apply, slackClient, slackOps: { updateEscalationResolved },
  log: (r) => {
    out.write(JSON.stringify(r) + '\n');
    if (r.note) { console.log(`${r.esc}\t${r.note}`); return; }
    console.log(`\n=== ${r.esc}\t${r.outcome}${r.new_esc ? ` → ${r.new_esc}` : ''}${r.flags?.length ? `\t⚠️ ${r.flags.join(',')}` : ''}`);
    if (r.new_body) console.log(`--- ny:\n${r.new_body}`);
  },
});
out.end();
db.close();

const counts = {};
for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${JSON.stringify(counts)} (log: ${logPath})`);
