// /studio/kommun/:kod (spec §7.5 item 5). The customer view for one kommun:
// what it buys, what it pays per elev against kommuner like it, what else
// those kommuner use, and when each avtal comes up for renewal.
//
// Privacy (spec §4): other kommuner appear only as anonymous aggregates.
// No peer is named anywhere on this page: strip dots say "En kommun", map
// tiles say "Liknande kommun", alternatives give counts. The page never
// ranks kommuner by price.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, fmtPrice, basisLine, monthsUntil } from '../format.js';
import { CATEGORIES, companyBySlug, productBySlug } from '../../catalogue.js';
import { kommunProfile, kommunView, priceDistribution, priceRowFilter, distribution, renewalBuckets, UNKNOWN_CATEGORY } from '../../studio-data.js';
import { GRADE_LEVELS as GRADE_ORDER } from '../../vendor-analytics.js';
import { entityHeader, kpiTile, emptyPanel } from '../components.js';
import { stripPlot, rankingBars, renewalTimeline, tileMap, niceDomain, loadKommunTiles } from '../charts.js';
import {
  isNum, headline, sumKnown, byContract, consolidateByContract, categoryLabel, modelLabel, productName, productNames,
  companyHref, productHref, section, breadcrumb, medianText, evidenceSection, renewalTileProps, jointText, jointValueText,
  safeAll, nOf, MIN_N, isIso,
} from './common.js';

// Elever the per-elev spend is divided by: kommunal regi, förskoleklass to åk 9.
export const F9 = Object.freeze(['Förskoleklass', '1-3', '4-6', '7-9']);
// A tender takes this long, so "upphandla om X mån" is the renewal date minus it.
export const TENDER_LEAD_MONTHS = 9;
// Categories where a kommun normally runs one system. Two vendors here at once
// is worth a look; two läromedel vendors is ordinary (one per subject).
export const SINGLE_SYSTEM = Object.freeze(['larplattform', 'skoladministration', 'prov', 'elevhalsa']);
const RENEWAL_MONTHS = 24;
const MAX_ALT = 4;
// The page leads with the answer; long lists fold behind these caps so a
// kommun with 40 avtal is not an 8 000 px scroll. Everything stays reachable.
export const MAX_PRICE_ROWS = 3;
export const MAX_PRICE_TILES = 6;
export const MAX_ALT_CARDS = 4;
export const MAX_OWN_LANES = 8;

// A closed fold: summary line plus the rest of the list.
const fold = (summary, body, cls = '') => `<details class="kn-fold${cls ? ` ${cls}` : ''}"><summary>${esc(summary)}</summary>${body}</details>`;

const STATUS = Object.freeze({
  not_contacted: { chip: 'Inte kontaktad', cls: 'is-none', text: 'Vi har inte begärt ut kommunens avtal än. Nedan ser du vad liknande kommuner köper och betalar.' },
  open: { chip: 'Insamling pågår', cls: 'is-open', text: 'Kommunen har inte lämnat ut alla avtal än. Siffrorna räknar bara de avtal vi har fått.' },
  done: { chip: 'Insamling klar', cls: 'is-done', text: 'Kommunen har svarat på vår begäran och insamlingen är avslutad.' },
  partial: { chip: 'Delvis utlämnat', cls: 'is-open', text: 'Kommunen har lämnat ut en del avtal men avslutat resten av vår begäran utan att lämna ut dem. Siffrorna räknar bara de avtal vi har fått, och att något saknas här betyder inte att kommunen saknar avtal.' },
  dead_end: { chip: 'Inga avtal utlämnade', cls: 'is-none', text: 'Kommunen har inte lämnat ut avtal till oss. Insamlingen är avslutad utan underlag, så sidan bygger på liknande kommuner.' },
  unknown: { chip: 'Status okänd', cls: 'is-none', text: 'Vi vet inte hur långt insamlingen har kommit här.' },
});

function addMonthsIso(iso, k) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
}

// "upphandla om 5 mån", "upphandla nu" (the lead time has started).
export function tenderCue(renewal, today) {
  const start = addMonthsIso(renewal, -TENDER_LEAD_MONTHS);
  return start <= today ? 'upphandla nu' : `upphandla ${monthsUntil(start, today)}`;
}

const catOf = (f) => f.category ?? UNKNOWN_CATEGORY;
const catName = (c) => (c === UNKNOWN_CATEGORY ? 'Okänd kategori' : categoryLabel(c));
const catOrder = (c) => { const i = CATEGORIES.findIndex((x) => x.slug === c); return i < 0 ? 99 : i; };

function safeGet(stats, kod) {
  try { return stats?.get?.(kod) ?? null; } catch { return null; }
}
function safePeers(stats, kod) {
  try { return stats?.peersOf?.(kod) ?? []; } catch { return []; }
}
function safeElever(stats, kod) {
  try {
    const n = stats?.eleverIn?.(kod, F9);
    return isNum(n) && n > 0 ? n : null;
  } catch { return null; }
}

// The kommun behind a kod, from open data, else from the facts. null = 404.
export function findKommun({ kod, stats, facts }) {
  if (!/^\d{4}$/.test(String(kod ?? ''))) return null;
  const rec = safeGet(stats, kod);
  if (rec) return { ...rec, kod };
  const f = facts.find((x) => x.kommun_kod === kod && x.kommun_namn);
  return f ? { kod, namn: f.kommun_namn, lan: null, folkmangd: null, kommungrupp: null, sizeBand: null } : null;
}

