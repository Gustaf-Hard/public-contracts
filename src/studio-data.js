// Studio facts and aggregates (2026-10-26 data-studio design §6.3, §8).
// Pure: every input is injected (storage rows, KommunStats, today). One fact
// row per avtal x owner company; the aggregators read only headline rows
// (active and not superseded). Unknown is null, never 0; medians and
// percentiles are suppressed below MIN_N.

import { classifyVendor, classifyLine, companyBySlug, productBySlug } from './catalogue.js';
import { GRADE_LEVELS, contractLengthMonths, mapUnitToGradeLevels, normalizeAnnualValue, unitPeriodsPerYear } from './vendor-analytics.js';
import { computeNextReviewDate } from './contract-lifecycle.js';

export const MIN_N = 5;
export const UNKNOWN_COMPANY = 'Okänd leverantör';
// Category bucket for facts whose category is null (unknown or uncatalogued).
export const UNKNOWN_CATEGORY = 'okand';
export const KOMMUNER_TOTAL = 290;

// Headline rule: an avtal without period_end counts as active this many
// years from its start.
export const ACTIVE_YEARS = 4;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
const blank = (s) => typeof s !== 'string' || !s.trim();
const ELEV_UNIT = /\belev/i;

function cleanVendorName(raw) {
  // Studio copy has no en or em dash; a dash in an extracted name is a hyphen.
  const s = String(raw).replace(/[\u2013\u2014]/g, '-').replace(/\s*\(publ\)\s*$/i, '')
    .replace(/[\s,]+(sverige\s+)?(ab|aktiebolag)\.?$/i, '').replace(/\s+/g, ' ').trim();
  return s || String(raw).replace(/[\u2013\u2014]/g, '-').trim();
}

