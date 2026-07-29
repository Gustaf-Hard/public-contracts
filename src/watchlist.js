// src/watchlist.js
// Strategically-sensitive vendors. When a delivery names one of these, the
// pipeline holds the draft and flags the escalation so the operator consciously
// authors the reply (see docs/superpowers/specs/2026-07-04-watchlist-vendor-confirmation-design.md).
// Pure: no IO.

import { COMPANIES, resolveCompany } from './vendor-kb.js';

// Watchlisted companies, canonical names — derived from the KB.
export const WATCHLIST = COMPANIES.filter((c) => c.watchlist).map((c) => ({ canonical: c.canonical, aliases: c.aliases }));

// Lowercase, ASCII-fold Swedish letters, punctuation→space, collapse whitespace.
function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Generic canonical-name matcher over `{ canonical, aliases }` entries —
// shared by the watchlist and the reseller/framework list (src/resellers.js).
// Returns the canonicals matched by any of `names`, deduped, in entry order.
// An alias matches only as a whole word on the normalized string, so short
// aliases (ne, ilt) never fire inside unrelated tokens.
export function matchVendorEntries(entries, names = []) {
  const normed = names.map(normalize).filter(Boolean);
  const matched = [];
  for (const entry of entries) {
    const hit = entry.aliases.some((alias) => {
      const a = normalize(alias);
      if (!a) return false;
      const re = new RegExp(`\\b${escapeRegExp(a)}\\b`);
      return normed.some((n) => re.test(n));
    });
    if (hit) matched.push(entry.canonical);
  }
  return matched;
}

// Canonical names of watchlisted companies matched by any of `names`, resolving
// products to their parent company (so "Magma" -> "Radish"). Returned in
// WATCHLIST (COMPANIES) order, deduped.
export function matchWatchlist(names = []) {
  const hitSlugs = new Set();
  for (const n of names) {
    const r = resolveCompany(n);
    if (r) hitSlugs.add(r.slug);
  }
  return COMPANIES.filter((c) => c.watchlist && hitSlugs.has(c.slug)).map((c) => c.canonical);
}
