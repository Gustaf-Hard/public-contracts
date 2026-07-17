import { readFileSync, existsSync } from 'node:fs';
import { resolveVacationConfig } from './vacation.js';

export function loadOverrides(path = 'data/pilot-overrides.json') {
  if (!existsSync(path)) throw new Error(`Pilot overrides not found at ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Resolved (default-merged) vacation window for the daemon/dashboard to inject
// into the tick deps. The pure vacation module never reads the file — this is
// the single wiring point that turns overrides into a cfg object.
export function resolveVacation(overrides) {
  return resolveVacationConfig(overrides ?? {});
}

export function resolveActiveKommuner(overrides, liveMunicipalities) {
  const active = overrides.active_pilot_kommun_kods ?? [];
  if (active.length === 0) return [];

  const rehearsalKods = new Set((overrides.rehearsal_kommuner ?? []).map((k) => k.kommun_kod));
  const hasRehearsal = active.some((k) => rehearsalKods.has(k));
  const hasLive = active.some((k) => !rehearsalKods.has(k));
  if (hasRehearsal && hasLive) {
    throw new Error('active_pilot_kommun_kods must not mix rehearsal (9999) with live kommuner');
  }

  const liveByKod = new Map(liveMunicipalities.map((m) => [m.kommun_kod, m]));
  const out = [];
  for (const kod of active) {
    if (rehearsalKods.has(kod)) {
      const r = overrides.rehearsal_kommuner.find((k) => k.kommun_kod === kod);
      out.push(r);
    } else {
      const live = liveByKod.get(kod);
      if (!live) throw new Error(`Active kommun_kod ${kod} not found in live municipalities`);
      out.push(live);
    }
  }
  return out;
}

export function isClockSkewAllowed(overrides) {
  const active = overrides.active_pilot_kommun_kods ?? [];
  if (active.length !== 1) return false;
  const rehearsalKods = new Set((overrides.rehearsal_kommuner ?? []).map((k) => k.kommun_kod));
  return rehearsalKods.has(active[0]);
}

// Perpetual-refresh pilot gating (2026-07-09 design §3.4). The refresh
// mechanism is general; only this allowlist limits which kommuner arm/trigger.
// Expanding later is a config edit to refresh_pilot_kommun_kods in
// data/pilot-overrides.json.
export function isRefreshAllowed(overrides, kommunKod) {
  const allow = overrides?.refresh_pilot_kommun_kods ?? [];
  return allow.includes(kommunKod);
}

export function getEffectiveNow({ env = process.env, overrides, baseNow = new Date() } = {}) {
  if (!isClockSkewAllowed(overrides)) return baseNow;
  const days = parseInt(env.PILOT_CLOCK_OFFSET_DAYS ?? '0', 10);
  if (!Number.isFinite(days) || days === 0) return baseNow;
  return new Date(baseNow.getTime() + days * 24 * 60 * 60 * 1000);
}