function minusYears(iso, years) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${String(y - years).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Headline rule (§8): period_end >= today, or period_end unknown and
// period_start within the last ACTIVE_YEARS years.
function isActive(c, today) {
  if (isIso(c.period_end)) return c.period_end.slice(0, 10) >= today;
  if (isIso(c.period_start)) return c.period_start.slice(0, 10) >= minusYears(today, ACTIVE_YEARS);
  return false;
}

const productCategory = (slug) => productBySlug(slug)?.product.category ?? null;
const sortGrades = (set) => GRADE_LEVELS.filter((g) => set.has(g));
const round2 = (x) => Math.round(x * 100) / 100;

// Student count stated in the avtal's coverage rows, or null when the rows do
// not pin it down. analyse-contract writes one row per (product, grade) and
// copies an entry's count onto every grade it lists, so "1-3 300 + 4-6 300"
// may be one entry of 300 or two of 300 each: a count repeated on two grades
// of one product is ambiguous and gives null. Products agreeing on a grade
// cover the same pupils (counted once); disagreeing is ambiguous. Every
// product's rows need a count, and the counted grades must be exactly the
// row's segments. Returns { count, invalid } (invalid: a stated count < 0 or
// not a number; 0 counts as not stated).
function coverageStudents(covRows, segments) {
  let invalid = false;
  let complete = true;
  const gradeCount = new Map();
  const byProduct = groupBy(covRows.filter((r) => GRADE_LEVELS.includes(r.grade_level)), (r) => r.product_name);
  if (byProduct.size === 0) complete = false;
  for (const rows of byProduct.values()) {
    const seen = new Set();
    for (const r of rows) {
      const n = r.student_count;
      // 0 is how extraction writes "count not stated": unknown, not bad
      // data, so the row may still fall back to Skolverket elever.
      if (n == null || n === 0) { complete = false; continue; }
      if (!(isFiniteNum(n) && n > 0)) { invalid = true; continue; }
      if (seen.has(n)) complete = false;
      seen.add(n);
      const prev = gradeCount.get(r.grade_level);
      if (prev != null && prev !== n) complete = false;
      gradeCount.set(r.grade_level, n);
    }
  }
  if (!complete || sortGrades(new Set(gradeCount.keys())).join() !== segments.join()) return { count: null, invalid };
  return { count: [...gradeCount.values()].reduce((sum, n) => sum + n, 0), invalid };
}

export function companyKey(f) {
  if (f.company_slug) return f.company_slug;
  if (f.company_name === UNKNOWN_COMPANY) return `contract:${f.contract_id}`;
  return `name:${f.company_name}`;
}

// ---------------- facts ----------------

export function buildStudioFacts({ contracts = [], lineItems = [], coverage = [], stats = null, today }) {
  if (!isIso(today)) throw new Error('buildStudioFacts requires today as YYYY-MM-DD');
  const now = new Date(today + 'T00:00:00Z');
  const linesBy = groupBy(lineItems.filter((l) => !blank(l.product_name)), (l) => l.contract_id);
  const covBy = groupBy(coverage.filter((c) => !blank(c.product_name)), (c) => c.contract_id);

  const facts = [];
  for (const c of contracts) {
    const vendor = blank(c.vendor_name) ? null : classifyVendor(c.vendor_name);
    const ownerSlug = vendor?.slug ?? null;
    const ownerName = vendor?.canonical ?? (blank(c.vendor_name) ? UNKNOWN_COMPANY : cleanVendorName(c.vendor_name));
    const cache = new Map();
    const cls = (name) => {
      if (!cache.has(name)) cache.set(name, classifyLine(ownerSlug, name));
      return cache.get(name);
    };
    // Group everything the avtal names by owning company; '' = the vendor.
    const groups = new Map();
    const group = (k) => {
      if (!groups.has(k)) groups.set(k, { lines: [], cov: [], products: new Set(), grades: new Set() });
      return groups.get(k);
    };
    group('');
    // Only a line that sells another company's product (or names that
    // company outright, e.g. "Adobelicenser" from a reseller) opens an owner
    // row for it. Add-ons, integrations, discounts, segment and noise lines
    // stay on the avtal's vendor: "Integration ProReNata" on a Unikum avtal
    // is Unikum's fee, not a ProReNata avtal.
    const OWNER_KINDS = ['product', 'bundle', 'unresolved'];
    const ownerOf = (r) => (OWNER_KINDS.includes(r.kind) && r.companySlug && r.companySlug !== ownerSlug ? r.companySlug : '');
    const productsOf = (r) => (r.kind === 'bundle' ? r.products ?? [] : ['product', 'segment'].includes(r.kind) && r.productSlug ? [r.productSlug] : []);

    for (const l of linesBy.get(c.contract_id) ?? []) {
      const r = cls(l.product_name);
      const g = group(ownerOf(r));
      g.lines.push({ l, r });
      for (const p of productsOf(r)) if (p) g.products.add(p);
      if (['product', 'segment', 'bundle'].includes(r.kind)) for (const lv of mapUnitToGradeLevels(l.product_name)) g.grades.add(lv);
    }
    for (const name of c.products ?? []) {
      if (blank(name)) continue;
      const r = cls(name);
      const g = group(ownerOf(r));
      for (const p of productsOf(r)) if (p) g.products.add(p);
    }
    for (const cv of covBy.get(c.contract_id) ?? []) {
      const r = cls(cv.product_name);
      const g = group(ownerOf(r));
      g.cov.push(cv);
      if (GRADE_LEVELS.includes(cv.grade_level)) g.grades.add(cv.grade_level);
    }
    if (ownerSlug) {
      const single = companyBySlug(ownerSlug)?.singleProduct;
      const own = groups.get('');
      if (single && own.products.size === 0) {
        const slug = companyBySlug(ownerSlug).products.find((p) => p.name === single)?.slug;
        if (slug) own.products.add(slug);
      }
    }

    const annual = normalizeAnnualValue(c, { now });
    const foreign = [...groups.keys()].filter((k) => k !== '');
    const viaChannel = foreign.length > 0 || vendor?.role === 'channel';
    const channelSlug = viaChannel ? ownerSlug : null;

    // Value split by line amounts; the remainder stays on the vendor row.
    const values = new Map();
    let remainderBasis = annual == null ? null : 'stated';
    if (foreign.length) {
      // amount_sek is the line's share of the avtal's TOTAL price
      // (analyse-contract). A line with period_months is annualised by it.
      // Lines without one are taken as annual unless the lines add up to more
      // than a year of the avtal's value; then they are totals over the avtal
      // length, and with no known length nothing is split.
      const allLines = [...groups.values()].flatMap((g) => g.lines);
      const hasAmt = ({ l }) => isFiniteNum(l.amount_sek) && l.amount_sek >= 0;
      const hasPm = ({ l }) => isFiniteNum(l.period_months) && l.period_months > 0;
      const withPm = allLines.filter((x) => hasAmt(x) && hasPm(x)).reduce((sum, { l }) => sum + (l.amount_sek * 12) / l.period_months, 0);
      const noPm = allLines.filter((x) => hasAmt(x) && !hasPm(x)).reduce((sum, { l }) => sum + l.amount_sek, 0);
      const avtalMonths = contractLengthMonths(c.period_start, c.period_end);
      let noPmFactor = 1;
      if (annual != null && withPm + noPm > annual + 1) noPmFactor = avtalMonths ? 12 / avtalMonths : null;
      let determinable = true;
      const amounts = new Map(foreign.map((k) => {
        const known = groups.get(k).lines.filter(hasAmt);
        if (!known.length) return [k, null];
        let sum = 0;
        for (const x of known) {
          if (hasPm(x)) sum += (x.l.amount_sek * 12) / x.l.period_months;
          else if (noPmFactor == null) determinable = false;
          else sum += x.l.amount_sek * noPmFactor;
        }
        return [k, Math.round(sum)];
      }));
      const splitSum = [...amounts.values()].reduce((sum, a) => sum + (a ?? 0), 0);
      const consistent = annual != null && determinable && splitSum <= annual + 1;
      for (const k of foreign) values.set(k, consistent ? amounts.get(k) : null);
      const own = groups.get('');
      const ownHasProducts = own.products.size > 0 && vendor?.role !== 'channel';
      remainderBasis = annual == null ? null : (ownHasProducts && consistent ? 'split' : 'unsplit_channel');
      values.set('', annual == null ? null : consistent ? Math.max(0, Math.round(annual - splitSum)) : annual);
      // Nothing left over is not a known 0 kr. A vendor that named nothing of
      // its own gets no row; one that named its own products keeps its row
      // with an unknown value (its price is not in the lines).
      if (consistent && values.get('') === 0) {
        if (own.products.size === 0) groups.delete('');
        else { values.set('', null); remainderBasis = null; }
      }
    } else {
      values.set('', annual);
    }

    const rows = [];
    for (const [k, g] of groups) {
      const isOwner = k === '';
      const company = isOwner ? null : companyBySlug(k);
      const slug = isOwner ? ownerSlug : k;
      const value = values.get(k) ?? null;
      const basis = isOwner ? remainderBasis : value == null ? null : 'split';
      const productSlugs = [...g.products];
      const category = productSlugs.map(productCategory).find((x) => x != null)
        ?? (isOwner ? vendor?.category ?? null : company?.category ?? null);
      const segments = sortGrades(g.grades);
      rows.push({
        contract_id: c.contract_id,
        kommun_kod: c.kommun_kod ?? null,
        kommun_namn: c.kommun_namn ?? null,
        company_slug: slug,
        company_name: isOwner ? ownerName : company?.canonical ?? k,
        channel_slug: channelSlug,
        category,
        product_slugs: productSlugs,
        segments,
        annual_value_sek: value,
        value_basis: value == null ? null : basis,
        pricing_model: c.pricing_model ?? null,
        period_start: c.period_start ?? null,
        period_end: c.period_end ?? null,
        next_renewal: computeNextReviewDate(c, now),
        // Renewal terms as the avtal states them (Förnyelser shows them).
        auto_renews: c.auto_renews == null ? null : !!c.auto_renews,
        extension_option_until: isIso(c.extension_option_until) ? c.extension_option_until.slice(0, 10) : null,
        last_cancellation_date: isIso(c.last_cancellation_date) ? c.last_cancellation_date.slice(0, 10) : null,
        active: isActive(c, today),
        superseded: false,
        elever_in_scope: null,
        kr_per_elev: null,
        kr_per_elev_basis: null,
        kr_per_elev_product_slug: null,
        attachment_id: c.attachment_id ?? null,
        // Date the avtal reached us (YYYY-MM-DD): "senast inkomna" lists.
        received_at: isIso(c.received_at) ? c.received_at.slice(0, 10) : null,
        // Same avtal delivered twice (duplicate_of) or by several kommuner
        // (joint, a samverkansavtal): see markDuplicates and allocateJoint.
        duplicate_of: null,
        joint: null,
        avtal_key: String(c.contract_id),
        _g: g,
        _owner: isOwner,
        _received_at: c.received_at ?? null,
        _vendor_key: ownerSlug ?? (blank(c.vendor_name) ? `contract:${c.contract_id}` : `name:${ownerName}`),
        _annual: annual,
      });
    }
    // An unsplit channel remainder with no category of its own takes the
    // avtal's category when every owner row agrees on one.
    const cats = new Set(rows.filter((r) => !r._owner).map((r) => r.category));
    for (const r of rows) {
      if (r.category == null && r.value_basis === 'unsplit_channel' && cats.size === 1 && [...cats][0] != null) {
        r.category = [...cats][0];
      }
    }
    for (const r of rows) {
      pricePerElev(r, { contract: c, singleRow: rows.length === 1, stats });
      delete r._g; delete r._owner;
    }
    facts.push(...rows);
  }

  markDuplicates(facts);
  markSuperseded(facts);
  allocateJoint(facts);
  for (const f of facts) { delete f._received_at; delete f._vendor_key; delete f._annual; }
  return facts;
}

// Pricing models whose value can be read as a price for the pupils. per_user,
// usage, one_time and free are not; null (older rows) and 'unknown' only when
// the avtal's own unit is elev.
const ELEV_MODELS = new Set(['per_student', 'fixed', 'tiered']);
// A unit that counts staff or users, not pupils.
const STAFF_UNIT = /l[äa]rare|personal|pedagog|anv[äa]ndare|anst[äa]lld|medarbetare|\buser/i;
const near = (a, b) => Math.abs(a - b) <= 0.1 * Math.max(Math.abs(a), Math.abs(b));

// Annual price per elev from a stated unit price, or null when it cannot be
// read as one. The extraction (analyse-contract line_items) does not say
// whether unit_price_sek is per month, per year or for the line's whole
// period, so it is checked against amount_sek = the line's share of the
// total price: unit x quantity x months = amount means a monthly price,
// unit x quantity = amount over more than 12 months means the price for the
// whole period. An explicit per-month or per-term unit is scaled to a year.
// A period over 12 months that the amount does not explain is ambiguous and
// gives null, so the caller falls back to value per elev.
function annualUnitPrice({ unit_price_sek: up, unit, quantity: q, amount_sek: amt, period_months: pm }) {
  if (!(isFiniteNum(up) && up > 0)) return null;
  // Per month or per term, by the same rule normalizeAnnualValue uses for
  // the avtal's annual value.
  const periods = unitPeriodsPerYear(unit);
  if (periods > 1) return up * periods;
  const months = isFiniteNum(pm) && pm > 0 ? pm : null;
  if (isFiniteNum(q) && q > 0 && isFiniteNum(amt) && amt > 0) {
    const t = up * q;
    if (months && months >= 12) {
      if (near(t, amt)) return months === 12 ? up : (up * 12) / months;
      if (near(t * months, amt)) return up * 12;
      if (near((t * months) / 12, amt)) return up;
    } else if (!months && near(t * 12, amt) && !near(t, amt)) return up * 12;
  }
  if (months && months > 12) return null;
  return up;
}

// The elever an owner row covers: the avtal's own stated count when the
// coverage rows pin it down, else Skolverket elever in the row's segments.
// null when the row has no segments, the coverage is partial or bad, or the
// count is unknown.
function scopeElever(r, g, stats) {
  if (r.segments.length === 0) return null; // a kommun-wide licence without segments is not normalised
  const { count, invalid } = coverageStudents(g.cov, r.segments);
  if (invalid) return null; // a negative or non-numeric count is bad data, not a fallback
  if (count != null) return { elever: count, basis: 'avtalets_elevantal' };
  if (stats && !g.cov.some((cv) => cv.status === 'partial')) {
    const n = stats.eleverIn(r.kommun_kod, r.segments);
    if (isFiniteNum(n) && n > 0) return { elever: n, basis: 'skolverket' };
  }
  return null;
}

// The line's amount for choosing the main elev line: amount_sek when stated,
// else unit price x quantity, else 0.
const lineWeight = ({ l }) => (isFiniteNum(l.amount_sek) && l.amount_sek > 0 ? l.amount_sek
  : isFiniteNum(l.quantity) && l.quantity > 0 ? l.unit_price_sek * l.quantity : 0);
const isElevLine = ({ l }) => ELEV_UNIT.test(l.unit ?? '') && isFiniteNum(l.unit_price_sek) && l.unit_price_sek > 0;
const shortPeriod = (l) => isFiniteNum(l.period_months) && l.period_months > 0 && l.period_months < 12;

function pricePerElev(r, { contract, singleRow, stats }) {
  const g = r._g;
  const model = contract.pricing_model ?? null;
  // The pupils the row covers, whatever the pricing model: a kommun page
  // divides known spend by the elever in the school forms its avtal cover
  // (spend per elev is not a price, so a staff licence or a per-user avtal
  // still counts there). Price per elev below has its own, stricter rules.
  const scope = scopeElever(r, g, stats);
  if (scope) r.elever_in_scope = scope.elever;
  // Free avtal and a known 0 kr are not price points.
  if (model === 'free' || r.annual_value_sek === 0) return;
  const staffUnit = STAFF_UNIT.test(contract.unit ?? '')
    || g.lines.some(({ l }) => isFiniteNum(l.amount_sek) && l.amount_sek > 0 && STAFF_UNIT.test(l.unit ?? '') && !ELEV_UNIT.test(l.unit ?? ''));
  const elevModel = ELEV_MODELS.has(model)
    || ((model == null || model === 'unknown') && ELEV_UNIT.test(contract.unit ?? ''));
  if (!elevModel) return;
  // Styckpris: a product line of this row priced per elev for a period of at
  // least 12 months (or no stated period). Of several, the main line: an
  // explicit >= 12 months first, then the largest amount (the all-subject
  // licence, not a small add-on title that happens to come first).
  const unitLines = g.lines.filter((x) => ['product', 'segment', 'bundle'].includes(x.r.kind) && isElevLine(x)
    && (x.l.period_months == null || (isFiniteNum(x.l.period_months) && x.l.period_months >= 12)))
    .map((x) => ({ ...x, annual: annualUnitPrice(x.l) }))
    .filter((x) => x.annual != null)
    .sort((a, b) => (b.l.period_months != null) - (a.l.period_months != null) || lineWeight(b) - lineWeight(a));
  const unitLine = unitLines[0];
  if (unitLine) {
    r.kr_per_elev = round2(unitLine.annual);
    r.kr_per_elev_basis = 'styckpris';
    r.kr_per_elev_product_slug = unitLine.r.kind === 'bundle' ? null : unitLine.r.productSlug ?? null;
    return;
  }
  // The avtal's own unit price, under the same period rule as lines: not when
  // the avtal runs under 12 months, or its elev lines are priced for a
  // shorter period (a 6-month line price is not a price per year).
  const months = contractLengthMonths(contract.period_start, contract.period_end);
  const shortLines = g.lines.some((x) => isElevLine(x) && shortPeriod(x.l))
    && !g.lines.some((x) => isElevLine(x) && isFiniteNum(x.l.period_months) && x.l.period_months >= 12);
  if (singleRow && ELEV_UNIT.test(contract.unit ?? '') && !shortLines && !(months != null && months < 12)) {
    const annual = annualUnitPrice({
      unit_price_sek: contract.unit_price_sek, unit: contract.unit, quantity: contract.quantity,
      amount_sek: contract.annual_value_sek, period_months: null,
    });
    if (annual != null) {
      r.kr_per_elev = round2(annual);
      r.kr_per_elev_basis = 'styckpris';
      r.kr_per_elev_product_slug = r.product_slugs.length === 1 ? r.product_slugs[0] : null;
      return;
    }
  }
  // Value per elev: never for a staff or user licence (a few teacher seats
  // divided by every pupil would read as the cheapest price in Sweden).
  if (staffUnit || !scope) return;
  if (!isFiniteNum(r.annual_value_sek) || r.annual_value_sek <= 0 || !['stated', 'split'].includes(r.value_basis)) return;
  const v = r.annual_value_sek / scope.elever;
  if (!Number.isFinite(v)) return;
  r.kr_per_elev = round2(v);
  r.kr_per_elev_basis = scope.basis;
}

const dayOf = (v) => (isIso(v) ? v.slice(0, 10) : null);
const sameKr = (a, b) => isFiniteNum(a) && isFiniteNum(b) && Math.abs(a - b) <= 1;
const segmentsOverlap = (a, b) => !a.length || !b.length || a.some((s) => b.includes(s));
const union = (rows, key) => [...new Set(rows.flatMap((f) => f[key]))];

// One entry per avtal: its rows plus what the avtal-level rules compare.
function avtalList(facts) {
  return [...groupBy(facts, (f) => f.contract_id).values()].map((rows) => ({
    id: rows[0].contract_id,
    rows,
    kod: rows[0].kommun_kod,
    vendor: rows[0]._vendor_key,
    start: dayOf(rows[0].period_start),
    end: dayOf(rows[0].period_end),
    annual: rows[0]._annual,
    segments: sortGrades(new Set(union(rows, 'segments'))),
    products: union(rows, 'product_slugs'),
  }));
}

// The same avtal delivered twice in one kommun: same vendor, same start and
// end, the same annual value (or one unknown), overlapping products and
// segments. The fullest copy counts (see below); every
// row of the other copies is hidden, so a second delivery never leaves an
// owner row of its own behind.
function markDuplicates(facts) {
  const byKey = groupBy(avtalList(facts).filter((a) => a.kod && a.start), (a) => `${a.kod}\u0000${a.vendor}\u0000${a.start}\u0000${a.end ?? ''}`);
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    // The fuller copy counts: a known value, then known school forms (spend
    // per elev needs them), then more owner rows and products (a copy that names Microsoft beside Atea keeps both), then
    // the lowest id.
    list.sort((a, b) => (isFiniteNum(b.annual) - isFiniteNum(a.annual)) || ((b.segments.length > 0) - (a.segments.length > 0))
      || b.rows.length - a.rows.length
      || b.products.length - a.products.length || a.id - b.id);
    const kept = [];
    for (const a of list) {
      const same = kept.find((k) => (a.annual == null || k.annual == null || sameKr(a.annual, k.annual))
        && segmentsOverlap(a.segments, k.segments)
        && (!a.products.length || !k.products.length || a.products.some((p) => k.products.includes(p))));
      if (!same) { kept.push(a); continue; }
      for (const f of a.rows) { f.superseded = true; f.duplicate_of = same.id; }
    }
  }
}

