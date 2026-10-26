// /studio/utforska (spec §7.5 item 7): slice the avtal any way you like.
// Reuses public/explorer-core.js (applyFilters, groupFacts, aggregateFacts)
// server-side by mapping studio facts to the field names it reads; that
// module is shared with the back office and is not changed here. A chart of
// the current grouping comes first, then a table paginated 50 rows per page,
// so the page never ships the whole dataset.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, UNKNOWN } from '../format.js';
import { CATEGORIES, companyBySlug } from '../../catalogue.js';
import { UNKNOWN_CATEGORY, companyKey } from '../../studio-data.js';
import { contractLengthMonths } from '../../vendor-analytics.js';
import { applyFilters, groupFacts, aggregateFacts, UNKNOWN as CORE_UNKNOWN } from '../../../public/explorer-core.js';
import { filterBar, emptyPanel } from '../components.js';
import { rankingBars } from '../charts.js';
import {
  isNum, isIso, headline, categoryLabel, companyHref, productHref, kommunHref, kommunNamer,
  productNames, section, nOf, modelLabel, MODEL_LABEL,
} from './common.js';

export const UTFORSKA_PAGE_SIZE = 50;
const CHART_MAX = 10;

// explorer-core band keys carry en dashes and "≤", which studio copy never
// shows. The studio uses these labels in the URL and the page and maps them
// back to the core's keys before filtering.
const BAND_LABELS = Object.freeze({
  value_band: { '0 kr': '0 kr', '< 100 tkr': 'under 100 tkr', '100–500 tkr': '100 till 500 tkr', '0,5–1 mkr': '0,5 till 1 mkr', '> 1 mkr': 'över 1 mkr' },
  length_band: { '≤ 1 år': 'högst 1 år', '1–2 år': '1 till 2 år', '2–4 år': '2 till 4 år', '> 4 år': 'över 4 år' },
  renewal_window: { passerat: 'passerat', 'inom 3 mån': 'inom 3 mån', 'inom 12 mån': 'inom 12 mån', senare: 'senare' },
});
const fromLabel = (dim, label) => {
  if (label === UNKNOWN) return CORE_UNKNOWN;
  const hit = Object.entries(BAND_LABELS[dim] ?? {}).find(([, l]) => l === label);
  return hit ? hit[0] : null;
};

export const GROUPS = Object.freeze([
  { value: 'vendor', label: 'Leverantör' },
  { value: 'kategori', label: 'Kategori' },
  { value: 'product', label: 'Produkt' },
  { value: 'kommun', label: 'Kommun' },
  { value: 'lan', label: 'Län' },
  { value: 'pricing_model', label: 'Prismodell' },
  { value: 'value_band', label: 'Årsvärde' },
  { value: 'length_band', label: 'Avtalslängd' },
  { value: 'renewal_window', label: 'Förnyelse' },
]);
const GROUP_KEYS = new Set(GROUPS.map((g) => g.value));
export const DEFAULT_GROUP = 'vendor';

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');

export function parseUtforskaQuery(q = {}) {
  const grupp = str(q.grupp);
  return {
    q: str(q.q),
    kategori: str(q.kategori),
    vendor: str(q.vendor),
    product: str(q.product),
    lan: str(q.lan),
    pricing_model: str(q.pricing_model),
    value_band: str(q.value_band),
    length_band: str(q.length_band),
    renewal_window: str(q.renewal_window),
    urval: str(q.urval) === 'alla' ? 'alla' : '',
    grupp: GROUP_KEYS.has(grupp) ? grupp : DEFAULT_GROUP,
    gruppGiven: GROUP_KEYS.has(grupp),
  };
}

function lanOf(stats, kod) {
  try { return stats?.get?.(kod)?.lan ?? null; } catch { return null; }
}

