# Contract validation — "is it really a contract (money exchanged)?"

**Date:** 2026-07-15
**Status:** approved, ready for implementation

## Problem

The kommun detail page shows "Mottagna avtal (13)" for Huddinge (#27), but
those 13 are one procurement's worth of documents: ~2 real purchase contracts
plus a personuppgiftsbiträdesavtal (PUB/DPA) and a stack of bilagor (SLA,
säkerhet, kravspecifikation, definitioner, IT-miljö, samverkan). Three
independent defects inflate the picture:

1. **The UI ignores classification.** `aggregateContracts` in
   `src/dashboard-views.js` lists *every attachment* and labels the count
   "Mottagna avtal". `is_contract` is never consulted here.
2. **The analyzer calls annexes "avtal".** `document_type`'s enum
   (`avtal | följebrev_sammanställning | prislista | sekretessbeslut | övrigt`)
   has no notion of *bilaga* or *PUB-avtal*, so "Bilaga SLA" and "Bilaga
   Samverkan" were classified `avtal` → `is_contract=1`.
3. **The merge rule locks in stale positives.** `mergePreserving` in
   `src/analyse-contract.js` "never flips a good 1 → 0", so "Bilaga 2 –
   Servicenivåer" and "Bilaga 3 – Säkerhet" now carry `document_type=övrigt`
   **and** `is_contract=1` — a contradiction the UI and coverage counts trust.

## Decision (from the operator)

- **What counts as a contract (`is_contract=1`): any agreement that implies
  money is exchanged for a product/service.** The commercial huvudavtal,
  ramavtal, or a priced beställning. NOT a PUB-avtal/DPA (no money changes
  hands), NOT bilagor/annexes, NOT a standalone price list or cover letter.
- **Bilagor are not needed** — stop requesting them and stop counting them.
  They may still be stored (never delete delivered material), just not counted
  or shown as contracts.

## Scope — six changes

### 1. Narrow the request email (`src/templates.js`)
`T_INITIAL` and `T_REQUEST_MISSING`: explicitly ask for *själva avtalet med
pris/kommersiella villkor* and state we do **not** need bilagor
(kravspecifikationer, SLA, säkerhets-/definitionsbilagor) or
personuppgiftsbiträdesavtal. Keep the existing watchlist probe in
`T_REQUEST_MISSING`. Update `tests/templates.test.js` fixtures first, then the
templates, so the tests keep expressing the live contract.

### 2. Refine the analyzer taxonomy (`src/analyse-contract.js`)
Extend `document_type`'s enum with `bilaga` and
`personuppgiftsbiträdesavtal`. Rewrite the `document_type` and `is_contract`
rules in `SYSTEM_PROMPT`:
- `avtal` — a commercial agreement where the kommun **pays** for a
  product/service (huvudavtal, ramavtal, priced beställning). The discriminator
  is *money exchanged for products/services*.
- `bilaga` — an annex/appendix to an agreement that is not itself a commercial
  agreement: SLA/servicenivåer, säkerhet, kravspecifikation, funktionella krav,
  definitioner, IT-miljö, samverkan/ändringshantering, prisbilaga that belongs
  to a huvudavtal. Even if it reads contractually, a standalone annex is a
  `bilaga`.
- `personuppgiftsbiträdesavtal` — a GDPR data-processing agreement (PUB-avtal /
  DPA). It is legally an "avtal" but **no money is exchanged**, so it is NOT a
  contract for our purposes.
- Existing `följebrev_sammanställning | prislista | sekretessbeslut | övrigt`
  unchanged.
- **`is_contract = true` ONLY when `document_type = 'avtal'`.** Everything else
  is `false`.

**Union-limit guard (hard constraint):** `document_type` is a plain
non-nullable `enum` string, so adding enum values adds **zero** union-typed
params. Do NOT add any new nullable/`anyOf` field to `CONTRACT_SCHEMA`; it must
stay ≤16 union params (currently 14). See the memory note
`anthropic-structured-output-union-limit`. This failure is live-only — offline
tests cannot catch it — so keep the schema shape unchanged apart from the enum.

### 3. Fix the merge rule (`src/analyse-contract.js` `mergePreserving`)
`is_contract` must stay consistent with the freshest `document_type`. When a
new pass returns a confident (`confidence >= 0.8`, tune if needed) non-`avtal`
`document_type`, allow `is_contract` to flip `1 → 0` and set the merged
`document_type` to the new value. Continue to merge extracted *data* (vendor,
prices, line_items, coverage, dates) **fill-only / non-destructive** — never
wipe a good extraction. Only the classification boolean follows the newer
confident verdict. Add a regression test for the exact Huddinge contradiction
(old `is_contract=1`, new pass `document_type='bilaga'|'övrigt'` → merged
`is_contract=0`).

### 4. Persist `document_type` (`src/storage.js`)
Add a `document_type` TEXT column to `contracts` via the append-only,
`PRAGMA table_info`-guarded migration pattern. `storeContractAnalysis` writes
`analysis.document_type`. Backfill-safe: existing rows get `NULL` until
re-analysed; treat `NULL` as "unknown/legacy". No other schema change.

### 5. UI honesty (`src/dashboard-views.js`)
- `aggregateContracts` (or the section that renders it) must carry each
  attachment's classification. Join attachments to their `contracts` row so a
  row knows its `is_contract` / `document_type`.
- Header: count only real avtal, e.g. **"Mottagna dokument (13) · 2 avtal"**.
- Each row badged by type: `Avtal` (prominent), `Bilaga`, `PUB-avtal`,
  `Följebrev`, `Övrigt` (muted). Bilagor/övrigt stay visible but
  de-emphasized — nothing is hidden or deleted.
- Vendor/product coverage already keys on `is_contract=1` + vendor, so it
  self-corrects once re-analysis runs; no change needed there.
- Keep the existing "sparad, ej avtalsanalyserad (ej PDF)" note for non-PDFs.

### 6. Re-analysis backfill — NOT in the subagent
`scripts/07-reanalyse-lifecycle.js` (or the existing reanalyse path) reruns the
analyzer over stored PDFs so existing rows get the new taxonomy. This is the
one live step: backup `data/pilot.db` first, run non-destructively, validate on
one PDF against the live API before the full run (union-limit is live-only).
The operator runs this supervised — the subagent must NOT touch the live DB,
daemon, Gmail, Slack, or run any live LLM call.

## Constraints (non-negotiable)

- **No data loss.** Additive, `PRAGMA`-guarded migration; fill-only backfill;
  bilagor kept, just reclassified. Subagent works offline only — temp/`:memory:`
  SQLite DBs, injected fakes, no live `data/pilot.db`.
- **Union limit ≤16.** Only the enum changes in `CONTRACT_SCHEMA`.
- **Update fixtures first**, then code, so tests keep expressing the live
  contract (project test convention).
- Full `npm test` must pass (offline). Report the before/after count.

## Out of scope (possible follow-ups)

- Grouping bilagor under their parent huvudavtal (parent linking by procurement
  id). The operator chose type-badges + honest count for now.
- Re-classifying `mentioned_agreements` semantics.