// Of several avtal for one kommun x company x product, a newer one replaces
// an older one only when it is clearly a renewal of it. Both must name the
// same products (the newer every product of the older), the newer is active
// and starts strictly later (both starts known), and the newer covers some
// of the older's school forms: a newer avtal with no known school forms
// never covers one that has them (a tilläggsavtal for a few modules names the
// main product and no school forms, and must not hide the main avtal). Then
// it must be a renewal: (a) a re-signing, the same annual value within
// RENEWAL_VALUE_TOLERANCE or the older has no known value, or (b) the older
// ends before, or at most RENEWAL_GAP_DAYS after, the newer starts. An older
// avtal with no end date is replaced only under (a). Anything else is an
// addition (tillägg, option, another module) and both count. A tie is never
// broken by id or by a day's difference in end date.
export const RENEWAL_VALUE_TOLERANCE = 0.02;
export const RENEWAL_GAP_DAYS = 92;
const addDays = (iso, k) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);
const newerCovers = (older, newer) => (newer.length ? !older.length || older.some((s) => newer.includes(s)) : !older.length);
export function isRenewalOf(older, newer) {
  const os = dayOf(older.period_start); const ns = dayOf(newer.period_start);
  if (!os || !ns || ns <= os || !newer.active) return false;
  if (!newerCovers(older.segments, newer.segments)) return false;
  if (older.product_slugs.length === 0 ? newer.product_slugs.length !== 0 : !older.product_slugs.every((p) => newer.product_slugs.includes(p))) return false;
  const ov = older._annual ?? older.annual_value_sek; const nv = newer._annual ?? newer.annual_value_sek;
  const resigned = !isFiniteNum(ov) || (isFiniteNum(nv) && Math.abs(ov - nv) <= RENEWAL_VALUE_TOLERANCE * Math.max(Math.abs(ov), Math.abs(nv)));
  if (resigned) return true;
  const oe = dayOf(older.period_end);
  return !!oe && oe <= addDays(ns, RENEWAL_GAP_DAYS);
}
function markSuperseded(facts) {
  const groups = groupBy(facts.filter((f) => !f.duplicate_of), (f) => `${f.kommun_kod}\u0000${companyKey(f)}`);
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    for (const r of rows) {
      r.superseded = rows.some((s) => s.contract_id !== r.contract_id && isRenewalOf(r, s));
    }
  }
}

