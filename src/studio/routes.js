// Mediagraf Studio routes. Mounted by createDashboardApp behind the same auth
// gate as the back office (operator only). Every handler reads facts through
// getStudioData(), built once and memoised per db + day (with a short TTL so
// newly analysed avtal show up within minutes, not tomorrow).

import { buildStudioFacts, collectionStatus, dataBasis, KOMMUNER_TOTAL } from '../studio-data.js';
import { loadKommunStats } from '../kommun-stats.js';
import { companies } from '../catalogue.js';
import { studioLayout, esc } from './layout.js';
import { fmtInt, fmtPct } from './format.js';

export const STUDIO_DATA_TTL_MS = 5 * 60 * 1000;

export const isPartial = (req) => req.query.partial === '1' || req.get('X-Partial') === '1';

function safe(fn, fallback) {
  try { return fn() ?? fallback; } catch { return fallback; }
}

function buildSearchOptions(stats) {
  const out = [];
  for (const k of safe(() => stats?.all(), [])) if (k.namn) out.push(k.namn);
  for (const c of companies()) {
    if (c.hiddenInStudio) continue;
    out.push(c.canonical);
    for (const p of c.products) if (p.name !== c.canonical) out.push(p.name);
  }
  return out.sort((a, b) => a.localeCompare(b, 'sv'));
}

export function makeStudioData({ db, statsLoader = loadKommunStats, now = () => new Date() }) {
  let memo = null;
  return function getStudioData() {
    const t = now();
    const today = t.toISOString().slice(0, 10);
    const ms = t.getTime();
    if (memo && memo.db === db && memo.today === today && ms - memo.at < STUDIO_DATA_TTL_MS) return memo.data;
    const stats = safe(() => statsLoader(), null);
    const facts = db
      ? buildStudioFacts({
        contracts: db.listContractFacts(),
        lineItems: db.listLineItems(),
        coverage: db.listCoverage(),
        stats,
        today,
      })
      : [];
    const statusMap = collectionStatus(db ? db.listAllConversations() : []);
    const basis = { ...dataBasis(facts, statusMap), updated: today };
    const data = { facts, stats, statusMap, basis, today, searchOptions: buildSearchOptions(stats) };
    memo = { db, today, at: ms, data };
    return data;
  };
}

function cleanPath(req) {
  const u = new URL(req.originalUrl, 'http://studio.local');
  u.searchParams.delete('partial');
  return u.pathname + u.search;
}

// Render a studio page: full shell, or the body only for a pane swap.
export function sendStudio(req, res, data, { title, body, status = 200 }) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8');
  res.send(studioLayout({
    title,
    body,
    currentPath: cleanPath(req),
    partial: isPartial(req),
    basis: data.basis,
    searchOptions: data.searchOptions,
  }));
}

// Placeholder Marknad body until the landing page is built (Task 8).
function renderMarknadPlaceholder({ basis }) {
  const covered = basis.kommuner_with_avtal ?? 0;
  const share = KOMMUNER_TOTAL ? covered / KOMMUNER_TOTAL : null;
  const kpi = (label, num, basisText, extra = '') => `<div class="kpi${extra}">
      <span class="kpi-label">${esc(label)}</span>
      <span class="kpi-value"><span class="kpi-num">${esc(num)}</span></span>
      <span class="kpi-basis">${esc(basisText)}</span>
    </div>`;
  return `<section class="entity-header">
  <div class="entity-grid">
    <div>
      <span class="kicker">Marknad · Skolans digitala verktyg</span>
      <h1 class="page-title">Vad Sveriges kommuner köper, av vem och till vilket pris</h1>
      <p class="lede">Underlaget är ${esc(fmtInt(basis.active))} aktiva avtal från ${esc(fmtInt(covered))} av ${esc(fmtInt(KOMMUNER_TOTAL))} kommuner, begärda som allmänna handlingar och tolkade rad för rad.</p>
    </div>
    <div class="coverage-meter" aria-label="Kommuner med avtal">
      <div class="coverage-meter-head"><span class="kpi-num">${esc(fmtPct(share))}</span><span class="kpi-unit">av kommunerna</span></div>
      <div class="meter"><span class="meter-fill grow-x" style="width:${share == null ? 0 : (share * 100).toFixed(1)}%"></span></div>
      <span class="kpi-basis">${esc(fmtInt(covered))} av ${esc(fmtInt(KOMMUNER_TOTAL))} kommuner har minst ett aktivt avtal hos oss</span>
    </div>
  </div>
</section>
<section class="section">
  <div class="kpi-row">
    ${kpi('Aktiva avtal', fmtInt(basis.active), `av ${fmtInt(basis.collected)} insamlade`)}
    ${kpi('Kommuner med avtal', fmtInt(covered), `av ${fmtInt(KOMMUNER_TOTAL)} kommuner`)}
    ${kpi('Insamling klar', fmtInt(basis.done), `av ${fmtInt(KOMMUNER_TOTAL)} kommuner`)}
    ${kpi('Slutdatum okänt', fmtInt(basis.active_unknown_end), 'räknas som aktiva i fyra år från avtalsstart')}
  </div>
</section>
<section class="section">
  <div class="panel-unknown">
    <strong>Marknadsöversikten byggs.</strong> Kategorier, största leverantörer och förnyelsevågen hamnar här. Under tiden finns underlaget sammanfattat ovan.
  </div>
</section>`;
}

export function mountStudio(app, { db, statsLoader = loadKommunStats, now = () => new Date() } = {}) {
  const getStudioData = makeStudioData({ db, statsLoader, now });

  app.get('/studio', (req, res) => {
    const data = getStudioData();
    sendStudio(req, res, data, { title: 'Marknad', body: renderMarknadPlaceholder(data) });
  });

  return { getStudioData };
}
