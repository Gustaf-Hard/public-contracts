# Soft internal forwards should wait, not escalate

**Date:** 2026-07-20
**Status:** approved (operator: soft forwards only, ≥21 days), ready for implementation

## Problem

A reply like Bjurholm #21 — *"Tack för ditt mail … Jag skickar det vidare till
skol och IT-chef … Med anledning av semestertider så kan återkopplingen ta något
längre tid än vanligt"* — is classified `handoff` by the LLM, which maps to
`unknown` (`analysisToLegacyClassification`) and therefore **always escalates to
`NEEDS_HUMAN`**. But this is not a real handoff: the registrator forwarded the
request *internally* to the right person and warned it's slower due to semester.
It clutters "Behöver dig" demanding a click when the only correct action is to
wait. (Avesta #12 "vidare till Upphandlingsenheten" and Eda #43 "vidare till
Bildning" are the same shape.)

The prompt already defines `handoff` as a *permanent redirect to another
address/registrator we must contact* — those genuinely need a human.

## Decision (from the operator)

- **Soft forwards only.** An INTERNAL forward (no new external address for us to
  contact) → **wait silently, push the follow-up, no escalation**. A HARD
  handoff that redirects us to a NEW external address still escalates (a human
  decides whether to fire a fresh request there).
- **Wait window: at least 21 days.** `follow_up_at = max(today + 21d, stated
  return/semester date + grace)`. The 21-day floor is enforced by the system,
  not trusted to the LLM. After the window with no reply, the existing stale
  rules re-surface it in "Behöver dig".

## Design

### 1. New intent `handoff_internal` (distinct from `handoff`)
- **`src/analyse-message.js`**: add `handoff_internal` to the intent enum (enum
  value = ZERO new json_schema union params — safe). Prompt guidance: a reply
  that says the registrator has forwarded/passed our request to the right
  person/unit *internally* (markers: "skickar vidare", "vidarebefordrat",
  "skickat vidare till", "lämnat vidare till", often + a semester/delay note)
  and gives NO external address for us to contact → `handoff_internal`,
  `suggested_action: "wait"`, NO `draft_reply`. A PERMANENT redirect to a
  specific other address/registrator we must contact → `handoff` (unchanged,
  escalates). Add a Bjurholm-style few-shot for `handoff_internal`; keep the
  existing external-redirect few-shot as `handoff`.
- **`src/classifier.js`** (offline path): conservative detection of the
  "vidare"/"vidarebefordrat" forwarding phrasing with NO new email address →
  `handoff_internal`. Precision over recall — if a concrete other address is
  named, fall through to the existing handling (stays escalate).
- `analysisToLegacyClassification` maps `handoff_internal` → a new legacy class
  `handoff_internal` (NOT `unknown`).

### 2. Handling: wait, push follow-up ≥21d, never escalate (`src/conversation.js`)
- `nextActionForClassification` for `handoff_internal` mirrors `auto_reply`:
  `{ nextState: state, action: 'none' }` — no draft, no escalation, state
  unchanged (a machine/soft signal, not a state advance).
- **Follow-up (`src/tick.js` ingest):** for `handoff_internal`, set
  `follow_up_at = max(today + 21d, analysis.promised_response_date + grace)`.
  Enforce the 21-day floor in code regardless of what the LLM returned.
- **Silent** — no outbound (an ack would reintroduce an approval step, defeating
  the load reduction), exactly like `auto_reply`.

### 3. Retag the three already escalated (offline helper, operator runs supervised)
- Bjurholm #21, Avesta #12, Eda #43 are open `free_form` escalations that are
  really soft forwards. Extend the retag pattern (`src/retag-auto-reply.js` →
  a sibling `retagSoftHandoff`): supersede an open free_form escalation whose
  triggering message is a recognized `handoff_internal`, set the conversation's
  `follow_up_at = today + 21d`, and clear the `NEEDS_HUMAN` state back to the
  appropriate waiting state (see the stuck-state fix note below). Offline-tested;
  operator runs it backup-first.

## Constraints (non-negotiable)

- **Precision over recall** — a genuine external redirect must NEVER be
  downgraded to `handoff_internal` and silently deferred. When a concrete other
  address is named, keep `handoff` → escalate. Tests for both.
- **No schema change** — `handoff_internal` is a new intent-enum value + a new
  string class value in existing TEXT columns.
- **No data loss** — the message is stored; the retag supersedes (never deletes).
- **`handoff` behaviour unchanged** for external redirects.
- **Union limit** — only an enum value added (0 new union params); verify count.
- **Pure functions stay pure.**
- **Subagent offline only**; reset worktree onto current `main` tip
  ([[worktree-stale-base]]). Branch `soft-handoff-wait`.
- Full offline `npm test` green.

## Related: stuck NEEDS_HUMAN cases (fold the root cause in)

Audit 2026-07-20 found 3 conversations stuck `NEEDS_HUMAN` with 0 open
escalations (Bjuv #19, Helsingborg #22, Norrköping #24): their last escalation
was resolved (edit-send or supersede) but the state never moved off
`NEEDS_HUMAN` — the free_form restore in `send-reply.js` falls back to a
`previous_state` that was itself `NEEDS_HUMAN`/null, and the autosvar retag
doesn't clear the state. Fix: when a free_form/soft escalation resolves and
`previous_state` is not a valid non-terminal waiting state, restore to a sane
default (e.g. `SENT`/`ACK_RECEIVED` per prior progress) rather than leaving
`NEEDS_HUMAN`. Provide a supervised offline helper to un-stick the 3 existing
cases (set to the right waiting state + keep their follow_up_at).

## Testing (offline)

- `classifier.js` / `analyse-message`: Bjurholm-style internal forward →
  `handoff_internal` (wait, no draft); an external redirect naming an address →
  `handoff` (escalate); a delivery/clarification reply → its normal class.
- `runTick`: a `handoff_internal` inbound → message stored, NO escalation,
  `follow_up_at` ≥ today+21 (or return date+grace if later), state unchanged;
  an external `handoff` still escalates.
- Retag helper: supersedes the open free_form escalation, pushes follow_up_at,
  un-sticks the state; leaves a genuine external handoff escalation alone.
