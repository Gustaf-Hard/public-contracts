# Autosvar / out-of-office recognition — wait silently, don't escalate

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

A vacation autoresponder ("Autosvar: … Jag har semester och är åter 20 juli …",
Bjuv escalation #38) was classified `unknown` by the OFFLINE regex classifier
and escalated free-form ("draft a reply"). It shouldn't demand the operator:
it's a machine autoresponder saying the person is away until a date. The LLM
path already routes an OOO to `delay_promise` → `T_DELAY_ACK` (a human-approved
"we'll wait" reply), but (a) the offline path has no OOO detection at all, and
(b) replying to an autoresponder is pointless and risks a reply loop.

## Decisions (from the operator)

- **Recognize the machine autoresponder → push the follow-up past the stated
  return date and WAIT SILENTLY.** No escalation, no reply. Applied on BOTH the
  offline and LLM paths.
- A genuine HUMAN delay promise ("vi behöver ca 10 arbetsdagar") is unchanged —
  it still gets the `T_DELAY_ACK` graceful acknowledgement.
- A colleague named for urgent matters ("vid akuta ärenden kontakta X") is NOT
  a handoff — ignore it and keep waiting for the registrator to return.

## Design

### 1. New intent/class `auto_reply` (distinct from `delay_promise`)
- **`src/analyse-message.js`**: add `auto_reply` to the intent enum (an enum
  value adds ZERO json_schema union params — safe, like the `document_type`
  extension). Prompt guidance: *a MACHINE autoresponder / frånvaro / OOO
  (markers like "Autosvar:", "automatiskt svar", "frånvarande", "är åter",
  "semester", "out of office") → `auto_reply`, `suggested_action: "wait"`, and
  set `promised_response_date` to the stated return date when present; a HUMAN
  who promises a timeframe → `delay_promise` (unchanged).* Reclassify the
  existing "Frånvaroautosvar" few-shot from `delay_promise` to `auto_reply`
  (action `wait`, no `draft_reply`), and KEEP a human-delay few-shot as
  `delay_promise` → `send_delay_ack`. `auto_reply` must carry NO `draft_reply`
  and NO handoff extraction (ignore the urgent-contact colleague).
- **`src/classifier.js`** (offline path): add CONSERVATIVE, high-precision OOO
  detection → the `auto_reply` class, extracting the return date. Markers
  (case-insensitive, on the UNQUOTED body via `stripQuotedText`): subject or
  body starting with / containing `Autosvar`, `Automatiskt svar`,
  `Auto-reply`/`Out of office`/`OoO`, or `frånvar*` combined with `är åter` /
  `åter den` / `tillbaka` / `semester`. Precision over recall — if unsure, fall
  through to the existing classification (do NOT tag a real reply as OOO).
- `analysisToLegacyClassification` maps `auto_reply` → the same offline class so
  both paths converge on one transition.

### 2. Handling: wait, set follow-up, never escalate
- The transition for `auto_reply` (in `src/conversation.js` / wherever
  `auto_ack` is handled) mirrors `auto_ack`: `suggested_action: 'wait'`, NO
  escalation, NO state advance to a terminal/handoff state — the conversation
  stays in its current waiting state.
- **Follow-up date:** set `follow_up_at` = the stated return date + 3 days grace
  (reuse the existing delay grace); if no return date could be extracted, use a
  default grace of 14 days from receipt (semester can be weeks). The message is
  still stored + classified `auto_reply`.
- **Loop-safe by construction:** because `auto_reply` NEVER sends a reply and
  NEVER escalates, a re-firing autoresponder just refreshes the follow-up date —
  no reply loop, no escalation spam.

### 3. Existing Bjuv #38 — supervised cleanup (offline helper, do NOT run)
Bjuv #38 is an open free-form escalation that is really an autosvar. Provide an
offline-testable helper (extend `scripts/09`-style, or a small storage function)
that supersedes open free-form escalations whose triggering message is a
recognized `auto_reply`, setting the conversation's follow-up past the return
date. The subagent writes + tests it offline; the OPERATOR runs it supervised,
backup-first.

## Constraints (non-negotiable)

- **Precision over recall** — a real kommun reply (delivery / clarification /
  handoff / fee) must NEVER be misclassified as `auto_reply` (that would
  silently suppress a needed escalation). Conservative markers only; when in
  doubt, fall through. Add tests for the non-OOO cases staying unaffected.
- **No schema change** — `auto_reply` is a new intent-enum value + a new string
  class value in existing TEXT columns.
- **No data loss** — the autoresponder message is stored.
- **Human `delay_promise` behaviour unchanged** — `T_DELAY_ACK` still fires for
  a real human delay; its tests stay green untouched.
- **Union limit** — only an enum value is added to the message schema (0 new
  union params); verify the count is unchanged.
- **Pure functions stay pure** (classifier, conversation transition take inputs
  as args).
- **Subagent works offline only** — temp/`:memory:` SQLite, injected fakes,
  `vi.spyOn(analyseMod,'analyseMessage')`; no live `data/pilot.db`, daemon,
  Gmail, Slack, Anthropic, or `pilot-*`/`scripts/*` runs.
- **Base:** reset the worktree onto the current `main` tip first
  (`worktree-stale-base`). Leave commits on an `autosvar-recognition` branch.
- Full offline `npm test` green.

## Testing (offline)

- `classifier.js`: the Bjuv autosvar ("Autosvar: … Jag har semester och är åter
  20 juli …") → `auto_reply` with return date `2026-07-20`; a plain
  autoresponder with no date → `auto_reply`, no date; a genuine delivery /
  clarification / handoff reply → its normal class (NOT `auto_reply`); an email
  merely quoting the word "semester" in history → not OOO (quoted text
  stripped).
- `analyse-message` (faked LLM): an `auto_reply` intent → action `wait`, no
  `draft_reply`, no handoff.
- `runTick` ingest: an autosvar inbound → message stored `auto_reply`, NO
  escalation created, `follow_up_at` = return date + 3 (or +14 default), state
  unchanged; a human `delay_promise` still creates the `T_DELAY_ACK` escalation.
- Retag helper: supersedes an open free-form escalation whose message is an
  `auto_reply`; leaves genuine free-form escalations alone.

## Out of scope

- Any change to `T_DELAY_ACK` / human delay handling.
- Treating the urgent-contact colleague as a handoff (explicitly excluded).
- Slack-side changes.
