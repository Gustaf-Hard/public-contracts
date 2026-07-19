# Vendor↔ramavtal relationships, vertical Leverantörer panel, ramavtal pages

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

The kommun profile's Leverantörer panel is a flat chip cloud. The operator
wants it to read like Pipedrive's "People" list: a **vertical list**, each
vendor an icon + clickable link, mentioned-only vendors under a sub-header,
and — crucially — when a vendor is procured **through a ramavtal**, show that
as a framed tag on the vendor (e.g. `NE ▢ Läromedia`). Ramavtal providers
(Adda, Skolon, Läromedia, Atea) should be **first-class entities with their
own pages** ("have a place in the tool").

The blocker: we don't store *which* ramavtal a given vendor is reached
through. We know the kommun's channels in aggregate (`matchResellers` over
mentioned + confirmed vendor names), but the actual fact — "NE och Magma finns
som underleverantörer i vårt avtal med Läromedia" (Västerås, msg #6) — lives
only in email prose, never extracted as structured data.

## Decisions (from the operator)

- **Vendor→ramavtal link is extracted from emails (LLM)**, per-case. A vendor
  is tagged with a ramavtal **only when the kommun actually stated it** —
  never guessed from the kommun's channel set. (Honesty: three channels on
  one kommun means we cannot infer which one supplies NE.)
- **Ramavtal providers get dedicated pages** at `/ramavtal/:slug` — a distinct
  entity type (a channel, not a product vendor). Läromedia will legitimately
  have BOTH a vendor page (it holds a signed avtal) and a ramavtal page.
- **Drop the kommun-level "🛒 Köper via ramavtal: …" summary line.** Almost
  every kommun buys via ramavtal, so the line is noise; the per-vendor framed
  tags carry the specific signal. The underlying channel derivation stays (it
  still softens the coverage matrices) — only the display line is removed.
- **Frame icon** on the ramavtal tag — "ram" = frame in Swedish, so a
  bordered-frame glyph is the right visual for *ram*avtal.

## Design

### 1. Extraction — `src/analyse-message.js`
Add ONE field to the reply-analysis `extracted` object:
`reseller_relations`: an array of `{ vendor, ramavtal }` objects (nullable /
empty when none). The LLM fills it when the reply states a vendor is a
sub-supplier under / reached through a named framework agreement or reseller.
- `mentioned_vendors` stays exactly as-is (back-compat; existing consumers and
  the reseller-channel widening in `storage.js` depend on it).
- Update `SYSTEM_PROMPT` guidance + add/extend a few-shot example (the Västerås
  "NE och Magma … i vårt avtal med Läromedia" shape) → 
  `reseller_relations: [{vendor:'NE', ramavtal:'Läromedia'}, {vendor:'Magma', ramavtal:'Läromedia'}]`.
- **Union-limit guard:** adding one nullable array-of-objects field adds a
  small number of union params. Before finalizing, count the message schema's
  union-typed params (anyOf/nullable/type-arrays, incl. nested) and confirm it
  stays ≤16 (see memory `anthropic-structured-output-union-limit`). The
  message schema is far smaller than `CONTRACT_SCHEMA`, so there is headroom —
  but verify, because the failure is **live-only** (offline tests inject a fake
  client). Prefer the simplest shape: array items with two required plain
  string fields, the array itself nullable.
- The field lives INSIDE `analysis_json` (existing TEXT column). **No new
  column, no migration.**

