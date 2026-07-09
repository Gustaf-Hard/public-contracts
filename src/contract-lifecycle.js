// Pure lifecycle resolution for the perpetual-refresh loop
// (2026-07-09-perpetual-contract-refresh-design.md §1).
//
// A collected contract is never "final": it has a real lifecycle, and
// `period_end` is not always the true end (auto-renewal and extension options).
// This module resolves ONE `next_review_date` per contract — the date at which
// the contract could actually change and we should re-contact the kommun.
//
// It is intentionally per-contract and pure: the soonest-across-a-kommun and
// dedup-newest-wins logic needs the full contract set and lives in the scan.

// Strict ISO YYYY-MM-DD validation. Anything else (nulls, "okänt", "vid behov",
// partial dates) is treated as absent so the caller degrades gracefully rather
// than crashing (design §5).
function validIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(t.getTime())) return null;
  // Guard against JS Date roll-over (e.g. 2026-02-30 → 2026-03-02).
  if (t.toISOString().slice(0, 10) !== s) return null;
  return t;
}

function addDaysIso(iso, days) {
  const t = new Date(iso + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

// Resolve a contract to its next_review_date (ISO YYYY-MM-DD) or null.
// Precedence: auto-renew (day after uppsägningsdag) → extension option → plain
// period_end. Unparseable lifecycle fields fall through to period_end; if
// nothing is usable, returns null (the contract is simply not armed).
export function computeNextReviewDate(contract, now) {
  if (!now) throw new Error('computeNextReviewDate requires an explicit now');
  if (!contract) return null;

  const periodEnd = validIsoDate(contract.period_end) ? contract.period_end : null;

  // 1. Auto-renewing: re-contact just after the last cancellation day, when
  //    the renew-vs-switch decision must be made. No cancellation date → the
  //    only signal we have is period_end.
  if (contract.auto_renews === true || contract.auto_renews === 1) {
    if (validIsoDate(contract.last_cancellation_date)) {
      return addDaysIso(contract.last_cancellation_date, 1);
    }
    return periodEnd;
  }

  // 2. Fixed + extension option: the option's end date is when it could change.
  if (validIsoDate(contract.extension_option_until)) {
    return contract.extension_option_until;
  }

  // 3. Plain fixed-term.
  return periodEnd;
}

const MS_PER_DAY = 86400000;

// Whole-day signed distance from `now` to an ISO date (positive = future).
function dayDiffFromNow(iso, now) {
  const t = new Date(iso + (iso.includes('T') ? '' : 'T00:00:00Z')).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((t - now.getTime()) / MS_PER_DAY);
}

// THE canonical "which contracts are due per kommun" function (finding 8).
// Both the arming (armRefresh) and the daily scan (runRefreshScan) resolve the
// review from this ONE place — there is no parallel fork, and the horizon/grace
// window is applied consistently so decade-old expiries (the live 2014 Tieto
// rows) are never armed.
//
// Steps:
//   1. Dedup per vendor, newest-wins by received_at — an Atea extension
//      supersedes an old expiring Atea row instead of double-triggering.
//   2. Resolve each surviving row's lifecycle review date (auto-renew /
//      extension option / plain period_end) via computeNextReviewDate.
//   3. Drop rows whose review date is more than `graceDays` in the past — a
//      contract that ended a decade ago is dead history, not a renewal target.
//   4. Return the soonest remaining review date, the vendor that drove it, and
//      ALL contracts sharing that soonest date (so T_UPDATE can name them).
//
// The upper `horizonDays` bound is NOT applied here: firing is gated by
// next_review_at <= today in listConversationsDueForRefresh, so a far-future
// review is simply "not due yet" rather than discarded (which would lose the
// arming entirely). It is accepted as an option for callers that want the
// batch-draft semantics (renewal.nextRenewalDrafts).
//
// rows: [{ id, vendor_name, period_end, received_at, is_contract, auto_renews,
//          last_cancellation_date, extension_option_until }]
// Returns { date, source, contracts: [{ vendor_name, period_end }] }.
export function computeKommunReview(rows, now, { graceDays = 90, horizonDays = null } = {}) {
  if (!now) throw new Error('computeKommunReview requires an explicit now');
  const sorted = [...(rows ?? [])].sort((a, b) =>
    String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')));
  const newestByVendor = new Map();
  for (const r of sorted) {
    if (r.is_contract === 0) continue;
    const key = (r.vendor_name ?? `__id${r.id}`).toLowerCase();
    if (!newestByVendor.has(key)) newestByVendor.set(key, r); // first = newest (received_at DESC)
  }

  const dated = [];
  for (const r of newestByVendor.values()) {
    const date = computeNextReviewDate(r, now);
    if (!date) continue;
    const diff = dayDiffFromNow(date, now);
    if (diff === null) continue;
    if (diff < -graceDays) continue;            // dead history — never a renewal target
    if (horizonDays != null && diff > horizonDays) continue; // caller-requested upper bound
    dated.push({ row: r, date });
  }
  if (dated.length === 0) return { date: null, source: null, contracts: [] };

  dated.sort((a, b) => a.date.localeCompare(b.date));
  const soonest = dated[0].date;
  const atReview = dated.filter((d) => d.date === soonest);
  return {
    date: soonest,
    source: atReview[0].row.vendor_name ?? null,
    contracts: atReview.map((d) => ({ vendor_name: d.row.vendor_name ?? null, period_end: d.row.period_end ?? null })),
  };
}
