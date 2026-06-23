# Trustworthy Single Next-Action per Case — Design (Autopilot Foundation)

**Date:** 2026-06-23
**Status:** Draft for review
**Scope:** `src/conversation.js`, `src/tick.js`, `src/storage.js`, `src/dashboard.js`, `src/dashboard-views.js`. No external-service changes.

## Why

The end goal is for this tool to run on **autopilot** — the daemon advances each case correctly with the human dashboard as oversight, not as a required click on every message. Two problems block that today, both seen in the live pilot data:

1. **A case can accumulate multiple conflicting "next actions."** Ale (`1440/central`) has **two open escalation drafts**, both addressed to `kansli@ale.se`: a `delivery` acknowledgement ("Re: Handlingar") and an `unknown` recipient-confirmation ("Re: Fw: Avtal"). They came from two inbound emails that arrived in the same minute; the daemon opened one escalation per email with no awareness of the other. Sending both would double-message the kommun with contradictory content. A bot must **never** do this.

2. **The dashboard presents derived statuses as truth even when the pipeline is dead.** `Behöver dig` / `Klart` / `Avtal kommer in` / `försenad 4d` are all computed from DB state that only advances when the daemon **successfully** ticks (reaches Gmail, classifies inbound). With the daemon off — or up but failing on `invalid_grant`, which is the current state — the DB is frozen at the last good tick, yet the UI shows those labels with full confidence. The operator can't tell stale state from current state.

Neither can be tolerated on autopilot, and both undermine trust now.

## Goals

- **Invariant: at most one open "next action" (escalation) per conversation.** Always.
- Co-arriving inbound on the same conversation produce **one** coherent reply, not one per email.
- A stronger classification **supersedes** a weaker one rather than coexisting.
- The dashboard **never presents stale derived state as current truth**; staleness is loud and tied to a *successful* tick.
- Keep everything server-rendered, offline-testable, no new dependencies.

## Non-goals

- Full autopilot (auto-send of replies) — out of scope here; this is the *foundation* that makes it safe. Manual approval (Skicka) remains the send trigger for now.
- Changing the LLM classifier itself or the email templates.
- The Wait / Nästa-steg operator levers — specified here as **Phase 2** (built on this foundation), not Phase 1.

## Architecture

### Phase 1 — Single next-action invariant (the core fix)

**Classification precedence.** Define an explicit ordering so the system can pick a winner when a conversation has competing signals (existing classes from `nextActionForClassification`):

```
delivery > clarification > delay_promise > auto_ack > handoff > dead_end > unknown
```

`delivery` and `clarification` are concrete, actionable signals; `unknown` is the weakest fallback. (Ale: `delivery` beats `unknown` → the acknowledgement wins, the recipient-confirmation is dropped.)

**Collapse co-arriving inbound (`src/tick.js`).** When a tick fetches multiple inbound messages for the *same conversation*, process them as a group: pick the highest-precedence classification, drive one state transition, and create **one** draft. The lower-precedence messages are still recorded (so the thread is complete) but do not each spawn an escalation.

**Supersede on new signal (`src/tick.js` + `src/storage.js`).** Before opening a new escalation for a conversation, resolve any existing `open` escalation on it as **`status='superseded'`** (no schema change — `resolveEscalation(id, {status})` already takes an arbitrary status). Net effect: a conversation holds at most one open draft; the newest/strongest action replaces the stale one.

**Hard guard (`src/tick.js` + `src/dashboard.js` send path).** Assert the invariant at two choke points: (a) the daemon refuses to open a second open escalation on a conversation (supersede first); (b) the dashboard's `POST /escalations/:id` re-checks `status='open'` immediately before sending (it already does) and additionally refuses if a *newer* open escalation exists for the same conversation.

**One-time cleanup.** A small idempotent step (in `04-patch-data.js` style, or a guarded migration) that, for every conversation with >1 open escalation, keeps the highest-precedence/newest one and marks the rest `superseded`. Fixes the existing Ale case.

