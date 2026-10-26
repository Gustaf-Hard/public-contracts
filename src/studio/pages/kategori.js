// /studio/kategori/:slug (spec §7.5 item 2). Market size and shares, price
// per elev by kommungrupp and segment, pricing models, where the underlag
// has avtal, and renewals for one category. Vendor questions 3, 6, 7, 10; buyer 3, 4.
// Kommun names appear for who has what and when it renews (public record),
// never as a price ranking.

import { esc } from '../layout.js';
import { fmtInt, fmtKrCompact, fmtPct, fmtPrice } from '../format.js';
import { CATEGORIES, companies } from '../../catalogue.js';
import {
  companyShares, companyKey, priceDistribution, pricingModelMix, renewalBuckets, whiteSpots, distribution,
  KOMMUNER_TOTAL, UNKNOWN_CATEGORY, MIN_N, inRequest,
} from '../../studio-data.js';
import { entityHeader, kpiTile, emptyPanel, STRIP_SEGMENTS } from '../components.js';
import { segmentMatrix, renewalTimeline, loadKommunTiles } from '../charts.js';
import {
  isNum, headline, byContract, byAvtal, distinctCount, kommunNamer, productNames, productHref, companyHref,
  section, breadcrumb, priceStrip, medianText, evidenceSection, renewalTileProps, peerGroupKods,
  modelLabel, safeAll, nOf, RENEWAL_MONTHS, isIso, coverageMap, noneStatusText, laneValue,
} from './common.js';
import { knownValue, shareBar, topThree, vendorRankings } from './marknad.js';

const MAX_LANES = 10;
const MAX_CARDS = 12;
const catOf = (f) => f.category ?? UNKNOWN_CATEGORY;

export function findCategory(slug) {
  return CATEGORIES.find((c) => c.slug === slug) ?? null;
}

// ------------------------------------------------------------ pricing models

// Colour slots: only the first three categorical hues pass the all-pairs
// check (validate_palette.js --pairs all, light and dark), and a missing model
// would make any two slots neighbours, so three models get a hue, every other
// known model shares the neutral "övriga" and unknown is hatched. The legend
// names every model with its count.
const MODEL_SLOT = { per_student: 'm1', fixed: 'm2', tiered: 'm3' };
const isUnknownModel = (m) => m === UNKNOWN_CATEGORY || m === 'unknown' || !modelLabel(m);

function modelMix({ facts, category }) {
  const mix = pricingModelMix(facts, { category });
  const total = mix.reduce((s, m) => s + m.n, 0);
  if (!total) return emptyPanel({ title: 'Inga aktiva avtal i kategorin än' });
  const rows = headline(facts).filter((f) => catOf(f) === category);
  const order = (m) => (MODEL_SLOT[m.model] ? Object.keys(MODEL_SLOT).indexOf(m.model) : isUnknownModel(m.model) ? 9 : 5);
  const items = [...mix].sort((a, b) => order(a) - order(b) || b.n - a.n);
  const cls = (m) => MODEL_SLOT[m.model] ?? (isUnknownModel(m.model) ? 'm-unknown' : 'm-other');
  const name = (m) => (isUnknownModel(m.model) ? 'Prismodell okänd' : modelLabel(m.model));
  const segs = items.map((m) => `<i class="mm-seg ${cls(m)}${cls(m) === 'm-unknown' ? ' hatch' : ''}" style="flex-basis:${((m.n / total) * 100).toFixed(2)}%"><span class="tip" role="tooltip"><strong>${esc(name(m))}</strong><span>${esc(nOf(m.n, 'avtal', 'avtal'))}, ${esc(fmtPct(m.n / total))}</span></span></i>`).join('');
  const legend = items.map((m) => {
    // Median annual value per avtal for the model, from MIN_N known values.
    const vals = byAvtal(rows.filter((f) => (f.pricing_model ?? UNKNOWN_CATEGORY) === m.model)).map((f) => f.annual_value_sek).filter(isNum);
    const d = distribution(vals);
    const med = d.suppressed ? (vals.length ? `värde känt för ${fmtInt(vals.length)}, för få för median` : 'värde okänt') : `median ${fmtKrCompact(d.median)}/år per avtal (n = ${fmtInt(d.n)})`;
    return `<li><i class="mm-sw ${cls(m)}${cls(m) === 'm-unknown' ? ' hatch' : ''}"></i><span class="mm-name">${esc(name(m))}</span><b>${esc(fmtPct(m.n / total))}</b><span class="mm-n">${esc(nOf(m.n, 'avtal', 'avtal'))}</span><span class="mm-med">${esc(med)}</span></li>`;
  }).join('');
  return `<figure class="viz mm">
  <div class="viz-head"><span class="viz-label">Andel avtal per prismodell</span><span class="viz-n">${esc(nOf(total, 'aktivt avtal', 'aktiva avtal'))}</span></div>
  <div class="mm-bar" role="img" aria-label="${esc(items.map((m) => `${name(m)} ${fmtPct(m.n / total)}`).join(', '))}">${segs}</div>
  <ul class="mm-legend">${legend}</ul>
</figure>`;
}

