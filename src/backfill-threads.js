// One-off: populate gmail_thread_id/thread_id on messages that predate the
// threads model, grouping them into threads rows. Idempotent — messages that
// already have a gmail_thread_id are skipped.
export async function backfillThreads({ db, gmail, gmailOps }) {
  const rows = db.raw.prepare(
    "SELECT id, conversation_id, gmail_message_id, from_email, direction, received_at FROM messages WHERE gmail_thread_id IS NULL AND gmail_message_id IS NOT NULL ORDER BY id"
  ).all();
  let updated = 0;
  for (const row of rows) {
    const full = await gmailOps.getMessage(gmail, row.gmail_message_id);
    if (!full?.threadId) continue;
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
  return { scanned: rows.length, updated };
}
