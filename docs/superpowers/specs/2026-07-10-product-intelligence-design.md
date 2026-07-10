# Product Intelligence on the Vendor Dossier — Design

**Date:** 2026-07-10
**Status:** Approved (brainstorm), ready for implementation
**Scope:** `src/analyse-contract.js`, `src/storage.js`, `src/vendor-analytics.js`, the vendor dossier view in `src/dashboard-views.js`, one backfill script. Additive schema only — no destructive change. Builds on `main` (`ea42ccc`: safety hardening + perpetual refresh + vendor data center).

## Goal

Turn the vendor dossier (`/leverantor/:slug`) into a genuine market-intelligence surface by extracting, per product, two things the contracts already state but we currently discard:

1. **Real per-product price** — from the contract's own itemized breakdown (line items), not a fabricated split of the contract total.
2. **Grade-level coverage** — which school levels each product reaches in each kommun, and how fully (green / yellow / red).

Both are AI-extracted from the same contract text, so one re-analysis backfill populates both.

## Motivating example (ILT Education, Ale contract)

The Ale contract states a total of `585 649 SEK` but itemizes it:
- Inlästa läromedel (65,40 kr/elev, 7 mån) 161 909 + (55 kr, 5 mån) 88 855 = **250 764**
- Begreppa 116 244 + (3,5 mån tidigare pris) 50 341 = **166 585**
- Polyglutt (100 kr/barn × 1683) = **168 300**

…and per-product coverage: Inlästa läromedel & Begreppa cover "Alla kommunala grundskolor (3 810), gymnasieskolor (120), vuxenutbildningar (270), anpassad skola (44)"; Polyglutt covers "Alla kommunala förskolor (1 683)". Today we store only the `585 649` total and a flat product-name list — the breakdown and coverage are thrown away.

## Feature 1 — Line-item per-product pricing

### Extraction (`src/analyse-contract.js`)
Add a `line_items[]` array to `CONTRACT_SCHEMA` and prompt guidance to extract the contract's own itemization (the "Totalt pris … beräknas enligt nedan" breakdown). Capture the **contracted** amounts, not "ordinarie pris" reference figures. Each line item:

```
{ product: string,            // product name as written
  description: string|null,   // e.g. "65,40 kr/elev, 7 månader"
  unit_price_sek: number|null,
  unit: string|null,          // "elev" | "barn" | …
  quantity: number|null,
  period_months: number|null,
  amount_sek: number|null }   // this line's contribution to the contract value
```

A product may have several line items in one contract (rate-period splits). When a contract gives only a lump sum with no itemization, `line_items` is empty and the product shows "ingår, ospecificerat pris."

### Storage (`src/storage.js`)
New additive table (guarded migration, same PRAGMA-checked ALTER/CREATE-IF-NOT-EXISTS pattern as the lifecycle/pricing columns):

```sql
CREATE TABLE IF NOT EXISTS contract_line_items (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  product_id INTEGER REFERENCES products(id),   -- nullable; matched by name when possible
  product_name TEXT NOT NULL,
  description TEXT,
  unit_price_sek REAL,
  unit TEXT,
  quantity REAL,
  period_months REAL,
  amount_sek REAL
);
CREATE INDEX IF NOT EXISTS idx_line_items_contract ON contract_line_items(contract_id);
```

`storeContractAnalysis` writes line items for a contract; on re-analysis it replaces that contract's line items (idempotent) — consistent with, and inside, the existing non-destructive merge (a re-run that returns *no* line items must not wipe previously-extracted ones — treat empty as "no signal," fill-only).

Per-product price in a contract = Σ `amount_sek` of its line items.

## Feature 2 — Grade-level coverage matrix

### Grade schema (canonical, fixed — 9 levels)
`Förskola · Förskoleklass · 1-3 · 4-6 · 7-9 · Gymnasiet · Komvux · Introduktionsprogrammet · Högskola`

Mapping from contract unit descriptions → bands (a pure, tested function):
- förskola → Förskola
- förskoleklass → Förskoleklass
- grundskola → 1-3, 4-6, 7-9 (a "F-3" style range maps to Förskoleklass + 1-3)
- gymnasieskola / gymnasiet → Gymnasiet
- introduktionsprogram → Introduktionsprogrammet
- vuxenutbildning / Komvux / SFI → Komvux
- **anpassad skola / särskola → folded into the matching age bands** (its students count toward 1-3/4-6/7-9/Gymnasiet, per the chosen design)
- högskola → Högskola (municipalities rarely operate this; usually absent)

