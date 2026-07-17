# Vacation mode — don't nag kommuner over the Swedish summer

**Date:** 2026-07-17
**Status:** approved, ready for implementation

## Problem

Swedish municipalities are largely closed 15 Jun – 30 Jul (semester). Silence
during that window is normal, but the staleness machinery treats it as a
kommun going dark: `runDailyFollowup` computes `daysBetween(state_changed_at,
now)` and, once it crosses the 7/10/14-day `STALE_RULES` thresholds, mints
follow-up nudges and escalations. The result is a flood of escalations that
are just "it's summer". We want to allow slow responses, not escalate during
the window, and not let the window count toward staleness.

## Decisions (from the operator)

- **Pause only the staleness nudges** (the `runDailyFollowup` loop). Leave the
  perpetual contract-refresh scan (`runRefreshScan` / T_UPDATE) running as
  normal.
- **Always respond to real inbound.** A genuine incoming reply during the
  window still gets analysed, drafted, and escalated — that path is
  `runTick`, separate from `runDailyFollowup`, so it is untouched by design.
- **Clear the currently-open stale escalations now** — supersede the ones that
  are purely staleness-driven, leaving real-inbound escalations alone.

## Window definition

Annual, recurring every year, **15 Jun – 30 Jul inclusive**. Month/day only —
year-agnostic, so it applies to every summer without edits. Configurable via
`data/pilot-overrides.json`:

```json
"vacation": { "enabled": true, "start": "06-15", "end": "07-30" }
```

Absent config → the default window, enabled. `enabled: false` disables the
whole feature (clock counts normally, no gating, no banner).

## Design

### 1. `src/vacation.js` — pure, no I/O
- `isInVacation(iso, cfg)` → boolean. `iso` is a `YYYY-MM-DD` date; compares
  month-day against the window (inclusive both ends). Handles the window not
  wrapping year-end (it never does here, but guard `start <= end` by month-day).
- `vacationDaysBetween(thenIso, nowIso, cfg)` → integer count of whole days in
  the half-open span `[then, now)` that fall inside any yearly vacation window.
  Must span multiple summers correctly (e.g. a conversation quiet from May 2026
  to Aug 2027 counts both windows). Implement by walking days or by summing
  per-year window overlaps — either is fine; cover it with tests.
- `defaultVacationConfig()` and a `resolveVacationConfig(overrides)` that merges
  the override with the default. Keep the module pure: callers pass `cfg` in.
- If `cfg.enabled === false`: `isInVacation` → always false,
  `vacationDaysBetween` → always 0.

### 2. Wire config through (`src/pilot-config.js`, `src/daemon.js`)
`loadOverrides()` already reads `data/pilot-overrides.json`. Expose the resolved
vacation config (default-merged) so the daemon can pass it into the tick deps.
`runDailyFollowup` receives `cfg` via `deps` (follow the existing deps-injection
pattern used for `now`, `refreshAllowlist`, etc.). Do NOT read the file inside
the pure functions.

### 3. Don't count — discount the clock (`src/tick.js runDailyFollowup`)
Replace the raw staleness age with a discounted one:

```
const raw = daysBetween(new Date(conv.state_changed_at), now);
const vac = vacationDaysBetween(conv.state_changed_at.slice(0,10), todayIso, cfg);
const days = Math.max(0, raw - vac);
```

Pass `days` into `staleAction` exactly as today. `staleAction` stays pure and
unchanged. A conversation that went quiet before/into summer no longer accrues
stale days across the window.

### 4. Don't escalate — gate the loop (`src/tick.js runDailyFollowup`)
At the top of the per-conversation body, if `isInVacation(todayIso, cfg)`,
`continue` before drafting any nudge/escalation. This gates ONLY the proactive
staleness loop. `runTick` (real inbound) and `runRefreshScan` (T_UPDATE) are not
touched, honoring "always respond to real inbound" and "leave contract-refresh
running". Log once per tick that the daily loop is paused for vacation (guard
against per-conversation log spam).

### 5. Display honesty (`src/conversation.js`, `src/dashboard-views.js`)
- `effectiveFollowUp(conv)` computes the shown "Nästa kontakt" date as
  `state_changed + rule.days`. When that date lands inside the vacation window,
  push it to the day after the window ends (e.g. `07-31`) so the dashboard never
  shows a date it won't act on. `effectiveFollowUp` currently takes only `conv`;
  give it an optional `cfg` param (default = disabled/no-op) so existing callers
  and tests are unaffected unless they pass cfg. The dashboard route passes the
  resolved cfg.
- Add a muted banner on the dashboard when `isInVacation(today, cfg)`:
  **"☀️ Sommarläge — automatisk bevakning pausad t.o.m. 30 juli"**. Place it
  near the existing heartbeat/escalation-count header area.

### 6. Clear the existing stale escalations — supervised, NOT run by the subagent
- Add `supersedeStaleNudgeEscalations()` to `src/storage.js`: set
  `status = 'superseded'` on every escalation currently `status = 'open'` whose
  `classifier_class = 'followup_stale'`. That class tags every staleness-driven
  draft (nudge, close, and the escalated free-form) and nothing else, so
  real-inbound escalations are untouched. Return the count. Append-only query,
  no schema change.
- Add `scripts/09-clear-stale-escalations.js` that calls it and prints the
  count. The SUBAGENT writes and tests this (offline, temp DB) but MUST NOT run
  it against the live DB. The operator runs it supervised, backup-first.

## Constraints (non-negotiable)

- **Subagent works offline only** — temp/`:memory:` SQLite, injected fakes, no
  live `data/pilot.db`, daemon, Gmail, Slack, or Anthropic calls. Do NOT run
  `scripts/09*` or any `pilot-*` command.
- **No schema change.** Vacation logic is compute-only over existing columns
  (`state_changed_at`, escalation `status`/`classifier_class`).
- **No data loss.** Superseding is a status change on staleness-only rows;
  nothing deleted; real-inbound escalations preserved.
- **Pure functions stay pure** — `vacation.js`, `staleAction`,
  `effectiveFollowUp` take config as a parameter; only the daemon/dashboard read
  the file.
- **Base:** branch from the current `main` tip `7a9e755`; reset onto it first if
  the worktree snapshot is stale (see memory `worktree-stale-base`).
- Full `npm test` passes (offline). Do NOT commit to main / merge / open a PR —
  leave commits on a `vacation-mode` branch; the operator integrates.

## Testing

- `vacation.js`: window boundaries (14/15 Jun, 30/31 Jul), a date mid-window,
  outside; `vacationDaysBetween` across one summer, across two summers, zero
  when the span misses the window; `enabled:false` → 0 / always-false.
- `runDailyFollowup` with `now` injected: inside the window → no nudge created
  even for a long-stale conversation; just outside (1 Aug) → a conversation
  quiet since May is NOT instantly maxed out (its summer days were discounted).
- `effectiveFollowUp`: a follow-up date that would fall in the window is pushed
  past 30 Jul; one outside is unchanged; `enabled:false` unchanged.
- `supersedeStaleNudgeEscalations`: supersedes open `followup_stale`, leaves
  open real-inbound and already-terminal rows untouched; returns the count.

## Out of scope

- Pausing new first-time T-INITIAL outreach (operator chose to keep the refresh
  scan and only pause the staleness loop; initial sends already require the
  scheduled send + human approval).
- Any change to the perpetual contract-refresh scan.
