// Pure slice-and-dice logic for the /leverantorer contract explorer.
// Browser-safe ESM with zero imports: loaded by public/explorer.js in the
// browser AND unit-tested directly by vitest (tests/explorer-core.test.js).
// No DOM access here — public/explorer.js owns the (untested) glue.
//
// A "fact" is one row of the contract-facts dataset the server embeds as
// JSON (built by src/vendor-analytics.js buildContractFacts). The honesty
// rule carries through: null means unknown and buckets as 'okänt' — it is
// never coerced to 0 and never silently dropped from counts.

export const UNKNOWN = 'okänt';

export const PRICING_MODEL_LABELS = {
  per_student: 'per elev',
  per_user: 'per användare',
  fixed: 'fast pris',
  tiered: 'trappa',
  usage: 'förbrukning',
  one_time: 'engångsköp',
  free: 'kostnadsfritt',
  unknown: 'okänd modell',
};

// ---- band bucketing ----------------------------------------------------------

export function valueBand(annualSek) {
  if (annualSek == null) return UNKNOWN;
  if (annualSek === 0) return '0 kr';
  if (annualSek < 100000) return '< 100 tkr';
  if (annualSek < 500000) return '100–500 tkr';
  if (annualSek < 1000000) return '0,5–1 mkr';
  return '> 1 mkr';
}

export function lengthBand(months) {
  if (months == null) return UNKNOWN;
  if (months <= 12) return '≤ 1 år';
  if (months <= 24) return '1–2 år';
  if (months <= 48) return '2–4 år';
  return '> 4 år';
}

// Days from todayIso (YYYY-MM-DD) to an ISO date; negative = past.
function daysFromToday(iso, todayIso) {
  const t = Date.parse(iso + 'T00:00:00Z');
  const today = Date.parse(todayIso + 'T00:00:00Z');
  if (Number.isNaN(t) || Number.isNaN(today)) return null;
  return Math.round((t - today) / 86400000);
}

export function renewalWindow(f, todayIso) {
  if (!f.next_review_date) return UNKNOWN;
  const d = daysFromToday(f.next_review_date, todayIso);
  if (d == null) return UNKNOWN;
  if (d < 0) return 'passerat';
  if (d <= 92) return 'inom 3 mån';
  if (d <= 365) return 'inom 12 mån';
  return 'senare';
}

// ---- dimension access ---------------------------------------------------------

// One canonical accessor per filter/group dimension. Returns the bucket key
// for a fact ('okänt' for null); 'product' is multi-valued and handled apart.
function dimValue(f, dim, todayIso) {
  switch (dim) {
    case 'lan': return f.lan ?? UNKNOWN;
    case 'vendor': return f.vendor_name ?? UNKNOWN;
    case 'kommun': return f.kommun_namn ?? UNKNOWN;
    case 'pricing_model': return f.pricing_model ?? UNKNOWN;
    case 'value_band': return valueBand(f.annual_value_sek);
    case 'length_band': return lengthBand(f.contract_length_months);
    case 'renewal_window': return renewalWindow(f, todayIso);
    default: return UNKNOWN;
  }
}

// ---- options / filters / grouping ---------------------------------------------

function sortedSv(values) {
  return [...values].sort((a, b) => a.localeCompare(b, 'sv'));
}

// Distinct filter options per dimension, sorted sv-SE; a trailing 'okänt'
// entry appears only where the data actually has nulls.
export function deriveOptions(facts) {
  const collect = (get) => {
    const known = new Set();
    let hasUnknown = false;
    for (const f of facts) {
      const v = get(f);
      if (v == null) hasUnknown = true;
      else known.add(v);
    }
    return sortedSv(known).concat(hasUnknown ? [UNKNOWN] : []);
  };
  return {
    lan: collect((f) => f.lan),
    vendor: collect((f) => f.vendor_name),
    pricing_model: collect((f) => f.pricing_model),
    product: sortedSv(new Set(facts.flatMap((f) => f.products ?? []))),
  };
}

// AND-combine active filters. A filter is active when its value is a
// non-empty string; 'okänt' selects the null bucket of that dimension.
export function applyFilters(facts, filters, todayIso) {
  const active = Object.entries(filters ?? {}).filter(([, v]) => typeof v === 'string' && v !== '');
  return facts.filter((f) => active.every(([key, value]) => {
    if (key === 'q') {
      const q = value.toLowerCase();
      return [f.vendor_name, f.kommun_namn, ...(f.products ?? [])]
        .some((s) => s != null && s.toLowerCase().includes(q));
    }
    if (key === 'product') return (f.products ?? []).includes(value);
    return dimValue(f, key, todayIso) === value;
  }));
}

// Group facts by a dimension → [{ key, facts }], sorted by known annual
// total desc (then size, then label). 'product' is multi-membership: a
// contract covering two products appears under both; product-less contracts
// land in 'okänt'. Empty dim = one group with everything.
export function groupFacts(facts, dim, todayIso) {
  if (!dim) return [{ key: null, facts: [...facts] }];
  const groups = new Map();
  const add = (key, f) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  };
  for (const f of facts) {
    if (dim === 'product') {
      const products = f.products ?? [];
      if (products.length === 0) add(UNKNOWN, f);
      for (const p of products) add(p, f);
    } else {
      add(dimValue(f, dim, todayIso), f);
    }
  }
  return [...groups.entries()]
    .map(([key, groupFacts]) => ({ key, facts: groupFacts }))
    .sort((a, b) => {
      const ta = aggregateFacts(a.facts).total_annual_sek ?? -1;
      const tb = aggregateFacts(b.facts).total_annual_sek ?? -1;
      return tb - ta || b.facts.length - a.facts.length || a.key.localeCompare(b.key, 'sv');
    });
}

// Running totals for a (filtered) fact set, with honest completeness:
// total_annual_sek sums the value_known facts only, and is null — not 0 —
// when nothing is known.
export function aggregateFacts(facts) {
  const known = facts.filter((f) => f.annual_value_sek != null);
  return {
    count: facts.length,
    value_known: known.length,
    total_annual_sek: known.length ? known.reduce((s, f) => s + f.annual_value_sek, 0) : null,
    kommun_count: new Set(facts.map((f) => f.kommun_kod)).size,
    vendor_count: new Set(facts.map((f) => f.vendor_id).filter((v) => v != null)).size,
  };
}
