// Pure analytics layer for the vendor data center
// (2026-07-09-vendor-data-center-design.md Part 2).
//
// Functions here return DATA, never HTML, so the same layer can later back a
// customer-facing export or API. Input rows come from db.listContractFacts()
// (one row per stored contract, is_contract=1) but nothing in this module
// touches a DB — everything is table-testable with plain objects.
//
// Honesty invariant: an unknown value is null — never 0, never a guess.
// Aggregates sum only known values and always come with completeness counts.

import { computeNextReviewDate } from './contract-lifecycle.js';

// ---- Grade-level coverage schema (2026-07-10-product-intelligence design) ----

// Canonical, fixed 9-level grade schema. Order matters: every consumer
// (matrix columns, mapper output) uses this order.
export const GRADE_LEVELS = Object.freeze([
  'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9',
  'Gymnasiet', 'Komvux', 'Introduktionsprogrammet', 'Högskola',
]);

// The levels a kommun actually operates — everything except Högskola.
// whole-municipality coverage expands to these, never to Högskola.
export const MUNICIPAL_GRADE_LEVELS = Object.freeze(GRADE_LEVELS.slice(0, 8));

const COMPULSORY_BANDS = ['1-3', '4-6', '7-9'];

// Map an "F-3"/"åk 4-6"/"F-Gy" range onto the bands it intersects.
// lo/hi live on the scale F=0, 1..9, Gy=10.
function rangeToLevels(lo, hi) {
  const out = [];
  if (lo === 0) out.push('Förskoleklass');
  for (const [band, s, e] of [['1-3', 1, 3], ['4-6', 4, 6], ['7-9', 7, 9]]) {
    if (Math.max(lo, 1) <= e && Math.min(hi, 9) >= s && hi >= 1 && lo <= 9) out.push(band);
  }
  if (hi === 10) out.push('Gymnasiet');
  return out;
}

// Pure Swedish-unit-description → canonical-band mapper (spec Feature 2).
// Honest by design: unrecognized text maps to NOTHING — never a guess.
// Anpassad skola / särskola is folded into the matching age bands (its
// students count toward 1-3/4-6/7-9/Gymnasiet): a qualified phrase
// ("anpassad grundskola", "gymnasiesärskola") folds into its own bands via
// the ordinary keyword rules; a bare "anpassad skola"/"särskola" with no
// age context folds into all four.
export function mapUnitToGradeLevels(unitText) {
  if (typeof unitText !== 'string' || !unitText.trim()) return [];
  const t = unitText.toLowerCase();
  const out = new Set();

  // Whole-municipality phrases → every municipal level.
  if (/hela kommunen|samtliga skolformer|alla skolformer|kommunövergripande/.test(t)) {
    for (const g of MUNICIPAL_GRADE_LEVELS) out.add(g);
  }

  // "F-3" / "åk 4-6" / "F-Gy" style ranges (hyphen or dash).
  for (const m of t.matchAll(/(?:åk\s*)?\b(f|[1-9])\s*[-–—]\s*(gy\w*|[1-9])\b/gi)) {
    const lo = m[1] === 'f' ? 0 : Number(m[1]);
    const hi = /^gy/.test(m[2]) ? 10 : Number(m[2]);
    for (const g of rangeToLevels(lo, hi)) out.add(g);
  }

  if (/förskoleklass/.test(t)) out.add('Förskoleklass');
  if (/förskol(a|an|or|orna)/.test(t)) out.add('Förskola');
  if (/grundskol/.test(t)) for (const g of COMPULSORY_BANDS) out.add(g);
  if (/gymnasi/.test(t)) out.add('Gymnasiet');
  if (/introduktionsprogram|\bim-program/.test(t)) out.add('Introduktionsprogrammet');
  if (/vuxenutbildning|komvux|\bsfi\b|svenska för invandrare/.test(t)) out.add('Komvux');
  if (/högskol|universitet/.test(t)) out.add('Högskola');

  // Anpassad skola / särskola folding. Qualified forms are already handled
  // above (grundsärskola matches nothing yet → handled here; anpassad
  // grundskola matched /grundskol/; gymnasiesärskola matched /gymnasi/).
  if (/grundsärskol/.test(t)) for (const g of COMPULSORY_BANDS) out.add(g);
  if (/anpassad|särskol/.test(t) && !/grundskol|grundsärskol|gymnasi/.test(t)) {
    for (const g of [...COMPULSORY_BANDS, 'Gymnasiet']) out.add(g);
  }

  return GRADE_LEVELS.filter((g) => out.has(g));
}

