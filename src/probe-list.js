// The follow-up probe list (2026-10-29). "Stämmer det att kommunen inte har
// avtal för något av följande?" asks about every service company in the
// curated catalogue (src/catalogue.js, the single source for this list),
// minus everything we can strike for this kommun:
//
//   1. companies we hold an avtal from (any stored contract row, active or not),
//   2. companies in its purchase rows (bought via Skolon, Atea, Läromedia...)
//      or named anywhere in a document it sent (documentCompanies: an
//      invoice, a licensbevis, a PUB-avtal, a mention the evidence gate
//      would reject), since those are known already,
//   3. exclusive functions (catalogue-def.js "Probe fields") an avtal already
//      covers: lärplattform, prov and elevhälsojournal per skolform, the
//      skoladministration functions (elevregister, schema, frånvaro, ...)
//      each on its own,
//   4. channels, free public services and companies outside the request are
//      never probed at all.
//
// The list is a question, never a claim: nothing here says an avtal is
// missing. Pure: rows in, plain objects out. Callers pass fleet-wide contracts
// and purchase rows so the per-category order (and the cap) follows each
// company's footprint in our data: the number of kommuner where we have seen it.

import { CATEGORIES, companies, classifyVendor, classifyLine, companiesNamedIn, productBySlug } from './catalogue.js';
import { classifyPurchaseRow } from './purchase-list.js';
import { channelName } from './studio-purchases.js';
import { mapUnitToGradeLevels } from './vendor-analytics.js';
import { loadKommunStats } from './kommun-stats.js';

// At most this many names per line; the rest is "eller liknande".
export const PROBE_CAP = 10;

export const FUNCTION_LABELS = Object.freeze({
  larplattform: 'lärplattform',
  prov: 'digitala prov',
  journal: 'elevhälsojournal',
  incident: 'hantering av kränkande behandling',
  elevregister: 'elevregister',
  schema: 'schema',
  franvaro: 'frånvarohantering',
  barnomsorg: 'barnomsorg och förskoleplacering',
  vuxenutbildning: 'vuxenutbildningens administration',
  kulturskola: 'kulturskolans administration',
  tjanstefordelning: 'tjänstefördelning',
  skolplacering: 'skolplacering',
});

// Functions answered per skolform: a grundskola lärplattform does not settle
// the question for gymnasiet.
const PER_SKOLFORM = new Set(['larplattform', 'prov', 'journal']);
const SKOLFORMER = ['grundskola', 'gymnasiet'];
const SKOLFORM_LABEL = { grundskola: 'grundskolan', gymnasiet: 'gymnasiet' };
const NO_SCHOOL_LABEL = { grundskola: 'grundskola', gymnasiet: 'gymnasieskola' };
const GRUNDSKOLA_LEVELS = new Set(['Förskoleklass', '1-3', '4-6', '7-9']);
const GYMNASIE_LEVELS = new Set(['Gymnasiet', 'Introduktionsprogrammet']);

const SINGLE_OUT = 'binogi'; // never asked about on its own

const blank = (s) => s == null || (typeof s === 'string' && !s.trim());
const OWNER_KINDS = new Set(['product', 'bundle', 'segment', 'unresolved']);

const CATALOGUE = companies();
const ORDER = new Map(CATALOGUE.map((c, i) => [c.slug, i]));
const BY_SLUG = new Map(CATALOGUE.map((c) => [c.slug, c]));
const nameOf = (c) => c.probeName ?? c.canonical;
const isService = (slug) => BY_SLUG.get(slug)?.role === 'service';

function levelsToForms(levels) {
  const out = new Set();
  for (const g of levels) {
    if (GRUNDSKOLA_LEVELS.has(g)) out.add('grundskola');
    if (GYMNASIE_LEVELS.has(g)) out.add('gymnasiet');
  }
  return out;
}

