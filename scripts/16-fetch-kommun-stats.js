// Fetch kommun open data and build the tile grid.
//   node scripts/16-fetch-kommun-stats.js
// Writes data/kommun-stats/kommun-stats.json and public/geo/kommun-tiles.json.
// Sources (all open): Skolverket SIRIS exports 6 and 57, Skolverket PxWeb
// (komvux), Kolada v3 (förskola, förskoleklass, kommungrupp, peers), Wikidata
// (centroids). A failed source leaves its fields null and is recorded with
// status "failed"; nothing is ever invented.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { politeFetch } from '../src/http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_STATS = path.join(ROOT, 'data/kommun-stats/kommun-stats.json');
const OUT_TILES = path.join(ROOT, 'public/geo/kommun-tiles.json');

const START_YEAR = 2025; // läsår 2025/26, mätt 15 oktober 2025
const LAAR = '2025/26';
const SIRIS = 'https://siris.skolverket.se/siris/reports/export_api/runexport/';
const KOLADA = 'https://api.kolada.se/v3';
const PX = 'https://statistikdatabasen.skolverket.se/PxWeb/api/v1/sv/Skolverkets_statistikdatabas/Kommunala_jamforelsetal/Komvux/Elever_och_kursdeltagare/Komvux_grundlaggande_och_gymnasial/Komvux_grund_gymnasial_elever_kursdeltagare.px';
const WDQS = 'https://query.wikidata.org/sparql';
const GRUPP_IDS = [92786, 92787, 92788, 92789, 92790, 92791, 92792, 92793, 92794].map((n) => `G${n}`);

export const GRADES = ['Förskola', 'Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'];

// ---------- pure helpers (exported for reuse) ----------

// SIRIS cell -> { n, masked }. "." = no such grade/missing, ".." = masked (<5).
export function parseCell(v) {
  if (v == null) return { n: null, masked: false };
  const s = String(v).replace(/[\s ]/g, '');
  if (s === '..') return { n: null, masked: true };
  if (s === '.' || s === '') return { n: null, masked: false };
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? { n, masked: false } : { n: null, masked: false };
}

// Project centroids onto a cols x rows grid, big kommuner keep their cell,
// the rest take the nearest free cell. Deterministic.
export function buildTiles(points, { cols = 18, rows = 32 } = {}) {
  const lons = points.map((p) => p.lon);
  const lats = points.map((p) => p.lat);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const ideal = (p) => ({
    x: ((p.lon - lonMin) / (lonMax - lonMin)) * (cols - 1),
    y: ((latMax - p.lat) / (latMax - latMin)) * (rows - 1),
  });
  const order = [...points].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.kod.localeCompare(b.kod));
  const taken = new Map();
  const tiles = {};
  let displacement = 0;
  for (const p of order) {
    const t = ideal(p);
    let best = null;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (taken.has(`${x},${y}`)) continue;
        const d = (x - t.x) ** 2 + (y - t.y) ** 2;
        if (!best || d < best.d || (d === best.d && (y < best.y || (y === best.y && x < best.x)))) best = { x, y, d };
      }
    }
    if (!best) throw new Error('grid too small');
    taken.set(`${best.x},${best.y}`, p.kod);
    tiles[p.kod] = { x: best.x, y: best.y };
    displacement += Math.sqrt(best.d);
  }
  return { cols, rows, tiles, meanDisplacement: displacement / points.length };
}

// ---------- network ----------