### 2. Read-time derivation — `src/storage.js`
Add a helper that, per kommun, parses `reseller_relations` from inbound
messages' `analysis_json`, canonicalizes each `ramavtal` via `matchResellers`
(drop rows whose ramavtal doesn't match a curated reseller), and returns a map
`vendorName.toLowerCase() → [ramavtal canonical, …]` (deduped). Mirrors the
existing `mentioned_vendors` parsing. Read-time only, no schema change. A
malformed `analysis_json` is skipped safely. The kommun route passes this map
into `renderKommunDetail` (new param, default empty Map — existing tests
unaffected).

### 3. Vertical Leverantörer panel — `src/dashboard-views.js`
Replace the chip tag-list in `renderKommunDetail`'s Leverantörer section with
a **vertical list**, keeping the two sub-headers:
- **Avtal bekräftat** (confirmed contract vendors) and **Nämnda**
  (mentioned-only, minus confirmed, minus reseller-channel names — unchanged
  filtering from the 2026-07-18 panel).
- Each row: a vendor **icon** (small inline SVG, defined once) + the vendor
  name. **Linked** to `/leverantor/:slug` when `vendorSlugsByName` has a slug;
  otherwise icon + muted plain name with `title="ingen leverantörssida än"`
  (honest — no dead links; the future normalization project resolves more).
- **Ramavtal tag:** for each ramavtal in the vendor's relation list (from §2),
  append a bordered **frame** pill `▢ <Ramavtal>` linking to `/ramavtal/:slug`.
  Shown only when a relation was extracted for that vendor.
- **Remove** the `🛒 Köper via ramavtal: …` summary line and its helper usage.
  Keep computing `channels`/`isChannelName` only insofar as they still filter
  reseller names out of the Nämnda list.
- New CSS: `.vendor-row` (flex, icon + name + tags, one per line),
  `.pill-ramavtal` (bordered/framed, muted). Reuse existing `.muted`.

### 4. Ramavtal pages — `src/dashboard.js` + `src/dashboard-views.js` + `src/resellers.js`
- `src/resellers.js`: add a `slug` to each `RESELLERS` entry (slugified
  canonical, e.g. `adda`, `skolon`, `laromedia`, `atea`) and a
  `resellerBySlug(slug)` lookup. Pure.
- `renderRamavtal({ reseller, kommuner, vendors, … })` view: header with the
  frame icon + name; a section listing **kommuner that procure via it** (from
  the kommun-level channel derivation — `listKommunerWithContracts`'
  `reseller_channels`), each linking to `/kommun/:kod`; and a section listing
  **vendors reached through it** (distinct vendors from the extracted
  `reseller_relations` across all kommuner), each linking to its vendor page
  when one exists. Honest empty states ("Inga kända leverantörer via detta
  ramavtal än.").
- `GET /ramavtal/:slug` route: resolve via `resellerBySlug`; 404 (with the
  Leverantörer overview as a landing, mirroring `/leverantor/:slug`) for
  unknown slugs. Derives its data read-time from storage; works for Adda even
  though Adda has no `vendors` row.
- All four RESELLERS therefore have a working page — "every ramavtal has a
  place in the tool."

### 5. Backfill — supervised live step, NOT the subagent
Existing inbound messages have no `reseller_relations`. An **additive** script
(`scripts/10-extract-reseller-relations.js`) walks inbound messages, runs a
**targeted** LLM extraction (just the relations) over each `body_text`, and
merges the result into `analysis_json.extracted.reseller_relations` **without
recomputing or overwriting any other analysis field** (fill-only,
non-destructive). Backup `data/pilot.db` first; validate on one message
against the live API before the full run (Haiku). The subagent WRITES and
tests this offline (injected fake LLM, temp DB) but MUST NOT run it live. The
operator runs it supervised, backup-first — same discipline as the
2026-07-17 contract backfill.

## Constraints (non-negotiable)

- **No schema change.** `reseller_relations` lives in `analysis_json`;
  everything else is read-time derived over existing columns.
- **No data loss.** Additive extraction field; fill-only backfill that never
  overwrites other analysis fields; nothing deleted.
- **Honesty:** a vendor→ramavtal tag appears ONLY when the kommun stated the
  relation. No inference from the kommun's channel set. Non-page vendors are
  shown but not linked (no dead links).
- **Union limit ≤16** on the message schema — verify before finalizing
  (live-only failure).
- **Pure functions stay pure** — views and `resellers.js` take data via
  params / are pure; only the route + storage read the DB; only the backfill
  script calls the live LLM.
- **Subagent works offline only** — temp/`:memory:` SQLite, injected fake LLM
  client, hand-crafted fixtures. No live `data/pilot.db`, daemon, Gmail, Slack,
  Anthropic calls, or `pilot-*`/`scripts/10*` runs.
- **Base:** reset the worktree onto the current `main` tip before starting
  (worktrees branch from a stale snapshot — memory `worktree-stale-base`).
  Leave commits on a `vendor-ramavtal` branch; operator integrates + one
  restart.
- **Tests-as-contract first**, then code. Full offline `npm test` green.

## Testing (offline)

- `analyse-message`: with a faked LLM returning a `reseller_relations` array,
  the parsed analysis carries it; absent/empty → empty; malformed JSON safe.
  (Prompt/schema shape asserted; the live union count is a manual check.)
- storage read-time helper: a kommun whose inbound message states
  `reseller_relations:[{vendor:'NE',ramavtal:'Läromedia'}]` yields
  `{ ne: ['Läromedia'] }`; a non-curated ramavtal name is dropped; malformed
  analysis_json skipped; no relations → empty map.
- `renderKommunDetail`: vertical rows (not chips); a confirmed vendor links to
  its page; a no-page vendor renders icon + unlinked name; a vendor with a
  relation shows the framed `▢ Läromedia` tag linking to `/ramavtal/laromedia`;
  the old `🛒 Köper via ramavtal:` line is gone.
- `resellers.js`: `resellerBySlug('adda')` resolves; unknown → null; slugs are
  unique.
- `renderRamavtal`: lists kommuner-via and vendors-reached-through with correct
  links; honest empty states; the frame icon in the header.
- Backfill script: over a temp DB with a fake LLM, fills
  `reseller_relations` on inbound rows and leaves every other analysis field
  byte-identical (fill-only); does not touch non-inbound rows.

## Out of scope (follow-ups)

- **Vendor-name normalization** (ADDA/ADDAS/Adda Ramavtal → Adda; Microsoft /
  Microsoft 365; Alvis / Alvis GotIT). Still deferred; it's what will make the
  remaining no-page rows link and collapse the duplicates. Separate spec.
- Product coverage on the ramavtal page (kommuner-via + vendors-through is the
  agreed scope for now).
- The Gmail-like thread view (separate, still-pending design).
