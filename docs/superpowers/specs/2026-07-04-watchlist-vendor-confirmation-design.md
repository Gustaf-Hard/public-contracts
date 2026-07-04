# Watchlist-Vendor Confirmation — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorming) — ready for implementation plan
**Related:** [2026-07-04-contract-aware-followup-design.md](2026-07-04-contract-aware-followup-design.md) — this builds directly on the contract-aware delivery draft (`computeReceivedMissing`, the delivery branch in `src/tick.js`).

## Problem

The delivery follow-up now drafts a contract-aware reply automatically (T_RECEIPT
or T_REQUEST_MISSING). For most municipalities that is exactly what we want — a
human approves the draft and it goes out. But some vendors are *strategically
sensitive* to the operator and must not be handled on autopilot:

- **Binogi** — the operator's own company (`gustaf@binogi.com`). A municipality
  contract naming Binogi is not a routine "please send the missing avtal" case.
- **Nationalencyklopedin (NE)**, **Inläsningstjänst (ILT)**, **Magma** — direct
  edtech peers whose appearance on a contract list warrants a conscious human
  decision before any reply is sent.

Today nothing distinguishes these from any other vendor: the pipeline drafts a
normal reply, and a human reviewing a queue of routine drafts can approve one of
these on autopilot without noticing the sensitive vendor.

## Goal

When a delivery's vendor list includes a watchlist vendor, the pipeline must
**flag** the escalation prominently and **hold** the draft — surfacing which
watchlist vendor(s) matched and leaving no pre-filled, ready-to-send reply, so
the operator consciously authors (or declines) the response instead of
rubber-stamping an auto-draft. This mirrors the collaborative, human-checked
style used for Västerås.

## Non-goals

- No auto-sending changes beyond holding the draft; the human gate already
  exists. This only removes the auto-draft for matched deliveries and adds a
  flag.
- No conversation FSM change. A delivery still transitions as today; only the
  drafted reply differs.
- **Not** hard-blocking the Slack "Approve" button for held escalations. The hold
  reuses the existing `free_form` "write-it-yourself" path (already used for the
  `escalate` action), whose placeholder body would be sent if a human clicks
  Approve instead of Edit. That is pre-existing behavior, not introduced here;
  the ⚠️ banner and *(ingen draft)* display mitigate it. A hard Approve-block is
  a larger Slack-interactivity change, deferred as a follow-up.
- No configurable/external watchlist. The list is a small code constant (4
  entries, changes rarely).

## Approach

**Match-then-hold within the existing delivery branch.** The contract-aware
feature already, for a `delivery`, analyses the message's attachments inline and
computes received-vs-missing. We extend that same block: gather *all* vendors
named in the delivery, match them against a code-constant watchlist, and — when
any match — override the draft to a held (`free_form`) escalation that carries
the matched vendor names. The watchlist decision **supersedes** the
contract-aware draft: a match means "do not auto-draft anything."

## Components

### 1. Watchlist module (`src/watchlist.js`, new — pure)

A defined constant plus one pure function. No IO.

```js
export const WATCHLIST = [
  { canonical: 'Nationalencyklopedin',   aliases: ['nationalencyklopedin', 'ne'] },
  { canonical: 'Magma',                  aliases: ['magma'] },
  { canonical: 'Inläsningstjänst (ILT)', aliases: ['inläsningstjänst', 'ilt'] },
  { canonical: 'Binogi',                 aliases: ['binogi'] },
];

// Return the canonical names of watchlist entries matched by any of the names,
// deduped, in WATCHLIST order.
export function matchWatchlist(names) { /* ... */ }
```

**Normalization** (applied to both a vendor name and each alias before
comparison):
- lowercase
- ASCII-fold Swedish letters: `å`/`ä` → `a`, `ö` → `o` (also `é`→`e`, `ü`→`u`)
- replace punctuation with spaces, collapse runs of whitespace, trim

So `ILT Inläsningstjänst`, `inlasningstjanst` (OCR without diacritics), `NE`, and
`Binogi AB` all normalize to forms the aliases match.

**Matching is whole-word**, not naive substring: an alias matches a name only
when it appears as a whole token (regex `\balias\b` on the normalized string).
This is required so short aliases (`ne`, `ilt`) do not false-positive on
unrelated names (`Vinge`, `Skillster`, `Skolplus`). Distinctive aliases
(`nationalencyklopedin`, `binogi`, `magma`) also match as whole words. Aliases
are authored already ASCII-folded/lowercased (or folded at load time) so the
comparison is fold-vs-fold.

`matchWatchlist([])` → `[]`. Null/blank names are skipped.

### 2. Full vendor set (`src/templates.js`, extend)

`computeReceivedMissing(rows)` currently returns `{ received, missing }`. Add a
third field `all`: the distinct union (case-insensitive dedup, first-seen casing
preserved) of

- every row's `vendor_name` that is present, and
- every `mentioned_agreements[].vendor` across all rows, **regardless of
  `doc_attached`**.

`all` is the complete set of vendors named anywhere in the delivery — the input
to `matchWatchlist`. Adding a field is backward compatible; existing callers that
destructure `{ received, missing }` are unaffected.

### 3. Storage (`src/storage.js`, extend)

