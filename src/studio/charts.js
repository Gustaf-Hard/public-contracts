// Mediagraf Studio charts. Server-rendered, no inline scripts, every text
// input escaped. Two rules keep text crisp at any width:
//  - SVG marks use percentage x coordinates in an SVG with no viewBox and a
//    fixed pixel height, so dots stay round and nothing is scaled;
//  - every label lives in HTML positioned over the plot, never inside the SVG.
// Hover detail is an HTML overlay (`.tip`) shown by CSS on :hover/:focus, plus
// a native <title> per mark for assistive tech. Honesty: below MIN_N priced
// avtal no dot, median or band is drawn; the hatched panel says why.

import { readFileSync } from 'node:fs';
import { esc } from './layout.js';
import { fmtInt, fmtPrice, UNKNOWN } from './format.js';
import { MIN_N } from '../studio-data.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (x) => `${(Math.round(x * 100) / 100).toFixed(2)}%`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// Tooltip side so a tip near an edge opens inwards.
const side = (p) => (p > 72 ? ' tip-left' : p < 28 ? ' tip-right' : '');

function niceStep(span, target = 4) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

// Linear domain for a position axis. Starts at 0 unless the data sits far
// from it; always non-empty so a constant series still has a scale.
export function niceDomain(min, max) {
  let lo = min < max * 0.35 ? 0 : min * 0.9;
  let hi = max * 1.04;
  if (!(hi > lo)) { lo = 0; hi = max > 0 ? max * 1.5 : 1; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 1e6; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function axisTicks(ticks, x, unit) {
  return `<div class="axis-x" aria-hidden="true">${ticks.map((t, i) => {
    const edge = i === 0 ? ' is-first' : i === ticks.length - 1 ? ' is-last' : '';
    return `<span class="axis-tick${edge}" style="left:${pct(x(t))}">${esc(fmtPrice(t))}</span>`;
  }).join('')}${unit ? `<span class="axis-unit">${esc(unit)}</span>` : ''}</div>`;
}

// ---------------------------------------------------------------- strip plot

const DOT_R = 5;
const LANE_H = 9;
const MAX_LANE = 3;

// Greedy beeswarm: each dot takes the lane nearest the centre line where it
// does not touch the previous dot of that lane.
function swarm(xs, minGap) {
  const lastX = new Map();
  const order = [0];
  for (let k = 1; k <= MAX_LANE; k++) order.push(-k, k);
  return xs.map((x) => {
    let lane = order.find((l) => !lastX.has(l) || x - lastX.get(l) >= minGap);
    if (lane === undefined) lane = order.reduce((a, b) => (lastX.get(a) <= lastX.get(b) ? a : b));
    lastX.set(lane, x);
    return lane;
  });
}

export function stripPlot({
  dist, highlightKod = null, highlightLabel = null, unit = 'kr/elev', label = '',
  nameOf = null, unknownCount = null, noun = 'avtal', dotNoun = 'kommun',
} = {}) {
  const d = dist || { n: 0, suppressed: true, values: [] };
  const values = (d.values || []).filter((v) => isNum(v.kr_per_elev));
  // When the dist claims more than the finite values it carries, count what
  // we can actually show; a suppressed dist carries no values, so trust d.n.
  const nRaw = isNum(d.n) ? d.n : 0;
  const n = d.suppressed ? nRaw : Math.min(nRaw, values.length);
  const head = `<div class="viz-head"><span class="viz-label">${esc(label)}</span><span class="viz-n">n = ${esc(fmtInt(n))}</span></div>`;
  const unknownLine = isNum(unknownCount) && unknownCount > 0
    ? `<span>utan känt pris: ${esc(fmtInt(unknownCount))}</span>` : '';

  if (d.suppressed || values.length < MIN_N) {
    const title = n === 0 ? `inga ${noun} med känt pris än` : `för få ${noun} (n = ${fmtInt(n)})`;
    return `<figure class="viz strip is-suppressed">${head}
  <div class="strip-empty hatch" role="note">
    <span class="strip-ghost" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${esc(title)}</strong>
    <span>Median och spridning visas när minst ${MIN_N} ${esc(noun)} har känt pris per elev.</span>
  </div>
  ${unknownLine ? `<figcaption class="viz-foot">${unknownLine}</figcaption>` : ''}
</figure>`;
  }

  const min = isNum(d.min) ? d.min : values[0].kr_per_elev;
  const max = isNum(d.max) ? d.max : values[values.length - 1].kr_per_elev;
  const { lo, hi, ticks } = niceDomain(min, max);
  const x = (v) => clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
  const xs = values.map((v) => x(v.kr_per_elev));
  const lanes = swarm(xs, 1.7);
  const maxLane = Math.max(1, ...lanes.map(Math.abs));
  const bandH = (2 * maxLane + 1) * LANE_H + 12;
  const H = bandH + 20;
  const cy = H / 2;
  const fmtV = (v) => `${fmtPrice(v)} ${unit}`;
  const who = (kod) => {
    if (highlightKod != null && String(kod) === String(highlightKod) && highlightLabel) return highlightLabel;
    const nm = nameOf ? nameOf(kod) : null;
    return nm || 'En kommun';
  };

  const dots = values.map((v, i) => {
    const hl = highlightKod != null && String(v.kommun_kod) === String(highlightKod);
    return `<circle class="mark strip-dot fade-in${hl ? ' is-highlight' : ''}" style="--i:${i}" cx="${pct(xs[i])}" cy="${cy + lanes[i] * LANE_H}" r="${hl ? DOT_R + 2 : DOT_R}"><title>${esc(who(v.kommun_kod))}: ${esc(fmtV(v.kr_per_elev))}</title></circle>`;
  });
  // Highlighted dot last so it paints on top.
  const hlIdx = values.findIndex((v) => highlightKod != null && String(v.kommun_kod) === String(highlightKod));
  if (hlIdx >= 0) dots.push(dots.splice(hlIdx, 1)[0]);

  const hits = values.map((v, i) => `<span class="strip-hit${side(xs[i])}" style="left:${pct(xs[i])};top:${cy + lanes[i] * LANE_H}px"><span class="tip" role="tooltip"><strong>${esc(fmtV(v.kr_per_elev))}</strong><span>${esc(who(v.kommun_kod))}</span></span></span>`).join('');

  const mx = x(d.median);
  const hl = hlIdx >= 0 ? values[hlIdx] : null;
  const hlX = hl ? xs[hlIdx] : null;
  const labelEdge = (p) => (p > 80 ? ' is-right' : p < 20 ? ' is-left' : '');

  const aria = `${label}: ${n} ${noun}, median ${fmtV(d.median)}, mittersta hälften ${fmtPrice(d.p25)} till ${fmtV(d.p75)}`;
  return `<figure class="viz strip">${head}
  <div class="strip-plot">
    <span class="strip-median-label${labelEdge(mx)}" style="left:${pct(mx)}">median <b>${esc(fmtV(d.median))}</b></span>
    <div class="strip-area" style="height:${H}px">
      <svg class="strip-svg" width="100%" height="${H}" role="img" aria-label="${esc(aria)}">
        <line class="strip-base" x1="0%" x2="100%" y1="${cy}" y2="${cy}"/>
        <rect class="strip-iqr grow-x" x="${pct(x(d.p25))}" width="${pct(Math.max(0.4, x(d.p75) - x(d.p25)))}" y="${cy - bandH / 2}" height="${bandH}" rx="4"/>
        <line class="strip-median" x1="${pct(mx)}" x2="${pct(mx)}" y1="${cy - bandH / 2 - 6}" y2="${cy + bandH / 2 + 6}"/>
        ${dots.join('')}
      </svg>
      <div class="strip-hits">${hits}</div>
    </div>
    ${hl ? `<span class="strip-hl-label${labelEdge(hlX)}" style="left:${pct(hlX)}"><i class="dot"></i>${esc(highlightLabel || who(hl.kommun_kod))} <b>${esc(fmtV(hl.kr_per_elev))}</b></span>` : ''}
    ${axisTicks(ticks, x, unit)}
  </div>
  <figcaption class="viz-foot">
    <span class="lg"><i class="lg-band"></i>mittersta hälften ${esc(fmtPrice(d.p25))} till ${esc(fmtV(d.p75))}</span>
    <span class="lg"><i class="lg-tick"></i>median</span>
    ${hl ? `<span class="lg"><i class="lg-dot is-highlight"></i>${esc(highlightLabel || who(hl.kommun_kod))}</span>` : ''}
    <span>en punkt per ${esc(dotNoun)}, ${esc(fmtInt(n))} ${esc(noun)}</span>
    ${unknownLine}
  </figcaption>
</figure>`;
}

// ------------------------------------------------------------ segment matrix

const SEQ_STEPS = 5;

function hashId(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return `sm${(h >>> 0).toString(36)}`;
}

export function segmentMatrix({ rows = [], cols = [], cell, id = null, unit = 'kr/elev', rowHead = '', caption = '' } = {}) {
  const base = String(id || hashId(JSON.stringify([rows.map((r) => r.key), cols.map((c) => c.key)]))).replace(/[^a-zA-Z0-9-]/g, '');
  const grid = rows.map((r) => cols.map((c) => {
    // Caller errors propagate: a broken cell() must never render as "inga avtal".
    const d = cell ? cell(r, c) : null;
    return d || null;
  }));
  const medians = grid.flat().filter((d) => d && !d.suppressed && isNum(d.median)).map((d) => d.median).sort((a, b) => a - b);
  const step = (m) => {
    if (medians.length < 2) return 2;
    const rank = medians.filter((v) => v < m).length + medians.filter((v) => v === m).length / 2;
    return clamp(Math.floor((rank / medians.length) * SEQ_STEPS), 0, SEQ_STEPS - 1);
  };

  const pops = [];
  const head = `<div class="sm-corner">${esc(rowHead)}</div>${cols.map((c) => `<div class="sm-colhead">${esc(c.label)}</div>`).join('')}`;
  const body = rows.map((r, i) => `<div class="sm-rowhead">${esc(r.label)}</div>${cols.map((c, j) => {
    const d = grid[i][j];
    const pid = `${base}-${i}-${j}`;
    const where = `${r.label} · ${c.label}`;
    const n = d && isNum(d.n) ? d.n : null;
    let inner;
    let cls;
    let pop;
    // Unknown: no dist, no count, or a count that should have a median but
    // does not. Distinct from n = 0 (a known empty group) and from too few.
    if (n == null || (n >= MIN_N && !isNum(d.median))) {
      cls = 'sm-cell is-unknown hatch';
      inner = `<span class="sm-few">${UNKNOWN}</span>`;
      pop = '<p>Underlaget för den här gruppen kunde inte räknas fram. Det betyder inte att det saknas avtal.</p>';
    } else if (d.suppressed || !isNum(d.median)) {
      cls = n === 0 ? 'sm-cell is-empty' : 'sm-cell is-few hatch';
      inner = n === 0
        ? '<span class="sm-few">inga avtal</span>'
        : `<span class="sm-few">för få</span><span class="sm-n">n = ${esc(fmtInt(n))}</span>`;
      pop = `<p>${n === 0 ? 'Inga avtal med känt pris i den här gruppen än.' : `För få avtal (n = ${esc(fmtInt(n))}). Medianen visas när minst ${MIN_N} avtal har känt pris per elev.`}</p>`;
    } else {
      cls = `sm-cell seq-${step(d.median)}`;
      inner = `<span class="sm-med">${esc(fmtInt(d.median))}</span><span class="sm-n">n = ${esc(fmtInt(n))}</span>`;
      pop = `<dl class="pop-dl">
        <div><dt>Median</dt><dd><b>${esc(fmtInt(d.median))} ${esc(unit)}</b></dd></div>
        <div><dt>Mittersta hälften</dt><dd>${esc(fmtInt(d.p25))} till ${esc(fmtInt(d.p75))} ${esc(unit)}</dd></div>
        <div><dt>Spann</dt><dd>${esc(fmtInt(d.min))} till ${esc(fmtInt(d.max))} ${esc(unit)}</dd></div>
        <div><dt>Underlag</dt><dd>${esc(fmtInt(n))} avtal med känt pris</dd></div>
      </dl>`;
    }
    pops.push(`<div popover id="${pid}" class="sm-pop"><p class="pop-title">${esc(where)}</p>${pop}</div>`);
    return `<button type="button" class="${cls}" popovertarget="${pid}" aria-label="${esc(where)}">${inner}</button>`;
  }).join('')}`).join('');

  const legend = `<div class="sm-legend" aria-hidden="true">
    <span>lägre${medians.length ? ` <b>${esc(fmtInt(medians[0]))}</b>` : ''}</span>
    <span class="sm-ramp">${Array.from({ length: SEQ_STEPS }, (_, k) => `<i class="seq-${k}"></i>`).join('')}</span>
    <span>högre${medians.length ? ` <b>${esc(fmtInt(medians[medians.length - 1]))}</b>` : ''} median ${esc(unit)}</span>
    <span class="lg"><i class="lg-hatch"></i>för få avtal (under ${MIN_N})</span>
  </div>`;

  return `<figure class="viz sm">
  ${caption ? `<div class="viz-head"><span class="viz-label">${esc(caption)}</span></div>` : ''}
  <div class="sm-scroll scroll-x">
    <div class="sm-grid" style="--sm-cols:${cols.length}">${head}${body}</div>
  </div>
  ${legend}
  ${pops.join('')}
</figure>`;
}

// -------------------------------------------------------------- ranking bars

export function rankingBars({ items = [], max = 7, highlight = null, noun = '', valueHead = '' } = {}) {
  const top = Math.max(0, ...items.map((it) => (isNum(it.value) ? it.value : 0)));
  // highlight: one label/href, or a list of them.
  const hls = highlight == null ? [] : Array.isArray(highlight) ? highlight : [highlight];
  const isHl = (it) => hls.some((h) => it.label === h || (it.href && it.href === h));
  const row = (it, i) => {
    const known = isNum(it.value);
    const w = known && top > 0 ? Math.max(1.5, (it.value / top) * 100) : 0;
    const name = it.href ? `<a href="${esc(it.href)}" data-pane-link>${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`;
    const share = isNum(it.share) ? `<span class="rank-share">${esc(fmtShare(it.share))}</span>` : '';
    return `<li class="rank-row${isHl(it) ? ' is-highlight' : ''}">
      <span class="rank-i">${i + 1}</span>
      <span class="rank-name">${name}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>
      <span class="rank-track">${known
        ? `<span class="rank-bar grow-x" style="width:${pct(w)};--i:${i}"></span>`
        : '<span class="rank-bar is-unknown hatch"></span>'}</span>
      <span class="rank-val">${known ? esc(it.valueLabel ?? fmtInt(it.value)) : `<span class="muted">${UNKNOWN}</span>`}${share}</span>
    </li>`;
  };
  const shown = items.slice(0, max);
  const rest = items.slice(max);
  return `<div class="viz rank">
  ${valueHead ? `<div class="rank-head"><span></span><span></span><span></span><span>${esc(valueHead)}</span></div>` : ''}
  <ol class="rank-list">${shown.map(row).join('')}</ol>
  ${rest.length ? `<details class="rank-fold">
    <summary><span>Övriga ${esc(fmtInt(rest.length))}${noun ? ` ${esc(noun)}` : ''}</span></summary>
    <ol class="rank-list" start="${max + 1}">${rest.map((it, k) => row(it, max + k)).join('')}</ol>
  </details>` : ''}
</div>`;
}

function fmtShare(s) {
  const p = s * 100;
  if (p > 0 && p < 1) return '<1 %';
  return `${fmtInt(p)} %`;
}

// ----------------------------------------------------------- renewal timeline

const MONTHS_SV = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function isoMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

export function renewalTimeline({ lanes = [], today, months = 24, laneHead = '' } = {}) {
  const t0 = isoMs(today);
  if (t0 == null) throw new Error('renewalTimeline requires today as YYYY-MM-DD');
  const start = new Date(t0);
  const y0 = start.getUTCFullYear();
  const m0 = start.getUTCMonth();
  const t1 = Date.UTC(y0, m0 + months, start.getUTCDate());
  const x = (ms) => ((ms - t0) / (t1 - t0)) * 100;

  // Month boundaries for the axis and the bucket histogram.
  const bounds = [];
  for (let k = 0; k <= months; k++) bounds.push(Date.UTC(y0, m0 + k, 1));
  const buckets = new Array(months + 1).fill(0);
  const values = lanes.flatMap((l) => (l.items || []).map((it) => it.value)).filter(isNum);
  const vmax = Math.max(1, ...values);
  const size = (v) => (isNum(v) ? Math.round(9 + Math.sqrt(Math.max(0, v) / vmax) * 15) : 11);

  const laneHtml = lanes.map((lane, li) => {
    let later = 0;
    let passed = 0;
    const dots = [];
    for (const it of lane.items || []) {
      const ms = isoMs(it.date);
      if (ms == null) continue;
      if (ms < t0) { passed++; continue; }
      if (ms > t1) { later++; continue; }
      const p = x(ms);
      const b = bounds.findIndex((bm, k) => ms >= bm && (k === bounds.length - 1 || ms < bounds[k + 1]));
      if (b >= 0) buckets[b]++;
      const unknown = !isNum(it.value);
      const s = size(it.value);
      const tag = it.href ? 'a' : 'span';
      const href = it.href ? ` href="${esc(it.href)}" data-pane-link` : ' tabindex="0"';
      dots.push(`<${tag} class="tl-dot${unknown ? ' is-unknown' : ''}${side(p)}"${href} style="left:${pct(p)};--s:${s}px;--i:${dots.length + li}"><span class="tip" role="tooltip"><strong>${esc(it.title)}</strong><span>${esc(it.date)}${unknown ? ', värde okänt' : `, ${esc(it.valueLabel ?? `${fmtInt(it.value)} kr/år`)}`}</span></span></${tag}>`);
    }
    const extras = [later ? `${fmtInt(later)} senare` : '', passed ? `${fmtInt(passed)} passerat` : ''].filter(Boolean).join(', ');
    const name = lane.href ? `<a href="${esc(lane.href)}" data-pane-link>${esc(lane.label)}</a>` : esc(lane.label);
    return `<div class="tl-lane">
      <div class="tl-label">${name}${lane.sub ? `<small>${esc(lane.sub)}</small>` : ''}</div>
      <div class="tl-track">${dots.join('')}${!dots.length ? `<span class="tl-none">inga förnyelser inom ${esc(fmtInt(months))} mån</span>` : ''}${extras ? `<span class="tl-more">${esc(extras)}</span>` : ''}</div>
    </div>`;
  }).join('');

  const bmax = Math.max(1, ...buckets);
  const monthCells = bounds.slice(0, months + 1).map((bm, k) => {
    const d = new Date(bm);
    const left = Math.max(0, x(bm));
    const next = k < months ? x(bounds[k + 1]) : 100;
    const width = Math.max(0, Math.min(100, next) - left);
    if (width <= 0.2) return '';
    const isJan = d.getUTCMonth() === 0;
    const lbl = isJan ? String(d.getUTCFullYear()) : MONTHS_SV[d.getUTCMonth()];
    const c = buckets[k];
    return `<span class="tl-month${isJan ? ' is-year' : ''}${k % 3 ? ' is-minor' : ''}" style="left:${pct(left)};width:${pct(width)}">
      <span class="tl-bucket" title="${esc(`${MONTHS_SV[d.getUTCMonth()]} ${d.getUTCFullYear()}: ${c} avtal`)}"><i class="grow-y" style="height:${c ? Math.max(8, (c / bmax) * 100) : 0}%;--i:${k}"></i>${c ? `<b>${c}</b>` : ''}</span>
      <span class="tl-mlabel">${width >= 3 ? `<span>${esc(lbl)}</span>` : ''}</span>
    </span>`;
  }).join('');

  return `<figure class="viz tl">
  <div class="tl-axis">
    <div class="tl-label tl-axis-head">${esc(laneHead)}</div>
    <div class="tl-months">${monthCells}<span class="tl-today-tag">idag</span></div>
  </div>
  <div class="tl-lanes" style="--lanes:${lanes.length}">${laneHtml}</div>
  <figcaption class="viz-foot">
    <span class="lg"><i class="lg-dot"></i>avtal som löper ut, storlek efter årsvärde</span>
    <span class="lg"><i class="lg-dot is-unknown"></i>värde okänt</span>
    <span>staplarna överst visar antal per månad, ${esc(fmtInt(months))} månader framåt</span>
  </figcaption>
</figure>`;
}

// ------------------------------------------------------------------ tile map

// 'neutral': a kommun the map makes no claim about (e.g. outside a peer group).
// 'has-open': collection still open but avtal have come in (Kommuner directory).
export const TILE_CLASSES = Object.freeze(['has', 'has-open', 'none-done', 'none-open', 'not-contacted', 'highlight', 'neutral', 'unknown']);
const TILE_UNKNOWN_LABEL = 'Status okänd';

let tilesMemo = null;
export function loadKommunTiles() {
  if (!tilesMemo) tilesMemo = JSON.parse(readFileSync(new URL('../../public/geo/kommun-tiles.json', import.meta.url), 'utf8'));
  return tilesMemo;
}

function checkTileClass(cls, where) {
  if (!TILE_CLASSES.includes(cls)) throw new Error(`tileMap: invalid class ${JSON.stringify(cls)} for ${where}`);
  return cls;
}

// Every claim on the map comes from the caller. Without classOf a tile is
// 'unknown' (hatched, its own legend entry), never 'not-contacted'. A
// throwing classOf/titleOf or an invalid class name is a caller bug and
// propagates instead of turning into a factual claim.
export function tileMap({ tiles, classOf = () => 'unknown', titleOf = (k) => k, legend = [], label = 'Karta över Sveriges kommuner' } = {}) {
  const t = tiles || { cols: 1, rows: 1, tiles: {} };
  const counts = Object.fromEntries(TILE_CLASSES.map((c) => [c, 0]));
  const cells = Object.entries(t.tiles).map(([kod, pos]) => {
    const cls = checkTileClass(classOf(kod), `kommun ${kod}`);
    counts[cls]++;
    const tip = titleOf(kod) ?? kod;
    const sideCls = pos.x > t.cols * 0.6 ? ' tip-left' : pos.x < t.cols * 0.4 ? ' tip-right' : '';
    return `<span class="tile t-${cls}${sideCls}" tabindex="0" role="img" aria-label="${esc(tip)}" style="grid-column:${pos.x + 1};grid-row:${pos.y + 1}" data-tip="${esc(tip)}"></span>`;
  });
  const entries = legend.map((l) => ({ cls: checkTileClass(l.cls, `legend ${l.label}`), label: l.label }));
  if (counts.unknown > 0 && !entries.some((l) => l.cls === 'unknown')) entries.push({ cls: 'unknown', label: TILE_UNKNOWN_LABEL });
  const legendHtml = entries.length ? `<ul class="tm-legend">${entries.map((l) => `<li><i class="tile t-${l.cls}"></i><span>${esc(l.label)}</span><b>${esc(fmtInt(counts[l.cls]))}</b></li>`).join('')}</ul>` : '';
  const summary = entries.map((l) => `${l.label}: ${counts[l.cls]}`).join(', ');
  return `<figure class="viz tilemap">
  <div class="tm-grid" role="group" aria-label="${esc(summary ? `${label}. ${summary}` : label)}" style="--tm-cols:${t.cols};--tm-rows:${t.rows};aspect-ratio:${t.cols}/${t.rows}">${cells.join('')}</div>
  ${legendHtml}
</figure>`;
}

// ----------------------------------------------------------------- sparkline

// Fixed pixel size, so nothing scales. Single series, no legend: the tile
// label names it. End dot marks the latest value.
export function sparkline(series = [], { w = 96, h = 28 } = {}) {
  const v = (series || []).filter(isNum);
  if (!v.length) return '';
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const pad = 4;
  const px = (i) => (v.length === 1 ? w - pad : pad + (i / (v.length - 1)) * (w - 2 * pad));
  const py = (y) => (hi === lo ? h / 2 : pad + (1 - (y - lo) / (hi - lo)) * (h - 2 * pad));
  const pts = v.map((y, i) => `${px(i).toFixed(1)},${py(y).toFixed(1)}`).join(' ');
  const last = v.length - 1;
  const area = `${pad},${h} ${pts} ${px(last).toFixed(1)},${h}`;
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polygon class="spark-area" points="${area}"/>
    <polyline class="spark-line" points="${pts}"/>
    <circle class="spark-end" cx="${px(last).toFixed(1)}" cy="${py(v[last]).toFixed(1)}" r="3.5"/>
  </svg>`;
}