// Free text (a filename, a summary, a product cell) cut into phrases
// classifyLine can read: one company per phrase, so a text naming three
// companies yields three. "/", "+" and "&" cut too (fix wave 3 Q1); a part only
// counts when it resolves to a catalogue company, so "Natur & Kultur" (whose
// parts name nothing) stays one name, read whole.
function phrases(text) {
  if (blank(text)) return [];
  return String(text).replace(/\.(pdf|xlsx|docx|doc|xls)$/i, ' ')
    .split(/[,;:()\n/+&]|\.\s|\s(?:och|samt|eller)\s|\s[-–—]\s/i)
    .map((x) => x.trim()).filter((x) => x.length >= 2);
}

// Every catalogue company a text names, for STRIKING (fix wave 3 Q1: ALL of
// them, not the first). The whole text (a line, a product cell, a mention;
// never a prose summary or filename, `whole: false`, where a product pattern
// can misfire across phrases) and each phrase are classified with the owner
// AND without it, so a line filed under one vendor still strikes the
// other companies it names ("Migrering av data från Draftit" under ProReNata);
// any kind that resolves to a company counts (an integration line, a discount
// line); and every brand or brand-safe product pattern in the text adds its
// company ("Everway Claro"). A probe is a question, so striking too much is
// the safe direction. Memoised: classifyLine is pure and the probe runs per
// draft and per ärende view.
const LINE_MEMO = new Map();
function lineCompanies(ownerSlug, text, { whole = true } = {}) {
  if (blank(text)) return [];
  const str = String(text);
  const key = `${whole ? 1 : 0}${ownerSlug ?? ''}\u0000${str}`;
  const hit = LINE_MEMO.get(key);
  if (hit) return hit;
  const out = new Set();
  const take = (owner, t) => {
    const r = classifyLine(owner, t);
    if (r.kind !== 'uncatalogued' && r.companySlug) out.add(r.companySlug);
  };
  for (const t of new Set([...(whole ? [str] : []), ...phrases(str)])) {
    take(ownerSlug, t);
    if (ownerSlug) take(null, t);
  }
  for (const slug of companiesNamedIn(str)) out.add(slug);
  const res = [...out];
  if (LINE_MEMO.size > 20000) LINE_MEMO.clear();
  LINE_MEMO.set(key, res);
  return res;
}
// A vendor string, for striking: its catalogue match plus every company it
// names ("Everway Claro").
function vendorNamed(raw) {
  if (blank(raw)) return [];
  const v = classifyVendor(raw);
  return [...new Set([...(v ? [v.slug] : []), ...lineCompanies(null, raw)])];
}
// A vendor string, for HOLDING (contractUnits): one owner only, since a held
// unit credits functions.
function vendorCompanies(raw) {
  if (blank(raw)) return [];
  const v = classifyVendor(raw);
  if (v) return [v.slug];
  const r = classifyLine(null, raw);
  return OWNER_KINDS.has(r.kind) && r.companySlug ? [r.companySlug] : [];
}

const productFunctions = (ps) => productBySlug(ps)?.product?.functions;

// Which catalogue companies one avtal holds, as units: one per product it
// names (fix wave 2 P4: functions resolve PER PRODUCT, then unite, so adding a
// tagged sibling never removes what an untagged product covered). An untagged
// product, or a company the avtal names without a product, takes the
// company-level functions; a product tagged with [] covers nothing. A
// channel's avtal holds the companies it resells, never the channel, and
// (P3) an avtal under a channel or an unknown vendor also holds the companies
// its summary and filename name: "Trelson Avtal ... Digitala prov.pdf" filed
// under the reseller is still a Trelson avtal.
function contractUnits(c, lines = []) {
  const vendor = blank(c.vendor_name) ? null : classifyVendor(c.vendor_name);
  const ownerSlug = vendor?.slug ?? null;
  const units = []; // { slug, productSlug, fns: Set, name }
  const companyFns = (slug) => new Set(BY_SLUG.get(slug)?.functions ?? []);
  const add = (slug, productSlug, name) => {
    if (!slug || !isService(slug)) return;
    const tagged = productSlug ? productFunctions(productSlug) : undefined;
    units.push({ slug, productSlug: productSlug ?? null, name: name ?? null, fns: tagged ? new Set(tagged) : companyFns(slug) });
  };
  for (const name of [...(c.products ?? []), ...lines]) {
    if (blank(name)) continue;
    const r = classifyLine(ownerSlug, name);
    if (!OWNER_KINDS.has(r.kind) || !r.companySlug) continue;
    const productSlugs = r.kind === 'bundle' ? (r.products ?? []).filter(Boolean) : r.productSlug ? [r.productSlug] : [];
    if (productSlugs.length) for (const ps of productSlugs) add(r.companySlug, ps, name);
    else add(r.companySlug, null, name);
  }
  const vendorSlugs = vendor ? [vendor.slug] : vendorCompanies(c.vendor_name);
  for (const slug of vendorSlugs) if (!units.some((u) => u.slug === slug)) add(slug, null, null);
  if (!vendor || vendor.role === 'channel') {
    for (const text of [...phrases(c.summary), ...phrases(c.filename)]) {
      // One company per phrase here, not lineCompanies: a held unit credits
      // functions, so only the phrase's own verdict holds.
      const r = classifyLine(null, text);
      const slug = r.kind !== 'uncatalogued' ? r.companySlug : null;
      if (slug && !units.some((u) => u.slug === slug)) add(slug, null, text);
    }
  }
  return units;
}

