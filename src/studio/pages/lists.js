// Directories and search (spec §7.5 item 8, §7.1): /studio/leverantorer
// (company cards grouped by category), /studio/kommuner (tile map coloured by
// collection status + a list per län) and /studio/sok (exact match redirects,
// otherwise a results page). hiddenInStudio companies never appear.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact } from '../format.js';
import { CATEGORIES, companies, normName } from '../../catalogue.js';
import { companyShares, isCollectionFinished, KOMMUNER_TOTAL } from '../../studio-data.js';
import { filterBar, emptyPanel } from '../components.js';
import { tileMap } from '../charts.js';
import {
  headline, categoryLabel, companyHref, productHref, kommunHref, kommunNamer, section, nOf, safeAll,
} from './common.js';

const CHANNEL_GROUP = 'kanal';

// ------------------------------------------------------------------ leverantörer

function companyStats(facts) {
  const by = new Map();
  for (const s of companyShares(facts)) by.set(s.slug ?? `name:${s.name}`, s);
  return by;
}

function companyCard(c, s, max, i) {
  const href = companyHref(c.slug);
  const kommuner = s?.kommuner ?? 0;
  const prods = c.products.filter((p) => p.name !== c.canonical || c.products.length > 1);
  const shown = prods.slice(0, 3).map((p) => {
    const h = productHref(p.slug);
    return h ? `<a href="${esc(h)}" data-pane-link>${esc(p.name)}</a>` : esc(p.name);
  });
  const value = s && s.n_known ? `<b>${esc(fmtKrCompact(s.value_known_sek))}</b>/år känt` : '<span class="muted">värde okänt</span>';
  return `<article class="card dir-card" style="--i:${i}">
  <h3 class="dir-name"><a href="${esc(href)}" data-pane-link>${esc(c.canonical)}</a></h3>
  ${shown.length ? `<p class="dir-prods">${shown.join(', ')}${prods.length > 3 ? ` <span class="muted">och ${esc(fmtInt(prods.length - 3))} till</span>` : ''}</p>` : ''}
  <div class="dir-reach">
    <div class="dir-row"><span><b>${esc(fmtInt(kommuner))}</b> ${kommuner === 1 ? 'kommun' : 'kommuner'}</span><span class="dir-val">${value}</span></div>
    <div class="meter dir-meter"><span class="meter-fill grow-x" style="width:${(max ? (kommuner / max) * 100 : 0).toFixed(1)}%;--i:${i}"></span></div>
  </div>
</article>`;
}

