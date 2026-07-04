import { inferThreadStatus } from './threads.js';

// One-off: populate gmail_thread_id/thread_id on messages that predate the
// threads model, grouping them into threads rows, then classify each touched
// thread's status the same way live ingest does. Idempotent — messages that
// already have a gmail_thread_id are skipped.
//
// Historical messages can no longer be fetchable (deleted from the mailbox, or
// an old send whose id 404s). A single un-fetchable message must NOT abort the
// whole backfill, so each getMessage is guarded — failures are counted and
// logged, and the run continues. Re-running later picks up anything that was
// skipped but has since become fetchable.
export async function backfillThreads({ db, gmail, gmailOps, log = () => {} }) {
  const rows = db.raw.prepare(
    "SELECT id, conversation_id, gmail_message_id, from_email, direction, received_at FROM messages WHERE gmail_thread_id IS NULL AND gmail_message_id IS NOT NULL ORDER BY id"
  ).all();
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    let full;
    try {
      full = await gmailOps.getMessage(gmail, row.gmail_message_id);
    } catch (e) {
      skipped++;
      log(`skip message ${row.gmail_message_id} (${e.status ?? e.code ?? 'error'}: ${e.message})`);
      continue;
    }
    if (!full?.threadId) { skipped++; continue; }
    const thread = db.upsertThread({
      conversation_id: row.conversation_id,
      gmail_thread_id: full.threadId,
      counterparty_email: row.direction === 'inbound' ? row.from_email : null,
      counterparty_name: row.direction === 'inbound' ? row.from_email : null,
      last_inbound_at: row.direction === 'inbound' ? row.received_at : null,
    });
    db.raw.prepare('UPDATE messages SET gmail_thread_id = ?, thread_id = ? WHERE id = ?')
      .run(full.threadId, thread.id, row.id);
    updated++;
  }

  // Second pass: classify every auto-status thread from its inbound messages,
  // the same way live ingest does (Task 9). Runs over ALL auto threads (not
  // just ones touched this run) so it is self-healing — re-running after the
  // messages are already stamped still (re)classifies. Deterministic, and
  // manual overrides are never touched.
  let classified = 0;
  const autoThreads = db.raw.prepare("SELECT id, conversation_id FROM threads WHERE status_source = 'auto'").all();
  for (const t of autoThreads) {
    const inbound = db.listMessages(t.conversation_id)
      .filter((mm) => mm.direction === 'inbound' && mm.thread_id === t.id)
      .map((mm) => ({ classification: mm.classification, attachment_count: mm.attachment_count }));
    db.setThreadStatus(t.id, inferThreadStatus(inbound), 'auto');
    classified++;
  }

  return { scanned: rows.length, updated, skipped, classified };
}