// The skolformer each unit of one avtal covers. A coverage row that names a
// product (or company) of the avtal covers that unit only (fix wave 2 P5); a
// row that names nothing we can place covers every unit, as before. A unit's
// own product name adds its levels ("Unikum gymnasiet"). A unit no row names
// and whose name gives no level takes the whole avtal (fix wave 3 Q9).
// Unknown counts as grundskolan only; rows that name only other levels (förskola, komvux) cover
// neither school form.
function unitForms(c, covRows, units) {
  const vendor = blank(c.vendor_name) ? null : classifyVendor(c.vendor_name);
  const ownerSlug = vendor?.slug ?? null;
  const named = units.map(() => []);
  const generic = [];
  for (const row of covRows) {
    const r = blank(row.product_name) ? { kind: 'uncatalogued' } : classifyLine(ownerSlug, row.product_name);
    const ps = r.kind === 'bundle' ? (r.products ?? []) : r.productSlug ? [r.productSlug] : [];
    let hit = ps.length ? units.map((u, i) => (ps.includes(u.productSlug) ? i : -1)).filter((i) => i >= 0) : [];
    if (!hit.length && r.companySlug && r.kind !== 'uncatalogued') hit = units.map((u, i) => (u.slug === r.companySlug ? i : -1)).filter((i) => i >= 0);
    if (hit.length) for (const i of hit) named[i].push(row.grade_level);
    else generic.push(row.grade_level);
  }
  const contractLevels = new Set();
  for (const n of c.products ?? []) for (const f of levelsToForms(mapUnitToGradeLevels(String(n ?? '')))) contractLevels.add(f);
  const allLevels = covRows.map((row) => row.grade_level);
  return units.map((u, i) => {
    const own = u.name ? levelsToForms(mapUnitToGradeLevels(String(u.name))) : contractLevels;
    // Fix wave 3 Q9: a unit no coverage row names, and whose own name gives
    // no skolform, takes the whole avtal (every row, every product name):
    // "Digitala prov" in an NE 360 avtal whose rows name only NE 360.
    const whole = !named[i].length && !(u.name && own.size);
    const levels = whole ? allLevels : [...named[i], ...generic];
    const forms = levelsToForms(levels);
    for (const f of whole ? contractLevels : own) forms.add(f);
    if (forms.size) return forms;
    // Rows naming only other levels cover neither school form. In the
    // whole-avtal fallback only the generic rows speak for this unit; rows
    // naming other products ("Stödinsatser Förskola") say nothing about it:
    // unknown, so grundskolan.
    return (whole ? generic.length : levels.length) ? new Set() : new Set(['grundskola']);
  });
}

function mentionCompanies(m) {
  const out = new Set(vendorNamed(m?.vendor));
  const vendor = blank(m?.vendor) ? null : classifyVendor(m.vendor);
  for (const slug of lineCompanies(vendor?.slug ?? null, m?.product)) out.add(slug);
  return [...out].filter(isService);
}

