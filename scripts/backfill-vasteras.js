#!/usr/bin/env node
// Backfill an existing Gmail conversation into pilot.db without sending
// anything. Specifically for the Västerås thread that pre-dates the bot.
//
// Flow:
//   1. List Gmail messages matching a domain query, group by thread.
//   2. Sort all messages chronologically across threads.
//   3. Insert each as a row in `messages` (skipping ones already there).
//   4. For each inbound: run LLM analysis and store analysis_json + signature.
//   5. For each PDF attachment: download + save_attachment to data/contracts/.
//   6. Use the longest thread's Gmail thread-id as the canonical
//      `conversations.gmail_thread_id` so future ticks resume polling.
//   7. Set final state to DELIVERING (contracts received, dialogue ongoing).
//
// Dry-run by default. Pass --commit to actually write.

import 'dotenv/config';
import {
  buildOAuthClient,
  loadStoredToken,
  makeGmail,
  parseInboundMessage,
  fetchAttachment as gmailFetchAttachment,
} from '../src/gmail.js';
import { openDb } from '../src/storage.js';
import { analyseMessage } from '../src/analyse-message.js';
import { extractSignature } from '../src/extract-signature.js';
import { saveAttachment } from '../src/attachments.js';

const KOMMUN_KOD = '1980';
const KOMMUN_NAMN = 'Västerås';
const ROLE = 'central';
const CONTACT_EMAIL = 'mikaela.radgren@vasteras.se';
const ARENDENUMMER = 'K202642713';
const QUERY = 'vasteras.se newer_than:1y';

const COMMIT = process.argv.includes('--commit');

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

const token = loadStoredToken(TOKEN_PATH);
if (!token) { console.error(`No Gmail token at ${TOKEN_PATH}`); process.exit(1); }
const oauth = buildOAuthClient(process.env);
oauth.setCredentials(token);
const gmail = makeGmail(oauth);

const db = openDb(DB_PATH);
db.migrate();

console.log(`Backfill mode: ${COMMIT ? 'COMMIT (writes to DB + filesystem)' : 'DRY-RUN'}`);
console.log(`Query: ${QUERY}`);

// 1) Find matching messages
const matches = [];
let pageToken;
do {
  const { data } = await gmail.users.messages.list({ userId: 'me', q: QUERY, maxResults: 100, pageToken });
  for (const m of data.messages ?? []) matches.push(m);
  pageToken = data.nextPageToken;
} while (pageToken);

const threadIds = [...new Set(matches.map((m) => m.threadId))];
console.log(`Matched ${matches.length} messages across ${threadIds.length} threads.`);

// 2) Fetch full messages per thread
const allRaw = [];
for (const tid of threadIds) {
  const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: tid, format: 'full' });
  for (const m of thread.messages ?? []) allRaw.push(m);
}

// 3) Parse + sort chronologically
const myAddr = (process.env.GMAIL_USER_EMAIL ?? '').toLowerCase();
const parsed = allRaw.map((m) => ({ raw: m, p: parseInboundMessage(m) }))
  .sort((a, b) => new Date(a.p.date).getTime() - new Date(b.p.date).getTime());

console.log(`Will process ${parsed.length} messages (chronological).`);

// 4) Pick canonical thread (longest)
const counts = new Map();
for (const m of allRaw) counts.set(m.threadId, (counts.get(m.threadId) ?? 0) + 1);
const canonicalThreadId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`Canonical thread: ${canonicalThreadId} (${counts.get(canonicalThreadId)} messages)`);

// 5) Check existing conversation
const existing = db.raw.prepare('SELECT * FROM conversations WHERE kommun_kod = ? AND role = ?')
  .get(KOMMUN_KOD, ROLE);
if (existing) console.log(`Found existing conversation #${existing.id} state=${existing.state}`);
else console.log(`No existing conversation; will create new.`);

if (!COMMIT) {
  const inboundCount = parsed.filter(({ p }) => !(p.from ?? '').toLowerCase().includes(myAddr)).length;
  const attCount = parsed.reduce((n, { p }) => n + (p.attachments?.length ?? 0), 0);
  console.log('\nDry-run summary:');
  console.log(`  Inbound messages (LLM will analyse): ${inboundCount}`);
  console.log(`  Total attachments: ${attCount}`);
  console.log(`  New conversation? ${existing ? 'no, reuse' : 'yes'}`);
  console.log(`  Final state: DELIVERING (receipt_sent=1, arendenummer=${ARENDENUMMER})`);
  console.log('\nRun again with --commit to write.');
  db.close();
  process.exit(0);
}

