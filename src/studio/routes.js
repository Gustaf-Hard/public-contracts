// Mediagraf Studio routes. Mounted by createDashboardApp behind the same auth
// gate as the back office (operator only). Every handler reads facts through
// getStudioData(), built once and memoised per db + day (with a short TTL so
// newly analysed avtal show up within minutes, not tomorrow).

import { buildStudioFacts, collectionStatus, dataBasis, KOMMUNER_TOTAL } from '../studio-data.js';
import { loadKommunStats } from '../kommun-stats.js';
import { companies } from '../catalogue.js';
import { studioLayout, esc } from './layout.js';
import { fmtInt, fmtPct } from './format.js';
import { renderGallery } from './gallery.js';
import { companyBySlug } from '../catalogue.js';
import { renderLeverantor } from './pages/leverantor.js';
import { renderProdukt, findProduct } from './pages/produkt.js';
import { notFound } from './pages/common.js';
import path from 'node:path';
import { existsSync } from 'node:fs';

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

export const UNDERLAG_TYPES = Object.freeze({
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

// Type of a stored avtal file from its stored extension, else its MIME type.
// null for anything outside pdf/docx/xlsx.
export function underlagType({ filename, saved_path, mime_type } = {}) {
  const extOf = (s) => (/\.([a-z0-9]+)$/i.exec(String(s ?? '')) || [])[1]?.toLowerCase() ?? null;
  let ext = extOf(filename) ?? extOf(saved_path);
  if (!ext || !UNDERLAG_TYPES[ext]) {
    const byMime = Object.entries(UNDERLAG_TYPES).find(([, m]) => m === String(mime_type ?? '').toLowerCase());
    ext = byMime ? byMime[0] : null;
  }
  return ext && UNDERLAG_TYPES[ext] ? { ext, mime: UNDERLAG_TYPES[ext] } : null;
}

const pageOf = (req) => Math.max(1, parseInt(req.query.sida, 10) || 1);

export function mountStudio(app, {
  db, statsLoader = loadKommunStats, now = () => new Date(),
  contractsDir = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts',
} = {}) {
  const getStudioData = makeStudioData({ db, statsLoader, now });

  app.get('/studio', (req, res) => {
    const data = getStudioData();
    sendStudio(req, res, data, { title: 'Marknad', body: renderMarknadPlaceholder(data) });
  });

  // Component gallery, hand-written demo data only (never the pilot DB).
  app.get('/studio/_komponenter', (req, res) => {
    const data = getStudioData();
    sendStudio(req, res, data, { title: 'Komponenter', body: renderGallery({ stats: data.stats, today: data.today }) });
  });

  app.get('/studio/leverantor/:slug', (req, res) => {
    const data = getStudioData();
    const company = companyBySlug(req.params.slug);
    if (!company || company.hiddenInStudio) {
      return sendStudio(req, res, data, {
        title: 'Leverantören finns inte', status: 404,
        body: notFound({ what: 'Leverantören finns inte', text: 'Vi känner inte till någon leverantör med den adressen. Sök efter namnet eller gå till listan över leverantörer.' }),
      });
    }
    const body = renderLeverantor({ company, facts: data.facts, stats: data.stats, statusMap: data.statusMap, today: data.today, page: pageOf(req) });
    sendStudio(req, res, data, { title: company.canonical, body });
  });

  app.get('/studio/produkt/:slug', (req, res) => {
    const data = getStudioData();
    const hit = findProduct(req.params.slug);
    if (!hit) {
      return sendStudio(req, res, data, {
        title: 'Produkten finns inte', status: 404,
        body: notFound({ what: 'Produkten finns inte', text: 'Vi känner inte till någon produkt med den adressen. Sök efter namnet eller gå till leverantören.' }),
      });
    }
    const body = renderProdukt({ product: hit.product, company: hit.company, facts: data.facts, stats: data.stats, statusMap: data.statusMap, today: data.today, page: pageOf(req) });
    sendStudio(req, res, data, { title: hit.product.name, body });
  });

  // OPERATOR-ONLY. Serves the source file of a stored avtal, the same file as
  // the back office /attachments/:id, but never its filename (which can carry
  // a person's name). Must be replaced by a redacted or metadata-only view
  // before the studio is opened to anyone outside the auth gate (spec §8).
  // Only pdf, docx and xlsx are served; a PDF opens inline, an Office file
  // downloads, and nosniff stops the browser guessing another type.
  app.get('/studio/underlag/:attachmentId', (req, res) => {
    const id = /^\d+$/.test(req.params.attachmentId) ? Number(req.params.attachmentId) : null;
    if (!db || id == null) return res.status(404).send('Not found');
    const att = db.raw.prepare(`
      SELECT a.id, a.saved_path, a.mime_type, a.filename FROM attachments a
      JOIN contracts c ON c.attachment_id = a.id
      WHERE a.id = ? AND c.is_contract = 1
    `).get(id);
    if (!att) return res.status(404).send('Not found');
    const type = underlagType(att);
    if (!type) return res.status(404).send('Not found');
    const base = path.resolve(contractsDir);
    const full = path.resolve(att.saved_path);
    if (!full.startsWith(base + path.sep) || !existsSync(full)) return res.status(404).send('Not found');
    res.set('Content-Type', type.mime);
    res.set('Content-Disposition', `${type.ext === 'pdf' ? 'inline' : 'attachment'}; filename="avtal-${att.id}.${type.ext}"`);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(full);
  });

  return { getStudioData };
}
