// /studio (spec §7.5 item 1) and /studio/kategorier (item 8). The first page
// a customer sees: how big the known market is, who leads, what comes up for
// renewal. Every figure comes from active, non-superseded avtal; an unknown
// value is never added as 0, and every aggregate carries its basis.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, fmtPct, fmtPrice } from '../format.js';
import { CATEGORIES, companyBySlug } from '../../catalogue.js';
import { companyShares, marketByCategory, priceDistribution, renewalBuckets, KOMMUNER_TOTAL, UNKNOWN_CATEGORY, MIN_N } from '../../studio-data.js';
import { kpiTile, emptyPanel } from '../components.js';
import { rankingBars } from '../charts.js';
import {
  isNum, headline, byContract, categoryLabel, companyHref, kommunHref, kommunNamer,
  section, renewalTileProps, nOf, isIso,
} from './common.js';

export const ADDA_MONTH = '2027-01';
export const ADDA_NOTE = 'Addas ramavtal Digitala läromedel 2022 löper ut 31 jan 2027';
export const WAVE_MONTHS = 24;
const MONTHS_SV = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_LONG = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const LATEST_MAX = 8;

// Known value over the distinct avtal of some rows: { value, known, total }.
export function knownValue(rows) {
  const avtal = new Map();
  for (const f of rows) {
    const a = avtal.get(f.contract_id) ?? { known: false, value: 0 };
    if (isNum(f.annual_value_sek)) { a.known = true; a.value += f.annual_value_sek; }
    avtal.set(f.contract_id, a);
  }
  const vals = [...avtal.values()];
  const known = vals.filter((a) => a.known);
  return { value: known.length ? known.reduce((s, a) => s + a.value, 0) : null, known: known.length, total: vals.length };
}

// "känt för 10 av 11 aktiva avtal"
const basisOf = (kv) => `känt för ${fmtInt(kv.known)} av ${nOf(kv.total, 'aktivt avtal', 'aktiva avtal')}`;

// ------------------------------------------------------------ completeness

// One ring: kommuner with an active avtal of all 290. Square viewBox, so it
// scales without distortion.
export function completenessRing({ covered, total = KOMMUNER_TOTAL, label = 'av kommunerna' }) {
  const share = total > 0 ? Math.min(1, covered / total) : 0;
  const r = 52;
  const c = 2 * Math.PI * r;
  return `<figure class="ring" role="img" aria-label="${esc(`${fmtInt(covered)} av ${fmtInt(total)} kommuner har aktiva avtal i underlaget`)}">
  <svg viewBox="0 0 132 132" width="132" height="132" aria-hidden="true">
    <circle class="ring-track" cx="66" cy="66" r="${r}"/>
    <circle class="ring-fill" cx="66" cy="66" r="${r}" stroke-dasharray="${(share * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 66 66)"/>
  </svg>
  <figcaption class="ring-center"><b>${esc(fmtPct(share))}</b><span>${esc(label)}</span></figcaption>
</figure>`;
}

// ------------------------------------------------------------ share bar

// Top three companies' share of known value, one hue stepped dark to light
// (the three names differ per category, so the colour encodes rank within
// the bar, and the names sit next to it).
export function shareBar(top = [], { compact = false } = {}) {
  const known = top.filter((t) => isNum(t.share));
  if (!top.length || !known.length) {
    return `<div class="share is-unknown"><div class="share-bar hatch" role="img" aria-label="Andelar okända"></div><p class="meta">${top.length ? 'andelar okända, inget känt värde' : 'inga leverantörer än'}</p></div>`;
  }
  const rest = Math.max(0, 1 - known.reduce((s, t) => s + t.share, 0));
  const segs = known.map((t, i) => `<i class="share-seg s${i + 1}" style="flex-basis:${(t.share * 100).toFixed(2)}%"></i>`).join('')
    + (rest > 0.0005 ? `<i class="share-seg s-rest" style="flex-basis:${(rest * 100).toFixed(2)}%"></i>` : '');
  const aria = known.map((t) => `${t.name} ${fmtPct(t.share)}`).join(', ') + (rest > 0.0005 ? `, övriga ${fmtPct(rest)}` : '');
  const list = top.map((t, i) => `<li><i class="share-sw s${i + 1}"></i><span class="share-name">${esc(t.name)}</span><b>${esc(isNum(t.share) ? fmtPct(t.share) : 'okänt')}</b></li>`).join('');
  return `<div class="share${compact ? ' is-compact' : ''}">
  ${compact ? '' : '<span class="share-cap">Största leverantörer, andel av känt årsvärde</span>'}
  <div class="share-bar" role="img" aria-label="${esc(`Andel av känt värde: ${aria}`)}">${segs}</div>
  <ol class="share-list">${list}</ol>
</div>`;
}

