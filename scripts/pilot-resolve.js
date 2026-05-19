#!/usr/bin/env node
import 'dotenv/config';
import { google } from 'googleapis';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, sendMessage } from '../src/gmail.js';

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
    escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
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

const sent = await sendMessage(gmail, {
  from: `${process.env.GMAIL_FROM_NAME} <${process.env.GMAIL_USER_EMAIL}>`,
  to: conv.contact_email,
  subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar',
  body: replyText,
  threadId: conv.gmail_thread_id,
});
const nowIso = new Date().toISOString();
db.recordMessage({
  conversation_id: conv.id, gmail_message_id: sent.id, direction: 'outbound',
  from_email: process.env.GMAIL_USER_EMAIL, to_email: conv.contact_email,
  subject: esc.draft_subject ?? 'Re: Begäran om allmänna handlingar', body_text: replyText,
  classification: null, classification_confidence: null,
  received_at: nowIso, attachment_count: 0,
});
const patch = { last_outbound_at: nowIso };
if (esc.draft_template === 'T_RECEIPT') patch.receipt_sent = 1;
if (esc.draft_template === 'T_FOLLOWUP_NUDGE' || esc.draft_template === 'T_FOLLOWUP_CLOSE') {
  patch.followup_count = (conv.followup_count ?? 0) + 1;
}
const targetState = (conv.state === 'NEEDS_HUMAN' && esc.draft_template === 'free_form' && esc.previous_state)
  ? esc.previous_state
  : conv.state;
db.updateConversationState(conv.id, targetState, patch);
db.resolveEscalation(escId, { status: action === 'edit' ? 'resolved_edit' : 'resolved_send', resolved_text: replyText });
db.recordDecision({
  escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
  classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
  draft_template: esc.draft_template, draft_body: esc.draft_body,
  decision: action === 'edit' ? 'edit' : 'approve_unmodified',
  final_body: replyText,
});

console.log(`Escalation ${escId} resolved (${action}). Sent gmail message ${sent.id}. Decision logged.`);
db.close();