// The product an avtal's kr/elev belongs to, same rule as priceDistribution.
const pricedProduct = (f) => f.kr_per_elev_product_slug ?? (f.product_slugs.length === 1 ? f.product_slugs[0] : null);

// ------------------------------------------------------------ spend vs peers

// An owner row counts toward spend per elev when both its value and the
// pupils it covers (elever_in_scope, from its own school forms) are known.
export const hasScope = (f) => isNum(f.elever_in_scope) && f.elever_in_scope > 0 && f.segments.length > 0;

// Known spend per elev per category for one kommun, in the school forms the
// avtal cover: the known value of every avtal with known value and known
// school forms, divided by the kommun's elever in the union of those school
// forms (two läromedel avtal for the same pupils are not twice the pupils).
// eleverIn(segments) gives the kommun's elever. Returns
// Map(cat -> { perElev, value, elever, counted, leftOut }); perElev is null
// when the elever are unknown. completeOnly (peers): a category with any
// avtal left out is dropped, a partial sum would pull the median down.
export function perElevByCategory(rows, { eleverIn, completeOnly = false } = {}) {
  const by = new Map();
  for (const f of rows) {
    const c = catOf(f);
    if (!by.has(c)) by.set(c, { value: 0, segs: new Set(), counted: 0, leftOut: 0, joint: 0 });
    const e = by.get(c);
    // A samverkansavtal has no known share for this kommun (kommunView).
    if (f.joint) { e.leftOut += 1; e.joint += 1; } else if (isNum(f.annual_value_sek) && hasScope(f)) {
      e.value += f.annual_value_sek; e.counted += 1;
      for (const g of f.segments) e.segs.add(g);
    } else e.leftOut += 1;
  }
  const out = new Map();
  for (const [c, e] of by) {
    if (completeOnly && e.leftOut) continue;
    if (!e.counted) { out.set(c, { perElev: null, value: null, elever: null, counted: 0, leftOut: e.leftOut, joint: e.joint }); continue; }
    let elever = null;
    try { const n = eleverIn?.(GRADE_ORDER.filter((g) => e.segs.has(g))); elever = isNum(n) && n > 0 ? n : null; } catch { elever = null; }
    out.set(c, { perElev: elever ? e.value / elever : null, value: e.value, elever, counted: e.counted, leftOut: e.leftOut, joint: e.joint });
  }
  return out;
}

const eleverFor = (stats, kod) => (segs) => stats?.eleverIn?.(kod, segs);