// ------------------------------------------------------------ category tiles

// Top three by known value; a company with no known value has an unknown
// share, never 0 %.
export function topThree(facts, category) {
  return companyShares(facts, { category }).slice(0, 3).map((s) => ({ name: s.name, share: s.n_known ? s.share_value : null }));
}

export function categoryCards({ facts, includeEmpty = false }) {
  const market = new Map(marketByCategory(facts).map((m) => [m.category, m]));
  const cats = CATEGORIES.map((c) => ({ ...c, m: market.get(c.slug) ?? null }))
    .filter((c) => includeEmpty || c.m)
    .sort((a, b) => (b.m?.value_known_sek ?? -1) - (a.m?.value_known_sek ?? -1) || (b.m?.n_avtal ?? 0) - (a.m?.n_avtal ?? 0));
  const cards = cats.map((c, i) => {
    const href = `/studio/kategori/${encodeURIComponent(c.slug)}`;
    if (!c.m) {
      return `<a class="card ct is-link is-empty" href="${esc(href)}" data-pane-link style="--i:${i}">
  <div class="ct-head"><h3 class="ct-name">${esc(c.label)}</h3><span class="viz-n">0 avtal</span></div>
  <p class="ct-none">Inga aktiva avtal i kategorin än.</p>
</a>`;
    }
    const m = c.m;
    const rows = headline(facts).filter((f) => (f.category ?? UNKNOWN_CATEGORY) === c.slug);
    const kv = knownValue(rows);
    const dist = priceDistribution(facts, { category: c.slug });
    const reach = m.kommuner / KOMMUNER_TOTAL;
    const priced = !dist.suppressed && isNum(dist.median);
    return `<a class="card ct is-link" href="${esc(href)}" data-pane-link style="--i:${i}">
  <div class="ct-head"><h3 class="ct-name">${esc(c.label)}</h3><span class="viz-n">${esc(nOf(m.n_avtal, 'avtal', 'avtal'))}</span></div>
  <div class="ct-value${kv.value == null ? ' is-unknown' : ''}">
    <span class="ct-num">${esc(kv.value == null ? 'värde okänt' : fmtKrCompact(kv.value))}</span>${kv.value == null ? '' : '<span class="ct-unit">per år</span>'}
    <span class="meta">${esc(basisOf(kv))}</span>
  </div>
  <div class="ct-reach">
    <div class="ct-reach-row"><span><b>${esc(fmtInt(m.kommuner))}</b> ${m.kommuner === 1 ? 'kommun' : 'kommuner'}</span><span class="meta">av ${esc(fmtInt(KOMMUNER_TOTAL))}</span></div>
    <div class="meter ct-meter"><span class="meter-fill grow-x" style="width:${(reach * 100).toFixed(1)}%;--i:${i}"></span></div>
  </div>
  <div class="ct-share"><span class="ct-sub">Största leverantörer, andel av känt värde</span>${shareBar(topThree(facts, c.slug), { compact: true })}</div>
  <div class="ct-price${priced ? '' : ' is-unknown hatch'}">${priced
    ? `median <b>${esc(fmtPrice(dist.median))}</b> kr/elev <span class="meta">n = ${esc(fmtInt(dist.n))}</span>`
    : `<span>${esc(dist.n ? `för få avtal med pris per elev (n = ${fmtInt(dist.n)})` : 'inget känt pris per elev')}</span><span class="meta">median visas från ${MIN_N}</span>`}</div>
</a>`;
  }).join('');
  const unk = market.get(UNKNOWN_CATEGORY);
  const unkLine = unk
    ? `<p class="meta ct-foot">${esc(nOf(unk.n_avtal, 'aktivt avtal', 'aktiva avtal'))} från ${esc(nOf(unk.kommuner, 'kommun', 'kommuner'))} har ingen känd kategori${unk.n_known ? `, känt värde ${esc(fmtKrCompact(unk.value_known_sek))} per år` : ''}. De räknas i totalen men inte i någon kategori.</p>`
    : '';
  if (!cards) return emptyPanel({ title: 'Inga aktiva avtal än', text: 'När de första avtalen är tolkade visas kategorierna här.' }) + unkLine;
  return `<div class="ct-grid">${cards}</div>${unkLine}`;
}

