// Studio facts and aggregates (2026-10-26 data-studio design §6.3, §8).
// Pure: every input is injected (storage rows, KommunStats, today). One fact
// row per avtal x owner company; the aggregators read only headline rows
// (active and not superseded). Unknown is null, never 0; medians and
// percentiles are suppressed below MIN_N.

import { classifyVendor, classifyLine, companyBySlug, productBySlug } from './catalogue.js';
import { GRADE_LEVELS, mapUnitToGradeLevels, normalizeAnnualValue } from './vendor-analytics.js';
import { computeNextReviewDate } from './contract-lifecycle.js';

export const MIN_N = 5;
export const UNKNOWN_COMPANY = 'Okänd leverantör';
// Category bucket for facts whose category is null (unknown or uncatalogued).
export const UNKNOWN_CATEGORY = 'okand';
export const KOMMUNER_TOTAL = 290;

const ACTIVE_YEARS = 4;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
const blank = (s) => typeof s !== 'string' || !s.trim();
const ELEV_UNIT = /\belev/i;

function cleanVendorName(raw) {
  const s = String(raw).replace(/\s*\(publ\)\s*$/i, '')
    .replace(/[\s,]+(sverige\s+)?(ab|aktiebolag)\.?$/i, '').replace(/\s+/g, ' ').trim();
  return s || String(raw).trim();
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

// Student count stated in the avtal's coverage rows. analyse-contract copies
// one entry's count onto every grade it lists, so per product the distinct
// counts are summed; products of one row cover the same pupils, so the max
// across products is taken. Returns { count, invalid }.
function coverageStudents(covRows) {
  const byProduct = new Map();
  let invalid = false;
  for (const r of covRows) {
    if (r.student_count != null && !(isFiniteNum(r.student_count) && r.student_count > 0)) invalid = true;
    if (!byProduct.has(r.product_name)) byProduct.set(r.product_name, []);
    byProduct.get(r.product_name).push(r.student_count);
  }
  let best = null;
  for (const counts of byProduct.values()) {
    if (!counts.every((n) => isFiniteNum(n) && n > 0)) continue;
    const sum = [...new Set(counts)].reduce((s, n) => s + n, 0);
    if (best == null || sum > best) best = sum;
  }
  return { count: best, invalid };
}

function newerKey(f) {
  return [
    (isIso(f.period_start) ? f.period_start.slice(0, 10) : isIso(f._received_at) ? f._received_at.slice(0, 10) : ''),
    isIso(f.period_end) ? f.period_end.slice(0, 10) : '',
    f.contract_id,
  ];
}
function isNewer(a, b) { // a newer than b
  const ka = newerKey(a); const kb = newerKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
  return false;
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
    const ownerOf = (r) => (r.companySlug && r.companySlug !== ownerSlug ? r.companySlug : '');
    const productsOf = (r) => (r.kind === 'bundle' ? r.products ?? [] : ['product', 'segment'].includes(r.kind) && r.productSlug ? [r.productSlug] : []);

    for (const l of linesBy.get(c.contract_id) ?? []) {
      const r = cls(l.product_name);
      const g = group(ownerOf(r));
      g.lines.push(l);
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
      const amounts = new Map(foreign.map((k) => {
        const known = groups.get(k).lines.map((l) => l.amount_sek).filter((a) => isFiniteNum(a) && a >= 0);
        return [k, known.length ? known.reduce((s, a) => s + a, 0) : null];
      }));
      const splitSum = [...amounts.values()].reduce((s, a) => s + (a ?? 0), 0);
      const consistent = annual != null && splitSum <= annual + 1;
      for (const k of foreign) values.set(k, consistent ? amounts.get(k) : null);
      const own = groups.get('');
      const ownHasProducts = own.products.size > 0 && vendor?.role !== 'channel';
      remainderBasis = annual == null ? null : (ownHasProducts && consistent ? 'split' : 'unsplit_channel');
      values.set('', annual == null ? null : consistent ? Math.max(0, Math.round(annual - splitSum)) : annual);
      // A channel that named nothing of its own and has nothing left over
      // gets no row of its own.
      if (consistent && values.get('') === 0 && own.products.size === 0 && own.lines.length === 0 && own.cov.length === 0) {
        groups.delete('');
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
        active: isActive(c, today),
        superseded: false,
        elever_in_scope: null,
        kr_per_elev: null,
        kr_per_elev_basis: null,
        attachment_id: c.attachment_id ?? null,
        _g: g,
        _owner: isOwner,
        _received_at: c.received_at ?? null,
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

  markSuperseded(facts);
  for (const f of facts) delete f._received_at;
  return facts;
}

function pricePerElev(r, { contract, singleRow, stats }) {
  const g = r._g;
  const unitLine = g.lines.find((l) => ELEV_UNIT.test(l.unit ?? '') && isFiniteNum(l.unit_price_sek) && l.unit_price_sek > 0);
  if (unitLine) {
    r.kr_per_elev = round2(unitLine.unit_price_sek);
    r.kr_per_elev_basis = 'styckpris';
    return;
  }
  if (singleRow && ELEV_UNIT.test(contract.unit ?? '') && isFiniteNum(contract.unit_price_sek) && contract.unit_price_sek > 0) {
    r.kr_per_elev = round2(contract.unit_price_sek);
    r.kr_per_elev_basis = 'styckpris';
    return;
  }
  if (r.segments.length === 0) return; // a kommun-wide licence without segments is not normalised
  const { count, invalid } = coverageStudents(g.cov);
  if (invalid) return; // a stated 0 or negative count is bad data, not a fallback
  let elever = null; let basis = null;
  if (count != null) {
    elever = count; basis = 'avtalets_elevantal';
  } else if (stats && !g.cov.some((cv) => cv.status === 'partial')) {
    const n = stats.eleverIn(r.kommun_kod, r.segments);
    if (isFiniteNum(n) && n > 0) { elever = n; basis = 'skolverket'; }
  }
  if (elever == null) return;
  r.elever_in_scope = elever;
  if (r.annual_value_sek == null || !['stated', 'split'].includes(r.value_basis)) return;
  const v = r.annual_value_sek / elever;
  if (!Number.isFinite(v)) return;
  r.kr_per_elev = round2(v);
  r.kr_per_elev_basis = basis;
}

// Of several avtal for one kommun x company x product, the newest counts.
function markSuperseded(facts) {
  const groups = groupBy(facts, (f) => `${f.kommun_kod}\u0000${companyKey(f)}`);
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    for (const r of rows) {
      r.superseded = rows.some((s) => s.contract_id !== r.contract_id && isNewer(s, r) && (
        r.product_slugs.length === 0
          ? s.product_slugs.length === 0
          : r.product_slugs.every((p) => s.product_slugs.includes(p))));
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
const catOf = (f) => f.category ?? UNKNOWN_CATEGORY;
const sumKnown = (rows) => rows.reduce((s, f) => s + (isFiniteNum(f.annual_value_sek) ? f.annual_value_sek : 0), 0);
const nKnown = (rows) => rows.filter((f) => isFiniteNum(f.annual_value_sek)).length;
const distinct = (rows, fn) => new Set(rows.map(fn)).size;
const hidden = (slug) => !!(slug && companyBySlug(slug)?.hiddenInStudio);
const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'sv');

// ---------------- aggregators ----------------

export function collectionStatus(conversations = []) {
  const by = groupBy(conversations.filter((c) => c && c.kommun_kod), (c) => c.kommun_kod);
  const out = new Map();
  for (const [kod, convs] of by) {
    if (convs.every((c) => c.state === 'INITIAL')) out.set(kod, 'not_contacted');
    else if (convs.every((c) => c.state === 'DONE' || c.state === 'DEAD_END')) out.set(kod, 'done');
    else out.set(kod, 'open');
  }
  return out;
}

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
      n_avtal: distinct(group, (f) => f.contract_id),
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
      n_avtal: distinct(group, (f) => f.contract_id),
      n_known: nKnown(group),
      kommuner: distinct(group, (f) => f.kommun_kod),
      topCompanies: companyShares(facts, { category }).slice(0, 3)
        .map((c) => ({ slug: c.slug, name: c.name, share: c.share_value })),
    });
  }
  return out.sort((a, b) => b.value_known_sek - a.value_known_sek || b.n_avtal - a.n_avtal || a.category.localeCompare(b.category));
}