// Every company one document the kommun sent names (fix wave 2 P1): its
// vendor, its products and line items, the analysis's own vendor, products,
// line items (name and description) and mentions (UNFILTERED: the evidence
// gate decides what we may claim is missing, not what we know), its filename
// and its summary. Every text strikes ALL the companies it names (fix wave 3
// Q1, lineCompanies). Any document counts: avtal, faktura, PUB-avtal,
// prislista, licensbevis, följebrev.
export function documentCompanies(d) {
  let a = d?.analysis_json;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
  if (!a || typeof a !== 'object') a = {};
  const out = new Set();
  const vendors = [d?.vendor_name, a.vendor_name].filter((v) => !blank(v));
  for (const v of vendors) for (const slug of vendorNamed(v)) out.add(slug);
  const owner = vendors.map((v) => classifyVendor(v)).find(Boolean)?.slug ?? null;
  const lines = [
    ...(d?.products ?? []), ...(d?.lines ?? []),
    ...(Array.isArray(a.products) ? a.products : []),
    ...(Array.isArray(a.line_items) ? a.line_items.flatMap((l) => [l?.product_name, l?.description]) : []),
  ].filter((x) => typeof x === 'string');
  for (const l of lines) for (const slug of lineCompanies(owner, l)) out.add(slug);
  for (const m of Array.isArray(a.mentioned_agreements) ? a.mentioned_agreements : []) for (const slug of mentionCompanies(m)) out.add(slug);
  for (const t of [d?.filename, d?.summary ?? a.summary]) for (const slug of lineCompanies(null, t, { whole: false })) out.add(slug);
  return [...out].filter(isService);
}

// Which skolformer the kommun runs schools in, from the kommun-stats snapshot
// (src/kommun-stats.js, elever in kommunal regi). A kommun missing from a
// Skolverket export that loaded fine, or below the form's minimum (see
// MIN_GYMNASIE_ELEVER), has no school of that form (false); a
// failed source, or a kommun not in the snapshot, is unknown (null).
// Operator decision 2026-10-29: fewer than this many gymnasieskola elever in
// kommunal regi is most likely introduktionsprogram only, not a gymnasieskola
// with its own lärplattform, so the probe treats it as no school.
export const MIN_GYMNASIE_ELEVER = 50;

