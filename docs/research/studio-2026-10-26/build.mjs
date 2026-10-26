import { createRequire } from 'node:module';
import fs from 'node:fs';
import { COMPANIES, MINOR_BRANDS } from './catalogue-def.mjs';
const require = createRequire('/Users/gustafhard/Projects/mmc-priced/package.json');
const Database = require('better-sqlite3');

const WORK = new URL('.', import.meta.url).pathname;
const OUT = WORK + '../';
const db = new Database(WORK + 's.db', { readonly: true });

export const N = (s) => String(s ?? '').toLowerCase()
  .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[éè]/g, 'e').replace(/ü/g, 'u').replace(/æ/g, 'ae').replace(/ø/g, 'o')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (s) => N(s).replace(/ /g, '-');

const BY_VENDOR = new Map();
for (const c of COMPANIES) for (const v of c.vendors) BY_VENDOR.set(v, c);
const OWNER = new Map(); // product name -> company
for (const c of COMPANIES) for (const p of c.products) {
  if (OWNER.has(p.name)) throw new Error('duplicate product ' + p.name);
  OWNER.set(p.name, c);
}

const KOMMUN = JSON.parse(fs.readFileSync('/Users/gustafhard/Projects/mmc-priced/data/municipalities.json', 'utf8'))
  .map((k) => N(k.kommun_namn)).filter(Boolean);
