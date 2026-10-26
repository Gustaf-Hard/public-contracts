// Shared pieces for the studio entity pages (leverantör, produkt, and later
// kommun/kategori). Pure: everything comes in as arguments. Text is escaped
// here or by the components; nothing in this file prints a PDF filename,
// a person, or a back-office link.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, UNKNOWN } from '../format.js';
import { CATEGORIES, companyBySlug, productBySlug } from '../../catalogue.js';
import { companyShares, priceDistribution, priceRowFilter, whiteSpots, MIN_N } from '../../studio-data.js';
import { evidenceDrawer, EVIDENCE_PAGE_SIZE, emptyPanel } from '../components.js';
import { stripPlot, rankingBars, renewalTimeline, tileMap } from '../charts.js';

// "1 kommun", "3 kommuner".
export const nOf = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const headline = (facts) => facts.filter((f) => f.active && !f.superseded);
export const distinctCount = (rows, fn) => new Set(rows.map(fn).filter((x) => x != null)).size;
export const sumKnown = (rows) => rows.reduce((s, f) => s + (isNum(f.annual_value_sek) ? f.annual_value_sek : 0), 0);
const isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);

// One value per avtal: on a company page each avtal has one row, but keep
// the guard so a product page never double-counts an avtal.
export function byContract(rows) {
  const m = new Map();
  for (const f of rows) if (!m.has(f.contract_id)) m.set(f.contract_id, f);
  return [...m.values()];
}

export function categoryLabel(slug) {
  if (!slug) return 'Okänd kategori';
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? 'Okänd kategori';
}

export const MODEL_LABEL = Object.freeze({
  fixed: 'Fast pris',
  per_student: 'Per elev',
  per_user: 'Per användare',
  tiered: 'Trappstegspris',
  usage: 'Efter användning',
  one_time: 'Engångsbelopp',
  free: 'Kostnadsfritt',
});
export const modelLabel = (m) => MODEL_LABEL[m] ?? null;

export function kommunNamer(stats, facts = []) {
  const fromFacts = new Map();
  for (const f of facts) if (f.kommun_kod && f.kommun_namn && !fromFacts.has(f.kommun_kod)) fromFacts.set(f.kommun_kod, f.kommun_namn);
  return (kod) => {
    let n = null;
    try { n = stats?.get(kod)?.namn ?? null; } catch { n = null; }
    return n || fromFacts.get(kod) || `Kommun ${kod}`;
  };
}

export function productName(slug) {
  return productBySlug(slug)?.product.name ?? null;
}

export function productNames(f) {
  return f.product_slugs.map(productName).filter(Boolean);
}

export function companyHref(slug) {
  const c = slug ? companyBySlug(slug) : null;
  return c && !c.hiddenInStudio ? `/studio/leverantor/${encodeURIComponent(slug)}` : null;
}
export function productHref(slug) {
  const p = slug ? productBySlug(slug) : null;
  return p && !p.company.hiddenInStudio ? `/studio/produkt/${encodeURIComponent(slug)}` : null;
}
export const kommunHref = (kod) => `/studio/kommun/${encodeURIComponent(kod)}`;

// SKR huvudgrupper: the nine kommungrupper folded into three, so a product
// with a few dozen avtal still fills its matrix.
export const PEER_GROUPS = Object.freeze([
  { key: 'A', label: 'Storstäder och storstadsnära', members: ['Storstäder', 'Pendlingskommun nära storstad'] },
  { key: 'B', label: 'Större städer och kommuner nära större stad', members: ['Större stad', 'Pendlingskommun nära större stad', 'Lågpendlingskommun nära större stad'] },
  { key: 'C', label: 'Mindre städer och landsbygd', members: ['Mindre stad/tätort', 'Pendlingskommun nära mindre tätort', 'Landsbygdskommun, ej nära större stad', 'Landsbygdskommun med besöksnäring'] },
]);

export function peerGroupKods(stats) {
  const all = safeAll(stats);
  return PEER_GROUPS.map((g) => ({ ...g, kods: all.filter((r) => g.members.includes(r.kommungrupp)).map((r) => r.kod) }));
}

export function safeAll(stats) {
  try { return stats?.all?.() ?? []; } catch { return []; }
}