export function renderLeverantorer({ facts, query = {} }) {
  const qn = normName(typeof query.q === 'string' ? query.q : '');
  const stats = companyStats(facts);
  const visible = companies().filter((c) => !c.hiddenInStudio);
  const match = (name) => !qn || normName(name).includes(qn);
  const matchCompany = (c) => match(c.canonical) || c.products.some((p) => match(p.name));
  const groupOf = (c) => (c.role === 'channel' ? CHANNEL_GROUP : c.category ?? 'ovrigt');
  const groups = [...CATEGORIES.map((c) => ({ slug: c.slug, label: c.label })), { slug: CHANNEL_GROUP, label: 'Återförsäljare och kanaler' }];
  const max = Math.max(1, ...[...stats.values()].map((s) => s.kommuner));
  let withAvtal = 0;
  let i = 0;
  const sections = groups.map((g) => {
    const members = visible.filter((c) => groupOf(c) === g.slug && matchCompany(c));
    if (!members.length) return '';
    const active = members.filter((c) => stats.get(c.slug)?.kommuner)
      .sort((a, b) => stats.get(b.slug).kommuner - stats.get(a.slug).kommuner || a.canonical.localeCompare(b.canonical, 'sv'));
    const idle = members.filter((c) => !stats.get(c.slug)?.kommuner).sort((a, b) => a.canonical.localeCompare(b.canonical, 'sv'));
    withAvtal += active.length;
    const cards = active.map((c) => companyCard(c, stats.get(c.slug), max, i++)).join('');
    const idleHtml = idle.length ? `<details class="dir-idle"><summary>${esc(nOf(idle.length, 'leverantör', 'leverantörer'))} utan aktiva avtal i underlaget</summary>
      <p class="dir-names">${idle.map((c) => `<a href="${esc(companyHref(c.slug))}" data-pane-link>${esc(c.canonical)}</a>`).join('')}</p></details>` : '';
    const total = active.reduce((s, c) => s + (stats.get(c.slug)?.n_known ? stats.get(c.slug).value_known_sek : 0), 0);
    return section({
      id: `grupp-${g.slug}`,
      kicker: g.slug === CHANNEL_GROUP ? 'Kanaler' : 'Kategori',
      title: g.label,
      note: `${nOf(active.length, 'leverantör', 'leverantörer')} med aktiva avtal${total ? `, känt värde ${fmtKrCompact(total)}/år` : ''}`,
      body: `${cards ? `<div class="dir-grid">${cards}</div>` : ''}${idleHtml}`,
    });
  }).filter(Boolean).join('\n');

  // Names we could not place in the catalogue: listed, never given a page.
  const others = [...stats.values()].filter((s) => !s.slug && match(s.name))
    .sort((a, b) => b.kommuner - a.kommuner || a.name.localeCompare(b.name, 'sv'));
  const othersHtml = others.length ? section({
    id: 'ovriga', kicker: 'Övriga', title: 'Övriga leverantörer',
    note: 'namn från avtalen som inte finns i katalogen än',
    body: `<details class="dir-idle dir-others"><summary>Visa ${esc(nOf(others.length, 'leverantör', 'leverantörer'))} utanför katalogen</summary>
      <ul class="dir-olist">${others.map((s) => `<li><span>${esc(s.name)}</span><span class="muted">${esc(nOf(s.kommuner, 'kommun', 'kommuner'))}</span></li>`).join('')}</ul></details>`,
  }) : '';

  const top = companyShares(facts).find((s) => s.slug && s.n_known);
  const answer = qn
    ? `${nOf(withAvtal, 'leverantör', 'leverantörer')} med aktiva avtal matchar ”${query.q}”.`
    : `${nOf(withAvtal, 'leverantör', 'leverantörer')} i katalogen har aktiva avtal med kommunerna${top ? `, flest kommuner har ${[...stats.values()].filter((s) => s.slug).sort((a, b) => b.kommuner - a.kommuner)[0].name}` : ''}. Klicka en leverantör för produkter, priser, karta och förnyelser.`;

  return `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Leverantörer</span>
      <h1 class="page-title">Vem säljer till skolan</h1>
      <p class="lede">${esc(answer)}</p>
    </div>
  </div>
</section>
<section class="section">${filterBar({ action: '/studio/leverantorer', fields: [{ name: 'q', label: 'Sök leverantör eller produkt', type: 'text', value: query.q ?? '', placeholder: 't.ex. Vklass', chip: false }] })}</section>
${sections || emptyPanel({ title: 'Ingen leverantör matchar', text: 'Prova ett kortare sökord.' })}
${othersHtml}`;
}

// ------------------------------------------------------------------ kommuner

export const KOMMUN_STATUS = Object.freeze({
  done: { label: 'Insamling klar', tile: 'has', chip: 'is-done' },
  open: { label: 'Insamling pågår', tile: 'none-open', chip: 'is-open' },
  dead_end: { label: 'Inga avtal utlämnade', tile: 'refused', chip: 'is-none' },
  not_contacted: { label: 'Inte kontaktad', tile: 'not-contacted', chip: 'is-none' },
  unknown: { label: 'Status okänd', tile: 'unknown', chip: 'is-none' },
});

export function kommunStatus(statusMap, kod, hasAvtal) {
  const raw = statusMap.get(kod);
  if (raw && KOMMUN_STATUS[raw]) return raw === 'not_contacted' && hasAvtal ? 'unknown' : raw;
  return hasAvtal ? 'unknown' : 'not_contacted';
}

