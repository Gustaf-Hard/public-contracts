// Studio facts for purchase rows (2026-10-27): rows read out of a kommun's
// purchase and licence lists (storage listPurchaseRows), as their own
// evidence level beside "avtal i underlaget".
//
// Rules (the data-honesty ethos):
//   - a purchase row is never an avtal. It never upgrades a kommun to "has
//     avtal", never enters buildStudioFacts, whiteSpots or any price median.
//   - rows are never summed. A total is shown only when the document states
//     it (stated_total_sek), per document.
//   - the licensperiod is the row's own period_end, else the end of its
//     läsår; with neither it is unknown, never guessed.
// Pure: rows and today in, plain objects out.

import { companyBySlug, normName } from './catalogue.js';
import { classifyPurchaseRow, schoolYearEnd } from './purchase-list.js';

const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
const blank = (s) => s == null || (typeof s === 'string' && !s.trim());

export const CHANNEL_NAMES = Object.freeze({ skolon: 'Skolon', atea: 'Atea', laromedia: 'Läromedia' });
export const channelName = (slug) => (slug ? CHANNEL_NAMES[slug] ?? companyBySlug(slug)?.canonical ?? slug : null);

// The evidence label a row is shown under.
export function purchaseEvidenceLabel(channelSlug) {
  const n = channelName(channelSlug);
  return n ? `Köpt via ${n}` : 'Finns i kommunens inköpslista';
}

// One fact per row; the same order line delivered in two lists of one kommun
// (an order history for 2023 and one for 2023-24) counts once.
export function buildPurchaseFacts({ rows = [], today } = {}) {
  if (!isIso(today)) throw new Error('buildPurchaseFacts requires today as YYYY-MM-DD');
  const seen = new Set();
  const out = [];
  const sorted = [...rows].sort((a, b) => (a.attachment_id - b.attachment_id) || ((a.row_index ?? 0) - (b.row_index ?? 0)));
  for (const r of sorted) {
    if (!r?.kommun_kod || (blank(r.supplier) && blank(r.product))) continue;
    // Only an order reference identifies a line across documents; rows
    // without one are never merged (two equal rows can be two orders).
    if (r.order_ref) {
      const key = `${r.kommun_kod}\u0000${r.order_ref}\u0000${normName(r.product)}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const c = classifyPurchaseRow({ supplier: r.supplier, product: r.product, channel: r.channel ?? r.document_channel ?? null });
    const end = isIso(r.period_end) ? r.period_end.slice(0, 10) : null;
    const syEnd = end ? null : schoolYearEnd(r.school_year);
    const licenceEnd = end ?? syEnd;
    out.push({
      id: r.id ?? null,
      attachment_id: r.attachment_id,
      kommun_kod: r.kommun_kod,
      kommun_namn: r.kommun_namn ?? null,
      supplier: r.supplier ?? null,
      product: r.product ?? null,
      channel_slug: c.channel_slug,
      company_slug: c.company_slug,
      company_name: c.company_name,
      product_slug: c.product_slug,
      category: c.category,
      quantity: r.quantity ?? null,
      unit: r.unit ?? null,
      amount_sek: typeof r.amount_sek === 'number' ? r.amount_sek : null,
      order_date: isIso(r.order_date) ? r.order_date.slice(0, 10) : null,
      period_start: isIso(r.period_start) ? r.period_start.slice(0, 10) : null,
      period_end: end,
      school_year: r.school_year ?? null,
      grades: Array.isArray(r.grades) ? r.grades : [],
      licence_end: licenceEnd,
      licence_basis: end ? 'period' : syEnd ? 'lasar' : null,
      // true: the licensperiod runs on; false: it has ended; null: unknown.
      current: licenceEnd ? licenceEnd >= today : null,
      method: r.method ?? null,
      stated_total_sek: typeof r.stated_total_sek === 'number' ? r.stated_total_sek : null,
    });
  }
  return out;
}

// Rows for one scope. viaChannel: a channel's page lists what was bought
// THROUGH it as well as its own product.
export function purchasesFor(pf = [], { kommunKod = null, companySlug = null, productSlug = null, viaChannel = false } = {}) {
  return pf.filter((p) => (!kommunKod || p.kommun_kod === kommunKod)
    && (!productSlug || p.product_slug === productSlug)
    && (!companySlug || p.company_slug === companySlug || (viaChannel && p.channel_slug === companySlug)));
}

// Kommuner with any purchase row in scope: the footprint map's own marker.
export const purchaseKods = (rows = []) => new Set(rows.map((p) => p.kommun_kod).filter(Boolean));

// Per kommun for an entity page: evidence labels, row count, the latest
// known licensperiod end and whether any licensperiod runs on.
export function purchaseKommuner(rows = []) {
  const by = new Map();
  for (const p of rows) {
    if (!by.has(p.kommun_kod)) by.set(p.kommun_kod, { kommun_kod: p.kommun_kod, kommun_namn: p.kommun_namn, labels: new Set(), n: 0, latest_end: null, basis: null, current: false, products: new Set() });
    const e = by.get(p.kommun_kod);
    e.labels.add(purchaseEvidenceLabel(p.channel_slug));
    e.n += 1;
    if (p.product_slug) e.products.add(p.product_slug);
    if (p.licence_end && (!e.latest_end || p.licence_end > e.latest_end)) { e.latest_end = p.licence_end; e.basis = p.licence_basis; }
    if (p.current === true) e.current = true;
  }
  return [...by.values()].map((e) => ({ ...e, labels: [...e.labels].sort(), products: [...e.products] }))
    .sort((a, b) => (b.current - a.current) || String(b.latest_end ?? '').localeCompare(String(a.latest_end ?? '')) || String(a.kommun_namn).localeCompare(String(b.kommun_namn), 'sv'));
}

// Licensperioder that end on or after today, soonest first.
export function upcomingLicenceEnds(rows = [], { today } = {}) {
  return rows.filter((p) => p.licence_end && p.licence_end >= today)
    .sort((a, b) => a.licence_end.localeCompare(b.licence_end) || String(a.product ?? '').localeCompare(String(b.product ?? ''), 'sv'));
}

// The documents behind rows, each with its own stated total (never a sum).
export function purchaseDocuments(rows = []) {
  const by = new Map();
  for (const p of rows) {
    if (!by.has(p.attachment_id)) by.set(p.attachment_id, { attachment_id: p.attachment_id, channel_slug: p.channel_slug, n: 0, stated_total_sek: p.stated_total_sek, method: p.method, school_years: new Set() });
    const d = by.get(p.attachment_id);
    d.n += 1;
    if (p.school_year) d.school_years.add(p.school_year);
  }
  return [...by.values()].map((d) => ({ ...d, school_years: [...d.school_years].sort() }));
}
