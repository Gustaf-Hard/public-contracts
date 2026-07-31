# Collection velocity — week-by-week avtal, response speed, funnel

**Date:** 2026-07-31
**Status:** design, operator-approved

## Problem

The overview gives counts but no sense of **speed**. There is no way to see
whether collection is accelerating or stalling, how long a kommun takes to
answer with a human, or how long it takes from first contact to the first real
avtal. `Snittsvarstid` renders `—` because `avg_reply_days` is hardcoded `null`
(`src/dashboard.js` `buildSummary`).

Worse, the headline is wrong. **`Avtal mottagna` counts attachments, not
avtal.** `buildOverviewRows` counts `count(a.id)` from `attachments` with no
`is_contract` filter, so följebrev, bilagor, prislistor and PUB-avtal all
inflate it. Live numbers on 2026-07-31:

| | count |
|---|---|
| attachments received | 154 |
| analysed (`contracts` rows) | 147 (0 PDFs pending) |
| **actual avtal (`is_contract = 1`)** | **91** |
| `bilaga` | 36 |
| `övrigt` / PUB-avtal / `prislista` / följebrev | 10 / 7 / 2 / 1 |

The tile overstates collected avtal by ~69%. That is a
[[data-honesty-ethos]] violation in the most-read number on the dashboard.

## Goals

- A **`/takt`** page, reached by clicking the Avtal-mottagna tile, showing
  week-by-week avtal with a cumulative line, the two speed metrics, the funnel,
  and which kommuner have gone silent.
- **Correct the headline**: tile and per-kommun column count real avtal.
- Every number states its own sample size and definition, so none of them can
  mislead the way `154` does.

## Non-goals

- No schema change. Both new queries are read-only `SELECT`s over existing
  tables (`storage.js` migrations stay append-only probes).
- No JS charting library, no build step, no CDN (the dashboard has none).
- Not a forecast. The page reports what happened; it does not extrapolate a
  completion date from 8 weeks of sparse data.

## Data feasibility (probed read-only against the live DB, 2026-07-31)

- `messages.classification` is populated on **135 of 136** inbound messages, so
  robot-vs-human is reliable: `auto_ack` 55, `auto_reply` 5 (robots);
  `delivery` 30, `clarification` 16, `unknown` 14, `delay_promise` 12,
  `handoff_internal`/`handoff`/`dead_end` 1 each, null 1.
- 62 conversations have an outbound; 31 have a human reply; 16 have an avtal.
- First human reply: mean 2.74 d, range 0.01–14.98 (n=31).
- First contact → first avtal: mean 5.02 d, range 0.35–24.98 (n=16).
- Avtal by week: W15 8, W23 17, W25 22, W26 1, W27 23, W28 16, W29 1, W30 3
  (sums to 91). Note the **W16–W22 gap** — it must render as a gap.

## Definitions (shown on the page, not just in this doc)

- **Robot reply** = `classification IN ('auto_ack','auto_reply')`. `unknown`
  and null count as **human**: no robot marker matched, so a person almost
  certainly wrote it. This affects 15 of 136 inbound messages. The page always
  shows `n`, so the sample is visible rather than implied.
- **Week** = ISO week (Mon–Sun) of `messages.received_at`, which is Gmail's
  `internalDate` and never processing time (existing invariant). Weeks with no
  avtal between the first and last week render as **zero-height bars, not
  skipped** — a gap must look like a gap.
- **Median, not mean**, for both timing metrics: the distributions are skewed
  (one kommun took 25 days). Median is over **conversations**, so a chatty
  kommun cannot weight the result. Mean is not shown; range and `n` are.
- **Avtal** = `contracts.is_contract = 1`. Everything else is a file, not an
  avtal.
- **Durations are excluded when negative** (a reply timestamped before our
  first outbound — clock skew, or an inbound matched to a conversation created
  later). They are dropped from the median and counted nowhere; `n` therefore
  reports only the durations actually measured.

## Architecture

Follows the `/leverantorer` pattern: a pure analytics module, a thin route, and
server-rendered HTML.

### `src/collection-velocity.js` (new, pure — no IO, no DB)