// A samverkansavtal delivered by several kommuner: the same vendor, start,
// end and annual value in different kommuner of one län is one avtal. We
// rarely know every member or how the cost is shared (a copy may come from
// two of four members), so nothing is allocated: every copy carries
// joint.whole_value_sek (the whole avtal's value), the lowest-id copy keeps
// it as annual_value_sek so market totals count it once, the other copies
// have no value of their own (annual_value_sek null). No copy has a price
// per elev: the whole value over one member's elever is not that member's
// price. avtal_key is the same on every copy, so avtal counts count it once.
// Kommun pages show it as "samverkansavtal (N kommuner), andel okänd" and
// leave it out of the kommun's spend and of peer comparisons.
function allocateJoint(facts) {
  const live = avtalList(facts).filter((a) => !a.rows[0].duplicate_of && a.kod && a.start && a.end && isFiniteNum(a.annual) && a.annual > 0);
  // Members share a län (the first two digits of the kommun kod): kommunal
  // samverkan is regional, and two kommuner far apart paying a list price on
  // the same dates are two avtal.
  for (const list of groupBy(live, (a) => `${a.vendor}\u0000${a.start}\u0000${a.end}\u0000${String(a.kod).slice(0, 2)}`).values()) {
    const used = new Set();
    for (const a of list) {
      if (used.has(a.id)) continue;
      const members = [];
      for (const b of list) {
        if (used.has(b.id) || !sameKr(a.annual, b.annual) || members.some((m) => m.kod === b.kod)) continue;
        members.push(b);
      }
      if (members.length < 2) continue;
      for (const m of members) used.add(m.id);
      const primary = Math.min(...members.map((m) => m.id));
      const key = `joint:${primary}`;
      const kods = members.map((m) => m.kod).sort();
      for (const m of members) {
        for (const f of m.rows) {
          f.avtal_key = key;
          f.joint = { n_kommuner: members.length, kommun_kods: kods, whole_value_sek: f.annual_value_sek, counted_here: m.id === primary };
          if (m.id !== primary) { f.annual_value_sek = null; f.value_basis = null; }
          f.kr_per_elev = null; f.kr_per_elev_basis = null; f.kr_per_elev_product_slug = null;
        }
      }
    }
  }
}

