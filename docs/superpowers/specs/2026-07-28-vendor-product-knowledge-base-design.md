# Vendor/product knowledge base + 3-stage coverage engagement

**Date:** 2026-07-28
**Status:** design for review

## Problem

The pipeline treats every extracted name as a flat "vendor". It has no notion
that a **product** belongs to a **company**, and no notion that some names are
**procurement channels** we buy *through*, not vendors we want a contract
*from*. Two failures follow.

**1. Strange missing-contract drafts.** Borlänge (conv 31) sent the **Magma**
contract. Magma, Matteappen and Magma Pedagogik are all products of the company
**Radish**. The generated draft nonetheless:
- thanked them for *Matteappen* (a Radish product),
- asked for the still-missing contract from *Radish* (the maker of the Magma they
  just delivered), and
- re-asked for *Magma* (already delivered),
- and listed *LäroMedia* and *Adda* as missing "contracts" — but those are
  procurement channels, not services we want an avtal from.

**2. Fragmented analytics.** The same company appears as several "vendors":
NE as `Nationalencyklopedin` / `NE` / `NE Nationalencyklopedin`; ILT as
`ILT Education` / `ILT Inläsningstjänst` / `Inläsningstjänst`; `Skola24` is both
its own vendor and a product of `Nova Software`; `Tieto`/`Tietoevry` split; etc.
The `products` table already captures `Magma → Radish` in fragments — the
knowledge exists, it is just not curated or fed back into any reasoning.

## Goals

- A single curated knowledge base of **companies → products → aliases**, tagged
  **service** vs **channel**, small enough (~50 companies, ~200 products) to fit
  entirely in an LLM prompt.
- Deterministic **read-time resolution** of any raw name → its canonical
  company, powering clean analytics, watchlist satisfaction, and grounded draft
  facts — without mutating stored extraction.
- A **3-stage coverage engagement** that drives toward collecting every digital
  school service a kommun uses, direct or via upphandlingspartner, and reaches a
  principled "complete" end-state.

## Non-goals

- No rewrite of stored `vendors`/`products` rows (read-time resolution only; a
  backfill pass is a possible later option, out of scope here).
- No change to the send-safety model (two-phase claim, human approval, one open
  escalation/conv) — all new drafts still require human approval.
- Not a general vendor CRM; the KB covers Swedish school/edtech digital services
  and their procurement channels only.

## The knowledge base — `src/vendor-kb.js` (new)

A pure, curated data module in the shape of `watchlist.js` / `resellers.js`, one
entry per company:

```js
export const COMPANIES = [
  { canonical: 'Radish', slug: 'radish', role: 'service', category: 'läromedel',
    aliases: ['radish'], products: ['Magma', 'Matteappen', 'Magma Pedagogik'],
    watchlist: true },
  { canonical: 'ILT Education', slug: 'ilt', role: 'service', category: 'läromedel',
    aliases: ['ilt', 'ilt education', 'ilt inläsningstjänst', 'inläsningstjänst'],
    products: ['Polyglutt', 'Polylino', 'Begreppa', 'Inlästa läromedel', 'Trovy', 'Aski Raski'],
    watchlist: true },
  { canonical: 'Adda', slug: 'adda', role: 'channel',
    aliases: ['adda', 'skl kommentus', 'kommentus'], products: [] },
  // …Skolon, Atea, LäroMedia, Mediacenter, GR → role: 'channel'
  // …NE, Binogi, Unikum, Tieto, IST, Skola24/Nova Software, … → role: 'service'
];
```

Fields: `canonical`, `slug`, `role` (`'service' | 'channel'`), `category`,
`aliases` (company-name variants), `products` (brand/product names, incl. their
common variants), `watchlist` (strategically-sensitive → still holds the draft
for conscious authoring, per the existing watchlist design).

`role` is the key new concept:
- **service** — a real vendor whose contract/avrop we ultimately want.
- **channel** — a procurement/distribution partner (Adda, SKL Kommentus, Skolon,
  Atea, LäroMedia, Mediacenter, GR). We **never** request "the channel's
  contract"; we request the real services / the kommun's own avrop behind it.

### Resolver (pure)

```js
resolveCompany(name) // → { canonical, slug, role, matchedAs: 'company'|'product', product? } | null
```

Normalisation reuses the watchlist matcher (`src/watchlist.js` `normalize` +
whole-word alias match, ASCII-folding å/ä/ö) so short aliases (`ne`, `ilt`)
never fire inside unrelated tokens. A name matches on a company alias
(`matchedAs: 'company'`) or on a product (`matchedAs: 'product'`, with the
matched `product`). Unknown names return `null` and are passed through unchanged
by callers — the KB is a whitelist, never a guess.

This module becomes the single source of truth: `watchlist.js` reduces to
"companies where `watchlist: true`", the near-dupe collapsing in
`canonicalVendorName` is backed by it, and `resellers.js` channels move in as
`role: 'channel'` entries. (Consolidating those is part of this work, not an
unrelated refactor — they are the same concept expressed three times today.)

## Consumers (all read-time; stored rows untouched)

1. **Analytics** (`src/vendor-analytics.js`): group rollups by
   `resolveCompany(name).canonical` instead of `canonicalVendorName`'s
   near-dupe collapse. NE/ILT/Tieto each become one company with their products
   nested; channels render as channels, not vendors.
2. **Watchlist**: delivering `Magma` resolves to `Radish`, satisfying the
   watchlist entry — it stops holding/flagging for a product already delivered.
