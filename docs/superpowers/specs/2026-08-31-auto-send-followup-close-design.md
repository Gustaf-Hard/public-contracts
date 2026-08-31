# Auto-send T_FOLLOWUP_CLOSE + honest edit/approve ledger — design

Date: 2026-08-31. Status: approved for implementation.
Prereqs: 2026-08-17 auto-send nudge design, 2026-08-20 delay-ack design (this
is graduation #3 on the same rails).

## Motivation (evidence from the live ledger, box DB 2026-08-31)

1. **Every T_FOLLOWUP_CLOSE the operator has ever sent was untouched.**
   8/8 `edit` decisions have `final_body` byte-identical to `draft_body` once
   line endings are normalized. The template is 33 fixed words with no dates,
   no vendor names, no claims that age.
2. **The ledger under-reports approvals as edits.** The dashboard textarea
   submits `\r\n` line endings; the resolve endpoint compares nothing and
   records `decision='edit'` whenever the edit form was used. Result: the
   ledger holds **zero** `approve_unmodified` rows even though most "edits"
   changed nothing (nudge 15/15, close 8/8, receipt 16/18 untouched after
   CRLF normalization). Graduation evidence, `listOperatorDecisionTimes`
   semantics, and the edit-review page all deserve honest data.
3. 11 close-reminders sit open today and a steady stream follows (the
   14-day DELIVERING timer). It is the largest recurring one-click block in
   Behöver dig.

## Part A — honest ledger

### A1. CRLF normalization

In the dashboard resolve endpoint (`POST /escalations/:id`, dashboard.js):
normalize the submitted body before anything else:

```js
const normalize = (s) => (s ?? '').replace(/\r\n/g, '\n');
```

`finalBody` for the `edit` action becomes `normalize(req.body.body)`. The
free-form composer endpoint (`POST /arenden/:id/send` area, dashboard.js
~1035) normalizes its body the same way so stored `final_body` is always
`\n`-terminated.

### A2. Decision reclassification (dashboard resolve endpoint ONLY)

When `action === 'edit'` but the normalized submitted body equals
`esc.draft_body` (normalized) **and** the submitted subject equals
`esc.draft_subject` (or was not provided), record the decision as
`approve_unmodified`, not `edit`:

```js
const untouched = normalize(req.body.body) === normalize(esc.draft_body ?? '')
  && (req.body.subject == null || req.body.subject === (esc.draft_subject ?? ''));
const decision = action === 'send' || (action === 'edit' && untouched)
  ? 'approve_unmodified' : 'edit';
```

Consequence, intended: an untouched "edit" now faces the STALE_ESCALATION
guard exactly like an unmodified approve. If the operator did not change the
text, they did not incorporate newer context, so the guard's premise applies
regardless of which button was pressed. The 409 tells them to re-review.

**Why not centralize in `sendApprovedReply`:** the free-form composer
*creates* its escalation with `draft_body = finalBody` in the same request,
so draft always equals final by construction there — a choke-point rule
would misclassify every composed mail as `approve_unmodified`. (Same
artifact means the ledger's free_form "11/13 untouched" is NOT evidence of
LLM draft quality; analyses of untouched rates must exclude `free_form`.)
The Slack `edit` path (daemon.js) is dead on the AWS box (interactivity
port unexposed) and pilot-resolve's `edit` requires an explicitly provided
body; both are left as-is.

Historical rows are not rewritten. Queries that need the truth for old rows
normalize CRLF, as the 2026-08-31 analysis did.

## Part B — T_FOLLOWUP_CLOSE auto-send

### Guard: `isAutoSendableFollowupClose` (conversation.js, pure)

```js
isAutoSendableFollowupClose({ esc, conv, unreadDocs, autoSentCount })
  → { ok: true } | { ok: false, reason }
```

Rules, every one failing closed:

| # | Rule | reason |
|---|------|--------|
| 1 | `esc.draft_template === 'T_FOLLOWUP_CLOSE'` | `not_followup_close` |
| 2 | `conv.state === 'DELIVERING'` | `wrong_state` |
| 3 | `unreadDocs === 0` (`countUnreadAnalysableAttachments`) | `unread_documents` |
| 4 | `autoSentCount === 0` (`countAutoSendDecisions(conv.id, 'T_FOLLOWUP_CLOSE')`) | `auto_send_cap` |

Rule 2 is DELIVERING **only** — the evidence (8/8) is all-DELIVERING;
CROSSCHECK close-reminders stay manual until they earn their own record.
Rule 3: we must not ask "is that everything?" while a delivered avtal sits
unread (pending OR parked) on our own disk — same principle as the
T_REQUEST_MISSING suppression. Rule 4 is once per conversation, ever;
operator sends do not count (that is `countAutoSendDecisions` semantics).
`unreadDocs`/`autoSentCount` that are not finite numbers fail closed
(`Number.isFinite`, the delay-ack lesson).

**No draft-age rule, deliberately** (divergence from delay-ack's 48h):
the close template is timeless prose — no dates, no elapsed time, no
claims about specific mail — and the deploy-day backlog (11 open) is the
point of the release. Correctness against a changed world is carried by
`sendApprovedReply`'s existing guards: STALE_ESCALATION refuses when any
newer inbound exists in the DB, STALE_INGEST refuses while blind
(T_FOLLOWUP_CLOSE is in STALE_SENSITIVE_TEMPLATES), and `escalateWithDraft`
superseding means a surviving open close-draft has answered no new inbound.

### Sweep (tick.js, runDailyFollowup)

Mirrors the T_DELAY_ACK sweep exactly: runs after it, gated on
`autoSendTemplates.includes('T_FOLLOWUP_CLOSE') && !isInVacation(todayIso, cfg)`,
enumerates `listEscalationsByStatus('open')` filtered to the template,
per-escalation guard → `sendApprovedReply` with `decision: 'auto_send'` →
truthful status-read-back catch log (open / send_failed / uncertain). No
retry, no status mutation, next-run pickup.

**Per-run cap:** `CLOSE_AUTO_MAX_PER_RUN = 5` (constant in tick.js).
Escalations beyond the cap in one daily run are left open and logged
(`close auto-send cap reached — N left for tomorrow`); the backlog drains
over ~3 daily runs instead of one 11-mail burst. Eligible order:
escalation id ascending (oldest first).

### Kill switch & rollout

`auto_send_templates` in the overrides file gains `"T_FOLLOWUP_CLOSE"` —
at release time, on the box (`/var/lib/mediagraf/pilot-overrides.json`),
re-read per run as today. Pulling the key stops the next run without
restart.

CLAUDE.md invariant paragraph updates from "two templates" to "three",
naming the close guard set.

## Out of scope

- T_RECEIPT auto-send (graduation #4 — needs the two edited receipts read
  and a coverage-facts grounding rule; spec separately).
- Rewriting historical ledger rows.
- Slack/CLI decision reclassification.

## Test plan

- Guard unit tests: each rule's pass/fail + fail-closed on NaN/undefined.
- Sweep tests in a new `tests/auto-send-followup-close.test.js` mirroring
  `tests/auto-send-delay-ack.test.js` (temp-dir SQLite, fake gmailOps,
  overrides file): switch off → no send; eligible → exactly one send with
  decision `auto_send`; cap → 5 sent, 6th left open; unread docs → skip
  with reason; CROSSCHECK conv → skip; STALE_INGEST refusal leaves open;
  Gmail failure parks `send_failed`, never retried; vacation window → no
  sweep.
- Dashboard tests: untouched edit → `approve_unmodified` recorded, body
  stored with `\n`; real edit → `edit`; untouched edit on stale escalation
  → 409; composer body normalized.
