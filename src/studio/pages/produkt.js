// /studio/produkt/:slug (spec §7.5 item 4). What it costs per elev, by
// segment and kommungrupp, where it is used, what else does the same job,
// and when it comes up for renewal. A product inside a multi-product avtal
// has no value of its own, so the page never sums annual value per product.

import { esc } from '../layout.js';
import { fmtInt } from '../format.js';
import { companies, productBySlug } from '../../catalogue.js';
import { priceDistribution, renewalBuckets } from '../../studio-data.js';
import { entityHeader, kpiTile, segmentStrip, emptyPanel, STRIP_SEGMENTS } from '../components.js';
import { rankingBars, segmentMatrix, loadKommunTiles } from '../charts.js';
import {
  headline, distinctCount, byContract, categoryLabel, kommunNamer, productNames,
  companyHref, productHref, section, breadcrumb, priceStrip, medianText, categoryContext,
  footprintMap, renewalSection, evidenceSection, renewalTileProps, peerGroupKods, MIN_N,
} from './common.js';

function substitutes({ facts, product, category }) {
  if (!category) return emptyPanel({ title: 'Kategorin är okänd', text: 'Utan kategori kan vi inte säga vilka produkter som gör samma jobb.' });
  const head = headline(facts);
  const items = [];
  for (const c of companies()) {
    if (c.hiddenInStudio) continue;
    for (const p of c.products) {
      if (p.slug === product.slug || p.category !== category) continue;
      const pr = head.filter((f) => f.product_slugs.includes(p.slug));
      if (!pr.length) continue;
      const k = distinctCount(pr, (f) => f.kommun_kod);
      const dist = priceDistribution(facts, { productSlug: p.slug });
      items.push({
        label: p.name,
        href: productHref(p.slug),
        value: k,
        valueLabel: `${fmtInt(k)} ${k === 1 ? 'kommun' : 'kommuner'}`,
        sub: `${c.canonical} · ${medianText(dist)}`,
      });
    }
  }
  items.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'sv'));
  if (!items.length) return emptyPanel({ title: `Inga andra produkter i ${categoryLabel(category).toLowerCase()} i avtalen än` });
  return `<div class="card"><div class="viz-head"><span class="viz-label">Andra produkter i ${esc(categoryLabel(category).toLowerCase())}</span><span class="viz-n">efter antal kommuner</span></div>
  <p class="meta card-lede">Median per elev visas när minst ${MIN_N} avtal har känt pris per elev för produkten.</p>
  ${rankingBars({ items, max: 8, noun: 'produkter' })}</div>`;
}

