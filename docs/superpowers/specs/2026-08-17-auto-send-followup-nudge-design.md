# Auto-send follow-up nudges (first unattended send)

**Date:** 2026-08-17
**Status:** Approved by operator (this conversation)
**Predecessors:** `2026-07-05-autopilot-readiness-review.md` (path to autopilot,
step 7), `2026-06-23-trustworthy-next-action-design.md` (staleness rules),
`2026-07-17-vacation-mode-design.md` (follow-up gates)

## Goal

Graduate the first outbound class from human-approved to automatic:
`T_FOLLOWUP_NUDGE`, the generic "Jag vill bara följa upp om min begäran…"
reminder, sent only to kommuner that have given no substantive response.
Everything else — receipts, precision answers, closes, resends, refreshes,
free-form — stays human-approved.

## Why now

The autopilot roadmap required, before flipping any class: idempotent
two-phase sends, serialized ticks, transactional ingest, one open escalation
per conversation, a decisions ledger, and a clean-approval streak for the
candidate pair. All infrastructure shipped (readiness review steps 1–6,
completed through the 2026-08-17 hardening batch). The ledger shows 9
`T_FOLLOWUP_NUDGE` sends across 2026-06-06 → 2026-08-17, every one sent with
the draft byte-identical up to CRLF line endings — a 9/9 unmodified streak.
The operator has explicitly granted trust for this class.

## Eligibility — "no substantive response yet"

A drafted `T_FOLLOWUP_NUDGE` auto-sends only when **all** hold:

1. The draft template is exactly `T_FOLLOWUP_NUDGE` (never
   `T_FOLLOWUP_CLOSE`, never `free_form`).
2. **Every** inbound message in the conversation is classified in the LAZY
   set: `auto_ack`, `auto_reply`, `delay_promise`, `handoff_internal`.
   Zero inbound also qualifies. If any inbound is `delivery`,
   `clarification`, `dead_end`, `bounce`, `unknown`, or has NULL
   classification, the draft escalates to the operator as today —
   **fail closed**: unclassifiable means not lazy.
3. `auto_send_templates` in `data/pilot-overrides.json` contains
   `"T_FOLLOWUP_NUDGE"` (the kill switch, below).
4. All existing gates already passed upstream (they are unchanged, listed
   here for the record): ingest-health gate on `runDailyFollowup`, vacation
   window, `hasActiveEscalation`, `follow_up_at` (a delay promise or soft
   handoff sets a future date — no nudge fires inside the window the kommun
   asked for), `staleAction` thresholds and `MAX_NUDGES`.

Both nudge #1 and nudge #2 may auto-send while the conversation stays lazy.
After `MAX_NUDGES` (2), `staleAction` returns `escalate` and a human decides,
exactly as today.

In practice the eligible states are `SENT` and `ACK_RECEIVED` (an
`AWAITING_PRECISION` conversation contains a `clarification` and can never
pass rule 2).

## Timing — 9–15 day deterministic jitter

The nudge thresholds in `STALE_RULES` change from fixed days to a
per-conversation value in **[9, 15]**: `9 + (hash(conv.id) % 7)` days, where
`hash` is a small pure integer hash (not `Math.random` — deterministic for
tests and stable across ticks, and varied across kommuner so reminders do not
all land on the same day-count like clockwork).

- `SENT`: was 7 days → now 9–15.
- `ACK_RECEIVED`: was 14 days → now 9–15 (mean ≈ 12; an ack is just
  "diarieförd", slightly sooner is acceptable).
- `AWAITING_PRECISION` (10 days), `DELIVERING`/`CROSSCHECK` (14 days,
  `T_FOLLOWUP_CLOSE`): unchanged.

The jitter applies to the *drafting* threshold, so it also shifts when
manual-approval nudges are drafted — that is intended; it is the same nudge.
Sends go out at the daily follow-up run (09:00 or its catch-up). Intra-day
time jitter is explicitly out of scope for this iteration.

Implementation: `staleAction(state, days, followupCount, opts)` gains
`opts.nudgeJitterDays` (0–6, computed by the caller from `conv.id`), added to
`rule.days` only when `rule.action === 'send_followup_nudge'`. `staleAction`
stays pure; `STALE_RULES.SENT.days` becomes 9.

## Mechanism — auto-approve on the existing rails

