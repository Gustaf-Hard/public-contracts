#!/usr/bin/env node
// Bounce handling (2026-07-19 design §5) — one-shot supervised retag.
//
// Before this feature there was no notion of a bounce, so a delivery-failure
// notification (mailer-daemon / NDR) that landed in a T-INITIAL thread was
// classified `unknown` and escalated free-form ("draft a reply"). This helper
// converts any such EXISTING open escalation whose triggering message is
// actually a bounce into the new bounce shape — classifier_class='bounce',
// draft_template='T_RESEND_BAD_ADDRESS', with the T-INITIAL pre-filled as the
// resend draft — so the dashboard shows the address-entry resend form.
//
// It is an append-only in-place status/field change; nothing is deleted and
// there is NO schema change (`bounce` / `T_RESEND_BAD_ADDRESS` are new string
// values in existing TEXT columns). Run it supervised, backup-first:
//
//   cp data/pilot.db data/pilot.db.bak-$(date +%Y%m%d-%H%M%S)
//   node scripts/11-retag-bounce-escalations.js [--db=data/pilot.db] [--dry-run]
//
// --dry-run reports which open escalations WOULD be retagged without writing.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/storage.js';
import { isBounce, failedRecipient } from '../src/bounce.js';
import { T_INITIAL } from '../src/templates.js';

// Pure(ish) — takes an open db + env, returns the list of retag actions taken
// (or that would be taken in dry-run). Only touches OPEN escalations whose
// triggering message is a genuine bounce and that are not already tagged.
export function retagBounceEscalations(db, { env = {}, dryRun = false } = {}) {
  const retagged = [];
  for (const esc of db.listOpenEscalations()) {
    // Already a bounce escalation — leave it.
    if (esc.classifier_class === 'bounce' || esc.draft_template === 'T_RESEND_BAD_ADDRESS') continue;
    // Needs a triggering message to inspect.
    if (!esc.message_id) continue;
    const msg = db.getMessageById(esc.message_id);
    if (!msg) continue;
    if (!isBounce({ from_email: msg.from_email, subject: msg.subject, body_text: msg.body_text })) continue;

    const conv = db.getConversation(esc.conversation_id);
    if (!conv) continue;
    const deadAddress = failedRecipient(msg.body_text ?? '') ?? conv.contact_email;
    const initial = T_INITIAL({
      kommun_namn: conv.kommun_namn,
      role: conv.role,
      from_email: env.GMAIL_USER_EMAIL,
      from_name: env.GMAIL_FROM_NAME,
    });
    const reason = `Leveransfel: adressen \`${deadAddress}\` finns inte — ange ny adress och skicka om begäran.`;

    if (!dryRun) {
      db.raw.prepare(`
        UPDATE escalations
        SET classifier_class = 'bounce',
            draft_template = 'T_RESEND_BAD_ADDRESS',
            draft_subject = ?,
            draft_body = ?,
            reason = ?
        WHERE id = ? AND status = 'open'
      `).run(initial.subject, initial.body, reason, esc.id);
    }
    retagged.push({ escalation_id: esc.id, kommun_namn: conv.kommun_namn, dead_address: deadAddress });
  }
  return retagged;
}

export function parseArgs(argv) {
  const args = { db: 'data/pilot.db', dryRun: false };
  for (const a of argv) {
    if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('--db=')) {
      args.db = a.slice('--db='.length);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    console.error(`No database at ${args.db} — nothing to retag.`);
    process.exitCode = 1;
    return;
  }
  const env = {
    GMAIL_USER_EMAIL: process.env.GMAIL_USER_EMAIL,
    GMAIL_FROM_NAME: process.env.GMAIL_FROM_NAME,
  };
  const db = openDb(args.db);
  try {
    const actions = retagBounceEscalations(db, { env, dryRun: args.dryRun });
    const prefix = args.dryRun ? '[dry-run] ' : '';
    console.log(`${prefix}${actions.length} open escalation(s) ${args.dryRun ? 'would be' : ''} retagged as bounce:`);
    for (const a of actions) {
      console.log(`  ${prefix}#${a.escalation_id} ${a.kommun_namn} — dead address ${a.dead_address}`);
    }
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
