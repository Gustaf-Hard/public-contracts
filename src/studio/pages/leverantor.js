// /studio/leverantor/:slug (spec §7.5 item 3). Answer first (who buys it,
// where, for how much), visual second, evidence last. Every number on the
// page comes from active, non-superseded avtal; expired ones show only in
// the evidence drawer.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, fmtPct, basisLine, monthsUntil } from '../format.js';
import { companyBySlug } from '../../catalogue.js';
import { companyShares, coOccurrence, priceDistribution, renewalBuckets, elevCoverage } from '../../studio-data.js';
import { entityHeader, kpiTile, segmentStrip, emptyPanel } from '../components.js';
import { rankingBars, loadKommunTiles } from '../charts.js';
import {
  isNum, headline, distinctCount, sumKnown, byContract, consolidateByContract, categoryLabel, kommunNamer, productNames,
  companyHref, productHref, section, breadcrumb, priceStrip, medianText, categoryContext,
  footprintMap, renewalSection, evidenceSection, renewalTileProps, MIN_N, nOf,
  floorText, elevCoverageText, ELEV_BASIS,
} from './common.js';
import { STRIP_SEGMENTS } from '../components.js';
import { entityPurchaseSection, purchaseAnswerText } from './purchases.js';
import { purchasesFor, purchaseKods } from '../../studio-purchases.js';

const MAX_STRIPS = 3;

function unionSegments(rows) {
  const on = new Set(rows.flatMap((f) => f.segments));
  return STRIP_SEGMENTS.map((s) => s.key).filter((k) => on.has(k));
}

function productCards({ company, rows, facts, kommunerTotal }) {
  const cards = [];
  const without = [];
  for (const p of company.products) {
    const pr = rows.filter((f) => f.product_slugs.includes(p.slug));
    if (!pr.length) { without.push(p); continue; }
    const kommuner = distinctCount(pr, (f) => f.kommun_kod);
    const dist = priceDistribution(facts, { productSlug: p.slug });
    // Segments are stated per avtal, not per product: only an avtal that is
    // about this product alone says which segments the product covers.
    cards.push({ p, kommuner, dist, segments: unionSegments(pr.filter((f) => f.product_slugs.length === 1)), n: byContract(pr).length });
  }
  cards.sort((a, b) => b.kommuner - a.kommuner || a.p.name.localeCompare(b.p.name, 'sv'));
  const noProduct = byContract(rows.filter((f) => f.product_slugs.length === 0)).length;

  const html = cards.map(({ p, kommuner, dist, segments, n }, i) => {
    const share = kommunerTotal > 0 ? kommuner / kommunerTotal : 0;
    const priced = !dist.suppressed && isNum(dist.median);
    return `<article class="card pc is-link" style="--i:${i}">
  <div class="pc-head">
    <h3 class="pc-name"><a href="${esc(productHref(p.slug))}" data-pane-link>${esc(p.name)}</a></h3>
    <span class="viz-n">${esc(fmtInt(n))} avtal</span>
  </div>
  <p class="pc-what">${esc(p.whatItIs)}</p>
  <div class="pc-reach">
    <div class="pc-reach-row"><span class="nowrap"><b>${esc(fmtInt(kommuner))}</b> ${kommuner === 1 ? 'kommun' : 'kommuner'}</span><span class="meta nowrap">${esc(fmtPct(share))}</span></div>
    <div class="meter pc-meter" role="img" aria-label="${esc(`${kommuner} av ${kommunerTotal} kommuner`)}"><span class="meter-fill grow-x" style="width:${(share * 100).toFixed(1)}%;--i:${i}"></span></div>
  </div>
  <div class="pc-price${priced ? '' : ' is-unknown hatch'}">
    ${priced
      ? `<span class="pc-price-num">${esc(fmtInt(dist.median))}</span><span class="pc-price-unit">kr/elev, median</span><span class="meta">mittersta hälften ${esc(fmtInt(dist.p25))} till ${esc(fmtInt(dist.p75))}, n = ${esc(fmtInt(dist.n))}</span>`
      : `<span class="pc-price-few">${esc(medianText(dist))}</span><span class="meta">median visas från ${MIN_N} kommuner med känt pris per elev</span>`}
  </div>
  <div class="pc-seg">${segmentStrip(segments)}</div>
</article>`;
  }).join('');

  const withoutLine = without.length ? `Utan aktiva avtal hos oss: ${without.map((p) => `<a href="${esc(productHref(p.slug))}" data-pane-link>${esc(p.name)}</a>`).join(', ')}.` : '';
  const foot = [
    withoutLine,
    noProduct ? `${esc(nOf(noProduct, 'aktivt avtal', 'aktiva avtal'))} anger ingen produkt vi känner igen.` : '',
  ].filter(Boolean).join(' ');

  if (!cards.length) {
    return emptyPanel({
      title: 'Inga produkter utpekade i avtalen än',
      text: noProduct ? `${nOf(noProduct, 'aktivt avtal nämner', 'aktiva avtal nämner')} ingen av leverantörens produkter vid namn.` : 'Vi har inga aktiva avtal med leverantören.',
    }) + (withoutLine ? `<p class="meta pc-foot">${withoutLine}</p>` : '');
  }
  return `<div class="pc-grid">${html}</div>${foot ? `<p class="meta pc-foot">${foot}</p>` : ''}`;
}

