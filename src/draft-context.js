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

import { isTrivialImage } from './attachments.js';

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
      const fullBody = (m.body_text ?? '').trim();
      const body = fullBody.slice(0, MAX_OUTBOUND_CHARS);
      const truncated = fullBody.length > MAX_OUTBOUND_CHARS;
      lines.push(`## VI skrev (${date})${fileNote}`);
      lines.push(truncated ? `${body} … [avkortat]` : body);
    } else {
      let summary = null;
      try { summary = JSON.parse(m.analysis_json ?? 'null')?.summary ?? null; } catch { /* unparsable */ }
      // An empty stored summary ('') must fall back too, not render a blank
      // inbound line (finding 6, 2026-09-12 review).
      const text = summary?.trim() || (m.body_text ?? '').trim().slice(0, MAX_INBOUND_CHARS);
      lines.push(`## KOMMUNEN skrev (${date}, klassning: ${m.classification ?? 'okänd'})${fileNote}`);
      lines.push(text);
    }
    lines.push('');
  }

  lines.push('# Bilagor i det inkommande mejlet');
  const triggerAtts = parsed?.attachments ?? [];
  const substantive = triggerAtts.filter((a) => a?.filename && !isTrivialImage(a));
  const skippedCount = triggerAtts.length - substantive.length;
  if (substantive.length > 0) {
    lines.push(substantive.map((a) => `- ${a.filename} (${a.mime_type ?? 'okänd typ'}, ${a.size_bytes ?? '?'} B)`).join('\n'));
  } else if (skippedCount > 0) {
    lines.push(`(inga dokumentbilagor; ${skippedCount} trivial bild(er) hoppades över)`);
  } else {
    lines.push('(inga)');
  }
  lines.push('');

  lines.push('# Avtal vi redan extraherat ur mottagna bilagor');
  const contracts = db.listContractInfoForConversation?.(conv.id) ?? [];
  lines.push(contracts.length
    ? contracts.map((c) => `- ${c.vendor_name ?? 'okänd leverantör'}: ${c.document_type ?? 'okänt dokument'}${c.is_contract ? '' : ' (EJ ett avtal)'}`).join('\n')
    : '(inga extraherade ännu)');

  return lines.join('\n');
}