export function renderKommuner({ facts, stats, statusMap = new Map(), tiles, query = {} }) {
  const nameOf = kommunNamer(stats, facts);
  const head = headline(facts);
  const avtalBy = new Map();
  for (const f of head) {
    if (!avtalBy.has(f.kommun_kod)) avtalBy.set(f.kommun_kod, new Set());
    avtalBy.get(f.kommun_kod).add(f.contract_id);
  }
  const all = safeAll(stats);
  const kods = all.length ? all.map((r) => r.kod) : [...new Set([...statusMap.keys(), ...facts.map((f) => f.kommun_kod)])].filter(Boolean);
  const lanOf = new Map(all.map((r) => [r.kod, r.lan ?? null]));
  const collectedKods = new Set(facts.map((f) => f.kommun_kod));
  const rows = kods.map((kod) => {
    const n = avtalBy.get(kod)?.size ?? 0;
    return { kod, name: nameOf(kod), lan: lanOf.get(kod) ?? null, n, status: kommunStatus(statusMap, kod, collectedKods.has(kod)) };
  });
  const byStatus = (s) => rows.filter((r) => r.status === s).length;
  const statusOf = new Map(rows.map((r) => [r.kod, r.status]));

  // Open collections split in two: avtal have come in, or none yet.
  const tileOf = (kod) => {
    const st = statusOf.get(kod) ?? 'unknown';
    return st === 'open' && collectedKods.has(kod) ? 'has-open' : KOMMUN_STATUS[st].tile;
  };
  const map = tileMap({
    tiles,
    classOf: tileOf,
    titleOf: (kod) => {
      const r = rows.find((x) => x.kod === kod);
      return r ? `${r.name}: ${KOMMUN_STATUS[r.status].label.toLowerCase()}, ${nOf(r.n, 'aktivt avtal', 'aktiva avtal')}` : kod;
    },
    legend: [
      { cls: 'has', label: 'Insamling klar' },
      { cls: 'has-open', label: 'Pågår, avtal har kommit in' },
      { cls: 'none-open', label: 'Pågår, inga avtal än' },
      { cls: 'refused', label: 'Inga avtal utlämnade' },
      { cls: 'not-contacted', label: 'Inte kontaktad' },
    ],
    label: 'Insamlingens status per kommun',
  });

  const lanFilter = typeof query.lan === 'string' ? query.lan : '';
  const statusFilter = typeof query.status === 'string' && KOMMUN_STATUS[query.status] ? query.status : '';
  const list = rows.filter((r) => (!lanFilter || r.lan === lanFilter) && (!statusFilter || r.status === statusFilter));
  const lans = [...new Set(rows.map((r) => r.lan ?? 'Okänt län'))].sort((a, b) => a.localeCompare(b, 'sv'));
  const maxN = Math.max(1, ...rows.map((r) => r.n));
  const groups = lans.map((lan) => {
    const members = list.filter((r) => (r.lan ?? 'Okänt län') === lan).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    if (!members.length) return '';
    const withAvtal = members.filter((r) => r.n).length;
    return `<div class="kl-lan">
    <h3 class="kl-head"><span>${esc(lan)}</span><small>${esc(`${fmtInt(withAvtal)} av ${nOf(members.length, 'kommun', 'kommuner')} med avtal`)}</small></h3>
    <ul class="kl-list">${members.map((r) => `<li class="kl-row">
      <a href="${esc(kommunHref(r.kod))}" data-pane-link>${esc(r.name)}</a>
      <span class="kl-n">${r.n ? `<i style="width:${((r.n / maxN) * 100).toFixed(1)}%"></i><b>${esc(fmtInt(r.n))}</b>` : '<span class="muted">0</span>'}</span>
      <span class="st-chip ${KOMMUN_STATUS[r.status].chip}">${esc(KOMMUN_STATUS[r.status].label)}</span>
    </li>`).join('')}</ul>
  </div>`;
  }).filter(Boolean).join('');

  const withAvtal = rows.filter((r) => r.n).length;
  const finished = rows.filter((r) => isCollectionFinished(r.status)).length;
  const answer = `Vi har aktiva avtal från ${fmtInt(withAvtal)} av ${fmtInt(KOMMUNER_TOTAL)} kommuner. Insamlingen är klar i ${fmtInt(finished)} och pågår i ${fmtInt(byStatus('open'))}${byStatus('dead_end') ? `, ${fmtInt(byStatus('dead_end'))} har inte lämnat ut några avtal` : ''}${byStatus('not_contacted') ? `, ${fmtInt(byStatus('not_contacted'))} har vi inte kontaktat än` : ''}.`;

  return `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Kommuner</span>
      <h1 class="page-title">Alla ${esc(fmtInt(KOMMUNER_TOTAL))} kommuner</h1>
      <p class="lede">${esc(answer)}</p>
    </div>
    <div class="eh-side">
      <dl class="eh-facts">
        <div class="eh-fact"><dt>Med aktiva avtal</dt><dd class="eh-val">${esc(fmtInt(withAvtal))}</dd><dd class="eh-sub">av ${esc(fmtInt(KOMMUNER_TOTAL))}</dd></div>
        <div class="eh-fact"><dt>Insamling klar</dt><dd class="eh-val">${esc(fmtInt(byStatus('done')))}</dd><dd class="eh-sub">${esc(byStatus('dead_end') ? `och ${fmtInt(byStatus('dead_end'))} utan utlämnade avtal` : 'kommuner')}</dd></div>
        <div class="eh-fact"><dt>Pågår</dt><dd class="eh-val">${esc(fmtInt(byStatus('open')))}</dd><dd class="eh-sub">kommuner</dd></div>
      </dl>
    </div>
  </div>
</section>
${section({ id: 'karta', kicker: 'Karta', title: 'Hur långt insamlingen har kommit', note: 'en ruta per kommun, håll över för namn', body: `<div class="card map-card">${map}</div>` })}
${section({
    id: 'lista', kicker: 'Lista', title: 'Kommuner per län', note: 'aktiva avtal och insamlingens status',
    body: `${filterBar({
      action: '/studio/kommuner',
      fields: [
        { name: 'lan', label: 'Län', value: lanFilter, options: lans },
        { name: 'status', label: 'Status', value: statusFilter, options: ['done', 'open', 'dead_end', 'not_contacted'].map((s) => ({ value: s, label: KOMMUN_STATUS[s].label })) },
      ],
      resultLine: nOf(list.length, 'kommun', 'kommuner'),
    })}${groups ? `<div class="kl-grid">${groups}</div>` : emptyPanel({ title: 'Ingen kommun matchar filtren' })}`,
  })}`;
}

