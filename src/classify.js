const ROLE_KEYWORDS = [
  ['gymnasie', [
    'gymnasieforvaltning', 'gymnasieförvaltning', 'gymnasienämnd', 'gymnasienamnd', 'gymnasie-',
    'gymnasie och vuxenutbildning', 'gymnasie- och vuxenutbildning',
  ]],
  ['vuxenutbildning', ['vuxenutbildning', 'vux-', 'vuxutbildning', 'komvux']],
  ['it_digitalisering', [
    'it-forvaltning', 'it-förvaltning',
    'digitaliseringsforvaltning', 'digitaliseringsförvaltning',
    'it och digital', 'digital transformation', 'digitalisering',
  ]],
  ['upphandling', ['upphandlingsforvaltning', 'upphandlingsförvaltning', 'upphandlingsenhet', 'upphandlingskontor', 'upphandlingsavdelning']],
  ['utbildning', [
    'utbildningsforvaltning', 'utbildningsförvaltning',
    'barn- och utbildning', 'barn och utbildning',
    'skolforvaltning', 'skolförvaltning',
    'utbildningsnamnd', 'utbildningsnämnd',
    'barnomsorgsforvaltning', 'barnomsorgsförvaltning',
    'grundskolenämnd', 'grundskolenamnd', 'förskolenamnd', 'förskolenämnd',
    'barn- och ungdomsforvaltning', 'barn- och ungdomsförvaltning',
  ]],
];

// Email local-part patterns that indicate the central municipal administrative role
const CENTRAL_EMAIL_RE = /^(registrator|registratur|diariet|diarium|kommunstyrelsen|kansli|stadskansliet|stadshuset|kommunhuset|kommunledning|kommunen|kommunkontor|kommuninfo|kommun|info|kontakt|kontaktcenter|servicecenter|kommunservice|medborgar|medborgarservice|diariet|ks|kf|kommunarkiv|kommunarkivet|kommunsekreterare|stab|ledningsstab|forvaltning|forvaltningen)@/i;
// Also match patterns like "arboga.kommun@", "registrator-bun@", "malmostad@"
const CENTRAL_EMAIL_DOTPATTERN_RE = /^registrator[-_.]|[._-](registrator|kommun|kansli|diarium|kommunledning)@|stad@/i;

// Email local-part patterns that indicate education role
const UTBILDNING_EMAIL_RE = /^(utbildning|skola|grundskola|grundskolenamnden|forskolenamnden|barnochutbildning|bun|buf|barnochungdom|barn\.och|utbildningsnamnden)@/i;

// Email local-part patterns for gymnasie
const GYMNASIE_EMAIL_RE = /^(gymnasie|gymn|gymnasienamnden)@/i;

// Email local-part patterns for vux
const VUX_EMAIL_RE = /^(vux|vuxenutbildning|komvux)@/i;

// Email local-part patterns for it
const IT_EMAIL_RE = /^(it|digital|digitalisering|itforvaltning)@/i;

// Email local-part patterns for upphandling
const UPPHANDLING_EMAIL_RE = /^(upphandling|inkop|inköp)@/i;

// Roles that should be preferred over central email classification when in page context
const FORVALTNING_ROLES = new Set(['utbildning', 'gymnasie', 'vuxenutbildning', 'it_digitalisering']);

export function classifyRole({ url = '', pageTitle = '', headings = [], email = '' }) {
  const haystack = `${url} ${pageTitle} ${headings.join(' ')}`.toLowerCase();

  // Check if this is a clear central email (registrator, commune@domain etc.)
  let isCentralEmail = false;
  if (CENTRAL_EMAIL_RE.test(email)) isCentralEmail = true;
  if (!isCentralEmail && CENTRAL_EMAIL_DOTPATTERN_RE.test(email)) isCentralEmail = true;
  if (!isCentralEmail) {
    try {
      const [local, domain] = email.split('@');
      if (domain) {
        const domainFirst = domain.split('.')[0].toLowerCase();
        if (local.toLowerCase() === domainFirst && domainFirst.length >= 3) isCentralEmail = true;
      }
    } catch { /* ignore */ }
  }

  // Page context classification — förvaltning roles (utbildning/gymnasie/etc.) override central email
  for (const [role, keywords] of ROLE_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k.toLowerCase()))) {
      // Only override central classification for actual förvaltning roles, not for upphandling
      if (isCentralEmail && !FORVALTNING_ROLES.has(role)) break;
      return role;
    }
  }

  if (isCentralEmail) return 'central';

  // Pure email-based fallback (no matching page context)
  if (UTBILDNING_EMAIL_RE.test(email)) return 'utbildning';
  if (GYMNASIE_EMAIL_RE.test(email)) return 'gymnasie';
  if (VUX_EMAIL_RE.test(email)) return 'vuxenutbildning';
  if (IT_EMAIL_RE.test(email)) return 'it_digitalisering';
  if (UPPHANDLING_EMAIL_RE.test(email)) return 'upphandling';

  return 'other';
}