- Add column `watchlist_vendors TEXT` to `escalations`: in the `CREATE TABLE`
  schema (for fresh DBs) and via an idempotent PRAGMA-probed `ALTER TABLE ADD
  COLUMN` in `migrate()` (matching the existing migration pattern for
  `follow_up_at`, `analysis_json`, etc.). Stores a JSON array of matched
  canonical names, or `NULL`/absent when none.
- `recordEscalation(e)` accepts and inserts `e.watchlist_vendors ?? null`.
- `listOpenEscalations()` (and any escalation read used by the dashboard) returns
  `watchlist_vendors` so surfaces can render it.

### 4. Tick wiring (`src/tick.js`, delivery branch only)

Inside the existing crash-safe inline-analysis block (the one guarded by
`draftTemplate === 'T_RECEIPT'` that computes received/missing):

1. Destructure `all` from `computeReceivedMissing(...)`.
2. `const matched = matchWatchlist(all);`
3. If `matched.length > 0` (checked **before / instead of** the
   T_REQUEST_MISSING override):
   - `draftTemplate = 'free_form'` (held — no sendable draft)
   - `llmDraft = null`
   - record the matched vendors so `escalateWithDraft` can persist and surface
     them (see below)
   - the escalation `reason` becomes
     `⚠️ BEVAKAD LEVERANTÖR: <matched joined> | <original reason>`
4. Else: existing contract-aware behavior (T_RECEIPT / T_REQUEST_MISSING).

The whole block remains inside the existing try/catch: if inline analysis throws,
`all` is empty, no match fires, and today's behavior stands. Only the delivery
branch is affected; precision/escalate/followup are untouched.

`escalateWithDraft(...)` gains a dedicated `watchlistVendors = []` parameter
(distinct from `templateCtx`, since `free_form` ignores template context). It
passes the array to `recordEscalation` (persisted as JSON in `watchlist_vendors`)
and to `buildEscalationBlocks` (for the banner).

### 5. Surfacing

**Slack (`src/slack.js`).** `buildEscalationBlocks({ ..., watchlist_vendors })`
prepends a warning block when `watchlist_vendors` is non-empty:

```
⚠️ *BEVAKAD LEVERANTÖR:* <vendors joined> — kontrollera innan du svarar.
```

Because the draft is `free_form`, "Förslag på svar" shows *(ingen draft)*; the
operator uses **Edit** to author the reply. When `watchlist_vendors` is empty the
blocks are unchanged from today.

**Dashboard (`scripts/pilot-dashboard.js`).** Render the same ⚠️ banner and the
matched vendor names on the flagged escalation, consistent with the existing
"needs action" styling.

## Data flow

```
delivery → save attachments → analyse inline
  → computeReceivedMissing → { received, missing, all }
  → matched = matchWatchlist(all)
  → matched.length > 0 ?
       HOLD: draftTemplate='free_form', llmDraft=null,
             reason='⚠️ BEVAKAD LEVERANTÖR: …', watchlist_vendors=matched
     : T_RECEIPT | T_REQUEST_MISSING  (contract-aware, unchanged)
  → escalateWithDraft → recordEscalation(+watchlist_vendors)
                      → buildEscalationBlocks(+watchlist_vendors) → Slack
```

## Error handling

- Watchlist matching is pure and does not throw on normal input (`[]`, nulls,
  blanks handled).
- Inline analysis failure is already caught (contract-aware feature); on failure
  `all` is empty, so no false hold — falls back to today's behavior.

## Testing (all offline)

**`watchlist.js` (pure):**
- Matches by canonical and alias: `Nationalencyklopedin` and `NE`; `ILT
  Education`, `ILT Inläsningstjänst`, `Inläsningstjänst`, and ASCII-folded
  `inlasningstjanst`; `Binogi` and `Binogi AB`; `Magma`.
- No false positives: `ne`/`ilt` as substrings of unrelated names (`Vinge`,
  `Skillster`, `Skolplus`) do **not** match.
- Case-insensitive; deduped; returns canonical names in `WATCHLIST` order;
  `matchWatchlist([])` → `[]`.

**`computeReceivedMissing`:** returns `all` as the union of received +
every mentioned vendor (including `doc_attached=true` mentions), deduped.

**`storage`:** `recordEscalation` persists `watchlist_vendors`;
`listOpenEscalations` returns it; `migrate()` adds the column idempotently on a
pre-existing DB.

**`slack`:** `buildEscalationBlocks` includes the ⚠️ banner (with vendor names)
when `watchlist_vendors` is set and omits it when absent.

**`tick` integration:** a delivery whose vendors include a watchlist vendor →
escalation `draft_template='free_form'`, `watchlist_vendors` set, `reason`
contains `BEVAKAD LEVERANTÖR`, and the draft is **not** T_RECEIPT/T_REQUEST_MISSING;
a delivery with no watchlist vendor → unchanged (T_RECEIPT / T_REQUEST_MISSING).

## Success criteria

- A delivery naming any watchlist vendor (Binogi / NE / ILT-Inläsningstjänst /
  Magma) — whether as a real attached contract or only mentioned in a summary —
  produces a **held** escalation with no pre-filled sendable reply.
- The escalation prominently names the matched watchlist vendor(s) in both Slack
  and the dashboard.
- Deliveries with no watchlist vendor keep today's contract-aware behavior.
- Short aliases (`ne`, `ilt`) never false-positive on unrelated vendor names.
- The follow-up remains human-authored; no auto-send is introduced.