async function getJson(url, opts = {}) {
  const res = await politeFetch(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  // SIRIS puts raw newlines inside JSON strings; they are whitespace elsewhere.
  const text = (await res.text()).replace(/[\r\n]+/g, ' ');
  return JSON.parse(text);
}

async function koladaPaged(url) {
  const out = [];
  let next = url;
  while (next) {
    const j = await getJson(next);
    out.push(...j.values);
    next = j.next_url;
  }
  return out;
}

const sources = {};
function mark(key, url, status, extra = {}) {
  sources[key] = { url, status, ...extra };
}

async function guarded(key, url, fn) {
  try {
    const r = await fn();
    mark(key, url, 'ok');
    return r;
  } catch (e) {
    console.error(`FAILED ${key}: ${e.message}`);
    mark(key, url, 'failed', { error: String(e.message).slice(0, 200) });
    return null;
  }
}

async function fetchGrundskola(codes) {
  const url = `${SIRIS}?pFormat=json&pExportID=6&pAr=${START_YEAR}`;
  const j = await getJson(url);
  const acc = {}; // kod -> { '1-3': n, ..., masked: n }
  for (const row of j.data) {
    const s = row.skola;
    const kod = s['Kommun-kod'];
    if (!codes.has(kod)) continue;
    acc[kod] ??= { '1-3': 0, '4-6': 0, '7-9': 0, masked: 0 };
    if (s['Typ av huvudman'] !== 'Kommunal') continue;
    for (let g = 1; g <= 9; g++) {
      const { n, masked } = parseCell(s[`Elever, årskurs ${g}`]);
      const band = g <= 3 ? '1-3' : g <= 6 ? '4-6' : '7-9';
      if (n != null) acc[kod][band] += n;
      if (masked) acc[kod].masked += 1;
    }
  }
  return acc;
}

async function fetchGymnasium(codes) {
  const url = `${SIRIS}?pFormat=json&pExportID=57&pAr=${START_YEAR}`;
  const j = await getJson(url);
  const out = {};
  for (const row of j.data) {
    const r = row.kommun;
    if (!codes.has(r['Kommun-kod']) || r['Typ av huvudman'] !== 'Kommunal') continue;
    const { n } = parseCell(r['Antal elever']);
    if (n != null) out[r['Kommun-kod']] = n;
  }
  return out;
}

async function fetchKolada(kpi) {
  const rows = await koladaPaged(`${KOLADA}/data/kpi/${kpi}/year/${START_YEAR}?per_page=2000`);
  const out = {};
  for (const r of rows) {
    const v = r.values?.find((x) => x.gender === 'T' && !x.isdeleted && typeof x.value === 'number');
    if (v) out[r.municipality] = v.value;
  }
  return out;
}

async function fetchKomvux(codes) {
  const body = {
    query: [
      { code: 'variable', selection: { filter: 'item', values: ['0', '6'] } },
      { code: 'time', selection: { filter: 'item', values: [String(START_YEAR)] } },
    ],
    response: { format: 'json' },
  };
  const res = await politeFetch(PX, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${PX}`);
  const j = JSON.parse(await res.text());
  // data: [{ key:[variable, level, time], values:[v] }]
  const by = {};
  for (const d of j.data) {
    const lvl = d.key[1];
    if (!codes.has(lvl)) continue;
    const { n } = parseCell(d.values[0]);
    by[lvl] ??= { sum: 0, seen: 0 };
    if (n != null) { by[lvl].sum += n; by[lvl].seen += 1; }
  }
  const out = {};
  // Both levels present, else the sum would understate.
  for (const [k, v] of Object.entries(by)) if (v.seen === 2) out[k] = v.sum;
  if (Object.keys(out).length < 200) throw new Error(`komvux: only ${Object.keys(out).length} kommuner`);
  return out;
}

async function fetchGrupper() {
  const out = {};
  for (const id of GRUPP_IDS) {
    const j = await getJson(`${KOLADA}/municipality_groups/${id}`);
    const g = j.values[0];
    const name = g.title.replace(/\s*\(ovägt medel\)\s*$/, '');
    for (const m of g.members) out[m.member_id] = name;
  }
  if (Object.keys(out).length < 250) throw new Error(`only ${Object.keys(out).length} kommungrupp members`);
  return out;
}

async function fetchKoladaNames() {
  const rows = await koladaPaged(`${KOLADA}/municipality?per_page=400`);
  const out = {};
  for (const r of rows) if (r.type === 'K') out[r.id] = r.title;
  if (Object.keys(out).length < 280) throw new Error('kolada municipality list incomplete');
  return out;
}

async function fetchPeers(nameToKod) {
  const rows = await koladaPaged(`${KOLADA}/municipality_groups?title=${encodeURIComponent('Liknande kommuner grundskola')}&per_page=500`);
  const out = {};
  for (const g of rows) {
    const m = g.title.match(/^Liknande kommuner grundskola, (.+), (\d{4})$/);
    if (!m) continue;
    const kod = nameToKod.get(m[1]);
    if (!kod) continue;
    out[kod] = g.members.map((x) => x.member_id);
  }
  return out;
}

async function fetchCentroids(codes) {
  const q = 'SELECT ?kod ?c WHERE { ?i wdt:P31 wd:Q127448; wdt:P525 ?kod; wdt:P625 ?c . }';
  const url = `${WDQS}?query=${encodeURIComponent(q)}`;
  const j = await getJson(url, { headers: { Accept: 'application/sparql-results+json' } });
  const out = {};
  for (const b of j.results.bindings) {
    const kod = b.kod.value;
    const m = b.c.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (m && codes.has(kod)) out[kod] = { lon: Number(m[1]), lat: Number(m[2]) };
  }
  return out;
}

// ---------- main ----------

async function main() {
  const muni = JSON.parse(readFileSync(path.join(ROOT, 'data/municipalities.json'), 'utf8'));
  const codes = new Set(muni.map((m) => m.kommun_kod));
  // municipalities.json names lost a trailing s in the genitive pass (Falu,
  // Hällefor), so Kolada's own names drive the title match and the display name.
  const names = await guarded('kolada_municipality_names', `${KOLADA}/municipality`, fetchKoladaNames);
  const nameToKod = new Map(Object.entries(names ?? {}).map(([k, n]) => [n, k]));

  const grund = await guarded('siris_6_grundskola', `${SIRIS}?pExportID=6&pAr=${START_YEAR}`, () => fetchGrundskola(codes));
  const gymn = await guarded('siris_57_gymnasieskola', `${SIRIS}?pExportID=57&pAr=${START_YEAR}`, () => fetchGymnasium(codes));
  const forskola = await guarded('kolada_N11730_forskola', `${KOLADA}/data/kpi/N11730/year/${START_YEAR}`, () => fetchKolada('N11730'));
  const fklass = await guarded('kolada_N11805_forskoleklass', `${KOLADA}/data/kpi/N11805/year/${START_YEAR}`, () => fetchKolada('N11805'));
  const komvux = await guarded('pxweb_komvux', PX, () => fetchKomvux(codes));
  const grupper = await guarded('kolada_kommungrupper', `${KOLADA}/municipality_groups/${GRUPP_IDS[0]}..${GRUPP_IDS.at(-1)}`, fetchGrupper);
  const peers = await guarded('kolada_liknande_kommuner_grundskola', `${KOLADA}/municipality_groups?title=Liknande kommuner grundskola`, () => fetchPeers(nameToKod));
  const cent = await guarded('wikidata_centroids', WDQS, () => fetchCentroids(codes));

  const kommuner = {};
  for (const m of muni) {
    const k = m.kommun_kod;
    const g = grund?.[k];
    kommuner[k] = {
      namn: names?.[k] ?? m.kommun_namn,
      lan: m.lan,
      folkmangd: m.folkmangd ?? null,
      kommungrupp: grupper?.[k] ?? null,
      peers: peers?.[k] ?? [],
      elever: {
        'Förskola': forskola?.[k] ?? null,
        'Förskoleklass': fklass?.[k] ?? null,
        '1-3': g ? g['1-3'] : null,
        '4-6': g ? g['4-6'] : null,
        '7-9': g ? g['7-9'] : null,
        'Gymnasiet': gymn?.[k] ?? null,
        'Komvux': komvux?.[k] ?? null,
      },
      // grundskola cells under 5 pupils are masked by Skolverket; sums are lower bounds
      grundskola_masked_cells: g ? g.masked : null,
    };
  }

  // tiles
  let tileInfo = null;
  if (cent) {
    const missing = muni.filter((m) => !cent[m.kommun_kod]).map((m) => m.kommun_kod);
    if (missing.length) {
      mark('wikidata_centroids', WDQS, 'failed', { error: `no centroid for ${missing.join(',')}` });
      console.error(`FAILED tiles: no centroid for ${missing.join(',')}`);
    } else {
      const pts = muni.map((m) => ({ kod: m.kommun_kod, ...cent[m.kommun_kod], weight: m.folkmangd ?? 0 }));
      const t = buildTiles(pts);
      mkdirSync(path.dirname(OUT_TILES), { recursive: true });
      writeFileSync(OUT_TILES, JSON.stringify({ cols: t.cols, rows: t.rows, tiles: t.tiles }) + '\n');
      tileInfo = `${Object.keys(t.tiles).length} tiles on ${t.cols}x${t.rows}, mean displacement ${t.meanDisplacement.toFixed(2)} cells`;
    }
  }

  // single write, after tiles so a tile failure is recorded in sources
  const stats = { fetched_at: new Date().toISOString(), sources, laar: LAAR, kommuner };
  mkdirSync(path.dirname(OUT_STATS), { recursive: true });
  writeFileSync(OUT_STATS, JSON.stringify(stats, null, 1) + '\n');

  // summary
  const all = Object.values(kommuner);
  console.log(`kommuner: ${all.length}`);
  for (const g of GRADES) console.log(`  elever ${g}: ${all.filter((r) => r.elever[g] != null).length}/${all.length}`);
  console.log(`  kommungrupp: ${all.filter((r) => r.kommungrupp).length}/${all.length}`);
  console.log(`  peers: ${all.filter((r) => r.peers.length).length}/${all.length}`);
  console.log(`  tiles: ${tileInfo ?? 'NOT WRITTEN'}`);
  for (const [k, v] of Object.entries(sources)) console.log(`  source ${k}: ${v.status}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