function competitors({ rows, facts, slug, category }) {
  const mine = new Set(rows.map((f) => f.kommun_kod));
  const head = headline(facts);
  const same = new Map();
  for (const f of head) {
    if (!mine.has(f.kommun_kod) || !f.company_slug || f.company_slug === slug) continue;
    const c = companyBySlug(f.company_slug);
    if (!c || c.hiddenInStudio) continue;
    if (!category || (f.category ?? null) !== category) continue;
    if (!same.has(f.company_slug)) same.set(f.company_slug, { name: f.company_name, kods: new Set() });
    same.get(f.company_slug).kods.add(f.kommun_kod);
  }
  const compItems = [...same.entries()].map(([s, v]) => ({
    label: v.name, href: companyHref(s), value: v.kods.size,
    valueLabel: `${fmtInt(v.kods.size)} av ${fmtInt(mine.size)}`,
  })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));

  const co = coOccurrence(facts, slug).filter((c) => !same.has(c.slug) && companyBySlug(c.slug));
  const coItems = co.map((c) => ({
    label: c.name, href: companyHref(c.slug), value: c.kommuner,
    valueLabel: `${fmtInt(c.kommuner)} av ${fmtInt(mine.size)}`,
    sub: categoryLabel(companyBySlug(c.slug)?.category),
  }));

  const col = (title, lede, items, empty) => `<div class="span-6 card">
  <div class="viz-head"><span class="viz-label">${esc(title)}</span><span class="viz-n">gemensamma kommuner</span></div>
  <p class="meta card-lede">${esc(lede)}</p>
  ${items.length ? rankingBars({ items, max: 6, noun: 'leverantörer' }) : emptyPanel({ title: empty })}
</div>`;
  const compCol = category
    ? col('Konkurrerar med', `Andra leverantörer i ${categoryLabel(category).toLowerCase()} som har avtal i samma kommuner.`, compItems, 'Ingen annan leverantör i kategorin hos samma kommuner än')
    : `<div class="span-6 card"><div class="viz-head"><span class="viz-label">Konkurrerar med</span></div>${emptyPanel({ title: 'Kategorin är okänd', text: 'Utan kategori kan vi inte säga vilka leverantörer som gör samma jobb.' })}</div>`;
  return `<div class="grid-12">
${compCol}
${col('Köps ofta tillsammans med', 'Leverantörer i andra kategorier som samma kommuner också köper av.', coItems, 'Inga andra leverantörer hos samma kommuner än')}
</div>`;
}

