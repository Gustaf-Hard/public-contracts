// Studio catalogue: reads raw vendor and product-line names into company,
// product, add-on, discount, segment or noise. Pure and read-time only (the
// only IO is the committed kommun list, read once at load). The definition is
// src/catalogue-def.js; the rules are catalogue.md "Regler, i den ordning de
// körs", ported from docs/research/studio-2026-10-26/build.mjs. The back office
// keeps using src/vendor-kb.js.

import fs from 'node:fs';
import { COMPANIES, MINOR_BRANDS } from './catalogue-def.js';

export const CATEGORIES = [
  { slug: 'laromedel', label: 'Läromedel' },
  { slug: 'larplattform', label: 'Lärplattform' },
  { slug: 'skoladministration', label: 'Skoladministration' },
  { slug: 'prov', label: 'Prov och bedömning' },
  { slug: 'stodverktyg', label: 'Stödverktyg' },
  { slug: 'elevhalsa', label: 'Elevhälsa' },
  { slug: 'ovrigt', label: 'Övrigt' },
];

// Research taxonomy (catalogue-def.js) -> studio category slug. Channels
// without own products have no category (null).
const STUDIO_CATEGORY = {
  'läromedel': 'laromedel',
  'lärplattform': 'larplattform',
  'skoladministration': 'skoladministration',
  'prov': 'prov',
  'bedömning': 'prov',
  'stödverktyg': 'stodverktyg',
  'elevhälsa': 'elevhalsa',
  'övrigt': 'ovrigt',
  'integration': 'ovrigt',
  'utbildningsanordnare': 'ovrigt',
  'offentlig aktör': 'ovrigt',
};
const studioCategory = (c) => (c == null ? null : STUDIO_CATEGORY[c] ?? 'ovrigt');

export const normName = (s) => String(s ?? '').toLowerCase()
  .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/ü/g, 'u').replace(/æ/g, 'ae').replace(/ø/g, 'o')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const N = normName;
const slugify = (s) => N(s).replace(/ /g, '-');

// ---------------- indexes ----------------
const BY_VENDOR = new Map();
for (const c of COMPANIES) for (const v of c.vendors) BY_VENDOR.set(v, c);
const BY_SLUG_DEF = new Map(COMPANIES.map((c) => [c.slug, c]));
const PRODUCT_SLUG = new Map(); // product name -> slug
for (const c of COMPANIES) for (const p of c.products) {
  if (PRODUCT_SLUG.has(p.name)) throw new Error(`catalogue: duplicate product ${p.name}`);
  PRODUCT_SLUG.set(p.name, slugify(p.name));
}

// Public, regex-free view of the catalogue.
const PUBLIC = COMPANIES.map((c) => Object.freeze({
  slug: c.slug,
  canonical: c.canonical,
  role: c.role,
  category: studioCategory(c.category),
  website: c.website ?? null,
  ...(c.note ? { note: c.note } : {}),
  products: Object.freeze(c.products.map((p) => Object.freeze({
    slug: PRODUCT_SLUG.get(p.name),
    name: p.name,
    category: studioCategory(p.category),
    whatItIs: p.what_it_is,
    ...(p.editions ? { editions: Object.freeze([...p.editions]) } : {}),
    ...(p.functions ? { functions: Object.freeze([...p.functions]) } : {}),
  }))),
  ...(c.singleProduct ? { singleProduct: c.singleProduct } : {}),
  ...(c.defaultProduct ? { defaultProduct: c.defaultProduct } : {}),
  ...(c.hiddenInStudio ? { hiddenInStudio: true } : {}),
  // Probe fields (catalogue-def.js "Probe fields", read by src/probe-list.js).
  ...(c.probeName ? { probeName: c.probeName } : {}),
  ...(c.functions ? { functions: Object.freeze([...c.functions]) } : {}),
  ...(c.free ? { free: true } : {}),
  ...(c.probe === false ? { probe: false } : {}),
  ...(c.probeCategory ? { probeCategory: c.probeCategory } : {}),
}));
const PUBLIC_BY_SLUG = new Map(PUBLIC.map((c) => [c.slug, c]));
if (PUBLIC_BY_SLUG.size !== PUBLIC.length) throw new Error('catalogue: duplicate company slug');
const PRODUCT_BY_SLUG = new Map();
for (const company of PUBLIC) for (const product of company.products) {
  if (PRODUCT_BY_SLUG.has(product.slug)) throw new Error(`catalogue: duplicate product slug ${product.slug}`);
  PRODUCT_BY_SLUG.set(product.slug, { product, company });
}

