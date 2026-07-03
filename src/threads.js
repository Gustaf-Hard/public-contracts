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