function spendSection({ kommun, profile, head, peers, stats, mine, statusMap }) {
  const ownMap = perElevByCategory(mine, { eleverIn: eleverFor(stats, kommun.kod) });
  // Peer medians use only peers whose collection is done: a peer still
  // sending avtal would pull the median down with spend we have not seen.
  const donePeers = peers.filter((k) => statusMap.get(k) === 'done');
  const peerRows = new Map();
  const peerSet = new Set(donePeers);
  for (const f of head) if (peerSet.has(f.kommun_kod)) {
    if (!peerRows.has(f.kommun_kod)) peerRows.set(f.kommun_kod, []);
    peerRows.get(f.kommun_kod).push(f);
  }
  const peerVals = new Map(); // cat -> [kr/elev]
  const peerAny = new Map(); // cat -> Set(kod) with any active avtal there
  for (const [kod, rows] of peerRows) {
    for (const f of rows) {
      const c = catOf(f);
      if (!peerAny.has(c)) peerAny.set(c, new Set());
      peerAny.get(c).add(kod);
    }
    for (const [c, v] of perElevByCategory(rows, { eleverIn: eleverFor(stats, kod), completeOnly: true })) {
      if (!isNum(v.perElev)) continue;
      if (!peerVals.has(c)) peerVals.set(c, []);
      peerVals.get(c).push(v.perElev);
    }
  }
  const spend = new Map(profile.spendByCategory.map((s) => [s.category, s]));
  const cats = [...new Set([...spend.keys(), ...peerAny.keys()])]
    // With own avtal, a category only peers buy is shown when there is a
    // peer median to show; otherwise it is a row of nothing.
    .filter((c) => spend.has(c) || (c !== UNKNOWN_CATEGORY && (mine.length ? (peerVals.get(c)?.length ?? 0) >= MIN_N : (peerVals.get(c)?.length ?? 0) > 0)))
    .sort((a, b) => (spend.has(b) - spend.has(a)) || catOrder(a) - catOrder(b));
  if (!cats.length) {
    return emptyPanel({
      title: 'Inget känt årsvärde att jämföra än',
      text: `${fmtInt(donePeers.length)} av ${fmtInt(peers.length)} liknande kommuner har klar insamling, och ingen av dem har aktiva avtal med känt värde${mine.length ? '' : ' här'}. Vi jämför årsvärde bara mot kommuner där insamlingen är klar.`,
    });
  }
  const rows = cats.map((c) => {
    const s = spend.get(c) ?? null;
    const d = distribution(peerVals.get(c) ?? []);
    const m = ownMap.get(c) ?? null;
    return { c, s, m, own: m?.perElev ?? null, d };
  });
  const plotted = rows.flatMap((r) => [r.own, r.d.suppressed ? null : r.d.p75].filter(isNum));
  const top = Math.max(1, ...plotted);
  const { hi, ticks } = niceDomain(0, top);
  const x = (v) => Math.max(0, Math.min(100, (v / hi) * 100));
  const p = (v) => `${x(v).toFixed(2)}%`;
  const kr = (v) => `${fmtPrice(v)} kr/elev`;
  const hasOwn = mine.length > 0;

  const li = rows.map(({ c, s, m, own: o, d }, i) => {
    const ownKnown = isNum(o);
    const few = d.suppressed;
    const nPeers = peerAny.get(c)?.size ?? 0;
    const nLeft = (m?.leftOut ?? 0) - (m?.joint ?? 0);
    const left = `${nLeft ? `, ${fmtInt(nLeft)} utan känt värde eller skolformer räknas inte` : ''}${m?.joint ? `, ${nOf(m.joint, 'samverkansavtal', 'samverkansavtal')} med okänd andel räknas inte` : ''}`;
    const name = `<div class="sc-name"><b>${esc(catName(c))}</b><small>${esc(s
      ? `${nOf(s.n_avtal, 'avtal', 'avtal')}${!s.n_known ? ', värde okänt' : s.n_known < s.n_avtal ? `, värde känt för ${fmtInt(s.n_known)}` : ''}${left}`
      : hasOwn ? 'inga aktiva avtal här' : `${fmtInt(nPeers)} liknande köper här`)}</small></div>`;
    let bar = '';
    if (ownKnown) bar = `<span class="sc-bar grow-x" style="width:${p(o)};--i:${i}"></span>`;
    else if (s) bar = '<span class="sc-bar is-unknown hatch"></span>';
    const band = few ? '' : `<span class="sc-iqr" style="left:${p(d.p25)};width:${(Math.max(0.6, x(d.p75) - x(d.p25))).toFixed(2)}%"></span>`;
    const tick = few ? '' : `<span class="sc-med" style="left:${p(d.median)}" tabindex="0"><span class="tip" role="tooltip"><strong>${esc(kr(d.median))}</strong><span>median bland ${esc(fmtInt(d.n))} liknande med klar insamling</span><span>mittersta hälften ${esc(fmtPrice(d.p25))} till ${esc(kr(d.p75))}</span></span></span>`;
    const ownText = ownKnown ? `<b>${esc(kr(o))}</b>`
      : s ? `<b class="muted">${m?.counted ? 'elevantal saknas' : s.n_known ? 'skolformer okända' : 'värde okänt'}</b>`
        : hasOwn ? '<b class="muted">inget avtal</b>' : '';
    const peerText = few
      ? `<small class="sc-few">för få liknande med klar insamling (n = ${esc(fmtInt(d.n))})</small>`
      : `<small>median bland ${esc(fmtInt(d.n))} liknande med klar insamling: ${esc(kr(d.median))}</small>`;
    return `<li class="sc-row">${name}<div class="sc-track${few ? ' is-few hatch' : ''}">${band}${bar}${tick}</div><div class="sc-val">${ownText}${peerText}</div></li>`;
  }).join('');

  const axis = `<div class="sc-axis-row"><span></span><div class="axis-x" aria-hidden="true">${ticks.map((t, i) => `<span class="axis-tick${i === 0 ? ' is-first' : i === ticks.length - 1 ? ' is-last' : ''}" style="left:${p(t)}">${esc(fmtPrice(t))}</span>`).join('')}<span class="axis-unit">kr per elev och år, i avtalens skolformer</span></div><span></span></div>`;
  const foot = `<figcaption class="viz-foot">
    ${hasOwn ? `<span class="lg"><i class="lg-dot is-highlight sq"></i>${esc(kommun.namn)}</span>` : ''}
    ${rows.some((r) => !r.d.suppressed) ? `<span class="lg"><i class="lg-band"></i>mittersta hälften bland liknande med klar insamling</span>
    <span class="lg"><i class="lg-tick"></i>median bland dem</span>` : ''}
    <span class="lg"><i class="lg-hatch"></i>för få (under ${MIN_N} kommuner)</span>
  </figcaption>`;
  const lede = `Känt årsvärde per elev i de skolformer avtalen gäller: summan av avtal med känt värde och kända skolformer, delat med kommunens elever i de skolformerna (Skolverket, kommunal regi). Liknande kommuner räknas på samma sätt, men bara de ${fmtInt(donePeers.length)} av ${fmtInt(peers.length)} där insamlingen är klar, och i en kategori bara när alla deras aktiva avtal där har känt värde och kända skolformer.${hasOwn ? ' Era egna avtal utan känt värde eller utan kända skolformer räknas inte, raden säger hur många.' : ''}`;
  return `<figure class="viz sc card">
  <div class="viz-head"><span class="viz-label">${hasOwn ? 'Ert årsvärde per elev mot liknande kommuner' : 'Vad liknande kommuner lägger per elev'}</span><span class="viz-n">${esc(nOf(peers.length, 'liknande kommun', 'liknande kommuner'))}</span></div>
  <p class="meta card-lede">${esc(lede)}</p>
  <ol class="sc-list">${li}</ol>
  ${plotted.length ? axis : ''}
  ${foot}
</figure>`;
}

// ------------------------------------------------------------ price per avtal

// The peers' distribution with the kommun's own price drawn on top. The
// median, quartiles and n are the peers' alone: the kommun's own price is
// never part of the benchmark it is compared with.
export function withOwnPoint(dist, kod, value) {
  if (!dist || dist.suppressed || !isNum(value)) return dist;
  const values = [...dist.values.filter((v) => v.kommun_kod !== kod), { kommun_kod: kod, kr_per_elev: value }]
    .sort((a, b) => a.kr_per_elev - b.kr_per_elev);
  return { ...dist, values, min: Math.min(dist.min, value), max: Math.max(dist.max, value) };
}