// Studio facts in the shape explorer-core reads. One row per avtal x owner;
// the value of a split channel avtal is already divided between its rows.
export function explorerFacts({ facts, stats, all = false }) {
  const nameOf = kommunNamer(stats, facts);
  return (all ? facts : headline(facts))
    .filter((f) => !(f.company_slug && companyBySlug(f.company_slug)?.hiddenInStudio))
    .map((f) => ({
      ...f,
      vendor_name: f.company_name,
      vendor_id: companyKey(f),
      products: productNames(f),
      kommun_namn: nameOf(f.kommun_kod),
      lan: lanOf(stats, f.kommun_kod),
      contract_length_months: contractLengthMonths(f.period_start, f.period_end) ?? null,
      next_review_date: isIso(f.next_renewal) ? f.next_renewal.slice(0, 10) : null,
      kategori: f.category ?? UNKNOWN_CATEGORY,
    }));
}

function coreFilters(q) {
  const out = {};
  for (const k of ['q', 'vendor', 'product', 'lan', 'pricing_model']) if (q[k]) out[k] = q[k] === UNKNOWN ? CORE_UNKNOWN : q[k];
  for (const k of ['value_band', 'length_band', 'renewal_window']) {
    if (!q[k]) continue;
    out[k] = fromLabel(k, q[k]) ?? '\u0000no-match';
  }
  return out;
}

export function filteredFacts({ rows, q, today }) {
  const pre = q.kategori ? rows.filter((f) => f.kategori === q.kategori) : rows;
  return applyFilters(pre, coreFilters(q), today);
}

function groupLabel(dim, key) {
  if (key == null || key === CORE_UNKNOWN) {
    return { pricing_model: 'Okänd prismodell', product: 'Ingen känd produkt', lan: 'Okänt län', vendor: 'Okänd leverantör' }[dim] ?? 'Okänt';
  }
  if (dim === 'pricing_model') return modelLabel(key) ?? key;
  if (dim === 'kategori') return categoryLabel(key === UNKNOWN_CATEGORY ? null : key);
  if (BAND_LABELS[dim]) return BAND_LABELS[dim][key] ?? key;
  return key;
}

export function groupRows(rows, dim, today) {
  if (dim === 'kategori') {
    const m = new Map();
    for (const f of rows) {
      if (!m.has(f.kategori)) m.set(f.kategori, []);
      m.get(f.kategori).push(f);
    }
    return [...m.entries()].map(([key, fs]) => ({ key, facts: fs }))
      .sort((a, b) => (aggregateFacts(b.facts).total_annual_sek ?? -1) - (aggregateFacts(a.facts).total_annual_sek ?? -1) || b.facts.length - a.facts.length);
  }
  return groupFacts(rows, dim, today);
}

const distinctAvtal = (fs) => new Set(fs.map((f) => f.contract_id)).size;

function groupHref(dim, key, first) {
  if (key == null || key === CORE_UNKNOWN) return null;
  if (dim === 'vendor') return first?.company_slug ? companyHref(first.company_slug) : null;
  if (dim === 'kommun') return first?.kommun_kod ? kommunHref(first.kommun_kod) : null;
  if (dim === 'kategori') return key !== UNKNOWN_CATEGORY ? `/studio/kategori/${encodeURIComponent(key)}` : null;
  return null;
}