### Phase 1 — Freshness honesty (the trust fix)

**Track last *successful* tick (`src/storage.js`, `src/daemon.js`).** `recordHeartbeat` already stores ticks with an `error` field. Add a derived read `getTickHealth()` → `{ last_success_at, last_error, stale }` where `last_success_at` is the most recent heartbeat with `error IS NULL`, and `stale = (now - last_success_at) > THRESHOLD` (default 60 min, same band as the existing pill) or no success ever.

**Surface it (`src/dashboard-views.js`).** When `stale`:
- Render a **prominent banner** in the content region (not just the small sidebar pill): `⚠️ Data kan vara inaktuell — inkommande mejl har inte bearbetats sedan <datum>. Statusarna nedan visar senast kända läge.` Include the cause when known (`invalid_grant` → "Gmail-token måste förnyas: kör `npm run pilot-auth`").
- **Visually qualify derived statuses** while stale: status badges and the "Behöver dig" framing get a muted/`senast känt`-treatment (e.g. reduced opacity + a `(ej verifierat)` title) so they don't read as current truth.
- The sidebar heartbeat pill keys off `getTickHealth().stale` (successful tick), not "any tick ran," so a daemon that's up but failing on Gmail shows **red**, not green.

### Phase 2 — Wait / Nästa-steg operator levers (built on the invariant)

Once a conversation provably has one next-action, the manual levers are safe and simple (full design carried from the prior brainstorm):

- **Nästa steg** (case detail): compute the next template for the case's state (`nextStepTemplate(state)` — extracted, shared with the daemon), render it via a shared `buildStepDraft`, and record it as the single open escalation (superseding per Phase 1). The existing reply box then shows it for review + Skicka. Hidden for terminal cases and when an open escalation already exists.
- **Wait** (case detail): `POST /conversations/:id/snooze {until}` sets `follow_up_at` to a chosen date (presets +3 dagar / +1 vecka / +2 veckor / eget datum). `staleAction` already suppresses drafting until `follow_up_at`. Add a nullable `follow_up_source` column so a manual snooze (blue, "väntar — du valde detta") is shown distinctly from a kommun-promised date (green) and a default nudge (red); `effectiveFollowUp` treats a null source on an existing `follow_up_at` as `kommun_promise` for backward compatibility.

## Data flow

Unchanged ingestion; the changes are: tick groups inbound per conversation and supersedes stale drafts before creating a new one; storage gains `getTickHealth()` (read-only) and (Phase 2) a `follow_up_source` column; the dashboard reads `getTickHealth()` to gate status presentation and (Phase 2) gains snooze/next-step routes.

## Error handling

- Supersede is best-effort and idempotent: resolving an already-resolved escalation is a no-op.
- If precedence can't pick a winner (tie), keep the **newest** message's draft.
- Freshness banner degrades safely: if `getTickHealth()` throws or the heartbeat table is empty, treat as **stale** (fail toward honesty, never toward false confidence).
- Dashboard send guard returning "a newer draft exists" redirects back to the case showing the current single draft, never an error page.

## Testing (all offline)

- `conversation.js`: precedence ordering is a pure function — table-test each pair.
- `tick.js`: two inbound (delivery + unknown) on one conversation → exactly one open escalation, and it's the `delivery` one (regression test for the Ale bug); a new escalation supersedes a prior open one.
- `storage.js`: `getTickHealth()` — success/stale/never cases against seeded heartbeats.
- `dashboard`: stale health → banner present + statuses carry the qualified markup; healthy → no banner. Send guard refuses when a newer open escalation exists.
- Cleanup step: conversation with 2 open escalations → 1 open + 1 superseded, highest-precedence kept.

## Rollout

Phase 1 first (correctness + trust; fixes Ale immediately via the cleanup step), Phase 2 (operator levers) after. Single branch, no env changes; the cleanup step runs once against `data/pilot.db`.