function priceRows({ kommun, mine, facts, peers, today }) {
  const order = (a, b) => catOrder(catOf(a)) - catOrder(catOf(b)) || String(a.company_name).localeCompare(String(b.company_name), 'sv');
  // Every priced owner row is a price (ILT and Magma inside one Läromedia
  // avtal are two prices); an avtal with no priced row is listed once, whole.
  const pricedRows = mine.filter((f) => isNum(f.kr_per_elev)).sort(order);
  const pricedIds = new Set(pricedRows.map((f) => f.contract_id));
  const avtal = consolidateByContract(mine);
  const unpricedAvtal = avtal.filter((f) => !pricedIds.has(f.contract_id)).sort(order);
  // Thresholds and labels count DISTINCT kommuner with a known price, never
  // avtal rows; the kommun itself is never one of its own comparison set.
  const head0 = headline(facts);
  const pricedKods = (filter) => {
    const match = priceRowFilter(filter);
    return new Set(head0.filter((f) => isNum(f.kr_per_elev) && match(f) && f.kommun_kod !== kommun.kod).map((f) => f.kommun_kod));
  };
  const priced = [];
  const unpriced = [];
  let comparable = 0;
  for (const f of [...pricedRows, ...unpricedAvtal]) {
    const slug = pricedProduct(f);
    const pname = (slug && productName(slug)) || productNames(f).join(', ') || f.company_name;
    const peerK = slug ? pricedKods({ productSlug: slug, kommunKods: peers }) : new Set();
    const otherK = slug ? pricedKods({ productSlug: slug }) : new Set();
    const info = { f, slug, pname, peerK, otherK };
    if (isNum(f.kr_per_elev)) priced.push(info); else unpriced.push(info);
  }

  const head = (f, pname, slug) => {
    const href = slug ? productHref(slug) : null;
    const comp = companyHref(f.company_slug);
    const via = f.channel_slug && f.channel_slug !== f.company_slug ? companyBySlug(f.channel_slug)?.canonical ?? null : null;
    const bits = [
      catName(catOf(f)),
      f.joint ? jointValueText(f) ?? 'årsvärde okänt' : isNum(f.annual_value_sek) ? `${fmtKrCompact(f.annual_value_sek)}/år` : 'årsvärde okänt',
      via ? `via ${via}` : null,
      f.joint ? jointText(f) : null,
      modelLabel(f.pricing_model),
      isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today ? `förnyas ${f.next_renewal.slice(0, 10)}` : null,
    ].filter(Boolean);
    return `<div class="kp-head">
      <h3 class="kp-name">${href ? `<a href="${esc(href)}" data-pane-link>${esc(pname)}</a>` : esc(pname)}</h3>
      <p class="kp-who">${comp ? `<a href="${esc(comp)}" data-pane-link>${esc(f.company_name)}</a>` : esc(f.company_name)}</p>
      <p class="meta">${esc(bits.join(' · '))}</p>
    </div>`;
  };

  // Comparable prices get a full row with the anonymous strip; the rest of
  // the priced avtal become compact tiles (own price, why no comparison).
  const mineStrip = (dist, label, own) => stripPlot({
    dist: withOwnPoint(dist, kommun.kod, own), label, highlightKod: kommun.kod, highlightLabel: kommun.namn, nameOf: null, noun: 'kommuner', dotNoun: 'kommun', unit: 'kr/elev',
  });
  const big = [];
  const small = [];
  for (const it of priced) {
    const { f, slug, pname, peerK, otherK } = it;
    if (slug && peerK.size >= MIN_N) {
      big.push({ it, viz: mineStrip(priceDistribution(facts, { productSlug: slug, kommunKods: [...peerK] }), `${pname} hos ${fmtInt(peerK.size)} liknande kommuner`, f.kr_per_elev) });
    } else if (slug && otherK.size >= MIN_N) {
      const few = `${peerK.size ? `Bara ${nOf(peerK.size, 'liknande kommun', 'liknande kommuner')} har` : 'Ingen liknande kommun har'} känt pris för ${pname}, för få jämförbara kommuner. Här jämförs med ${fmtInt(otherK.size)} andra kommuner.`;
      big.push({ it, fallback: true, viz: `<p class="kp-few">${esc(few)}</p>${mineStrip(priceDistribution(facts, { productSlug: slug, kommunKods: [...otherK] }), 'Jämfört med alla kommuner (för få liknande)', f.kr_per_elev)}` });
    } else {
      small.push({
        it,
        why: !slug ? 'Avtalet gäller flera produkter till ett pris, så vi jämför inte per produkt.'
          : `För få jämförbara kommuner: ${peerK.size ? nOf(peerK.size, 'liknande kommun', 'liknande kommuner') : 'ingen liknande kommun'} och ${otherK.size ? nOf(otherK.size, 'kommun', 'kommuner') : 'ingen kommun'} totalt har känt pris, vi jämför från ${MIN_N}.`,
      });
    }
  }
  comparable = big.length;
  const own = (f) => `<div class="kp-own"><span class="kp-own-num">${esc(fmtPrice(f.kr_per_elev))}</span><span class="kp-own-unit">kr per elev och år, ert pris</span></div>`;
  const card = ({ it, viz }, i) => `<article class="card kp-row" style="--i:${i}">
      <div class="kp-left">${head(it.f, it.pname, it.slug)}${own(it.f)}</div>
      <div class="kp-viz">${viz}</div>
    </article>`;
  const bigRest = big.slice(MAX_PRICE_ROWS);
  const cards = big.slice(0, MAX_PRICE_ROWS).map(card).join('')
    + (bigRest.length ? fold(`Visa ${nOf(bigRest.length, 'jämförelse', 'jämförelser')} till`, `<div class="kp-list">${bigRest.map((b, i) => card(b, i)).join('')}</div>`) : '');
  const tile = ({ it, why }) => `<li class="kp-tile">${head(it.f, it.pname, it.slug)}${own(it.f)}<p class="kp-why">${esc(why)}</p></li>`;
  const smallRest = small.slice(MAX_PRICE_TILES);
  const tiles = small.length
    ? `<ul class="kp-tiles">${small.slice(0, MAX_PRICE_TILES).map(tile).join('')}</ul>${smallRest.length ? fold(`Visa ${nOf(smallRest.length, 'pris', 'priser')} till`, `<ul class="kp-tiles">${smallRest.map(tile).join('')}</ul>`) : ''}`
    : '';

  const rest = unpriced.map(({ f, slug, pname, peerK, otherK }) => {
    const med = (kods) => priceDistribution(facts, { productSlug: slug, kommunKods: [...kods] }).median;
    const ref = peerK.size >= MIN_N
      ? `${fmtInt(peerK.size)} liknande kommuner: median ${fmtPrice(med(peerK))} kr/elev`
      : otherK.size >= MIN_N ? `${fmtInt(otherK.size)} kommuner: median ${fmtPrice(med(otherK))} kr/elev` : '';
    return `<li class="kp-rest-row">${head(f, pname, slug)}${ref ? `<span class="chip">${esc(ref)}</span>` : ''}</li>`;
  }).join('');

  let html = '';
  if (avtal.length) {
    html = `${cards ? `<div class="kp-list">${cards}</div>` : ''}
    ${tiles ? `<div class="card kp-rest"><div class="viz-head"><span class="viz-label">Känt pris, för få att jämföra</span><span class="viz-n">${esc(nOf(small.length, 'pris', 'priser'))}</span></div>${tiles}</div>` : ''}
    ${!priced.length ? emptyPanel({ title: 'Inget av avtalen anger pris per elev', text: 'Vi räknar pris per elev när avtalet anger ett styckpris, eller ett årsvärde och vilka skolformer det gäller.' }) : ''}
    ${rest ? `<div class="card kp-rest">${fold(`${nOf(unpriced.length, 'avtal', 'avtal')} utan känt pris per elev`, `<p class="meta card-lede">Avtalet anger inget styckpris, eller inte vilka skolformer det gäller. Där andra kommuner har känt pris för produkten visas deras median.</p><ul class="kp-rest-list">${rest}</ul>`, 'is-card-fold')}</div>` : ''}`;
  }
  return { html, priced: priced.length, pricedAvtal: pricedIds.size, comparable, total: avtal.length };
}

