# Bounce (NDR) handling — a dead-address delivery failure is not a reply

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

A T-INITIAL to `lund.kommun@lund.se` bounced: Gmail's `mailer-daemon`
returned a "Delivery Status Notification (Failure) — Address not found". The
bounce landed in the T-INITIAL's Gmail thread, so thread-matching attached it
to the Lund conversation, and — because the codebase has **no notion of a
bounce** — it was classified `unknown` and escalated as a free-form
"Behöver dig / draft a reply" (escalation #10). That is wrong twice: nobody
should draft a reply to `mailer-daemon`, and the real problem (the address
doesn't exist, so the request never reached Lund) is invisible.

Triage of the 21 open escalations found exactly one bounce (#10 Lund) and one
out-of-office autosvar (#38 Bjuv, deferred — see out of scope). Both fell
through as `unknown` → free-form escalation because there is no category for
"delivery failed" or "auto-reply".

## Decisions (from the operator)

- **Resend UX: manual address entry.** The bounce escalation lets the operator
  type a corrected recipient address and resend the T-INITIAL. No dataset
  auto-suggest for now.
- **Scope: bounces only.** Autosvar / out-of-office recognition is a separate
  follow-up.

## Design

### 1. Detector — `src/bounce.js` (pure, no IO) — PRE-BUILT
- `isBounce({ from_email, subject, body_text })` → boolean. True when the
  sender is a mail daemon (`mailer-daemon@` / `postmaster@`, or a "Mail
  Delivery Subsystem" / "Delivery Status Notification" display name) OR the
  subject/body carries a strong NDR phrase ("Address not found", "wasn't
  delivered to …", "does not exist", "550 5.1.1", "Undeliverable", "returned
  to sender", Swedish "kunde inte levereras"). Whole-message, case-insensitive.
- `failedRecipient(body_text)` → best-effort address that bounced (the address
  after "delivered to …"), else null.
- Low false-positive risk: a genuine kommun reply is neither from a daemon nor
  says "wasn't delivered to <addr>".

### 2. Ingest short-circuit — `src/tick.js`
In the inbound path, **before** LLM analysis / draft / escalate, check
`isBounce(message)`. On a bounce:
- Store the message (no data loss) with classification `bounce` (a NEW string
  value in the existing TEXT column — no schema change), skip the LLM analysis
  and the reply-draft path entirely.
- Mark the conversation's send as **failed to that address**: move the
  conversation to `NEEDS_HUMAN` and record the bounced address (from
  `failedRecipient`, fallback to `conv.contact_email`) in the escalation
  reason.
- Open ONE bounce escalation via the existing `escalateWithDraft` (so the
  one-open-escalation invariant + supersede logic still hold):
  `classifier_class='bounce'`, `draft_template='T_RESEND_BAD_ADDRESS'`,
  reason "Leveransfel: adressen `<addr>` finns inte — ange ny adress och
  skicka om begäran." `draft_body` = the T-INITIAL body (so the operator sees
  exactly what will be resent), `draft_subject` = the original T-INITIAL
  subject.

### 3. Escalation UI — `src/dashboard-views.js` `renderEscalationForm`
When the escalation is a bounce (`classifier_class==='bounce'` /
`draft_template==='T_RESEND_BAD_ADDRESS'`), render a DISTINCT form instead of
the reply textarea:
- A clear "leveransfel" banner naming the dead address.
- A **required address input** (`name="finalTo"`, empty; the dead address shown
  struck-through as context) + the (editable) T-INITIAL body.
- A single button: **"Skicka om begäran (T-INITIAL)"**.
No "approve unmodified reply" affordance — this is a resend, not a reply.

### 4. Resend path — `src/send-reply.js`
`sendApprovedReply` handles the bounce escalation as a **T-INITIAL resend**,
not a thread reply:
- Recipient = the operator-entered `finalTo` (required; reject empty with the
  escalation re-shown).
- Send a fresh T-INITIAL (new thread — do NOT reply into the bounce thread),
  subject = T-INITIAL subject, body = the (possibly edited) T-INITIAL body.
- Go through the SAME two-phase, atomically-claimed approved-send shape
  (`open → sending` before Gmail; park failures as `send_failed` /
  `send_unconfirmed`; never back to `open`; never auto-retry). On success the
  conversation returns to `SENT` with the new recipient + new thread, and the
  escalation resolves `resolved_send`.
- Update `conv.contact_email` to the corrected address so future matching /
  follow-up uses it.
- **Not a double-message:** the original send bounced (reached no one), and the
  atomic claim prevents a double-resend.

### 5. Existing #10 — supervised one-off
Only one open bounce escalation exists today (#10 Lund). Add nothing
automatic. Either the operator resends it via the new form once live, OR a
tiny supervised retag step converts existing `mailer-daemon` free-form
escalations to `classifier_class='bounce'` so the resend form shows. The
subagent writes the retag as an offline-testable helper but does NOT run it.

## Constraints (non-negotiable)

- **Send-safety invariants preserved** (CLAUDE.md): all sends — including the
  resend — go through `sendApprovedReply`'s two-phase atomic-claim shape; at
  most one open escalation per conversation; ticks never overlap. Do NOT add a
  send path that bypasses this. The resend must never re-send to the SAME
  (bounced) address without operator input.
- **No schema change.** `bounce` / `T_RESEND_BAD_ADDRESS` are new string values
  in existing TEXT columns (classification, classifier_class, draft_template).
- **No data loss.** The bounce message is stored; nothing deleted.
- **Pure detector stays pure** (`bounce.js` takes the message fields as args).
- **Subagent offline only** — temp/`:memory:` SQLite, injected fake
  `gmailOps`/`slackOps`, `gmailSendImpl` seam, fixtures. No live `data/pilot.db`,
  daemon, Gmail, Slack, Anthropic, or `pilot-*` runs.
- **Base:** reset the worktree onto the current `main` tip first
  (`worktree-stale-base`). Leave commits on a `bounce-handling` branch.
- **Tests-as-contract first.** Full offline `npm test` green.

## Sequencing

Implementation of §2–§5 edits `tick.js`, `storage.js`, `dashboard-views.js`,
`send-reply.js`, `templates.js` — `storage.js`/`dashboard-views.js` overlap the
in-flight `vendor-ramavtal` branch, so §2–§5 are implemented **after** that
branch merges (the subagent resets onto the merged tip). The pure detector
(§1) has no overlap and is pre-built now on `main`.

## Testing (offline)

- `isBounce`: the real Lund NDR (from `mailer-daemon@googlemail.com`, subject
  "Delivery Status Notification (Failure)", body "Address not found … wasn't
  delivered to lund.kommun@lund.se") → true; a normal kommun reply → false; an
  autosvar → false (out of scope, must NOT be caught as a bounce);
  `failedRecipient` extracts `lund.kommun@lund.se`.
- `runTick` ingest: a bounce inbound → no LLM analysis, no reply draft,
  conversation `NEEDS_HUMAN`, exactly one open `classifier_class='bounce'`
  escalation; a normal reply is unaffected.
- `sendApprovedReply` on a bounce escalation: rejects empty `finalTo`; with a
  new address, resends a T-INITIAL in a NEW thread via the two-phase claim,
  sets `SENT` + updated `contact_email`, resolves the escalation; a send
  failure parks as `send_failed`, never `open`.
- `renderEscalationForm`: a bounce escalation renders the address-entry +
  resend form, not the reply textarea.

## Out of scope (follow-ups)

- **Autosvar / out-of-office** recognition (Bjuv #38): treat "Autosvar:" / OOO
  as a delay with a follow-up date, not a human reply. Separate spec.
- Dataset-driven address suggestion on resend (operator chose manual entry).
- SPF/DMARC or transient (4xx) soft-bounce retry logic — only hard failures
  (bad address) are handled here.
