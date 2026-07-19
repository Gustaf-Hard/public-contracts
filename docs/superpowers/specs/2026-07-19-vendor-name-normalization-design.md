# Vendor-name normalization — one canonical name per vendor (read-time)

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

Vendor names arrive from two sources and duplicate heavily:
- the `vendors` table (from contract analysis) — near-dupes like
  `NE` / `NE Nationalencyklopedin` / `Nationalencyklopedin`,
  `Insight` / `Insight Technology Solutions`, `Oribi` / `Oribi Texthelp`,
  `Tempus` / `Tempus Information Systems`, `Aleido Learning` / `Aleido Learning Sweden`;
- `mentioned_vendors` free-text — `Microsoft` vs `Microsoft 365`,
  `Skola24` vs `Skola 24`, `Teachiq` vs `TeachIQ`, `SchoolSoft` vs `Schoolsoft` vs
  `SchoolSoft AB`, `Nova Software` vs `Nova Software AB`, `Everway` vs `Ewerway`.

They render as separate rows/chips and inflate the market list, so the kommun
panel, `/leverantorer`, and the coverage matrices all show the same vendor
several times.

## Decisions (from the operator)

- **Curated map + light suffix rules.** A hand-curated cluster map for the
  semantic cases that cannot be derived, PLUS safe mechanical rules (strip a
  trailing legal suffix / genitive-s) applied **only when the stripped form
  matches a known canonical**. Conservative — an unknown name passes through
  unchanged; no name is ever merged into a canonical it doesn't clearly belong
  to.
- **Read-time only, no DB change.** A pure `canonicalVendorName(name)` applied
  at display/aggregation. No `vendors` rows merged, no `vendor_id` remapped,
  fully reversible, zero data loss. (Duplicate vendor PAGES may still exist;
  unifying them is a possible follow-up.)

## Design