// ------------------------------------------------------------ overlap

function overlapSection({ profile, mine }) {
  const hits = profile.overlaps.filter((o) => SINGLE_SYSTEM.includes(o.category));
  if (!hits.length) return '';
  const items = hits.map((o) => {
    const rows = consolidateByContract(mine.filter((f) => catOf(f) === o.category));
    const known = rows.filter((f) => isNum(f.annual_value_sek));
    const names = o.companies.map((c) => {
      const href = companyHref(c.slug);
      return href ? `<a href="${esc(href)}" data-pane-link>${esc(c.name)}</a>` : esc(c.name);
    });
    const sum = known.length ? `${fmtKrCompact(sumKnown(known))}/år${known.length < rows.length ? `, känt för ${fmtInt(known.length)} av ${fmtInt(rows.length)} avtal` : ''}` : 'värde okänt';
    return `<li><b>${esc(catName(o.category))}</b><span>${names.length > 1 ? `${names.slice(0, -1).join(', ')} och ${names[names.length - 1]}` : names.join('')}</span><span class="meta">${esc(`tillsammans ${sum}`)}</span></li>`;
  }).join('');
  return `<section class="section" id="overlapp"><div class="kn-overlap" role="note">
  <span class="kn-overlap-mark" aria-hidden="true">2+</span>
  <div><strong>Flera system i samma kategori</strong>
  <p>Gäller lärplattform, skoladministration, prov och bedömning samt elevhälsa, där en kommun oftast har ett system. Kommunen har aktiva avtal med mer än en leverantör här. Det kan vara medvetet, till exempel olika skolformer, men är värt att kontrollera inför nästa upphandling.</p>
  <ul class="kn-overlap-list">${items}</ul></div>
</div></section>`;
}

// ------------------------------------------------------------ alternatives