// ---------------- helpers ----------------

function groupBy(items, keyFn) {
  const m = new Map();
  for (const x of items) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
const headline = (facts) => facts.filter((f) => f.active && !f.superseded);
// A row as one kommun sees it: a samverkansavtal has no known value of its
// own for a member kommun (the share is unknown), so it is left out of the
// kommun's spend and of every peer comparison. joint.whole_value_sek keeps
// the whole avtal's value for display.
export const kommunView = (f) => (f.joint ? { ...f, annual_value_sek: null, value_basis: null } : f);
// One avtal: a samverkansavtal delivered by several kommuner shares one key.
export const avtalOf = (f) => f.avtal_key ?? String(f.contract_id);
const catOf = (f) => f.category ?? UNKNOWN_CATEGORY;
const sumKnown = (rows) => rows.reduce((s, f) => s + (isFiniteNum(f.annual_value_sek) ? f.annual_value_sek : 0), 0);
const nKnown = (rows) => rows.filter((f) => isFiniteNum(f.annual_value_sek)).length;
const distinct = (rows, fn) => new Set(rows.map(fn)).size;
const hidden = (slug) => !!(slug && companyBySlug(slug)?.hiddenInStudio);
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'sv');

// ---------------- aggregators ----------------

// Per kommun: 'not_contacted' (only INITIAL), 'open', 'done' (every
// conversation DONE), 'dead_end' (every conversation closed, at least one
// DEAD_END, no avtal received) or 'partial' (closed with a DEAD_END, but
// some avtal did arrive: "delvis utlämnat"). Neither dead_end nor partial is
// evidence of absence: part of the request ended without avtal, so we do not
// know everything the kommun buys. dead_end needs kodsWithAvtal (kommun kods
// with any collected avtal); without it a DEAD_END kommun is 'partial'. Only
// 'done' counts as a finished collection.
export function collectionStatus(conversations = [], { kodsWithAvtal = null } = {}) {
  const by = groupBy(conversations.filter((c) => c && c.kommun_kod), (c) => c.kommun_kod);
  const out = new Map();
  for (const [kod, convs] of by) {
    if (convs.every((c) => c.state === 'INITIAL')) out.set(kod, 'not_contacted');
    else if (convs.every((c) => c.state === 'DONE' || c.state === 'DEAD_END')) {
      const deadEnd = convs.some((c) => c.state === 'DEAD_END');
      out.set(kod, !deadEnd ? 'done' : kodsWithAvtal && !kodsWithAvtal.has(kod) ? 'dead_end' : 'partial');
    } else out.set(kod, 'open');
  }
  return out;
}