const KOMMUN_RE = new RegExp(`\\b(${KOMMUN.sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

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
const HARDWARE = /dator|chromebook|surfplatt|\bipad\b|skarm|smartphone|tillbehor|mediaspelare|\bmacos\b|hardvara|arbetsstation|utrustning|enheter\b|leasing|\bmdm\b|utskrift|gemensam utrustning|kommunikation$/;
const GENERIC_DESC = /larplattform|\blms\b|learning management|elevadministr|skoladministr|elevregister|barn (och )?elev|verksamhetssystem|it stod|systemstod|administrationssystem|administrativ|journalsystem|laromedel|digitala prov|provverktyg|provplattform|schemalaggning|\bschema|narvaro|program(vara|varor|mvaru)|molntjanster|licenser|saas|tjansten|systemet|^system$|plattform|digitala verktyg|stodverktyg|produkter|tjanster|losningen|beslutsstod|bibliotekssystem|webbplatssystem|mediekatalog|mediecenter|litteratur|digital arbetsplats|infrastruktur|volymlicens|skolplattform|skapandeverktyg|filmpedagogbloggen|\bsystem\b|e laromedel|talsyntes|vardnadshavare|ovriga|ovrigt|^ansokan|^betyg$|e tjanst|mallar$/;
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

function vendorCompany(raw) {
  if (raw == null) return null;
  const n = N(raw);
  const k = n.replace(/\b(sverige ab|aktiebolag|sverige|ab)$/, '').trim();
  return BY_VENDOR.get(n) ?? BY_VENDOR.get(k) ?? null;
}

function matchProducts(n, products, useLocal) {
  const pass = (useM) => {
    let rest = n; const hits = [];
    for (const p of products) {
      const re = useM ? p.m : p.local;
      if (!re) continue;
      const m = rest.trim() ? rest.match(re) : null;
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
function brandIn(n) { return COMPANIES.find((c) => c.brand && c.brand.test(n)) ?? null; }
const defaultOf = (c) => c?.singleProduct ?? c?.defaultProduct ?? null;

export function classify(vendorRaw, name) {
  const vc = vendorCompany(vendorRaw);
  const vendorLabel = vc?.canonical ?? (vendorRaw ? vendorRaw.replace(/\s+(Sverige AB|AB|Sverige)$/i, '') : null);
  const n = N(name).replace(/\b(adobe|microsoft)licenser\b/g, '$1 licenser').replace(/\bgr utbildning\b/g, 'gr').replace(/\bavtalsomrade \d+.*$/, ' ').replace(/\b(utbildning i svenska for invandrare|distansutbildning for vuxna)\b/g, 'sfi').replace(/\b(som molntjanst|molntjanst saas|saas|som tjanst|it system som tjanst|inkl \d+ ?mb lagring\w*)\b/g, ' ').replace(/\b(sektor (utbildning|omsorg)|tillhorande tjanster utbildning|barn( och)? utbildning( och)? kultur\w*|utbildningsforvaltning\w*)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const ownStrong = vc ? matchProducts(n, vc.products, false) : [];
  let glob = ownStrong.length ? null : globalProducts(n, vc);
  if (glob?.minor && vc && matchProducts(n, vc.products, true).length) glob = null;
  const own = ownStrong.length ? matchProducts(n, vc.products, true) : glob ? [] : vc ? matchProducts(n, vc.products, true) : [];
  if (own.length) glob = null;
  const hitCompany = own.length ? vc : glob?.company && typeof glob.company === 'object' ? glob.company : null;
  const hits = own.length ? own : glob?.hits ?? [];
  const productName = hits[0]?.name ?? (glob?.minor ? glob.product : null);
  const bundle = hits.length > 1 ? hits.map((p) => p.name) : undefined;
  const minorCompany = glob?.minor ? glob.company : null;
  const companyFor = (c) => c?.canonical ?? minorCompany ?? (vc && vc.role !== 'channel' ? vc.canonical : brandIn(n)?.canonical ?? vendorLabel);
  const r = (kind, company, product, extra = {}) => ({ kind, company: company ?? null, product: product ?? null, ...(bundle && kind !== 'discount' ? { bundle } : {}), ...extra });

  // 1. discount
  if (DISCOUNT.test(n)) return r('discount', hitCompany?.canonical ?? vc?.canonical ?? brandIn(n)?.canonical ?? vendorLabel, productName);
  // 1b. adult-education providers: every line is a school form (segment)
  if (vc?.category === 'utbildningsanordnare' || (!vc && VUX_RE.test(n) && !productName)) return r('segment', vc?.canonical ?? vendorLabel, null, { segment: name });
  // 1c. a line that starts with a service word is a service line, whatever it names
  if (/^(integration|integrering|inforande|implementer|implementation|utbildning|support|migrering|uppstart|setup|installation)/.test(n)) {
    const ac = hitCompany ?? vc ?? brandIn(n);
    const own1 = vc?.addOns?.find((a) => a.m.test(n));
    return r('addon', ac?.canonical ?? minorCompany ?? vendorLabel, null, { addon: own1?.name ?? addonLabel(n), ...(productName ? { for: productName } : {}) });
  }
  // 2. own explicit add-ons
  const ownAddon = vc?.addOns?.find((a) => a.m.test(n));
  if (ownAddon && !(vc.productFirst && own.length)) return r('addon', vc.canonical, null, { addon: ownAddon.name, ...(own[0] ? { for: own[0].name } : {}) });
  // 3. add-on whose brand owner has an explicit add-on (e.g. Unikum Connect bought via Crayon)
  if (hitCompany && hitCompany !== vc) {
    const a = hitCompany.addOns?.find((x) => x.m.test(n));
    if (a) return r('addon', hitCompany.canonical, null, { addon: a.name, for: productName });
  }
  // 4. generic add-on (service line); text after "inkl" does not make a product line an add-on
  const isLicence = LICENCE_WORD.test(n);
  const head = productName ? n.split(/\b(inkl|inklusive)\b/)[0] : n;
  if (GENERIC_ADDON.test(head) && !(isLicence && (productName || defaultOf(vc))) && !((vc?.productFirst || hitCompany?.productFirst) && (productName || vc?.singleProduct) && !new RegExp('^' + GENERIC_ADDON.source).test(head))) {
    const ac = hitCompany ?? vc ?? brandIn(n);
    return r('addon', ac?.canonical ?? minorCompany ?? vendorLabel, null, { addon: addonLabel(n), ...(productName ? { for: productName } : {}) });
  }
  // 4b. a user-licence line inside a vendor that has one main product
  if (/^anvandarlicens/.test(n) && defaultOf(vc) && !own.length) return r('segment', vc.canonical, defaultOf(vc), { segment: name });
  // 5. product
  if (productName) return r('product', companyFor(hitCompany), productName, glob?.minor ? { uncatalogued: true } : {});
  // 6. a bare company name
  const bareStripped = stripSeg(n);
  const nameCo = COMPANIES.find((c) => c.vendors.includes(n) || c.vendors.includes(bareStripped) || (c.brand && bareStripped && c.brand.test(bareStripped) && bareStripped.split(' ').length <= 2 && c.brand.source.length > 3 && new RegExp(`^(${c.brand.source})$`).test(bareStripped)));
  if (nameCo) {
    const d = defaultOf(nameCo);
    return d ? r('product', nameCo.canonical, d, { via: 'company-name' }) : r('company', nameCo.canonical, null);
  }
  // 6b. an uncatalogued vendor's line that names the vendor itself is that vendor's product
  const vTok = vendorRaw ? N(vendorRaw).split(' ').find((t) => t.length > 3 && !['sverige', 'education', 'utbildning', 'learning'].includes(t)) : null;
  if (!vc && vTok && new RegExp(`\\b${vTok}`).test(n)) return r('product', vendorLabel, tidyName(name), { uncatalogued: true });
  // 7. hardware
  if (HARDWARE.test(n)) return r('noise', vc?.canonical ?? vendorLabel, null, { note: 'hårdvara' });
  // 8. segment / licence form only
  if (!bareStripped) return r('segment', vc?.canonical ?? vendorLabel, defaultOf(vc), { segment: name });
  // 8b. a licence/fee line that names no product is the price of the vendor's main product
  if (isLicence && defaultOf(vc)) return r('segment', vc.canonical, defaultOf(vc), { segment: name });
  // 9. single-product company: everything else is its product
  if (vc?.singleProduct) return r('product', vc.canonical, vc.singleProduct, { via: 'single-product' });
  // 10. generic descriptor
  if (GENERIC_DESC.test(n) || GENERIC_DESC.test(bareStripped)) {
    if (vc && defaultOf(vc) && fitsCategory(n, vc)) return r('product', vc.canonical, defaultOf(vc), { via: 'generic-default' });
    return r('noise', vc?.canonical ?? vendorLabel, null, { note: 'generisk beskrivning' });
  }
  // 11. fallback
  if (vc?.role === 'channel') return r('noise', vc.canonical, null, { note: 'okänd produkt hos återförsäljare' });
  if (vc && vc.products.length) return r('product', vc.canonical, null, { unresolved: true });
  if (vc) return r('product', vc.canonical, null, { unresolved: true, note: 'företaget har ingen katalogiserad produkt' });
  if (!vendorRaw && (GENERIC_DESC.test(n) || /modul|lararhandledning|\bprao\b|nationella prov|folkbokforing|barnadministration|arskostnad|avtalssamverkan/.test(n))) return r('noise', null, null, { note: 'generisk beskrivning' });
  return r('product', vendorLabel, tidyName(name), { uncatalogued: true });
}

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
  return s || name;
}

// ---------------- run ----------------
const raw = db.prepare(`
  select v.name vendor, x.n name, x.src src, count(*) cnt from (
    select p.vendor_id vid, p.name n, 'products' src from products p
    union all select c.vendor_id, li.product_name, 'line_items' from contract_line_items li join contracts c on c.id=li.contract_id
    union all select c.vendor_id, cc.product_name, 'coverage' from contract_coverage cc join contracts c on c.id=cc.contract_id
  ) x left join vendors v on v.id=x.vid group by 1,2,3`).all();
const vendors = db.prepare(`select v.name, count(c.id) avtal from vendors v left join contracts c on c.vendor_id=v.id group by v.id`).all();

const results = [];
for (const row of raw) results.push({ ...row, ...classify(row.vendor, row.name) });

// mapping: per distinct raw name
const mapping = { vendors: {}, names: {} };
for (const v of vendors) {
  const c = vendorCompany(v.name);
  mapping.vendors[v.name] = c ? { kind: 'company', company: c.canonical, product: null, avtal: v.avtal }
    : { kind: 'company', company: v.name.replace(/\s+(Sverige AB|AB)$/i, ''), product: null, avtal: v.avtal, uncatalogued: true };
}
const byName = new Map();
for (const r of results) {
  const key = r.name;
  const val = { kind: r.kind, company: r.company, product: r.product };
  for (const f of ['bundle', 'addon', 'for', 'segment', 'note', 'unresolved', 'uncatalogued', 'via']) if (r[f] !== undefined && f !== 'segment') val[f] = r[f];
  if (!byName.has(key)) byName.set(key, []);
  byName.get(key).push({ vendor: r.vendor, cnt: r.cnt, src: r.src, val });
}
for (const [name, list] of [...byName].sort((a, b) => a[0].localeCompare(b[0], 'sv'))) {
  const distinct = new Map();
  for (const e of list) {
    const k = JSON.stringify(e.val);
    if (!distinct.has(k)) distinct.set(k, { val: e.val, vendors: new Set(), cnt: 0, src: new Set() });
    const d = distinct.get(k); d.vendors.add(e.vendor ?? '(ingen leverantör)'); d.cnt += e.cnt; d.src.add(e.src);
  }
  const arr = [...distinct.values()].sort((a, b) => b.cnt - a.cnt);
  const top = arr[0];
  const entry = { ...top.val, rows: list.reduce((s, e) => s + e.cnt, 0), sources: [...new Set(list.map((e) => e.src))] };
  if (arr.length > 1) entry.byVendor = Object.fromEntries(arr.flatMap((d) => [...d.vendors].map((v) => [v, d.val])));
  mapping.names[name] = entry;
}

// catalogue
const aliasMap = new Map(); // product -> Set raw
const addonMap = new Map(); // company -> Set addon labels
const prodRows = new Map();
for (const r of results) {
  if (r.kind === 'product' && r.product && OWNER.has(r.product)) {
    for (const p of r.bundle ?? [r.product]) {
      if (!aliasMap.has(p)) aliasMap.set(p, new Map());
      aliasMap.get(p).set(r.name, (aliasMap.get(p).get(r.name) ?? 0) + r.cnt);
    }
  }
  if (r.kind === 'addon' && r.company) {
    if (!addonMap.has(r.company)) addonMap.set(r.company, new Map());
    addonMap.get(r.company).set(r.addon, (addonMap.get(r.company).get(r.addon) ?? 0) + r.cnt);
  }
}
const avtalByCompany = new Map();
for (const v of vendors) { const c = vendorCompany(v.name); if (c) avtalByCompany.set(c.canonical, (avtalByCompany.get(c.canonical) ?? 0) + v.avtal); }

const catalogue = COMPANIES.map((c) => {
  const vendorAliases = vendors.filter((v) => vendorCompany(v.name) === c).map((v) => v.name);
  const o = {
    canonical: c.canonical, slug: c.slug, category: c.category ?? (c.role === 'channel' ? 'återförsäljare' : null), role: c.role,
    aliases: [...new Set([...vendorAliases, ...c.vendors.filter((v) => !vendorAliases.some((a) => N(a) === v))])],
    website: c.website ?? null,
    ...(c.note ? { note: c.note } : {}),
    avtal: avtalByCompany.get(c.canonical) ?? 0,
    products: c.products.map((p) => ({
      name: p.name, slug: slugify(p.name), category: p.category, what_it_is: p.what_it_is,
      ...(p.editions ? { editions: p.editions } : {}),
      aliases: [...(aliasMap.get(p.name) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([n]) => n).filter((n) => n !== p.name),
    })),
    addOns: [...(addonMap.get(c.canonical) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([n]) => n),
  };
  if (c.singleProduct) o.singleProduct = c.singleProduct;
  if (c.probeLabel) o.probeLabel = c.probeLabel;
  return o;
});

fs.writeFileSync(OUT + 'catalogue.json', JSON.stringify(catalogue, null, 2));
fs.writeFileSync(OUT + 'catalogue-mapping.json', JSON.stringify(mapping, null, 2));
fs.writeFileSync(WORK + 'results.json', JSON.stringify(results, null, 1));
console.log('rows', results.length, 'names', byName.size);
const kinds = {}; for (const r of results) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1; console.log(kinds);
console.log('unresolved', results.filter((r) => r.unresolved).length, 'uncatalogued', results.filter((r) => r.uncatalogued).length);