// ------------------------------------------------------------ renewal wave

function monthsFrom(today, n) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return Array.from({ length: n }, (_, k) => {
    const t = y * 12 + (m - 1) + k;
    return { key: `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`, y: Math.floor(t / 12), m: t % 12 };
  });
}

function bucketValueText(b) {
  if (!b.n) return '';
  if (!b.n_known) return 'värde okänt';
  if (b.n_known < b.n) return `känt värde ${fmtKrCompact(b.value_known_sek)}/år, känt för ${fmtInt(b.n_known)} av ${fmtInt(b.n)}`;
  return `${fmtKrCompact(b.value_known_sek)}/år`;
}

// Avtal ending or up for renewal per month, a single series of HTML bars
// (crisp at any width). The three tallest months and the Adda month carry a
// direct label; every bar has a hover tip with count and known value.
export function renewalWave({ buckets = [], today, foot = '' }) {
  if (!isIso(today)) throw new Error('renewalWave requires today as YYYY-MM-DD');
  const months = buckets.length
    ? buckets.map((b) => { const [y, m] = b.month.split('-').map(Number); return { key: b.month, y, m: m - 1 }; })
    : monthsFrom(today, WAVE_MONTHS);
  const byMonth = new Map(buckets.map((b) => [b.month, b]));
  const cols = months.map((mo) => ({ ...mo, b: byMonth.get(mo.key) ?? { n: 0, n_known: 0, value_known_sek: 0 } }));
  const max = Math.max(1, ...cols.map((c) => c.b.n));
  const top = new Set([...cols].filter((c) => c.b.n > 0).sort((a, b) => b.b.n - a.b.n).slice(0, 3).map((c) => c.key));
  const addaIdx = cols.findIndex((c) => c.key === ADDA_MONTH);
  const total = cols.reduce((s, c) => s + c.b.n, 0);
  const n = cols.length;
  const bars = cols.map((c, i) => {
    const h = c.b.n ? Math.max(3, (c.b.n / max) * 100) : 0;
    const adda = i === addaIdx;
    const side = i > n * 0.7 ? ' tip-left' : i < n * 0.3 ? ' tip-right' : '';
    const label = top.has(c.key) || (adda && c.b.n) ? `<b class="rw-lbl">${esc(fmtInt(c.b.n))}</b>` : '';
    const what = `${MONTHS_LONG[c.m]} ${c.y}`;
    const vt = bucketValueText(c.b);
    return `<span class="rw-col${adda ? ' is-adda' : ''}${c.m === 0 ? ' is-year' : ''}${side}" tabindex="0" aria-label="${esc(`${what}: ${c.b.n} avtal${vt ? `, ${vt}` : ''}`)}">
      <span class="rw-stack">${label}<i class="rw-bar grow-y" style="height:${h.toFixed(1)}%;--i:${i}"></i></span>
      <span class="tip" role="tooltip"><strong>${esc(what)}</strong><span>${esc(fmtInt(c.b.n))} avtal${vt ? `, ${esc(vt)}` : ''}</span></span>
    </span>`;
  }).join('');
  const axis = cols.map((c, i) => {
    const show = c.m === 0 || i === 0 || c.m % 3 === 0;
    const txt = c.m === 0 ? String(c.y) : MONTHS_SV[c.m];
    return `<span class="rw-tick${c.m === 0 ? ' is-year' : ''}${c.m % 3 === 0 || c.m === 0 || i === 0 ? '' : ' is-minor'}">${show ? esc(txt) : ''}</span>`;
  }).join('');
  const pos = addaIdx >= 0 ? ((addaIdx + 0.5) / n) * 100 : null;
  const note = addaIdx >= 0
    ? `<div class="rw-notes"><span class="rw-note${pos > 55 ? ' is-right' : ''}" style="--x:${pos.toFixed(2)}%"><i aria-hidden="true"></i><span>${esc(ADDA_NOTE)}</span></span></div>`
    : '';
  return `<figure class="viz rw">
  <div class="viz-head"><span class="viz-label">Avtal som löper ut eller förnyas, per månad</span><span class="viz-n">${esc(fmtInt(total))} avtal på ${esc(fmtInt(n))} mån</span></div>
  ${note}
  <div class="rw-plot${addaIdx >= 0 ? ' has-note' : ''}" style="--n:${n}${pos != null ? `;--adda:${pos.toFixed(2)}%` : ''}">
    <div class="rw-bars">${bars}</div>
    <div class="rw-axis" aria-hidden="true">${axis}</div>
  </div>
  ${foot ? `<figcaption class="viz-foot"><span>${esc(foot)}</span></figcaption>` : ''}
</figure>`;
}