export const isCollectionFinished = (s) => s === 'done';

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function distribution(values = []) {
  const v = values.filter(isFiniteNum).sort((a, b) => a - b);
  const n = v.length;
  if (n < MIN_N) return { n, median: null, p25: null, p75: null, min: null, max: null, suppressed: true };
  return {
    n,
    median: quantile(v, 0.5),
    p25: quantile(v, 0.25),
    p75: quantile(v, 0.75),
    min: v[0],
    max: v[n - 1],
    suppressed: false,
  };
}

export function companyShares(facts, { category } = {}) {
  let rows = headline(facts);
  if (category) rows = rows.filter((f) => catOf(f) === category);
  const totalValue = sumKnown(rows);
  const totalKommuner = distinct(rows, (f) => f.kommun_kod);
  const out = [];
  for (const group of groupBy(rows, companyKey).values()) {
    const f0 = group[0];
    if (hidden(f0.company_slug)) continue;
    const value = sumKnown(group);
    const kommuner = distinct(group, (f) => f.kommun_kod);
    out.push({
      slug: f0.company_slug,
      name: f0.company_name,
      value_known_sek: value,
      share_value: totalValue > 0 ? value / totalValue : null,
      kommuner,
      share_kommuner: totalKommuner > 0 ? kommuner / totalKommuner : null,
      n_avtal: distinct(group, avtalOf),
      n_known: nKnown(group),
    });
  }
  return out.sort((a, b) => b.value_known_sek - a.value_known_sek || b.kommuner - a.kommuner || byName(a, b));
}

export function marketByCategory(facts) {
  const rows = headline(facts);
  const out = [];
  for (const [category, group] of groupBy(rows, catOf)) {
    out.push({
      category,
      value_known_sek: sumKnown(group),
      n_avtal: distinct(group, avtalOf),
      n_known: nKnown(group),
      kommuner: distinct(group, (f) => f.kommun_kod),
      topCompanies: companyShares(facts, { category }).slice(0, 3)
        .map((c) => ({ slug: c.slug, name: c.name, share: c.share_value })),
    });
  }
  return out.sort((a, b) => b.value_known_sek - a.value_known_sek || b.n_avtal - a.n_avtal || a.category.localeCompare(b.category));
}

