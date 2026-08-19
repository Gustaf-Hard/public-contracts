#!/usr/bin/env node
// Read-only triage of the "Omatchade inkommande" digest (2026-08-19).
//
// Mirrors runTick's inbound listing EXACTLY (same Gmail query, same window
// derivation from tick health), drops messages already ingested, runs the
// real matchInbound against the live conversations, and prints a breakdown
// of what remains by sender domain — flagged as newsletter / kommun-domain /
// other — with sample subjects. Reads Gmail (metadata only) and the DB; never
// writes to either, never posts to Slack, never archives.
//
// Usage (on the box, under the daemon's env):
//   node scripts/13-unmatched-breakdown.js [--window-days N] [--top N] [--json PATH]
//
// Without --window-days the window comes from tick health, like the daemon.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { openDb } from '../src/storage.js';
import { matchInbound, deriveFetchWindowDays } from '../src/tick.js';
import {
  buildOAuthClient, loadStoredToken, makeGmail, listInboundQuery, extractEmailDomain,
} from '../src/gmail.js';

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
}
const TOP = Number(arg('--top', 40));
const JSON_OUT = arg('--json', null);
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const me = (process.env.GMAIL_USER_EMAIL ?? '').toLowerCase();
if (!me) { console.error('GMAIL_USER_EMAIL not set'); process.exit(1); }

const token = loadStoredToken(TOKEN_PATH);
if (!token) { console.error(`No Gmail token at ${TOKEN_PATH}`); process.exit(1); }
const oauth = buildOAuthClient(process.env);
oauth.setCredentials(token);
const gmail = makeGmail(oauth);

const db = openDb(DB_PATH);
const now = new Date();
const health = db.getTickHealth?.({ now }) ?? null;
const windowDays = Number(arg('--window-days', deriveFetchWindowDays(health?.last_success_at ?? null, now)));
const query = `(to:${me} OR cc:${me} OR deliveredto:${me}) -from:${me} newer_than:${windowDays}d`;
console.log(`Query: ${query}`);

const list = await listInboundQuery(gmail, query);
console.log(`Listed: ${list.length} messages in window (${windowDays}d)`);

const notIngested = list.filter((m) => !db.hasGmailMessageId(m.id));
console.log(`Already ingested: ${list.length - notIngested.length}; candidates: ${notIngested.length}`);

// Metadata-only fetch: headers are all the triage needs, and it is ~10x
// cheaper than format=full for a 1000+ message sweep.
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted', 'In-Reply-To', 'References'];
const fetched = [];
let i = 0;
for (const m of notIngested) {
  i++;
  if (i % 100 === 0) console.error(`  fetched ${i}/${notIngested.length}`);
  const res = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: HEADERS });
  const h = {};
  for (const x of res.data.payload?.headers ?? []) h[x.name.toLowerCase()] = x.value;
  fetched.push({
    id: m.id,
    threadId: res.data.threadId,
    labelIds: res.data.labelIds ?? [],
    internalDate: res.data.internalDate ? new Date(Number(res.data.internalDate)).toISOString() : null,
    from: h.from ?? '',
    to: h.to ?? '',
    cc: h.cc ?? '',
    subject: h.subject ?? '',
    newsletter: !!(h['list-unsubscribe'] || /bulk|list/i.test(h.precedence ?? '')),
    autoSubmitted: !!(h['auto-submitted'] && h['auto-submitted'] !== 'no'),
    hasReferences: !!(h['in-reply-to'] || h.references),
  });
}

const active = db.listAllConversations().filter((c) => c.gmail_thread_id);
const convInputs = active.map((c) => ({
  id: c.id,
  contact_email: c.contact_email,
  thread_ids: [c.gmail_thread_id, ...db.listThreadsForConversation(c.id).map((t) => t.gmail_thread_id)].filter(Boolean),
}));
const { matched, ambiguous, unmatched } = matchInbound(
  fetched.map((f) => ({ id: f.id, threadId: f.threadId, from: f.from })),
  convInputs,
);
console.log(`\nWould match: ${matched.length} (thread ${matched.filter((x) => x.via === 'thread').length}, domain ${matched.filter((x) => x.via === 'domain').length}) — not yet ingested; the next tick should take these.`);
console.log(`Ambiguous: ${ambiguous.length}`);
console.log(`Unmatched: ${unmatched.length}`);

