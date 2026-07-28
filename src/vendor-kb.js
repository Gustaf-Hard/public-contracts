// Curated knowledge base of school/edtech companies, their products, aliases,
// and role (service vs procurement channel). Pure: no IO, no DB. The single
// source of truth backing the watchlist, analytics dedup, coverage facts, and
// the extraction/draft prompts. An unknown name resolves to null (whitelist,
// never a guess). See docs/superpowers/specs/2026-07-28-vendor-product-knowledge-base-design.md

// Scaffold seed — a few real entries to exercise the resolver. The FULL curated
// list is produced in Task 2 from the live vendors/products.
export const COMPANIES = [
  { canonical: 'Radish', slug: 'radish', role: 'service', category: 'läromedel',
    aliases: ['radish'], products: ['Magma', 'Matteappen', 'Magma Pedagogik'], watchlist: true },
  { canonical: 'Nationalencyklopedin', slug: 'ne', role: 'service', category: 'läromedel',
    aliases: ['ne', 'nationalencyklopedin', 'ne nationalencyklopedin'],
    products: ['NE.se', 'NE Junior', 'NE Play', 'NE Ordböcker', 'NE 360'], watchlist: true },
  { canonical: 'ILT Education', slug: 'ilt', role: 'service', category: 'läromedel',
    aliases: ['ilt', 'ilt education', 'ilt inläsningstjänst', 'inläsningstjänst'],
    products: ['Polyglutt', 'Polylino', 'Begreppa', 'Inlästa läromedel', 'Trovy', 'Aski Raski'], watchlist: true },
  { canonical: 'Binogi', slug: 'binogi', role: 'service', category: 'läromedel',
    aliases: ['binogi'], products: ['Binogi.se'], watchlist: true },
  { canonical: 'Adda', slug: 'adda', role: 'channel',
    aliases: ['adda', 'skl kommentus', 'sklkommentus', 'kommentus'], products: [] },
  { canonical: 'Skolon', slug: 'skolon', role: 'channel', aliases: ['skolon'], products: [] },
];

export function normalizeVendorName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wholeWord(alias, normedName) {
  const a = normalizeVendorName(alias);
  if (!a) return false;
  return new RegExp(`\\b${escapeRegExp(a)}\\b`).test(normedName);
}

const BY_SLUG = new Map(COMPANIES.map((c) => [c.slug, c]));
export function companyBySlug(slug) { return BY_SLUG.get(slug); }

export function resolveCompany(name) {
  const normed = normalizeVendorName(name);
  if (!normed) return null;
  // Company alias first, then product, in COMPANIES order.
  for (const c of COMPANIES) {
    if (c.aliases.some((a) => wholeWord(a, normed))) {
      return { canonical: c.canonical, slug: c.slug, role: c.role, matchedAs: 'company' };
    }
  }
  for (const c of COMPANIES) {
    const hit = c.products.find((p) => wholeWord(p, normed));
    if (hit) return { canonical: c.canonical, slug: c.slug, role: c.role, matchedAs: 'product', product: hit };
  }
  return null;
}
