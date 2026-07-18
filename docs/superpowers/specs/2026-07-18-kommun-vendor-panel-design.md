# Kommun profile — reseller channels + split Leverantörer panel

**Date:** 2026-07-18
**Status:** approved, ready for implementation

## Problem

The Västerås profile (`/kommun/1980`) makes plain a gap: the kommun's own
email says *"NE och Magma finns som underleverantörer i vårt avtal med
Läromedia"* — i.e. Västerås procures its edtech **through Läromedia**, a
reseller/framework channel we already model in `src/resellers.js`. But that
channel is invisible on the profile, because `reseller_channels` is derived
**only** from vendor names on stored `is_contract=1` contracts
(`storage.js` `listKommunerWithContracts`). Läromedia is *mentioned* in the
prose, not the vendor on a signed contract, so we never log it.

Two things are wanted:

1. **Log & show the reseller/framework channel** the kommun buys through
   (Läromedia / Adda / Skolon / Atea), sourced from what the kommun tells us
   in email prose, not just from signed contracts.
2. **A "Leverantörer" list in the left panel** of the profile, split by how
   much we actually know: contracts we hold vs. vendors merely named.

## Decisions (from the operator)

- The "upphandlingsenhet" to log is the **reseller/framework channel**
  (`resellers.js`), NOT the kommun's internal procurement email/department.
- The sidebar vendor list shows **both** confirmed and mentioned vendors,
  **visually split**, so we never imply a contract we haven't seen (core
  data-honesty ethos).
- The widened channel signal **also softens the global coverage matrices** —
  a kommun that says it buys via a channel genuinely can hold products that
  way, so this is honest, not noise.
- The redundant main-column **"Nämnda leverantörer" section is removed**,
  consolidated into the sidebar.

## Design — five changes

### 1. Widen channel detection (`src/storage.js` `listKommunerWithContracts`)
Today the function collects vendor names from `is_contract=1` contracts and
runs `matchResellers(names)` per kommun. Extend the name pool: also gather
`mentioned_vendors` from each kommun's inbound messages' `analysis_json`
(parse in JS, as the function already post-processes rows), union with the
contract vendor names, and pass the union to `matchResellers`.

- **Read-time only, no schema change** (matches the "no schema changes
  casually" convention). `matchResellers` is a whole-word match on a curated
  4-entry list, so false positives are negligible.
- A kommun with mentions but no `is_contract=1` contract still does **not**
  appear here (the query filters on `is_contract=1`) — that is fine; the
  matrices key off contracts. The profile (change 3) computes channels
  independently for its own display.
- Effect: the coverage matrices' existing reseller-softening now also fires
  for kommuner whose channel is known only from prose. **Intended.**

### 2. Plumbing (`src/dashboard.js` kommun route)
The route already runs
`SELECT a.*, c.is_contract AS contract_is_contract,
 c.document_type AS contract_document_type ... LEFT JOIN contracts c ON
 c.attachment_id = a.id`. Add `v.name AS contract_vendor_name` (LEFT JOIN
`vendors v ON v.id = c.vendor_id`) so the view can build the confirmed-vendor
set. No other route change.

### 3. Profile "Köper via" line + split Leverantörer panel (`renderKommunDetail`)
In the sidebar:

- Compute `confirmedVendors` = distinct `contract_vendor_name` where
  `contract_is_contract` is truthy, across this kommun's attachments.
- Compute `mentionedVendors` = existing `aggregateVendors` output
  (`mentioned_vendors` union across messages).
- `channels = matchResellers([...mentionedVendors, ...confirmedVendors])`.
- **"Köper via" line:** if `channels` non-empty, render a muted line heading
  the section: `🛒 Köper via ramavtal: <Läromedia, …>` (reuse the tooltip
  wording from `resellerBadge`).
- **`<h3>Leverantörer (N)</h3>` section**, two labelled subgroups:
  - **Avtal bekräftat** — `confirmedVendors`, each linking to
    `/leverantor/:slug` when `vendorSlugsByName` has the slug (else plain).
  - **Nämnda** — `mentionedVendors` minus any already in `confirmedVendors`
    (case-insensitive), muted styling; a `?`/muted note that these are only
    named, not confirmed.
  - Reseller-channel names get the 🛒 pill wherever they appear.
  - `N` counts distinct vendors across both groups.
- **Remove** the main-column `vendorsSection` ("Nämnda leverantörer") — the
  sidebar now carries it. Drop the now-unused main-column render, keep
  `aggregateVendors` (reused by the sidebar).

### 4. Honesty details
- A vendor that has a confirmed contract must **not** also show under Nämnda.
- Empty states: no confirmed and no mentioned → the section renders a muted
  "Inga leverantörer fångade ännu." (mirror existing sidebar empty states).
- Reseller pill stays a muted `pill-reseller`, never an alarm colour
  (consistent with the coverage-matrix treatment).

### 5. Tests (offline, temp/`:memory:` DB — never live `data/pilot.db`)
- `listKommunerWithContracts`: a kommun whose only Läromedia signal is a
  message `mentioned_vendors: ["Läromedia"]` (with ≥1 unrelated
  `is_contract=1` contract so it appears) now returns
  `reseller_channels: ['Läromedia']`. A kommun with neither → `[]`.
- `renderKommunDetail`:
  - "Köper via ramavtal: Läromedia" line renders when a channel is present.
  - Leverantörer section splits into "Avtal bekräftat" and "Nämnda".
  - A vendor with a confirmed contract appears under Avtal bekräftat and
    **not** under Nämnda.
  - Reseller 🛒 pill present for the channel vendor.
  - Main column no longer contains the old "Nämnda leverantörer" heading.

## Constraints (non-negotiable)

- **No schema change.** Channel detection is read-time compute over existing
  columns (`analysis_json`, contract `vendor_id`/`is_contract`).
- **No data loss.** Additive only; nothing deleted from the DB; the removed
  UI section is a render change, not a data change.
- **Pure functions stay pure** — the view takes its data via params; only the
  route reads the DB.
- **Update fixtures/tests to express the live contract**, then code.
- **Subagent works offline only** — temp/`:memory:` SQLite, injected fakes,
  no live `data/pilot.db`, daemon, Gmail, Slack, or Anthropic calls. Do NOT
  run any `pilot-*` command.
- **Base:** reset the worktree onto the current `main` tip before starting
  (Agent worktrees branch from a stale snapshot — see memory
  `worktree-stale-base`). Leave commits on a `kommun-vendor-panel` branch;
  the operator integrates + restarts.
- Full `npm test` passes (offline).

## Out of scope

- Surfacing the kommun's internal procurement department/email as a distinct
  "Upphandlingsenhet" contact (operator chose the reseller channel only).
- A persisted `kommun_channels` table with provenance/confidence (read-time
  derivation is sufficient for the curated reseller list).
- Reclassifying `mentioned_agreements` semantics or feeding them into channel
  detection (mentioned_vendors is the agreed source; agreements can follow
  later if needed).
