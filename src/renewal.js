// Pure groundwork for the perpetual-refresh loop (autopilot review §7).
// NOT wired to the DB or the tick: the full loop needs schema (request
// generations, contracts.supersedes_contract_id) and is deferred. This module
// only answers the pure question: given what we know, which renewal requests
// are due?
//
// Rules from the review:
//  - one renewal request per kommun BATCH, not one per expiring contract
//    (rate control — the refresh loop multiplies send volume permanently);
//  - only contracts expiring within the horizon (default 60 days) or expired
//    within a short grace window are candidates. The live dataset contains
//    historical contracts expiring back in 2014 — asking for the successor of
//    a decade-old contract is noise, so old expiries are excluded.

function dayDiff(fromIso, now) {
  const t = new Date(fromIso + (fromIso.includes('T') ? '' : 'T00:00:00Z')).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 86400000);
}

// contracts: [{ id, kommun_kod, kommun_namn, vendor_name, period_end, is_contract }]
// Returns one draft per kommun: [{ kommun_kod, kommun_namn, contracts: [{ id, vendor_name, period_end }] }],
// soonest-expiring kommun first, contracts within a kommun sorted by period_end.
export function nextRenewalDrafts(contracts, { now, horizonDays = 60, graceDays = 90 } = {}) {
  if (!now) throw new Error('nextRenewalDrafts requires an explicit now');
  const byKommun = new Map();
  for (const c of contracts ?? []) {
    if (!c || !c.is_contract || !c.period_end || !c.kommun_kod) continue;
    const d = dayDiff(c.period_end, now);
    if (d === null) continue;
    if (d > horizonDays) continue;   // expires too far out
    if (d < -graceDays) continue;    // historical — not a live renewal target
    if (!byKommun.has(c.kommun_kod)) {
      byKommun.set(c.kommun_kod, { kommun_kod: c.kommun_kod, kommun_namn: c.kommun_namn ?? null, contracts: [] });
    }
    byKommun.get(c.kommun_kod).contracts.push({
      id: c.id, vendor_name: c.vendor_name ?? null, period_end: c.period_end,
    });
  }
  const drafts = [...byKommun.values()];
  for (const d of drafts) d.contracts.sort((a, b) => a.period_end.localeCompare(b.period_end));
  drafts.sort((a, b) => a.contracts[0].period_end.localeCompare(b.contracts[0].period_end));
  return drafts;
}