// ---- SEK/year normalization -------------------------------------------------

// Parse a Swedish-formatted amount ("612 500,00", "4 955 221") to a number.
// Spaces (incl. NBSP) are thousands separators; comma is the decimal mark.
function parseSekNumber(s) {
  const cleaned = String(s).replace(/[\s ]/g, '').replace(/\.$/, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const NUM = '([\\d][\\d\\s\\u00A0.,]*?)';

// Which contract year are we in? 1-based, computed from period_start; clamped
// by the caller to the listed schedule. Defaults to year 1 when the start (or
// now) is unusable — the first listed price is the least speculative.
function currentContractYear(periodStart, now) {
  if (!periodStart || !now) return 1;
  const start = new Date(periodStart + 'T00:00:00Z').getTime();
  if (Number.isNaN(start)) return 1;
  const elapsedDays = (now.getTime() - start) / 86400000;
  if (elapsedDays < 0) return 1;
  return Math.floor(elapsedDays / 365.25) + 1;
}

// Conservative text-parse of the raw avtalsvarde free text. Whitelisted
// shapes only (all observed in the live DB); anything else returns null.
// Exported for direct testing via normalizeAnnualValue.
function parseAvtalsvardeText(text, { periodStart = null, now = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text;

  // Explicitly free: "Ingen årlig abonnemangskostnad …". Requires "årlig" so a
  // bare "0 kr" (often about waived one-time fees) never reads as annual-0.
  if (/\bingen\s+årlig\b[^.;]*kostnad/i.test(t)) return 0;

  // Monthly → ×12. First match wins (the main service fee is listed first).
  const monthly = t.match(new RegExp(`${NUM}\\s*(?:sek|kr)\\s*(?:\\/|per\\s+)mån(?:ad)?`, 'i'));
  if (monthly) {
    const v = parseSekNumber(monthly[1]);
    if (v != null && v > 0) return Math.round(v * 12);
  }

  // "129 tkr/år" → ×1000.
  const tkr = t.match(new RegExp(`${NUM}\\s*tkr\\s*(?:\\/|per\\s+)år`, 'i'));
  if (tkr) {
    const v = parseSekNumber(tkr[1]);
    if (v != null && v > 0) return Math.round(v * 1000);
  }

  // A stated total beats the per-part figures: "(totalt 177 000 kr/år)".
  const totalt = t.match(new RegExp(`totalt\\s*${NUM}\\s*(?:sek|kr)\\s*(?:\\/|per\\s+)år`, 'i'));
  if (totalt) {
    const v = parseSekNumber(totalt[1]);
    if (v != null && v > 0) return Math.round(v);
  }

  // Plain annual: "612 500,00 kr/år", "30 000 SEK per år". Never matches
  // per-unit ("kr/elev/år") or per-period ("kr/2 år") shapes — the separator
  // must be immediately followed by "år" — and a trailing per-unit qualifier
  // ("110 000 kr/år per modul") makes the figure a unit price, not a total.
  const annual = t.match(new RegExp(`${NUM}\\s*(?:sek|kr)\\s*(?:\\/|per\\s+)år(?!\\s*(?:per\\b|\\/))`, 'i'));
  if (annual) {
    const v = parseSekNumber(annual[1]);
    if (v != null && v > 0) return Math.round(v);
  }

  // Per-elev with a machine-readable count: "40 kr/elev (3744 elever)".
  // First listed tier = current tier (live rows list the current year first).
  const perElev = t.match(new RegExp(`${NUM}\\s*kr\\s*(?:\\/|per\\s+)elev[^();]*\\(\\s*([\\d][\\d\\s\\u00A0]*)\\s*elever\\)`, 'i'));
  if (perElev) {
    const price = parseSekNumber(perElev[1]);
    const count = parseSekNumber(perElev[2]);
    if (price != null && count != null && price > 0 && count > 0) return Math.round(price * count);
  }

  // Escalating schedule: "585 649 SEK år 1, 615 767 SEK år 2, …" (and the
  // reversed "År 1: … 11 000 kr" form). Pick the current contract year,
  // clamped to the listed years.
  const schedule = new Map();
  for (const m of t.matchAll(new RegExp(`${NUM}\\s*(?:sek|kr)\\s*år\\s*(\\d+)`, 'gi'))) {
    const v = parseSekNumber(m[1]);
    if (v != null && v > 0) schedule.set(Number(m[2]), v);
  }
  // The amount must not be a per-unit price ("från år 2: 85 kr per elevlicens").
  for (const m of t.matchAll(new RegExp(`år\\s*(\\d+)\\s*:\\s*(?:[a-zåäö]+\\s+)?${NUM}\\s*(?:sek|kr)(?!\\s*(?:per\\b|\\/))`, 'gi'))) {
    const v = parseSekNumber(m[2]);
    if (v != null && v > 0 && !schedule.has(Number(m[1]))) schedule.set(Number(m[1]), v);
  }
  if (schedule.size > 0) {
    const years = [...schedule.keys()].sort((a, b) => a - b);
    const y = Math.min(Math.max(currentContractYear(periodStart, now), years[0]), years[years.length - 1]);
    // Exact year if listed, otherwise the nearest listed year below.
    const pick = years.filter((n) => n <= y).pop() ?? years[0];
    return Math.round(schedule.get(pick));
  }

  return null;
}

// Normalize one contract row to SEK per year. Precedence:
//   1. analyser-provided annual_value_sek (finite, >= 0 — an explicit 0 is
//      a true zero, e.g. "Ingen årlig abonnemangskostnad")
//   2. pricing_model 'free' → 0
//   3. unit_price_sek × quantity for per-unit models
//   4. conservative parse of the raw avtalsvarde text (pre-backfill rows)
// Returns null when genuinely unknown — never 0 for unknown, never a guess.
export function normalizeAnnualValue(contract, { now = null } = {}) {
  if (!contract) return null;

  if (typeof contract.annual_value_sek === 'number'
      && Number.isFinite(contract.annual_value_sek)
      && contract.annual_value_sek >= 0) {
    return Math.round(contract.annual_value_sek);
  }

  if (contract.pricing_model === 'free') return 0;

  if ((contract.pricing_model === 'per_student' || contract.pricing_model === 'per_user')
      && Number.isFinite(contract.unit_price_sek) && contract.unit_price_sek > 0
      && Number.isFinite(contract.quantity) && contract.quantity > 0) {
    return Math.round(contract.unit_price_sek * contract.quantity);
  }

  // Text fallback is SEK-only; a foreign valuta makes "kr"-looking text suspect.
  if (contract.valuta && String(contract.valuta).toUpperCase() !== 'SEK') return null;
  return parseAvtalsvardeText(contract.avtalsvarde, {
    periodStart: contract.period_start ?? null, now,
  });
}

// ---- flat contract-facts dataset --------------------------------------------

function isoDateMs(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const t = new Date(s.slice(0, 10) + 'T00:00:00Z').getTime();
  return Number.isNaN(t) ? null : t;
}

// Whole months between two ISO dates (average month length), null when either
// is missing/unparseable or the span is non-positive.
export function contractLengthMonths(periodStart, periodEnd) {
  const a = isoDateMs(periodStart);
  const b = isoDateMs(periodEnd);
  if (a == null || b == null || b <= a) return null;
  return Math.round((b - a) / 86400000 / 30.4375);
}

function toBoolOrNull(v) {
  return v == null ? null : !!v;
}

// One flat row per contract — the dataset behind the market table, the
// dossier, and the client-side explorer (embedded as JSON). `rows` is
// db.listContractFacts() output; `lanByKommunKod` maps kommun_kod → län.
export function buildContractFacts(rows, { lanByKommunKod = new Map(), now }) {
  if (!now) throw new Error('buildContractFacts requires an explicit now');
  return rows.map((r) => ({
    contract_id: r.contract_id,
    vendor_id: r.vendor_id ?? null,
    vendor_name: r.vendor_name ?? null,
    vendor_slug: r.vendor_slug ?? null,
    kommun_kod: r.kommun_kod,
    kommun_namn: r.kommun_namn,
    lan: lanByKommunKod.get(r.kommun_kod) ?? null,
    annual_value_sek: normalizeAnnualValue(r, { now }),
    one_time_value_sek: r.one_time_value_sek ?? null,
    pricing_model: r.pricing_model ?? null,
    unit_price_sek: r.unit_price_sek ?? null,
    unit: r.unit ?? null,
    quantity: r.quantity ?? null,
    value_incl_moms: toBoolOrNull(r.value_incl_moms),
    avtalsvarde: r.avtalsvarde ?? null,
    period_start: r.period_start ?? null,
    period_end: r.period_end ?? null,
    contract_length_months: contractLengthMonths(r.period_start, r.period_end),
    auto_renews: toBoolOrNull(r.auto_renews),
    next_review_date: computeNextReviewDate(r, now),
    products: r.products ?? [],
    attachment_id: r.attachment_id,
    filename: r.filename ?? null,
    received_at: r.received_at ?? null,
  }));
}

// ---- rollups & summaries -----------------------------------------------------

function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Earliest review date at/after today. Facts with null dates are skipped.
function nextFutureDate(facts, now) {
  const today = now.toISOString().slice(0, 10);
  const future = facts.map((f) => f.next_review_date).filter((d) => d != null && d >= today).sort();
  return future[0] ?? null;
}

// Per-vendor market rollup. Vendor-less contracts (vendor unknown) stay in
// the facts/explorer/completeness but do not form a vendor row here.
// Sorted by total known annual SEK desc; vendors with no known value last.
export function buildVendorRollups(facts, { now }) {
  if (!now) throw new Error('buildVendorRollups requires an explicit now');
  const byVendor = new Map();
  for (const f of facts) {
    if (f.vendor_id == null) continue;
    if (!byVendor.has(f.vendor_id)) byVendor.set(f.vendor_id, []);
    byVendor.get(f.vendor_id).push(f);
  }

  const rollups = [];
  for (const group of byVendor.values()) {
    const known = group.filter((f) => f.annual_value_sek != null);
    const lengths = group.map((f) => f.contract_length_months).filter((n) => n != null).sort((a, b) => a - b);
    const mix = {};
    for (const f of group) {
      if (f.pricing_model) mix[f.pricing_model] = (mix[f.pricing_model] ?? 0) + 1;
    }
    // Dominant = most frequent (excluding 'unknown'); ties break alphabetically
    // so the result is deterministic.
    const dominant = Object.entries(mix)
      .filter(([m]) => m !== 'unknown')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    const studentPrices = group
      .filter((f) => f.unit === 'elev' && Number.isFinite(f.unit_price_sek))
      .map((f) => f.unit_price_sek);
    rollups.push({
      vendor_id: group[0].vendor_id,
      vendor_name: group[0].vendor_name,
      vendor_slug: group[0].vendor_slug,
      contract_count: group.length,
      kommun_count: new Set(group.map((f) => f.kommun_kod)).size,
      total_annual_sek: known.length ? known.reduce((s, f) => s + f.annual_value_sek, 0) : null,
      value_known_count: known.length,
      pricing_model_mix: mix,
      dominant_pricing_model: dominant,
      avg_length_months: lengths.length ? Math.round(lengths.reduce((s, n) => s + n, 0) / lengths.length) : null,
      median_length_months: median(lengths),
      length_known_count: lengths.length,
      price_per_student_min: studentPrices.length ? Math.min(...studentPrices) : null,
      price_per_student_max: studentPrices.length ? Math.max(...studentPrices) : null,
      // "Snitt per kommun" KPI (2026-07-10 design): total KNOWN annual ÷
      // distinct kommuner. Null (never 0) when no value is known; the view
      // pairs it with the value-completeness line.
      avg_annual_per_kommun: known.length
        ? Math.round(known.reduce((s, f) => s + f.annual_value_sek, 0) / new Set(group.map((f) => f.kommun_kod)).size)
        : null,
      products: [...new Set(group.flatMap((f) => f.products))].sort((a, b) => a.localeCompare(b, 'sv')),
      next_renewal_date: nextFutureDate(group, now),
    });
  }

  return rollups.sort((a, b) =>
    (b.total_annual_sek ?? -1) - (a.total_annual_sek ?? -1)
    || b.kommun_count - a.kommun_count
    || String(a.vendor_name).localeCompare(String(b.vendor_name), 'sv'));
}

// ---- Per-product rollups: line-item pricing + coverage matrix --------------
// (2026-07-10-product-intelligence design.) `facts` is one vendor's contract
// facts (the dossier's slice); `lineItems`/`coverage` are DB rows from
// db.listLineItems()/db.listCoverage() — rows for other vendors' contracts
// are ignored via the contract_id join, so passing the full tables is safe.

// Aggregated colour for one (product, grade) over the kommuner with known
// coverage for the product:
//   green   — full in ALL of them
//   yellow  — partial somewhere, or mixed full/absent across kommuner
//   red     — no kommun covers the level AND at least one of the lacking
//             kommuner is collection-complete, so "sold elsewhere, not here"
//             is a confident claim
//   unknown — no kommun covers the level, but every lacking kommun's
//             collection is still in progress — we can't claim red yet
//   na      — the level is never referenced by any contract of this vendor,
//             or the product has no extracted coverage at all (unknown ≠ red).
// `doneKods` is the Set of kommun_kods whose collection is complete (>=1
// conversation, all DONE — see storage.listKommunerWithContracts). Omitted
// (null) → legacy behavior: every kommun treated as complete, red stays red.
// `resellerKods` is the Set of kommun_kods that procure via a framework/
// reseller channel (non-empty reseller_channels): such a kommun can HAVE a
// product without a direct contract, so it can never anchor a confident red —
// red needs >=1 complete AND non-reseller kommun lacking the level; when the
// only lacking kommuner are in-progress or reseller-procuring → unknown.
export function buildProductRollups(facts, lineItems = [], coverage = [], { doneKods = null, resellerKods = null } = {}) {
  const factById = new Map(facts.map((f) => [f.contract_id, f]));
  const li = lineItems.filter((r) => factById.has(r.contract_id));
  const cov = coverage.filter((r) => factById.has(r.contract_id));

  // Product universe: named on contracts, in line items, or in coverage.
  const names = new Set();
  for (const f of facts) for (const p of f.products ?? []) names.add(p);
  for (const r of li) names.add(r.product_name);
  for (const r of cov) names.add(r.product_name);

  // Vendor-level applicability: a grade the vendor never references is "–"
  // for every product (not-applicable), so red keeps its meaning.
  const applicable = new Set(cov.map((r) => r.grade_level));

  const rollups = [];
  for (const name of names) {
    // Selling kommuner: any contract naming the product (or carrying its
    // line items / coverage rows).
    const kommunNames = new Map(); // kod → namn
    for (const f of facts) {
      if ((f.products ?? []).includes(name)) kommunNames.set(f.kommun_kod, f.kommun_namn);
    }
    for (const r of [...li, ...cov]) {
      if (r.product_name !== name) continue;
      const f = factById.get(r.contract_id);
      kommunNames.set(f.kommun_kod, f.kommun_namn);
    }
    const kommunKods = [...kommunNames.keys()].sort((a, b) =>
      kommunNames.get(a).localeCompare(kommunNames.get(b), 'sv'));

    // Per-kommun price = Σ amount_sek of the product's line items in that
    // kommun's contracts. No line items → null ("ingår, ospecificerat pris").
    const priceByKommun = kommunKods.map((kod) => {
      const amounts = li.filter((r) => r.product_name === name
        && factById.get(r.contract_id).kommun_kod === kod
        && r.amount_sek != null);
      return {
        kommun_kod: kod,
        kommun_namn: kommunNames.get(kod),
        amount_sek: amounts.length ? Math.round(amounts.reduce((s, r) => s + r.amount_sek, 0)) : null,
      };
    });
    const knownPrices = priceByKommun.map((p) => p.amount_sek).filter((v) => v != null);
    const priceRange = knownPrices.length
      ? { min: Math.min(...knownPrices), max: Math.max(...knownPrices) }
      : null;

    // Dominant pricing model over the contracts that name the product.
    const mix = {};
    for (const f of facts) {
      if ((f.products ?? []).includes(name) && f.pricing_model) {
        mix[f.pricing_model] = (mix[f.pricing_model] ?? 0) + 1;
      }
    }
    const dominantPricingModel = Object.entries(mix)
      .filter(([m]) => m !== 'unknown')
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

    // Coverage per kommun: kod → Map(grade → { status, student_count }),
    // full beating partial when a kommun has several contracts.
    const covByKommun = new Map();
    for (const r of cov) {
      if (r.product_name !== name) continue;
      const f = factById.get(r.contract_id);
      if (!covByKommun.has(f.kommun_kod)) covByKommun.set(f.kommun_kod, new Map());
      const grades = covByKommun.get(f.kommun_kod);
      const prev = grades.get(r.grade_level);
      if (!prev || (prev.status !== 'full' && r.status === 'full')) {
        grades.set(r.grade_level, { status: r.status, student_count: r.student_count ?? null });
      }
    }
    const coverageKnown = covByKommun.size > 0;

    const coverageByGrade = {};
    const coverageDetail = {};
    for (const g of GRADE_LEVELS) {
      const detail = kommunKods
        .filter((kod) => covByKommun.get(kod)?.has(g))
        .map((kod) => ({
          kommun_kod: kod,
          kommun_namn: kommunNames.get(kod),
          status: covByKommun.get(kod).get(g).status,
          student_count: covByKommun.get(kod).get(g).student_count,
        }));
      coverageDetail[g] = detail;
      if (!coverageKnown || !applicable.has(g)) {
        coverageByGrade[g] = 'na';
      } else if (detail.length === 0) {
        // Red is a confident negative — it needs at least one lacking kommun
        // whose collection is finished AND that does not procure via a
        // framework/reseller channel (the product could reach it that way).
        // All-in-progress or all-via-reseller → unknown, not red.
        const confident = [...covByKommun.keys()].some((kod) =>
          (doneKods == null || doneKods.has(kod))
          && !(resellerKods != null && resellerKods.has(kod)));
        coverageByGrade[g] = confident ? 'red' : 'unknown';
      } else if (detail.length === covByKommun.size && detail.every((d) => d.status === 'full')) {
        coverageByGrade[g] = 'green';
      } else {
        coverageByGrade[g] = 'yellow';
      }
    }

    rollups.push({
      name,
      kommunCount: kommunKods.length,
      kommuns: kommunKods.map((kod) => kommunNames.get(kod)),
      priceByKommun,
      priceRange,
      dominantPricingModel,
      coverageKnown,
      coverageByGrade,
      coverageDetail,
    });
  }

  return rollups.sort((a, b) =>
    b.kommunCount - a.kommunCount || a.name.localeCompare(b.name, 'sv'));
}

// ---- Product-coverage drill-down: kommun × grade for ONE product ------------

// Product-name slug — the SAME rule as vendor slugs in storage.js
// (upsertVendor), so /leverantor/:slug/produkt/:productSlug reads uniformly.
export function slugifyProductName(name) {
  return String(name ?? '').toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// The dossier's product×grade matrix pivoted for one product: rows are
// kommuner, columns the 9 grade levels. `dataKommuner` is EVERY kommun we
// hold any stored contract for (db.listKommunerWithContracts()), each row
// carrying `collection_done` (>=1 conversation, all DONE). Per-cell states:
//   full/partial — this kommun's contract covers the level (fully / partly);
//                  a positive stands regardless of collection state
//   none         — collection-complete, NON-reseller kommun, no coverage of
//                  this product here → a CONFIDENT "not sold to them"
//   unknown      — kommun lacks the product/level but either its collection
//                  is still in progress (or DEAD_END) — "vet inte än" — or it
//                  procures via a framework/reseller channel (non-empty
//                  reseller_channels), so the product may reach it via the
//                  channel without a direct contract ("kan finnas via
//                  ramavtal"). Never red in either case.
//   na           — exactly where buildProductRollups says 'na' (the vendor
//                  never references the level, or no coverage extracted at all)
// A dataKommuner row without a collection_done flag is treated as complete
// (legacy callers keep the old confident-red behavior). Rows are passed
// through with reseller_channels + collection_done so views can badge the
// kommun and word the unknown tooltip by reason.
// `facts` is the vendor's contract-fact slice; the grade aggregation is
// buildProductRollups itself — shared, not forked. Product match is
// case-insensitive; returns null when the vendor has no such product.
export function buildProductCoverageByKommun({ vendorName, productName, facts = [], lineItems = [], coverage = [], dataKommuner = [] }) {
  const wanted = String(productName ?? '').toLowerCase();
  const doneKods = new Set(dataKommuner
    .filter((k) => k.collection_done !== false)
    .map((k) => k.kommun_kod));
  const resellerKods = new Set(dataKommuner
    .filter((k) => (k.reseller_channels ?? []).length > 0)
    .map((k) => k.kommun_kod));
  const rollup = buildProductRollups(facts, lineItems, coverage, { doneKods, resellerKods })
    .find((p) => p.name.toLowerCase() === wanted);
  if (!rollup) return null;

  // Selling kommuner: any contract naming the product (kods via priceByKommun,
  // which buildProductRollups derives from the same kommun universe).
  const sellingKods = new Set(rollup.priceByKommun.map((p) => p.kommun_kod));

  const kommuner = [...dataKommuner]
    .sort((a, b) => a.kommun_namn.localeCompare(b.kommun_namn, 'sv'))
    .map(({ kommun_kod, kommun_namn, collection_done, reseller_channels }) => {
      const coverageByGrade = {};
      for (const g of GRADE_LEVELS) {
        if (rollup.coverageByGrade[g] === 'na') {
          coverageByGrade[g] = 'na';
          continue;
        }
        const d = rollup.coverageDetail[g].find((x) => x.kommun_kod === kommun_kod);
        coverageByGrade[g] = d
          ? (d.status === 'full' ? 'full' : 'partial')
          : (doneKods.has(kommun_kod) && !resellerKods.has(kommun_kod) ? 'none' : 'unknown');
      }
      return {
        kommun_kod,
        kommun_namn,
        collection_done: collection_done !== false,
        reseller_channels: reseller_channels ?? [],
        coverageByGrade,
      };
    });

  return {
    vendorName,
    productName: rollup.name,
    kommuner,
    summary: {
      kommun_total: dataKommuner.length,
      kommun_with_product: dataKommuner.filter((k) => sellingKods.has(k.kommun_kod)).length,
    },
  };
}

// Non-null count for any fact key — drives every "känd för X av Y avtal" line.
export function completeness(facts, key) {
  return {
    known: facts.filter((f) => f[key] != null).length,
    total: facts.length,
  };
}

// Headline KPIs for the market overview.
export function buildMarketSummary(facts, { now }) {
  if (!now) throw new Error('buildMarketSummary requires an explicit now');
  const today = now.toISOString().slice(0, 10);
  const horizon = new Date(now.getTime() + 365 * 86400000).toISOString().slice(0, 10);
  const known = facts.filter((f) => f.annual_value_sek != null);
  return {
    vendor_count: new Set(facts.map((f) => f.vendor_id).filter((v) => v != null)).size,
    kommun_count: new Set(facts.map((f) => f.kommun_kod)).size,
    contract_count: facts.length,
    total_annual_sek: known.length ? known.reduce((s, f) => s + f.annual_value_sek, 0) : null,
    value_completeness: completeness(facts, 'annual_value_sek'),
    renewals_within_12mo: facts.filter((f) =>
      f.next_review_date != null && f.next_review_date >= today && f.next_review_date <= horizon).length,
  };
}
