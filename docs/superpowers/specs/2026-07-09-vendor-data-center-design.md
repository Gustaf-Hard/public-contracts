# Vendor data center — design (2026-07-09)

Turn `/leverantorer` from a thin master–detail list into the product's
flagship **contract data center**: the surface that delivers market
intelligence (who sells what, to which kommuner, for how much, renewing when)
to eventual customers. Builds ON TOP of the perpetual-contract-refresh branch
(`2026-07-09-perpetual-contract-refresh-design.md`) — same schema-extension
pattern, same lifecycle fields, reuses `computeNextReviewDate`.

## The data problem

`contracts.avtalsvarde` is raw free text from the Opus extraction and is
wildly inconsistent (all real rows from the live DB):

| shape | example |
|---|---|
| monthly | `80 417 SEK per månad` |
| tkr shorthand | `129 tkr/år` |
| annual w/ noise | `612 500,00 kr/år (sitelicens)` |
| per-student tiered | `2025: 40 kr/elev (3744 elever); från 2026: 95 kr/elev grundskola (3744 elever) och 50 kr/elev gymnasium (120 elever), ex. moms` |
| escalating schedule | `585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3` |
| total-with-annual-inside | `94 435 000 kr totalt (förvaltningsavgift 4 955 221 kr/år, införandeprojekt 2 806 685 kr fast)` |
| free | `Ingen årlig abonnemangskostnad för Unikum Arkiv Start` |
| bare amount, no period | `121 272 SEK` (annual? total for 3 years? unknowable) |

No aggregate (total annual spend, price-per-student ranges, pricing-model
mix) can be computed from that text directly. Two layers fix it:

1. **Extraction** — the analyser itself outputs structured pricing fields
   (it reads the whole PDF; it is the best-placed normalizer).
2. **Normalization** — a pure, unit-tested `normalizeAnnualValue(contract)`
   that derives/validates SEK-per-year from the structured components AND
   falls back to parsing the known `avtalsvarde` text shapes, so rows
   analysed *before* the backfill still get honest numbers where the text is
   unambiguous.

**Honesty invariant: never fabricate.** A bare `121 272 SEK` with no period
marker is *unknown*, not annual. Unknown → `null` → rendered "okänt" and
counted in the completeness line ("årlig kostnad känd för X av Y avtal").
An explicit "Ingen årlig abonnemangskostnad" / `pricing_model: "free"` is a
true 0 — that is knowledge, not fabrication.

## Part 1 — pricing extraction (schema + analyser)

New fields in the SAME `CONTRACT_SCHEMA` + prompt in
`src/analyse-contract.js`, and the SAME `contracts` table via the existing
PRAGMA-guarded ALTER migration in `src/storage.js`:

| column | type | meaning |
|---|---|---|
| `annual_value_sek` | REAL, null | contract value normalized to SEK/year (current tier / current year). null when it does not follow from the document |
| `one_time_value_sek` | REAL, null | one-off costs (uppstart, införande) in SEK |
| `pricing_model` | TEXT | `per_student` \| `per_user` \| `fixed` \| `tiered` \| `usage` \| `one_time` \| `free` \| `unknown` |
| `unit_price_sek` | REAL, null | price per unit (e.g. 40 for "40 kr/elev") |
| `unit` | TEXT, null | the unit, e.g. `elev`, `användare` |
| `quantity` | REAL, null | number of units named in the contract (e.g. 3744) |
| `value_incl_moms` | INTEGER(bool), null | whether stated values include VAT; null if not stated |

Prompt rules (Swedish, appended to the existing system prompt):
- Normalize monthly to yearly (×12); pick the CURRENT tier/year of an
  escalating schedule (relative to period_start); never guess — null when
  the document doesn't say.
- `pricing_model` from the price construction, not the product type.
- `one_time_value_sek` only for genuinely one-off costs.

`storeContractAnalysis` + `recordContract` persist the new fields.
`scripts/07-reanalyse-lifecycle.js` (force re-analysis of every PDF with the
current prompt/schema) therefore backfills pricing at the same time as
lifecycle — no new script, doc text updated. NOT run in this branch (hard
constraint); activation steps live in the refresh runbook.

## Part 2 — pure analytics layer (`src/vendor-analytics.js`)

Pure functions returning DATA (no HTML) so the same layer can later back a
customer export/API.

- `normalizeAnnualValue(contract, { now })` → number | null.
  Precedence:
  1. `annual_value_sek` from the analyser (finite, ≥ 0).
  2. `pricing_model === 'free'` → 0.
  3. `unit_price_sek × quantity` for per-unit models when both present.
  4. Conservative text parse of `avtalsvarde` (whitelisted shapes only):
     `/år`, `per år`, `/månad`→×12, `tkr`→×1000, "år 1/år 2/…" schedule
     (current year via period_start vs now, clamped), "N kr/elev (M elever)"
     first-listed (current) tier, annual figure named inside a "totalt"
     paren, explicit "Ingen årlig …kostnad" → 0.
     Everything else — bare amounts, per-day rates, per-user without a
     count — returns null. Never 0 for unknown.
