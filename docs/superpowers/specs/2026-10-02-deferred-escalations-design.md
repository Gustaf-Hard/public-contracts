# Deferred escalations ("Pausade") — design, 2026-10-02

## Why

After the 2026-09-26 batch, 58 of the 174 "Behöver dig" items are ones the
reviewers deliberately left to the operator: 38 fee demands (avgift), 15
sekretess/masking decisions, 4 legal (overklagbart beslut), 1 bounce. The
operator decided: park the fee and legal ones without replying (silence lets
the kommun close the case; a "vi avvaktar" mail adds nothing and a
sammanställning/sammanfattning request is a new, chargeable request), test a
free "uppgift ur allmän handling" ask on 5 fee cases, and send a plain receipt
on the sekretess ones (masking accepted).

Today an escalation is either active (`open`, `sending`, `send_failed`,
`send_unconfirmed`) or terminal. There is no "parked by the operator, nothing
sent, resumable" state, so parked cases either sit red in Behöver dig forever
or get `skip`ped and vanish (and a `NEEDS_HUMAN` case that was skipped is
nagged daily as a 🧭 orphan).

## The new status: `deferred`

A new string value in `escalations.status` (no migration — CLAUDE.md "No
schema changes casually"). Semantics:

- The operator looked at the draft and chose to do nothing for now. Nothing
  was sent. The draft body is kept as-is so it can be resumed.
- `resolved_at` = the moment it was parked ("pausad sedan").
- `resolved_text` = `pausad: <reason>` where reason ∈ `avgift | sekretess |
  juridik | annat`, optionally followed by ` – <free note>`. Parse with a
  small helper `parseDeferReason(resolved_text)` in storage.js; never
  regex it elsewhere.
- Ledger: `recordDecision({ decision: 'defer', final_body: null,
  conversation_state: esc.previous_state ?? conv.state })`. On resume:
  `decision: 'resume'`. Both are automatically outside the
  `listOperatorDecisionTimes` allowlist (`approve_unmodified`, `edit`), so a
  defer never discharges a kommun frist — update that allowlist's rationale
  comment to name `defer`/`resume` alongside `skip`/`closed`.

### Not in `ACTIVE_ESCALATION_STATUSES`

`deferred` is NOT added to `ACTIVE_ESCALATION_STATUSES`. That set means
"outbound work is pending or may have left Gmail"; a deferred row is neither.
Consequences we want for free: it leaves `buildActionQueue`, `caseBucket`
`behover_dig`, `listOpenEscalationsAgedDays`, `listOrphanNeedsHuman`,
`hasActiveEscalation`, STALE_ESCALATION etc.

Add instead:

```js
// storage.js
export const DEFERRED_ESCALATION_STATUS = 'deferred';
hasDeferredEscalation(conversationId)        // any row with status='deferred'
listDeferredEscalations()                    // all, newest-parked first, joined with kommun/role/state
listDeferredEscalationsForConversation(id)
deferEscalationIfOpen(id, { reason, note })  // UPDATE … WHERE id=? AND status='open' → true/false
resumeEscalationIfDeferred(id)               // UPDATE … SET status='open', resolved_at=NULL, resolved_text=NULL WHERE id=? AND status='deferred' → true/false
```

Invariant: at most one open escalation per conversation still holds. Resume
must refuse (return false / 409) if the conversation already has a row in
`ACTIVE_ESCALATION_STATUSES` — check inside the same transaction.

### Defer moves the conversation off `NEEDS_HUMAN`

`NEEDS_HUMAN` with no active escalation is treated as a bug everywhere
(`listOrphanNeedsHuman`, `buildActionQueue` state arm). So on defer, when
`conv.state === 'NEEDS_HUMAN'`, set the conversation to
`saneRestoreState(esc.previous_state, conv, db)` (already exported from
send-reply.js; move it to a shared place if importing send-reply into
storage/dashboard is awkward — do not duplicate it). `escalations.previous_state`
keeps the pre-NEEDS_HUMAN state, which is what resume does NOT need to restore:
an open escalation in any state is in Behöver dig via the escalation arm.
`follow_up_at` is set to NULL on defer (no live follow-up promise, same as
close).

### What wakes a deferred case up

- **The operator** clicks ▶️ Återuppta (dashboard) → `resumeEscalationIfDeferred`.
- **A new inbound mail that mints a draft**: `escalateWithDraft` (tick.js)
  supersedes a `deferred` row exactly like it supersedes an `open` one
  (status `superseded`) before inserting the new row. A kommun answering the
  uppgift ask or dropping the fee must reach the operator.
- Nothing else. In particular:
  - The void/no-reply inbound path (tick.js ~845, supersedes `open` rows) must
    NOT touch `deferred` rows — an auto-ack must not make a parked case vanish.
  - `supersedeStaleNudgeEscalations` (vacation mode) stays `status='open'`.
  - `retryUnpostedEscalations` stays `status='open'`.

### What a deferred case must be excluded from

- `runDailyFollowup` staleness loop: the gate at tick.js ~1628 becomes
  `if (db.hasActiveEscalation(id) || db.hasDeferredEscalation(id)) continue;`
  — a parked fee dispute must never get a fresh T_FOLLOWUP_NUDGE/CLOSE/FINAL.
- `runRefreshScan` heal of `REFRESH_DUE` → `DONE`: same `|| hasDeferred`.
- `buildWaiting` (dashboard): exclude conversations with a deferred row, or
  they reappear under "Pågår" the moment they leave Behöver dig.
- Köhälsa ⏰ `listConversationsWithDeadlineDue`: exclude conversations with a
  deferred row. The whole point of parking is that the deadline is not ours
  to chase right now.
- Auto-send sweeps iterate `status='open'` only — unaffected.

## Dashboard

- **Overview card** "Pausade" next to Behöver dig, `<div class="value warn">`
  (yellow; `.value.warn` exists). Count = `listDeferredEscalations().length`.
- **Overview section** "Pausade" below Behöver dig, reusing `queueRow`, wrapper
  class `queue-warn` with `.queue-warn .queue-row { border-left: 3px solid
  var(--warn) }`. Row label: `Pausad (avgift) · sedan <date>`; link to the
  ärende. Sorted oldest-parked first.
- **Ärenden master list**: 4th bucket `{ key: 'pausade', label: 'Pausade' }`
  in `ARENDEN_BUCKETS`, `caseBucket` branch BEFORE `behover_dig`, new
  `.mail-dot.warn`. `loadCaseSummaries` gains `deferred_esc` count.
- **Ärende page**: a card like `renderParkedSends` (same `.reply-box` shape)
  per deferred row showing reason/note, the frozen draft, and one form
  `▶️ Återuppta` → `POST /escalations/:id/resume` (409 if not deferred or
  the conversation already has an active row). Kommun page and focused-thread
  page must also render deferred rows (they currently read `status='open'`
  only — the a7ec79c bug class).
- **Pausa button**: third form in `renderEscalationForm`, `POST
  /escalations/:id` with `action=defer`, a `<select name="reason">` (avgift /
  sekretess / juridik / annat) and optional `note`. Handled next to the `skip`
  branch; uses `deferEscalationIfOpen`, records the `defer` decision, strips
  Slack buttons, moves the conversation off NEEDS_HUMAN as above. Adjust the
  `action !== 'send' && action !== 'edit'` 400 guard.
- `escalationActionLabel` is unaffected (deferred rows never reach it); add
  a `deferredLabel(esc)` helper for the Pausade rows.
- `?filter=pausade` on the overview is NOT needed now.

## Batch applier: `defer` verdict

`src/apply-verdicts.js`: new verdict `defer` with `defer_reason` (required,
one of the four) and optional `defer_note`. Same five guards as `skip`
(human / missing / not_open / draft_changed / newer_inbound). Dry run →
`would_defer`; apply → `deferEscalationIfOpen` + `recordDecision('defer')` +
NEEDS_HUMAN restore → `deferred`. No Gmail. `--only=defer` works because the
filter is a plain Set on `v.verdict`. Document in CLAUDE.md next to the
existing batch paragraph.

## `T_UPPGIFT` template (src/templates.js)

Pure function `T_UPPGIFT({ thread_subject, from_name, from_email })` →
`{ subject: 'Re: ' + thread_subject, body }`. Body (no em-dash, no legal
paragraph cites, organisational "vi", no company name, no date):

```
Hej,

Tack för beskedet om avgiften. Vi avstår från kopior av handlingarna tills vidare.

I stället undrar vi om ni kan lämna uppgifter ur avtalen, så att inga kopior behöver tas fram: leverantör, vad avtalet gäller, avtalsperiod och årskostnad eller kontraktsvärde. En rad per avtal direkt i mejlet räcker gott, eller ett utdrag ur ert avtalsregister om ni har ett sådant.

Vänliga hälsningar
<signature>
```

Register it in the `TEMPLATES` map in tick.js and in `escalationActionLabel`
("uppgiftsförfrågan"). No automatic chooser wires it yet; the five test sends
go through the applier as `edit` verdicts whose `final_body` is this template's
output. It is NOT stale-sensitive (asserts nothing about silence).

## Tests (vitest, offline)

- storage: `deferEscalationIfOpen`/`resumeEscalationIfDeferred` guards;
  `hasDeferredEscalation`; `listOrphanNeedsHuman` and
  `listConversationsWithDeadlineDue` exclusion; `it.each(ACTIVE…)` loops get a
  `deferred` counterpart asserting the opposite.
- tick-followup: `active (non-terminal) escalations gate new drafts` gains
  "a deferred escalation gates the staleness loop"; `escalateWithDraft`
  supersedes a deferred row on a new inbound; the void path leaves it alone.
- dashboard: defer via POST moves NEEDS_HUMAN off and out of Behöver dig and
  out of Pågår; Pausade card count + section; ärende page card + resume;
  resume refused when an active row exists; Ärenden bucket ordering
  (arenden-order.test.js pattern).
- apply-verdicts: `defer` dry/apply, guards inherited, `--only=defer`.
- templates: `T_UPPGIFT` describe + it passes the no-em-dash sweep.

## Out of scope

Automatic choice of `T_UPPGIFT` for `fee_demand` classifications (do it when
the 5-case test has an answer). Slack button for Pausa (dashboard only).