// === COMMIT MODE ===
const firstOutbound = parsed.find(({ p }) => (p.from ?? '').toLowerCase().includes(myAddr));
const firstOutboundIso = firstOutbound ? new Date(firstOutbound.p.date).toISOString() : new Date().toISOString();

let convId = existing?.id;
if (!convId) {
  convId = db.createConversation({
    kommun_kod: KOMMUN_KOD, kommun_namn: KOMMUN_NAMN, role: ROLE,
    contact_email: CONTACT_EMAIL,
    scheduled_send_at: firstOutboundIso,
  });
  console.log(`Created conversation #${convId}`);
}

let lastInboundAnalysis = null;
let latestOutboundIso = null;

for (const { raw, p } of parsed) {
  if (db.hasGmailMessageId(raw.id)) {
    console.log(`  ↩ skip ${raw.id} (already in DB)`);
    continue;
  }
  const isOutbound = (p.from ?? '').toLowerCase().includes(myAddr);
  const dir = isOutbound ? 'outbound' : 'inbound';
  const receivedAt = new Date(p.date).toISOString();
  if (isOutbound && (!latestOutboundIso || receivedAt > latestOutboundIso)) {
    latestOutboundIso = receivedAt;
  }

  let analysis = null;
  let classification = null;
  let confidence = null;
  if (!isOutbound && p.body) {
    process.stdout.write(`  🤖 LLM analysing ${p.subject?.slice(0, 40)}...`);
    analysis = await analyseMessage(p.body, {
      kommun_namn: KOMMUN_NAMN, role: ROLE,
      conversation_state: 'SENT',
      today_iso: new Date().toISOString().slice(0, 10),
      days_since_last_outbound: null,
    });
    console.log(` ${analysis ? analysis.intent : 'FAILED'}`);
    if (analysis) {
      classification = analysis.intent;
      confidence = analysis.confidence;
      lastInboundAnalysis = analysis;
    }
  }

  const sig = !isOutbound ? extractSignature(p.body) : null;
  const msgId = db.recordMessage({
    conversation_id: convId,
    gmail_message_id: raw.id,
    direction: dir,
    from_email: p.from, to_email: p.to,
    subject: p.subject, body_text: p.body,
    classification, classification_confidence: confidence,
    received_at: receivedAt,
    attachment_count: p.attachments?.length ?? 0,
    signature_extracted: sig,
    analysis_json: analysis,
  });

  for (const att of p.attachments ?? []) {
    const isPdf = att.mime_type === 'application/pdf'
      || att.filename?.toLowerCase().endsWith('.pdf');
    if (!isPdf) continue;
    const buf = await gmailFetchAttachment(gmail, raw.id, att.attachment_id);
    const saved = await saveAttachment(buf, {
      kommun_kod: KOMMUN_KOD, kommun_namn: KOMMUN_NAMN, role: ROLE,
      received_at: receivedAt, from_email: p.from, from_name: null,
      gmail_message_id: raw.id, gmail_thread_id: raw.threadId,
      subject: p.subject, original_filename: att.filename, mime_type: att.mime_type,
    }, { baseDir: CONTRACTS_DIR });
    db.recordAttachment({
      message_id: msgId, filename: att.filename,
      saved_path: saved.saved_path, mime_type: att.mime_type, size_bytes: saved.size_bytes,
    });
    console.log(`    📎 ${att.filename} (${saved.size_bytes} B)`);
  }

  console.log(`  ${isOutbound ? '⬆' : '⬇'} ${p.date?.slice(0, 22)}  ${p.subject?.slice(0, 50)}`);
}

const patch = {
  gmail_thread_id: canonicalThreadId,
  last_outbound_at: latestOutboundIso ?? firstOutboundIso,
  receipt_sent: 1,
  arendenummer: ARENDENUMMER,
};
if (lastInboundAnalysis?.follow_up_at) patch.follow_up_at = lastInboundAnalysis.follow_up_at;
db.updateConversationState(convId, 'DELIVERING', patch);
console.log(`\nConversation #${convId} → state=DELIVERING, follow_up_at=${patch.follow_up_at ?? 'null'}, ärendenummer=${ARENDENUMMER}`);

db.close();
console.log('Done.');
