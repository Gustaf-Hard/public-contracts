#!/usr/bin/env node
// One-shot tick: runs runTick exactly once and exits. Useful for forcing a
// poll of Gmail without waiting for the cron interval and without binding
// the Slack interactivity listener port.

import 'dotenv/config';
import { runTick } from '../src/tick.js';
import { openDb } from '../src/storage.js';
import {
  buildOAuthClient,
  loadStoredToken,
  makeGmail,
  sendMessage as gmailSend,
  listInboundQuery,
  getMessage as gmailGet,
  fetchAttachment,
} from '../src/gmail.js';
import { makeSlackClient, postEscalation } from '../src/slack.js';
import { loadOverrides, getEffectiveNow } from '../src/pilot-config.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

const overrides = loadOverrides();
const oauth = buildOAuthClient(process.env);
const stored = loadStoredToken(TOKEN_PATH);
if (!stored) {
  console.error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  process.exit(1);
}
oauth.setCredentials(stored);
const gmail = makeGmail(oauth);
const slack = makeSlackClient(process.env.SLACK_BOT_TOKEN);
const db = openDb(DB_PATH);
db.migrate();

const now = getEffectiveNow({ env: process.env, overrides });
console.log(`Tick at ${now.toISOString()}`);

let tickErr = null;
try {
  await runTick({
    db,
    gmailClient: { gmail },
    gmailOps: { sendMessage: gmailSend, listInboundQuery, getMessage: gmailGet, fetchAttachment },
    slackClient: slack,
    slackOps: { postEscalation },
    env: process.env,
    contractsDir: CONTRACTS_DIR,
    now,
    log: console.log,
  });
} catch (e) { tickErr = e.message; throw e; }
finally {
  db.recordHeartbeat({ kind: 'tick', error: tickErr });
  // A successful one-shot tick ends the outage as far as the health clock is
  // concerned (last_success_at is now fresh), so the outage flag must go too.
  // Left set, the daemon's next tick posts a recovery message claiming the
  // outage lasted minutes when it actually lasted hours. No recovery message is
  // posted from here: this script is run by a human who already knows.
  if (tickErr == null && db.getTickHealth().outage_alerted_at) {
    db.clearOutageAlert();
    console.log('Cleared the ingest-outage flag (no recovery message posted — this was a manual tick).');
  }
}

db.close();
console.log('Tick done.');