export function priceDistribution(facts, { productSlug, category, segment, kommunKods } = {}) {
  const kods = kommunKods ? new Set(kommunKods) : null;
  const rows = headline(facts).filter((f) => isFiniteNum(f.kr_per_elev)
    && (!productSlug || f.product_slugs.includes(productSlug))
    && (!category || catOf(f) === category)
    && (!segment || f.segments.includes(segment))
    && (!kods || kods.has(f.kommun_kod)));
  const d = distribution(rows.map((f) => f.kr_per_elev));
  const values = d.suppressed ? [] : rows
    .map((f) => ({ kommun_kod: f.kommun_kod, kr_per_elev: f.kr_per_elev }))
    .sort((a, b) => a.kr_per_elev - b.kr_per_elev || String(a.kommun_kod).localeCompare(String(b.kommun_kod)));
  return { ...d, values };
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
  const buckets = Array.from({ length: months }, (_, i) => ({ month: addMonths(first, i), n: 0, value_known_sek: 0, byCategory: {} }));
  const index = new Map(buckets.map((b, i) => [b.month, i]));
  for (const f of headline(facts)) {
    if (!isIso(f.next_renewal) || f.next_renewal.slice(0, 10) < today) continue;
    const i = index.get(monthKey(f.next_renewal));
    if (i == null) continue;
    const b = buckets[i];
    const v = isFiniteNum(f.annual_value_sek) ? f.annual_value_sek : 0;
    b.n += 1; b.value_known_sek += v;
    const cat = catOf(f);
    b.byCategory[cat] ??= { n: 0, value_known_sek: 0 };
    b.byCategory[cat].n += 1; b.byCategory[cat].value_known_sek += v;
  }
  return buckets;
}