function alternatives({ kommun, head, peers, mine }) {
  const peerSet = new Set(peers);
  let base = head.filter((f) => peerSet.has(f.kommun_kod));
  let scope = 'liknande';
  let total = peers.length;
  if (!base.length) {
    base = head.filter((f) => f.kommun_kod !== kommun.kod);
    scope = 'alla';
    total = new Set(base.map((f) => f.kommun_kod)).size;
  }
  const ownProducts = new Set(mine.flatMap((f) => f.product_slugs));
  const ownCompanies = new Set(mine.filter((f) => !f.product_slugs.length).map((f) => f.company_slug));
  const byCat = new Map(); // cat -> Map(key -> {label, href, sub, kods, mine})
  for (const f of base) {
    const c = f.company_slug ? companyBySlug(f.company_slug) : null;
    if (!c || c.hiddenInStudio) continue;
    const entries = f.product_slugs.length
      ? f.product_slugs.map((s) => ({ key: `p:${s}`, slug: s, cat: productBySlug(s)?.product.category ?? f.category }))
      : [{ key: `c:${c.slug}`, slug: null, cat: f.category }];
    for (const e of entries) {
      const cat = e.cat ?? UNKNOWN_CATEGORY;
      if (!byCat.has(cat)) byCat.set(cat, new Map());
      const m = byCat.get(cat);
      if (!m.has(e.key)) {
        m.set(e.key, {
          slug: e.slug,
          label: e.slug ? productName(e.slug) ?? c.canonical : c.canonical,
          href: e.slug ? productHref(e.slug) : companyHref(c.slug),
          company: c.canonical,
          kods: new Set(),
          mine: e.slug ? ownProducts.has(e.slug) : ownCompanies.has(c.slug),
        });
      }
      m.get(e.key).kods.add(f.kommun_kod);
    }
  }
  const ownCats = new Set(mine.map(catOf));
  const cats = [...byCat.keys()].filter((c) => c !== UNKNOWN_CATEGORY)
    .sort((a, b) => (ownCats.has(b) - ownCats.has(a)) || catOrder(a) - catOrder(b));
  if (!cats.length) {
    return emptyPanel({ title: 'Inga jämförbara avtal än', text: 'Vi har inga aktiva avtal från andra kommuner att visa här än.' });
  }
  const cardOf = (cat) => {
    const items = [...byCat.get(cat).values()].map((it) => {
      const k = it.kods.size;
      const median = it.slug ? medianText(priceDistribution(head, { productSlug: it.slug })) : 'produkt ej angiven';
      return {
        label: it.label,
        href: it.href,
        value: k,
        valueLabel: scope === 'liknande' ? `${fmtInt(k)} av ${fmtInt(total)} liknande` : nOf(k, 'kommun', 'kommuner'),
        sub: [it.mine ? 'ni har den' : null, median, it.label !== it.company ? it.company : null].filter(Boolean).join(' · '),
        mine: it.mine,
      };
    }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
    const nKods = new Set([...byCat.get(cat).values()].flatMap((it) => [...it.kods])).size;
    return `<div class="span-6 card alt-card">
  <div class="viz-head"><span class="viz-label">${esc(catName(cat))}</span><span class="viz-n">${esc(scope === 'liknande' ? `${fmtInt(nKods)} av ${fmtInt(total)} liknande köper här` : nOf(nKods, 'kommun', 'kommuner'))}</span></div>
  ${rankingBars({ items, max: MAX_ALT, highlight: items.filter((it) => it.mine).map((it) => it.label), noun: 'produkter' })}
</div>`;
  };
  const restCats = cats.slice(MAX_ALT_CARDS);
  const cards = cats.slice(0, MAX_ALT_CARDS).map(cardOf).join('')
    + (restCats.length ? `<div class="span-12">${fold(`Visa ${nOf(restCats.length, 'kategori', 'kategorier')} till: ${restCats.map(catName).join(', ')}`, `<div class="grid-12 alt-grid">${restCats.map(cardOf).join('')}</div>`)}</div>` : '');
  const lede = scope === 'liknande'
    ? `Produkter i aktiva avtal hos liknande kommuner, efter hur många av dem som har produkten. Median per elev räknas över alla kommuner och visas från ${MIN_N} kommuner med känt pris.`
    : `Ingen liknande kommun har aktiva avtal hos oss än, så här visas alla kommuner. Median per elev visas från ${MIN_N} kommuner med känt pris.`;
  return `<p class="meta alt-lede">${esc(lede)}</p><div class="grid-12 alt-grid">${cards}</div>`;
}

// ------------------------------------------------------------ renewals

function renewals({ kommun, mine, head, peers, today, status }) {
  const avtal = consolidateByContract(mine);
  const dated = avtal.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today)
    .sort((a, b) => a.next_renewal.localeCompare(b.next_renewal));
  const unknown = avtal.length - dated.length;
  const peerSet = new Set(peers);
  const until = addMonthsIso(today, RENEWAL_MONTHS);
  const ownCats = new Set(mine.map(catOf));
  const peerSoon = byContract(head.filter((f) => peerSet.has(f.kommun_kod) && (!ownCats.size || ownCats.has(catOf(f)))
    && isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today && f.next_renewal.slice(0, 10) <= until));
  const peerLine = peerSoon.length
    ? `Hos liknande kommuner löper ${nOf(peerSoon.length, 'avtal', 'avtal')}${ownCats.size ? ' i samma kategorier' : ''} ut inom ${RENEWAL_MONTHS} mån.`
    : '';
  const basis = [
    avtal.length ? `${fmtInt(dated.length)} av ${nOf(avtal.length, 'aktivt avtal', 'aktiva avtal')} har känt slutdatum` : '',
    `räknat med ${TENDER_LEAD_MONTHS} månader för en upphandling`,
  ].filter(Boolean).join(', ');

  if (!dated.length) {
    const text = !avtal.length
      ? status === 'not_contacted' ? 'Vi känner inte till kommunens avtal än.' : 'Vi har inga aktiva avtal från kommunen.'
      : `${nOf(unknown, 'aktivt avtal anger', 'aktiva avtal anger')} inget slutdatum, så de kan förnyas utan att synas här.`;
    return { html: `<div class="card">${emptyPanel({ title: 'Inga kända förnyelser', text, context: peerLine })}</div>`, basis };
  }
  const lanes = dated.slice(0, MAX_OWN_LANES).map((f) => {
    const date = f.next_renewal.slice(0, 10);
    const names = productNames(f).join(', ');
    return {
      label: f.company_name,
      href: companyHref(f.company_slug),
      sub: `${names ? `${names}, ` : ''}${tenderCue(date, today)}`,
      items: [{
        date,
        value: isNum(f.annual_value_sek) ? f.annual_value_sek : null,
        valueLabel: isNum(f.annual_value_sek) ? `${fmtKrCompact(f.annual_value_sek)}/år` : null,
        title: `${names || f.company_name}: ${tenderCue(date, today)}`,
      }],
    };
  });
  const tl = renewalTimeline({ today, months: RENEWAL_MONTHS, laneHead: 'Avtal', lanes });
  const notes = [dated.length > MAX_OWN_LANES ? `Visar de ${MAX_OWN_LANES} avtal som förnyas först, ${fmtInt(dated.length - MAX_OWN_LANES)} till förnyas senare.` : '', unknown ? `${nOf(unknown, 'aktivt avtal', 'aktiva avtal')} utan känt slutdatum syns inte här.` : '', peerLine].filter(Boolean);
  return { html: `<div class="card">${tl}${notes.length ? `<p class="meta tl-rest">${esc(notes.join(' '))}</p>` : ''}</div>`, basis };
}