### Extraction (`src/analyse-contract.js`)
Add a `coverage[]` array to `CONTRACT_SCHEMA` + prompt guidance to read the per-product "för följande enheter" sections:

```
{ product: string,
  unit_text: string,           // raw description, e.g. "Alla kommunala grundskolor"
  grade_levels: string[],      // mapped canonical bands (enum of the 9)
  status: "full" | "partial",  // full = "alla …"/whole-municipality; partial = named subset/subset count
  student_count: number|null }
```

Plus a contract- or product-level `whole_municipality: boolean` the model sets when a product is sold kommun-wide → expands to `full` on all applicable levels.

### Storage (`src/storage.js`)
```sql
CREATE TABLE IF NOT EXISTS contract_coverage (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  grade_level TEXT NOT NULL,      -- one of the 9 canonical levels
  status TEXT NOT NULL,           -- 'full' | 'partial'
  student_count REAL
);
CREATE INDEX IF NOT EXISTS idx_coverage_contract ON contract_coverage(contract_id);
```
One row per (contract, product, grade_level). Absence of a row for a level = "none" (not sold there). Non-destructive on re-analysis (empty = no signal, don't wipe).

### Coverage status → colour (per product, aggregated across the vendor's kommuner)
For each (product, grade_level), aggregate over the kommuner that bought the product:
- 🟢 **green (full)** — full in **all** selling kommuner (or whole-municipality)
- 🟡 **yellow (partial)** — partial somewhere, or mixed full/partial across kommuner
- 🔴 **red (none)** — no selling kommun covers that level
- **"–" neutral** — level genuinely not applicable (no contract in the dataset for this vendor ever references it, e.g. Högskola) so 🔴 always means "sold elsewhere, not here."

## Analytics layer (`src/vendor-analytics.js`, pure + tested)
- `mapUnitToGradeLevels(unitText)` — pure Swedish-unit → canonical-band mapper (incl. anpassad-skola folding, F-3 ranges, whole-municipality).
- Extend `buildProductRollups(facts, lineItems, coverage)` → per product:
  `{ name, kommunCount, kommuns[], priceByKommun[], priceRange, coverageByGrade: { <grade>: 'green'|'yellow'|'red'|'na' } }`.
- `avgAnnualPerKommun` on the vendor rollup = total known annual ÷ distinct kommuner (with completeness note).

## Dossier UI (`src/dashboard-views.js`, server-rendered)
1. **Product table** — Produkt · Kommuner · **Pris** (per-product, summed line items; per-kommun value or range) · Prismodell. Bundled-lump-sum-only products show "ingår, ospecificerat pris."
2. **Coverage matrix** — rows = products, 9 grade columns, cells green/yellow/red/–, aggregated across kommuner. A cell links/expands to per-kommun detail (which kommun is full vs partial).
3. **"Snitt per kommun"** KPI in the band (total known annual ÷ distinct kommuner) with a completeness subtext consistent with the existing honesty pattern.

## Testing (all offline)
- `mapUnitToGradeLevels`: table tests for every unit phrase (grundskola, F-3 range, förskola, gymnasieskola, vuxenutbildning/SFI, anpassad skola folding, whole-municipality).
- `buildProductRollups`: an ILT-shaped fixture carrying the real Ale line-item breakdown + per-product enhets-lists — asserts Begreppa price 166 585, Polyglutt 168 300, and coverage aggregation (green only when full in all selling kommuner; yellow on mixed; red when absent).
- Line-item summing per product; empty line_items → "ospecificerat".
- Migration idempotency (migrate twice → each table/column once).
- View tests: product table renders per-product price; coverage matrix renders the right colour classes; unknown/na cells honest.
- Keep the full suite green (baseline 543).

## Backfill & activation (non-destructive, supervised)
One re-analysis pass (extend the existing `scripts/07-reanalyse-lifecycle.js` or a new `08-` script) re-runs the analyser so line items + coverage populate for stored contracts. Same guarantees as the prior backfill: **fill-only / non-destructive** (an empty extraction never wipes existing line items/coverage), backup `pilot.db` first, run with the daemon stopped, verify counts don't regress, restart. Documented in an activation runbook; **not executed by the implementer.**

## Out of scope (YAGNI)
- Per-product *revenue totals* beyond price (bundling/attribution ambiguity — same reason we don't split lump sums).
- "Ordinarie pris" vs kampanjpris tracking (capture only the contracted amount).
- Cross-vendor coverage/market-share rollups (this is the per-vendor dossier).
- A `products`-table price column (line items are the source of truth).
