// The follow-up probe list (2026-10-29). "Stämmer det att kommunen inte har
// avtal för något av följande?" asks about every service company in the
// curated catalogue (src/catalogue.js, the single source for this list),
// minus everything we can strike for this kommun:
//
//   1. companies we hold an avtal from (any stored contract row, active or not),
//   2. companies in its purchase rows (bought via Skolon, Atea, Läromedia...)
//      or named in its own documents where the evidence gate accepts the
//      mention (src/coverage.js), since those are known already,
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

import { CATEGORIES, companies, classifyVendor, classifyLine, productBySlug } from './catalogue.js';
import { classifyPurchaseRow } from './purchase-list.js';
import { channelName } from './studio-purchases.js';
import { isNotRequestedMention, isOutOfScopeMention } from './coverage.js';
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

// Which catalogue companies one avtal holds, and the functions it covers for
// each. A channel's avtal holds the companies it resells, never the channel.
function contractHoldings(c) {
  const vendor = blank(c.vendor_name) ? null : classifyVendor(c.vendor_name);
  const ownerSlug = vendor?.slug ?? null;
  const held = new Map(); // slug -> { fns: Set, tagged: bool }
  const hold = (slug) => {
    if (!slug || !isService(slug)) return null;
    if (!held.has(slug)) held.set(slug, { fns: new Set(), tagged: false });
    return held.get(slug);
  };
  if (vendor) hold(vendor.slug);
  else if (!blank(c.vendor_name)) {
    const r = classifyLine(null, c.vendor_name);
    if (OWNER_KINDS.has(r.kind)) hold(r.companySlug);
  }
  for (const name of c.products ?? []) {
    if (blank(name)) continue;
    const r = classifyLine(ownerSlug, name);
    if (!OWNER_KINDS.has(r.kind) || !r.companySlug) continue;
    const h = hold(r.companySlug);
    if (!h) continue;
    const productSlugs = r.kind === 'bundle' ? r.products ?? [] : r.productSlug ? [r.productSlug] : [];
    for (const ps of productSlugs) {
      const fns = productBySlug(ps)?.product?.functions;
      if (!fns) continue;
      h.tagged = true;
      for (const f of fns) h.fns.add(f);
    }
  }
  return [...held].map(([slug, h]) => ({
    slug,
    functions: h.tagged ? [...h.fns] : [...(BY_SLUG.get(slug)?.functions ?? [])],
  }));
}

// The skolformer one avtal covers: its coverage rows plus what its product
// names say. Unknown counts as grundskolan only; coverage rows that name only
// other levels (förskola, komvux) cover neither school form.
function contractForms(c, covRows) {
  const levels = covRows.map((r) => r.grade_level);
  const forms = levelsToForms(levels);
  for (const n of c.products ?? []) for (const f of levelsToForms(mapUnitToGradeLevels(String(n ?? '')))) forms.add(f);
  if (forms.size) return forms;
  return covRows.length ? new Set() : new Set(['grundskola']);
}

function mentionCompanies(m) {
  const out = new Set();
  const vendor = blank(m?.vendor) ? null : classifyVendor(m.vendor);
  if (vendor) out.add(vendor.slug);
  else if (!blank(m?.vendor)) {
    const r = classifyLine(null, m.vendor);
    if (OWNER_KINDS.has(r.kind) && r.companySlug) out.add(r.companySlug);
  }
  if (!blank(m?.product)) {
    const r = classifyLine(vendor?.slug ?? null, m.product);
    if ((r.kind === 'product' || r.kind === 'bundle') && r.companySlug) out.add(r.companySlug);
  }
  return [...out].filter(isService);
}

// Which skolformer the kommun runs schools in, from the kommun-stats snapshot
// (src/kommun-stats.js, elever in kommunal regi). A kommun missing from a
// Skolverket export that loaded fine has no school of that form (false); a
// failed source, or a kommun not in the snapshot, is unknown (null).
const FORM_SOURCES = {
  grundskola: { levels: ['1-3', '4-6', '7-9'], source: 'siris_6_grundskola' },
  gymnasiet: { levels: ['Gymnasiet'], source: 'siris_57_gymnasieskola' },
};
export function skolformerFromStats(stats, kommunKod) {
  const rec = stats?.get?.(String(kommunKod)) ?? null;
  const out = {};
  for (const [form, { levels, source }] of Object.entries(FORM_SOURCES)) {
    if (!rec) { out[form] = null; continue; }
    const vals = levels.map((l) => rec.elever?.[l]);
    if (vals.some((v) => typeof v === 'number' && v > 0)) out[form] = true;
    else if (vals.some((v) => v === 0) && vals.every((v) => v == null || v === 0)) out[form] = false;
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
//   skolformer    { grundskola, gymnasiet }: true when the kommun has elever in
//                 its own schools, false when it has none, null/absent unknown
//                 (skolformerFromStats). False forms are never asked about.
export function buildProbeList({ kommunKod, contracts = [], purchaseRows = [], coverage = [], mentions = [], skolformer = null } = {}) {
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

  // 1 + 3: what this kommun holds, and the functions it covers.
  const held = new Set();
  const covered = new Map(); // fn -> { forms: Set, holders: Set(slug) }
  for (const c of contracts) {
    const holdings = contractHoldings(c);
    for (const h of holdings) seenIn(h.slug, c.kommun_kod);
    if (!own(c)) continue;
    const forms = contractForms(c, covBy.get(c.contract_id) ?? []);
    for (const h of holdings) {
      held.add(h.slug);
      for (const f of h.functions) {
        if (!covered.has(f)) covered.set(f, { forms: new Set(), holders: new Set() });
        const e = covered.get(f);
        for (const x of forms) e.forms.add(x);
        e.holders.add(h.slug);
      }
    }
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
  for (const m of mentions) {
    if (isNotRequestedMention(m) || isOutOfScopeMention(m)) continue;
    for (const slug of mentionCompanies(m)) named.add(slug);
  }

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

// Unreadable stats mean unknown skolformer: the probe keeps asking.
function safeStats() {
  try { return loadKommunStats(); } catch { return null; }
}

// The one IO wrapper: the probe for one kommun read from an open pilot DB
// (src/storage.js). Contracts and purchase rows are fleet-wide so each
// category follows footprint; mentions are the kommun's own, across all its
// conversations (an avtal a handoff conversation delivered is still held).
export function probeFromDb(db, kommunKod, { stats } = {}) {
  return buildProbeList({
    kommunKod,
    contracts: db.listContractFacts(),
    purchaseRows: db.listPurchaseRows(),
    coverage: db.listCoverage(),
    mentions: collectMentions(db.listContractInfoForKommun(kommunKod)),
    skolformer: skolformerFromStats(stats === undefined ? safeStats() : stats, kommunKod),
  });
}
