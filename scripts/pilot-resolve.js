#!/usr/bin/env node
// CLI escalation resolver. Thin wrapper over the SAME code path as the Slack
// approve and the dashboard (sendApprovedReply) — this script used to carry a
// third, drifted copy of the send logic that bypassed resolveReplyRecipient
// and mis-routed replies (autopilot review M7). Never duplicate send logic.
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail } from '../src/gmail.js';
import { sendApprovedReply } from '../src/send-reply.js';

function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const escId = parseInt(arg('escalation'), 10);
const action = arg('action');
const text = arg('text');

if (!escId || !['send', 'edit', 'skip'].includes(action)) {
  console.error('Usage: pilot-resolve --escalation=<id> --action=send|edit|skip [--text="..."]');
  process.exit(1);
}

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
if (!esc) { console.error(`Escalation ${escId} not found`); process.exit(1); }
if (esc.status !== 'open') { console.error(`Escalation ${escId} already resolved as ${esc.status}`); process.exit(1); }
const conv = db.getConversation(esc.conversation_id);

if (action === 'skip') {
  db.resolveEscalation(escId, { status: 'resolved_skip' });
  db.recordDecision({
    escalation_id: escId, conversation_id: conv.id,
    conversation_state: esc.previous_state ?? conv.state,
    classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
    draft_template: esc.draft_template, draft_body: esc.draft_body,
    decision: 'skip', final_body: null,
  });
  console.log(`Escalation ${escId} skipped (decision logged).`);
  process.exit(0);
}

const replyText = action === 'edit' ? (text ?? '') : (esc.draft_body ?? '');
if (!replyText) { console.error(`No reply text. Use --text="..." with --action=edit.`); process.exit(1); }

const oauth = buildOAuthClient(process.env);
const stored = loadStoredToken(TOKEN_PATH);
if (!stored) { console.error(`No Gmail token at ${TOKEN_PATH}`); process.exit(1); }
oauth.setCredentials(stored);
const gmail = makeGmail(oauth);

try {
  const sent = await sendApprovedReply({
    db, gmail, env: process.env, conv, esc,
    finalBody: replyText,
    decision: action === 'edit' ? 'edit' : 'approve_unmodified',
  });
  console.log(`Escalation ${escId} resolved (${action}). Sent gmail message ${sent.id}. Decision logged.`);
} catch (e) {
  console.error(`Resolve failed: ${e.message}`);
  process.exitCode = 1;
}
db.close();
