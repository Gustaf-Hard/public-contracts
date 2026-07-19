// src/vendor-aliases.js
// Vendor-name normalization (2026-07-19-vendor-name-normalization-design).
//
// Vendor names arrive from two sources and duplicate heavily — the `vendors`
// table (contract analysis) and free-text `mentioned_vendors`. This module
// maps a raw vendor name to ONE canonical display name, read-time only:
// nothing here touches the DB, no rows are merged, no vendor_id is remapped.
// Fully reversible; callers apply it purely at aggregation/display.
//
// Conservative by design: an unknown name passes through UNCHANGED. A name is
// merged into a canonical ONLY when (a) it matches a hand-curated cluster
// variant, or (b) a mechanical suffix/genitive strip lands EXACTLY on a known
// canonical. No name is ever merged into a canonical it does not clearly
// belong to (see the §3 exclusions and their tests).
//
// Resellers (Adda/Skolon/Läromedia/Atea) stay owned by matchResellers — this
// module deliberately does NOT special-case them, so reseller matching is
// unaffected.
//
// Pure: no IO. KNOWN_CANONICALS is a static seed list (NO DB read).

// Normalize a raw name for case-insensitive lookup: trim + collapse internal
// whitespace. Casing is discarded for comparison only — a canonical keeps its
// OWN casing for output.
function normalizeForLookup(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

function lookupKey(name) {
  return normalizeForLookup(name).toLowerCase();
}

// §2 Curated cluster map (CONSERVATIVE seed — EXACTLY this, nothing more).
// canonical ← [variants]. Variants match case-insensitively on the normalized
// (trimmed, whitespace-collapsed) name.
export const VENDOR_CLUSTERS = Object.freeze([
  { canonical: 'Nationalencyklopedin', variants: ['NE', 'NE Nationalencyklopedin', 'Nationalencyklopedin'] },
  { canonical: 'Microsoft', variants: ['Microsoft', 'Microsoft 365'] },
  { canonical: 'Google', variants: ['Google', 'Google Workspace', 'Google Workspace for Education'] },
  { canonical: 'Skola24', variants: ['Skola24', 'Skola 24'] },
  { canonical: 'InfoMentor', variants: ['InfoMentor', 'Infomentor', 'Informentor'] },
  { canonical: 'Everway', variants: ['Everway', 'Ewerway'] },
  { canonical: 'Teachiq', variants: ['Teachiq', 'TeachIQ'] },
  { canonical: 'SchoolSoft', variants: ['SchoolSoft', 'Schoolsoft'] },
  { canonical: 'Oribi', variants: ['Oribi', 'Oribi Texthelp'] },
  { canonical: 'Insight', variants: ['Insight', 'Insight Technology Solutions'] },
  { canonical: 'Aleido Learning', variants: ['Aleido Learning', 'Aleido Learning Sweden'] },
  { canonical: 'Tempus', variants: ['Tempus', 'Tempus Information Systems', 'Tempus Information System'] },
  { canonical: 'Tietoevry', variants: ['Tietoevry', 'Tieto'] },
  { canonical: 'Inläsningstjänst (ILT)', variants: ['ILT', 'Inläsningstjänst', 'ILT Inläsningstjänst', 'ILT Education'] },
  { canonical: 'LäroMedia Bokhandel Örebro', variants: ['Läromedia Bokhandel Örebro', 'LäroMedia Bokhandel Örebro'] },
]);

// variant lookup key → canonical.
const CLUSTER_BY_VARIANT = new Map();
for (const { canonical, variants } of VENDOR_CLUSTERS) {
  for (const v of variants) CLUSTER_BY_VARIANT.set(lookupKey(v), canonical);
}

// Known canonicals: every cluster canonical PLUS a static seed of bare
// vendors-table names (from the spec's Problem/§2). Used ONLY as the target
// of the guarded mechanical strip — a stripped form is accepted as canonical
// only when it lands on one of these. NO DB read.
const KNOWN_CANONICAL_SEED = [
  // vendors-table names whose ` AB`/`Aktiebolag`/`Sverige`/genitive variants
  // should fold back onto the bare name (§2 parenthetical).
  'Nova Software',
  'Haldor',
  'IST',
  'StudyBee',
];

// The public set of KNOWN canonicals (cluster canonicals + seed), keyed by
// their lookup form → the canonical's OWN casing for output.
const KNOWN_CANONICAL_BY_KEY = new Map();
for (const { canonical } of VENDOR_CLUSTERS) KNOWN_CANONICAL_BY_KEY.set(lookupKey(canonical), canonical);
for (const c of KNOWN_CANONICAL_SEED) KNOWN_CANONICAL_BY_KEY.set(lookupKey(c), c);

// Introspection export: the display-cased set of all known canonicals.
export const KNOWN_CANONICALS = new Set(KNOWN_CANONICAL_BY_KEY.values());

// Trailing legal suffixes, longest first so " Sverige AB" strips before " AB".
const LEGAL_SUFFIXES = [' Sverige AB', ' Aktiebolag', ' Sverige', ' AB'];

// Strip candidates for the guarded mechanical rule: try each suffix, and a
// trailing genitive -s, and the combination. Each candidate is checked against
// the known-canonical set; the FIRST that matches wins. A candidate that
// matches nothing is inert.
function* strippedCandidates(normalized) {
  for (const suffix of LEGAL_SUFFIXES) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      yield normalized.slice(0, normalized.length - suffix.length).trim();
    }
  }
  // Genitive -s on the whole name (e.g. "Haldors" → "Haldor").
  if (/[A-Za-zÅÄÖåäöéüÉÜ]s$/.test(normalized)) {
    yield normalized.slice(0, -1);
  }
  // Suffix + genitive combinations (e.g. "Novas Software AB" is not a real
  // case, but "Haldors AB" → strip " AB" then genitive -s → "Haldor").
  for (const suffix of LEGAL_SUFFIXES) {
    if (normalized.toLowerCase().endsWith(suffix.toLowerCase())) {
      const base = normalized.slice(0, normalized.length - suffix.length).trim();
      if (/[A-Za-zÅÄÖåäöéüÉÜ]s$/.test(base)) yield base.slice(0, -1);
    }
  }
}

// Map a raw vendor name to its canonical display name. Algorithm (spec §1):
//   1. normalize for lookup (trim, collapse whitespace, case-insensitive);
//   2. curated cluster variant → that cluster's canonical;
//   3. guarded mechanical strip (legal suffix and/or genitive -s): if the
//      stripped normalized form equals a KNOWN canonical, return it;
//   4. else return the ORIGINAL name unchanged (never invent a merge).
export function canonicalVendorName(name) {
  if (name == null) return name;
  const original = String(name);
  const normalized = normalizeForLookup(original);
  if (!normalized) return original;

  // 2. Curated cluster.
  const cluster = CLUSTER_BY_VARIANT.get(normalized.toLowerCase());
  if (cluster) return cluster;

  // 3. Guarded mechanical strip.
  for (const candidate of strippedCandidates(normalized)) {
    const hit = KNOWN_CANONICAL_BY_KEY.get(lookupKey(candidate));
    if (hit) return hit;
  }

  // 4. Unknown → unchanged.
  return original;
}
