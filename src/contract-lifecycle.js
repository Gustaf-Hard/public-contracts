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
