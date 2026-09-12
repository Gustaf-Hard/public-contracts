// Conversation context for the reply-drafting LLM (2026-09-12 design).
// The model previously saw ONLY the incoming body; every generation-time
// failure in the 2026-09-12 queue review traced back to that gap: drafts
// claimed delivered avtal were missing, re-argued accepted fees, and sent
// "resends" without the request text. This block is appended to the USER
// message (never the cached system prompt).
//
// Runs BEFORE the trigger message is ingested (tick.js IO ordering), so
// db.listMessages returns exactly the prior thread; the trigger mail's
// attachments arrive as parsed metadata only.

const MAX_MESSAGES = 20;
const MAX_OUTBOUND_CHARS = 1500;
const MAX_INBOUND_CHARS = 300;

export function buildDraftContext(db, conv, parsed) {
  const msgs = db.listMessages(conv.id);
  const attRows = db.listAttachmentsForConversation?.(conv.id) ?? [];
  const attsByMsg = new Map();
  for (const a of attRows) {
    if (!attsByMsg.has(a.message_id)) attsByMsg.set(a.message_id, []);
    attsByMsg.get(a.message_id).push(a.filename);
  }

  const lines = [];

  const firstOutbound = msgs.find((m) => m.direction === 'outbound');
  lines.push('# Ursprunglig begäran (vårt första mejl, ordagrant)');
  lines.push((firstOutbound?.body_text ?? '(saknas)').trim());
  lines.push('');

  lines.push('# Tidigare korrespondens (äldst först)');
  const shown = msgs.slice(-MAX_MESSAGES);
  if (msgs.length > shown.length) {
    lines.push(`(${msgs.length - shown.length} äldre meddelanden utelämnade)`);
  }
  for (const m of shown) {
    const date = (m.received_at ?? '').slice(0, 10);
    const files = attsByMsg.get(m.id) ?? [];
    const fileNote = files.length ? ` [bilagor: ${files.join(', ')}]` : '';
    if (m.direction === 'outbound') {
      const body = (m.body_text ?? '').trim().slice(0, MAX_OUTBOUND_CHARS);
      lines.push(`## VI skrev (${date})${fileNote}`);
      lines.push(body);
    } else {
      let summary = null;
      try { summary = JSON.parse(m.analysis_json ?? 'null')?.summary ?? null; } catch { /* unparsable */ }
      const text = summary ?? (m.body_text ?? '').trim().slice(0, MAX_INBOUND_CHARS);
      lines.push(`## KOMMUNEN skrev (${date}, klassning: ${m.classification ?? 'okänd'})${fileNote}`);
      lines.push(text);
    }
    lines.push('');
  }

  lines.push('# Bilagor i det inkommande mejlet');
  const triggerFiles = (parsed?.attachments ?? []).map((a) => a.filename).filter(Boolean);
  lines.push(triggerFiles.length ? triggerFiles.map((f) => `- ${f}`).join('\n') : '(inga)');
  lines.push('');

  lines.push('# Avtal vi redan extraherat ur mottagna bilagor');
  const contracts = db.listContractInfoForConversation?.(conv.id) ?? [];
  lines.push(contracts.length
    ? contracts.map((c) => `- ${c.vendor_name ?? 'okänd leverantör'}: ${c.document_type ?? 'okänt dokument'}${c.is_contract ? '' : ' (EJ ett avtal)'}`).join('\n')
    : '(inga extraherade ännu)');

  return lines.join('\n');
}