// ------------------------------------------------------------------ layout

export function section({ id, kicker = '', title, note = '', body }) {
  return `<section class="section" id="${esc(id)}">
  <div class="section-head"><div>${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}<h2 class="section-title">${esc(title)}</h2></div>${note ? `<p class="meta">${esc(note)}</p>` : ''}</div>
  ${body}
</section>`;
}

export function breadcrumb(items) {
  return `<nav class="crumbs" aria-label="Var du är">${items.map((it, i) => {
    const last = i === items.length - 1;
    return last
      ? `<span aria-current="page">${esc(it.label)}</span>`
      : `<a href="${esc(it.href)}" data-pane-link>${esc(it.label)}</a><span class="crumb-sep" aria-hidden="true">/</span>`;
  }).join('')}</nav>`;
}

export function notFound({ what, text, crumb = { label: 'Leverantörer', href: '/studio/leverantorer' } }) {
  return `${breadcrumb([crumb, { label: what }])}
${emptyPanel({ title: what, text })}`;
}

// ------------------------------------------------------------------ prices

export function priceStrip({ facts, filter, label, nameOf, noun = 'avtal' }) {
  const dist = priceDistribution(facts, filter);
  const all = byContract(headline(facts).filter(priceRowFilter(filter)));
  const unknownCount = all.filter((f) => !isNum(f.kr_per_elev)).length;
  return stripPlot({ dist, label, nameOf, unknownCount, noun, dotNoun: 'avtal', unit: 'kr/elev' });
}

export function medianText(dist) {
  if (!dist || dist.suppressed || !isNum(dist.median)) {
    return dist?.n ? `för få avtal (n = ${fmtInt(dist.n)})` : 'inget känt pris per elev';
  }
  return `median ${fmtInt(dist.median)} kr/elev`;
}

