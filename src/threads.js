// Pure thread logic — no IO. Recipient resolution here; status inference
// (inferThreadStatus) is added in Phase 2.

// Decide who a reply goes to and which Gmail thread it belongs in.
// Priority: the message we are answering → a single primary thread → the
// conversation's original contact. Always yields a non-empty `to` when the
// conversation has a contact_email.
export function resolveReplyRecipient({ triggeringMessage, conv, primaryThreads = [] }) {
  if (triggeringMessage) {
    return {
      to: triggeringMessage.from_email,
      threadId: triggeringMessage.gmail_thread_id ?? conv.gmail_thread_id ?? null,
    };
  }
  if (primaryThreads.length === 1) {
    return {
      to: primaryThreads[0].counterparty_email,
      threadId: primaryThreads[0].gmail_thread_id ?? conv.gmail_thread_id ?? null,
    };
  }
  return { to: conv.contact_email, threadId: conv.gmail_thread_id ?? null };
}

// Over the STORED legacy classification values (auto_ack, clarification,
// delivery, dead_end, unknown). `unknown` is deliberately NOT noise — it carries
// handoffs / fee demands that must escalate to a human, so it maps to neutral.
export const SUBSTANCE = new Set(['delivery', 'clarification']);
export const NOISE = new Set(['auto_ack']);

// Classify a thread from its inbound messages.
//  primary  — any inbound has attachments OR a SUBSTANCE classification
//  muted    — ≥1 inbound and ALL inbound are NOISE (auto_ack) with no attachments
//  neutral  — no inbound, or anything else (unknown, dead_end, mixed)
export function inferThreadStatus(inbound) {
  if (!inbound || inbound.length === 0) return 'neutral';
  const anySubstance = inbound.some((m) => (m.attachment_count ?? 0) > 0 || SUBSTANCE.has(m.classification));
  if (anySubstance) return 'primary';
  const allNoise = inbound.every((m) => (m.attachment_count ?? 0) === 0 && NOISE.has(m.classification));
  if (allNoise) return 'muted';
  return 'neutral';
}
