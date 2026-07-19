// src/resellers.js
// Framework-agreement and reseller channels. A kommun that procures via one
// of these can HAVE a product without us ever seeing a direct contract for
// it — the contract sits with the channel, not the product vendor:
//   - Adda (ex SKL Kommentus) — national ramavtal ("Digitala läromedel 2022")
//   - Skolon                  — edtech marketplace bundling many vendors
//   - Atea                    — licenspartner reselling e.g. Unikum, Skola24
//   - Läromedia               — bokhandel reselling licenses to schools
// The coverage matrices therefore must not paint a reseller-procuring kommun
// confidently red ("not sold here") for products reachable through the
// channel — the honest cell is "unknown (kan finnas via ramavtal)".
// Matching mirrors the watchlist (whole-word on ascii-folded names).
// Pure: no IO.

import { matchVendorEntries } from './watchlist.js';

// Each entry carries a stable `slug` (slugified canonical) so a ramavtal is a
// first-class entity with its own page at /ramavtal/:slug — "every ramavtal
// has a place in the tool" (2026-07-19 design).
export const RESELLERS = [
  { canonical: 'Adda',      slug: 'adda',      aliases: ['adda', 'skl kommentus', 'sklkommentus', 'kommentus'] },
  { canonical: 'Skolon',    slug: 'skolon',    aliases: ['skolon'] },
  { canonical: 'Atea',      slug: 'atea',      aliases: ['atea'] },
  { canonical: 'Läromedia', slug: 'laromedia', aliases: ['läromedia', 'laromedia', 'läromedia bokhandel örebro'] },
];

// Canonical names of reseller entries matched by any of `names`, deduped,
// in RESELLERS order.
export function matchResellers(names = []) {
  return matchVendorEntries(RESELLERS, names);
}

// Resolve a reseller/ramavtal by its slug. Pure; null for unknown/blank slugs.
export function resellerBySlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  return RESELLERS.find((r) => r.slug === slug) ?? null;
}
