# Perpetual Contract Refresh — design (2026-07-09)

Closes the "collection is terminal" gap named in
`2026-07-05-autopilot-readiness-review.md` §7. A collected contract is never
"final": each has a real lifecycle, and when it reaches the point where it
could actually change, the daemon automatically re-contacts the kommun with a
**human-approved** update request and folds the response back into the dataset
— perpetually. The human stays the approver (the bot is wrong-until-proven-
right); this reuses the existing escalation/approval flow, never auto-send.

This supersedes the pure groundwork in `src/renewal.js` (`nextRenewalDrafts`):
that module answered "which contracts expire within a horizon, batched per
kommun". It was never wired (no schema, no reopen model). The new model is
finer-grained — a per-contract `next_review_date` resolved from lifecycle
structure, not a bare `period_end` horizon — and it *is* wired to the DB, the
tick, and the dashboard. `renewal.js` is left in place (still tested) but is no
longer the basis for the loop.

---

## 1. Core model — `next_review_date` per contract

Today `analyse-contract.js` collapses auto-renewal into `period_end` ("Vid
automatisk förlängning: använd innevarande periods slutdatum") and stores NO
lifecycle structure. Real examples in the live data:

- **Tieto** — "förlängs automatiskt i ettårsperioder om det inte sägs upp"
- **Skola24** — "möjlighet till två års förlängning"
- **Teachiq** — "möjlighet till förlängning upp till 2027-06-14"

So `period_end` is not the true end. Each contract resolves to one date:

| Archetype | Signal | next_review_date |
|---|---|---|
| Plain fixed-term | `period_end`, no renewal language | on `period_end` |
| Auto-renewing | "förlängs automatiskt … om det inte sägs upp" | **just after `last_cancellation_date`** (uppsägningsdag) — renew-vs-switch is decided by then |
| Fixed + extension option | "möjlighet till förlängning upp till X" | on `extension_option_until` (X) |

A kommun's re-contact date = the **soonest next_review_date across its live
contracts**, deduped to **one record per (kommun, vendor), newest-wins** (so an
Atea extension supersedes the old Unikum/Skola24 rows instead of triple-
triggering). Contracts with no usable date, or ancient/superseded, are not
armed.

### Resolution rules (`computeNextReviewDate(contract, now)`, pure)

Precedence, first match wins:

1. **Auto-renewing** (`auto_renews === true`): if `last_cancellation_date`
   is a valid ISO date, review = the day *after* it (`last_cancellation_date +
   1 day`) — the decision must be made by the cancellation day, so we re-contact
   just after. If no `last_cancellation_date`, fall back to `period_end`.
2. **Extension option** (`extension_option_until` is a valid ISO date): review
   = `extension_option_until`.
3. **Plain fixed-term**: review = `period_end`.
4. No usable date at all → `null` (not armed).

`now` is required (no wall-clock ambush; matches `nextRenewalDrafts`). Ancient
review dates are NOT filtered here — the *scan* decides due-ness; this function
only resolves the date. Superseded/dedup logic lives in the scan too (it needs
the full contract set, not one row).

Invalid/garbage date strings are treated as absent (fall through the
precedence). This is the error-handling contract: null/unparseable lifecycle
fields degrade to `period_end`; no usable date → not armed, never a crash.

---

## 2. Part A — lifecycle extraction (data foundation)

### 2.1 Analyser prompt + schema

Extend the contract-analysis prompt and `CONTRACT_SCHEMA` in
`src/analyse-contract.js` with four new fields (all nullable, `period_end`
keeps its current meaning = current-period end):

- `auto_renews` — boolean. True when the contract renews automatically unless
  cancelled ("förlängs automatiskt … om det inte sägs upp").
- `renewal_term` — string | null. The renewal period, e.g. "1 år". Null if not
  auto-renewing or not stated.
- `last_cancellation_date` — ISO `YYYY-MM-DD` | null. The last day the contract
  can be cancelled (uppsägningsdag) before it auto-renews.
- `extension_option_until` — ISO | null. The date named in a "möjlighet till
  förlängning upp till X" option.

### 2.2 Schema + storage

New `contracts` columns: `auto_renews INTEGER`, `renewal_term TEXT`,
`last_cancellation_date TEXT`, `extension_option_until TEXT`. Persisted by
`recordContract` and populated by `storeContractAnalysis`.

### 2.3 Backfill

`scripts/07-reanalyse-lifecycle.js` re-runs the analyser over already-stored
contract PDFs (the existing `--force` path of `analysePendingContracts`, which
re-analyses every PDF attachment and `recordContract`-replaces the row) to
populate the new fields. Its pure argument-parsing is unit-tested; **it is NOT
run live here** (see §6).

---

## 3. Part B — the refresh loop (action)

### 3.1 Reopen model (approach A)

Do NOT change `UNIQUE(kommun_kod, role)`. When a case reaches `DONE`, it can
later be reopened for a refresh round: the state cycles
`DONE → REFRESH_DUE → SENT` on a **new Gmail thread**, tracked by a new
`conversations.refresh_round` counter (0 = original round). Rounds separate
naturally via the existing `threads` table (each round is a new thread). A new
conversation state `REFRESH_DUE` is added (a non-terminal string value, like
`SENDING` — no migration needed for the state itself).

### 3.2 Arming

On a conversation reaching `DONE`, compute the kommun's soonest
`next_review_date` across its live contracts (deduped per (kommun, vendor),
newest-wins) and store:

- `conversations.next_review_at` — the soonest review date (ISO), or null.
- `conversations.next_review_source` — which vendor drove it, e.g. "Skola24".

This is **distinct from `follow_up_at`**: the M10 safety fix clears
`follow_up_at` on terminal states and `effectiveFollowUp` is terminal-first, so
`follow_up_at` is unusable for refresh arming. `next_review_at` is a new field
that deliberately survives DONE.

Arming happens only for kommuner in the pilot allowlist (§3.4).

### 3.3 Trigger — daily refresh scan

`runRefreshScan(deps)` — a sibling of `runDailyFollowup` in `src/tick.js`,
reusing ALL its safety machinery:

- runs under the same tick/followup escalation mutex (wired in the daemon);
- `hasActiveEscalation` one-open-action guard;
- `escalateWithDraft` supersede-or-defer invariant;
- staleness / atomic claim inherited from the shared escalation path.

Logic: find `DONE` conversations where `next_review_at <= today`, the kommun is
in the refresh allowlist, and there is no active escalation → move the
conversation to `REFRESH_DUE` and create exactly ONE `T_UPDATE` escalation
(superseding per invariant). Not-due, not-allowlisted, or already-active
conversations are skipped.

### 3.4 Gating (pilot scope)

Arm and trigger only for kommuner in `refresh_pilot_kommun_kods`, initially
`["1489","1980"]` (Alingsås, Västerås), read from `data/pilot-overrides.json`
via a new `isRefreshAllowed(overrides, kommunKod)` helper in
`src/pilot-config.js`. The mechanism is general; only the allowlist limits it.
Expanding later is a config edit.

### 3.5 The update request — `T_UPDATE`

New template in `src/templates.js`, human-approved via the normal escalation
flow. Content:

- **references the prior relationship / ärende** ("Jag återkommer angående min
  tidigare begäran…", ärendenummer if known);
- **renewal question NAMES the specific contract(s) at review**: e.g. "Ert
  avtal med Skola24 hade avtalstid t.o.m. 2026-06-30 — har det förnyats, och
  kan jag i så fall ta del av det gällande avtalet?";
- **net-new question stays OPEN-ENDED** — do NOT enumerate everything we hold:
  "Har ni därutöver tecknat några nya avtal avseende digitala verktyg,
  lärplattformar eller läromedel sedan dess?".

This naming rule is deliberate (owner guidance): name the expiring contract,
keep net-new open — don't parrot our full extraction back at the kommun.

`T_UPDATE(ctx)` takes `review_contracts: [{ vendor_name, period_end }]` and
renders one named sentence per contract (Swedish-joined), plus the fixed
open-ended net-new question.

### 3.6 Re-arm (perpetual)

When a refresh round completes (the conversation reaches `DONE` again after a
`REFRESH_DUE`/`SENT` cycle), recompute `next_review_at` from the updated
contract set. Same arming code path — so the loop is perpetual.

### 3.7 Dashboard

On "Klart"/DONE cases show "Återkommer <next_review_at> — pga <vendor>"
(`src/dashboard-views.js`), sourced from the new `next_review_at` /
`next_review_source` columns (NOT from `effectiveFollowUp`, which is null on
DONE by design).

---

## 4. Schema changes (migration surface)

Idempotent guarded migration in `src/storage.js` `migrate()` (probe
`PRAGMA table_info` before each `ALTER TABLE ADD COLUMN`). Fresh test DBs get
the columns via the base `SCHEMA` string too, so both fresh and existing DBs
converge.

- `contracts.auto_renews` INTEGER
- `contracts.renewal_term` TEXT
- `contracts.last_cancellation_date` TEXT
- `contracts.extension_option_until` TEXT
- `conversations.next_review_at` TEXT
- `conversations.next_review_source` TEXT
- `conversations.refresh_round` INTEGER NOT NULL DEFAULT 0

New conversation state string value: `REFRESH_DUE` (non-terminal; no migration,
extends the existing TEXT column per the "new string values, not new columns"
convention).

`recordContract` and `updateConversationState` gain the new fields in their
allow-lists.

---

## 5. Error handling

- Null / again-unparseable lifecycle fields → `computeNextReviewDate` falls
  back to `period_end`.
- No usable date at all → conversation is not armed (`next_review_at` stays
  null); the refresh scan never selects it. Never blocks the pipeline.
- Refresh escalations obey the same guards as every other outbound: atomic
  claim, one-open-action, supersede-or-defer, staleness.

---

## 6. HARD constraint — no live mutation here

The migration is NOT run against live `data/pilot.db`; the backfill is NOT run
against real stored PDFs; the daemon/dashboard are NOT started; no live
Gmail/Slack/Anthropic calls. Everything is verified offline with temp /
`:memory:` DBs and hand-built fixtures.

A runbook — `docs/superpowers/runbooks/2026-07-09-refresh-activation.md` —
documents the exact live-activation steps (backup → migrate → backfill re-
analysis → verify `next_review_at` armed for 1489/1980 → confirm on dashboard)
for the owner to execute under supervision after review.

---

## 7. Testing (all offline)

- `computeNextReviewDate` per archetype incl. the real Tieto / Skola24 /
  Teachiq strings, plus null/edge/invalid-date cases.
- Refresh scan: armed & due → one escalation; not due → none; auto-renew
  cancellation-date math; gating allowlist respected; supersede invariant.
- Dedup newest-wins per (kommun, vendor).
- `T_UPDATE`: names expiring contract(s), net-new open-ended, references prior
  ärende.
- Migration idempotency (run `migrate()` twice; columns present once).
- Keep the existing suite green (baseline 386).

## 8. Out of scope (YAGNI)

- Per-kommun coverage % metric.
- `supersedes_contract_id` FK — dedup-by-newest covers v1.
