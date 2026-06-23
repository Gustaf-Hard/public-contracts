# Pilot Dashboard Redesign — Design

**Date:** 2026-06-17
**Status:** Approved (design); implementation plan pending
**Scope:** `src/dashboard.js`, `src/dashboard-views.js` (+ a thin new client-side asset and partial routes). No data-pipeline changes.

## Problem

The pilot dashboard is the tool an operator sits in all day to run the *offentlighetsprincipen* request pilot: triage incoming kommun replies, approve/edit the AI-drafted responses, clear escalations, and watch which cases are stalling. As built it does not support that:

1. **The Overview buries the cases that matter.** It defaults to "Alla (290)" and lists every kommun alphabetically; the handful of active pilot cases are scattered among ~286 empty "ej kontaktad" rows. Finding today's work means scrolling a 290-row table.
2. **Every page dumps full content inline.** Kommun detail renders the entire email thread with all message bodies expanded (a screen-and-a-half per case). Escalations stack full editable textareas (three escalations fills the page).
3. **Raw debug text leaks into the UI.** Escalations show `llm intent=handoff action=escalate confidence=0.92` — a log line, not a product.
4. **Disruptive full-page `<meta refresh content="30">`** resets scroll position and would discard a half-typed reply.
5. **Flat visual hierarchy** — everything is the same weight; nothing guides the eye to the next action.

## Goals

- Make the next action obvious and reachable without scrolling.
- Reduce scrolling and progressive-disclosure friction ("hidden stuff") across all views.
- A professional, calm, consistent visual design suitable for all-day use.
- Preserve the codebase ethos: server-rendered HTML, no framework, no build step. Introduce only a *thin* layer of hand-written vanilla JS.
- Keep the test suite green; view functions keep returning HTML strings.

## Non-goals

- No changes to the data pipeline, daemon logic, Gmail/Slack integration, or DB schema.
- No SPA framework, bundler, or TypeScript.
- Not redesigning the seed/discover/verify CLI stages.

## Chosen approach

A **master–detail app shell** with a **calm light theme** (indigo accent) and a **dark toggle**, and a **split home**. Server-rendered pages remain the source of truth and every entity keeps a real URL; a thin vanilla-JS layer intercepts navigation to swap the content/detail pane via `fetch` + the History API (progressive enhancement — links and forms still work with JS off), and runs a quiet background poll that replaces the full-page meta-refresh.

Approaches considered and rejected:
- *Polished multi-page, no JS* — lower risk but keeps full-page reloads and can't deliver the "never lose your place" feel for all-day use.
- *SPA framework* — overkill, breaks the no-build-step ethos, large rewrite.

## Architecture

### App shell (persistent)
A slim **left sidebar** replaces the top `<header>` nav. Items: Översikt · Ärenden · Eskaleringar (live count badge) · Leverantörer · Aktivitet. Pinned bottom: daemon heartbeat pill, light/dark toggle, clock. The sidebar is rendered once in `layout()`; only the content region is swapped on navigation.

### Routing & partials
Existing full-page routes are retained for direct navigation / no-JS / refresh:
`/`, `/kommun/:kod`, `/kommun/:kod/compose`, `/escalations`, `/activity`, `/leverantorer`, `/leverantor/:slug`, plus the POST actions (`/escalations/:id`, `/conversations/:id/close`, `/conversations/:id/reopen`, `/kommun/:kod/init`).

New: each pane-swappable view also responds to a **partial request** (e.g. `?partial=1` or an `X-Partial` header) by returning just the inner HTML fragment (the content region) instead of the full `layout()`. The client JS fetches the partial, swaps `#content`, and `history.pushState`s the canonical URL. A normal (non-JS) request to the same URL returns the full page. This is the one mechanism that powers all master–detail swapping; render functions are unchanged, `layout()` gains a `partial` branch.

### Client JS (thin, hand-written, no build)
A single static `public/app.js` served by Express, plus a tiny inline bootstrap. Responsibilities, in order of importance:
1. **Pane navigation:** intercept clicks on `[data-pane-link]`, fetch the partial, swap `#content`, push history; handle back/forward via `popstate`.
2. **Form submits in place:** intercept `[data-pane-form]` (send reply, skip, close, reopen, init), POST via fetch, swap the affected pane with the returned partial.
3. **Collapse/expand:** message bodies collapsed by default; toggle on click. (Native `<details>` where it suffices; JS only where layout needs it.)
4. **Quiet poll:** every ~30s fetch the list pane / counts and update badges and list rows — **never** mutating the open detail pane or any element with focus (guards against clobbering a half-typed reply). Replaces `<meta refresh>`.
5. **Theme toggle:** flips `[data-theme]` on `<html>`, persists to `localStorage`, applied before first paint by the inline bootstrap to avoid a flash.

