// Purchase rows on studio pages (2026-10-27): what a kommun's purchase and
// licence lists show, as its own evidence level ("Köpt via Skolon", "Finns i
// kommunens inköpslista"), never as an avtal. Nothing here sums rows; a total
// is shown only as the document's own stated total. Pure renderers.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, monthsUntil } from '../format.js';
import { companyBySlug, productBySlug } from '../../catalogue.js';
import { purchaseEvidenceLabel, purchaseKommuner, upcomingLicenceEnds, purchaseDocuments } from '../../studio-purchases.js';
import { companyHref, productHref, kommunHref, nOf } from './common.js';

const MAX_COMPANIES = 8;
const MAX_ENDS = 8;
const MAX_KOMMUNER = 20;

const fold = (summary, body) => `<details class="kn-fold"><summary>${esc(summary)}</summary>${body}</details>`;
const link = (href, text) => (href ? `<a href="${esc(href)}" data-pane-link>${esc(text)}</a>` : esc(text));
const productLabel = (slug) => productBySlug(slug)?.product.name ?? null;

// "licensperiod till 2026-06-30 (läsår 2025/26)", "licensperiod okänd".
export function licenceText(p, today = null) {
  if (!p.licence_end) return 'licensperiod okänd';
  const ended = today && p.licence_end < today;
  return `licensperiod ${ended ? 'slutade' : 'till'} ${p.licence_end}${p.licence_basis === 'lasar' && p.school_year ? ` (läsår ${p.school_year})` : ''}`;
}

const rowName = (p) => p.product ?? p.supplier ?? 'okänd rad';

function companyGroups(rows) {
  const by = new Map();
  for (const p of rows) {
    if (!p.company_slug) continue;
    if (!by.has(p.company_slug)) by.set(p.company_slug, { slug: p.company_slug, name: p.company_name ?? companyBySlug(p.company_slug)?.canonical ?? p.company_slug, rows: [] });
    by.get(p.company_slug).rows.push(p);
  }
  return [...by.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name, 'sv'));
}

function endsList(rows, today) {
  const ends = upcomingLicenceEnds(rows, { today });
  if (!ends.length) return '';
  const items = ends.slice(0, MAX_ENDS).map((p) => `<li><b>${esc(p.licence_end)}</b><span>${esc(rowName(p))}</span><span class="meta">${esc(`${monthsUntil(p.licence_end, today)}${p.licence_basis === 'lasar' ? ', slutet av läsåret' : ''}`)}</span></li>`).join('');
  const more = ends.length > MAX_ENDS ? `<p class="meta">${esc(`${fmtInt(ends.length - MAX_ENDS)} licensperioder till slutar senare.`)}</p>` : '';
  return `<div class="pu-ends"><span class="viz-label">Licensperioder som löper ut</span><ul class="pu-end-list">${items}</ul>${more}</div>`;
}

function docLine(rows) {
  const docs = purchaseDocuments(rows);
  const stated = docs.filter((d) => d.stated_total_sek != null);
  const bits = [`${nOf(docs.length, 'dokument', 'dokument')}, ${nOf(rows.length, 'rad', 'rader')}`];
  for (const d of stated) bits.push(`${docs.length === 1 ? 'dokumentet' : 'ett av dokumenten'} anger själv totalt ${fmtKrCompact(d.stated_total_sek)}`);
  return bits.join('; ');
}

