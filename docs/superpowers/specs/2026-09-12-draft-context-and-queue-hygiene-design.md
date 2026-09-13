# Conversation-aware drafting, deadline awareness, queue hygiene

**Date:** 2026-09-12
**Status:** approved design, not yet implemented
**Trigger:** review of all 19 open escalations older than 10 days (2026-09-12).
9 of 19 drafts could not be sent as written. Root causes, with the live cases
that exposed them:

| # | Failure | Cases | Root cause |
|---|---------|-------|------------|
| 1 | Draft claims documents weren't received while they sit stored in our DB | Malmö #303 (11 avtal-PDFs), Hällefors #304 (7 avtal) | draft LLM never sees attachments |
| 2 | Draft re-argues a fee we already accepted / re-asks an answered question | Halmstad #269 (invoice details given 11 aug), Kungälv #312, Arjeplog #313 | draft LLM never sees our prior outbounds |
| 3 | "Resend" draft contains no request text | Höör #253, Luleå #310 | draft LLM never sees the original request |
| 4 | Vague "saknar en del av det som nämns" instead of naming the gap | Degerfors #308 | draft LLM never sees extracted-contract state |
| 5 | Kommun's reply deadline expired while the escalation aged | Linköping #261 (7-day auto-close passed 2026-09-02) | deadlines are not extracted or surfaced |
| 6 | Escalations sit >2 weeks with no nag; NEEDS_HUMAN convs with nothing open are invisible | whole >10d queue; Karlstad conv 100, Avesta conv 15 | no aging alarm; void path (tick.js "kommun replied after draft") leaves nothing actionable |

The fix is three independent work packages. STALE_ESCALATION and STALE_INGEST
already cover "the world moved on after the draft"; every failure above was
wrong **at birth**, so the cure is generation-time context (A) plus surfacing
(B, C). No new approve-time guard.

---

## A. Conversation-aware drafting

### What the model sees today

`userPromptFor` (analyse-message.js) sends ONLY: kommun name, role, FSM
state, days since last outbound, today's date, and the incoming body. No
thread, no attachments, no request text, no contract state.

### New context block

A new module `src/draft-context.js` exports
`buildDraftContext(db, conv, parsed)` returning a plain-text block that
`ingestMessage` (tick.js) passes into `analyseMessage` as `ctx.thread_context`
and `userPromptFor` appends after the incoming body. Content, in order:

1. **Ursprunglig begäran** — the conversation's FIRST outbound `body_text`,
   verbatim. This is what a resend must be able to copy.