// ------------------------------------------------------------------ search

function searchIndex({ stats, facts }) {
  const out = [];
  const nameOf = kommunNamer(stats, facts);
  const kods = new Set(safeAll(stats).map((r) => r.kod));
  for (const f of facts) if (f.kommun_kod) kods.add(f.kommun_kod);
  for (const kod of kods) out.push({ type: 'kommun', name: nameOf(kod), href: kommunHref(kod) });
  for (const c of companies()) {
    if (c.hiddenInStudio) continue;
    out.push({ type: 'leverantor', name: c.canonical, href: companyHref(c.slug), sub: categoryLabel(c.role === 'channel' ? null : c.category) });
    for (const p of c.products) {
      if (p.name === c.canonical) continue;
      out.push({ type: 'produkt', name: p.name, href: productHref(p.slug), sub: c.canonical });
    }
  }
  return out.filter((x) => x.href);
}

const searchKey = (s) => normName(s).replace(/ kommun$/, '');

// Exact match (case, accents and a trailing "kommun" ignored) of exactly one
// entity → its page. Otherwise null and the caller renders the results.
export function exactSearchHit({ q, stats, facts }) {
  const k = searchKey(q);
  if (!k) return null;
  const hits = searchIndex({ stats, facts }).filter((x) => searchKey(x.name) === k);
  return hits.length === 1 ? hits[0].href : null;
}

const TYPE_LABEL = { kommun: 'Kommuner', leverantor: 'Leverantörer', produkt: 'Produkter' };
const SEARCH_MAX = 24;

export function renderSearch({ q = '', stats, facts }) {
  const k = searchKey(q);
  const index = searchIndex({ stats, facts });
  const hits = k ? index.filter((x) => searchKey(x.name).includes(k)) : [];
  const rank = (x) => (searchKey(x.name) === k ? 0 : searchKey(x.name).startsWith(k) ? 1 : 2);
  const blocks = ['kommun', 'leverantor', 'produkt'].map((type) => {
    const list = hits.filter((x) => x.type === type).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'sv'));
    if (!list.length) return '';
    return `<div class="card so-block">
    <div class="viz-head"><span class="viz-label">${esc(TYPE_LABEL[type])}</span><span class="viz-n">${esc(fmtInt(list.length))}</span></div>
    <ul class="so-list">${list.slice(0, SEARCH_MAX).map((x) => `<li><a href="${esc(x.href)}" data-pane-link>${esc(x.name)}</a>${x.sub && x.sub !== 'Okänd kategori' ? `<small>${esc(x.sub)}</small>` : ''}</li>`).join('')}</ul>
    ${list.length > SEARCH_MAX ? `<p class="meta">och ${esc(fmtInt(list.length - SEARCH_MAX))} till, skriv mer för att smalna av</p>` : ''}
  </div>`;
  }).filter(Boolean).join('');
  const title = k ? `Sökresultat för ”${q}”` : 'Sök i studion';
  const lede = !k
    ? 'Skriv namnet på en kommun, en leverantör eller en produkt.'
    : hits.length ? `${nOf(hits.length, 'träff', 'träffar')} bland kommuner, leverantörer och produkter.` : 'Inget i studion matchar sökningen.';
  return `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      <span class="kicker">Sök</span>
      <h1 class="page-title">${esc(title)}</h1>
      <p class="lede">${esc(lede)}</p>
    </div>
  </div>
</section>
<section class="section">${filterBar({ action: '/studio/sok', fields: [{ name: 'q', label: 'Kommun, leverantör eller produkt', type: 'text', value: q, placeholder: 't.ex. Ale eller Vklass', chip: false }] })}</section>
<section class="section">${blocks ? `<div class="so-grid">${blocks}</div>` : emptyPanel({
    title: k ? 'Inga träffar' : 'Börja skriva',
    text: k ? 'Prova en kortare del av namnet, eller bläddra bland alla leverantörer och kommuner.' : `Sökningen letar bland alla ${fmtInt(KOMMUNER_TOTAL)} kommuner och alla leverantörer och produkter i katalogen.`,
  })}
  <p class="so-browse"><a href="/studio/leverantorer" data-pane-link>Alla leverantörer</a><a href="/studio/kommuner" data-pane-link>Alla kommuner</a><a href="/studio/kategorier" data-pane-link>Alla kategorier</a></p>
</section>`;
}