function channels({ rows, facts, slug, company }) {
  const head = byContract(rows);
  const groups = new Map();
  for (const f of head) {
    const key = f.channel_slug && f.channel_slug !== slug ? f.channel_slug : 'direkt';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const items = [...groups.entries()].map(([key, fs]) => {
    const known = fs.filter((f) => isNum(f.annual_value_sek));
    const ch = key === 'direkt' ? null : companyBySlug(key);
    return {
      label: key === 'direkt' ? `Direkt från ${company.canonical}` : `Via ${ch?.canonical ?? key}`,
      href: key === 'direkt' ? null : companyHref(key),
      value: fs.length,
      valueLabel: `${fmtInt(fs.length)} avtal`,
      share: head.length ? fs.length / head.length : null,
      sub: known.length ? `${fmtKrCompact(sumKnown(known))}/år${known.length < fs.length ? `, känt för ${fmtInt(known.length)}` : ''}` : 'värde okänt',
    };
  }).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));

  let resold = '';
  if (company.role === 'channel') {
    const viaRows = headline(facts).filter((f) => f.channel_slug === slug && f.company_slug && f.company_slug !== slug);
    const via = byContract(viaRows);
    const by = new Map();
    for (const f of viaRows) {
      if (!by.has(f.company_slug)) by.set(f.company_slug, { name: f.company_name, kods: new Set() });
      by.get(f.company_slug).kods.add(f.kommun_kod);
    }
    const resItems = [...by.entries()].map(([s, v]) => ({
      label: v.name, href: companyHref(s), value: v.kods.size, valueLabel: nOf(v.kods.size, 'kommun', 'kommuner'),
    })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
    resold = `<div class="span-6 card"><div class="viz-head"><span class="viz-label">Leverantörer som köps via ${esc(company.canonical)}</span><span class="viz-n">${esc(fmtInt(via.length))} avtal</span></div>
    ${resItems.length ? rankingBars({ items: resItems, max: 6, noun: 'leverantörer' }) : emptyPanel({ title: 'Inga andra leverantörer namngivna i avtalen än' })}</div>`;
  }
  return `<div class="grid-12">
  <div class="span-6 card"><div class="viz-head"><span class="viz-label">Hur kommunerna köper</span><span class="viz-n">${esc(nOf(head.length, 'aktivt avtal', 'aktiva avtal'))}</span></div>
  ${items.length ? rankingBars({ items, max: 6 }) : emptyPanel({ title: 'Inga aktiva avtal' })}</div>
  ${resold}
</div>`;
}