### 1. `src/vendor-aliases.js` — pure, no IO
- `canonicalVendorName(name)` → the canonical display name for a raw vendor
  name. Algorithm, in order:
  1. Normalize for lookup: trim, collapse internal whitespace, case-insensitive
     compare (keep a canonical's OWN casing for output).
  2. **Curated cluster map** (below): if the normalized name matches a listed
     variant, return that cluster's canonical.
  3. **Guarded mechanical strip:** strip a trailing legal suffix
     (` AB`, ` Aktiebolag`, ` Sverige AB`, ` Sverige`) and/or a genitive `-s`;
     if the stripped, normalized form equals a KNOWN canonical (a cluster
     canonical OR one of the `KNOWN_CANONICALS` seeded from the vendors table),
     return that canonical. Otherwise…
  4. …return the original name unchanged (never invent a merge).
- Export the curated `VENDOR_CLUSTERS` and a `KNOWN_CANONICALS` set so callers
  and tests can introspect. Keep it pure (no DB read; `KNOWN_CANONICALS` is a
  static seed list in the module).

### 2. Curated cluster map (CONSERVATIVE seed — implement EXACTLY this; add nothing beyond it)
`canonical ← [variants]` (case-insensitive match on variants):
- **Nationalencyklopedin** ← `NE`, `NE Nationalencyklopedin`, `Nationalencyklopedin`
- **Microsoft** ← `Microsoft`, `Microsoft 365`
- **Google** ← `Google`, `Google Workspace`, `Google Workspace for Education`
- **Skola24** ← `Skola24`, `Skola 24`
- **InfoMentor** ← `InfoMentor`, `Infomentor`, `Informentor`
- **Everway** ← `Everway`, `Ewerway`
- **Teachiq** ← `Teachiq`, `TeachIQ`
- **SchoolSoft** ← `SchoolSoft`, `Schoolsoft`
- **Oribi** ← `Oribi`, `Oribi Texthelp`
- **Insight** ← `Insight`, `Insight Technology Solutions`
- **Aleido Learning** ← `Aleido Learning`, `Aleido Learning Sweden`
- **Tempus** ← `Tempus`, `Tempus Information Systems`, `Tempus Information System`
- **Tietoevry** ← `Tietoevry`, `Tieto`
- **Inläsningstjänst (ILT)** ← `ILT`, `Inläsningstjänst`, `ILT Inläsningstjänst`, `ILT Education`
- **LäroMedia Bokhandel Örebro** ← `Läromedia Bokhandel Örebro`, `LäroMedia Bokhandel Örebro`

(The ` AB`/`Aktiebolag`/`Sverige`/genitive variants of the above and of other
vendors-table names — `Nova Software AB`, `Haldor AB`, `IST AB`, `StudyBee AB`,
`Skolon AB`, `Atea Sverige AB`, `Magma Radish AB`→no match, etc. — are handled
by the §1 guarded mechanical rule, so they need not be listed here.)

### 3. Explicit EXCLUSIONS (must NOT be merged — add a test asserting each stays distinct)
- `Magma Radish AB` must NOT merge into `Magma` OR `Radish` (both exist as
  distinct entities; the string names two — leave it unchanged).
- `Teams` must NOT merge into `Microsoft` (bare product name, ambiguous).
- `Chrome OS` / `Chrome Education` must NOT merge into `Google`.
- `Unikt lärande AB` / `Unikum - Unikt Lärande AB` must NOT merge into `Unikum`
  (leave as-is; company-vs-product is uncertain).
- `Inlästa läromedel` must NOT merge into `Inläsningstjänst` (generic phrase).
- Resellers (`Adda`/`ADDAS`/`Skolon`/`Läromedia`/`Atea`) stay owned by
  `matchResellers` (genitive-aware already) — `canonicalVendorName` must not
  interfere with reseller matching; do not special-case them here.

### 4. Apply at read-time (aggregation/display only)
- `src/dashboard-views.js`: canonicalize in `aggregateVendors` (mentioned),
  `aggregateConfirmedVendors` (confirmed), the kommun-panel dedup
  (`confirmedLower` / `mentionedOnly` / `vendorCount`), the per-vendor
  `docsByVendor` key, and the `resellerRelationsByVendor` vendor keys — so the
  Leverantörer panel shows one row per canonical vendor.
- `src/vendor-analytics.js`: group `buildVendorRollups` (the `/leverantorer`
  market list) and the coverage aggregation by `canonicalVendorName` so a vendor
  appears once with summed facts. Do NOT change the underlying per-contract
  data — only the grouping key.
- Vendor-page links: when a canonical maps to a name that has a slug in
  `vendorSlugsByName`, link there; otherwise render unlinked (existing
  no-dead-link behaviour). Do NOT fabricate slugs.

### 5. Out of scope (follow-ups)
- Merging duplicate `vendors` rows / redirecting duplicate vendor PAGES
  (persisted change) — deferred; this is read-time display only.
- Any LLM-clustered expansion of the map (operator chose curated).

## Constraints (non-negotiable)

- **No DB change, no data loss** — pure read-time canonicalization over existing
  data; `vendors` rows and `vendor_id`s untouched.
- **No wrong merges** — implement the §2 map EXACTLY and the §1 guarded rule;
  add NO merges beyond them; every §3 exclusion has a test. An unknown name
  passes through unchanged.
- **Pure functions stay pure** — `vendor-aliases.js` is pure; callers import it.
- **`matchResellers` behaviour unchanged** (resellers not affected).
- **Update fixtures/tests first**, then code.
- **Subagent works offline only** — no live `data/pilot.db`, daemon, Gmail,
  Slack, Anthropic, or `pilot-*` runs. Pure-function + view tests with fixtures.
- **Base:** reset the worktree onto the current `main` tip first
  (`worktree-stale-base`). Leave commits on a `vendor-name-normalization`
  branch; the operator integrates + restarts.
- Full offline `npm test` green.

## Testing (offline)

- `canonicalVendorName`: each §2 cluster's variants → the canonical (e.g.
  `NE` / `NE Nationalencyklopedin` → `Nationalencyklopedin`; `Microsoft 365`
  → `Microsoft`; `Skola 24` → `Skola24`; `Ewerway` → `Everway`; `Schoolsoft`
  → `SchoolSoft`); guarded mechanical strip (`Nova Software AB` → `Nova
  Software`, `Haldor AB` → `Haldor`, `IST AB` → `IST`) — AND a name whose strip
  doesn't match a known canonical passes through unchanged (`Random Startup AB`
  → `Random Startup AB`). Every §3 exclusion asserted to stay distinct.
- `aggregateVendors` / `aggregateConfirmedVendors`: `['NE','Nationalencyklopedin']`
  collapses to one canonical row.
- `renderKommunDetail`: a kommun mentioning both `Microsoft` and `Microsoft 365`
  shows ONE Microsoft row; `vendorCount` counts it once.
- `buildVendorRollups`: two contracts with vendors `Oribi` and `Oribi Texthelp`
  roll up under one `Oribi` with summed facts (not two rows).
- Regression: `matchResellers` tests unchanged and green; reseller names still
  filtered from the Nämnda list.
