// Multi-kommun BATCH view for the perpetual-refresh loop (§7 groundwork).
// Finding 8: this shares the ONE canonical lifecycle primitive
// (computeNextReviewDate in contract-lifecycle.js) with the arming/scan path —
// there is no second, divergent "when does a contract come due" implementation.
// It differs only in SELECTION: the arming path picks the single soonest review
// to fire ONE T_UPDATE, whereas this batch snapshot lists EVERY contract whose
// review lands inside the horizon, one draft per kommun. The dedup-newest-wins,
// grace-window and lifecycle (auto-renew / extension option) rules are the
// shared function's; only the "all within horizon vs. just the soonest" framing
// lives here.
//
// Rules from the review:
//  - one renewal request per kommun BATCH, not one per expiring contract
//    (rate control — the refresh loop multiplies send volume permanently);
//  - only contracts whose review is within the horizon (default 60 days) or
//    expired within the grace window are candidates. The live dataset contains
//    historical contracts expiring back in 2014 — old expiries are excluded.

import { computeNextReviewDate } from './contract-lifecycle.js';

function dayDiff(iso, now) {
  const t = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00Z')).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / 86400000);
}

// contracts: [{ id, kommun_kod, kommun_namn, vendor_name, period_end, is_contract, ... }]
// Returns one draft per kommun: [{ kommun_kod, kommun_namn, contracts: [{ id, vendor_name, period_end }] }],
// soonest-expiring kommun first, contracts within a kommun sorted by review date.
export function nextRenewalDrafts(contracts, { now, horizonDays = 60, graceDays = 90 } = {}) {
  if (!now) throw new Error('nextRenewalDrafts requires an explicit now');
  const byKommun = new Map();
  for (const c of contracts ?? []) {
    if (!c || !c.kommun_kod) continue;
    if (!byKommun.has(c.kommun_kod)) byKommun.set(c.kommun_kod, []);
    byKommun.get(c.kommun_kod).push(c);
  }

  const drafts = [];
  for (const [kommun_kod, rows] of byKommun.entries()) {
    // Dedup per vendor newest-wins (received_at DESC), then resolve each via the
    // shared lifecycle primitive and keep only reviews inside the window.
    const sorted = [...rows].sort((a, b) =>
      String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')));
    const newestByVendor = new Map();
    for (const r of sorted) {
      if (!r.is_contract) continue;
      const key = (r.vendor_name ?? `__id${r.id}`).toLowerCase();
      if (!newestByVendor.has(key)) newestByVendor.set(key, r);
    }
    const picked = [];
    for (const r of newestByVendor.values()) {
      const review = computeNextReviewDate(r, now);
      if (!review) continue;
      const d = dayDiff(review, now);
      if (d === null || d > horizonDays || d < -graceDays) continue;
      picked.push({ id: r.id, vendor_name: r.vendor_name ?? null, period_end: r.period_end ?? null, _review: review });
    }
    if (!picked.length) continue;
    picked.sort((a, b) => a._review.localeCompare(b._review));
    drafts.push({
      kommun_kod,
      kommun_namn: rows[0].kommun_namn ?? null,
      contracts: picked.map(({ _review, ...c }) => c),
      _soonest: picked[0]._review,
    });
  }
  drafts.sort((a, b) => a._soonest.localeCompare(b._soonest));
  return drafts.map(({ _soonest, ...d }) => d);
}
