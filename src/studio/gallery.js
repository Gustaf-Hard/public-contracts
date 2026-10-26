// /studio/_komponenter: every studio component in every state, rendered from
// HAND-WRITTEN demo data. The repo is public, so nothing here comes from the
// pilot DB: vendor and product names are invented, prices are made up, and
// only the kommun names and tile positions (open data) are real.

import { esc } from './layout.js';
import { fmtInt, fmtKrCompact } from './format.js';
import { distribution } from '../studio-data.js';
import {
  entityHeader, kpiTile, segmentStrip, filterBar, emptyPanel, evidenceDrawer,
} from './components.js';
import {
  stripPlot, segmentMatrix, rankingBars, renewalTimeline, tileMap, loadKommunTiles,
} from './charts.js';

// Deterministic pseudo-random numbers so the gallery is stable between loads.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
  };
}

function demoDist(values, kods) {
  const d = distribution(values);
  return {
    ...d,
    values: d.suppressed ? [] : values.map((v, i) => ({ kommun_kod: kods[i], kr_per_elev: v }))
      .sort((a, b) => a.kr_per_elev - b.kr_per_elev),
  };
}

const section = (title, kicker, body, note = '') => `<section class="section gallery-section">
  <div class="section-head"><div><span class="kicker">${esc(kicker)}</span><h2 class="section-title">${esc(title)}</h2></div>${note ? `<p class="meta">${esc(note)}</p>` : ''}</div>
  ${body}
</section>`;

const state = (label, body) => `<div class="gallery-state"><p class="gallery-tag">${esc(label)}</p>${body}</div>`;