// ------------------------------------------------------------ coverage map

// What the underlag holds per kommun in the category (coverageMap), with the
// collection status beside it as a neutral fact. Never an absence claim (r4
// W1): a kommun without an avtal in the underlag may still have one.
function whiteSpotMap({ ws, label, nameOf, tiles, requested }) {
  const lower = label.toLowerCase();
  const map = coverageMap({ ws, tiles, nameOf, what: `i ${lower}`, label: `Kommuner med avtal i ${lower} i underlaget` });
  const nExp = ws.expired.length;
  const status = noneStatusText(ws);
  const side = `<div class="ws-side">
    <p class="ws-big"><b>${esc(fmtInt(ws.none.length))}</b> ${ws.none.length === 1 ? 'kommun har' : 'kommuner har'} inget avtal i ${esc(lower)} i underlaget.</p>
    <p class="meta">${status ? `${esc(status)}. ` : ''}Det betyder inte att de saknar avtal: mejl, fakturor och sammanställningar kan nämna leverantörer vi inte har avtal för, och en kommun skickar det den hittar.${requested ? '' : ` ${esc(label)} ingår inte i vår begäran, så kommunerna har ingen anledning att skicka sådana avtal till oss.`}</p>
    ${nExp ? `<p class="ws-exp"><b>${esc(fmtInt(nExp))}</b> ${nExp === 1 ? 'kommun har' : 'kommuner har'} bara utgångna eller ersatta avtal i ${esc(lower)} i underlaget. De har köpt i kategorin, ett nyare avtal kan finnas utan att vi har det.</p>` : ''}
  </div>`;
  return `<div class="ws card"><div class="ws-map">${map}</div>${side}</div>`;
}

// KPI basis: how many of the kommuner without an avtal in the underlag have a
// finished collection, and why that is still not a claim.
function wsBasis(ws, { requested, label }) {
  const done = ws.noneByStatus.done + ws.noneByStatus.unreviewed;
  return `varav ${fmtInt(done)} med klar insamling; mejl och sammanställningar kan nämna leverantörer vi inte har avtal för${requested ? '' : `; ${label.toLowerCase()} ingår inte i vår begäran`}`;
}

// ------------------------------------------------------------ renewals