2. **Tidigare korrespondens** — every prior message, chronological:
   - Outbound: date + **full body** (our own mails are short and carry the
     commitments the model keeps violating: fees accepted, invoice details
     given, questions already asked). Cap 1 500 chars per message as a
     safety valve.
   - Inbound: date + classification + the stored `analysis_json.summary`
     (fallback: first 300 chars of unquoted body — `stripQuotedText` from
     `src/classifier.js`, so our own T_RECEIPT question quoted back is never
     fed to the model as the kommun's words; wired in round-4 H7) + stored
     attachment filenames from the `attachments` table.
   - Cap the log at the most recent 20 messages; if truncated, say so in the
     block ("…N äldre meddelanden utelämnade") — never silently.
3. **Bilagor i det inkommande mejlet** — filenames + count from
   `parsed.attachments`. Available before the analysis call; the crash-safe
   IO ordering (analyse → fetch → one transaction) is untouched because this
   uses metadata only, no fetched bytes.
4. **Avtal vi redan extraherat** — per stored contract row for this
   conversation: vendor, `document_type`, `is_contract`. This is how the
   model distinguishes "we hold a sammanställning" from "we hold the avtal"
   (Degerfors) without hallucinating either way.

The trigger message's own body stays where it is today (primary input); the
context block is explicitly labelled as background.

### New system-prompt rules (buildSystemPrompt)

Appended to the SKRIVREGLER section:

3. **Påstå ALDRIG att handlingar saknas eller inte bifogats när
   bilagelistan visar mottagna filer.** Bekräfta mottagna handlingar med
   filnamn eller leverantörsnamn. "Jag saknar X" får bara skrivas när X
   varken finns i bilagelistan eller bland redan extraherade avtal.
4. **Upprepa ALDRIG en fråga som ett tidigare utgående mejl redan ställt**,
   om inte kommunen lämnat den obesvarad. Omförhandla ALDRIG en avgift som
   ett tidigare utgående mejl accepterat eller som kommunen redan besvarat
   med ett motiverat nej: ett lämnat åtagande (accepterad avgift, lämnade
   faktureringsuppgifter) står fast.
5. **Om kommunen uppger att begäran aldrig nått dem**: draft_reply MÅSTE
   innehålla den ursprungliga begäran i sin helhet (kopiera texten under
   "Ursprunglig begäran"), inte en sammanfattning eller en hänvisning.

One few-shot example is added for rule 5 (resend) since both live failures
(Höör, Luleå) hit it.

### Cost

Haiku, ~2–4k extra input tokens per inbound. Negligible against the Opus
contract-analysis spend.

### Tests (all offline, existing seams)

- `draft-context` unit tests on a temp DB: ordering, caps, summary fallback,
  attachment names, contract rows, truncation marker.
- `analyse-message` prompt-content tests via injected fake client capturing
  the request: context block present, labelled, after the body.
- Three regression tests named for the live failures, asserting prompt
  CONTENT (we cannot assert model output offline, so the tests pin what the
  model is shown):
  - *malmö*: trigger with 11 stored attachment names → prompt lists them
    and carries rule 3.
  - *halmstad*: prior outbound containing invoice details → that outbound
    appears verbatim in the prompt, and rule 4 is present.
  - *luleå*: prompt contains the full original request under "Ursprunglig
    begäran" and rule 5.

---

## B. Deadline awareness

### Extraction

New nullable field `extracted.respond_by_date` (ISO) in ANALYSIS_SCHEMA: a
deadline the KOMMUN imposes on US ("svara inom 7 dagar annars stängs
ärendet", "återkom senast 2026-09-02 med faktureringsuppgifter"). Distinct
from `promised_response_date` (their promise to us). Union-param count goes
9 → 10, safely under the json_schema 16 limit (see
anthropic-structured-output-union-limit). Prompt gets a definition + one
few-shot (Linköping-style komplettering with auto-close). Both the computation and
the guard are anchored to the date the trigger mail was RECEIVED (Gmail
`internalDate`), never to processing time: `ingestMessage` passes
`received_iso` in the ctx and `userPromptFor` prints it as
`Mejlet togs emot`. When the kommun states days rather than a date, the model
computes the ISO date from `Mejlet togs emot` plus those days, so a mail
ingested late in an outage backlog keeps the frist the kommun actually set.
`normaliseDelayAnalysis`'s helpers are reused for a `normaliseRespondBy`
guard: ISO validity, and not more than 30 days before the receipt date
(`RESPOND_BY_FLOOR_DAYS`). The guard's job is catching hallucinated or garbled
dates, which are typically far off (wrong month or wrong year) — NOT dates that
have merely passed. A frist the kommun states explicitly and that expired a few
days ago ("Fristen var den 10 september, svar saknas fortfarande") is real and
more urgent than a future one, so it is kept and sorts first as overdue; only a
date outside the 30-day window becomes null. The prompt says so too: instead of
"a date before the receipt date is an error, set null" it instructs
"Om kommunen uttryckligen nämner en frist som redan passerat, ange det datumet
ändå." (Round-3 addendum G5 revised this paragraph; the original rule nulled
anything more than one day pre-receipt and so erased exactly the overdue
deadlines the queue most needs to show.) (Delay promises keep their existing
`Dagens datum` anchor: pre-existing behaviour, ledgered as follow-up.)

### Storage

`escalations` gains `respond_by TEXT` via the append-only
`PRAGMA table_info` probe pattern. `escalateWithDraft` persists
`analysis.extracted.respond_by_date` when present. No other schema change.

### Surfacing

- `buildActionQueue` (dashboard.js): items carrying `respond_by` sort FIRST
  (soonest deadline first), before the existing oldest-`since` order; the
  action label gets "⏰ svar senast YYYY-MM-DD".
- Slack escalation blocks (slack.js): one added context line with the same
  ⏰ text when `respond_by` is set.
- Due/overdue alerting rides package C's daily digest (below) — no separate
  alert path, no new durable marker.

---

## C. Queue hygiene

One new digest in `runDailyFollowup`, same shape as the hänvisning nag
digest (c99daec): a single Slack message, posted only when non-empty,
listing three sections:

1. **⏰ Deadline inom 2 dagar eller passerad** — open escalations with
   `respond_by <= today+2`, sorted soonest first. Repeats daily until
   resolved; for a hard external deadline the repeat is the feature. Plus the
   draftless cases carrying a due frist, marked "utan utkast" because there is
   nothing to approve (round-2 finding F2). Those come from
   `listNeedsHumanWithoutOpenEscalation`, NOT from `listOrphanNeedsHuman`: a
   pending handoff task does not discharge a reply deadline, so the
   handoff exclusion belongs to list 3 only (round-3 G2). Deduped by
   conversation.
2. **🕰 Äldre än 7 dagar** — open escalations with `created_at` older than
   7 days: count + the oldest up to `DIGEST_MAX_LINES` (20, tick.js) as
   `kommun (N dagar)`, with an "…och N till" tail when the list is longer
   (round-4 H7: all three sections share one cap and one phrasing, see
   round-2 finding F6). Daily repetition is
   acceptable because the list only shrinks when the operator acts, and the
   whole point of this review was that silence let 19 items age past 10
   days.
3. **🧭 Behöver dig utan utkast** — conversations in NEEDS_HUMAN with no
   open escalation AND no pending handoff task for their kommun (the state
   the void path in tick.js legitimately produces, Karlstad/Avesta). These
   need a human decision the queue currently never re-raises.

The digest is Gmail-free and therefore allowed in `runDailyFollowup`
regardless of tick health; it reads only the DB. It never mutates state, so
no dedupe marker is needed — idempotent content, daily cadence.

Dashboard: the Behöver dig list already sorts oldest-first; each row
additionally shows age in days, red at ≥7.

---

## Explicitly out of scope

- No approve-time re-validation beyond the existing STALE_ESCALATION /
  STALE_INGEST guards.
- No change to auto-send rules; all three auto-send templates are
  unaffected (their gates don't touch the drafting prompt).
- No re-drafting of existing open escalations; the 2026-09-12 backlog is
  handled manually per the review notes.
- No FSM changes for the void path — the digest surfaces it; whether
  NEEDS_HUMAN should auto-transition is a later question.

## Rollout order

A, then B, then C. Each is independently shippable and testable offline;
C depends on B only for its section 1 (ship C's sections 2–3 first if B
lags). Deploy via `./deploy/deploy.sh` after merge; one restart.