export function renderLeverantor({ company, facts, stats, statusMap, today, page = 1, underlag = null, purchases = [] }) {
  const slug = company.slug;
  // Owner rows: what the company itself sells (product cards, prices, share).
  const all = facts.filter((f) => f.company_slug === slug);
  const rows = headline(all);
  // A reseller's avtal are also the ones it is the vendor of, where every
  // product belongs to someone else (channel_slug), added up per avtal so a
  // fully allocated avtal still counts and a split one shows its whole value.
  const isChannel = company.role === 'channel';
  // Only avtal the reseller is the vendor of are added up; where its own
  // product sits in another vendor's avtal, only its own row counts.
  const avtalAll = isChannel
    ? [...consolidateByContract(facts.filter((f) => f.channel_slug === slug)),
      ...all.filter((f) => f.channel_slug !== slug)]
    : all;
  const avtalRows = isChannel ? headline(avtalAll) : rows;
  const avtal = byContract(avtalRows);
  const nameOf = kommunNamer(stats, facts);
  const category = company.category ?? rows.map((f) => f.category).find(Boolean) ?? null;
  const catLabel = categoryLabel(category);
  const kommuner = distinctCount(avtalRows, (f) => f.kommun_kod);
  const known = avtal.filter((f) => isNum(f.annual_value_sek));
  const value = known.length ? sumKnown(known) : null;
  // A share of 0 % from an unknown value would be a false claim.
  const share = category && value != null ? companyShares(facts, { category }).find((s) => s.slug === slug)?.share_value ?? null : null;

  // Purchase rows: own evidence level, never counted as avtal above.
  const bought = purchasesFor(purchases, { companySlug: slug, viaChannel: isChannel });
  const boughtKods = purchaseKods(bought);

  const roleWord = company.role === 'channel' ? 'Återförsäljare' : 'Leverantör';
  // The value is a floor of the underlag; its coverage is the underlag's in
  // the company's category (all categories when it has none), in elever.
  const cov = elevCoverage(facts, stats, category ? { category } : {});
  const covText = elevCoverageText(cov, { who: category ? `Kommunerna med avtal i ${catLabel.toLowerCase()}` : 'Kommunerna med avtal i underlaget' });
  const answer = avtal.length
    ? `${company.canonical} har aktiva avtal med ${nOf(kommuner, 'kommun', 'kommuner')} i vårt underlag${value != null ? `, värda ${floorText(value)}. ${covText} (${ELEV_BASIS})` : ''}.${company.note ? ` ${company.note}` : ''}`
    : `Vi har inga aktiva avtal med ${company.canonical} än.${avtalAll.length ? ` ${fmtInt(byContract(avtalAll).length)} äldre avtal finns i underlaget.` : ''}`;
  const answerFull = answer + purchaseAnswerText({ kommuner: boughtKods.size, viaChannel: isChannel, entity: company.canonical });

  const header = entityHeader({
    kicker: category ? `${roleWord} · ${catLabel}` : roleWord,
    title: company.canonical,
    answer: answerFull,
    facts: [
      { label: 'Kommuner', value: kommuner, sub: 'med minst ett aktivt avtal' },
      { label: 'Minst per år i underlaget', value: value == null ? null : fmtKrCompact(value), sub: `${basisLine(known.length, avtal.length)}, en lägsta nivå` },
      category
        ? { label: `Andel av ${catLabel.toLowerCase()}`, value: share == null ? null : fmtPct(share), sub: share == null ? 'leverantörens värde är okänt' : isChannel ? 'egna produkter, av känt årsvärde i kategorin i underlaget' : 'av känt årsvärde i kategorin i underlaget' }
        : { label: 'Aktiva avtal', value: avtal.length, sub: `${fmtInt(byContract(avtalAll).length)} insamlade` },
    ],
    viz: segmentStrip(unionSegments(rows)),
  });

  // KPI row: main product's median, renewal pressure.
  const priced = new Map();
  // Same attribution as priceDistribution: the styckpris line's product, or
  // the avtal's only product (a value-per-elev price has no line product).
  const ownAvtal = byContract(rows);
  for (const f of ownAvtal) {
    const p = f.kr_per_elev_product_slug ?? (f.product_slugs.length === 1 ? f.product_slugs[0] : null);
    if (isNum(f.kr_per_elev) && p) priced.set(p, (priced.get(p) ?? 0) + 1);
  }
  const mainSlug = [...priced.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    ?? company.products.find((p) => rows.some((f) => f.product_slugs.includes(p.slug)))?.slug ?? null;
  const mainName = company.products.find((p) => p.slug === mainSlug)?.name ?? null;
  const mainDist = mainSlug ? priceDistribution(facts, { productSlug: mainSlug }) : { n: 0, suppressed: true };
  const nPriced = ownAvtal.filter((f) => isNum(f.kr_per_elev)).length;
  const upcoming = avtal.filter((f) => typeof f.next_renewal === 'string' && f.next_renewal.slice(0, 10) >= today)
    .sort((a, b) => a.next_renewal.localeCompare(b.next_renewal));
  const buckets = renewalBuckets(avtalAll, { today, months: 12 });
  const kpis = `<div class="kpi-row">
    ${kpiTile({ label: 'Aktiva avtal', value: avtal.length, unit: 'avtal', basis: `${fmtInt(byContract(avtalAll).length)} insamlade totalt`, state: avtal.length ? 'known' : 'unknown', reason: 'Inga aktiva avtal i underlaget.' })}
    ${kpiTile({
    label: mainName ? `Median per elev, ${mainName}` : 'Median per elev',
    value: mainDist.suppressed ? null : fmtInt(mainDist.median),
    unit: 'kr/elev',
    state: mainDist.suppressed ? 'unknown' : 'known',
    reason: mainDist.n ? `För få avtal med känt pris (n = ${fmtInt(mainDist.n)}), medianen visas från ${MIN_N}.` : 'Inget avtal anger pris per elev än.',
    basis: `pris per elev känt för ${fmtInt(nPriced)} av ${fmtInt(ownAvtal.length)} avtal${isChannel ? ' med egna produkter' : ''}`,
  })}
    ${kpiTile({
    label: 'Nästa förnyelse',
    value: upcoming.length ? monthsUntil(upcoming[0].next_renewal, today) : null,
    state: upcoming.length ? 'known' : 'unknown',
    reason: 'Inget aktivt avtal anger slutdatum eller förlängning.',
    basis: upcoming.length ? `${nameOf(upcoming[0].kommun_kod)}, ${upcoming[0].next_renewal.slice(0, 10)}` : '',
  })}
    ${kpiTile(renewalTileProps({ avtal, buckets, today }))}
  </div>`;

  // Prices: one strip per product with known prices (most priced first).
  const stripSlugs = [...priced.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, MAX_STRIPS);
  const productLabel = (s) => company.products.find((p) => p.slug === s)?.name ?? s;
  const strips = stripSlugs.map((s) => `<div class="span-12 card">${priceStrip({ facts, filter: { productSlug: s }, label: `${productLabel(s)}, pris per elev och år`, nameOf })}</div>`).join('');
  const thin = !stripSlugs.some((s) => !priceDistribution(facts, { productSlug: s }).suppressed);
  const priceBody = `${stripSlugs.length ? `<div class="grid-12">${strips}</div>` : `<div class="card">${priceStrip({ facts: all, filter: {}, label: `${company.canonical}, pris per elev och år`, nameOf })}</div>`}
  ${thin && category ? `<div class="ctx-wrap">${categoryContext({ facts, category, highlightSlug: slug, nameOf })}</div>` : ''}`;

  const tiles = safeTiles();
  const renew = renewalSection({
    rows: avtalAll, today, nameOf,
    titleOf: (f) => productNames(f).join(', ') || company.canonical,
  });
  const ev = evidenceSection({
    rows: avtalAll, today, page, nameOf,
    pageHref: (p) => `/studio/leverantor/${encodeURIComponent(slug)}?sida=${p}#underlag`,
  });

  return `${breadcrumb([{ label: 'Leverantörer', href: '/studio/leverantorer' }, ...(category ? [{ label: catLabel, href: `/studio/kategori/${category}` }] : []), { label: company.canonical }])}
${header}
<section class="section">${kpis}</section>
${section({ id: 'produkter', kicker: 'Produkter', title: `Det här köper kommunerna av ${company.canonical}`, note: rows.some((f) => f.product_slugs.length) ? `stapeln visar andel av leverantörens ${nOf(kommuner, 'kommun', 'kommuner')}, segment från avtal som gäller enbart produkten` : '', body: productCards({ company, rows, facts, kommunerTotal: kommuner }) })}
${section({ id: 'karta', kicker: 'Var', title: 'Kommuner med avtal', note: `${nOf(kommuner, 'kommun', 'kommuner')}, håll över en ruta för namn`, body: `<div class="card map-card">${footprintMap({ tiles, rows: avtalAll, statusMap, stats, entity: company.canonical, nameOf, underlag, scope: { category: company.category ?? null, companySlug: company.slug }, purchaseKods: boughtKods })}</div>` })}
${bought.length ? section({ id: 'inkop', kicker: 'Inköpslistor', title: isChannel ? `Köpt via ${company.canonical}` : 'Finns i kommunernas inköpslistor', note: 'köp, inte avtal; räknas inte i avtalssiffrorna eller i pris per elev', body: entityPurchaseSection({ rows: bought, today, entity: company.canonical, nameOf, viaChannel: isChannel }) }) : ''}
${section({ id: 'pris', kicker: 'Pris', title: 'Pris per elev och år', note: `en punkt per kommun, kommunens namn när du håller över`, body: priceBody })}
${section({ id: 'konkurrenter', kicker: 'Grannar', title: 'Andra leverantörer i samma kommuner', body: competitors({ rows, facts, slug, category }) })}
${section({ id: 'fornyelser', kicker: 'Förnyelser', title: 'Avtal som förnyas eller löper ut', note: renew.basis, body: `<div class="card">${renew.html}</div>` })}
${section({ id: 'kanaler', kicker: 'Kanal', title: 'Direkt eller via återförsäljare', body: channels({ rows: avtalRows, facts, slug, company }) })}
${section({ id: 'underlag', kicker: 'Underlag', title: 'Avtalen bakom siffrorna', note: `${fmtInt(ev.active)} aktiva, ${fmtInt(ev.old)} utgångna eller ersatta`, body: ev.html })}`;
}

function safeTiles() {
  try { return loadKommunTiles(); } catch { return { cols: 1, rows: 1, tiles: {} }; }
}