// Kommun home-domain index from the enrolled conversations + Phase-1 dataset.
const byId = new Map(fetched.map((f) => [f.id, f]));
const convById = new Map(active.map((c) => [c.id, c]));
let kommunDomains = new Map(); // domain → kommun_namn
try {
  const { readFileSync } = await import('node:fs');
  const muni = JSON.parse(readFileSync('data/municipalities.json', 'utf8'));
  for (const k of muni) {
    const web = (k.webbplats ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    if (web) kommunDomains.set(web, k.kommun_namn);
    for (const c of k.contacts ?? []) {
      const d = extractEmailDomain(c.email);
      if (d) kommunDomains.set(d, k.kommun_namn);
    }
  }
} catch (e) {
  console.error(`(no municipalities.json — kommun-domain flagging disabled: ${e.message})`);
}
function kommunFor(domain) {
  if (!domain) return null;
  for (const [d, name] of kommunDomains) {
    if (domain === d || domain.endsWith('.' + d)) return name;
  }
  return null;
}
const enrolledDomains = new Set(active.map((c) => extractEmailDomain(c.contact_email)).filter(Boolean));

const groups = new Map();
for (const id of unmatched) {
  const f = byId.get(id);
  const domain = extractEmailDomain(f.from) ?? '(no domain)';
  if (!groups.has(domain)) {
    groups.set(domain, { domain, kommun: kommunFor(domain), enrolled: enrolledDomains.has(domain), n: 0, threads: new Set(), newsletter: 0, autoSubmitted: 0, replies: 0, ccOnly: 0, subjects: new Map(), first: null, last: null });
  }
  const g = groups.get(domain);
  g.n++;
  g.threads.add(f.threadId);
  if (f.newsletter) g.newsletter++;
  if (f.autoSubmitted) g.autoSubmitted++;
  if (f.hasReferences) g.replies++;
  if (!f.to.toLowerCase().includes(me) && f.cc.toLowerCase().includes(me)) g.ccOnly++;
  const s = f.subject.replace(/^\s*(re|sv|vb|fw|fwd):\s*/i, '').slice(0, 80);
  g.subjects.set(s, (g.subjects.get(s) ?? 0) + 1);
  if (!g.first || f.internalDate < g.first) g.first = f.internalDate;
  if (!g.last || f.internalDate > g.last) g.last = f.internalDate;
}
const rows = [...groups.values()].sort((a, b) => b.n - a.n);

const bucket = { newsletter: 0, kommunDomain: 0, kommunDomainNewsletterish: 0, other: 0 };
for (const g of rows) {
  if (g.newsletter === g.n) bucket.newsletter += g.n;
  else if (g.kommun) { bucket.kommunDomain += g.n - g.newsletter; bucket.kommunDomainNewsletterish += g.newsletter; }
  else bucket.other += g.n;
}
console.log(`\nBuckets: newsletter-only domains ${bucket.newsletter}; kommun-domain non-newsletter ${bucket.kommunDomain} (+${bucket.kommunDomainNewsletterish} newsletter-ish from kommun domains); other ${bucket.other}`);

console.log(`\nTop ${TOP} sender domains among unmatched:`);
console.log('  n  thr  nl  auto  re  cc | domain  [kommun / enrolled?]  first..last');
for (const g of rows.slice(0, TOP)) {
  const tag = g.kommun ? `[${g.kommun}${g.enrolled ? ' ENROLLED' : ' not enrolled'}]` : '';
  console.log(`${String(g.n).padStart(4)} ${String(g.threads.size).padStart(4)} ${String(g.newsletter).padStart(3)} ${String(g.autoSubmitted).padStart(5)} ${String(g.replies).padStart(3)} ${String(g.ccOnly).padStart(3)} | ${g.domain} ${tag}  ${g.first?.slice(0, 10)}..${g.last?.slice(0, 10)}`);
  const top = [...g.subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [s, n] of top) console.log(`         ${n}× ${s || '(ämne saknas)'}`);
}
if (rows.length > TOP) console.log(`…and ${rows.length - TOP} more domains.`);

if (ambiguous.length) {
  console.log('\nAmbiguous:');
  for (const a of ambiguous) {
    const f = byId.get(a.messageId);
    console.log(`  ${f.from} — ${f.subject} → ${a.convIds.map((c) => { const cv = convById.get(c); return cv ? `${cv.kommun_namn}/${cv.role}` : c; }).join(', ')}`);
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({
    generated_at: now.toISOString(), windowDays, listed: list.length, candidates: notIngested.length,
    matched, ambiguous, unmatched: unmatched.map((id) => byId.get(id)),
    domains: rows.map((g) => ({ ...g, threads: g.threads.size, subjects: [...g.subjects.entries()] })),
  }, null, 2));
  console.log(`\nWrote ${JSON_OUT}`);
}
db.close?.();
