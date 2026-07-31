// Pure collection-velocity facts: how fast avtal are actually arriving.
// No IO, no DB — callers pass stored rows in (same rule as vendor-kb.js).
// Every figure carries its own sample size; an empty sample is null, never 0,
// because "0 dagar" would read as instant. See
// docs/superpowers/specs/2026-07-31-collection-velocity-design.md

const DAY_MS = 86400000;

// ISO week (Mon-Sun) of an instant, plus the date its Monday falls on.
export function isoWeek(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;                 // Mon=0 … Sun=6
  const monday = new Date(d.getTime() - day * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  // ISO week number: the Thursday of this week decides the year.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.floor((thursday - jan1) / (7 * DAY_MS)) + 1;
  return {
    iso_week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`,
    week_start: monday.toISOString().slice(0, 10),
  };
}

export function median(nums) {
  const xs = [...nums].sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

// Whole days between two ISO instants. Negative spans (an inbound stamped
// before our first outbound) are dropped by the caller, never clamped to 0 —
// a fabricated zero would flatter the median.
function daysBetween(a, b) { return (new Date(b) - new Date(a)) / DAY_MS; }

function spanStats(rows, from, to, of) {
  const days = rows
    .filter((r) => r[from] && r[to])
    .map((r) => daysBetween(r[from], r[to]))
    .filter((d) => d >= 0);
  return {
    median: round1(median(days)),
    min: days.length ? round1(Math.min(...days)) : null,
    max: days.length ? round1(Math.max(...days)) : null,
    n: days.length,
    of,
  };
}

export function buildVelocityFacts({
  contractEvents = [], caseTimings = [], files = { total: 0, by_type: [] }, now,
} = {}) {
  // --- weeks: bucket, then fill the gaps so a silent stretch stays visible ---
  const byWeek = new Map();
  for (const e of contractEvents) {
    const { iso_week, week_start } = isoWeek(e.received_at);
    const w = byWeek.get(iso_week) ?? { iso_week, week_start, contracts: 0, kommuner: new Set() };
    w.contracts += 1;
    w.kommuner.add(e.conversation_id);
    byWeek.set(iso_week, w);
  }
  const ordered = [...byWeek.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const weeks = [];
  if (ordered.length) {
    let cursor = new Date(`${ordered[0].week_start}T00:00:00Z`);
    const last = new Date(`${ordered[ordered.length - 1].week_start}T00:00:00Z`);
    let cumulative = 0;
    while (cursor <= last) {
      const key = isoWeek(cursor.toISOString());
      const hit = byWeek.get(key.iso_week);
      cumulative += hit?.contracts ?? 0;
      weeks.push({
        iso_week: key.iso_week,
        week_start: key.week_start,
        contracts: hit?.contracts ?? 0,
        cumulative,
        kommuner: hit ? hit.kommuner.size : 0,
      });
      cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    }
  }

  // --- timings + funnel over CONVERSATIONS (not messages), so one chatty
  //     kommun cannot weight the median ---
  const contacted = caseTimings.filter((c) => c.first_outbound_at);
  const timings = {
    first_human_reply: spanStats(contacted, 'first_outbound_at', 'first_human_inbound_at', contacted.length),
    first_contract: spanStats(contacted, 'first_outbound_at', 'first_contract_at', contacted.length),
  };
  const funnel = {
    contacted: contacted.length,
    human_replied: contacted.filter((c) => c.first_human_inbound_at).length,
    delivered: contacted.filter((c) => c.first_contract_at).length,
  };

  // --- silent: contacted, no human reply yet, longest wait first ---
  const silent = contacted
    .filter((c) => !c.first_human_inbound_at)
    .map((c) => ({
      conversation_id: c.conversation_id,
      kommun_namn: c.kommun_namn,
      days_waiting: Math.floor(daysBetween(c.first_outbound_at, now)),
    }))
    .filter((c) => c.days_waiting >= 0)
    .sort((a, b) => b.days_waiting - a.days_waiting || String(a.kommun_namn).localeCompare(String(b.kommun_namn)));

  const by_type = files.by_type ?? [];
  const avtal = by_type.find((t) => t.document_type === 'avtal')?.n ?? 0;

  return { weeks, timings, funnel, silent, files: { total: files.total ?? 0, avtal, by_type } };
}