// "612 av 716 aktiva avtal har känt slutdatum, 104 utan"
export function waveFoot(facts, today, months = WAVE_MONTHS) {
  const head = byContract(headline(facts));
  const dated = head.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today);
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const t = y * 12 + (m - 1) + months;
  const end = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  const later = dated.filter((f) => f.next_renewal.slice(0, 7) >= end).length;
  const undated = head.length - dated.length;
  return [
    `en stapel per månad, ${fmtInt(dated.length)} av ${nOf(head.length, 'aktivt avtal', 'aktiva avtal')} har känt slutdatum eller förlängning`,
    later ? `${fmtInt(later)} senare än så` : '',
    undated ? `${fmtInt(undated)} utan känt datum syns inte här` : '',
  ].filter(Boolean).join(', ');
}

// ------------------------------------------------------------ vendors

export function vendorRankings({ facts, category = null, max = 8, highlight = null }) {
  const shares = companyShares(facts, category ? { category } : {});
  const noun = 'leverantörer';
  const byValue = shares.map((s) => ({
    label: s.name,
    href: companyHref(s.slug),
    value: s.n_known ? s.value_known_sek : null,
    valueLabel: `${fmtKrCompact(s.value_known_sek)}/år`,
    share: s.n_known ? s.share_value : null,
    sub: [category ? null : categoryLabel(companyBySlug(s.slug)?.category ?? null), nOf(s.kommuner, 'kommun', 'kommuner')].filter((x) => x && x !== 'Okänd kategori').join(' · '),
  })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || a.label.localeCompare(b.label, 'sv'));
  const byKommun = shares.map((s) => ({
    label: s.name,
    href: companyHref(s.slug),
    value: s.kommuner,
    valueLabel: nOf(s.kommuner, 'kommun', 'kommuner'),
    share: s.share_kommuner,
    sub: nOf(s.n_avtal, 'aktivt avtal', 'aktiva avtal'),
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
  const kv = knownValue(headline(facts).filter((f) => !category || (f.category ?? UNKNOWN_CATEGORY) === category));
  if (!shares.length) return emptyPanel({ title: 'Inga leverantörer med aktiva avtal än' });
  return `<div class="grid-12">
  <div class="span-6 card"><div class="viz-head"><span class="viz-label">Efter känt årsvärde</span><span class="viz-n">andel av känt värde</span></div>
    <p class="meta card-lede">Värdet är ${esc(basisOf(kv))}. Leverantörer utan känt värde ligger sist.</p>
    ${rankingBars({ items: byValue, max, noun, highlight })}</div>
  <div class="span-6 card"><div class="viz-head"><span class="viz-label">Efter antal kommuner</span><span class="viz-n">andel av kommunerna med avtal</span></div>
    <p class="meta card-lede">Räknar kommuner med minst ett aktivt avtal, oavsett om värdet är känt.</p>
    ${rankingBars({ items: byKommun, max, noun, highlight })}</div>
</div>`;
}

// ------------------------------------------------------------ latest

function latestReceived({ facts, nameOf }) {
  // One row per kommun x company x day: three avtal Säsjö sent the same day
  // for the same vendor read as one delivery, "3 avtal".
  const seen = new Set();
  const groups = new Map();
  const sorted = facts.filter((f) => isIso(f.received_at) && f.kommun_kod)
    .sort((a, b) => b.received_at.localeCompare(a.received_at) || b.contract_id - a.contract_id);
  for (const f of sorted) {
    if (seen.has(f.contract_id)) continue;
    if (f.company_slug && companyBySlug(f.company_slug)?.hiddenInStudio) continue;
    seen.add(f.contract_id);
    const key = `${f.received_at}|${f.kommun_kod}|${f.company_slug ?? f.company_name}`;
    if (!groups.has(key)) {
      if (groups.size >= LATEST_MAX) break;
      groups.set(key, { ...f, n: 0 });
    }
    groups.get(key).n += 1;
  }
  const rows = [...groups.values()];
  if (!rows.length) return emptyPanel({ title: 'Inga avtal inkomna än' });
  return `<ol class="latest">${rows.map((f, i) => {
    const href = companyHref(f.company_slug);
    const company = href ? `<a href="${esc(href)}" data-pane-link>${esc(f.company_name)}</a>` : `<span>${esc(f.company_name)}</span>`;
    const cat = f.category ? `<a class="chip" href="/studio/kategori/${esc(encodeURIComponent(f.category))}" data-pane-link>${esc(categoryLabel(f.category))}</a>` : '';
    return `<li class="latest-row" style="--i:${i}">
    <span class="latest-date">${esc(f.received_at)}</span>
    <span class="latest-what"><a class="latest-kommun" href="${esc(kommunHref(f.kommun_kod))}" data-pane-link>${esc(nameOf(f.kommun_kod))}</a><span class="latest-co">${company}${f.n > 1 ? `, ${esc(fmtInt(f.n))} avtal` : ''}</span></span>
    <span class="latest-cat">${cat}</span>
  </li>`;
  }).join('')}</ol>`;
}

// ------------------------------------------------------------ pages

export function renderMarknad({ facts, stats, statusMap, today, basis }) {
  const b = basis ?? {};
  const head = headline(facts);
  const avtal = byContract(head);
  const kv = knownValue(head);
  const nameOf = kommunNamer(stats, facts);
  const covered = b.kommuner_with_avtal ?? 0;
  const leader = companyShares(facts).find((s) => s.n_known && isNum(s.share_value));
  const active = b.active ?? 0;
  const collected = b.collected ?? 0;
  const lede = `Underlaget är ${nOf(active, 'aktivt avtal', 'aktiva avtal')} (${fmtInt(collected)} ${collected === 1 ? 'insamlat' : 'insamlade'}) från ${fmtInt(covered)} av ${fmtInt(KOMMUNER_TOTAL)} kommuner, begärda som allmänna handlingar och tolkade rad för rad.${leader ? ` Störst är ${leader.name} med ${fmtPct(leader.share_value)} av det kända värdet.` : ''}`;

  const header = `<section class="entity-header mk-hero">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Marknad · Skolans digitala verktyg</span>
      <h1 class="page-title">Vad Sveriges kommuner betalar för skolans digitala verktyg</h1>
      <div class="mk-value${kv.value == null ? ' is-unknown' : ''}">
        <span class="mk-num">${esc(kv.value == null ? 'okänt' : fmtKrCompact(kv.value))}</span>${kv.value == null ? '' : '<span class="mk-unit">per år i kända avtalsvärden</span>'}
      </div>
      <p class="mk-basis">${esc(kv.total ? `värdet är ${basisOf(kv)}` : 'inga aktiva avtal än')}</p>
      <p class="lede">${esc(lede)}</p>
    </div>
    <div class="mk-side">
      ${completenessRing({ covered })}
      <dl class="mk-facts">
        <div><dt>Kommuner med avtal</dt><dd><b>${esc(fmtInt(covered))}</b> av ${esc(fmtInt(KOMMUNER_TOTAL))}</dd></div>
        <div><dt>Insamling klar</dt><dd><b>${esc(fmtInt(b.done ?? 0))}</b> kommuner</dd></div>
        <div><dt>Aktiva avtal</dt><dd><b>${esc(fmtInt(active))}</b> av ${esc(fmtInt(collected))} insamlade</dd></div>
      </dl>
    </div>
  </div>
</section>`;

  const buckets = renewalBuckets(facts, { today, months: WAVE_MONTHS });
  const b12 = renewalBuckets(facts, { today, months: 12 });
  const leaders = companyShares(facts).filter((s) => s.n_known).length;
  const kpis = `<div class="kpi-row">
    ${kpiTile({ label: 'Leverantörer', value: companyShares(facts).length, unit: 'med aktiva avtal', basis: `${fmtInt(leaders)} med känt värde`, state: avtal.length ? 'known' : 'unknown', reason: 'Inga aktiva avtal än.' })}
    ${kpiTile({ label: 'Kategorier', value: marketByCategory(facts).filter((m) => m.category !== UNKNOWN_CATEGORY).length, unit: `av ${CATEGORIES.length}`, basis: 'med minst ett aktivt avtal', state: avtal.length ? 'known' : 'unknown', reason: 'Inga aktiva avtal än.' })}
    ${kpiTile(renewalTileProps({ avtal, buckets: b12, today }))}
    ${kpiTile({ label: 'Slutdatum okänt', value: b.active_unknown_end ?? 0, unit: 'avtal', basis: 'räknas som aktiva i fyra år från avtalsstart', state: 'known' })}
  </div>`;

  return `${header}
<section class="section">${kpis}</section>
${section({ id: 'kategorier', kicker: 'Kategorier', title: 'Hur stor är varje kategori', note: 'känt årsvärde, kommuner och de tre största leverantörerna', body: categoryCards({ facts }) })}
${section({ id: 'fornyelser', kicker: 'Förnyelser', title: 'Det här kommer upp för upphandling', note: `${WAVE_MONTHS} månader framåt, håll över en stapel för detaljer`, body: `<div class="card">${renewalWave({ buckets, today, foot: waveFoot(facts, today) })}</div>` })}
${section({ id: 'leverantorer', kicker: 'Leverantörer', title: 'Största leverantörer', note: 'alla kategorier, aktiva avtal', body: vendorRankings({ facts }) })}
${section({ id: 'senaste', kicker: 'Senast inkomna', title: 'Avtal vi har fått in senast', note: 'kommun, leverantör och datum då avtalet kom in', body: `<div class="card">${latestReceived({ facts, nameOf })}</div>` })}`;
}

export function renderKategorier({ facts }) {
  return `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Kategorier</span>
      <h1 class="page-title">Marknaden kategori för kategori</h1>
      <p class="lede">Känt årsvärde, antal kommuner, de största leverantörerna och medianpris per elev för varje kategori. Klicka en kategori för andelar, priser per segment, vita fläckar och förnyelser.</p>
    </div>
  </div>
</section>
${section({ id: 'kategorier', kicker: 'Alla kategorier', title: 'Kategorier efter känt årsvärde', note: 'aktiva avtal', body: categoryCards({ facts, includeEmpty: true }) })}`;
}
