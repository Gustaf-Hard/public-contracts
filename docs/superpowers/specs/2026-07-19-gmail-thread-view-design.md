# Gmail-like conversation view — minimal thread rows + collapsed quoted history

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

The dashboard conversation view is hard to read on two counts:

1. **Thread rows are busy.** Each thread header (`renderThreadGroups` in
   `src/dashboard-views.js`) shows a bold name, the full email address, the
   `★ primary`/`mute` controls inline, a 90-char raw snippet, and "N
   meddelanden" — far from Gmail's dense one-liner.
2. **Quoted history is dumped inline.** `threadMessage` renders the entire
   `body_text`, so every reply repeats the whole prior thread ("12 juni 2026
   kl. 13:13 skrev Gustaf …:" followed by the quoted body, nested). Reading a
   thread means scrolling past the same text many times.

Make it read like Gmail: minimal thread rows, and per-message collapse of the
quoted trailing history behind a `···` expander.

## Decisions (from the operator)

- **Row summary:** the LLM one-sentence summary of the latest message
  (`analysis_json.summary`), falling back to a raw snippet for our own sent
  messages / messages with no analysis.
- **Quote collapse:** show only the new text; tuck ALL quoted prior-thread
  behind a `···` expander. **Keep the signature visible** (Gmail-like).
- **Participant label:** `Radgren, Mikaela, jag · N` (counterparty name, then
  `, jag` when the thread has ≥1 outbound message, then the message count) —
  mirrors Gmail's "Mikaela, me 19".

## Design

### 1. Split the quoted history — `src/classifier.js`
Add `splitQuotedText(body) → { visible, quoted }` that reuses the existing
`stripQuotedText` markers but returns BOTH parts. **Broaden the markers** so it
catches the leading-date Gmail Swedish attribution the current regex misses:
- current: `^(Den|On) .{4,80}skrev.*:$`
- also match a line that is a date-led attribution ending in `skrev … :` or
  `… wrote:` WITHOUT a leading "Den"/"On" — e.g. `12 juni 2026 kl. 13:13 skrev
  Gustaf Hård af Segerstad <…>:` and `On Sat, Jun 6, 2026 at 10:09 AM … wrote:`.
  A pragmatic rule: a line containing ` skrev ` and ending with `:`, or matching
  `wrote:$`, or an Outlook/`Från:`/`From:`/`-----…-----` header, starts the
  quoted tail. `>`-prefixed lines also belong to `quoted`.
`visible` = everything before the first such marker; `quoted` = the marker line
and everything after. Refactor `stripQuotedText(body)` to return
`splitQuotedText(body).visible` — **zero behaviour change**; the existing
classifier/closer tests must stay green untouched. Signature lines (e.g. "Med
vänlig hälsning …", "Skickat från min iPhone") stay in `visible`.

### 2. Collapse in the message body — `src/dashboard-views.js` `threadMessage`
Render `visible` in `.msg-text`. When `quoted` is non-empty, append a `···`
toggle button (`data-quote-toggle`) that reveals a muted `.msg-quote` block
containing `quoted`. No quoted tail → no toggle. Escape both parts as today.

### 3. Client toggle — the dashboard client script
Add a `data-quote-toggle` handler mirroring the existing `data-collapse` /
`data-thread-toggle` pattern (find where those live — inline in `layout()` or a
`public/` script). Clicking toggles the sibling `.msg-quote`'s hidden state and
flips a "Visa citerad historik" / "Dölj" label. Must not clash with the
per-message `data-collapse` or per-thread `data-thread-toggle` handlers.

### 4. Minimal thread rows — `src/dashboard-views.js` `renderThreadGroups` + `threadPreview`
Rebuild each collapsed thread header as one dense line:
- **Left:** participants + count — counterparty display name, `, jag` appended
  when the thread has ≥1 outbound message, then ` · N` (message count). Bold
  when the thread has a pending escalation (the "unread"-like weight).
- **Middle:** subject of the latest message with `Re:`/`Sv:`/`SV:`/`VB:`/`Fwd:`
  prefixes stripped, then ` — ` + the latest message's LLM summary
  (`parseJsonSafe(latest.analysis_json)?.summary`), falling back to the raw
  90-char quote-stripped snippet (`splitQuotedText(...).visible`) for outbound /
  no-analysis messages. One line, ellipsis-truncated (CSS), never wraps.
- **Right:** latest message date. Sort thread groups by the latest message
  `received_at` DESC (latest on top) — robust regardless of thread ordering.
- **Removed from the row:** the inline full email address and the
  `★ primary`/`mute` controls. Move `threadStatusControls` into a small toolbar
  at the TOP of the expanded thread body. Show a subtle `★` on the row only when
  `status === 'primary'`; keep the existing muted-thread dimming.
- `threadPreview` returns the pieces the row needs (participants string, count,
  subject, summary, date); keep it pure (takes `msgs`).

### 5. Consistency
`renderThreadGroups` / `threadMessage` are used by BOTH `renderKommunDetail`
(kommun page) and `renderCaseDetailPane` (Ärenden pane) — one change updates
both. The "Ogrupperat" orphan section keeps rendering (never hide messages).

## Constraints (non-negotiable)

- **No schema change**, **no data loss** — pure view/parse changes over existing
  fields (`body_text`, `analysis_json`, `subject`, `direction`, `received_at`).
- **Pure functions stay pure** — `splitQuotedText`, `threadPreview`,
  `threadMessage` take their inputs as args.
- `stripQuotedText`'s existing behaviour is preserved (refactor-only); its tests
  pass unchanged.
- **Update fixtures/tests first**, then code (project convention).
- **Subagent works offline only** — no live `data/pilot.db`, daemon, Gmail,
  Slack, Anthropic, or `pilot-*` runs. Pure-view + parser tests with fixtures.
- **Base:** reset the worktree onto the current `main` tip first
  (`worktree-stale-base`). Leave commits on a `gmail-thread-view` branch; the
  operator integrates + restarts.
- Full offline `npm test` green.

## Testing (offline)

- `splitQuotedText`: splits at the leading-date Gmail-sv attribution
  (`12 juni 2026 kl. 13:13 skrev … <…>:`); at `On … wrote:`; at
  `-----Ursprungligt/Original Message-----`; `>`-quoted lines → `quoted`; a body
  with no quote → `{ visible: whole, quoted: '' }`; signature stays in
  `visible`. `stripQuotedText(x) === splitQuotedText(x).visible` for each case;
  existing classifier/closer tests untouched and green.
- `threadPreview`: uses `analysis_json.summary` when present; falls back to a
  raw quote-stripped snippet for an outbound/no-analysis latest message;
  participants append `, jag` only with an outbound message; count + latest date
  correct.
- `renderThreadGroups`: header is one line WITHOUT the email address or
  `mute`/`make primary` controls; subject prefix stripped; `★` only when
  primary; groups sorted latest-first; status control appears inside the
  expanded body.
- `threadMessage`: renders `visible`; a message with quoted history hides the
  tail behind a `···` toggle (`.msg-quote` hidden by default); a message with no
  quote has no toggle; signature line remains visible.

## Out of scope

- Any change to ingest, matching, or the LLM prompts.
- Persisted per-message "clean body" (kept as a read-time split).
- Autosvar handling and bounce wiring (separate specs).
