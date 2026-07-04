#!/usr/bin/env node
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, getMessage } from '../src/gmail.js';
import { backfillThreads } from '../src/backfill-threads.js';

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;

const db = openDb(DB_PATH);
db.migrate();
const auth = buildOAuthClient(process.env);
auth.setCredentials(loadStoredToken(TOKEN_PATH));
const gmail = makeGmail(auth);
const gmailOps = { getMessage };

const r = await backfillThreads({ db, gmail, gmailOps, log: (m) => console.log(`  ${m}`) });
console.log(`Backfill complete: scanned ${r.scanned}, updated ${r.updated}, skipped ${r.skipped}, classified ${r.classified}.`);
process.exit(0);