// "Så ser Läromedel ut": the market around a thin entity, so a page with one
// avtal still shows something true. Highlights the entity in the ranking.
export function categoryContext({ facts, category, highlightSlug = null, nameOf }) {
  if (!category) {
    return emptyPanel({ title: 'Kategorin är okänd', text: 'Vi vet inte vilken kategori avtalen gäller, så vi kan inte visa marknaden runt omkring.' });
  }
  const label = categoryLabel(category);
  const shares = companyShares(facts, { category });
  const hl = shares.find((s) => s.slug === highlightSlug);
  const items = shares.map((s) => ({
    label: s.name,
    href: companyHref(s.slug),
    value: s.kommuner,
    valueLabel: `${fmtInt(s.kommuner)} ${s.kommuner === 1 ? 'kommun' : 'kommuner'}`,
    sub: s.n_known ? `känt värde ${fmtKrCompact(s.value_known_sek)}/år` : 'värde okänt',
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
  return `<div class="grid-12 ctx">
  <div class="span-12"><p class="ctx-lede"><b>Så ser ${esc(label)} ut</b> i avtalen vi har, ${esc(fmtInt(distinctCount(headline(facts).filter((f) => (f.category ?? 'okand') === category), (f) => f.kommun_kod)))} kommuner och ${esc(fmtInt(shares.length))} leverantörer.</p></div>
  <div class="span-7 card">${priceStrip({ facts, filter: { category }, label: `${label}, pris per elev och år`, nameOf })}</div>
  <div class="span-5 card"><div class="viz-head"><span class="viz-label">Leverantörer i kategorin</span><span class="viz-n">efter antal kommuner</span></div>${rankingBars({ items, max: 6, highlight: hl ? hl.name : null, noun: 'leverantörer', valueHead: '' })}</div>
</div>`;
}

// ------------------------------------------------------------------ map

// Footprint: `has` comes from the entity's own active avtal; every other
// kommun says what we know about collection there, never "no avtal" unless
// collection is done.
export function footprintMap({ tiles, rows, statusMap, stats, entity, nameOf }) {
  const allKods = safeAll(stats).map((r) => r.kod);
  const ws = whiteSpots(rows, statusMap, { allKods: allKods.length ? allKods : Object.keys(tiles?.tiles ?? {}) });
  const cls = new Map();
  for (const k of ws.has) cls.set(k, 'has');
  for (const k of ws.none_done) cls.set(k, 'none-done');
  for (const k of ws.none_open) cls.set(k, 'none-open');
  for (const k of ws.not_contacted) cls.set(k, 'not-contacted');
  const what = {
    has: `har aktivt avtal med ${entity}`,
    'none-done': `inget avtal med ${entity}, insamlingen klar`,
    'none-open': 'insamlingen pågår, inget avtal med ' + entity + ' än',
    'not-contacted': 'inte kontaktad än',
  };
  return tileMap({
    tiles,
    classOf: (kod) => cls.get(kod) ?? 'unknown',
    titleOf: (kod) => `${nameOf(kod)}: ${what[cls.get(kod)] ?? 'status okänd'}`,
    legend: [
      { cls: 'has', label: `Har avtal med ${entity}` },
      { cls: 'none-done', label: 'Inget avtal, insamling klar' },
      { cls: 'none-open', label: 'Insamling pågår' },
      { cls: 'not-contacted', label: 'Inte kontaktad' },
    ],
    label: `Kommuner med avtal med ${entity}`,
  });
}

// ------------------------------------------------------------------ renewals

// "Förnyas inom 12 mån" KPI input. Unknown when no active avtal has a dated
// next renewal; the value line never reads an unknown value as 0.
export function renewalTileProps({ avtal, buckets, today }) {
  const dated = avtal.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today).length;
  const n = buckets.reduce((s, b) => s + b.n, 0);
  const nKnown = buckets.reduce((s, b) => s + b.n_known, 0);
  const value = buckets.reduce((s, b) => s + b.value_known_sek, 0);
  if (!dated) {
    return {
      label: 'Förnyas inom 12 mån', value: null, state: 'unknown',
      reason: avtal.length ? 'Inget aktivt avtal anger slutdatum eller förlängning.' : 'Inga aktiva avtal.',
      basis: '',
    };
  }
  const valueText = !n ? '' : nKnown === 0 ? ', värde okänt' : nKnown < n
    ? `, ${fmtKrCompact(value)}/år känt för ${fmtInt(nKnown)} av ${fmtInt(n)}`
    : `, ${fmtKrCompact(value)}/år`;
  return {
    label: 'Förnyas inom 12 mån', value: n, unit: 'avtal', state: dated < avtal.length ? 'partial' : 'known',
    basis: `${fmtInt(dated)} av ${fmtInt(avtal.length)} med känt slutdatum${valueText}`,
    spark: n ? buckets.map((b) => b.n) : null,
  };
}

export const RENEWAL_MONTHS = 24;
export const MAX_LANES = 14;

function addMonthsIso(iso, k) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, d));
  return t.toISOString().slice(0, 10);
}

