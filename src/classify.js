const ROLE_KEYWORDS = [
  ['gymnasie', ['gymnasieforvaltning', 'gymnasieförvaltning', 'gymnasienämnd', 'gymnasie-']],
  ['vuxenutbildning', ['vuxenutbildning', 'vux-']],
  ['it_digitalisering', [
    'it-forvaltning', 'it-förvaltning',
    'digitaliseringsforvaltning', 'digitaliseringsförvaltning',
    'it och digital',
  ]],
  ['upphandling', ['upphandlingsforvaltning', 'upphandlingsförvaltning', 'upphandlingsenhet', 'upphandlingskontor']],
  ['utbildning', [
    'utbildningsforvaltning', 'utbildningsförvaltning',
    'barn- och utbildning', 'barn och utbildning',
    'skolforvaltning', 'skolförvaltning',
    'utbildningsnamnd', 'utbildningsnämnd',
    'barnomsorgsforvaltning', 'barnomsorgsförvaltning',
  ]],
];

const CENTRAL_EMAIL_RE = /^(registrator|kommun|info|kontakt|diariet|diarium)@/i;

export function classifyRole({ url = '', pageTitle = '', headings = [], email = '' }) {
  const haystack = `${url} ${pageTitle} ${headings.join(' ')}`.toLowerCase();

  for (const [role, keywords] of ROLE_KEYWORDS) {
    if (keywords.some((k) => haystack.includes(k.toLowerCase()))) return role;
  }

  if (CENTRAL_EMAIL_RE.test(email)) return 'central';
  return 'other';
}