// ------------------------------------------------------------ map

function peerMap({ kommun, peers, stats, groupWord }) {
  const tiles = safeTiles();
  const peerSet = new Set(peers);
  const classOf = (kod) => (kod === kommun.kod ? 'highlight' : peerSet.has(kod) ? 'has' : 'neutral');
  const titleOf = (kod) => (kod === kommun.kod ? kommun.namn : peerSet.has(kod) ? `Liknande kommun, ${groupWord}` : 'Övrig kommun, annan grupp');
  const known = new Set(safeAll(stats).map((r) => r.kod));
  return tileMap({
    tiles,
    classOf: (kod) => (known.size && !known.has(kod) && kod !== kommun.kod ? 'unknown' : classOf(kod)),
    titleOf,
    legend: [
      { cls: 'highlight', label: kommun.namn },
      { cls: 'has', label: `Liknande kommuner, ${groupWord}` },
      { cls: 'neutral', label: 'Övriga kommuner' },
    ],
    label: `${kommun.namn} bland liknande kommuner`,
  });
}

function safeTiles() {
  try { return loadKommunTiles(); } catch { return { cols: 1, rows: 1, tiles: {} }; }
}

// ------------------------------------------------------------ page

export function renderKommun({ kod, kommun = null, stats, facts, statusMap = new Map(), today, page = 1 }) {
  if (!isIso(today)) throw new Error('renderKommun requires today as YYYY-MM-DD');
  const k = kommun ?? findKommun({ kod, stats, facts });
  // kommunView: a samverkansavtal is listed, but its value is the whole
  // avtal's and the kommun's share is unknown, so it is never the kommun's
  // spend and never a peer's.
  const all = facts.filter((f) => f.kommun_kod === k.kod).map(kommunView);
  const head = headline(facts).map(kommunView);
  const mine = headline(all);
  // Whole avtal: a channel avtal's owner rows add up to its value.
  const avtal = consolidateByContract(mine);
  // Avtal from a kommun with no sent request (e.g. received another way) is
  // not "not contacted": we do not know how complete the collection is.
  const raw = statusMap.get(k.kod) ?? (all.length ? 'unknown' : 'not_contacted');
  const status = raw === 'not_contacted' && all.length ? 'unknown' : raw;
  const st = STATUS[status] ?? STATUS.unknown;
  const peers = safePeers(stats, k.kod);
  const groupWord = k.kommungrupp ? `kommungrupp ${k.kommungrupp.toLowerCase()}` : k.sizeBand ? `samma storlek (${k.sizeBand} invånare)` : 'ingen jämförelsegrupp';
  const profile = kommunProfile(facts, stats, k.kod, { today });
  const elever = safeElever(stats, k.kod);
  const known = avtal.filter((f) => isNum(f.annual_value_sek));
  const jointAvtal = avtal.filter((f) => f.joint);

  const statusWord = status === 'not_contacted' ? 'vi har inte begärt ut avtal här än'
    : status === 'open' ? 'insamling pågår' : status === 'done' ? 'insamling klar' : status === 'partial' ? 'delvis utlämnat'
      : status === 'dead_end' ? 'kommunen har inte lämnat ut avtal' : 'insamlingens status är okänd';
  const who = [
    isNum(k.folkmangd) ? `${fmtInt(k.folkmangd)} invånare` : null,
    elever ? `${fmtInt(elever)} elever i förskoleklass till åk 9` : null,
  ].filter(Boolean).join(' och ');
  const answer = `${k.namn}${who ? ` har ${who}` : ''}${peers.length ? ` och jämförs här med ${nOf(peers.length, 'liknande kommun', 'liknande kommuner')} i ${groupWord}` : ''}. ${avtal.length
    ? `Vi har ${nOf(avtal.length, 'aktivt avtal', 'aktiva avtal')} härifrån, ${statusWord}.`
    : status === 'not_contacted' ? `Sidan bygger på liknande kommuner: ${statusWord}.`
      : status === 'open' ? `Inga aktiva avtal tolkade än, ${statusWord}.`
        : status === 'done' ? `Vi har inga aktiva avtal härifrån, ${statusWord}.`
          : status === 'dead_end' ? `Sidan bygger på liknande kommuner: ${statusWord}.` : 'Inga aktiva avtal i underlaget.'}`;

  const facts3 = avtal.length
    ? [
      { label: 'Elever F-9', value: elever, sub: 'kommunal regi' },
      { label: 'Aktiva avtal', value: avtal.length, sub: `${fmtInt(byContract(all).length)} insamlade` },
      { label: 'Känt årsvärde', value: known.length ? fmtKrCompact(sumKnown(known)) : null, sub: `${basisLine(known.length, avtal.length)}${jointAvtal.length ? `, ${nOf(jointAvtal.length, 'samverkansavtal', 'samverkansavtal')} med okänd andel räknas inte` : ''}` },
    ]
    : [
      { label: 'Elever F-9', value: elever, sub: 'kommunal regi' },
      { label: 'Invånare', value: k.folkmangd, sub: k.lan ?? '' },
      { label: 'Liknande kommuner', value: peers.length, sub: k.kommungrupp ? 'samma kommungrupp' : 'samma storlek' },
    ];
  const stText = status === 'open' && !avtal.length ? 'Kommunen har inte lämnat ut sina avtal än. Att inga syns här betyder inte att kommunen saknar avtal.'
    : status === 'done' && all.length ? 'Kommunen har svarat på vår begäran och avtalen vi fått är inlagda.'
      : status === 'unknown' && all.length ? 'Vi har avtal härifrån men ingen registrerad begäran, så vi vet inte om underlaget är komplett.'
        : st.text;
  const statusViz = `<div class="kn-status ${st.cls}"><span class="kn-chip"><i aria-hidden="true"></i>${esc(st.chip)}</span><p>${esc(stText)}</p></div>`;
  const header = entityHeader({
    kicker: ['Kommun', k.lan, k.kommungrupp].filter(Boolean).join(' · '),
    title: k.namn,
    answer,
    facts: facts3,
    viz: statusViz,
  });

  const priceInfo = priceRows({ kommun: k, mine, facts, peers, today });
  const upcoming = avtal.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today)
    .sort((a, b) => a.next_renewal.localeCompare(b.next_renewal));
  const kpis = avtal.length ? `<section class="section"><div class="kpi-row">
    ${kpiTile({ label: 'Nästa förnyelse', value: upcoming.length ? monthsUntil(upcoming[0].next_renewal, today) : null, state: upcoming.length ? 'known' : 'unknown', reason: 'Inget aktivt avtal anger slutdatum eller förlängning.', basis: upcoming.length ? `${upcoming[0].company_name}, ${tenderCue(upcoming[0].next_renewal.slice(0, 10), today)}` : '' })}
    ${kpiTile(renewalTileProps({ avtal, buckets: renewalBuckets(all, { today, months: 12 }), today }))}
    ${kpiTile({ label: 'Pris per elev känt', value: priceInfo.pricedAvtal, unit: `av ${fmtInt(avtal.length)}`, state: priceInfo.pricedAvtal ? (priceInfo.pricedAvtal < avtal.length ? 'partial' : 'known') : 'unknown', reason: 'Inget av avtalen anger pris per elev.', basis: priceInfo.priced > priceInfo.pricedAvtal ? `aktiva avtal, ${fmtInt(priceInfo.priced)} priser i dem` : 'aktiva avtal' })}
    ${kpiTile({ label: 'Går att jämföra', value: priceInfo.comparable, unit: `av ${fmtInt(priceInfo.priced)}`, state: priceInfo.comparable ? 'known' : 'unknown', reason: priceInfo.priced ? `För få jämförbara kommuner, vi jämför från ${MIN_N}.` : 'Inget pris per elev att jämföra.', basis: `priser, minst ${MIN_N} andra kommuner med känt pris` })}
  </div></section>` : '';

  const renew = renewals({ kommun: k, mine, head, peers, today, status });
  const ev = evidenceSection({ rows: consolidateByContract(all), today, page, nameOf: () => k.namn, pageHref: (p) => `/studio/kommun/${encodeURIComponent(k.kod)}?sida=${p}#underlag` });
  const priceSection = avtal.length
    ? section({ id: 'pris', kicker: 'Pris', title: 'Ert pris vs liknande kommuner', note: `en punkt per kommun, ${k.namn} markerad, övriga kommuner anonyma`, body: priceInfo.html })
    : '';

  return `${breadcrumb([{ label: 'Kommuner', href: '/studio/kommuner' }, { label: k.namn }])}
${header}
${kpis}
${overlapSection({ profile, mine })}
${section({ id: 'kop', kicker: 'Köp', title: avtal.length ? 'Så här köper ni' : 'Så här köper liknande kommuner', note: `per kategori, ${groupWord}`, body: spendSection({ kommun: k, profile, head, peers, stats, mine, statusMap }) })}
${priceSection}
${section({ id: 'alternativ', kicker: 'Alternativ', title: avtal.length ? 'Vad liknande kommuner använder' : 'Vad liknande kommuner köper', note: 'efter antal kommuner, ni markerade', body: alternatives({ kommun: k, head, peers, mine }) })}
${section({ id: 'fornyelser', kicker: 'Förnyelser', title: 'När avtalen löper ut', note: renew.basis, body: renew.html })}
${section({ id: 'karta', kicker: 'Var', title: `${k.namn} och liknande kommuner`, note: groupWord, body: `<div class="card map-card">${peerMap({ kommun: k, peers, stats, groupWord })}</div>` })}
${section({ id: 'underlag', kicker: 'Underlag', title: 'Avtalen bakom siffrorna', note: all.length ? `${fmtInt(ev.active)} aktiva, ${fmtInt(ev.old)} utgångna eller ersatta` : '', body: all.length ? ev.html : emptyPanel({ title: 'Inga avtal från kommunen i underlaget', text: stText }) })}`;
}