function renewalLanes({ rows, today, nameOf }) {
  // Counts are avtal: a samverkansavtal from two kommuner is one.
  const head = byAvtal(rows);
  const [y, m, d] = today.split('-').map(Number);
  const until = new Date(Date.UTC(y, m - 1 + RENEWAL_MONTHS, d)).toISOString().slice(0, 10);
  const dated = rows.filter((f) => isIso(f.next_renewal) && f.next_renewal.slice(0, 10) >= today);
  const inWindow = dated.filter((f) => f.next_renewal.slice(0, 10) <= until);
  const avtalKey = (f) => f.avtal_key ?? String(f.contract_id);
  const datedIds = new Set(dated.map(avtalKey));
  const unknownDate = head.filter((f) => !datedIds.has(avtalKey(f))).length;
  const byCo = new Map();
  for (const f of inWindow) {
    const k = companyKey(f);
    if (!byCo.has(k)) byCo.set(k, { slug: f.company_slug, name: f.company_name, fs: [] });
    byCo.get(k).fs.push(f);
  }
  const lanes = [...byCo.values()]
    .map((l) => ({ ...l, fs: l.fs.sort((a, b) => a.next_renewal.localeCompare(b.next_renewal)) }))
    .sort((a, b) => b.fs.length - a.fs.length || a.fs[0].next_renewal.localeCompare(b.fs[0].next_renewal) || a.name.localeCompare(b.name, 'sv'));
  const shown = lanes.slice(0, MAX_LANES);
  const basis = [
    `${fmtInt(distinctCount(inWindow, avtalKey))} av ${nOf(head.length, 'aktivt avtal', 'aktiva avtal')} förnyas eller löper ut inom ${RENEWAL_MONTHS} mån`,
    unknownDate ? `${fmtInt(unknownDate)} utan känt slutdatum` : '',
  ].filter(Boolean).join(', ');
  if (!shown.length) {
    return {
      basis,
      html: emptyPanel({
        title: `Inga kända förnyelser inom ${RENEWAL_MONTHS} månader`,
        text: !head.length ? 'Inga aktiva avtal i kategorin än.' : unknownDate ? `${fmtInt(unknownDate)} av ${nOf(head.length, 'aktivt avtal', 'aktiva avtal')} anger inget slutdatum.` : 'Alla aktiva avtal löper längre än så.',
      }),
    };
  }
  const tl = renewalTimeline({
    today,
    months: RENEWAL_MONTHS,
    laneHead: 'Leverantör',
    lanes: shown.map((l) => ({
      label: l.name,
      href: companyHref(l.slug),
      sub: `${nOf(l.fs.length, 'avtal', 'avtal')}, först ${l.fs[0].next_renewal.slice(0, 10)}`,
      items: l.fs.map((f) => ({
        date: f.next_renewal.slice(0, 10),
        ...laneValue(f),
        title: [nameOf(f.kommun_kod), productNames(f).join(', ')].filter(Boolean).join(', '),
      })),
    })),
  });
  const rest = lanes.length - shown.length;
  return {
    basis,
    html: `${tl}${rest > 0 ? `<p class="meta tl-rest">Visar de ${fmtInt(shown.length)} leverantörer med flest förnyelser. ${fmtInt(rest)} till har avtal som förnyas inom ${RENEWAL_MONTHS} mån.</p>` : ''}`,
  };
}

// ------------------------------------------------------------ products

function productCards({ facts, category, rows, kommunerTotal }) {
  const cards = [];
  for (const c of companies()) {
    if (c.hiddenInStudio) continue;
    for (const p of c.products) {
      if (p.category !== category) continue;
      const pr = rows.filter((f) => f.product_slugs.includes(p.slug));
      if (!pr.length) continue;
      cards.push({ p, c, kommuner: distinctCount(pr, (f) => f.kommun_kod), dist: priceDistribution(facts, { productSlug: p.slug }), n: byAvtal(pr).length });
    }
  }
  cards.sort((a, b) => b.kommuner - a.kommuner || a.p.name.localeCompare(b.p.name, 'sv'));
  if (!cards.length) return emptyPanel({ title: 'Inga produkter utpekade i avtalen än', text: 'Avtalen i kategorin nämner ingen produkt vi känner igen vid namn.' });
  const shown = cards.slice(0, MAX_CARDS);
  const rest = cards.slice(MAX_CARDS);
  const html = shown.map(({ p, c, kommuner, dist, n }, i) => {
    const share = kommunerTotal > 0 ? kommuner / kommunerTotal : 0;
    const priced = !dist.suppressed && isNum(dist.median);
    return `<article class="card pc is-link" style="--i:${i}">
  <div class="pc-head">
    <h3 class="pc-name"><a href="${esc(productHref(p.slug))}" data-pane-link>${esc(p.name)}</a></h3>
    <span class="viz-n">${esc(fmtInt(n))} avtal</span>
  </div>
  <p class="pc-by">${companyHref(c.slug) ? `<a href="${esc(companyHref(c.slug))}" data-pane-link>${esc(c.canonical)}</a>` : esc(c.canonical)}</p>
  <p class="pc-what">${esc(p.whatItIs)}</p>
  <div class="pc-reach">
    <div class="pc-reach-row"><span class="nowrap"><b>${esc(fmtInt(kommuner))}</b> ${kommuner === 1 ? 'kommun' : 'kommuner'}</span><span class="meta nowrap">${esc(fmtPct(share))} av kategorins</span></div>
    <div class="meter pc-meter" role="img" aria-label="${esc(`${kommuner} av ${kommunerTotal} kommuner`)}"><span class="meter-fill grow-x" style="width:${(share * 100).toFixed(1)}%;--i:${i}"></span></div>
  </div>
  <div class="pc-price${priced ? '' : ' is-unknown hatch'}">
    ${priced
      ? `<span class="pc-price-num">${esc(fmtPrice(dist.median))}</span><span class="pc-price-unit">kr/elev, median</span><span class="meta">mittersta hälften ${esc(fmtPrice(dist.p25))} till ${esc(fmtPrice(dist.p75))}, n = ${esc(fmtInt(dist.n))}</span>`
      : `<span class="pc-price-few">${esc(medianText(dist))}</span><span class="meta">median visas från ${MIN_N} kommuner med känt pris per elev</span>`}
  </div>
</article>`;
  }).join('');
  const restLine = rest.length ? `<p class="meta pc-foot">Fler i kategorin: ${rest.map(({ p, kommuner }) => `<a href="${esc(productHref(p.slug))}" data-pane-link>${esc(p.name)}</a> (${esc(fmtInt(kommuner))})`).join(', ')}.</p>` : '';
  return `<div class="pc-grid is-dense">${html}</div>${restLine}`;
}