export function renderProdukt({ product, company, facts, stats, statusMap, today, page = 1 }) {
  const slug = product.slug;
  const all = facts.filter((f) => f.product_slugs.includes(slug) || f.kr_per_elev_product_slug === slug);
  const rows = headline(all);
  const avtal = byContract(rows);
  const nameOf = kommunNamer(stats, facts);
  const category = product.category ?? company.category ?? null;
  const catLabel = categoryLabel(category);
  const kommuner = distinctCount(rows, (f) => f.kommun_kod);
  const dist = priceDistribution(facts, { productSlug: slug });
  // Segments are stated per avtal, not per product. Segment views use only
  // avtal about this product alone, so a bundle's grades never leak in.
  const sole = facts.filter((f) => f.product_slugs.length <= 1);
  const soleRows = rows.filter((f) => f.product_slugs.length === 1);
  const on = new Set(soleRows.flatMap((f) => f.segments));
  const segs = STRIP_SEGMENTS.filter((s) => on.has(s.key));
  const nPriced = dist.n;

  const answer = `${product.whatItIs} ${avtal.length
    ? `Finns i aktiva avtal hos ${fmtInt(kommuner)} ${kommuner === 1 ? 'kommun' : 'kommuner'}.`
    : 'Vi har inga aktiva avtal som nämner produkten än.'}`;

  const header = entityHeader({
    kicker: `Produkt från ${company.canonical} · ${catLabel}`,
    title: product.name,
    answer,
    facts: [
      { label: 'Kommuner', value: kommuner, sub: 'med minst ett aktivt avtal' },
      { label: 'Median per elev', value: dist.suppressed ? null : fmtInt(dist.median), unit: dist.suppressed ? '' : 'kr/elev', sub: dist.suppressed ? medianText(dist) : `n = ${fmtInt(dist.n)} kommuner med känt pris` },
      { label: 'Pris per elev känt', value: nPriced, unit: `av ${fmtInt(avtal.length)}`, sub: 'aktiva avtal' },
    ],
    viz: segmentStrip(segs.map((s) => s.key)),
  });

  const upcoming = avtal.filter((f) => typeof f.next_renewal === 'string' && f.next_renewal.slice(0, 10) >= today)
    .sort((a, b) => a.next_renewal.localeCompare(b.next_renewal));
  const buckets = renewalBuckets(byContract(all), { today, months: 12 });
  const kpis = `<div class="kpi-row">
    ${kpiTile({ label: 'Aktiva avtal', value: avtal.length, unit: 'avtal', state: avtal.length ? 'known' : 'unknown', reason: 'Inga aktiva avtal nämner produkten.', basis: `${fmtInt(byContract(all).length)} insamlade totalt` })}
    ${kpiTile(renewalTileProps({ avtal, buckets, today }))}
    ${kpiTile({ label: 'Mittersta hälften', value: dist.suppressed ? null : `${fmtInt(dist.p25)} till ${fmtInt(dist.p75)}`, unit: 'kr/elev', state: dist.suppressed ? 'unknown' : 'known', reason: `${medianText(dist)}, spridningen visas från ${MIN_N}.`, basis: dist.suppressed ? '' : 'hälften av kommunerna ligger här' })}
    ${kpiTile({ label: 'Nästa förnyelse', value: upcoming.length ? upcoming[0].next_renewal.slice(0, 10) : null, state: upcoming.length ? 'known' : 'unknown', reason: 'Inget aktivt avtal anger slutdatum eller förlängning.', basis: upcoming.length ? nameOf(upcoming[0].kommun_kod) : '' })}
  </div>`;

  // Price: overall strip, then one per segment the avtal cover.
  let priceBody;
  if (!avtal.length || !nPriced) {
    priceBody = `<div class="card">${priceStrip({ facts, filter: { productSlug: slug }, label: `${product.name}, pris per elev och år`, nameOf })}</div>
    <div class="ctx-wrap">${categoryContext({ facts, category, highlightSlug: company.slug, nameOf })}</div>`;
  } else {
    // One segment only would repeat the overall strip.
    // Segments with no priced avtal at all collapse into one line instead of
    // a stack of empty panels.
    const segN = segs.map((s) => ({ s, n: priceDistribution(sole, { productSlug: slug, segment: s.key }).n }));
    const pricedSegs = segN.filter((x) => x.n > 0);
    const noPrice = segN.filter((x) => x.n === 0).map((x) => x.s.key);
    const segStrips = segs.length < 2 ? '' : pricedSegs.map(({ s }) => `<div class="span-6 card">${priceStrip({ facts: sole, filter: { productSlug: slug, segment: s.key }, label: `Avtal som omfattar ${s.key}`, nameOf })}</div>`).join('')
      + (noPrice.length ? `<p class="span-12 meta">Inget avtal som gäller enbart produkten har känt pris per elev för ${esc(noPrice.join(', '))}.</p>` : '');
    priceBody = `<div class="grid-12">
      <div class="span-12 card">${priceStrip({ facts, filter: { productSlug: slug }, label: `${product.name}, alla segment`, nameOf })}</div>
      ${segStrips}
    </div>${dist.suppressed ? `<div class="ctx-wrap">${categoryContext({ facts, category, highlightSlug: company.slug, nameOf })}</div>` : ''}`;
  }

  // Matrix: SKR huvudgrupp x segment, plus "Alla" on both axes.
  let matrix = '';
  if (avtal.length) {
    const groups = peerGroupKods(stats);
    const mRows = [...groups.map((g) => ({ key: g.key, label: g.label, kods: g.kods })), { key: 'all', label: 'Alla kommuner', kods: null }];
    const mCols = [{ key: '*', label: 'Alla segment' }, ...segs.map((s) => ({ key: s.key, label: s.key }))];
    matrix = section({
      id: 'matris', kicker: 'Jämför', title: 'Pris per kommungrupp och segment', note: 'median kr per elev och år, klicka en ruta för spridning; segmentkolumnerna räknar avtal som gäller enbart produkten',
      body: `<div class="card">${segmentMatrix({
        id: `pm-${slug}`,
        rows: mRows,
        cols: mCols,
        rowHead: 'Kommungrupp',
        cell: (r, c) => priceDistribution(c.key === '*' ? facts : sole, {
          productSlug: slug,
          ...(c.key === '*' ? {} : { segment: c.key }),
          ...(r.kods ? { kommunKods: r.kods } : {}),
        }),
      })}<p class="meta sm-note">En punkt per kommun i varje ruta. Ett avtal som gäller flera segment räknas i varje segment det omfattar.</p></div>`,
    });
  }

  const renew = renewalSection({ rows: all, today, nameOf, titleOf: (f) => productNames(f).join(', ') || product.name });
  const ev = evidenceSection({
    rows: all, today, page, nameOf,
    pageHref: (p) => `/studio/produkt/${encodeURIComponent(slug)}?sida=${p}#underlag`,
  });
  const tiles = safeTiles();

  return `${breadcrumb([{ label: 'Leverantörer', href: '/studio/leverantorer' }, { label: company.canonical, href: companyHref(company.slug) }, { label: product.name }])}
${header}
<section class="section">${kpis}</section>
${section({ id: 'pris', kicker: 'Pris', title: 'Pris per elev och år', note: 'en punkt per kommun; per segment räknas bara avtal som gäller enbart produkten', body: priceBody })}
${matrix}
${section({ id: 'karta', kicker: 'Var', title: 'Kommuner som använder produkten', note: `${fmtInt(kommuner)} kommuner med aktivt avtal, håll över en ruta för namn`, body: `<div class="card map-card">${footprintMap({ tiles, rows: all, statusMap, stats, entity: product.name, nameOf })}</div>` })}
${section({ id: 'alternativ', kicker: 'Alternativ', title: 'Produkter som gör samma jobb', body: substitutes({ facts, product, category }) })}
${section({ id: 'fornyelser', kicker: 'Förnyelser', title: 'Avtal som förnyas eller löper ut', note: renew.basis, body: `<div class="card">${renew.html}</div>` })}
${section({ id: 'underlag', kicker: 'Underlag', title: 'Avtalen bakom siffrorna', note: `${fmtInt(ev.active)} aktiva, ${fmtInt(ev.old)} utgångna eller ersatta`, body: ev.html })}`;
}

export function findProduct(slug) {
  const hit = productBySlug(slug);
  if (!hit || hit.company.hiddenInStudio) return null;
  return hit;
}

function safeTiles() {
  try { return loadKommunTiles(); } catch { return { cols: 1, rows: 1, tiles: {} }; }
}