- `buildContractFacts(rows, { lanByKommunKod, now })` → flat dataset, one
  row per stored contract (`is_contract=1`):
  `{ contract_id, vendor_id, vendor_name, vendor_slug, kommun_kod,
     kommun_namn, lan, annual_value_sek, pricing_model, value_incl_moms,
     contract_length_months, period_start, period_end, next_review_date,
     auto_renews, products, avtalsvarde, attachment_id, filename }`.
  `next_review_date` = `computeNextReviewDate(contract, now)` (reused from
  the refresh branch). `contract_length_months` from period_start/end
  (rounded to whole months), null if either missing.
- `buildVendorRollups(facts)` → per-vendor:
  `{ vendor_id, vendor_name, vendor_slug, kommun_count, contract_count,
     total_annual_sek, value_known_count, dominant_pricing_model,
     pricing_model_mix, products, avg_length_months, median_length_months,
     length_known_count, price_per_student_min/max, next_renewal_date }`.
  `total_annual_sek` sums only known values (null when none known);
  `next_renewal_date` = earliest future `next_review_date`.
- `buildMarketSummary(facts, rollups)` → the overview KPI band:
  vendor count, kommun coverage, total known annual SEK + completeness
  `{ value_known, total }`, upcoming renewals (≤ 365 d) count.
- `completeness(facts, key)` → `{ known, total }` — drives every
  "känd för X av Y avtal" line.

All table-tested against fixtures shaped from the real live rows above.

## Part 3 — the page (Design A: server shells + client slice & dice)

Three surfaces, same visual language as the rest of the dashboard
(`layout()`, sidebar, dark-mode variables, pane-swap via `data-pane-link`):

1. **Market overview — `/leverantorer`**
   KPI band (leverantörer, kommuner med avtal, total known ARR with
   completeness, förnyelser < 12 mån) → sortable rollup table (vendor, #
   kommuner, total SEK/år with per-vendor completeness, dominant pricing
   model, next renewal) using the existing `sortHeader` pattern → the
   **explorer** section below it.
2. **Vendor dossier — `/leverantor/:slug`**
   Full-width deep dive: KPI band (ARR across kommuner + completeness, #
   kommuner, contract-length range, price/elev range), renewal calendar
   (upcoming `next_review_date`s), per-kommun contract table (annual value
   or "okänt", pricing model, period, lifecycle badge, source-PDF links via
   `/attachments/:id`), product chips.
3. **Slice & dice explorer** (on `/leverantorer`)
   The server embeds the contract-facts dataset as
   `<script type="application/json" data-contract-facts>` (~70 rows —
   trivially small). A vanilla-JS layer filters/sorts/groups/aggregates
   live in the browser: filter by län, leverantör, pricing model, value
   band, contract length, renewal window, product; group-by any of those
   dimensions; per-group aggregates (count, known-value count, total
   SEK/år). No reloads, no dependencies, no framework.

Client-code split (testability):
- `public/explorer-core.js` — pure ESM module (filter predicates, group-by,
  aggregation, band bucketing, option derivation). Unit-tested directly by
  vitest.
- `public/explorer.js` — thin DOM glue (`initExplorer()`), ESM, dynamically
  imported. Untested by agreement (no non-trivial logic).
- `public/app.js` — one small hook: after a pane swap (and on initial
  load), if the pane contains `[data-explorer]`, dynamically `import()`
  explorer.js and init. Needed because scripts inside `innerHTML` never
  execute — the existing pane-swap would otherwise leave the explorer dead.

## Part 4 — honesty & polish

- Completeness lines wherever an aggregate could over-read: market KPI
  band, per-vendor rollup rows, dossier KPIs, explorer group aggregates
  ("summa av N avtal med känt värde, M okända").
- Unknowns render as "okänt" (muted), never 0, never omitted from counts.
- Values display in Swedish number format (`sv-SE`), " kr/år" suffix,
  compact `mkr`/`tkr` for large aggregates.

## Non-goals / constraints

- No live migration, no live backfill, no daemon/dashboard start, no live
  LLM calls. Everything verified with temp-dir SQLite + injected fake
  clients + fixtures shaped from read-only inspection of the live DB.
- The kommun-page contracts view is untouched.
- No CSV/API export yet — but `buildContractFacts` is the dataset an export
  would serialize.

## Test surface

- `tests/vendor-analytics.test.js` — normalizeAnnualValue per messy shape,
  facts assembly, rollups, market summary, completeness.
- `tests/explorer-core.test.js` — filter/group/aggregate/band logic.
- `tests/contracts-storage.test.js` (extended) — new columns persist +
  migration idempotency on a pre-existing DB.
- `tests/analyse-contract.test.js` (extended) — schema fields requested +
  stored.
- `tests/vendor-datacenter-views.test.js` — the three surfaces render the
  data, embed parseable facts JSON, show "okänt" and completeness lines;
  routes serve them.
