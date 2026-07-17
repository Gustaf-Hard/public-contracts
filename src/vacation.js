// Vacation mode (2026-07-17 design) — PURE, no I/O.
//
// Swedish municipalities are largely closed 15 Jun – 30 Jul (semester).
// Silence during that window is normal, so the staleness machinery must not
// escalate then, nor count the window toward staleness. This module is pure:
// callers pass the resolved `cfg` in; only the daemon/dashboard read the
// overrides file. The window is month-day only (year-agnostic), so it applies
// to every summer without edits.

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  start: '06-15', // MM-DD, inclusive
  end: '07-30',   // MM-DD, inclusive
});

export function defaultVacationConfig() {
  return { ...DEFAULT_CONFIG };
}

// Merge an overrides blob (data/pilot-overrides.json shape) with the default
// window. Absent config → the default window, enabled.
export function resolveVacationConfig(overrides) {
  const v = overrides?.vacation ?? {};
  return {
    enabled: v.enabled ?? DEFAULT_CONFIG.enabled,
    start: v.start ?? DEFAULT_CONFIG.start,
    end: v.end ?? DEFAULT_CONFIG.end,
  };
}

// True when the YYYY-MM-DD `iso` date falls inside the vacation window
// (inclusive both ends). The window never wraps year-end here; we guard by
// requiring start <= end (month-day). `enabled: false` → always false.
export function isInVacation(iso, cfg = defaultVacationConfig()) {
  if (!cfg?.enabled) return false;
  if (typeof iso !== 'string' || iso.length < 10) return false;
  const md = iso.slice(5, 10); // MM-DD
  const { start, end } = cfg;
  if (start > end) return false; // wrapping window — not supported / not used here
  return start <= md && md <= end;
}

// Count of whole days in the half-open span [then, now) that fall inside any
// yearly vacation window. Spans multiple summers correctly (a conversation
// quiet from May 2026 to Aug 2027 counts both windows). `enabled: false` → 0.
export function vacationDaysBetween(thenIso, nowIso, cfg = defaultVacationConfig()) {
  if (!cfg?.enabled) return 0;
  if (typeof thenIso !== 'string' || typeof nowIso !== 'string') return 0;
  const then = Date.parse(thenIso.slice(0, 10) + 'T00:00:00Z');
  const now = Date.parse(nowIso.slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(then) || Number.isNaN(now) || now <= then) return 0;
  let count = 0;
  for (let t = then; t < now; t += DAY_MS) {
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isInVacation(iso, cfg)) count++;
  }
  return count;
}