// Lanes per kommun, soonest first. Returns { html, inWindow, unknownDate }.
export function renewalSection({ rows, today, nameOf, titleOf }) {
  const head = byContract(headline(rows));
  const until = addMonthsIso(today, RENEWAL_MONTHS);
  const dated = head.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today);
  const inWindow = dated.filter((f) => f.next_renewal.slice(0, 10) <= until);
  const unknownDate = head.length - dated.length;
  const byKod = new Map();
  for (const f of inWindow) {
    if (!byKod.has(f.kommun_kod)) byKod.set(f.kommun_kod, []);
    byKod.get(f.kommun_kod).push(f);
  }
  const lanes = [...byKod.entries()]
    .map(([kod, fs]) => ({ kod, fs: fs.sort((a, b) => a.next_renewal.localeCompare(b.next_renewal)) }))
    .sort((a, b) => a.fs[0].next_renewal.localeCompare(b.fs[0].next_renewal) || nameOf(a.kod).localeCompare(nameOf(b.kod), 'sv'));
  const shown = lanes.slice(0, MAX_LANES);
  const later = dated.length - inWindow.length;
  const basis = [
    `${fmtInt(inWindow.length)} av ${nOf(head.length, 'aktivt avtal', 'aktiva avtal')} förnyas eller löper ut inom ${RENEWAL_MONTHS} mån`,
    later ? `${fmtInt(later)} senare` : '',
    unknownDate ? `${fmtInt(unknownDate)} utan känt slutdatum` : '',
  ].filter(Boolean).join(', ');
  if (!shown.length) {
    return {
      html: emptyPanel({
        title: `Inga kända förnyelser inom ${RENEWAL_MONTHS} månader`,
        text: !head.length ? 'Inga aktiva avtal.' : unknownDate ? `${fmtInt(unknownDate)} av ${nOf(head.length, 'aktivt avtal', 'aktiva avtal')} anger inget slutdatum, så de kan förnyas utan att synas här.` : `${head.length === 1 ? 'Avtalet löper' : 'Alla aktiva avtal löper'} längre än så.`,
      }),
      basis,
    };
  }
  const tl = renewalTimeline({
    today,
    months: RENEWAL_MONTHS,
    laneHead: 'Kommun',
    lanes: shown.map(({ kod, fs }) => ({
      label: nameOf(kod),
      href: kommunHref(kod),
      sub: `${fs.length === 1 ? 'förnyas' : `${fmtInt(fs.length)} avtal, först`} ${fs[0].next_renewal.slice(0, 10)}`,
      items: fs.map((f) => ({
        date: f.next_renewal.slice(0, 10),
        value: isNum(f.annual_value_sek) ? f.annual_value_sek : null,
        valueLabel: isNum(f.annual_value_sek) ? `${fmtKrCompact(f.annual_value_sek)}/år` : null,
        title: titleOf(f),
      })),
    })),
  });
  const rest = lanes.length - shown.length;
  return {
    html: `${tl}${rest > 0 ? `<p class="meta tl-rest">Visar de ${fmtInt(shown.length)} kommuner som förnyas först. ${fmtInt(rest)} kommuner till förnyas inom ${RENEWAL_MONTHS} mån.</p>` : ''}`,
    basis,
  };
}

// ------------------------------------------------------------------ evidence

function periodText(f, today) {
  const s = isIso(f.period_start) ? f.period_start.slice(0, 10) : null;
  const e = isIso(f.period_end) ? f.period_end.slice(0, 10) : null;
  let p = s && e ? `${s} till ${e}` : s ? `från ${s}, slut okänt` : e ? `till ${e}` : null;
  if (p == null) p = UNKNOWN;
  if (f.superseded) return `${p}, ersatt av nyare avtal`;
  if (!f.active) return `${p}, ${e && e < today ? 'utgånget' : 'räknas inte som aktivt'}`;
  return p;
}

function valueText(f) {
  if (!isNum(f.annual_value_sek)) return null;
  const base = `${fmtKrCompact(f.annual_value_sek)}/år`;
  if (f.value_basis === 'unsplit_channel') return `${base}, hela avtalet`;
  if (f.value_basis === 'split') return `${base}, egen del`;
  return base;
}

// Active avtal first (by kommun), then expired and replaced (newest first).
export function evidenceSection({ rows, today, page = 1, nameOf, pageHref }) {
  const all = byContract(rows);
  const active = all.filter((f) => f.active && !f.superseded)
    .sort((a, b) => nameOf(a.kommun_kod).localeCompare(nameOf(b.kommun_kod), 'sv') || a.contract_id - b.contract_id);
  const old = all.filter((f) => !(f.active && !f.superseded))
    .sort((a, b) => String(b.period_end ?? '').localeCompare(String(a.period_end ?? '')) || a.contract_id - b.contract_id);
  const ordered = [...active, ...old];
  const pages = Math.max(1, Math.ceil(ordered.length / EVIDENCE_PAGE_SIZE));
  const cur = Math.min(Math.max(1, Math.trunc(Number(page)) || 1), pages);
  const slice = ordered.slice((cur - 1) * EVIDENCE_PAGE_SIZE, cur * EVIDENCE_PAGE_SIZE);
  const evRows = slice.map((f) => ({
    kommun: nameOf(f.kommun_kod),
    period: periodText(f, today),
    value: valueText(f),
    model: modelLabel(f.pricing_model),
    // Operator-only route; see routes.js /studio/underlag.
    pdfHref: isNum(f.attachment_id) ? `/studio/underlag/${f.attachment_id}` : null,
  }));
  return {
    html: evidenceDrawer({ rows: evRows, total: ordered.length, page: cur, pageHref }),
    active: active.length,
    old: old.length,
  };
}

export { MIN_N };