// The row filter of priceDistribution without the price itself, so a page
// can count the avtal the plot could have shown ("utan känt pris").
export function priceRowFilter({ productSlug, category, segment, kommunKods } = {}) {
  const kods = kommunKods ? new Set(kommunKods) : null;
  return (f) => (!productSlug || (f.product_slugs.length === 1 && f.product_slugs[0] === productSlug) || f.kr_per_elev_product_slug === productSlug)
    && (!category || catOf(f) === category)
    && (!segment || f.segments.includes(segment))
    && (!kods || kods.has(f.kommun_kod));
}

// One point per kommun: a kommun with several priced avtal in the filtered
// set counts once, at the median of its own prices, so n is distinct
// kommuner and one kommun (or one avtal naming five owners) can never reach
// MIN_N alone. n_avtal says how many avtal stand behind the points.
export function priceDistribution(facts, opts = {}) {
  const match = priceRowFilter(opts);
  const rows = headline(facts).filter((f) => isFiniteNum(f.kr_per_elev) && f.kr_per_elev > 0 && match(f));
  const perKommun = [...groupBy(rows, (f) => f.kommun_kod)].map(([kommun_kod, group]) => {
    const v = group.map((f) => f.kr_per_elev).sort((a, b) => a - b);
    return { kommun_kod, kr_per_elev: round2(quantile(v, 0.5)) };
  });
  const d = distribution(perKommun.map((p) => p.kr_per_elev));
  const values = d.suppressed ? [] : perKommun
    .sort((a, b) => a.kr_per_elev - b.kr_per_elev || String(a.kommun_kod).localeCompare(String(b.kommun_kod)));
  return { ...d, n_avtal: distinct(rows, avtalOf), values };
}

function monthKey(iso) { return iso.slice(0, 7); }
function addMonths(ym, k) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + k;
  return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function renewalBuckets(facts, { today, months = 24 } = {}) {
  if (!isIso(today)) throw new Error('renewalBuckets requires today as YYYY-MM-DD');
  const first = monthKey(today);
  // n and n_known count distinct avtal (a channel avtal has one row per
  // owner company, and is still one avtal); value_known_sek sums the rows'
  // known values, which add up to the avtal's value when it is split.
  // n_known says how many of n carried a value, so unknown is never 0.
  const buckets = Array.from({ length: months }, (_, i) => ({ month: addMonths(first, i), n: 0, n_known: 0, value_known_sek: 0, byCategory: {} }));
  const index = new Map(buckets.map((b, i) => [b.month, i]));
  const ids = new Map(); // tally -> { all: Set, known: Set }
  const tally = (t, f, known) => {
    if (!ids.has(t)) ids.set(t, { all: new Set(), known: new Set() });
    const s = ids.get(t);
    s.all.add(avtalOf(f));
    if (known) { s.known.add(avtalOf(f)); t.value_known_sek += f.annual_value_sek; }
    t.n = s.all.size;
    t.n_known = s.known.size;
  };
  for (const f of headline(facts)) {
    if (!isIso(f.next_renewal) || f.next_renewal.slice(0, 10) < today) continue;
    const i = index.get(monthKey(f.next_renewal));
    if (i == null) continue;
    const b = buckets[i];
    const known = isFiniteNum(f.annual_value_sek);
    const cat = catOf(f);
    b.byCategory[cat] ??= { n: 0, n_known: 0, value_known_sek: 0 };
    tally(b, f, known);
    tally(b.byCategory[cat], f, known);
  }
  return buckets;
}

// allKods: the kommun universe (e.g. stats.all() kods); defaults to every
// kommun the status map or the facts know. Buckets, each kommun in one:
//   has: an active avtal in scope.
//   none_done: the safe white spot. Collection done, no avtal at all in
//     scope (active, expired or replaced) and, with a category, no active
//     avtal of unknown category (that avtal may be the one in scope).
//   none_done_expired: done, and every avtal in scope has expired or been
//     replaced ("avtalet har löpt ut"): they buy here, a sales opening, not
//     a white spot.
//   none_done_uncertain: done, nothing in scope, but an active avtal of
//     unknown category.
//   refused: dead_end, nothing handed over, so no claim either way.
//   partial: part of the request ended without avtal ("delvis utlämnat").
//   none_open, not_contacted.
export function whiteSpots(facts, statusMap = new Map(), { category, allKods } = {}) {
  const kods = allKods ? [...new Set(allKods)] : [...new Set([...statusMap.keys(), ...facts.map((f) => f.kommun_kod)])];
  const inScope = (f) => !category || catOf(f) === category;
  const has = new Set(headline(facts).filter(inScope).map((f) => f.kommun_kod));
  const hadAny = new Set(facts.filter(inScope).map((f) => f.kommun_kod));
  const unknownCat = new Set(category && category !== UNKNOWN_CATEGORY
    ? headline(facts).filter((f) => f.category == null).map((f) => f.kommun_kod) : []);
  const out = { has: [], none_done: [], none_done_expired: [], none_done_uncertain: [], refused: [], partial: [], none_open: [], not_contacted: [] };
  for (const kod of kods.filter(Boolean).sort()) {
    const st = statusMap.get(kod);
    if (has.has(kod)) out.has.push(kod);
    else if (st === 'done') {
      if (hadAny.has(kod)) out.none_done_expired.push(kod);
      else if (unknownCat.has(kod)) out.none_done_uncertain.push(kod);
      else out.none_done.push(kod);
    } else if (st === 'dead_end') out.refused.push(kod);
    else if (st === 'partial') out.partial.push(kod);
    else if (st === 'open') out.none_open.push(kod);
    else out.not_contacted.push(kod);
  }
  return out;
}

