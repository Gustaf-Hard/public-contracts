# Plan — vendor data center (2026-07-09)

Spec: `docs/superpowers/specs/2026-07-09-vendor-data-center-design.md`.
Branch `vendor-data-center`, on top of `perpetual-contract-refresh`.
TDD per task; suite stays green (baseline 434). Conventional commits.

1. **feat(storage): pricing columns + guarded migration + facts query**
   - `contracts` gains `annual_value_sek`, `one_time_value_sek`,
     `pricing_model`, `unit_price_sek`, `unit`, `quantity`,
     `value_incl_moms` (SCHEMA + PRAGMA-guarded ALTERs, same pattern as the
     lifecycle columns).
   - `recordContract` persists them; `listContractFacts()` joins
     contracts→attachments→messages→conversations (+vendor, products) for
     the analytics layer.
   - Tests: columns persist, migration idempotent on an old-shape DB
     (create table without the columns → migrate twice), facts query shape.

2. **feat(contracts): analyser extracts pricing**
   - Extend `SYSTEM_PROMPT` + `CONTRACT_SCHEMA` in `src/analyse-contract.js`
     with the seven fields; `storeContractAnalysis` passes them through.
   - Update `scripts/07-reanalyse-lifecycle.js` header (backfill now also
     populates pricing).
   - Tests: schema sent to the client includes the fields; a fake analysis
     with pricing lands in the DB; nulls stay null.

3. **feat(analytics): src/vendor-analytics.js**
   - `normalizeAnnualValue`, `buildContractFacts`, `buildVendorRollups`,
     `buildMarketSummary`, `completeness` — pure, data-only.
   - Tests: one case per messy avtalsvarde shape (monthly, tkr, per-elev
     tiered, escalating schedule, totalt-with-annual, free, bare-amount →
     null, per-day → null), rollup math, median, dominant model,
     next-renewal, completeness counts.

4. **feat(explorer): pure client logic**
   - `public/explorer-core.js`: `applyFilters`, `groupFacts`,
     `aggregateFacts`, `valueBand`, `lengthBand`, `renewalWindow`,
     `deriveOptions`. Browser-safe ESM, no deps.
   - Tests: `tests/explorer-core.test.js` table-tests over a facts fixture.

5. **feat(dashboard): the three surfaces**
   - `renderVendorMarket` (KPI band + sortable rollup table + explorer
     shell with embedded facts JSON), `renderVendorDossier` (full-width
     dossier), replacing the old master–detail `renderVendors`.
   - Routes: `/leverantorer` (with `?sort/&order`), `/leverantor/:slug`.
   - `public/explorer.js` DOM glue + `app.js` pane-swap init hook + CSS.
   - Tests: `tests/vendor-datacenter-views.test.js` (views + routes).

6. **docs(runbook): live activation**
   - Extend `docs/superpowers/runbooks/2026-07-09-refresh-activation.md`:
     pricing columns in the migration verification, pricing spot-checks
     after the backfill, note that the same backfill feeds /leverantorer.

Verification gate before each commit: `npx vitest run` green.
