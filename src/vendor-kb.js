// Curated knowledge base of school/edtech companies, their products, aliases,
// and role (service vs procurement channel). Pure: no IO, no DB. The single
// source of truth backing the watchlist, analytics dedup, coverage facts, and
// the extraction/draft prompts. An unknown name resolves to null (whitelist,
// never a guess). See docs/superpowers/specs/2026-07-28-vendor-product-knowledge-base-design.md

export const COMPANIES = [
  // ---- Watchlisted services ----
  { canonical: 'Radish', slug: 'radish', role: 'service', category: 'läromedel',
    aliases: ['radish'],
    products: ['Magma', 'Matteappen', 'Magma Pedagogik'], watchlist: true },
  { canonical: 'Nationalencyklopedin', slug: 'ne', role: 'service', category: 'läromedel',
    aliases: ['ne', 'nationalencyklopedin', 'ne nationalencyklopedin'],
    products: ['NE.se', 'NE Junior', 'NE Play', 'NE Ordböcker', 'NE 360',
      'NE.se internettjänst', 'E-språk', 'Världens länder', 'Språklexikon',
      'Kunskapstjänster'], watchlist: true },
  { canonical: 'ILT Education', slug: 'ilt', role: 'service', category: 'läromedel',
    aliases: ['ilt', 'ilt education', 'ilt inläsningstjänst', 'inläsningstjänst'],
    products: ['Polyglutt', 'Polylino', 'Begreppa', 'Inlästa läromedel', 'Trovy',
      'Aski Raski', 'Polyglutt Home Access'], watchlist: true },
  { canonical: 'Binogi', slug: 'binogi', role: 'service', category: 'läromedel',
    aliases: ['binogi'], products: ['Binogi.se', 'Språkprojektet'], watchlist: true },

  // ---- Services: skoladministration / lärplattform ----
  { canonical: 'Tietoevry', slug: 'tietoevry', role: 'service', category: 'skoladministration',
    aliases: ['tietoevry', 'tieto', 'tieto evry'],
    products: ['Edlevo', 'Procapita', 'Tieto Education', 'Tieto EDU App',
      'TimeEdit School', 'Procapita Education'] },
  { canonical: 'IST', slug: 'ist', role: 'service', category: 'skoladministration',
    aliases: ['ist', 'ist education'],
    products: ['Extens', 'Dexter', 'hypernet', 'SkolID', 'EduCloud', 'IST Förskola',
      'IST Administration', 'IST Analys', 'IST Home Skola', 'PingPong', 'TextLink',
      'IST Navet'] },
  { canonical: 'Unikum', slug: 'unikum', role: 'service', category: 'lärplattform',
    aliases: ['unikum'],
    products: ['Unikum Förskola', 'Unikum IUP', 'Unikum Bedömning', 'Unikum Grundskola',
      'Unikum Gymnasium', 'Unikum Connect'] },
  { canonical: 'Nova Software', slug: 'nova-software', role: 'service', category: 'skoladministration',
    aliases: ['nova software', 'novasoftware', 'skola24', 'skola 24'],
    products: ['Skola24', 'Novaschem', 'Skola24 Schema', 'Skola24 Frånvaro',
      'Funktionspaket Schema', 'Funktionspaket Frånvaro', 'Funktionspaket Fritidshem'] },
  { canonical: 'Infomentor', slug: 'infomentor', role: 'service', category: 'lärplattform',
    aliases: ['infomentor'], products: [] },
  { canonical: 'Vklass', slug: 'vklass', role: 'service', category: 'lärplattform',
    aliases: ['vklass'], products: [] },
  { canonical: 'itslearning', slug: 'itslearning', role: 'service', category: 'lärplattform',
    aliases: ['itslearning'], products: ['itslearning LP'] },
  { canonical: 'SchoolSoft', slug: 'schoolsoft', role: 'service', category: 'lärplattform',
    aliases: ['schoolsoft'], products: [] },
  { canonical: 'Haldor', slug: 'haldor', role: 'service', category: 'lärplattform',
    aliases: ['haldor'],
    products: ['Haldor Education', 'Haldor Dashboard', 'Haldor Uppgifter',
      'Haldor Planering & bedömning'] },
  { canonical: 'Meitner', slug: 'meitner', role: 'service', category: 'lärplattform',
    aliases: ['meitner'], products: [] },
  { canonical: 'Prorenata', slug: 'prorenata', role: 'service', category: 'elevhälsa',
    aliases: ['prorenata'], products: ['Prorenata Journal'] },

  // ---- Services: prov & bedömning ----
  { canonical: 'DigiExam', slug: 'digiexam', role: 'service', category: 'prov',
    aliases: ['digiexam'], products: [] },
  { canonical: 'Dugga', slug: 'dugga', role: 'service', category: 'prov',
    aliases: ['dugga'], products: ['Dugga Premium'] },
  { canonical: 'StudyBee', slug: 'studybee', role: 'service', category: 'bedömning',
    aliases: ['studybee'], products: ['StudyBee Assess', 'StudyBee Insights', 'StudyBee Mobile'] },
  { canonical: 'Teachiq', slug: 'teachiq', role: 'service', category: 'prov',
    aliases: ['teachiq'], products: [] },

  // ---- Services: stödverktyg / läromedel ----
  { canonical: 'Oribi', slug: 'oribi', role: 'service', category: 'stödverktyg',
    aliases: ['oribi', 'oribi texthelp'],
    products: ['Stava Rex', 'SpellRight', 'Oribi Speak', 'Oribi Habitat', 'Skriva Text',
      'LexiFlow'] },
  { canonical: 'Everway', slug: 'everway', role: 'service', category: 'stödverktyg',
    aliases: ['everway'], products: [] },
  { canonical: 'ReadSpeaker', slug: 'readspeaker', role: 'service', category: 'stödverktyg',
    aliases: ['readspeaker'], products: ['ReadSpeaker TextAid'] },
  { canonical: 'Symbolbruket', slug: 'symbolbruket', role: 'service', category: 'stödverktyg',
    aliases: ['symbolbruket'], products: ['InPrint 3'] },
  { canonical: 'Skolplus', slug: 'skolplus', role: 'service', category: 'läromedel',
    aliases: ['skolplus'], products: ['skolplus.se'] },
  { canonical: 'Sveriges Utbildningsradio', slug: 'ur', role: 'service', category: 'läromedel',
    aliases: ['sveriges utbildningsradio', 'utbildningsradio'],
    products: ['UR-program', 'UR film och radioprogram'] },
  { canonical: 'Aleido Learning', slug: 'aleido', role: 'service', category: 'lärplattform',
    aliases: ['aleido', 'aleido learning', 'aleido learning sweden'], products: [] },
  { canonical: 'Skillster', slug: 'skillster', role: 'service', category: 'övrigt',
    aliases: ['skillster'], products: [] },

  // ---- Services: övriga system ----
  { canonical: 'Tempus', slug: 'tempus', role: 'service', category: 'skoladministration',
    aliases: ['tempus', 'tempus information systems'], products: ['Tempus förskolesystem'] },
  { canonical: 'Quiculum', slug: 'quiculum', role: 'service', category: 'skoladministration',
    aliases: ['quiculum'], products: [] },
  { canonical: 'Eventful', slug: 'eventful', role: 'service', category: 'integration',
    aliases: ['eventful'], products: ['TeamSynk'] },
  { canonical: 'Göteborgs IT Konsult Gotit', slug: 'gotit', role: 'service', category: 'skoladministration',
    aliases: ['gotit', 'göteborgs it konsult gotit'], products: ['Alvis'] },
  { canonical: 'Sirvoy', slug: 'sirvoy', role: 'service', category: 'övrigt',
    aliases: ['sirvoy'], products: [] },

  // ---- Channels (procurement / distribution / reseller partners) ----
  { canonical: 'Adda', slug: 'adda', role: 'channel',
    aliases: ['adda', 'skl kommentus', 'sklkommentus', 'kommentus'], products: [] },
  { canonical: 'Skolon', slug: 'skolon', role: 'channel',
    aliases: ['skolon'], products: [] },
  { canonical: 'Atea', slug: 'atea', role: 'channel',
    aliases: ['atea'], products: [] },
  { canonical: 'LäroMedia Bokhandel Örebro', slug: 'laromedia', role: 'channel',
    aliases: ['laromedia', 'läromedia', 'läromedia bokhandel örebro', 'läromedia bokhandel'], products: [] },
  { canonical: 'Mediacenter Jönköpings län', slug: 'mediacenter', role: 'channel',
    aliases: ['mediacenter jönköpings län', 'mediacenter jönköping', 'mediacenter'], products: [] },
  { canonical: 'Göteborgsregionens kommunalförbund', slug: 'gr', role: 'channel',
    aliases: ['göteborgsregionens kommunalförbund', 'goteborgsregionen', 'gr utbildning'], products: [] },
  { canonical: 'Dustin', slug: 'dustin', role: 'channel',
    aliases: ['dustin'], products: [] },
  { canonical: 'Insight', slug: 'insight', role: 'channel',
    aliases: ['insight', 'insight technology solutions'], products: [] },
  { canonical: 'Devoteam Cloud Services', slug: 'devoteam', role: 'channel',
    aliases: ['devoteam', 'devoteam cloud services'], products: [] },
];

export function normalizeVendorName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function wholeWord(alias, normedName) {
  const a = normalizeVendorName(alias);
  if (!a) return false;
  return new RegExp(`\\b${escapeRegExp(a)}\\b`).test(normedName);
}

const BY_SLUG = new Map(COMPANIES.map((c) => [c.slug, c]));
export function companyBySlug(slug) { return BY_SLUG.get(slug); }

export function resolveCompany(name) {
  const normed = normalizeVendorName(name);
  if (!normed) return null;
  // Company alias first, then product, in COMPANIES order.
  for (const c of COMPANIES) {
    if (c.aliases.some((a) => wholeWord(a, normed))) {
      return { canonical: c.canonical, slug: c.slug, role: c.role, matchedAs: 'company' };
    }
  }
  for (const c of COMPANIES) {
    const hit = c.products.find((p) => wholeWord(p, normed));
    if (hit) return { canonical: c.canonical, slug: c.slug, role: c.role, matchedAs: 'product', product: hit };
  }
  return null;
}