If JS fails to load, everything degrades to full-page navigation — no dead ends.

### Views

**Home / Översikt (split, action-first)**
- Compact KPI band: the existing six stats in one tight row (not large cards).
- **"Behöver dig"** queue: only cases needing a human (open escalations to approve, replies to send, recipients to confirm). Row = kommun · role · the single next action · age. Click opens the case in the Ärenden detail pane.
- **"Pågår / väntar"**: open cases waiting on the kommun, with the follow-up countdown badge.
- **"Alla kommuner"**: the 290-list, searchable + filterable, **defaulting to contacted/active rows only**, with a "visa alla 290" toggle. Sorting preserved.

**Ärenden (master–detail core)**
- **List pane:** all cases (conversations = kommun+role) grouped by bucket — *Behöver dig · Öppna · Stängda* — each a compact line: status dot, kommun, role, intent, age. Current selection highlighted.
- **Detail pane:** context header (kommun · role · status badge · key dates · next step), a **collapsed timeline** (each message = one line: icon, direction, intent badge, summary, date; click expands the body), attachments as chips, and the **AI-drafted reply inline**, editable, with Skicka / Hoppa över / Stäng actions. This is where escalation handling happens.
- A link from the case header opens the full **kommun profile** (`/kommun/:kod`) — contacts, contracts, all that kommun's cases — retained and visually refreshed.

**Eskaleringar** folds into Ärenden as the "Behöver dig" filter; send/skip/edit live in the detail pane. The raw `intent=… action=… confidence=…` string becomes a clean badge with detail in a `title` tooltip. The `/escalations` URL still resolves (to the filtered Ärenden view) for compatibility.

**Leverantörer (master–detail)**: vendor list left; vendor detail right (products grouped as chips, contracts, and referencing kommuner). No wall of comma-separated tags.

**Aktivitet**: kept as a feed inside the shell; secondary surface.

### Design system
- Promote the existing CSS custom properties into a real token set: color (surfaces, text, borders, one indigo accent, calibrated status colors), a type scale, and a spacing scale.
- **Light is the default**; dark via `[data-theme="dark"]` on `<html>`, toggled and persisted client-side. Both themes share one set of component styles.
- Consistent components: card, badge/pill, button (primary/secondary/danger/disabled), table, list-row, timeline. Designed empty/zero states.
- Remove all debug text from the rendered UI.

## Data flow

Unchanged. `dashboard.js` reads `data/pilot.db` (via `openDb`) and `data/municipalities.json` (+ overrides), composes data objects, and calls the `render*` functions in `dashboard-views.js`. The redesign changes the HTML those functions emit and adds a `partial` rendering branch + static-asset serving; it does not change what data is read or how the daemon writes it.

## Error handling

- Partial fetch failure → client JS falls back to a full-page navigation to the same URL (no broken pane).
- Form POST failure → the returned/last pane is kept and an inline error shown; never a blank screen.
- Daemon-off / Gmail-not-ready states keep their existing affordances (heartbeat pill; send buttons disabled with reason) restyled into the new system.
- No-JS / JS-error → full server-rendered pages throughout.

## Testing

- Existing view tests keep asserting on returned HTML; update fixtures where markup/class names change, updating the fixture to the new live contract first (per repo convention) rather than loosening assertions.
- Add tests for the new `partial` rendering branch (full vs fragment output) and for the Home bucketing/queue logic (which cases land in "Behöver dig" vs "Pågår").
- Client JS is progressive enhancement; correctness is verified by the server-rendered fallback tests plus manual Playwright review.
- **Visual review loop:** after implementation, screenshot every view with Playwright at desktop width, critique against this spec, and iterate at least twice before requesting user review.

## Rollout

Single branch (current `feat/contract-viewer-and-vendors`). No migration, no env changes. The dashboard is launched the same way (`npm run pilot-dashboard`).