const FORM_SOURCES = {
  grundskola: { levels: ['1-3', '4-6', '7-9'], source: 'siris_6_grundskola', min: 1 },
  gymnasiet: { levels: ['Gymnasiet'], source: 'siris_57_gymnasieskola', min: MIN_GYMNASIE_ELEVER },
};
export function skolformerFromStats(stats, kommunKod) {
  const rec = stats?.get?.(String(kommunKod)) ?? null;
  const out = {};
  for (const [form, { levels, source, min }] of Object.entries(FORM_SOURCES)) {
    if (!rec) { out[form] = null; continue; }
    const nums = levels.map((l) => rec.elever?.[l]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (nums.length) out[form] = nums.reduce((a, b) => a + b, 0) >= min;
    else out[form] = stats.data?.sources?.[source]?.status === 'ok' ? false : null;
  }
  return out;
}

// Mentions for buildProbeList out of contract-info rows (is_contract,
// analysis_json): every mentioned_agreements entry, verbatim.
export function collectMentions(rows = []) {
  const out = [];
  for (const r of rows) {
    let a = r?.analysis_json;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    for (const m of a?.mentioned_agreements ?? []) {
      if (!m || blank(m.vendor)) continue;
      out.push({ vendor: m.vendor, product: m.product ?? null, note: m.note ?? null, from_contract: Boolean(r.is_contract) });
    }
  }
  return out;
}

// buildProbeList → { categories: [{ category, label, names, note?, more? }],
//                    struck: [{ name, reason }] }
//
//   contracts     stored avtal rows { contract_id, kommun_kod, vendor_name,
//                 products: [names] }, fleet-wide (footprint) or this kommun's
//   purchaseRows  purchase rows { kommun_kod, supplier, product, channel }
//   coverage      contract_coverage rows { contract_id, grade_level }
//   mentions      THIS kommun's mentions { vendor, product, note }
//   documents     THIS kommun's documents, every contracts row whatever its
//                 type { contract_id, is_contract, vendor_name, analysis_json,
//                 filename, summary, products, lines } (documentCompanies)
//   skolformer    { grundskola, gymnasiet }: true when the kommun has elever in
//                 its own schools, false when it has none, null/absent unknown
//                 (skolformerFromStats). False forms are never asked about.
export function buildProbeList({ kommunKod, contracts = [], purchaseRows = [], coverage = [], mentions = [], documents = [], skolformer = null } = {}) {
  const kod = kommunKod == null ? null : String(kommunKod);
  const own = (r) => kod != null && String(r?.kommun_kod ?? '') === kod;

  const covBy = new Map();
  for (const r of coverage) {
    if (!covBy.has(r.contract_id)) covBy.set(r.contract_id, []);
    covBy.get(r.contract_id).push(r);
  }

  const footprint = new Map(); // slug -> Set(kommun_kod)
  const seenIn = (slug, k) => {
    if (!slug || k == null) return;
    if (!footprint.has(slug)) footprint.set(slug, new Set());
    footprint.get(slug).add(String(k));
  };

  // Line items of this kommun's avtal (the documents carry them).
  const linesBy = new Map();
  for (const d of documents) if (d?.contract_id != null && d.lines?.length) linesBy.set(d.contract_id, d.lines);

  // 1 + 3: what this kommun holds, and the functions it covers.
  const held = new Set();
  const covered = new Map(); // fn -> { forms: Set, holders: Set(slug) }
  for (const c of contracts) {
    const mine = own(c);
    const units = contractUnits(c, mine ? linesBy.get(c.contract_id) ?? [] : []);
    for (const u of units) seenIn(u.slug, c.kommun_kod);
    if (!mine) continue;
    const forms = unitForms(c, covBy.get(c.contract_id) ?? [], units);
    units.forEach((u, i) => {
      held.add(u.slug);
      for (const f of u.fns) {
        if (!covered.has(f)) covered.set(f, { forms: new Set(), holders: new Set() });
        const e = covered.get(f);
        for (const x of forms[i]) e.forms.add(x);
        e.holders.add(u.slug);
      }
    });
  }

  // 2: bought, or named in its own documents.
  const bought = new Map(); // slug -> channel slug | null
  for (const r of purchaseRows) {
    const c = classifyPurchaseRow({ supplier: r.supplier, product: r.product, channel: r.channel ?? r.document_channel ?? null });
    if (!c.company_slug || !isService(c.company_slug)) continue;
    seenIn(c.company_slug, r.kommun_kod);
    if (own(r) && !bought.has(c.company_slug)) bought.set(c.company_slug, c.channel_slug ?? null);
  }
  const named = new Set();
  for (const m of mentions) for (const slug of mentionCompanies(m)) named.add(slug);
  for (const d of documents) for (const slug of documentCompanies(d)) named.add(slug);

  const struck = [];
  const groups = new Map(); // `${category}\u0000${note}` -> { category, note, members: [company] }
  const holderNames = (set) => [...set].sort((a, b) => ORDER.get(a) - ORDER.get(b)).map((s) => nameOf(BY_SLUG.get(s))).join(', ');

  for (const c of CATALOGUE) {
    if (c.role !== 'service' || c.free || c.probe === false || c.hiddenInStudio) continue;
    const category = c.probeCategory ?? c.category;
    if (!category) continue;
    const name = nameOf(c);
    if (held.has(c.slug)) { struck.push({ name, reason: 'avtal finns' }); continue; }
    if (bought.has(c.slug)) {
      const ch = bought.get(c.slug);
      struck.push({ name, reason: ch ? `köpt via ${channelName(ch)}` : 'finns i kommunens inköpslista' });
      continue;
    }
    if (named.has(c.slug)) { struck.push({ name, reason: 'nämns i kommunens underlag' }); continue; }

    let note;
    const primary = c.functions?.[0];
    const cov = primary ? covered.get(primary) : null;
    if (cov) {
      const settled = `${FUNCTION_LABELS[primary] ?? primary} finns redan via ${holderNames(cov.holders)}`;
      if (!PER_SKOLFORM.has(primary)) { struck.push({ name, reason: settled }); continue; }
      // A skolform the kommun runs no schools in is never asked about.
      const run = SKOLFORMER.filter((f) => skolformer?.[f] !== false);
      const open = run.filter((f) => !cov.forms.has(f));
      if (open.length === 0) {
        const none = SKOLFORMER.filter((f) => skolformer?.[f] === false && !cov.forms.has(f));
        struck.push({ name, reason: settled + none.map((f) => `; ingen kommunal ${NO_SCHOOL_LABEL[f]}`).join('') });
        continue;
      }
      if (open.length < run.length) note = `för ${SKOLFORM_LABEL[open[0]]}`;
    }
    const key = `${category}\u0000${note ?? ''}`;
    if (!groups.has(key)) groups.set(key, { category, note, members: [] });
    groups.get(key).members.push(c);
  }

  const size = (slug) => footprint.get(slug)?.size ?? 0;
  const categories = [];
  for (const { slug: category, label } of CATEGORIES) {
    const mine = [...groups.values()].filter((g) => g.category === category)
      .sort((a, b) => (a.note ? 1 : 0) - (b.note ? 1 : 0));
    for (const g of mine) {
      const members = [...g.members].sort((a, b) => (size(b.slug) - size(a.slug)) || (ORDER.get(a.slug) - ORDER.get(b.slug)));
      if (members.length === 1 && members[0].slug === SINGLE_OUT) {
        struck.push({ name: nameOf(members[0]), reason: 'skulle stå ensam i sin kategori' });
        continue;
      }
      const names = members.map(nameOf);
      const entry = { category, label, names: names.slice(0, PROBE_CAP) };
      if (g.note) entry.note = g.note;
      if (names.length > PROBE_CAP) entry.more = names.length - PROBE_CAP;
      categories.push(entry);
    }
  }
  return { categories, struck };
}

// One line per category: "- Läromedel: A, B, C eller liknande". Comma-joined,
// no "och": "A, B eller liknande" is the operator's own wording.
export function renderProbeList(probe) {
  return (probe?.categories ?? [])
    .filter((c) => c?.names?.length)
    .map((c) => `- ${c.label}${c.note ? ` ${c.note}` : ''}: ${c.names.join(', ')}${c.more ? ' eller liknande' : ''}`)
    .join('\n');
}

// The names a drafted probe asks about: every "- Label: A, B eller liknande"
// line of a draft body. Prose is not read, only probe lines.
export function probeNamesInDraft(body) {
  const out = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    const m = /^- [^:]+: (.+)$/.exec(line.trim());
    if (!m) continue;
    for (const n of m[1].replace(/ eller liknande$/, '').split(', ')) if (n.trim()) out.push(n.trim());
  }
  return out;
}