function groupChart({ groups, dim }) {
  if (dim === 'kommun') {
    // Kommuner are never ranked by what they pay (spec §4): this grouping
    // counts avtal per kommun instead of summing value.
    const items = groups.map((g) => {
      const n = distinctAvtal(g.facts);
      return { label: groupLabel(dim, g.key), href: groupHref(dim, g.key, g.facts[0]), value: n, valueLabel: nOf(n, 'avtal', 'avtal'), sub: nOf(new Set(g.facts.map((f) => f.company_name)).size, 'leverantör', 'leverantörer') };
    }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
    return rankingBars({ items, max: CHART_MAX, noun: 'kommuner' });
  }
  const items = groups.map((g) => {
    const agg = aggregateFacts(g.facts);
    const n = distinctAvtal(g.facts);
    const known = distinctAvtal(g.facts.filter((f) => isNum(f.annual_value_sek)));
    return {
      label: groupLabel(dim, g.key),
      href: groupHref(dim, g.key, g.facts[0]),
      value: agg.total_annual_sek,
      valueLabel: agg.total_annual_sek == null ? null : `${fmtKrCompact(agg.total_annual_sek)}/år`,
      sub: `${nOf(n, 'avtal', 'avtal')}, ${nOf(agg.kommun_count, 'kommun', 'kommuner')}${agg.total_annual_sek == null ? ', värde okänt' : known < n ? `, värde känt för ${fmtInt(known)}` : ''}`,
    };
  });
  return rankingBars({ items, max: CHART_MAX, noun: 'grupper' });
}

function periodText(f) {
  const s = isIso(f.period_start) ? f.period_start.slice(0, 10) : null;
  const e = isIso(f.period_end) ? f.period_end.slice(0, 10) : null;
  if (s && e) return `${s} till ${e}`;
  if (s) return `från ${s}`;
  if (e) return `till ${e}`;
  return UNKNOWN;
}

function valueCell(f) {
  // A samverkansavtal: the whole avtal's value on every copy, never a share.
  if (f.joint && isNum(f.joint.whole_value_sek)) return `${esc(fmtKrCompact(f.joint.whole_value_sek))}<small>hela samverkansavtalet, kopior från ${esc(String(f.joint.n_kommuner))} kommuner, andel okänd</small>`;
  if (!isNum(f.annual_value_sek)) return `<span class="muted">${UNKNOWN}</span>`;
  const base = esc(fmtKrCompact(f.annual_value_sek));
  if (f.value_basis === 'split') return `${base}<small>egen del</small>`;
  if (f.value_basis === 'unsplit_channel') return `${base}<small>ej fördelat</small>`;
  return base;
}

function tableHtml(rows) {
  const body = rows.map((f) => {
    const co = companyHref(f.company_slug);
    const prods = f.product_slugs.map((slug) => {
      const name = productNames({ product_slugs: [slug] })[0];
      if (!name) return null;
      const h = productHref(slug);
      return h ? `<a href="${esc(h)}" data-pane-link>${esc(name)}</a>` : esc(name);
    }).filter(Boolean).join(', ');
    const status = f.superseded ? 'ersatt' : f.active ? null : 'utgånget';
    return `<tr${f.active && !f.superseded ? '' : ' class="is-old"'}>
      <td data-label="Kommun"><a href="${esc(kommunHref(f.kommun_kod))}" data-pane-link>${esc(f.kommun_namn)}</a></td>
      <td data-label="Leverantör">${co ? `<a href="${esc(co)}" data-pane-link>${esc(f.company_name)}</a>` : esc(f.company_name)}${f.channel_slug && f.channel_slug !== f.company_slug ? `<small>via ${esc(companyBySlug(f.channel_slug)?.canonical ?? f.channel_slug)}</small>` : ''}</td>
      <td data-label="Produkter">${prods || `<span class="muted">${UNKNOWN}</span>`}</td>
      <td data-label="Kategori">${esc(categoryLabel(f.category))}</td>
      <td data-label="Värde per år" class="r nowrap">${valueCell(f)}</td>
      <td data-label="Prismodell">${esc(modelLabel(f.pricing_model) ?? UNKNOWN)}</td>
      <td data-label="Period" class="nowrap">${esc(periodText(f))}${status ? `<small>${esc(status)}</small>` : ''}</td>
    </tr>`;
  }).join('');
  return `<table class="st-table cards ux-table">
  <thead><tr><th>Kommun</th><th>Leverantör</th><th>Produkter</th><th>Kategori</th><th class="r">Värde per år</th><th>Prismodell</th><th>Period</th></tr></thead>
  <tbody>${body}</tbody>
</table>`;
}

function pager({ total, page, pageHref }) {
  const pages = Math.max(1, Math.ceil(total / UTFORSKA_PAGE_SIZE));
  if (pages <= 1) return '';
  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - page) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return `<nav class="ev-pages" aria-label="Sidor">
    ${page > 1 ? `<a href="${esc(pageHref(page - 1))}" data-pane-link rel="prev">Föregående</a>` : '<span class="is-off">Föregående</span>'}
    ${nums.map((p) => (p === '…' ? '<span class="ev-gap">…</span>' : p === page ? `<span class="is-cur" aria-current="page">${p}</span>` : `<a href="${esc(pageHref(p))}" data-pane-link>${p}</a>`)).join('')}
    ${page < pages ? `<a href="${esc(pageHref(page + 1))}" data-pane-link rel="next">Nästa</a>` : '<span class="is-off">Nästa</span>'}
  </nav>`;
}

