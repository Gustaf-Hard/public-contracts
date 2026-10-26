// /studio/fornyelser (spec §7.5 item 6): the sales and tender calendar. Which
// active avtal end or come up for renewal in the next N months, filtered by
// kategori, segment, län, kommungrupp and kanal. One row per avtal (a channel
// avtal split across owners lists the owners together). The same rows feed
// the CSV download.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact } from '../format.js';
import { CATEGORIES, companyBySlug } from '../../catalogue.js';
import { UNKNOWN_CATEGORY } from '../../studio-data.js';
import { filterBar, emptyPanel, STRIP_SEGMENTS } from '../components.js';
import {
  isNum, isIso, headline, categoryLabel, companyHref, productHref, kommunHref, kommunNamer,
  productName, section, nOf, safeAll,
} from './common.js';
import { ADDA_MONTH, ADDA_NOTE } from './marknad.js';

export const MONTH_CHOICES = Object.freeze([6, 12, 18, 24, 36]);
export const DEFAULT_MONTHS = 18;
export const FORNYELSER_PAGE_SIZE = 100;
// Fixed hue per category (colour follows the category, never its rank). Only
// three hues pass the validator for every pair, and a stacked bar can put
// any two next to each other; the rest share the neutral, unknown is hatched.
export const CATEGORY_HUE = Object.freeze({ laromedel: 'c1', larplattform: 'c2', skoladministration: 'c3' });
const MONTHS_SV = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTHS_LONG = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
const DIRECT = 'direkt';

const hueOf = (cat) => (cat === UNKNOWN_CATEGORY ? 'c-unknown hatch' : CATEGORY_HUE[cat] ?? 'c-other');

function addMonthsIso(iso, k) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
}

function statsOf(stats, kod) {
  try { return stats?.get?.(kod) ?? null; } catch { return null; }
}

const companyLabel = (slug) => companyBySlug(slug)?.canonical ?? slug;

// ------------------------------------------------------------------ query

const str = (v) => (typeof v === 'string' ? v.trim() : '');

export function parseFornyelserQuery(q = {}) {
  const man = parseInt(str(q.man), 10);
  return {
    kategori: str(q.kategori),
    segment: str(q.segment),
    lan: str(q.lan),
    kommungrupp: str(q.kommungrupp),
    kanal: str(q.kanal),
    man: MONTH_CHOICES.includes(man) ? man : DEFAULT_MONTHS,
    manGiven: MONTH_CHOICES.includes(man),
  };
}

// ------------------------------------------------------------------ rows

