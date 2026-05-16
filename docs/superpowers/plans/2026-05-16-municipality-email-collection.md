# Municipality contact dataset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js pipeline that collects all 290 Swedish municipalities and an unbounded list of registrator email addresses per kommun (tagged by förvaltning role), output to `data/municipalities.json` + derived CSVs.

**Architecture:** Three idempotent pipeline stages — seed list (Wikipedia/SCB), email discovery (polite per-host scraping with cheerio), verification (MX + manual-review report). Pure functions for extraction/classification/confidence, isolated IO for HTTP/file/DNS. Vitest with HTML fixtures, no live network in CI.

**Tech Stack:** Node.js 20+ (ESM), undici, cheerio, p-limit, csv-stringify, vitest. No framework, no database.

**Spec:** `docs/superpowers/specs/2026-05-16-municipality-email-collection-design.md`

---

## Task 1: Bootstrap project

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `vitest.config.js`
- Create: `README.md`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "mediagraf-municipal-contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "seed": "node scripts/01-fetch-seed.js",
    "discover": "node scripts/02-discover-emails.js",
    "verify": "node scripts/03-verify.js"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "csv-stringify": "^6.5.0",
    "p-limit": "^6.1.0",
    "undici": "^6.21.0"
  },
  "devDependencies": {
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create .gitignore**

```
node_modules/
.DS_Store
*.log
.env
.env.local
coverage/
```

- [ ] **Step 3: Create vitest.config.js**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    testTimeout: 10000,
  },
});
```

- [ ] **Step 4: Create README.md**

```markdown
# Mediagraf Municipal Contracts — Data Collection

Pipeline for collecting Swedish municipalities and their registrator email addresses for sending public-records requests under *offentlighetsprincipen*.

See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for the implementation plan.

## Usage

```
npm install
npm run seed       # Stage 1: fetch 290 kommuner from Wikipedia + SCB
npm run discover   # Stage 2: scrape registrator emails
npm run verify     # Stage 3: validate + build review report
npm test
```