No new send path (safety invariant #1). In `runDailyFollowup`, after
`escalateWithDraft` returns the created escalation for a qualifying
conversation, the loop immediately calls `sendApprovedReply` with:

- `decision: 'auto_send'` — a **new string value** in the existing decision
  vocabulary (repo convention: extend TEXT columns by value, no migration).
  The ledger permanently distinguishes machine sends from operator sends.
- The draft exactly as escalated (no body/subject/recipient overrides).

Everything downstream is the proven path: atomic `open → sending` claim,
`STALE_INGEST` guard (the nudge is a `STALE_SENSITIVE_TEMPLATE`),
`MISSING_RESEND_ADDRESS`/bounce refusals, thread routing, decision recording,
inbox archiving.

One guard needs widening: the `STALE_ESCALATION` check in `sendApprovedReply`
(newer inbound in the DB since the draft was created) currently fires only for
`decision === 'approve_unmodified'`. It MUST also fire for `'auto_send'` —
the condition becomes `decision === 'approve_unmodified' || decision ===
'auto_send'`. The shared escalation mutex means no tick can ingest between
drafting and auto-sending in the same run, but the guard must not rely on
that reasoning holding forever.

Consequences of each outcome:

- **Success** → escalation `resolved_send`, decision `auto_send`,
  `followup_count` incremented — indistinguishable from a manual send except
  for the decision value.
- **Send failure** → parks as `send_failed`/`send_unconfirmed`, never
  retried, blocks further drafts via `hasActiveEscalation` — same as a failed
  manual send. Auto-send makes no new attempt; the parked escalation is the
  operator's to resolve.
- **Refusal before the claim** (e.g. `STALE_INGEST` in a race) → the
  escalation stays `open` and appears in the operator's normal queue; the
  error is logged. The automation does NOT retry an open refusal — the next
  daily run skips the conversation entirely (`hasActiveEscalation`).

`escalateWithDraft` is called first (rather than sending directly) so a
crash between escalation and send leaves an `open` escalation a human can
act on — never a lost intention, never an untracked send.

## Kill switch

`data/pilot-overrides.json`:

```json
{ "auto_send_templates": ["T_FOLLOWUP_NUDGE"] }
```

- Read **fresh at the start of every `runDailyFollowup`** (a stale in-memory
  copy must not keep sending after the operator pulls the switch). The
  daemon's startup-loaded overrides object is not reused for this key.
- Absent key, empty array, malformed file → `[]` → fully manual (today's
  behavior). The feature ships OFF; the operator flips it on the box.
- Scoped per template so future graduates (`T_RECEIPT`, `T_FOLLOWUP_CLOSE`)
  reuse the same switch.

## Visibility — dashboard feed

Slack is not configured on the box, so the roadmap's "FYI-after-send" goes to
the dashboard instead:

- New section **"Auto-skickade"** on `/arenden`: the most recent 20 decisions
  with `decision = 'auto_send'` — kommun, role, sent-at, nudge count, link to
  the thread view. Backed by one new read-only storage query
  (`listAutoSendDecisions(limit)`).
- Auto-sent messages also appear in every existing surface exactly like
  manual sends (thread view outbound, pipeline board, decisions ledger).

## Out of scope (explicit)

- Auto-sending `T_FOLLOWUP_CLOSE`, `T_RECEIPT`, or any other template.
- Intra-day send-time jitter.
- Slack FYI notifications (no Slack on the box; the guards that would post
  them remain silent no-ops).
- Any change to `MAX_NUDGES`, the escalate-after-cap behavior, or the
  bounce/resend flow.
- Widening the LAZY set (e.g. human "vi har mottagit" acks classified
  `unknown` stay human-gated; revisit only with ledger evidence).

## Testing (offline, existing fakes)

1. Eligible conversation (SENT, zero inbound, threshold passed, switch on)
   → exactly one Gmail send via the injected `gmailSendImpl`, escalation
   `resolved_send`, decision `auto_send`, `followup_count` = 1.
2. Lazy-only inbound (`auto_ack` then `delay_promise` past its
   `follow_up_at`) → auto-sends.
3. Any substantive inbound (`clarification` / `delivery` / `unknown` / NULL
   classification) → escalation stays `open`, nothing sent.
4. Kill switch absent/empty/malformed → escalation stays `open`, nothing
   sent; switch edited between two runs takes effect without restart.
5. Jitter: threshold is within [9, 15] for arbitrary conv ids, stable for
   the same id across calls; day 8 does not draft for a conv with jitter 0
   (9 days); `ACK_RECEIVED` uses the same jitter; `AWAITING_PRECISION`
   unchanged at 10.
6. Send failure (fake Gmail throws) → parked `send_failed`, decision absent,
   next daily run does not re-attempt (`hasActiveEscalation` skip).
7. Nudge cap: `followup_count` = 2 → `free_form` escalation to a human,
   never auto-sent.
8. `STALE_INGEST` refusal → escalation stays `open`, no decision row, no
   crash of the run; remaining conversations still processed. Same for
   `STALE_ESCALATION`: an inbound row newer than the draft blocks an
   `auto_send` exactly as it blocks `approve_unmodified`.
9. Dashboard: `listAutoSendDecisions` returns newest-first with the join
   fields the view needs; `/arenden` renders the section only when rows
   exist.