// Fix wave 2 P7: a draft's probe is a snapshot; the probe now may have struck
// names the draft still asks about (a newer delivery, a purchase list). Which
// of the draft's names the CURRENT probe strikes, with the reason.
export function struckSinceDraft(probe, bodies = []) {
  const reasons = new Map((probe?.struck ?? []).map((x) => [x.name, x.reason]));
  const seen = new Set();
  const out = [];
  for (const b of bodies) {
    for (const name of probeNamesInDraft(b)) {
      if (seen.has(name) || !reasons.has(name)) continue;
      seen.add(name);
      out.push({ name, reason: reasons.get(name) });
    }
  }
  return out;
}

// Unreadable stats mean unknown skolformer: the probe keeps asking.
function safeStats() {
  try { return loadKommunStats(); } catch { return null; }
}

// The one IO wrapper: the probe for one kommun read from an open pilot DB
// (src/storage.js). Contracts and purchase rows are fleet-wide so each
// category follows footprint; documents are the kommun's own, every one it
// sent across all its conversations (an avtal a handoff conversation
// delivered is still held).
export function probeFromDb(db, kommunKod, { stats } = {}) {
  return buildProbeList({
    kommunKod,
    contracts: db.listContractFacts(),
    purchaseRows: db.listPurchaseRows(),
    coverage: db.listCoverage(),
    documents: db.listProbeDocumentsForKommun(kommunKod),
    skolformer: skolformerFromStats(stats === undefined ? safeStats() : stats, kommunKod),
  });
}