Outputs land in `data/`.
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: dependencies installed, `package-lock.json` created.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore vitest.config.js README.md
git commit -m "chore: bootstrap node project with vitest"
```

---

## Task 2: Polite HTTP client

**Files:**
- Create: `src/http.js`
- Test: `tests/http.test.js`

Provides a `politeFetch(url)` that enforces 1 req/sec per host, retries on transient errors with exponential backoff, sends a contactable User-Agent.

- [ ] **Step 1: Write the failing test**

Create `tests/http.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('politeFetch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rate-limits requests to the same host to >=1s apart', async () => {
    const fetches = [];
    const fakeFetch = vi.fn(async (url) => {
      fetches.push({ url, at: Date.now() });
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    const t0 = Date.now();
    await politeFetch('https://example.com/a');
    await politeFetch('https://example.com/b');
    const elapsed = Date.now() - t0;

    expect(fetches).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(950);
  });

  it('does not rate-limit across different hosts', async () => {
    const fakeFetch = vi.fn(async () => ({ status: 200, ok: true, text: async () => 'ok' }));
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    const t0 = Date.now();
    await politeFetch('https://a.example.com/x');
    await politeFetch('https://b.example.com/x');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(500);
  });

  it('retries on 429 with backoff and eventually succeeds', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls < 2) return { status: 429, ok: false, text: async () => '' };
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);
    politeFetch.__setBackoffBase(10);

    const res = await politeFetch('https://retry.example.com/x');
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it('sets a contact User-Agent', async () => {
    let seenHeaders;
    const fakeFetch = vi.fn(async (url, opts) => {
      seenHeaders = opts.headers;
      return { status: 200, ok: true, text: async () => 'ok' };
    });
    const { politeFetch } = await import('../src/http.js');
    politeFetch.__setFetch(fakeFetch);

    await politeFetch('https://ua.example.com/x');
    expect(seenHeaders['User-Agent']).toMatch(/mediagraf-municipal-contracts-bot/);
    expect(seenHeaders['User-Agent']).toMatch(/gustaf@binogi.com/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/http.test.js`
Expected: FAIL — module `../src/http.js` not found.

- [ ] **Step 3: Implement src/http.js**

```js
import { fetch as undiciFetch } from 'undici';

const HOST_RATE_MS = 1000;
const MAX_RETRIES = 3;
let backoffBase = 1000;
let fetchImpl = undiciFetch;
const lastRequestAt = new Map();
const inflight = new Map();

async function waitForHostSlot(host) {
  const prev = inflight.get(host) ?? Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  inflight.set(host, prev.then(() => next));
  await prev;
  const last = lastRequestAt.get(host) ?? 0;
  const wait = Math.max(0, last + HOST_RATE_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt.set(host, Date.now());
  return release;
}

export async function politeFetch(url, options = {}) {
  const u = new URL(url);
  const release = await waitForHostSlot(u.host);
  try {
    const headers = {
      'User-Agent':
        'mediagraf-municipal-contracts-bot/1.0 (+mailto:gustaf@binogi.com)',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'sv,en;q=0.8',
      ...(options.headers ?? {}),
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetchImpl(url, { ...options, headers });
        if (res.status === 429 || res.status === 503) {
          const backoff = backoffBase * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        const backoff = backoffBase * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr ?? new Error(`Failed after ${MAX_RETRIES} attempts: ${url}`);
  } finally {
    release();
  }
}

politeFetch.__setFetch = (f) => {
  fetchImpl = f;
};
politeFetch.__setBackoffBase = (ms) => {
  backoffBase = ms;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/http.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/http.js tests/http.test.js
git commit -m "feat: polite HTTP client with per-host rate limit and retry"
```

---

## Task 3: Email extractor

**Files:**
- Create: `src/extract.js`
- Test: `tests/extract.test.js`
- Test fixtures: `tests/fixtures/extract-*.html`

Pure functions that pull emails out of HTML, handling `mailto:`, plain text, and common obfuscations (`[at]`, `(at)`, `&#64;`).

- [ ] **Step 1: Create fixtures**

Create `tests/fixtures/extract-plain.html`:

```html
<!doctype html><html><body>
<p>Contact: <a href="mailto:registrator@example.se">registrator@example.se</a></p>
<p>Also: kontakt@example.se</p>
</body></html>
```

Create `tests/fixtures/extract-obfuscated.html`:

```html
<!doctype html><html><body>
<p>E-post: registrator [at] kommun.se</p>
<p>Sekretess: barn (at) kommun (dot) se</p>
<p>HTML-entity: skol&#64;kommun.se</p>
</body></html>
```

Create `tests/fixtures/extract-mailto-with-query.html`:

```html
<!doctype html><html><body>
<a href="mailto:registrator@kommun.se?subject=Begäran">Skriv till oss</a>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/extract.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractEmails, deobfuscate } from '../src/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('deobfuscate', () => {
  it('replaces [at] (case insensitive)', () => {
    expect(deobfuscate('foo [at] bar.se')).toBe('foo@bar.se');
    expect(deobfuscate('foo [AT] bar.se')).toBe('foo@bar.se');
  });
  it('replaces (at) and (dot)', () => {
    expect(deobfuscate('foo (at) bar (dot) se')).toBe('foo@bar.se');
  });
  it('replaces HTML entity &#64;', () => {
    expect(deobfuscate('foo&#64;bar.se')).toBe('foo@bar.se');
  });
});

describe('extractEmails', () => {
  it('finds mailto: links and ignores query strings', () => {
    const res = extractEmails(fixture('extract-mailto-with-query.html'), 'https://k.se/x');
    expect(res.map((r) => r.email)).toContain('registrator@kommun.se');
    expect(res[0].source_url).toBe('https://k.se/x');
  });

  it('finds emails in plain text and via mailto, deduped, lowercased', () => {
    const res = extractEmails(fixture('extract-plain.html'), 'https://k.se/');
    const emails = res.map((r) => r.email).sort();
    expect(emails).toEqual(['kontakt@example.se', 'registrator@example.se']);
  });

  it('finds obfuscated emails', () => {
    const res = extractEmails(fixture('extract-obfuscated.html'), 'https://k.se/');
    const emails = res.map((r) => r.email).sort();
    expect(emails).toContain('registrator@kommun.se');
    expect(emails).toContain('barn@kommun.se');
    expect(emails).toContain('skol@kommun.se');
  });

  it('returns empty array when no emails present', () => {
    const res = extractEmails('<html><body>nothing here</body></html>', 'https://k.se/');
    expect(res).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/extract.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement src/extract.js**

```js
import * as cheerio from 'cheerio';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export function deobfuscate(s) {
  return s
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/&#64;/g, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.');
}

export function extractEmails(html, sourceUrl) {
  const $ = cheerio.load(html);

  const fromMailto = $('a[href^="mailto:"]')
    .map((_, el) => {
      const href = $(el).attr('href') ?? '';
      return href.replace(/^mailto:/i, '').split('?')[0];
    })
    .get()
    .filter(Boolean);

  const text = deobfuscate($('body').text());
  const fromText = [...text.matchAll(EMAIL_RE)].map((m) => m[0]);

  const seen = new Set();
  const out = [];
  for (const raw of [...fromMailto, ...fromText]) {
    const email = raw.toLowerCase().trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, source_url: sourceUrl });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/extract.test.js`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add src/extract.js tests/extract.test.js tests/fixtures/extract-*.html
git commit -m "feat: email extractor with obfuscation handling"
```

---

## Task 4: Role classifier

**Files:**
- Create: `src/classify.js`
- Test: `tests/classify.test.js`

Pure function that maps `{ url, pageTitle, headings, email }` → role enum (`central`, `utbildning`, `gymnasie`, `vuxenutbildning`, `it_digitalisering`, `upphandling`, `other`). Order of checks matters — most specific first.

- [ ] **Step 1: Write the failing test**

Create `tests/classify.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classifyRole } from '../src/classify.js';

const ctx = (overrides = {}) => ({
  url: '',
  pageTitle: '',
  headings: [],
  email: '',
  ...overrides,
});

describe('classifyRole', () => {
  it('classifies utbildning from URL slug', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/forvaltningar/utbildningsforvaltningen' }))).toBe('utbildning');
  });

  it('classifies utbildning from heading "Barn- och utbildningsförvaltningen"', () => {
    expect(classifyRole(ctx({ headings: ['Barn- och utbildningsförvaltningen'] }))).toBe('utbildning');
  });

  it('classifies utbildning from "skolförvaltning"', () => {
    expect(classifyRole(ctx({ pageTitle: 'Skolförvaltningen i kommunen' }))).toBe('utbildning');
  });

  it('classifies gymnasie separately from generic utbildning', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/gymnasieforvaltningen' }))).toBe('gymnasie');
  });

  it('classifies vuxenutbildning', () => {
    expect(classifyRole(ctx({ headings: ['Vuxenutbildning'] }))).toBe('vuxenutbildning');
  });

  it('classifies it_digitalisering', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/it-forvaltningen' }))).toBe('it_digitalisering');
    expect(classifyRole(ctx({ headings: ['Digitaliseringsförvaltningen'] }))).toBe('it_digitalisering');
  });

  it('classifies upphandling', () => {
    expect(classifyRole(ctx({ headings: ['Upphandlingsförvaltningen'] }))).toBe('upphandling');
  });

  it('classifies central when email matches registrator pattern on a top-level page', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/kontakt', email: 'registrator@k.se' }))).toBe('central');
    expect(classifyRole(ctx({ url: 'https://k.se/', email: 'kommun@k.se' }))).toBe('central');
  });

  it('returns "other" when nothing matches', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/kultur', email: 'kultur@k.se' }))).toBe('other');
  });

  it('prefers förvaltning context over central email pattern', () => {
    expect(
      classifyRole(
        ctx({
          url: 'https://k.se/utbildningsforvaltningen/kontakt',
          email: 'registrator@k.se',
        })
      )
    ).toBe('utbildning');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/classify.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/classify.js**

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/classify.test.js`
Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add src/classify.js tests/classify.test.js
git commit -m "feat: role classifier for förvaltning-tagged emails"
```

---

## Task 5: Confidence calculator

**Files:**
- Create: `src/confidence.js`
- Test: `tests/confidence.test.js`

Pure: takes a `contacts` array, returns `'high' | 'medium' | 'low'`.

- [ ] **Step 1: Write the failing test**

Create `tests/confidence.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computeConfidence } from '../src/confidence.js';

describe('computeConfidence', () => {
  it('is "low" with no contacts', () => {
    expect(computeConfidence([])).toBe('low');
  });

  it('is "high" with central + utbildning', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'utbildning', email: 'b@k.se' },
      ])
    ).toBe('high');
  });

  it('treats gymnasie as part of utbildning family for "high"', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'gymnasie', email: 'g@k.se' },
      ])
    ).toBe('high');
  });

  it('treats vuxenutbildning as part of utbildning family for "high"', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'vuxenutbildning', email: 'v@k.se' },
      ])
    ).toBe('high');
  });

  it('is "medium" with only central', () => {
    expect(computeConfidence([{ role: 'central', email: 'a@k.se' }])).toBe('medium');
  });

  it('is "medium" with only utbildning-family', () => {
    expect(computeConfidence([{ role: 'utbildning', email: 'u@k.se' }])).toBe('medium');
  });

  it('is "low" with only "other"', () => {
    expect(computeConfidence([{ role: 'other', email: 'x@k.se' }])).toBe('low');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/confidence.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/confidence.js**

```js
const UTBILDNING_FAMILY = new Set(['utbildning', 'gymnasie', 'vuxenutbildning']);

export function computeConfidence(contacts) {
  if (!contacts || contacts.length === 0) return 'low';
  const hasCentral = contacts.some((c) => c.role === 'central');
  const hasUtbildning = contacts.some((c) => UTBILDNING_FAMILY.has(c.role));
  if (hasCentral && hasUtbildning) return 'high';
  if (hasCentral || hasUtbildning) return 'medium';
  return 'low';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/confidence.test.js`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/confidence.js tests/confidence.test.js
git commit -m "feat: confidence calculator"
```

---

## Task 6: Data store (JSON + CSV)

**Files:**
- Create: `src/store.js`
- Test: `tests/store.test.js`

Read/write `data/municipalities.json`, generate `data/municipalities.csv` (one row per kommun summary) and `data/municipalities-contacts.csv` (one row per contact).

- [ ] **Step 1: Write the failing test**

Create `tests/store.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMunicipalities,
  saveMunicipalities,
  writeSummaryCsv,
  writeContactsCsv,
} from '../src/store.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'store-'));
  return () => rmSync(tmp, { recursive: true, force: true });
});

