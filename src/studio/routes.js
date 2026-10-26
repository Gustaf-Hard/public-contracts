// Mediagraf Studio routes. Mounted by createDashboardApp behind the same auth
// gate as the back office (operator only). Every handler reads facts through
// getStudioData(), built once and memoised per db + day (with a short TTL so
// newly analysed avtal show up within minutes, not tomorrow).

import { buildStudioFacts, collectionStatus, dataBasis } from '../studio-data.js';
import { loadKommunStats } from '../kommun-stats.js';
import { companies } from '../catalogue.js';
import { studioLayout } from './layout.js';
import { renderGallery } from './gallery.js';
import { companyBySlug } from '../catalogue.js';
import { renderLeverantor } from './pages/leverantor.js';
import { renderProdukt, findProduct } from './pages/produkt.js';
import { renderKommun, findKommun } from './pages/kommun.js';
import { renderMarknad, renderKategorier } from './pages/marknad.js';
import { renderKategori, findCategory } from './pages/kategori.js';
import { notFound } from './pages/common.js';
import { renderFornyelser, renewalRows, renewalsCsv, parseFornyelserQuery } from './pages/fornyelser.js';
import { renderUtforska, parseUtforskaQuery } from './pages/utforska.js';
import { renderLeverantorer, renderKommuner, renderSearch, exactSearchHit } from './pages/lists.js';
import { renderOm } from './pages/om.js';
import { loadKommunTiles } from './charts.js';
import path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

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
    const statusMap = collectionStatus(db ? db.listAllConversations() : [], { kodsWithAvtal: new Set(facts.map((f) => f.kommun_kod)) });
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
    sendStudio(req, res, data, { title: 'Marknad', body: renderMarknad(data) });
  });

  app.get('/studio/kategorier', (req, res) => {
    const data = getStudioData();
    sendStudio(req, res, data, { title: 'Kategorier', body: renderKategorier(data) });
  });

  app.get('/studio/kategori/:slug', (req, res) => {
    const data = getStudioData();
    const category = findCategory(req.params.slug);
    if (!category) {
      return sendStudio(req, res, data, {
        title: 'Kategorin finns inte', status: 404,
        body: notFound({
          what: 'Kategorin finns inte',
          text: 'Vi känner inte till någon kategori med den adressen. Gå till listan över kategorier.',
          crumb: { label: 'Kategorier', href: '/studio/kategorier' },
        }),
      });
    }
    const body = renderKategori({ category, facts: data.facts, stats: data.stats, statusMap: data.statusMap, today: data.today, page: pageOf(req) });
    sendStudio(req, res, data, { title: category.label, body });
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

  app.get('/studio/kommun/:kod', (req, res) => {
    const data = getStudioData();
    const kommun = findKommun({ kod: req.params.kod, stats: data.stats, facts: data.facts });
    if (!kommun) {
      return sendStudio(req, res, data, {
        title: 'Kommunen finns inte', status: 404,
        body: notFound({
          what: 'Kommunen finns inte',
          text: 'Vi känner inte till någon kommun med den koden. Sök efter kommunens namn eller gå till listan över kommuner.',
          crumb: { label: 'Kommuner', href: '/studio/kommuner' },
        }),
      });
    }
    const body = renderKommun({ kod: kommun.kod, kommun, stats: data.stats, facts: data.facts, statusMap: data.statusMap, today: data.today, page: pageOf(req) });
    sendStudio(req, res, data, { title: kommun.namn, body });
  });

  app.get('/studio/fornyelser', (req, res) => {
    const data = getStudioData();
    const query = parseFornyelserQuery(req.query);
    sendStudio(req, res, data, { title: 'Förnyelser', body: renderFornyelser({ facts: data.facts, stats: data.stats, today: data.today, query, page: pageOf(req) }) });
  });

  app.get('/studio/fornyelser.csv', (req, res) => {
    const data = getStudioData();
    const rows = renewalRows({ facts: data.facts, stats: data.stats, today: data.today, query: parseFornyelserQuery(req.query) });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="fornyelser-${data.today}.csv"`);
    res.set('Cache-Control', 'private, no-store');
    res.send(renewalsCsv(rows));
  });

  app.get('/studio/utforska', (req, res) => {
    const data = getStudioData();
    const query = parseUtforskaQuery(req.query);
    sendStudio(req, res, data, { title: 'Utforska', body: renderUtforska({ facts: data.facts, stats: data.stats, today: data.today, query, page: pageOf(req) }) });
  });

  app.get('/studio/leverantorer', (req, res) => {
    const data = getStudioData();
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 120) : '';
    sendStudio(req, res, data, { title: 'Leverantörer', body: renderLeverantorer({ facts: data.facts, query: { q } }) });
  });

  app.get('/studio/kommuner', (req, res) => {
    const data = getStudioData();
    const tiles = safe(() => loadKommunTiles(), null);
    sendStudio(req, res, data, { title: 'Kommuner', body: renderKommuner({ facts: data.facts, stats: data.stats, statusMap: data.statusMap, tiles, query: req.query }) });
  });

  app.get('/studio/sok', (req, res) => {
    const data = getStudioData();
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const hit = q ? exactSearchHit({ q, stats: data.stats, facts: data.facts }) : null;
    if (hit) return res.redirect(302, isPartial(req) ? `${hit}?partial=1` : hit);
    sendStudio(req, res, data, { title: q ? `Sök: ${q}` : 'Sök', body: renderSearch({ q, stats: data.stats, facts: data.facts }) });
  });

  app.get('/studio/om', (req, res) => {
    const data = getStudioData();
    sendStudio(req, res, data, { title: 'Om datan', body: renderOm({ facts: data.facts, stats: data.stats, statusMap: data.statusMap, basis: data.basis, today: data.today, ttlMs: STUDIO_DATA_TTL_MS }) });
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
    // Canonical paths on both sides: a symlink inside the contracts dir that
    // points outside it must not pass the prefix check.
    let base; let full;
    try {
      base = realpathSync(path.resolve(contractsDir));
      full = realpathSync(path.resolve(att.saved_path));
    } catch {
      return res.status(404).send('Not found');
    }
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