// allKods: the kommun universe (e.g. stats.all() kods); defaults to every
// kommun the status map or the facts know.
export function whiteSpots(facts, statusMap = new Map(), { category, allKods } = {}) {
  const kods = allKods ? [...new Set(allKods)] : [...new Set([...statusMap.keys(), ...facts.map((f) => f.kommun_kod)])];
  const has = new Set(headline(facts).filter((f) => !category || catOf(f) === category).map((f) => f.kommun_kod));
  const out = { has: [], none_done: [], none_open: [], not_contacted: [] };
  for (const kod of kods.filter(Boolean).sort()) {
    if (has.has(kod)) out.has.push(kod);
    else if (statusMap.get(kod) === 'done') out.none_done.push(kod);
    else if (statusMap.get(kod) === 'open') out.none_open.push(kod);
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
    n_avtal: distinct(group, (f) => f.contract_id),
    n_known: nKnown(group),
  })).sort((a, b) => b.value_known_sek - a.value_known_sek || a.category.localeCompare(b.category));
}

// peerMedianByCategory: { category: distribution } over peers' known spend in
// that category. A peer with no known value there is unknown, not 0.
export function kommunProfile(facts, stats, kod) {
  const rows = headline(facts);
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

  const renewals = mine.filter((f) => isIso(f.next_renewal))
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
  const activeIds = new Set(head.map((f) => f.contract_id));
  const unknownEnd = new Set(head.filter((f) => !isIso(f.period_end)).map((f) => f.contract_id));
  return {
    active: activeIds.size,
    active_unknown_end: unknownEnd.size,
    collected: distinct(facts, (f) => f.contract_id),
    kommuner_with_avtal: distinct(facts.filter((f) => f.kommun_kod), (f) => f.kommun_kod),
    kommuner_total: KOMMUNER_TOTAL,
    done: [...statusMap.values()].filter((s) => s === 'done').length,
  };
}