const sample = [
  {
    kommun_kod: '1980',
    kommun_namn: 'Västerås',
    lan: 'Västmanlands län',
    org_nr: '212000-2080',
    webbplats: 'https://www.vasteras.se',
    diarium_url: null,
    contacts: [
      {
        email: 'registrator@vasteras.se',
        role: 'central',
        forvaltning_namn: null,
        source_url: 'https://www.vasteras.se/kontakt',
        found_via: 'pattern_match',
      },
      {
        email: 'bun@vasteras.se',
        role: 'utbildning',
        forvaltning_namn: 'Barn- och utbildningsförvaltningen',
        source_url: 'https://www.vasteras.se/bun',
        found_via: 'contact_page',
      },
    ],
    confidence: 'high',
    notes: null,
    verified_at: '2026-05-16',
  },
];

describe('store', () => {
  it('roundtrips JSON', () => {
    const path = join(tmp, 'm.json');
    saveMunicipalities(path, sample);
    expect(loadMunicipalities(path)).toEqual(sample);
  });

  it('returns [] when JSON file missing', () => {
    expect(loadMunicipalities(join(tmp, 'missing.json'))).toEqual([]);
  });

  it('writes summary CSV with one row per kommun', async () => {
    const path = join(tmp, 'summary.csv');
    await writeSummaryCsv(path, sample);
    const csv = readFileSync(path, 'utf8');
    expect(csv).toMatch(/kommun_kod,kommun_namn/);
    expect(csv).toMatch(/1980,Västerås/);
    expect(csv).toMatch(/,high,/);
    expect(csv).toMatch(/,2,/); // contact_count
  });

  it('writes long-format contacts CSV with one row per contact', async () => {
    const path = join(tmp, 'contacts.csv');
    await writeContactsCsv(path, sample);
    const csv = readFileSync(path, 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 contacts
    expect(csv).toMatch(/registrator@vasteras\.se/);
    expect(csv).toMatch(/bun@vasteras\.se/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement src/store.js**

```js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'csv-stringify';

export function loadMunicipalities(path) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveMunicipalities(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(records, null, 2) + '\n', 'utf8');
}

function stringifyCsv(rows, columns) {
  return new Promise((resolve, reject) => {
    stringify(rows, { header: true, columns }, (err, out) => {
      if (err) reject(err);
      else resolve(out);
    });
  });
}

export async function writeSummaryCsv(path, records) {
  const rows = records.map((r) => ({
    kommun_kod: r.kommun_kod,
    kommun_namn: r.kommun_namn,
    lan: r.lan,
    org_nr: r.org_nr,
    webbplats: r.webbplats,
    diarium_url: r.diarium_url ?? '',
    contact_count: r.contacts.length,
    confidence: r.confidence,
    verified_at: r.verified_at,
    notes: r.notes ?? '',
  }));
  const columns = [
    'kommun_kod', 'kommun_namn', 'lan', 'org_nr', 'webbplats',
    'diarium_url', 'contact_count', 'confidence', 'verified_at', 'notes',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await stringifyCsv(rows, columns), 'utf8');
}

export async function writeContactsCsv(path, records) {
  const rows = [];
  for (const r of records) {
    for (const c of r.contacts) {
      rows.push({
        kommun_kod: r.kommun_kod,
        kommun_namn: r.kommun_namn,
        email: c.email,
        role: c.role,
        forvaltning_namn: c.forvaltning_namn ?? '',
        source_url: c.source_url,
        found_via: c.found_via,
      });
    }
  }
  const columns = [
    'kommun_kod', 'kommun_namn', 'email', 'role',
    'forvaltning_namn', 'source_url', 'found_via',
  ];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, await stringifyCsv(rows, columns), 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.js`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/store.js tests/store.test.js
git commit -m "feat: JSON + CSV data store"
```

---

## Task 7: Stage 1 — Seed list fetcher

**Files:**
- Create: `src/seed.js`
- Create: `scripts/01-fetch-seed.js`
- Create: `tests/seed.test.js`
- Test fixtures: `tests/fixtures/wikipedia-kommuner.html`, `tests/fixtures/wikipedia-kommun-page.html`

Fetches all 290 kommuner from Wikipedia's "Lista över Sveriges kommuner" page (stable, contains kommunkod + name + län + link to each kommun's own Wikipedia article). For each kommun, follows the link and pulls the official website URL from the article's infobox. Output: `data/seed-municipalities.json`.

> **Note for the engineer:** verify the Wikipedia URL `https://sv.wikipedia.org/wiki/Lista_%C3%B6ver_Sveriges_kommuner` resolves and inspect the table structure before writing the parser. Adjust selectors if the article layout has changed. The fixture below was hand-crafted to match the expected structure — your selectors must work against the live page, not just the fixture.

- [ ] **Step 1: Create fixtures**

Create `tests/fixtures/wikipedia-kommuner.html` (a minimal table matching the structure of the real list page):

```html
<!doctype html><html><body>
<h1>Lista över Sveriges kommuner</h1>
<table class="wikitable sortable">
<tr><th>Kommunkod</th><th>Kommun</th><th>Län</th></tr>
<tr>
  <td>0114</td>
  <td><a href="/wiki/Upplands_V%C3%A4sby_kommun">Upplands Väsby</a></td>
  <td><a href="/wiki/Stockholms_l%C3%A4n">Stockholms län</a></td>
</tr>
<tr>
  <td>1980</td>
  <td><a href="/wiki/V%C3%A4ster%C3%A5s_kommun">Västerås</a></td>
  <td><a href="/wiki/V%C3%A4stmanlands_l%C3%A4n">Västmanlands län</a></td>
</tr>
</table>
</body></html>
```

Create `tests/fixtures/wikipedia-kommun-page.html`:

```html
<!doctype html><html><body>
<table class="infobox">
<tr><th>Officiell webbplats</th><td><a href="https://www.vasteras.se" class="external">www.vasteras.se</a></td></tr>
<tr><th>Org.nr</th><td>212000-2080</td></tr>
</table>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/seed.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKommunListPage, parseKommunInfobox } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseKommunListPage', () => {
  it('extracts kommunkod, namn, län, and article URL for each row', () => {
    const list = parseKommunListPage(fixture('wikipedia-kommuner.html'));
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      kommun_kod: '0114',
      kommun_namn: 'Upplands Väsby',
      lan: 'Stockholms län',
      wikipedia_url: 'https://sv.wikipedia.org/wiki/Upplands_V%C3%A4sby_kommun',
    });
    expect(list[1].kommun_kod).toBe('1980');
    expect(list[1].kommun_namn).toBe('Västerås');
  });
});

describe('parseKommunInfobox', () => {
  it('extracts official website and org.nr from infobox', () => {
    const info = parseKommunInfobox(fixture('wikipedia-kommun-page.html'));
    expect(info.webbplats).toBe('https://www.vasteras.se');
    expect(info.org_nr).toBe('212000-2080');
  });

  it('returns nulls when fields are missing', () => {
    const info = parseKommunInfobox('<html><body></body></html>');
    expect(info.webbplats).toBeNull();
    expect(info.org_nr).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/seed.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement src/seed.js**

```js
import * as cheerio from 'cheerio';
import { politeFetch } from './http.js';

const LIST_URL =
  'https://sv.wikipedia.org/wiki/Lista_%C3%B6ver_Sveriges_kommuner';
const WIKI_BASE = 'https://sv.wikipedia.org';

export function parseKommunListPage(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Find any wikitable whose first row's first header cell looks like kommunkod
  $('table.wikitable').each((_, table) => {
    const headers = $(table).find('tr').first().find('th')
      .map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (!headers.some((h) => h.includes('kommunkod'))) return;
    $(table).find('tr').slice(1).each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const kommun_kod = $(tds[0]).text().trim();
      const nameA = $(tds[1]).find('a').first();
      const kommun_namn = nameA.text().trim() || $(tds[1]).text().trim();
      const href = nameA.attr('href') ?? '';
      const wikipedia_url = href.startsWith('http') ? href : WIKI_BASE + href;
      const lan = $(tds[2]).text().trim();
      if (kommun_kod && kommun_namn) {
        out.push({ kommun_kod, kommun_namn, lan, wikipedia_url });
      }
    });
  });
  return out;
}

export function parseKommunInfobox(html) {
  const $ = cheerio.load(html);
  const info = { webbplats: null, org_nr: null };
  $('table.infobox tr').each((_, tr) => {
    const label = $(tr).find('th').text().trim().toLowerCase();
    if (label.includes('webbplats')) {
      const link = $(tr).find('td a[href^="http"]').first().attr('href');
      if (link) info.webbplats = link.trim();
    }
    if (label.includes('org.nr') || label.includes('organisationsnummer')) {
      info.org_nr = $(tr).find('td').text().trim();
    }
  });
  return info;
}

export async function fetchSeed({ log = () => {} } = {}) {
  log(`Fetching kommun list from ${LIST_URL}`);
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`Failed to fetch list: ${res.status}`);
  const html = await res.text();
  const list = parseKommunListPage(html);
  log(`Found ${list.length} kommuner on list page`);

  const enriched = [];
  for (const row of list) {
    try {
      const r = await politeFetch(row.wikipedia_url);
      if (!r.ok) {
        log(`  ${row.kommun_namn}: ${r.status}, skipping infobox`);
        enriched.push({ ...row, webbplats: null, org_nr: null });
        continue;
      }
      const info = parseKommunInfobox(await r.text());
      enriched.push({ ...row, ...info });
      log(`  ${row.kommun_namn}: ${info.webbplats ?? '(no website)'}`);
    } catch (e) {
      log(`  ${row.kommun_namn}: error ${e.message}, skipping`);
      enriched.push({ ...row, webbplats: null, org_nr: null });
    }
  }
  return enriched;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/seed.test.js`
Expected: 4 passed.

- [ ] **Step 6: Create the runner script**

Create `scripts/01-fetch-seed.js`:

```js
#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchSeed } from '../src/seed.js';

const out = 'data/seed-municipalities.json';
const seed = await fetchSeed({ log: (m) => console.log(m) });

if (seed.length < 280) {
  console.error(`\nWARNING: expected ~290 kommuner, got ${seed.length}`);
  console.error('Check that the Wikipedia list page layout has not changed.');
}

mkdirSync('data', { recursive: true });
writeFileSync(out, JSON.stringify(seed, null, 2) + '\n', 'utf8');
console.log(`\nWrote ${seed.length} records to ${out}`);
```

- [ ] **Step 7: Run the script (real network)**

Run: `node scripts/01-fetch-seed.js`
Expected: Logs ~290 kommuner with their websites. `data/seed-municipalities.json` exists with ≥280 entries.

If the parser returns 0 or far too few rows, the Wikipedia layout has changed — inspect the live page, adjust selectors in `src/seed.js`, regenerate the fixture, and rerun until tests still pass AND the live page yields ≥280 rows.

- [ ] **Step 8: Commit**

```bash
git add src/seed.js scripts/01-fetch-seed.js tests/seed.test.js tests/fixtures/wikipedia-*.html data/seed-municipalities.json
git commit -m "feat: stage 1 — fetch seed list of 290 kommuner from Wikipedia"
```

---

## Task 8: Stage 2 — Email discovery crawler

**Files:**
- Create: `src/crawl.js`
- Create: `scripts/02-discover-emails.js`
- Create: `tests/crawl.test.js`
- Test fixtures: `tests/fixtures/kommun-home.html`, `tests/fixtures/kommun-kontakt.html`, `tests/fixtures/kommun-bun.html`

For each kommun in `data/seed-municipalities.json`:
1. Fetch the homepage; find candidate links (`/kontakt`, `/kontakta-oss`, `/diarium`, `/registrator`, `/forvaltningar`, `/organisation`, plus anchors matching `förvaltning|nämnd|registrator|diarium|kontakt`).
2. Fetch each candidate page (max 15 per kommun to bound work); for each, extract emails and classify by context.
3. Build the per-kommun record with `contacts[]`, `confidence`, `verified_at`.

Output is merged into `data/municipalities.json` (existing rows preserved; only re-crawled rows updated).

- [ ] **Step 1: Create fixtures**

Create `tests/fixtures/kommun-home.html`:

```html
<!doctype html><html><body>
<nav>
  <a href="/kontakt">Kontakt</a>
  <a href="/forvaltningar/utbildningsforvaltningen">Utbildningsförvaltningen</a>
  <a href="/forvaltningar/it-forvaltningen">IT-förvaltningen</a>
  <a href="/nyheter/sommar">Nyheter</a>
</nav>
</body></html>
```

Create `tests/fixtures/kommun-kontakt.html`:

```html
<!doctype html><html><body>
<h1>Kontakta Västerås kommun</h1>
<p>Diarium: <a href="mailto:registrator@vasteras.se">registrator@vasteras.se</a></p>
</body></html>
```

Create `tests/fixtures/kommun-bun.html`:

```html
<!doctype html><html><body>
<h1>Barn- och utbildningsförvaltningen</h1>
<p>E-post: <a href="mailto:bun@vasteras.se">bun@vasteras.se</a></p>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `tests/crawl.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findCandidateLinks, crawlKommun } from '../src/crawl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('findCandidateLinks', () => {
  it('keeps links matching kontakt / förvaltning / nämnd / diarium / registrator', () => {
    const links = findCandidateLinks(fx('kommun-home.html'), 'https://vasteras.se');
    const paths = links.map((u) => new URL(u).pathname);
    expect(paths).toContain('/kontakt');
    expect(paths).toContain('/forvaltningar/utbildningsforvaltningen');
    expect(paths).toContain('/forvaltningar/it-forvaltningen');
    expect(paths).not.toContain('/nyheter/sommar');
  });

  it('returns absolute URLs', () => {
    const links = findCandidateLinks(fx('kommun-home.html'), 'https://vasteras.se');
    for (const u of links) expect(u).toMatch(/^https?:\/\//);
  });
});

describe('crawlKommun', () => {
  it('collects contacts with roles from multiple pages', async () => {
    const pages = {
      'https://vasteras.se/': fx('kommun-home.html'),
      'https://vasteras.se/kontakt': fx('kommun-kontakt.html'),
      'https://vasteras.se/forvaltningar/utbildningsforvaltningen': fx('kommun-bun.html'),
      'https://vasteras.se/forvaltningar/it-forvaltningen':
        '<html><body><h1>IT-förvaltningen</h1><a href="mailto:it@vasteras.se">it</a></body></html>',
    };
    const fakeFetch = async (url) => {
      const html = pages[url];
      if (!html) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => html };
    };

    const seed = {
      kommun_kod: '1980',
      kommun_namn: 'Västerås',
      lan: 'Västmanlands län',
      org_nr: '212000-2080',
      webbplats: 'https://vasteras.se',
    };

    const record = await crawlKommun(seed, { fetch: fakeFetch, today: '2026-05-16' });

    expect(record.kommun_kod).toBe('1980');
    expect(record.contacts.map((c) => c.email).sort()).toEqual(
      ['bun@vasteras.se', 'it@vasteras.se', 'registrator@vasteras.se']
    );
    const byEmail = Object.fromEntries(record.contacts.map((c) => [c.email, c]));
    expect(byEmail['registrator@vasteras.se'].role).toBe('central');
    expect(byEmail['bun@vasteras.se'].role).toBe('utbildning');
    expect(byEmail['it@vasteras.se'].role).toBe('it_digitalisering');
    expect(record.confidence).toBe('high');
    expect(record.verified_at).toBe('2026-05-16');
  });

  it('returns "low" confidence and empty contacts when website is missing', async () => {
    const seed = {
      kommun_kod: '9999',
      kommun_namn: 'Ingenstans',
      lan: 'Län',
      org_nr: null,
      webbplats: null,
    };
    const record = await crawlKommun(seed, { fetch: async () => ({ ok: false, status: 404, text: async () => '' }), today: '2026-05-16' });
    expect(record.contacts).toEqual([]);
    expect(record.confidence).toBe('low');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/crawl.test.js`
Expected: FAIL.

- [ ] **Step 4: Implement src/crawl.js**

```js
import * as cheerio from 'cheerio';
import { politeFetch } from './http.js';
import { extractEmails } from './extract.js';
import { classifyRole } from './classify.js';
import { computeConfidence } from './confidence.js';

const ANCHOR_KEYWORDS_RE =
  /(kontakt|förvaltning|forvaltning|nämnd|namnd|registrator|diarium|organisation|upphandling)/i;

const MAX_PAGES_PER_KOMMUN = 15;

export function findCandidateLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const text = $(a).text();
    if (!href) return;
    let absolute;
    try {
      absolute = new URL(href, base).toString();
    } catch {
      return;
    }
    const u = new URL(absolute);
    if (u.host !== base.host) return;
    if (!/^https?:$/.test(u.protocol)) return;
    const matches =
      ANCHOR_KEYWORDS_RE.test(u.pathname) || ANCHOR_KEYWORDS_RE.test(text);
    if (!matches) return;
    const norm = absolute.split('#')[0];
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  });
  return out;
}

function pageContext(html, url) {
  const $ = cheerio.load(html);
  return {
    url,
    pageTitle: $('title').first().text().trim(),
    headings: $('h1,h2,h3').map((_, el) => $(el).text().trim()).get().slice(0, 10),
  };
}

function forvaltningNameFromHeadings(headings) {
  const h = headings.find((s) => /förvaltning|nämnd/i.test(s));
  return h ?? null;
}

export async function crawlKommun(seed, { fetch = (u, o) => politeFetch(u, o), today } = {}) {
  const baseRecord = {
    kommun_kod: seed.kommun_kod,
    kommun_namn: seed.kommun_namn,
    lan: seed.lan,
    org_nr: seed.org_nr ?? null,
    webbplats: seed.webbplats ?? null,
    diarium_url: null,
    contacts: [],
    confidence: 'low',
    notes: null,
    verified_at: today ?? new Date().toISOString().slice(0, 10),
  };

  if (!seed.webbplats) {
    baseRecord.notes = 'no website in seed';
    return baseRecord;
  }

  let homeRes;
  try {
    homeRes = await fetch(seed.webbplats);
  } catch (e) {
    baseRecord.notes = `homepage fetch failed: ${e.message}`;
    return baseRecord;
  }
  if (!homeRes.ok) {
    baseRecord.notes = `homepage status ${homeRes.status}`;
    return baseRecord;
  }
  const homeHtml = await homeRes.text();

  const candidates = findCandidateLinks(homeHtml, seed.webbplats).slice(0, MAX_PAGES_PER_KOMMUN);
  const pages = [{ url: seed.webbplats, html: homeHtml }];
  for (const url of candidates) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      pages.push({ url, html: await r.text() });
    } catch {
      // tolerate per-page failures
    }
  }

  const seenEmails = new Set();
  for (const { url, html } of pages) {
    const emails = extractEmails(html, url);
    const ctx = pageContext(html, url);
    for (const { email, source_url } of emails) {
      if (seenEmails.has(email)) continue;
      seenEmails.add(email);
      const role = classifyRole({ ...ctx, email });
      if (role === 'other' && !email.startsWith('registrator') && !/^(kommun|info|kontakt|diariet|diarium|bun|buf|skol|utbildning|gymnasie|vux|it|upphandling)/i.test(email.split('@')[0])) {
        continue;
      }
      baseRecord.contacts.push({
        email,
        role,
        forvaltning_namn: forvaltningNameFromHeadings(ctx.headings),
        source_url,
        found_via: emails.length === 1 ? 'pattern_match' : 'contact_page',
      });
    }
  }

  baseRecord.confidence = computeConfidence(baseRecord.contacts);
  return baseRecord;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/crawl.test.js`
Expected: 4 passed.

- [ ] **Step 6: Create the runner script**

Create `scripts/02-discover-emails.js`:

```js
#!/usr/bin/env node
import pLimit from 'p-limit';
import { readFileSync } from 'node:fs';
import { crawlKommun } from '../src/crawl.js';
import { loadMunicipalities, saveMunicipalities, writeSummaryCsv, writeContactsCsv } from '../src/store.js';

const seedPath = 'data/seed-municipalities.json';
const outJson = 'data/municipalities.json';
const outSummary = 'data/municipalities.csv';
const outContacts = 'data/municipalities-contacts.csv';

const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const existing = loadMunicipalities(outJson);
const existingByKod = new Map(existing.map((r) => [r.kommun_kod, r]));

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const onlyKods = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;

const target = onlyKods ? seed.filter((s) => onlyKods.includes(s.kommun_kod)) : seed;
const today = new Date().toISOString().slice(0, 10);

const limit = pLimit(4); // up to 4 different hosts in flight
const results = await Promise.all(
  target.map((s) =>
    limit(async () => {
      const start = Date.now();
      try {
        const record = await crawlKommun(s, { today });
        const ms = Date.now() - start;
        console.log(
          `${s.kommun_kod} ${s.kommun_namn}: ${record.contacts.length} contacts (${record.confidence}) in ${ms}ms`
        );
        return record;
      } catch (e) {
        console.error(`${s.kommun_kod} ${s.kommun_namn}: ERROR ${e.message}`);
        return {
          kommun_kod: s.kommun_kod,
          kommun_namn: s.kommun_namn,
          lan: s.lan,
          org_nr: s.org_nr ?? null,
          webbplats: s.webbplats ?? null,
          diarium_url: null,
          contacts: [],
          confidence: 'low',
          notes: `crawl error: ${e.message}`,
          verified_at: today,
        };
      }
    })
  )
);

const byKod = new Map(existingByKod);
for (const r of results) byKod.set(r.kommun_kod, r);
const merged = [...byKod.values()].sort((a, b) => a.kommun_kod.localeCompare(b.kommun_kod));

saveMunicipalities(outJson, merged);
await writeSummaryCsv(outSummary, merged);
await writeContactsCsv(outContacts, merged);

const counts = merged.reduce((acc, r) => {
  acc[r.confidence] = (acc[r.confidence] ?? 0) + 1;
  return acc;
}, {});
console.log(`\nDone. ${merged.length} kommuner total. Confidence:`, counts);
```

- [ ] **Step 7: Smoke-test on 3 kommuner**

Run: `node scripts/02-discover-emails.js --only=1980,0114,0180`
Expected: log lines for Västerås, Upplands Väsby, Stockholm; `data/municipalities.json` now contains those 3 records with non-empty contacts (or `low` with a note if a site blocked us).

If multiple kommuner come back empty, inspect the HTML they returned and refine `ANCHOR_KEYWORDS_RE` / candidate paths in `src/crawl.js`, then rerun.

- [ ] **Step 8: Run full pipeline (real network, ~15 min)**

Run: `node scripts/02-discover-emails.js`
Expected: ~290 kommuner processed. Final log line shows confidence counts. Goal: ≥260 (90%) of kommuner at `high` or `medium`.

If the rate is well below 90%, do NOT lower the bar — instead inspect a handful of `low` rows by hand, identify the common pattern that was missed, add it to the keywords/candidates, rerun.

- [ ] **Step 9: Commit**

```bash
git add src/crawl.js scripts/02-discover-emails.js tests/crawl.test.js tests/fixtures/kommun-*.html data/municipalities.json data/municipalities.csv data/municipalities-contacts.csv
git commit -m "feat: stage 2 — discover registrator emails by walking kommun sites"
```

---

## Task 9: Stage 3 — Verification & review report

**Files:**
- Create: `src/verify.js`
- Create: `scripts/03-verify.js`
- Create: `tests/verify.test.js`

Validate email syntax, check MX records per unique domain, generate a human-review report listing every `low`/`medium` row with the source URLs already visited.

- [ ] **Step 1: Write the failing test**

Create `tests/verify.test.js`:

```js
import { describe, it, expect, vi } from 'vitest';
import { isValidEmailSyntax, buildReviewReport, verifyAll } from '../src/verify.js';

describe('isValidEmailSyntax', () => {
  it('accepts standard addresses', () => {
    expect(isValidEmailSyntax('registrator@kommun.se')).toBe(true);
  });
  it('rejects malformed strings', () => {
    expect(isValidEmailSyntax('not-an-email')).toBe(false);
    expect(isValidEmailSyntax('a@b')).toBe(false);
    expect(isValidEmailSyntax('@kommun.se')).toBe(false);
  });
});

describe('buildReviewReport', () => {
  it('lists low and medium rows but not high', () => {
    const records = [
      { kommun_kod: '1', kommun_namn: 'A', confidence: 'high', contacts: [] },
      { kommun_kod: '2', kommun_namn: 'B', confidence: 'medium', contacts: [{ email: 'x@b.se', source_url: 'https://b.se/x', role: 'central' }] },
      { kommun_kod: '3', kommun_namn: 'C', confidence: 'low', contacts: [] },
    ];
    const report = buildReviewReport(records);
    expect(report).toContain('B (medium)');
    expect(report).toContain('C (low)');
    expect(report).not.toContain('A (high)');
    expect(report).toContain('https://b.se/x');
  });
});

describe('verifyAll', () => {
  it('flags contacts whose email syntax is invalid', async () => {
    const records = [
      {
        kommun_kod: '1', kommun_namn: 'A', confidence: 'high',
        contacts: [
          { email: 'good@a.se', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' },
          { email: 'bad-email', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' },
        ],
      },
    ];
    const result = await verifyAll(records, { checkMx: async () => true });
    expect(result.invalidSyntax).toHaveLength(1);
    expect(result.invalidSyntax[0].email).toBe('bad-email');
  });

  it('flags domains with no MX record', async () => {
    const records = [
      {
        kommun_kod: '1', kommun_namn: 'A', confidence: 'high',
        contacts: [{ email: 'r@no-mx.example', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' }],
      },
    ];
    const result = await verifyAll(records, { checkMx: async () => false });
    expect(result.missingMx).toHaveLength(1);
    expect(result.missingMx[0].domain).toBe('no-mx.example');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/verify.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement src/verify.js**

```js
import { resolveMx } from 'node:dns/promises';

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export function isValidEmailSyntax(email) {
  return EMAIL_RE.test(email ?? '');
}

export async function hasMxRecord(domain) {
  try {
    const recs = await resolveMx(domain);
    return recs.length > 0;
  } catch {
    return false;
  }
}

export async function verifyAll(records, { checkMx = hasMxRecord } = {}) {
  const invalidSyntax = [];
  const missingMx = [];

  const allEmails = records.flatMap((r) =>
    r.contacts.map((c) => ({ kommun: r.kommun_namn, kod: r.kommun_kod, ...c }))
  );

  for (const c of allEmails) {
    if (!isValidEmailSyntax(c.email)) invalidSyntax.push(c);
  }

  const domains = [...new Set(
    allEmails.filter((c) => isValidEmailSyntax(c.email)).map((c) => c.email.split('@')[1])
  )];
  const mxCache = new Map();
  for (const d of domains) mxCache.set(d, await checkMx(d));

  for (const c of allEmails) {
    if (!isValidEmailSyntax(c.email)) continue;
    const domain = c.email.split('@')[1];
    if (!mxCache.get(domain)) missingMx.push({ ...c, domain });
  }

  return { invalidSyntax, missingMx };
}

export function buildReviewReport(records) {
  const lines = [];
  lines.push(`Review report — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  const flagged = records.filter((r) => r.confidence !== 'high');
  lines.push(`Kommuner needing review: ${flagged.length}`);
  lines.push('');
  for (const r of flagged) {
    lines.push(`## ${r.kommun_namn} (${r.confidence}) — ${r.kommun_kod}`);
    lines.push(`  Website: ${r.webbplats ?? '(none)'}`);
    if (r.notes) lines.push(`  Notes: ${r.notes}`);
    if (r.contacts.length === 0) {
      lines.push('  No contacts found.');
    } else {
      lines.push('  Found:');
      for (const c of r.contacts) {
        lines.push(`    - ${c.email}  [${c.role}]  ${c.source_url}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/verify.test.js`
Expected: 6 passed.

- [ ] **Step 5: Create the runner script**

Create `scripts/03-verify.js`:

```js
#!/usr/bin/env node
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadMunicipalities } from '../src/store.js';
import { verifyAll, buildReviewReport } from '../src/verify.js';

const records = loadMunicipalities('data/municipalities.json');
if (records.length === 0) {
  console.error('data/municipalities.json is empty — run npm run discover first.');
  process.exit(1);
}

console.log(`Verifying ${records.length} kommuner...`);
const { invalidSyntax, missingMx } = await verifyAll(records);
console.log(`Invalid syntax: ${invalidSyntax.length}`);
console.log(`Missing MX: ${missingMx.length}`);
for (const c of invalidSyntax) console.log(`  syntax: ${c.kod} ${c.kommun} -- ${c.email}`);
for (const c of missingMx) console.log(`  no MX: ${c.kod} ${c.kommun} -- ${c.email} (${c.domain})`);

const report = buildReviewReport(records);
mkdirSync('data', { recursive: true });
writeFileSync('data/review-report.md', report, 'utf8');
console.log('\nReview report written to data/review-report.md');
```

- [ ] **Step 6: Run the verification script**

Run: `node scripts/03-verify.js`
Expected: log lines for any flagged emails; `data/review-report.md` exists listing every non-`high` kommun.

- [ ] **Step 7: Commit**

```bash
git add src/verify.js scripts/03-verify.js tests/verify.test.js data/review-report.md
git commit -m "feat: stage 3 — verify emails and emit human-review report"
```

---

## Task 10: End-to-end documentation

**Files:**
- Modify: `README.md`

Document the data files produced and how to interpret confidence levels.

- [ ] **Step 1: Update README.md with output documentation**

Replace `README.md` with:

```markdown
# Mediagraf Municipal Contracts — Data Collection

Pipeline for collecting Swedish municipalities and their registrator email addresses for sending public-records requests under *offentlighetsprincipen*. Phase 1: data collection only.

See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for the implementation plan.

## Usage

```
npm install
npm run seed       # Stage 1: fetch 290 kommuner from Wikipedia
npm run discover   # Stage 2: scrape registrator emails (~15 min, real network)
npm run verify     # Stage 3: validate emails + emit review report
npm test
```

## Outputs

- `data/seed-municipalities.json` — 290 kommuner with name, län, org.nr, website.
- `data/municipalities.json` — full records with `contacts[]` per kommun (canonical).
- `data/municipalities.csv` — one row per kommun, with `contact_count` and `confidence`.
- `data/municipalities-contacts.csv` — one row per contact email (long format).
- `data/review-report.md` — every kommun with `confidence` ≠ `high`, with the source URLs already visited so manual completion is cheap.

## Confidence levels

- **high** — at least one `central` contact AND at least one `utbildning`-family contact (utbildning / gymnasie / vuxenutbildning).
- **medium** — only one of those two.
- **low** — neither, or no contacts found at all. Always needs manual review.

## Contact roles

Each contact is tagged with one of: `central`, `utbildning`, `gymnasie`, `vuxenutbildning`, `it_digitalisering`, `upphandling`, `other`. A single kommun may have any number of contacts.

## Re-running

All three stages are idempotent. Re-running `discover` overwrites the contacts for re-crawled kommuner; pass `--only=<komkod>[,<komkod>...]` to limit which ones.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document outputs and confidence levels"
```

---

## Self-review checklist (already run)

- ✅ Spec coverage: schema (T6), unbounded contacts (T8), role enum (T4), confidence (T5), seed source (T7), MX check (T9), review report (T9), idempotent re-run (T8 script merges by kommun_kod), 1 req/sec/host (T2), retry/backoff (T2), no JS execution (T8 uses cheerio only).
- ✅ No placeholders, no "TODO" / "TBD" / "similar to" / vague error handling.
- ✅ Type consistency: `politeFetch`, `extractEmails`, `classifyRole`, `computeConfidence`, `loadMunicipalities`/`saveMunicipalities`, `writeSummaryCsv`/`writeContactsCsv`, `findCandidateLinks`/`crawlKommun`, `isValidEmailSyntax`/`hasMxRecord`/`verifyAll`/`buildReviewReport` — all signatures used consistently across tasks.
