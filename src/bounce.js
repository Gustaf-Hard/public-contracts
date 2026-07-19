// src/bounce.js
// Detects delivery-failure notifications (bounces / NDRs) so a dead-address
// mailer-daemon message is never treated as a kommun reply needing a drafted
// answer. A bounce means the request never reached anyone — it needs a
// corrected address + resend, handled as a distinct escalation (see
// docs/superpowers/specs/2026-07-19-bounce-handling-design.md).
// Pure: no IO. Takes the stored message fields as args.

// Sender is a mail delivery daemon (address or display name).
const DAEMON_RE = /(mailer-daemon|postmaster)@|mail delivery (subsystem|system)|delivery status notification/i;
// Strong NDR subject markers.
const SUBJECT_RE = /delivery status notification\s*\(failure\)|undeliverable|mail delivery (failed|subsystem)|delivery has failed|returned to sender|(kunde inte|gick inte att) leverera|leveransmisslyckande/i;
// Strong NDR body phrases (EN + SV). Deliberately specific so a genuine reply
// that merely mentions an "address" is not mistaken for a bounce.
const BODY_RE = /address not found|couldn'?t be found|address couldn'?t be found|was(?:n'?t| not) delivered to|does not exist|user unknown|mailbox (unavailable|full|does not exist)|550[ -]?5\.[0-9]\.[0-9]|recipient address rejected|kunde inte (levereras|hittas)/i;

// True when the message is a delivery-failure notification, not a real reply.
export function isBounce({ from_email = '', subject = '', body_text = '' } = {}) {
  if (DAEMON_RE.test(String(from_email))) return true;
  if (SUBJECT_RE.test(String(subject))) return true;
  if (BODY_RE.test(String(body_text))) return true;
  return false;
}

// Best-effort extraction of the address that bounced, from the NDR body
// ("… wasn't delivered to <addr> because …"). Returns null when not found.
export function failedRecipient(body_text = '') {
  const m = String(body_text).match(/delivered to\s+([^\s<>]+@[^\s<>]+)/i);
  if (!m) return null;
  return m[1].replace(/[.,;:)\]]+$/, '');
}