// One row per avtal whose next renewal or end date falls from today up to
// `man` months ahead. Filters apply to the avtal x owner rows first, so a
// kategori filter on a split channel avtal keeps only the matching owners.
export function renewalRows({ facts, stats, today, query }) {
  const q = query ?? parseFornyelserQuery();
  const until = addMonthsIso(today, q.man);
  const nameOf = kommunNamer(stats, facts);
  const match = (f) => {
    if (!isIso(f.next_renewal)) return false;
    const d = f.next_renewal.slice(0, 10);
    if (d < today || d > until) return false;
    if (f.company_slug && companyBySlug(f.company_slug)?.hiddenInStudio) return false;
    if (q.kategori && (f.category ?? UNKNOWN_CATEGORY) !== q.kategori) return false;
    if (q.segment && !f.segments.includes(q.segment)) return false;
    if (q.kanal && (f.channel_slug ?? DIRECT) !== q.kanal) return false;
    if (q.lan || q.kommungrupp) {
      const s = statsOf(stats, f.kommun_kod);
      if (q.lan && s?.lan !== q.lan) return false;
      if (q.kommungrupp && s?.kommungrupp !== q.kommungrupp) return false;
    }
    return true;
  };
  const by = new Map();
  for (const f of headline(facts)) {
    if (!match(f)) continue;
    if (!by.has(f.contract_id)) by.set(f.contract_id, []);
    by.get(f.contract_id).push(f);
  }
  const rows = [...by.values()].map((fs) => {
    const f0 = fs[0];
    const owners = [...new Map(fs.map((f) => [f.company_slug ?? `name:${f.company_name}`, { slug: f.company_slug, name: f.company_name, unsplit: f.value_basis === 'unsplit_channel' && f.company_slug === f.channel_slug }])).values()];
    const products = [...new Set(fs.flatMap((f) => f.product_slugs))].map((slug) => ({ slug, name: productName(slug) })).filter((p) => p.name);
    const known = fs.filter((f) => isNum(f.annual_value_sek));
    const s = statsOf(stats, f0.kommun_kod);
    const cats = [...new Set(fs.map((f) => f.category ?? UNKNOWN_CATEGORY))];
    return {
      contract_id: f0.contract_id,
      kommun_kod: f0.kommun_kod,
      kommun: nameOf(f0.kommun_kod),
      lan: s?.lan ?? null,
      kommungrupp: s?.kommungrupp ?? null,
      owners,
      products,
      category: cats.find((c) => c !== UNKNOWN_CATEGORY) ?? UNKNOWN_CATEGORY,
      categories: cats,
      channel: f0.channel_slug,
      value: known.length ? known.reduce((sum, f) => sum + f.annual_value_sek, 0) : null,
      valuePartial: known.length > 0 && known.length < fs.length,
      date: f0.next_renewal.slice(0, 10),
      period_end: isIso(f0.period_end) ? f0.period_end.slice(0, 10) : null,
      extension_option_until: f0.extension_option_until ?? null,
      auto_renews: f0.auto_renews ?? null,
      last_cancellation_date: f0.last_cancellation_date ?? null,
    };
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.kommun.localeCompare(b.kommun, 'sv') || a.contract_id - b.contract_id);
}

// What the date means, in words: "avtalet slutar", "förlängning möjlig till",
// "förlängs automatiskt".
export function termsText(r) {
  const parts = [];
  if (r.auto_renews) {
    parts.push(r.last_cancellation_date ? `förlängs automatiskt om det inte sägs upp senast ${r.last_cancellation_date}` : 'förlängs automatiskt');
  } else if (r.extension_option_until && r.extension_option_until !== r.period_end) {
    parts.push(r.period_end ? `avtalet slutar ${r.period_end}, kan förlängas till ${r.extension_option_until}` : `kan förlängas till ${r.extension_option_until}`);
  } else if (r.period_end) {
    parts.push('avtalet löper ut');
  }
  return parts.join(', ');
}

const ownersText = (r) => r.owners.map((o) => (o.unsplit ? `${o.name} (ej fördelat)` : o.name)).join(', ');

// ------------------------------------------------------------------ CSV

const CSV_HEAD = [
  'Kommun', 'Leverantör', 'Produkter', 'Kategori', 'Län', 'Kommungrupp', 'Kanal',
  'Känt årsvärde (kr)', 'Värdet gäller', 'Förnyas eller löper ut', 'Avtalet slutar',
  'Förlängning möjlig till', 'Förlängs automatiskt', 'Sista uppsägningsdag',
];

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // A cell a spreadsheet would read as a formula is prefixed, so an
  // extracted name can never run as one.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renewalsCsv(rows) {
  const lines = [CSV_HEAD.join(';')];
  for (const r of rows) {
    lines.push([
      r.kommun,
      ownersText(r),
      r.products.map((p) => p.name).join(', '),
      r.categories.map(categoryLabel).join(', '),
      r.lan ?? '',
      r.kommungrupp ?? '',
      r.channel ? companyLabel(r.channel) : 'Direkt',
      r.value == null ? '' : Math.round(r.value),
      r.value == null ? 'okänt' : r.valuePartial ? 'delvis känt' : 'känt',
      r.date,
      r.period_end ?? '',
      r.extension_option_until ?? '',
      r.auto_renews == null ? '' : r.auto_renews ? 'ja' : 'nej',
      r.last_cancellation_date ?? '',
    ].map(csvCell).join(';'));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ chart

function monthList(today, n) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  return Array.from({ length: n + 1 }, (_, k) => {
    const t = y * 12 + (m - 1) + k;
    return { key: `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`, y: Math.floor(t / 12), m: t % 12 };
  });
}

const catOrder = (cat) => {
  const keys = Object.keys(CATEGORY_HUE);
  if (keys.includes(cat)) return keys.indexOf(cat);
  if (cat === UNKNOWN_CATEGORY) return 99;
  return 10 + CATEGORIES.findIndex((c) => c.slug === cat);
};

// Stacked monthly bars, one segment per category, plain HTML so it is crisp
// at any width. Every bar has a hover tip naming each category's count.
export function renewalChart({ rows, today, months }) {
  const cols = monthList(today, months);
  const byMonth = new Map(cols.map((c) => [c.key, new Map()]));
  for (const r of rows) byMonth.get(r.date.slice(0, 7))?.set(r.category, (byMonth.get(r.date.slice(0, 7)).get(r.category) ?? 0) + 1);
  const totals = cols.map((c) => [...byMonth.get(c.key).values()].reduce((s, n) => s + n, 0));
  const max = Math.max(1, ...totals);
  const top = new Set(cols.map((c, i) => [c.key, totals[i]]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k));
  const addaIdx = cols.findIndex((c) => c.key === ADDA_MONTH);
  const n = cols.length;
  const bars = cols.map((c, i) => {
    const counts = [...byMonth.get(c.key).entries()].sort((a, b) => catOrder(a[0]) - catOrder(b[0]));
    const total = totals[i];
    const h = total ? Math.max(3, (total / max) * 100) : 0;
    const side = i > n * 0.7 ? ' tip-left' : i < n * 0.3 ? ' tip-right' : '';
    const what = `${MONTHS_LONG[c.m]} ${c.y}`;
    // One segment per colour: the categories sharing the neutral are one block.
    const blocks = new Map();
    for (const [cat, k] of counts) blocks.set(hueOf(cat), (blocks.get(hueOf(cat)) ?? 0) + k);
    const segs = [...blocks.entries()].map(([cls, k]) => `<i class="fx-seg ${cls}" style="flex-grow:${k}"></i>`).join('');
    const detail = counts.map(([cat, k]) => `<span>${esc(categoryLabel(cat === UNKNOWN_CATEGORY ? null : cat))}: ${esc(fmtInt(k))}</span>`).join('');
    const aria = `${what}: ${total} avtal${counts.length ? `, ${counts.map(([cat, k]) => `${categoryLabel(cat === UNKNOWN_CATEGORY ? null : cat)} ${k}`).join(', ')}` : ''}`;
    return `<span class="rw-col${i === addaIdx ? ' is-adda' : ''}${side}" tabindex="0" aria-label="${esc(aria)}">
      <span class="rw-stack">${top.has(c.key) ? `<b class="rw-lbl">${esc(fmtInt(total))}</b>` : ''}<span class="fx-bar grow-y" style="height:${h.toFixed(1)}%;--i:${i}">${segs}</span></span>
      <span class="tip" role="tooltip"><strong>${esc(what)}</strong><span>${esc(nOf(total, 'avtal', 'avtal'))}</span>${detail}</span>
    </span>`;
  }).join('');
  const axis = cols.map((c, i) => {
    const show = c.m === 0 || i === 0 || c.m % 3 === 0;
    return `<span class="rw-tick${c.m === 0 ? ' is-year' : ''}${show ? '' : ' is-minor'}">${show ? esc(c.m === 0 ? String(c.y) : MONTHS_SV[c.m]) : ''}</span>`;
  }).join('');
  const present = [...new Set(rows.map((r) => r.category))].sort((a, b) => catOrder(a) - catOrder(b));
  const named = present.filter((c) => CATEGORY_HUE[c]);
  const other = present.filter((c) => !CATEGORY_HUE[c] && c !== UNKNOWN_CATEGORY);
  const count = (cats) => rows.filter((r) => cats.includes(r.category)).length;
  const legend = [
    ...named.map((c) => ({ cls: hueOf(c), label: categoryLabel(c), n: count([c]) })),
    ...(other.length ? [{ cls: 'c-other', label: other.length === 1 ? categoryLabel(other[0]) : `Övriga kategorier (${other.map(categoryLabel).join(', ')})`, n: count(other) }] : []),
    ...(present.includes(UNKNOWN_CATEGORY) ? [{ cls: 'c-unknown hatch', label: 'Okänd kategori', n: count([UNKNOWN_CATEGORY]) }] : []),
  ];
  const pos = addaIdx >= 0 ? ((addaIdx + 0.5) / n) * 100 : null;
  const note = addaIdx >= 0
    ? `<div class="rw-notes"><span class="rw-note${pos > 55 ? ' is-right' : ''}" style="--x:${pos.toFixed(2)}%"><span>${esc(ADDA_NOTE)}</span></span></div>`
    : '';
  return `<figure class="viz rw fx-chart">
  <div class="viz-head"><span class="viz-label">Avtal som löper ut eller kan förnyas, per månad och kategori</span><span class="viz-n">${esc(nOf(rows.length, 'avtal', 'avtal'))}</span></div>
  ${note}
  <div class="rw-plot${addaIdx >= 0 ? ' has-note' : ''}" style="--n:${n}${pos != null ? `;--adda:${pos.toFixed(2)}%` : ''}">
    <div class="rw-bars">${bars}</div>
    <div class="rw-axis" aria-hidden="true">${axis}</div>
  </div>
  ${legend.length ? `<ul class="fx-legend">${legend.map((l) => `<li><i class="fx-sw ${l.cls}"></i><span>${esc(l.label)}</span><b>${esc(fmtInt(l.n))}</b></li>`).join('')}</ul>` : ''}
</figure>`;
}

// ------------------------------------------------------------------ list

function valueHtml(r) {
  if (r.value == null) return '<span class="fx-val is-unknown">värde okänt</span>';
  return `<span class="fx-val"><b>${esc(fmtKrCompact(r.value))}</b>/år${r.valuePartial ? '<small>delvis känt</small>' : ''}</span>`;
}

function rowHtml(r, today) {
  const owners = r.owners.map((o) => {
    const href = companyHref(o.slug);
    const name = href ? `<a href="${esc(href)}" data-pane-link>${esc(o.name)}</a>` : esc(o.name);
    return o.unsplit ? `${name} <small class="muted">(ej fördelat)</small>` : name;
  }).join(', ');
  const products = r.products.map((p) => {
    const href = productHref(p.slug);
    return href ? `<a href="${esc(href)}" data-pane-link>${esc(p.name)}</a>` : esc(p.name);
  }).join(', ');
  const via = r.channel && !r.owners.every((o) => o.slug === r.channel) ? `via ${esc(companyLabel(r.channel))}` : '';
  const terms = termsText(r);
  const days = Math.round((Date.parse(`${r.date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const soon = days <= 92;
  const [, m, d] = r.date.split('-').map(Number);
  return `<li class="fx-row">
    <span class="fx-date${soon ? ' is-soon' : ''}" title="${esc(r.date)}"><b>${esc(String(d))}</b><span>${esc(MONTHS_SV[m - 1])}</span></span>
    <span class="fx-main">
      <a class="fx-kommun" href="${esc(kommunHref(r.kommun_kod))}" data-pane-link>${esc(r.kommun)}</a>
      <span class="fx-co">${owners}${via ? ` <span class="muted">${via}</span>` : ''}</span>
      ${products ? `<span class="fx-prod">${products}</span>` : ''}
      ${terms ? `<span class="fx-terms">${esc(terms)}</span>` : ''}
    </span>
    <span class="fx-side">${valueHtml(r)}<span class="chip fx-cat"><i class="fx-sw ${hueOf(r.category)}"></i>${esc(categoryLabel(r.category === UNKNOWN_CATEGORY ? null : r.category))}</span></span>
  </li>`;
}

function listHtml({ rows, today, page, pageHref }) {
  const pages = Math.max(1, Math.ceil(rows.length / FORNYELSER_PAGE_SIZE));
  const cur = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((cur - 1) * FORNYELSER_PAGE_SIZE, cur * FORNYELSER_PAGE_SIZE);
  const groups = [];
  for (const r of slice) {
    const key = r.date.slice(0, 7);
    if (!groups.length || groups[groups.length - 1].key !== key) groups.push({ key, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  const monthCount = new Map();
  for (const r of rows) monthCount.set(r.date.slice(0, 7), (monthCount.get(r.date.slice(0, 7)) ?? 0) + 1);
  const html = groups.map((g) => {
    const [y, m] = g.key.split('-').map(Number);
    return `<div class="fx-month">
    <h3 class="fx-mhead"><span>${esc(`${MONTHS_LONG[m - 1]} ${y}`)}</span><small>${esc(nOf(monthCount.get(g.key), 'avtal', 'avtal'))}</small></h3>
    <ol class="fx-list">${g.rows.map((r) => rowHtml(r, today)).join('')}</ol>
  </div>`;
  }).join('');
  const nav = pages > 1 ? `<nav class="ev-pages" aria-label="Sidor">
    ${cur > 1 ? `<a href="${esc(pageHref(cur - 1))}" data-pane-link rel="prev">Föregående</a>` : '<span class="is-off">Föregående</span>'}
    ${Array.from({ length: pages }, (_, i) => i + 1).map((p) => (p === cur ? `<span class="is-cur" aria-current="page">${p}</span>` : `<a href="${esc(pageHref(p))}" data-pane-link>${p}</a>`)).join('')}
    ${cur < pages ? `<a href="${esc(pageHref(cur + 1))}" data-pane-link rel="next">Nästa</a>` : '<span class="is-off">Nästa</span>'}
  </nav>` : '';
  const from = (cur - 1) * FORNYELSER_PAGE_SIZE + 1;
  return `${pages > 1 ? `<p class="meta">Visar ${esc(fmtInt(from))} till ${esc(fmtInt(from + slice.length - 1))} av ${esc(fmtInt(rows.length))}</p>` : ''}${html}${nav}`;
}

// ------------------------------------------------------------------ page

export function queryString(q, extra = {}) {
  const qs = new URLSearchParams();
  for (const k of ['kategori', 'segment', 'lan', 'kommungrupp', 'kanal']) if (q[k]) qs.set(k, q[k]);
  if (q.man !== DEFAULT_MONTHS) qs.set('man', String(q.man));
  for (const [k, v] of Object.entries(extra)) if (v != null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function renderFornyelser({ facts, stats, today, query, page = 1 }) {
  const q = query ?? parseFornyelserQuery();
  const rows = renewalRows({ facts, stats, today, query: q });
  const all = safeAll(stats);
  const lans = [...new Set(all.map((r) => r.lan).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sv'));
  const grupper = [...new Set(all.map((r) => r.kommungrupp).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sv'));
  const head = headline(facts);
  const channels = [...new Set(head.map((f) => f.channel_slug).filter(Boolean))]
    .map((slug) => ({ value: slug, label: `Via ${companyLabel(slug)}` })).sort((a, b) => a.label.localeCompare(b.label, 'sv'));

  const kommuner = new Set(rows.map((r) => r.kommun_kod)).size;
  const known = rows.filter((r) => r.value != null);
  const value = known.reduce((s, r) => s + r.value, 0);
  const counts = new Map();
  for (const r of rows) counts.set(r.date.slice(0, 7), (counts.get(r.date.slice(0, 7)) ?? 0) + 1);
  const peak = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const peakText = peak ? (() => { const [y, m] = peak[0].split('-').map(Number); return `${MONTHS_LONG[m - 1]} ${y}`; })() : null;
  const filtered = ['kategori', 'segment', 'lan', 'kommungrupp', 'kanal'].some((k) => q[k]);
  const undated = new Set(head.filter((f) => !isIso(f.next_renewal)).map((f) => f.contract_id)).size;

  const answer = rows.length
    ? `${nOf(rows.length, 'avtal', 'avtal')} i ${nOf(kommuner, 'kommun', 'kommuner')} löper ut eller kan förnyas de närmaste ${q.man} månaderna${filtered ? ' med de valda filtren' : ''}. ${known.length ? `Känt årsvärde ${fmtKrCompact(value)}, känt för ${fmtInt(known.length)} av ${fmtInt(rows.length)}.` : 'Inget av dem har känt värde.'}${peak && peak[1] > 1 ? ` Flest i ${peakText}, ${fmtInt(peak[1])} avtal.` : ''}`
    : `Inga aktiva avtal löper ut eller kan förnyas de närmaste ${q.man} månaderna${filtered ? ' med de valda filtren' : ''}.`;

  const header = `<section class="entity-header fx-hero">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Förnyelser · upphandlingskalender</span>
      <h1 class="page-title">När avtalen går att vinna</h1>
      <p class="lede">${esc(answer)}</p>
    </div>
    <div class="eh-side">
      <dl class="eh-facts">
        <div class="eh-fact"><dt>Avtal</dt><dd class="eh-val">${esc(fmtInt(rows.length))}</dd><dd class="eh-sub">inom ${esc(String(q.man))} mån</dd></div>
        <div class="eh-fact"><dt>Kommuner</dt><dd class="eh-val">${esc(fmtInt(kommuner))}</dd><dd class="eh-sub">av 290</dd></div>
        <div class="eh-fact${known.length ? '' : ' is-unknown'}"><dt>Känt årsvärde</dt><dd class="eh-val">${esc(known.length ? fmtKrCompact(value) : 'okänt')}</dd><dd class="eh-sub">${esc(rows.length ? `känt för ${fmtInt(known.length)} av ${fmtInt(rows.length)}` : 'inga avtal')}</dd></div>
      </dl>
    </div>
  </div>
</section>`;

  const fields = [
    { name: 'kategori', label: 'Kategori', value: q.kategori, options: [...CATEGORIES.map((c) => ({ value: c.slug, label: c.label })), { value: UNKNOWN_CATEGORY, label: 'Okänd kategori' }] },
    { name: 'segment', label: 'Segment', value: q.segment, options: STRIP_SEGMENTS.map((s) => s.key) },
    { name: 'lan', label: 'Län', value: q.lan, options: lans },
    { name: 'kommungrupp', label: 'Kommungrupp', value: q.kommungrupp, options: grupper },
    { name: 'kanal', label: 'Kanal', value: q.kanal, options: [{ value: DIRECT, label: 'Direkt från leverantören' }, ...channels] },
    { name: 'man', label: 'Månader framåt', value: q.manGiven ? String(q.man) : '', def: String(DEFAULT_MONTHS), all: false, options: MONTH_CHOICES.map((m) => ({ value: String(m), label: `${m} mån` })) },
  ];
  const csvHref = `/studio/fornyelser.csv${queryString(q)}`;
  const bar = `${filterBar({ action: '/studio/fornyelser', fields, resultLine: `${nOf(rows.length, 'avtal', 'avtal')}, ${nOf(kommuner, 'kommun', 'kommuner')}` })}
<p class="fx-actions"><a class="fx-csv" href="${esc(csvHref)}" download><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M6 9l4 4 4-4M4 16h12"/></svg>Ladda ner listan som CSV</a><span class="meta">semikolonseparerad, öppnas i Excel</span></p>`;

  const foot = `${fmtInt(undated)} aktiva avtal saknar slutdatum och syns inte här. Datumet är när avtalet löper ut, eller när en förlängning eller uppsägning avgörs om avtalet anger det.`;
  const pageHref = (p) => `/studio/fornyelser${queryString(q, { sida: p > 1 ? p : null })}`;
  const body = rows.length
    ? `<div class="card">${renewalChart({ rows, today, months: q.man })}<p class="meta fx-foot">${esc(foot)}</p></div>`
    : emptyPanel({ title: 'Inga förnyelser i urvalet', text: filtered ? 'Ta bort ett filter eller titta längre fram.' : 'Inga aktiva avtal har ett känt slutdatum inom perioden.', context: foot });

  return `${header}
<section class="section">${bar}</section>
${section({ id: 'kalender', kicker: 'Kalender', title: 'Avtal per månad', note: 'staplad per kategori, håll över en stapel för detaljer', body })}
${rows.length ? section({ id: 'lista', kicker: 'Lista', title: 'Avtalen, det närmaste först', note: 'kommun, leverantör, produkt, känt värde och datum', body: `<div class="card fx-card">${listHtml({ rows, today, page, pageHref })}</div>` }) : ''}`;
}
