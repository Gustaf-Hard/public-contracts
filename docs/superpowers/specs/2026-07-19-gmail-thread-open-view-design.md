# Gmail "open the thread" view — flat thread list + focused thread page

**Date:** 2026-07-19
**Status:** approved, ready for implementation

## Problem

The kommun page shows conversations as `Ärende #N` cards with inline
accordion thread rows that expand in place. The operator wants Gmail's model:
a **flat list of all the kommun's threads** (newest first), and **clicking a
thread opens it on its own focused page** (full width, back link) rather than
expanding inline — with Gmail's visual design (clean rows, red PDF attachment
badges, hover).

## Decisions (from the operator)

- **Open model:** a **dedicated thread page at a URL** (`/kommun/:kod/trad/:threadId`)
  — browser back works, URL is shareable. Not an in-page swap.
- **List shape:** one **flat list of all the kommun's threads**, newest first,
  regardless of which Ärende they belong to; the Ärende/roll shows as a small
  tag on each row.
- **Gmail styling:** clean list rows with hover, red **PDF** attachment badges,
  sender/participants + subject — summary + date; focused page laid out like an
  opened Gmail conversation.

## Design

### 1. Flat thread list — `renderKommunDetail` main column (`src/dashboard-views.js`)
Replace the per-Ärende `convCards` (with inline `renderThreadGroups`
accordions) with a single flat Gmail-style thread list built from ALL threads
across the kommun's conversations:
- Gather `{ thread, conv, msgs }` for every thread; sort by latest message
  `received_at` DESC (newest first).
- New `renderThreadList(rows, { kommunKod })` → a list where each row is an
  anchor to `/kommun/:kod/trad/:threadId`. Row content (reuse `threadPreview`):
  participants (`Name, jag · N`), subject (Re:/Sv:/VB:/Fwd: stripped) — LLM
  summary, date on the right, the attachment chips strip (existing
  `renderThreadAtts`), and a small muted **Ärende-tag** (`#<convId> · <roll>`).
  A subtle `★` when `thread.status === 'primary'`; muted threads dimmed; a
  thread with an OPEN escalation gets a clear **"behöver åtgärd"** red weight +
  marker so the operator can find it.
- Keep `initialDraftCards` (conversations with no thread yet → compose CTA) and
  `contractsSection` (Mottagna dokument) on the kommun page, below the list.
- **Orphan messages** (`thread_id` null, pre-backfill) must never vanish:
  render them in a small always-visible "Ogrupperat" section on the kommun page
  (inline, as today) — they have no thread id to link to.

### 2. Focused thread page — new route + view
- `GET /kommun/:kommun_kod/trad/:threadId` (`src/dashboard.js`): load the thread,
  its conversation (verify it belongs to `:kommun_kod`), its messages (ordered),
  attachments, signatures, and its open escalations. Unknown thread / mismatched
  kommun → 404 landing on the kommun page.
- `renderThread({ kommun, conv, thread, messages, attachmentsByMsg, signatures, escalations, gmailReady, … })`
  (`src/dashboard-views.js`): a focused, Gmail-like conversation view —
  - Header: **← back to `<Kommun>`**, the subject, a context line
    (`Ärende #N · roll · counterparty`), thread status controls
    (`threadStatusControls`).
  - The thread's messages via the existing `threadMessage` (latest expanded,
    quoted-history collapse, attachment links) — unchanged.
  - **The thread's open escalation reply forms** via the existing
    `renderEscalationForm` (so the operator approves/sends here). The returnTo is
    the focused thread URL.
- The kommun page and the Ärenden pane both keep working; this route is a new
  surface.

### 3. Gmail styling (`src/dashboard-views.js` CSS)
- Thread-list rows: full-width rows with a bottom separator, hover background,
  sender in `--fg`, subject bold-ish then muted summary, date right. Reuse the
  theme vars (light/dark). Red **PDF** badge on attachment chips
  (`.thread-att-kind` → a red pill for PDFs: white text on a Gmail-ish red,
  e.g. `#d93025`), other files keep the 📎 glyph.
- Focused page: comfortable message spacing, sender line, date right — mirror
  the current `threadMessage` look, just full-width without the accordion.

### 4. Safety — escalations stay reachable + the send path is untouched
- **Every open escalation remains actionable.** Thread-tied escalations render
  their reply forms on the focused thread page; the flat-list row for such a
  thread is marked "behöver åtgärd" so it is easy to find.
- **Ungrouped escalations** (no `thread_id` and no counterparty match — legacy)
  must NOT disappear: surface them in a **"Behöver åtgärd"** section on the
  kommun page (list each with its reply form or a link), exactly as reachable as
  before.
- `renderEscalationForm`, `sendApprovedReply`, and all POST actions
  (`/threads/:id/status`, escalation resolve/send) are **unchanged** — this is a
  presentation/navigation change only. Do not touch the send-safety path.

## Constraints (non-negotiable)

- **No schema change, no data loss.** Pure view/route changes over existing
  data. No message or escalation may become unreachable — verify orphan messages
  and ungrouped escalations still render.
- **Pure view functions stay pure** — `renderThreadList` / `renderThread` take
  data via params; only the route reads the DB.
- **Send-safety invariants preserved** (CLAUDE.md) — escalation forms + approved
  send path unchanged.
- **Update fixtures/tests first**, then code.
- **Subagent works offline only** — pure-view + injected-fake tests, temp DBs
  for any route-level test; no live `data/pilot.db`, daemon, Gmail, Slack,
  Anthropic, or `pilot-*` runs.
- **Base:** reset the worktree onto the current `main` tip first
  (`worktree-stale-base`). Leave commits on a `gmail-thread-open-view` branch;
  the operator integrates + restarts.
- Full offline `npm test` green.

## Testing (offline)

- `renderThreadList`: rows are anchors to `/kommun/:kod/trad/:threadId` (NOT
  accordion toggles — no `data-thread-toggle`); sorted newest-first; Ärende tag
  present; attachment chips present; `★` only when primary; a thread with an
  open escalation is marked "behöver åtgärd"; orphan messages still render in an
  "Ogrupperat" section.
- `renderThread`: renders the back link, subject, the thread's messages
  (`threadMessage`), and the open escalation reply form(s); a muted/primary
  status control is present.
- Route `GET /kommun/:kod/trad/:threadId` (temp DB): 200 with the thread for a
  valid id; 404-landing for an unknown id or a thread whose conversation is a
  different kommun.
- Regression: an ungrouped escalation still appears on the kommun page
  ("Behöver åtgärd"); the send/approve POST path is unchanged (existing
  send-reply tests untouched and green).

## Out of scope

- Applying the flat-list/open model to the `/arenden` pane (keep it as-is for
  now).
- Realtime/unread state, labels, or Gmail's left-nav.
- Any change to ingest, matching, analysis, or send logic.