3. **Extraction** (`src/analyse-contract.js`): inject a compact KB digest
   ("Radish → Magma, Matteappen; ILT Education → Polyglutt, Polylino, …") into
   the Opus prompt, instructing it to attribute a product to its parent company.
   Reduces fragmentation at the source. (Union-param budget unaffected — this is
   prompt text, not schema; see [[anthropic-structured-output-union-limit]].)
4. **Drafts** — deterministic facts + LLM prose:
   - **`buildCoverageFacts(conv, db)`** (deterministic, new in `templates.js` or
     a `coverage.js`): resolves every delivered attachment/vendor to its company
     and returns the honest ground truth —
     `{ received: [{company, role, via:'direct'|'channel', products}],
        channels_seen, not_yet_seen, stage }`. This is what fixes the
     hallucination bug: the facts come from real files, not the model.
   - The **LLM writes the reply** given those facts + the full KB + the stage
     rules below. Because the facts are deterministic and the KB is complete,
     the model grounds every claim; it never re-asks for a received service and
     never requests a channel's own contract.

## The 3-stage coverage engagement

Maps onto the existing FSM (`INITIAL→SENT→ACK_RECEIVED→AWAITING_PRECISION→
DELIVERING→DONE`). Two append-only marker columns on `conversations`
(`channel_probe_sent_at`, `crosscheck_sent_at`, added via the existing
`PRAGMA table_info` probe pattern — no casual schema change) gate the
once-only stages.

**Stage 1 — Open wide (unchanged).** `T_INITIAL`: broad request for all digital
school contracts, direct or indirect. No vendor names.

**Stage 2 — Channel probe.** In `DELIVERING`, when `buildCoverageFacts` shows
channels mentioned/delivered (Adda, Skolon, …) but the real services/avrop
behind them are not yet detailed, and `channel_probe_sent_at` is null: draft a
`T_CHANNEL_AVROP` reply asking for the kommun's own avrop/beställningar under
those framework agreements (the avrop show real products/volumes). Never asks
for the framework contract itself. Sets `channel_probe_sent_at` on send.

**Stage 3 — Single cross-check.** When direct + channel gaps are satisfied (no
pending direct/channel asks) and `crosscheck_sent_at` is null and
`not_yet_seen` is non-empty: draft a `T_CROSSCHECK` reply that names the
**watchlist + commonly-seen key service companies this kommun has not
mentioned** (a focused, answerable list — not all ~50 in the KB) and asks them
to cross-check and confirm which they do not use. Sent **once**. Sets
`crosscheck_sent_at`.

**Coverage end-state.** The kommun's reply to the cross-check records each named
company as **received** or **confirmed-absent** (a lightweight
`coverage_confirmations(conversation_id, company_slug, status, at)` table).
Once every KB service is either received or confirmed-absent, the conversation
is **complete → `DONE`**; no further follow-ups. "Unknown" (never asked) is
distinct from "confirmed-absent" (asked, denied) — an honesty distinction
surfaced in analytics. [[data-honesty-ethos]]

## Data honesty & safety

- **Read-time only** — raw extraction stays exactly as the kommun sent it;
  resolution/labelling happens on read. Reversible; re-runnable.
- **Deterministic facts ground the LLM** — the draft's received/missing claims
  come from `buildCoverageFacts` over real attachments, not model memory. Fixes
  the `T_REQUEST_MISSING` hallucination (Huddinge/Boxholm/Bräcke, 2026-07-20).
- **Whitelist, not heuristic** — unknown names pass through unchanged; the KB
  never invents a company. Consistent with the project's whitelist ethos.
- **Human approval unchanged** — every stage-2/3 draft is an escalation the
  operator approves; nothing auto-sends. One open escalation per conversation.
- **Confirmed-absent ≠ unknown** — coverage completeness only counts explicit
  confirmations, never assumptions.

## Testing

- Pure `resolveCompany` unit tests: `Magma → Radish`; ILT alias set; NE variants;
  whole-word safety (`ne` not matching inside "oppanel"); `Adda → role:channel`;
  unknown → `null`.
- `buildCoverageFacts` test replaying Borlänge: Magma delivered ⇒ Radish
  received, not in `not_yet_seen`, Adda/LäroMedia never listed as missing.
- Analytics grouping test: NE/ILT fragments collapse to one company each.
- Stage-transition tests: channel probe fires once and sets its marker;
  cross-check fires once when gaps closed; completeness → DONE only when all
  received-or-confirmed-absent.
- Fixtures updated first where a parser/classifier contract changes.

## Implementation phases (one spec, staged rollout)

1. `vendor-kb.js` + `resolveCompany` + tests; back `watchlist.js` with it.
2. Analytics grouping via the resolver (visible win in `/leverantorer`).
3. `buildCoverageFacts` + KB-grounded LLM draft for the missing/channel reply;
   re-draft the open Borlänge escalation as the first live check.
4. Stage markers + `T_CHANNEL_AVROP` + `T_CROSSCHECK` + `coverage_confirmations`
   + completeness → DONE.
5. KB digest injected into the extraction prompt.

## Out of scope

- Backfilling/merging stored `vendors`/`products` rows (read-time only for now).
- Auto-sending any stage (human approval retained).
- Non-school vendor domains.

## Open items to confirm at build time

- Exact seed contents of `vendor-kb.js` (I generate the first draft from the
  live extracted vendors/products + known Swedish edtech landscape; operator
  reviews the committed file).
- Which service companies count as "commonly-seen key" for the Stage-3
  cross-check list (tunable; default = `watchlist: true` + a small curated set).