```js
buildVelocityFacts({ contractEvents, caseTimings, files, now }) → {
  weeks:   [{ iso_week, week_start, contracts, cumulative, kommuner }],
  timings: {
    first_human_reply: { median, min, max, n, of },
    first_contract:    { median, min, max, n, of },
  },
  funnel:  { contacted, human_replied, delivered },
  silent:  [{ conv_id, kommun_namn, days_waiting }],   // sorted desc
  files:   { total, avtal, by_type: [{ document_type, n }] },
}
```

Inputs are plain rows so the module is testable offline with fixtures:

- `contractEvents`: `{ conversation_id, kommun_namn, received_at }` per
  `is_contract = 1` contract.
- `caseTimings`: one row per conversation —
  `{ conversation_id, kommun_namn, first_outbound_at, first_human_inbound_at,
  first_contract_at }` (nulls where it has not happened).
- `files`: `{ document_type, n }` rollup plus the attachment total.

`median` returns `null` for an empty sample — never `0`, which would read as
"instant" ([[data-honesty-ethos]]).

### `src/storage.js` (two read-only queries, no schema change)

- `listContractDeliveryEvents()` — `is_contract = 1` joined through
  `attachments → messages → conversations` for `received_at`, `kommun_namn`.
- `listCaseTimings()` — per conversation, `min(received_at)` for the first
  outbound, for the first inbound whose classification is not a robot marker,
  and for the first delivered avtal.
- `countFilesByDocumentType()` — the 154-vs-91 breakdown.

### `src/dashboard.js`

- New `GET /takt` route → `buildVelocityFacts` → `renderVelocity`.
- `buildOverviewRows`: the per-kommun `contracts` count switches from
  `count(a.id)` over attachments to `is_contract = 1`. `buildSummary` sums the
  corrected value, so the tile and the column agree.

### `src/dashboard-views.js`

- `renderVelocity(facts)` — inline SVG bar chart plus cumulative polyline,
  the two timing blocks, the funnel, and the silent list.
- The Avtal-mottagna tile becomes a `data-pane-link` to `/takt`; `/takt` joins
  the sidebar after Aktivitet.

## Page content

1. **Avtal per vecka** — bars (avtal that week) + cumulative line, x-axis
   labelled by ISO week, empty weeks present. Rendered as inline SVG with an
   `aria-label` and `<title>`; the same weekly numbers repeat in a compact
   table underneath, which is both the accessible fallback and the honest
   "here are the actual figures".
2. **Två hastigheter** — first human reply and first contact → first avtal,
   each as `median · spann min–max · n av <funnel.contacted> kontaktade`
   (the denominator is computed, never a literal).
3. **Tratt** — kontaktade → mänskligt svar → levererat avtal.
4. **Tysta kommuner** — outbound sent, no human reply yet, sorted by days
   waiting, each linking to `/arenden/:id`. Capped at 10 with an explicit
   "+N fler" so nothing is silently truncated.
5. **Filer** — the 154/91 split by `document_type`, so the corrected headline
   is self-explaining rather than arbitrary.

## Testing

- `tests/collection-velocity.test.js` — pure unit tests over fixture rows:
  week bucketing incl. a deliberate empty week; cumulative monotonicity;
  median/range/n incl. the empty sample → `null`; robot classifications
  excluded from "first human reply" while `unknown` counts as human; funnel
  counts; silent-list ordering and cap.
- `tests/dashboard.test.js` — `/takt` renders 200 with the chart and the
  definitions; the corrected tile counts avtal not attachments (this test must
  fail against the current code, proving it is not vacuous).
- All offline, temp-dir SQLite via `mkdtempSync` + `openDb` + `migrate()`.

## Risks

- **The headline drops 154 → 91 and per-kommun counts drop with it.** Intended,
  and the files breakdown on `/takt` explains it, but it will look like data
  loss at first glance. Worth expecting.
- **Small samples.** n=16 for time-to-first-avtal. Always displaying `n` is the
  mitigation; the page must not present a 16-case median as settled fact.
- **W15 looks anomalous** (8 avtal, then a 7-week gap). It is real data and is
  rendered as-is; no smoothing, no dropping.

## Out of scope

- Forecasting a completion date.
- Per-kommun velocity pages (the existing `/arenden/:id` already shows a case).
- Backfilling or re-analysing attachments (0 PDFs are pending).