export function companies() { return PUBLIC; }
export function companyBySlug(slug) { return PUBLIC_BY_SLUG.get(slug); }
export function productBySlug(slug) { return PRODUCT_BY_SLUG.get(slug); }

// Kommun names are stripped from lines ("Polyglutt Ale kommun") before the
// segment test. municipalities.json is committed Phase-1 open data.
const KOMMUN = JSON.parse(fs.readFileSync(new URL('../data/municipalities.json', import.meta.url), 'utf8'))
  .map((k) => N(k.kommun_namn)).filter(Boolean);
const KOMMUN_RE = new RegExp(`\\b(${KOMMUN.sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

// ---------------- word lists (verbatim from build.mjs) ----------------
const VUX_RE = /vuxenutbildning|svenska for invandrare|\bsfi\b|yrkesutbildning|grundlaggande|gymnasial|gymnasieniva|komvux/;
const DISCOUNT = /rabatt|\bavdrag\b|kostnadsfri|\bgratis\b|kreditering|avrakning/;
const LICENCE_WORD = /licens|abonnemang|arsavgift|prenumeration|subscription|nyttjanderatt|arlig kostnad/;
const GENERIC_ADDON = new RegExp('\\b(' + [
  'inforande\\w*', 'implementer\\w*', 'implementation\\w*', 'uppstart\\w*', 'startavgift', 'startkostnad', 'etablering\\w*', 'setup', 'set up',
  'installation\\w*', 'grundinstallation\\w*', 'inlasning av data', 'filtransport', 'utbildningspaket', 'temautbildning\\w*', 'uppsattning', 'konfigur\\w*', 'applikationskonfiguration', 'utbildning(ar|en|sdag(ar)?|sinsatser|stjanster)?', 'grundutbildning\\w*',
  'distansutbildning', 'workshop', 'e learning', 'online utbildning', 'on line utbildning', 'kurs', 'uppstartskurs', 'grundkurs', 'uppfoljningskurs', 'heldagsutbildning', 'halvdagsutbildning',
  'konsult\\w*', 'datakonsulttjanster', 'timpris', 'timkostnad', 'per timme', 'projektledning', 'projekt\\w*', 'processledning', 'processtod', 'radgivning', 'licensradgivning', 'licenshantering', 'licensrevision',
  'support\\w*', 'kundsupport', 'customer success', 'service fee', 'serviceavtal', 'sla', 'underhall\\w*', 'forvaltning\\w*', 'drift\\w*', 'systemdrift', 'serverdrift', 'asp', 'hosting',
  'molntjanst', 'lagring', 'backup', 'migrering\\w*', 'konvertering', 'overforing', 'import', 'export', 'integration\\w*', 'integrations', 'integrer\\w*', 'api',
  'synk\\w*', 'provisionering', 'sso', 'single sign on', 'idp', 'saml', 'bankid', 'mobilt bankid', 'e legitimation', 'e legitimationsinlogg', 'inloggning\\w*', 'autentisering', 'koppling',
  'sms\\w*', 'inkommande sms', 'testmiljo', 'arkiv\\w*', 'gallring\\w*', 'avveckling\\w*', 'leveranskontroll', 'anpassning', 'kundanpassning', 'utvecklingsarbete', 'forstudie',
  'teknikstod', 'teknikinstallation\\w*', 'tekniskt', 'applikationsteam', 'plastning', 'flytt', 'leverans', 'grundkostnad', 'sam tjanst', 'sam system', 'csp support', 'navet',
  'utbildningsdag', 'uppstartsdag', 'tillhorande konsulttjanster', 'produktnara tjanster', 'licenspartner\\w*', 'it tjanster', 'it partner', 'programforsorjning',
].join('|') + ')\\b');
const GENERIC_ADDON_HEAD = new RegExp('^' + GENERIC_ADDON.source);
const SERVICE_WORD_HEAD = /^(integration|integrering|inforande|implementer|implementation|utbildning|support|migrering|uppstart|setup|installation)/;
const HARDWARE = /dator|chromebook|surfplatt|\bipad\b|skarm|smartphone|tillbehor|mediaspelare|\bmacos\b|hardvara|arbetsstation|utrustning|enheter\b|leasing|\bmdm\b|utskrift|gemensam utrustning|kommunikation$/;
const GENERIC_DESC = /larplattform|\blms\b|learning management|elevadministr|skoladministr|elevregister|barn (och )?elev|verksamhetssystem|it stod|systemstod|administrationssystem|administrativ|journalsystem|laromedel|digitala prov|provverktyg|provplattform|schemalaggning|\bschema|narvaro|program(vara|varor|mvaru)|molntjanster|licenser|saas|tjansten|systemet|^system$|plattform|digitala verktyg|stodverktyg|produkter|tjanster|losningen|beslutsstod|bibliotekssystem|webbplatssystem|mediekatalog|mediecenter|litteratur|digital arbetsplats|infrastruktur|volymlicens|skolplattform|skapandeverktyg|filmpedagogbloggen|\bsystem\b|e laromedel|talsyntes|vardnadshavare|ovriga|ovrigt|^ansokan|^betyg$|e tjanst|mallar$/;
const VENDORLESS_NOISE = /modul|lararhandledning|\bprao\b|nationella prov|folkbokforing|barnadministration|arskostnad|avtalssamverkan/;
const SEG_WORDS = new RegExp('\\b(' + [
  'forskoleklass', 'forskola(n)?', 'forskolor', 'fsk', 'f klass', 'fritidshem(met)?', 'fritids', 'grundskola(n)?', 'grundskolor', 'grundsarskola', 'gr', 'gy', 'gymnasie(skola(n)?|t|t)?', 'gymnasieskolor', 'gymnasium', 'gymnasiet', 'gymnasial', 'gymnasienivå', 'gymnasieniva', 'gymnasieutbildning',
  'vux', 'vuxenutbildning(en)?', 'vuxna', 'komvux', 'sfi', 'svenska for invandrare', 'utbildning i svenska for invandrare', 'grundlaggande', 'yrkesutbildning', 'distansutbildning', 'distans', 'im', 'introduktionsprogrammet', 'anpassad(e)?', 'sarskola', 'ak', 'arskurs', 'ar', 'k12', 'hogskola', 'skolform(er)?', 'samtliga',
  'skola', 'skolor', 'skolan', 'skolornas', 'elever', 'elev', 'larare', 'personal', 'pedagog(er)?', 'staff', 'students?', 'faculty', 'tutor', 'barn', 'deltagare', 'kommunal(a)?', 'centralt',
  'kommunlicens(en)?', 'huvudmann?a?s?licens(en)?', 'verksamhetslicens', 'skollicens(er)?', 'elevlicens(er)?', 'lararlicens(er)?', 'pedagoglicens', 'standardlicens', 'grundlicens', 'baslicens', 'plattformslicens', 'platformlicens', 'platform license', 'sitelicens', 'singellicens', 'klasslicens', 'arslicens', 'terminlicens', 'eht licens', 'anvandarlicens(er)?', 'enskild licens', 'licens(er|en|avgift|kostnad|pris|bevis)?', 'license', 'licences', 'subscriptions?', 'abonnemang(et)?', 'kommunabonnemang', 'pilotabonnemang', 'prenumeration\\w*', 'medicinsk', 'icke medicinsk', 'hsl', 'eht', 'ej',
  'arsavgift', 'abonnemangsavgift', 'tjanst', 'tjansten', 'arlig(t)?', 'arskostnad', 'manadskostnad', 'manadsavgift', 'paketpris', 'systemkostnad', 'kostnad', 'avgift', 'pris', 'nyttjande', 'nyttjanderattsavgift', 'start', 'bas', 'basic', 'small', 'medium', 'large', 'xs', 'upp', 'max', 'antal',
  'man', 'manader', 'manaders', 'dagar', 'per', 'user', 'site', 'anvandare', 'anvandartyp', 'annual', 'tre', 'ars', 'avtal', 'option', 'inkl', 'inklusive', 'for', 'och', 'med', 'av', 'i', 'till', 'samt', 'pa', 'om', 'enligt', 'avseende', 'mot',
  'digital', 'digitalt', 'digitala', 'webb', 'lararwebb', 'grundbok', 'lararhandledning', 'lararstod', 'elevpaket', 'lararpaket', 'tryckt', 'bok', 'kommun', 'kommunen', 'kommuner', 'alla', 'amnen', 'ett', 'en', 'helhetslosning', 'paket', 'allmanna', 'kurser', 'nivå', 'niva', 'fast', 'rorlig', 'nya', 'endast',
  'auktorisation', 'auktorisationsavtal', 'auktorisationssystem', 'vux norrort', 'norrort', 'kommunlicenser', 'licensavgift', 'sprakavtal', 'las och skrivavtal', 'normalavtal', 'campus och school avtal', 'enrollment for education solutions', 'ees', 'enterprise registrering', 'indirekt', 'software assurance', 'eas avtal', 'csp avtal', 'lsp', 'enterprise tillagg', 'enterprise', 'onlinetjanster', 'utbildningsplattformsprodukter', 'option', 'standard', 'sektor', 'omsorg', 'utbildningsforvaltningen', 'grundskoleforvaltningen', 'kunskapsforvaltningen', 'forvaltningen',
  'personal for dokumentation', 'arbete', 'elevjournal', 'anvandarkonto', 'skolskoterska', 'skollakare', 'psykolog', 'logoped', 'lararlicenser', 'elevlicenser',
].join('|') + ')\\b', 'g');
const stripSeg = (n) => n.replace(KOMMUN_RE, ' ').replace(/\b\w+skola(n)?\b|\b\w+skolan\b|\b\w+gymnasiet\b/g, ' ').replace(SEG_WORDS, ' ').replace(/\b[a-z]\b|\b\d+\b|\b[fk] \d+\b/g, ' ').replace(/\s+/g, ' ').trim();

// ---------------- vendor ----------------
function vendorCompany(raw) {
  if (raw == null) return null;
  const n = N(raw);
  const k = n.replace(/\b(sverige ab|aktiebolag|sverige|ab)$/, '').trim();
  return BY_VENDOR.get(n) ?? BY_VENDOR.get(k) ?? null;
}

// Rule 1: raw vendor name -> catalogue company, or null when uncatalogued.
export function classifyVendor(raw) {
  const c = vendorCompany(raw);
  return c ? { slug: c.slug, canonical: c.canonical, role: c.role, category: studioCategory(c.category) } : null;
}

// ---------------- product matching ----------------
function matchProducts(n, products, useLocal) {
  const pass = (useM) => {
    let rest = n; const hits = [];
    for (const p of products) {
      const re = useM ? p.m : p.local;
      if (!re) continue;
      const m = rest.trim() ? rest.match(re) : null;
      // Mask the matched text so a line naming two products becomes a bundle.
      if (m) { hits.push({ p, idx: m.index, text: m[0].trim() }); rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length); }
    }
    return hits;
  };
  let hits = pass(true);
  if (!hits.length && useLocal) hits = pass(false);
  if (hits.length > 1 && !/\b(och|inkl|inklusive|samt|plus)\b|[/+&]/.test(n)) {
    const owner = COMPANIES.find((c) => c.products.includes(hits[0].p));
    const bare = owner?.brand ? new RegExp(`^(${owner.brand.source})$`) : null;
    const kept = hits.filter((h) => !(bare && bare.test(h.text)));
    if (kept.length) hits = kept;
  }
  hits.sort((a, b) => a.idx - b.idx);
  return [...new Set(hits.map((h) => h.p))];
}

function globalProducts(n, exclude) {
  for (const c of COMPANIES) {
    if (c === exclude) continue;
    const hits = matchProducts(n, c.products, false);
    if (hits.length) return { company: c, hits };
  }
  for (const [re, company, product] of MINOR_BRANDS) if (re.test(n)) return { minor: true, company, product };
  return null;
}
const brandIn = (n) => COMPANIES.find((c) => c.brand && c.brand.test(n)) ?? null;
const defaultOf = (c) => c?.singleProduct ?? c?.defaultProduct ?? null;

function fitsCategory(n, c) {
  const cat = /prov|provverktyg/.test(n) ? 'prov' : /stodverktyg/.test(n) ? 'stödverktyg' : /laromedel/.test(n) ? 'läromedel' : /journal|elevhals/.test(n) ? 'elevhälsa'
    : /elevadministr|skoladministr|elevregister|barn (och )?elev|administrativ|schema/.test(n) ? 'skoladministration'
    : /larplattform|\blms\b|learning management|plattform/.test(n) ? 'lärplattform' : null;
  if (!cat) return true;
  if (cat === c.category) return true;
  return !!c.suite && (cat === 'lärplattform' || cat === 'skoladministration');
}

function addonLabel(n) {
  const rules = [
    [/rabatt/, 'Rabatt'], [/konsult|timpris|timkostnad|per timme/, 'Konsulttjänster'], [/inforande|implementer|implementation|uppstart|startavgift|startkostnad|etablering|setup|set up|installation|uppsattning|konfigur|tekniskt|teknikinstallation|leverans|grundkostnad/, 'Införande och uppstart'],
    [/(?<!vuxen)utbildning|workshop|e learning|\bkurs|kompetens|uppstartsdag|grundkurs|uppstartskurs/, 'Utbildning'], [/konsult|timpris|timkostnad|per timme|projektledning|projekt|processledning|radgivning|licensrevision|licenshantering|utvecklingsarbete|forstudie|anpassning|applikationsteam|licenspartner|programforsorjning|it tjanster|it partner|produktnara|sam tjanst|sam system/, 'Konsulttjänster'],
    [/integration|integrer|\bapi\b|filtransport/, 'Integrationer'],
    [/support|customer success|service fee|serviceavtal|\bsla\b/, 'Support'], [/drift|asp|hosting|molntjanst|lagring|backup|forvaltning|underhall|teknikstod/, 'Drift, förvaltning och underhåll'],
    [/migrering|konvertering|overforing|import|export|flytt/, 'Migrering och dataöverföring'], [/bankid|sso|single sign on|idp|saml|inloggning|autentisering|legitimation|freja/, 'Inloggning och identitet'],
    [/sms/, 'SMS'], [/arkiv|gallring|avveckling/, 'Arkiv, gallring och avveckling'], [/testmiljo/, 'Testmiljö'],
    [/integration|integrer|api|synk|provisionering|koppling|navet|leveranskontroll/, 'Integrationer'],
  ];
  return rules.find(([re]) => re.test(n))?.[1] ?? 'Tjänst';
}

function tidyName(name) {
  const s = String(name).replace(/\s*\((?:[^)]*)\)\s*/g, ' ').replace(/\s+-\s+.*$/, '').replace(/\s+/g, ' ').trim();
  return s || String(name);
}

// Line text clean-up before matching (verbatim from build.mjs).
const prepare = (name) => N(name)
  .replace(/\b(adobe|microsoft)licenser\b/g, '$1 licenser').replace(/\bgr utbildning\b/g, 'gr').replace(/\bavtalsomrade \d+.*$/, ' ')
  .replace(/\b(utbildning i svenska for invandrare|distansutbildning for vuxna)\b/g, 'sfi')
  .replace(/\b(som molntjanst|molntjanst saas|saas|som tjanst|it system som tjanst|inkl \d+ ?mb lagring\w*)\b/g, ' ')
  .replace(/\b(sektor (utbildning|omsorg)|tillhorande tjanster utbildning|barn( och)? utbildning( och)? kultur\w*|utbildningsforvaltning\w*)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

// The research engine. Returns { kind, company (def object|null), product
// (name|null), ... } with the research kinds (incl. 'company'); classifyLine
// turns it into the public shape. `vc` is the line's vendor company (or null).
function classifyRaw(vc, name) {
  const n = prepare(name);
  const ownStrong = vc ? matchProducts(n, vc.products, false) : [];
  let glob = ownStrong.length ? null : globalProducts(n, vc);
  if (glob?.minor && vc && matchProducts(n, vc.products, true).length) glob = null;
  const own = ownStrong.length ? matchProducts(n, vc.products, true) : glob ? [] : vc ? matchProducts(n, vc.products, true) : [];
  if (own.length) glob = null;
  const hitCompany = own.length ? vc : glob?.company && typeof glob.company === 'object' ? glob.company : null;
  const hits = own.length ? own : glob?.hits ?? [];
  const productName = hits[0]?.name ?? (glob?.minor ? glob.product : null);
  const bundle = hits.length > 1 ? hits.map((p) => p.name) : undefined;
  const minorCompany = glob?.minor ? glob.company : null; // a name, not a catalogue company
  const companyFor = (c) => c ?? (vc && vc.role !== 'channel' ? vc : brandIn(n) ?? vc);
  const r = (kind, company, product, extra = {}) => ({ kind, company: company ?? null, product: product ?? null, ...(bundle && kind !== 'discount' ? { bundle } : {}), ...extra });

  // Rule 2: discount.
  if (DISCOUNT.test(n)) return r('discount', hitCompany ?? vc ?? brandIn(n), productName);
  // Rule 3: adult-education providers, every line is a school form.
  if (vc?.category === 'utbildningsanordnare' || (!vc && VUX_RE.test(n) && !productName)) return r('segment', vc, null);
  // Rule 4: a line that starts with a service word is a service line, whatever it names.
  if (SERVICE_WORD_HEAD.test(n)) {
    const own1 = vc?.addOns?.find((a) => a.m.test(n));
    return r('addon', hitCompany ?? vc ?? brandIn(n), null, { addon: own1?.name ?? addonLabel(n), ...(productName ? { for: productName } : {}) });
  }
  // Rule 5: the company's own explicit add-ons ...
  const ownAddon = vc?.addOns?.find((a) => a.m.test(n));
  if (ownAddon && !(vc.productFirst && own.length)) return r('addon', vc, null, { addon: ownAddon.name, ...(own[0] ? { for: own[0].name } : {}) });
  // ... and the brand owner's (Unikum Connect bought via Crayon).
  if (hitCompany && hitCompany !== vc) {
    const a = hitCompany.addOns?.find((x) => x.m.test(n));
    if (a) return r('addon', hitCompany, null, { addon: a.name, for: productName });
  }
  // Rule 7 (checked before rule 6 so a service line naming a product stays a
  // service line): generic add-on, unless it is a licence line for a product.
  // Text after "inkl" does not make a product line an add-on.
  const isLicence = LICENCE_WORD.test(n);
  const head = productName ? n.split(/\b(inkl|inklusive)\b/)[0] : n;
  if (GENERIC_ADDON.test(head) && !(isLicence && (productName || defaultOf(vc))) && !((vc?.productFirst || hitCompany?.productFirst) && (productName || vc?.singleProduct) && !GENERIC_ADDON_HEAD.test(head))) {
    return r('addon', hitCompany ?? vc ?? brandIn(n), null, { addon: addonLabel(n), ...(productName ? { for: productName } : {}) });
  }
  // A user-licence line inside a vendor with one main product.
  if (/^anvandarlicens/.test(n) && defaultOf(vc) && !own.length) return r('segment', vc, defaultOf(vc));
  // Rule 6: product match.
  if (productName) return minorCompany ? r('uncatalogued', null, productName, { companyName: minorCompany }) : r('product', companyFor(hitCompany), productName);
  // Rule 8: a bare company name -> its main product.
  const bareStripped = stripSeg(n);
  const nameCo = COMPANIES.find((c) => c.vendors.includes(n) || c.vendors.includes(bareStripped) || (c.brand && bareStripped && c.brand.test(bareStripped) && bareStripped.split(' ').length <= 2 && c.brand.source.length > 3 && new RegExp(`^(${c.brand.source})$`).test(bareStripped)));
  if (nameCo) {
    const d = defaultOf(nameCo);
    return d ? r('product', nameCo, d) : r('company', nameCo, null);
  }
  // Rule 9: hardware.
  if (HARDWARE.test(n)) return r('noise', vc, null);
  // Rule 10: only segment and licence words left.
  if (!bareStripped) return r('segment', vc, defaultOf(vc));
  // Rule 11: a licence/fee line that names no product prices the main product.
  if (isLicence && defaultOf(vc)) return r('segment', vc, defaultOf(vc));
  // (Rule 6, single-product companies: everything else is the product.)
  if (vc?.singleProduct) return r('product', vc, vc.singleProduct);
  // Rule 12: generic descriptor -> main product only when the category fits.
  if (GENERIC_DESC.test(n) || GENERIC_DESC.test(bareStripped)) {
    if (vc && defaultOf(vc) && fitsCategory(n, vc)) return r('product', vc, defaultOf(vc));
    return r('noise', vc, null);
  }
  // Rule 13: the rest.
  if (vc?.role === 'channel') return r('noise', vc, null);
  if (vc) return r('unresolved', vc, null);
  if (VENDORLESS_NOISE.test(n)) return r('noise', null, null);
  return r('uncatalogued', null, tidyName(name));
}

// Rules 2-13 for one product-line name. `ownerSlug` is the slug classifyVendor
// gave the line's vendor (null when the vendor is uncatalogued or missing).
// A line bought through a channel is attributed to the product's owner: the
// returned companySlug can differ from ownerSlug.
export function classifyLine(ownerSlug, raw) {
  const vc = ownerSlug ? BY_SLUG_DEF.get(ownerSlug) ?? null : null;
  const res = classifyRaw(vc, raw);
  const companySlug = res.company?.slug ?? null;
  const pslug = (name) => (name ? PRODUCT_SLUG.get(name) ?? null : null);
  switch (res.kind) {
    case 'product':
      if (res.bundle) return { kind: 'bundle', companySlug, productSlug: pslug(res.bundle[0]), products: res.bundle.map(pslug) };
      return { kind: 'product', companySlug, productSlug: pslug(res.product) };
    case 'addon':
      return { kind: 'addon', companySlug, productSlug: pslug(res.for), addonType: res.addon };
    case 'discount':
    case 'segment':
    case 'noise':
      return { kind: res.kind, companySlug, productSlug: pslug(res.product) };
    case 'company': // a bare company name without a main product
    case 'unresolved':
      return { kind: 'unresolved', companySlug, productSlug: null };
    default: // uncatalogued
      return { kind: 'uncatalogued', companySlug: null, productSlug: null, name: res.product, ...(res.companyName ? { companyName: res.companyName } : {}) };
  }
}