// The kommun page: one card per evidence label.
export function kommunPurchaseSection({ rows = [], today }) {
  if (!rows.length) return '';
  const byLabel = new Map();
  for (const p of rows) {
    const l = purchaseEvidenceLabel(p.channel_slug);
    if (!byLabel.has(l)) byLabel.set(l, []);
    byLabel.get(l).push(p);
  }
  const cards = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length).map(([label, ps], i) => {
    const groups = companyGroups(ps);
    const unknown = ps.filter((p) => !p.company_slug);
    const item = (g) => {
      const products = [...new Set(g.rows.map((p) => p.product_slug).filter(Boolean))];
      const names = products.map((sl) => link(productHref(sl), productLabel(sl) ?? sl)).join(', ');
      const latest = g.rows.filter((p) => p.licence_end).sort((a, b) => b.licence_end.localeCompare(a.licence_end))[0];
      // One row: its own amount as the list states it. Several rows are
      // never added up.
      const one = g.rows.length === 1 && typeof g.rows[0].amount_sek === 'number' ? `, ${fmtKrCompact(g.rows[0].amount_sek)} enligt listan` : '';
      return `<li><div class="pu-co">${link(companyHref(g.slug), g.name)}${names ? `<span class="pu-prod">${names}</span>` : ''}</div><span class="meta">${esc(`${nOf(g.rows.length, 'rad', 'rader')}${one}, ${latest ? licenceText(latest, today) : 'licensperiod okänd'}`)}</span></li>`;
    };
    const li = groups.slice(0, MAX_COMPANIES).map(item).join('');
    const restCo = groups.length > MAX_COMPANIES
      ? fold(`Visa ${nOf(groups.length - MAX_COMPANIES, 'leverantör', 'leverantörer')} till`, `<ul class="pu-list">${groups.slice(MAX_COMPANIES).map(item).join('')}</ul>`)
      : '';
    const unk = unknown.length
      ? fold(`${nOf(unknown.length, 'rad', 'rader')} som vi inte kan koppla till en leverantör i katalogen`, `<ul class="pu-raw">${unknown.slice(0, 60).map((p) => `<li>${esc([p.supplier, p.product].filter(Boolean).join(': '))}</li>`).join('')}</ul>${unknown.length > 60 ? `<p class="meta">${esc(`och ${fmtInt(unknown.length - 60)} till.`)}</p>` : ''}`)
      : '';
    return `<article class="card pu-card" style="--i:${i}">
  <div class="viz-head"><span class="viz-label"><i class="pu-mark" aria-hidden="true"></i>${esc(label)}</span><span class="viz-n">${esc(nOf(groups.length, 'leverantör i katalogen', 'leverantörer i katalogen'))}</span></div>
  <p class="meta">${esc(docLine(ps))}</p>
  ${li ? `<ul class="pu-list">${li}</ul>` : ''}${restCo}
  ${unk}
</article>`;
  }).join('');
  return `<p class="meta card-lede pu-lede">Rader ur inköpslistor, orderhistorik och licensöversikter som kommunen har lämnat ut. Det är köp, inte avtal: de räknas inte som avtal i underlaget, inte i årsvärdet och inte i medianer per elev. Vi summerar aldrig raderna; en totalsumma visas bara när dokumentet själv anger den.</p>
<div class="pu-grid">${cards}</div>
${endsList(rows, today) ? `<div class="card">${endsList(rows, today)}</div>` : ''}`;
}

// Leverantör and produkt pages: the kommuner whose lists show the entity.
export function entityPurchaseSection({ rows = [], today, entity, nameOf = (k) => k, viaChannel = false }) {
  if (!rows.length) return '';
  const ks = purchaseKommuner(rows);
  const li = ks.slice(0, MAX_KOMMUNER).map((k) => `<li><div class="pu-co">${link(kommunHref(k.kommun_kod), nameOf(k.kommun_kod) ?? k.kommun_namn)}<span class="pu-prod">${esc(k.labels.join(', '))}</span></div><span class="meta">${esc(`${nOf(k.n, 'rad', 'rader')}, ${k.latest_end ? `licensperiod ${k.latest_end < today ? 'slutade' : 'till'} ${k.latest_end}${k.basis === 'lasar' ? ' (läsårets slut)' : ''}` : 'licensperiod okänd'}`)}</span></li>`).join('');
  const more = ks.length > MAX_KOMMUNER ? `<p class="meta">${esc(`${nOf(ks.length - MAX_KOMMUNER, 'kommun', 'kommuner')} till.`)}</p>` : '';
  const lede = viaChannel
    ? `Kommuner vars inköpslistor eller orderhistorik visar köp via ${entity}. Det är köp, inte avtal, och de räknas inte i avtalssiffrorna ovan eller i medianer per elev.`
    : `Kommuner vars inköpslistor eller orderhistorik nämner ${entity}. Det är köp, inte avtal, och de räknas inte i avtalssiffrorna ovan eller i medianer per elev.`;
  const ends = endsList(rows, today);
  return `<div class="grid-12">
  <div class="span-${ends ? 7 : 12} card">
    <div class="viz-head"><span class="viz-label"><i class="pu-mark" aria-hidden="true"></i>${esc('Kommuner med köprader')}</span><span class="viz-n">${esc(nOf(ks.length, 'kommun', 'kommuner'))}</span></div>
    <p class="meta card-lede">${esc(lede)}</p>
    <ul class="pu-list">${li}</ul>${more}
  </div>
  ${ends ? `<div class="span-5 card">${ends}</div>` : ''}
</div>`;
}

// One line for a page header: "Inköpslistor visar också köp i 3 kommuner".
export function purchaseAnswerText({ kommuner = 0, viaChannel = false, entity = '' } = {}) {
  if (!kommuner) return '';
  return viaChannel
    ? ` Inköpslistor visar också köp via ${entity} i ${nOf(kommuner, 'kommun', 'kommuner')}, som köp och inte som avtal.`
    : ` ${entity} finns också i inköpslistor från ${nOf(kommuner, 'kommun', 'kommuner')}, som köp och inte som avtal.`;
}