// ------------------------------------------------------------ page

export function renderKategori({ category, facts, stats, statusMap, today, page = 1, underlag = null }) {
  const slug = category.slug;
  const label = category.label;
  const lower = label.toLowerCase();
  const all = facts.filter((f) => catOf(f) === slug);
  const rows = headline(all);
  // Avtal counts by avtal_key: a samverkansavtal is one avtal (as on Marknad).
  const avtal = byAvtal(rows);
  const nameOf = kommunNamer(stats, facts);
  const kv = knownValue(rows);
  const kommuner = distinctCount(rows, (f) => f.kommun_kod);
  const shares = companyShares(facts, { category: slug });
  const dist = priceDistribution(facts, { category: slug });
  const leader = shares.find((s) => s.n_known && isNum(s.share_value));
  const tiles = safeTiles();

  const answer = avtal.length
    ? `${nOf(kommuner, 'kommun', 'kommuner')} i vårt underlag har aktiva avtal i ${lower} med ${nOf(shares.length, 'leverantör', 'leverantörer')}${kv.value != null ? `, till ett känt värde av ${fmtKrCompact(kv.value)} per år` : ''}.${leader ? ` Störst är ${leader.name} med ${fmtPct(leader.share_value)} av det kända värdet.` : ''}`
    : `Vi har inga aktiva avtal i ${lower} än. Kartan nedan visar var vi har frågat.`;

  const header = entityHeader({
    kicker: 'Kategori',
    title: label,
    answer,
    facts: [
      { label: 'Känt årsvärde', value: kv.value == null ? null : fmtKrCompact(kv.value), sub: kv.total ? `känt för ${fmtInt(kv.known)} av ${fmtInt(kv.total)} avtal` : 'inga aktiva avtal' },
      { label: 'Kommuner', value: kommuner, unit: `av ${fmtInt(KOMMUNER_TOTAL)}`, sub: 'med minst ett aktivt avtal' },
      { label: 'Median per elev', value: dist.suppressed ? null : fmtPrice(dist.median), unit: dist.suppressed ? '' : 'kr/elev', sub: dist.suppressed ? medianText(dist) : `n = ${fmtInt(dist.n)} kommuner med känt pris` },
    ],
    viz: avtal.length ? shareBar(topThree(facts, slug)) : '',
  });

  const kods = safeAll(stats).map((r) => r.kod);
  const ws = whiteSpots(facts, statusMap, { category: slug, allKods: kods.length ? kods : Object.keys(tiles?.tiles ?? {}), underlag });
  const requested = inRequest(slug);
  const kpis = `<div class="kpi-row">
    ${kpiTile({ label: 'Aktiva avtal', value: avtal.length, unit: 'avtal', basis: `${fmtInt(byAvtal(all).length)} insamlade totalt`, state: avtal.length ? 'known' : 'unknown', reason: 'Inga aktiva avtal i kategorin än.' })}
    ${kpiTile({ label: 'Leverantörer', value: shares.length, unit: 'leverantörer', basis: shares.length ? `${fmtInt(shares.filter((s) => s.slug).length)} i katalogen, ${fmtInt(shares.filter((s) => s.n_known).length)} med känt värde` : '', state: shares.length ? 'known' : 'unknown', reason: 'Inga leverantörer med aktiva avtal än.' })}
    ${kpiTile(renewalTileProps({ avtal, buckets: renewalBuckets(all, { today, months: 12 }), today }))}
    ${kpiTile({ label: 'Utan avtal i underlaget', value: ws.none.length, unit: 'kommuner', basis: wsBasis(ws, { requested, label }), state: 'known' })}
  </div>`;

  // Matrix: SKR huvudgrupp x segment, "Alla" on both axes.
  const on = new Set(rows.flatMap((f) => f.segments));
  const segs = STRIP_SEGMENTS.filter((s) => on.has(s.key));
  const groups = peerGroupKods(stats);
  const mRows = [...groups.map((g) => ({ key: g.key, label: g.label, kods: g.kods })), { key: 'all', label: 'Alla kommuner', kods: null }];
  const mCols = [{ key: '*', label: 'Alla segment' }, ...segs.map((s) => ({ key: s.key, label: s.key }))];
  const matrix = segmentMatrix({
    id: `km-${slug}`,
    rows: mRows,
    cols: mCols,
    rowHead: 'Kommungrupp',
    caption: 'Median per kommungrupp och segment',
    cell: (r, c) => priceDistribution(facts, {
      category: slug,
      ...(c.key === '*' ? {} : { segment: c.key }),
      ...(r.kods ? { kommunKods: r.kods } : {}),
    }),
  });
  const priceBody = `<div class="grid-12">
    <div class="span-12 card">${priceStrip({ facts, filter: { category: slug }, label: `${label}, pris per elev och år`, nameOf })}</div>
    <div class="span-12 card">${matrix}<p class="meta sm-note">En punkt per kommun i varje ruta. Ett avtal som gäller flera segment räknas i varje segment det omfattar.</p></div>
  </div>`;

  const renew = renewalLanes({ rows, today, nameOf });
  const ev = evidenceSection({
    rows: all, today, page, nameOf,
    pageHref: (p) => `/studio/kategori/${encodeURIComponent(slug)}?sida=${p}#underlag`,
  });

  return `${breadcrumb([{ label: 'Kategorier', href: '/studio/kategorier' }, { label }])}
${header}
<section class="section">${kpis}</section>
${section({ id: 'andelar', kicker: 'Andelar', title: `Vem säljer ${lower}`, note: 'aktiva avtal, andel av känt värde och av kommunerna med avtal i kategorin', body: vendorRankings({ facts, category: slug }) })}
${section({ id: 'pris', kicker: 'Pris', title: 'Pris per elev och år', note: 'en punkt per kommun; matrisen visar median per kommungrupp och segment, klicka en ruta för spridning', body: priceBody })}
${section({ id: 'prismodell', kicker: 'Prismodell', title: 'Hur kategorin prissätts', note: 'andel av aktiva avtal per prismodell', body: `<div class="card">${modelMix({ facts, category: slug })}</div>` })}
${section({ id: 'tackning', kicker: 'Täckning', title: `Var underlaget har avtal i ${lower}`, note: `håll över en ruta för namn och insamlingens status; inget avtal i underlaget betyder inte att avtal saknas${requested ? '' : ', och kategorin ingår inte i vår begäran'}`, body: whiteSpotMap({ ws, label, nameOf, tiles, requested }) })}
${section({ id: 'fornyelser', kicker: 'Förnyelser', title: 'Avtal som förnyas eller löper ut, per leverantör', note: renew.basis, body: `<div class="card">${renew.html}</div>` })}
${section({ id: 'produkter', kicker: 'Produkter', title: `Produkter i ${lower}`, note: 'efter antal kommuner med aktivt avtal', body: productCards({ facts, category: slug, rows, kommunerTotal: kommuner }) })}
${section({ id: 'underlag', kicker: 'Underlag', title: 'Avtalen bakom siffrorna', note: `${fmtInt(ev.active)} aktiva, ${fmtInt(ev.old)} utgångna eller ersatta`, body: ev.html })}`;
}

function safeTiles() {
  try { return loadKommunTiles(); } catch { return { cols: 1, rows: 1, tiles: {} }; }
}
