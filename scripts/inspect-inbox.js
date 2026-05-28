#!/usr/bin/env node
// Inspect-only: list Gmail threads matching a domain query, with a summary
// of participants, message counts, dates, and subjects. Touches no DB.
//
// Usage:
//   node scripts/inspect-inbox.js <gmail-query>
//
// Examples:
//   node scripts/inspect-inbox.js 'vasteras.se newer_than:1y'
//   node scripts/inspect-inbox.js 'from:vasteras.se OR to:vasteras.se'

import 'dotenv/config';
import {
  buildOAuthClient,
  loadStoredToken,
  makeGmail,
  parseInboundMessage,
} from '../src/gmail.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.error('Usage: node scripts/inspect-inbox.js "<gmail query>"');
  process.exit(1);
}

const token = loadStoredToken(TOKEN_PATH);
if (!token) {
  console.error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  process.exit(1);
}
const oauth = buildOAuthClient(process.env);
oauth.setCredentials(token);
const gmail = makeGmail(oauth);

// 1) Get matching messages (paginated, up to 500).
const messages = [];
let pageToken;
let pages = 0;
do {
  const { data } = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 100,
    pageToken,
  });
  for (const m of data.messages ?? []) messages.push(m);
  pageToken = data.nextPageToken;
  pages++;
} while (pageToken && pages < 5);

console.log(`Matched ${messages.length} messages.`);

// 2) Group by threadId.
const byThread = new Map();
for (const m of messages) {
  if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
  byThread.get(m.threadId).push(m.id);
}
console.log(`Across ${byThread.size} thread(s).\n`);

// 3) For each thread, fetch full messages and print a summary.
const myAddr = (process.env.GMAIL_USER_EMAIL ?? '').toLowerCase();
let i = 0;
for (const [threadId, msgIds] of byThread.entries()) {
  i++;
  console.log(`────────────── Thread ${i}/${byThread.size}  id=${threadId} ──────────────`);
  const { data: thread } = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const parsed = (thread.messages ?? []).map(parseInboundMessage)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
  console.log(`  Messages: ${parsed.length}`);
  console.log(`  First subject: ${parsed[0]?.subject ?? '(no subject)'}`);
  const participants = new Set();
  for (const p of parsed) {
    if (p.from) participants.add(p.from.toLowerCase());
    if (p.to)   participants.add(p.to.toLowerCase());
  }
  console.log(`  Participants: ${[...participants].join(', ')}`);
  const start = parsed[0]?.date ?? '';
  const end = parsed[parsed.length - 1]?.date ?? '';
  console.log(`  Range: ${start} → ${end}`);
  let attCount = 0;
  for (const p of parsed) attCount += p.attachments?.length ?? 0;
  console.log(`  Attachments: ${attCount}`);
  console.log('  Per-message:');
  for (const p of parsed) {
    const dir = p.from?.toLowerCase().includes(myAddr) ? '⬆ out' : '⬇ in ';
    const bodySnippet = (p.body ?? '').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`    ${dir} ${p.date?.slice(0, 16) ?? ''}  ${p.subject?.slice(0, 60) ?? ''}`);
    console.log(`           from=${p.from?.slice(0, 50)}  to=${p.to?.slice(0, 50)}`);
    if (p.attachments?.length) console.log(`           📎 ${p.attachments.map((a) => a.filename).join(', ')}`);
    console.log(`           > ${bodySnippet}…`);
  }
  console.log();
}