const FILTER_KEYS = ['q', 'kategori', 'vendor', 'product', 'lan', 'pricing_model', 'value_band', 'length_band', 'renewal_window', 'urval'];

function hrefFor(q, extra = {}) {
  const qs = new URLSearchParams();
  for (const k of FILTER_KEYS) if (q[k]) qs.set(k, q[k]);
  if (q.grupp !== DEFAULT_GROUP) qs.set('grupp', q.grupp);
  for (const [k, v] of Object.entries(extra)) if (v != null) qs.set(k, String(v));
  const s = qs.toString();
  return `/studio/utforska${s ? `?${s}` : ''}`;
}

const sortSv = (xs) => [...xs].sort((a, b) => a.localeCompare(b, 'sv'));

export function renderUtforska({ facts, stats, today, query, page = 1 }) {
  const q = query ?? parseUtforskaQuery();
  const base = explorerFacts({ facts, stats, all: q.urval === 'alla' });
  const rows = filteredFacts({ rows: base, q, today });
  const groups = groupRows(rows, q.grupp, today);
  const agg = aggregateFacts(rows);
  const nAvtal = distinctAvtal(rows);
  const nKnown = distinctAvtal(rows.filter((f) => isNum(f.annual_value_sek)));
  // Avtal whose only party is a hidden utbildningsanordnare are left out of
  // the explorer; say so, or the totals here disagree with Marknad unexplained.
  const pool = q.urval === 'alla' ? facts : headline(facts);
  const shown = new Set(base.map((f) => f.contract_id));
  const nHidden = new Set(pool.filter((f) => !shown.has(f.contract_id)).map((f) => f.contract_id)).size;

  const has = (get) => base.some((f) => get(f) == null);
  const opts = (get) => sortSv(new Set(base.map(get).filter((v) => v != null))).concat(has(get) ? [UNKNOWN] : []);
  const fields = [
    { name: 'q', label: 'Fritext', type: 'text', value: q.q, placeholder: 'kommun, leverantör, produkt' },
    { name: 'grupp', label: 'Gruppera efter', value: q.gruppGiven ? q.grupp : '', def: DEFAULT_GROUP, all: false, options: GROUPS },
    { name: 'urval', label: 'Avtal', value: q.urval, def: '', all: false, options: [{ value: '', label: 'Aktiva avtal' }, { value: 'alla', label: 'Alla insamlade' }] },
    { name: 'kategori', label: 'Kategori', value: q.kategori, options: [...CATEGORIES.map((c) => ({ value: c.slug, label: c.label })), { value: UNKNOWN_CATEGORY, label: 'Okänd kategori' }] },
    { name: 'vendor', label: 'Leverantör', value: q.vendor, options: opts((f) => f.company_name) },
    { name: 'product', secondary: true, label: 'Produkt', value: q.product, options: sortSv(new Set(base.flatMap((f) => f.products))) },
    { name: 'lan', secondary: true, label: 'Län', value: q.lan, options: opts((f) => f.lan) },
    { name: 'pricing_model', secondary: true, label: 'Prismodell', value: q.pricing_model, options: [...Object.entries(MODEL_LABEL).map(([value, label]) => ({ value, label })), { value: UNKNOWN, label: 'Okänd prismodell' }] },
    { name: 'value_band', secondary: true, label: 'Årsvärde', value: q.value_band, options: [...Object.values(BAND_LABELS.value_band), UNKNOWN] },
    { name: 'length_band', secondary: true, label: 'Avtalslängd', value: q.length_band, options: [...Object.values(BAND_LABELS.length_band), UNKNOWN] },
    { name: 'renewal_window', secondary: true, label: 'Förnyelse', value: q.renewal_window, options: [...Object.values(BAND_LABELS.renewal_window), UNKNOWN] },
  ];
  const noun = q.urval === 'alla' ? 'insamlade avtal' : 'aktiva avtal';
  const countNoun = nAvtal === 1 ? (q.urval === 'alla' ? 'insamlat avtal' : 'aktivt avtal') : noun;
  const resultLine = `${fmtInt(nAvtal)} ${countNoun}, ${nOf(agg.kommun_count, 'kommun', 'kommuner')}`;

  const gLabel = GROUPS.find((g) => g.value === q.grupp).label.toLowerCase();
  const lead = groups[0];
  const leadAgg = lead ? aggregateFacts(lead.facts) : null;
  const answer = rows.length
    ? `${fmtInt(nAvtal)} ${countNoun} från ${nOf(agg.kommun_count, 'kommun', 'kommuner')} matchar. Känt årsvärde ${agg.total_annual_sek == null ? 'okänt' : `${fmtKrCompact(agg.total_annual_sek)}, känt för ${fmtInt(nKnown)} av ${fmtInt(nAvtal)}`}.${lead && q.grupp !== 'kommun' && leadAgg.total_annual_sek != null ? ` Störst efter ${gLabel} är ${groupLabel(q.grupp, lead.key)} med ${fmtKrCompact(leadAgg.total_annual_sek)} per år.` : ''}`
    : 'Inga avtal matchar filtren.';
  // Only unfiltered: a filtered count would need the hidden rows filtered too.
  const hiddenNote = nHidden && !FILTER_KEYS.some((k) => k !== 'urval' && q[k]) ? ` ${fmtInt(nHidden)} avtal med utbildningsanordnare utan produkter visas inte här.` : '';

  const pages = Math.max(1, Math.ceil(rows.length / UTFORSKA_PAGE_SIZE));
  const cur = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  // Alphabetical by kommun, never by value: the studio does not rank
  // kommuner by what they pay (spec §4).
  const sorted = [...rows].sort((a, b) => a.kommun_namn.localeCompare(b.kommun_namn, 'sv')
    || String(a.company_name).localeCompare(String(b.company_name), 'sv') || a.contract_id - b.contract_id);
  const slice = sorted.slice((cur - 1) * UTFORSKA_PAGE_SIZE, cur * UTFORSKA_PAGE_SIZE);
  const from = (cur - 1) * UTFORSKA_PAGE_SIZE + 1;

  const header = `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Utforska</span>
      <h1 class="page-title">Alla avtal, på ditt sätt</h1>
      <p class="lede">${esc(answer)}</p>
      ${hiddenNote ? `<p class="meta ux-hidden">${esc(hiddenNote.trim())}</p>` : ''}
    </div>
  </div>
</section>`;

  const chart = rows.length
    ? `<div class="card"><div class="viz-head"><span class="viz-label">${esc(q.grupp === 'kommun' ? 'Antal avtal per kommun' : `Känt årsvärde per ${gLabel}`)}</span><span class="viz-n">${esc(nOf(groups.length, 'grupp', 'grupper'))}</span></div>
      <p class="meta card-lede">${q.grupp === 'kommun' ? 'Kommuner jämförs aldrig efter vad de betalar, bara efter antal avtal.' : 'Grupper utan känt värde ligger sist.'} En kanal som säljer flera leverantörers produkter delas upp per leverantör där avtalet anger hur.</p>
      ${groupChart({ groups, dim: q.grupp })}</div>`
    : emptyPanel({ title: 'Inga avtal matchar', text: 'Ta bort ett filter eller byt till alla insamlade avtal.' });

  const table = rows.length
    ? `<div class="card ux-card"><p class="meta">Visar ${esc(fmtInt(from))} till ${esc(fmtInt(from + slice.length - 1))} av ${esc(nOf(rows.length, 'rad', 'rader'))}, kommun för kommun. En rad per avtal och leverantör, så ett avtal via en återförsäljare kan ge flera rader.</p>
      ${tableHtml(slice)}
      ${pager({ total: rows.length, page: cur, pageHref: (p) => hrefFor(q, { sida: p > 1 ? p : null }) })}</div>`
    : '';

  return `${header}
<section class="section">${filterBar({ action: '/studio/utforska', fields, resultLine })}</section>
${section({ id: 'gruppering', kicker: 'Gruppering', title: `Efter ${gLabel}`, note: noun, body: chart })}
${table ? section({ id: 'avtal', kicker: 'Avtal', title: 'Raderna bakom', note: `${UTFORSKA_PAGE_SIZE} per sida`, body: table }) : ''}`;
}