export function coOccurrence(facts, companySlug) {
  const rows = headline(facts);
  const mine = new Set(rows.filter((f) => f.company_slug === companySlug).map((f) => f.kommun_kod));
  const by = new Map();
  for (const f of rows) {
    if (!f.company_slug || f.company_slug === companySlug || hidden(f.company_slug) || !mine.has(f.kommun_kod)) continue;
    if (!by.has(f.company_slug)) by.set(f.company_slug, { slug: f.company_slug, name: f.company_name, kods: new Set() });
    by.get(f.company_slug).kods.add(f.kommun_kod);
  }
  return [...by.values()].map(({ slug, name, kods }) => ({ slug, name, kommuner: kods.size }))
    .sort((a, b) => b.kommuner - a.kommuner || byName(a, b));
}

function spendRows(rows) {
  return [...groupBy(rows, catOf)].map(([category, group]) => ({
    category,
    value_known_sek: sumKnown(group),
    n_avtal: distinct(group, avtalOf),
    n_known: nKnown(group),
    n_joint: distinct(group.filter((f) => f.joint), avtalOf),
  })).sort((a, b) => b.value_known_sek - a.value_known_sek || a.category.localeCompare(b.category));
}

// peerMedianByCategory: { category: distribution } over peers' known spend in
// that category. A peer with no known value there is unknown, not 0.
// Samverkansavtal count as avtal but never as the kommun's known spend
// (kommunView).
export function kommunProfile(facts, stats, kod, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const rows = headline(facts).map(kommunView);
  const mine = rows.filter((f) => f.kommun_kod === kod);
  const spendByCategory = spendRows(mine);

  const peers = new Set(stats?.peersOf?.(kod) ?? []);
  const peerSpend = new Map(); // category -> Map(kod -> sum)
  for (const f of rows) {
    if (!peers.has(f.kommun_kod) || !isFiniteNum(f.annual_value_sek)) continue;
    const cat = catOf(f);
    if (!peerSpend.has(cat)) peerSpend.set(cat, new Map());
    const m = peerSpend.get(cat);
    m.set(f.kommun_kod, (m.get(f.kommun_kod) ?? 0) + f.annual_value_sek);
  }
  const peerMedianByCategory = {};
  for (const cat of new Set([...peerSpend.keys(), ...spendByCategory.map((s) => s.category)])) {
    peerMedianByCategory[cat] = distribution([...(peerSpend.get(cat)?.values() ?? [])]);
  }

  const overlaps = [];
  for (const [category, group] of groupBy(mine.filter((f) => f.company_slug && !hidden(f.company_slug)), catOf)) {
    const companies = [...new Map(group.map((f) => [f.company_slug, { slug: f.company_slug, name: f.company_name }])).values()].sort(byName);
    if (companies.length >= 2) overlaps.push({ category, companies });
  }
  overlaps.sort((a, b) => a.category.localeCompare(b.category));

  const renewals = mine.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today)
    .map((f) => ({
      contract_id: f.contract_id, company_slug: f.company_slug, company_name: f.company_name,
      category: f.category, next_renewal: f.next_renewal, annual_value_sek: f.annual_value_sek,
    }))
    .sort((a, b) => a.next_renewal.localeCompare(b.next_renewal) || a.contract_id - b.contract_id);

  return { spendByCategory, peerMedianByCategory, overlaps, renewals };
}

// Footer basis: "X aktiva avtal (Y insamlade) från Z kommuner".
export function dataBasis(facts, statusMap = new Map()) {
  const head = headline(facts);
  const activeIds = new Set(head.map(avtalOf));
  const unknownEnd = new Set(head.filter((f) => !isIso(f.period_end)).map(avtalOf));
  return {
    active: activeIds.size,
    active_unknown_end: unknownEnd.size,
    collected: distinct(facts, avtalOf),
    kommuner_with_avtal: distinct(head.filter((f) => f.kommun_kod), (f) => f.kommun_kod),
    kommuner_collected: distinct(facts.filter((f) => f.kommun_kod), (f) => f.kommun_kod),
    kommuner_total: KOMMUNER_TOTAL,
    // dead_end is counted on its own, never as a finished collection.
    done: [...statusMap.values()].filter(isCollectionFinished).length,
    dead_end: [...statusMap.values()].filter((s) => s === 'dead_end').length,
    partial: [...statusMap.values()].filter((s) => s === 'partial').length,
  };
}

function filterRows(facts, { category, companySlug } = {}) {
  return headline(facts).filter((f) => (!category || catOf(f) === category) && (!companySlug || f.company_slug === companySlug));
}

// Pricing-model mix over headline rows; n counts avtal, null model -> 'okand'.
export function pricingModelMix(facts, opts = {}) {
  const rows = filterRows(facts, opts);
  const total = distinct(rows, avtalOf);
  return [...groupBy(rows, (f) => f.pricing_model ?? UNKNOWN_CATEGORY)]
    .map(([model, group]) => {
      const n = distinct(group, avtalOf);
      return { model, n, share: total > 0 ? n / total : null };
    })
    .sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
}

// Channel mix over headline rows; a row bought directly is 'direkt'.
export function channelMix(facts, opts = {}) {
  const rows = filterRows(facts, opts);
  return [...groupBy(rows, (f) => f.channel_slug ?? 'direkt')]
    .map(([channel_slug, group]) => ({ channel_slug, n: distinct(group, avtalOf), value_known_sek: sumKnown(group) }))
    .sort((a, b) => b.value_known_sek - a.value_known_sek || b.n - a.n || a.channel_slug.localeCompare(b.channel_slug));
}