export function renderGallery({ stats = null, today = '2026-10-26', tiles = null } = {}) {
  const t = tiles || safeTiles();
  const kods = Object.keys(t.tiles).sort();
  const nameOf = (kod) => {
    try { return stats?.get(kod)?.namn || `Kommun ${kod}`; } catch { return `Kommun ${kod}`; }
  };
  const r = rng(20261026);

  // ---- strip plot data: 38 invented prices, one highlighted kommun.
  const stripKods = kods.filter((_, i) => i % 7 === 0).slice(0, 38);
  const stripVals = stripKods.map(() => Math.round(120 + r() * 260 + (r() > 0.85 ? r() * 420 : 0)));
  const big = demoDist(stripVals, stripKods);
  const hlKod = stripKods[11];
  const five = demoDist([210, 240, 260, 310, 355], kods.slice(40, 45));

  // ---- segment matrix: size bands x segments.
  const bands = [
    { key: 'xl', label: 'Storstäder och förorter' },
    { key: 'l', label: 'Större städer' },
    { key: 'm', label: 'Pendlingskommuner' },
    { key: 's', label: 'Landsbygdskommuner' },
  ];
  const segs = ['Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet'].map((s) => ({ key: s, label: s }));
  const cellFor = (row, col) => {
    const ri = bands.indexOf(row);
    const ci = segs.indexOf(col);
    if (row.key === 's' && col.key === 'Gymnasiet') return distribution([]);
    if (row.key === 'm' && col.key === 'Gymnasiet') return null; // unknown state
    if ((row.key === 's' && ci < 2) || (row.key === 'xl' && col.key === 'Förskoleklass')) return distribution([300, 320, 340].slice(0, 2 + (ci % 2)));
    const base = 140 + ci * 55 - ri * 12;
    return distribution(Array.from({ length: 5 + ((ri * 3 + ci) % 9) }, (_, k) => base + k * 9 + (k % 3) * 14));
  };

  // ---- ranking.
  const vendors = [
    ['Exempelförlaget', 31.4, 121], ['Läromedia Nord', 18.2, 64], ['Plattform Alfa', 12.9, 88],
    ['Skolverktyg Beta', 7.4, 41], ['Bokhuset Gamma', 5.1, 22], ['Digitala Delta', 3.8, 30],
    ['Provtjänst Epsilon', 2.2, 17], ['Lärresurs Zeta', 1.4, 9], ['Studio Eta', 0.9, 6], ['Theta Utbildning', 0.4, 3],
  ];
  const total = vendors.reduce((a, v) => a + v[1], 0);
  const rankItems = vendors.map(([name, mkr, k]) => ({
    label: name, href: '/studio/_komponenter', value: mkr * 1e6, valueLabel: `${fmtKrCompact(mkr * 1e6)}/år`,
    share: mkr / total, sub: `${fmtInt(k)} kommuner`,
  }));
  rankItems.splice(5, 0, { label: 'Okänd prisbild AB', value: null, valueLabel: null, share: null, sub: '4 kommuner, inget känt årsvärde' });

  // ---- renewal timeline.
  const addDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const lanes = [
    { label: 'Exempelförlaget', sub: '14 avtal', items: [[97, 2.1e6], [97, 900e3], [97, 450e3], [180, 300e3], [320, null], [410, 1.2e6], [600, 200e3], [900, 1]] },
    { label: 'Plattform Alfa', sub: '6 avtal', items: [[40, 180e3], [260, 640e3], [300, null], [520, 380e3], [700, 90e3]] },
    { label: 'Läromedia Nord', sub: '4 avtal', items: [[-20, 50e3], [150, 95e3], [460, 1.6e6]] },
    { label: 'Provtjänst Epsilon', sub: '1 avtal', items: [[]] },
  ].map((l, li) => ({
    label: l.label, sub: l.sub, href: '/studio/_komponenter',
    items: l.items.filter((x) => x.length).map(([d, v], i) => ({ date: addDays(d), value: v, title: `${nameOf(kods[li * 20 + i * 3])}, ${l.label}` })),
  }));

  // ---- tile map classes.
  const tileClass = (kod) => {
    if (kod === '1440') return 'highlight';
    const h = (parseInt(kod, 10) * 2654435761) >>> 0;
    const v = h % 100;
    return v < 46 ? 'has' : v < 62 ? 'none' : v < 80 ? 'none-open' : 'not-contacted';
  };
  const tileTitle = (kod) => {
    const c = tileClass(kod);
    const what = { has: 'har avtal med Exempelförlaget', none: 'inget avtal i underlaget', 'none-open': 'insamling pågår', 'not-contacted': 'inte kontaktad än', highlight: 'du är här' }[c];
    return `${nameOf(kod)}: ${what}`;
  };
  const legend = [
    { cls: 'has', label: 'Har avtal' },
    { cls: 'none', label: 'Inget avtal i underlaget' },
    { cls: 'none-open', label: 'Insamling pågår' },
    { cls: 'not-contacted', label: 'Inte kontaktad' },
    { cls: 'highlight', label: 'Vald kommun' },
  ];

  const evRows = Array.from({ length: 6 }, (_, i) => ({
    kommun: nameOf(kods[i * 31]), period: `2025-0${(i % 8) + 1}-01 till 2027-0${(i % 6) + 1}-30`,
    value: i === 3 ? null : fmtKrCompact(80e3 + i * 37e3), model: ['Per elev', 'Fast pris', 'Per licens', null, 'Per elev', 'Fast pris'][i],
    pdfHref: '/studio/_komponenter#underlag',
  }));

  const kpiRow = `<div class="kpi-row">
    ${kpiTile({ label: 'Känt årsvärde', value: '30,9', unit: 'mkr/år', basis: 'känd för 158 av 190 avtal', state: 'known', spark: [12, 14, 13, 18, 21, 24, 26, 31] })}
    ${kpiTile({ label: 'Kommuner', value: 121, unit: 'av 185', basis: 'kommuner med minst ett aktivt avtal', state: 'known', spark: [40, 58, 77, 90, 104, 121] })}
    ${kpiTile({ label: 'Median per elev', value: 248, unit: 'kr/elev', basis: 'känd för 12 av 40 avtal', state: 'partial' })}
    ${kpiTile({ label: 'Nästa förnyelse', value: null, basis: 'inget avtal anger slutdatum', state: 'unknown', reason: 'Avtalen saknar slutdatum, vi räknar dem som aktiva i fyra år.' })}
  </div>`;

  const body = `
${entityHeader({
    kicker: 'Komponentbibliotek · Demodata',
    title: 'Mediagraf Studio, alla komponenter',
    answer: 'Varje komponent visas i sina lägen: känt, delvis känt, okänt och för få. All data på sidan är påhittad, utom kommunnamnen.',
    facts: [
      { label: 'Känt årsvärde', value: '30,9', unit: 'mkr/år', sub: 'känd för 158 av 190 avtal' },
      { label: 'Kommuner', value: 121, sub: 'av 185 med avtal' },
      { label: 'Andel av kategorin', value: null, sub: 'kategorins värde är okänt' },
    ],
    viz: segmentStrip(['Förskoleklass', '1-3', '4-6', '7-9']),
  })}

${section('KPI-rutor', 'Siffror', `${kpiRow}`, 'känt · delvis · okänt')}

${section('Prisspridning per elev', 'Strip plot', `<div class="grid-12">
  <div class="span-12 card">${stripPlot({ dist: big, highlightKod: hlKod, highlightLabel: nameOf(hlKod), unit: 'kr/elev', label: 'Exempelförlaget, pris per elev och år', nameOf, unknownCount: 14 })}</div>
  <div class="span-6 card">${state('n = 5, precis nog', stripPlot({ dist: five, unit: 'kr/elev', label: 'Plattform Alfa, 4-6' }))}</div>
  <div class="span-6 card">${state('n = 4, för få', stripPlot({ dist: demoDist([200, 260, 300, 410], kods.slice(0, 4)), unit: 'kr/elev', label: 'Skolverktyg Beta, 7-9', unknownCount: 3 }))}</div>
</div>`)}

${section('Pris per segment och kommungrupp', 'Segmentmatris', `<div class="card">${segmentMatrix({ id: 'demo-sm', rows: bands, cols: segs, cell: cellFor, rowHead: 'Kommungrupp', caption: 'Median kr per elev och år, Läromedel' })}</div>`, 'klicka en ruta för detaljer')}

${section('Största leverantörer', 'Rangordning', `<div class="grid-12">
  <div class="span-7 card">${rankingBars({ items: rankItems, max: 7, highlight: 'Plattform Alfa', noun: 'leverantörer', valueHead: 'Känt årsvärde' })}</div>
  <div class="span-5 card">${state('kort lista, inget fäll', rankingBars({ items: rankItems.slice(0, 3), max: 7 }))}</div>
</div>`)}

${section('Förnyelser kommande 24 månader', 'Tidslinje', `<div class="card">${renewalTimeline({ lanes, today, months: 24, laneHead: 'Leverantör' })}</div>`)}

${section('Var finns avtalen', 'Kommunkarta', `<div class="grid-12">
  <div class="span-6 card">${tileMap({ tiles: t, classOf: tileClass, titleOf: tileTitle, legend })}</div>
  <div class="span-6 gallery-stack">
    <div class="card">${state('Segmentremsa, känt', `<p class="gallery-row"><span>Exempelförlaget Bas</span>${segmentStrip(['1-3', '4-6', '7-9'])}</p><p class="gallery-row"><span>Plattform Alfa</span>${segmentStrip(['Förskola', 'Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'])}</p>`)}${state('Segmentremsa, okänt', `<p class="gallery-row"><span>Provtjänst Epsilon</span>${segmentStrip([])}</p>`)}</div>
    ${emptyPanel({ title: 'Vi har inte begärt ut avtal här än', text: 'Kommunen ingår i nästa utskick. Tills dess visar vi hur liknande kommuner köper.', context: 'Liknande kommuner: 9 av 12 har avtal i kategorin, median 248 kr per elev.' })}
    ${emptyPanel({ title: 'För få avtal i segmentet', text: 'Vi har avtal från 3 av 12 kommuner i segmentet. Medianen visas när minst 5 har känt pris.', contextHtml: segmentStrip(['7-9']) })}
  </div>
</div>`)}

${section('Filter', 'Filterrad', filterBar({
    action: '/studio/_komponenter',
    fields: [
      { name: 'kategori', label: 'Kategori', options: [{ value: 'laromedel', label: 'Läromedel' }, { value: 'larplattform', label: 'Lärplattform' }], value: 'laromedel' },
      { name: 'segment', label: 'Segment', options: ['1-3', '4-6', '7-9'], value: '4-6' },
      { name: 'grupp', label: 'Kommungrupp', options: bands.map((b) => ({ value: b.key, label: b.label })), value: '' },
    ],
    resultLine: '412 avtal · 98 mkr/år känt för 260',
  }))}

${section('Underlag', 'Evidens', `<div id="underlag">${evidenceDrawer({ rows: evRows, total: 190, page: 1, pageHref: (p) => `/studio/_komponenter?sida=${p}` })}</div>`)}
`;
  return body;
}

function safeTiles() {
  try { return loadKommunTiles(); } catch { return { cols: 1, rows: 1, tiles: {} }; }
}
