# Vendor/Product Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the pipeline a curated company→product→alias knowledge base (service vs channel) with a deterministic read-time resolver, then feed it into analytics, watchlist, drafts, extraction, and a 3-stage coverage engagement.

**Architecture:** A pure data+logic module `src/vendor-kb.js` is the single source of truth. A pure `resolveCompany(name)` maps any raw vendor/product name to its canonical company. Existing flat lists (`watchlist.js`, the clusters in `vendor-aliases.js`, `resellers.js`) become views over the KB. Consumers resolve at read time; stored extraction is never mutated.

**Tech Stack:** Node 20+ ESM, vitest, better-sqlite3 (SQLite, WAL), Anthropic SDK (Opus for extraction / Haiku for analysis). No new dependencies.

## Global Constraints

- **Node 20+ ESM** — `import`/`export`, no CommonJS.
- **`src/vendor-kb.js` is pure** — no IO, no DB read, deterministic. (Same rule as `watchlist.js`, `resellers.js`, `vendor-aliases.js`.)
- **Whitelist, not heuristic** — an unknown name resolves to `null` and is passed through unchanged by callers. Never invent a company.
- **Normalization matches the watchlist** — lowercase, ASCII-fold `å ä → a`, `ö → o`, `é → e`, `ü → u`, punctuation → space, collapse whitespace; aliases match as **whole words** so short aliases (`ne`, `ilt`) never fire inside unrelated tokens.
- **No casual schema changes** — later phases add columns only via append-only `PRAGMA table_info` probes and extend existing TEXT columns with new string values (see `src/storage.js` conventions).
- **All tests run offline** — vitest, fakes/fixtures; temp-dir SQLite via `mkdtempSync` + `openDb` + `migrate()`, never the live `data/pilot.db`.
- **No em-dash / en-dash in outbound email prose** — applies to every template/draft string (later phases).
- **Anthropic json_schema keeps <16 union-typed params** — the extraction KB digest is prompt *text*, not schema; do not add union params. See [[anthropic-structured-output-union-limit]].
- **Update the fixture first** when a parser/classifier live contract changes; don't loosen a test to paper over a change.

---

## Phase 1 — Knowledge base + resolver + watchlist backing

Delivers a tested, self-contained foundation: the KB data module, the pure
resolver, and `watchlist.js` re-expressed as a view over the KB (public API
unchanged). Everything after Phase 1 consumes `resolveCompany`.

### Task 1: `resolveCompany` + KB scaffold

**Files:**
- Create: `src/vendor-kb.js`
- Test: `tests/vendor-kb.test.js`

**Interfaces:**
- Produces:
  - `export const COMPANIES` — array of `{ canonical: string, slug: string, role: 'service'|'channel', category?: string, aliases: string[], products: string[], watchlist?: boolean }`.
  - `export function normalizeVendorName(s): string` — the shared normalizer.
  - `export function resolveCompany(name): { canonical, slug, role, matchedAs: 'company'|'product', product?: string } | null`.
  - `export function companyBySlug(slug): company | undefined`.

- [ ] **Step 1: Write the failing test**

```js
// tests/vendor-kb.test.js
import { describe, it, expect } from 'vitest';
import { resolveCompany, normalizeVendorName, companyBySlug, COMPANIES } from '../src/vendor-kb.js';

describe('normalizeVendorName', () => {
  it('folds Swedish letters, lowercases, collapses punctuation/space', () => {
    expect(normalizeVendorName('  Inläsningstjänst (ILT) ')).toBe('inlasningstjanst ilt');
    expect(normalizeVendorName('Skola 24')).toBe('skola 24');
  });
});

describe('resolveCompany', () => {
  it('resolves a product to its parent company', () => {
    expect(resolveCompany('Magma')).toMatchObject({ canonical: 'Radish', role: 'service', matchedAs: 'product', product: 'Magma' });
    expect(resolveCompany('Matteappen')).toMatchObject({ canonical: 'Radish', matchedAs: 'product' });
  });
  it('resolves a company alias to the company', () => {
    expect(resolveCompany('NE')).toMatchObject({ canonical: 'Nationalencyklopedin', matchedAs: 'company' });
    expect(resolveCompany('ILT Education')).toMatchObject({ canonical: 'ILT Education', matchedAs: 'company' });
  });
  it('tags procurement channels with role=channel', () => {
    expect(resolveCompany('Adda')).toMatchObject({ canonical: 'Adda', role: 'channel' });
    expect(resolveCompany('SKL Kommentus')).toMatchObject({ canonical: 'Adda', role: 'channel' });
  });
  it('matches aliases only as whole words (short aliases never fire inside tokens)', () => {
    expect(resolveCompany('nexus panel')).toBeNull();   // "ne" must not match inside "nexus"
    expect(resolveCompany('kilty')).toBeNull();          // "ilt" must not match inside "kilty"
  });
  it('returns null for an unknown name', () => {
    expect(resolveCompany('Totally Unknown AB')).toBeNull();
    expect(resolveCompany('')).toBeNull();
    expect(resolveCompany(null)).toBeNull();
  });
  it('companyBySlug looks up by slug', () => {
    expect(companyBySlug('radish')).toMatchObject({ canonical: 'Radish' });
    expect(companyBySlug('nope')).toBeUndefined();
  });
  it('every company has a unique slug and non-empty canonical', () => {
    const slugs = COMPANIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of COMPANIES) { expect(c.canonical).toBeTruthy(); expect(['service','channel']).toContain(c.role); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vendor-kb.test.js`
Expected: FAIL — `Cannot find module '../src/vendor-kb.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/vendor-kb.js
// Curated knowledge base of school/edtech companies, their products, aliases,
// and role (service vs procurement channel). Pure: no IO, no DB. The single
// source of truth backing the watchlist, analytics dedup, coverage facts, and
// the extraction/draft prompts. An unknown name resolves to null (whitelist,
// never a guess). See docs/superpowers/specs/2026-07-28-vendor-product-knowledge-base-design.md

// Scaffold seed — a few real entries to exercise the resolver. The FULL curated
// list is produced in Task 2 from the live vendors/products.
export const COMPANIES = [
  { canonical: 'Radish', slug: 'radish', role: 'service', category: 'läromedel',
    aliases: ['radish'], products: ['Magma', 'Matteappen', 'Magma Pedagogik'], watchlist: true },
  { canonical: 'Nationalencyklopedin', slug: 'ne', role: 'service', category: 'läromedel',
    aliases: ['ne', 'nationalencyklopedin', 'ne nationalencyklopedin'],
    products: ['NE.se', 'NE Junior', 'NE Play', 'NE Ordböcker', 'NE 360'], watchlist: true },
  { canonical: 'ILT Education', slug: 'ilt', role: 'service', category: 'läromedel',
    aliases: ['ilt', 'ilt education', 'ilt inläsningstjänst', 'inläsningstjänst'],
    products: ['Polyglutt', 'Polylino', 'Begreppa', 'Inlästa läromedel', 'Trovy', 'Aski Raski'], watchlist: true },
  { canonical: 'Binogi', slug: 'binogi', role: 'service', category: 'läromedel',
    aliases: ['binogi'], products: ['Binogi.se'], watchlist: true },
  { canonical: 'Adda', slug: 'adda', role: 'channel',
    aliases: ['adda', 'skl kommentus', 'sklkommentus', 'kommentus'], products: [] },
  { canonical: 'Skolon', slug: 'skolon', role: 'channel', aliases: ['skolon'], products: [] },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vendor-kb.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/vendor-kb.js tests/vendor-kb.test.js
git commit -m "feat(vendor-kb): curated company/product KB + pure resolveCompany"
```

### Task 2: Seed the full curated KB from live data (operator-reviewed)

**Files:**
- Modify: `src/vendor-kb.js` (replace the scaffold `COMPANIES` with the full curated list)
- Test: `tests/vendor-kb.test.js` (add coverage-shape assertions)

**Interfaces:**
- Consumes: `resolveCompany` (Task 1). Produces: the same exports, fuller data.

- [ ] **Step 1: Generate the candidate list from the live box DB**

Read-only, via SSM against the live DB (do NOT mutate). Produce, for review, every distinct `vendors.name` and every `products.name → vendor.name` pair:

```bash
AWS_PROFILE=personal AWS_REGION=eu-central-1 aws ssm start-session --target i-0c71fa9c98b466a90
# on the box:
sudo -u mediagraf /usr/local/bin/node -e '
const D=require("/opt/mediagraf/app/node_modules/better-sqlite3");
const db=new D("/var/lib/mediagraf/pilot.db",{readonly:true});
console.log(JSON.stringify({
  vendors: db.prepare("SELECT name FROM vendors ORDER BY name").all().map(r=>r.name),
  products: db.prepare("SELECT p.name product, v.name vendor FROM products p JOIN vendors v ON v.id=p.vendor_id ORDER BY v.name").all(),
}));'
```

- [ ] **Step 2: Curate into `COMPANIES`**

Fold the candidates into one entry per real company. Rules:
- `role: 'channel'` for procurement/distribution partners: **Adda / SKL Kommentus, Skolon, Atea, LäroMedia Bokhandel Örebro, Mediacenter Jönköpings län, Göteborgsregionens kommunalförbund (GR)**. `products: []`.
- `role: 'service'` for real vendors; put brand/product names under the owning company (`Magma/Matteappen/Magma Pedagogik → Radish`; `Polyglutt/Polylino/Begreppa → ILT Education`; `Skola24/Novaschem → Nova Software`; `Edlevo/Procapita/Unikum 2021 → Tietoevry`; `NE.se/NE Junior/... → Nationalencyklopedin`, etc.).
- `watchlist: true` on the four current watchlist companies (Nationalencyklopedin, Radish/Magma, ILT, Binogi) so Task 3 can derive the watchlist.
- Every alias/product a *whole-word*, ASCII-foldable string. Keep casing on `canonical`/`products` for display.

Commit the file for operator review before wiring consumers.

- [ ] **Step 3: Extend the test with shape guarantees**

```js
it('resolves the known fragmentation clusters to a single company', () => {
  for (const n of ['NE', 'NE Nationalencyklopedin', 'NE.se']) expect(resolveCompany(n)?.slug).toBe('ne');
  for (const n of ['ILT', 'ILT Education', 'Inläsningstjänst', 'Polyglutt']) expect(resolveCompany(n)?.slug).toBe('ilt');
  for (const n of ['Magma', 'Matteappen', 'Radish']) expect(resolveCompany(n)?.slug).toBe('radish');
});
it('channels are role=channel with no products to request', () => {
  for (const s of ['adda','skolon','atea','laromedia']) {
    const c = COMPANIES.find((x) => x.slug === s); expect(c?.role).toBe('channel');
  }
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/vendor-kb.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vendor-kb.js tests/vendor-kb.test.js
git commit -m "feat(vendor-kb): seed full curated company/product list (operator review)"
```

### Task 3: Back `watchlist.js` with the KB (public API unchanged)

**Files:**
- Modify: `src/watchlist.js`
- Test: `tests/watchlist.test.js` (existing) + one new case

**Interfaces:**
- Consumes: `COMPANIES`, `resolveCompany` (Tasks 1–2).
- Produces (unchanged public API): `export function matchWatchlist(names): string[]`, `export const WATCHLIST`, `export function matchVendorEntries(entries, names)`.

- [ ] **Step 1: Write the failing test** (delivering a product satisfies its company's watchlist entry)

```js
// tests/watchlist.test.js — add
import { matchWatchlist } from '../src/watchlist.js';
it('a delivered product resolves to its company watchlist entry', () => {
  // "Magma" is a product of Radish, which is watchlisted.
  expect(matchWatchlist(['Magma'])).toContain('Radish');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/watchlist.test.js`
Expected: FAIL — current `matchWatchlist(['Magma'])` returns `['Magma']` (or nothing), not `['Radish']`.

- [ ] **Step 3: Re-express the watchlist over the KB**

Keep `matchVendorEntries` and `normalize` (other callers use them), but derive `WATCHLIST` from the KB and route `matchWatchlist` through `resolveCompany` so products map to their company:

```js
import { COMPANIES, resolveCompany } from './vendor-kb.js';

// Watchlisted companies, canonical names — derived from the KB.
export const WATCHLIST = COMPANIES.filter((c) => c.watchlist).map((c) => ({ canonical: c.canonical, aliases: c.aliases }));

// Canonical names of watchlisted companies matched by any of `names`, resolving
// products to their parent company (so "Magma" → "Radish").
export function matchWatchlist(names = []) {
  const watch = new Set(COMPANIES.filter((c) => c.watchlist).map((c) => c.slug));
  const hits = new Set();
  for (const n of names) {
    const r = resolveCompany(n);
    if (r && watch.has(r.slug)) hits.add(r.canonical);
  }
  return [...hits];
}
```

(Leave `normalize`, `escapeRegExp`, `matchVendorEntries` in place for the reseller list and other callers.)

- [ ] **Step 4: Run the full suite** (watchlist is consumed by tick/storage tests)

Run: `npx vitest run`
Expected: PASS — all ~1042+ tests. Fix any test that asserted the old flat `['Magma']` behavior by updating it to the company-resolved value (update the assertion, not the resolver).

- [ ] **Step 5: Commit**

```bash
git add src/watchlist.js tests/watchlist.test.js
git commit -m "feat(watchlist): derive from vendor-kb; delivered product satisfies its company"
```

---

## Phases 2–5 — Roadmap (detailed just-in-time, one plan section each)

These build on Phase 1's `resolveCompany`. Each is independently shippable and
will be expanded into full TDD tasks (like Phase 1 above) when it starts —
detailing them now would require guessing exact signatures in
`vendor-analytics.js`, `templates.js`, `tick.js`, and `analyse-contract.js` that
are best read immediately before editing. Deliverables and interfaces are fixed:

**Phase 2 — Analytics grouping (visible win in `/leverantorer`).**
- Modify `src/vendor-analytics.js`: group rollups by `resolveCompany(name)?.canonical ?? canonicalVendorName(name)` so NE/ILT/Tieto fragments collapse to one company each with products nested; channels render as channels.
- Tests: a rollup fixture where `NE`, `NE Nationalencyklopedin`, `NE.se` collapse to one row.
- Deliverable: `/leverantorer` shows one company per real vendor.

**Phase 3 — Coverage facts + KB-grounded LLM draft.**
- Create `src/coverage.js`: `buildCoverageFacts(conv, db) → { received:[{slug,canonical,role,via,products}], channels_seen:[slug], not_yet_seen:[slug], stage }`, deterministic over delivered attachments/vendors via `resolveCompany`.
- Modify the missing-contracts draft path (`src/templates.js` `computeReceivedMissing`/`chooseDeliveryReply` + `src/analyse-message.js` draft prompt) to write the reply from those facts + the full KB, with the rules: never re-ask a received service; never request a channel's own contract; ask for real services/avrop behind channels.
- Tests: `buildCoverageFacts` replaying Borlänge (Magma delivered ⇒ Radish received, not in `not_yet_seen`; Adda/LäroMedia never listed as missing).
- Deliverable: re-draft the open Borlänge escalation correctly as the live check.

**Phase 4 — 3-stage engagement + completeness.**
- `src/storage.js`: append-only probes for `conversations.channel_probe_sent_at`, `conversations.crosscheck_sent_at`; new table `coverage_confirmations(conversation_id, company_slug, status, at)`.
- `src/templates.js`: `T_CHANNEL_AVROP` (Stage 2), `T_CROSSCHECK` (Stage 3, names watchlist + key not-yet-seen services, sent once).
- `src/tick.js`: stage selection from `buildCoverageFacts` + markers; record confirmations from cross-check replies; complete → `DONE` when every KB service is received-or-confirmed-absent.
- Tests: each stage fires once and sets its marker; completeness only on received-or-confirmed-absent.

**Phase 5 — KB digest in the extraction prompt.**
- Modify `src/analyse-contract.js`: inject a compact `COMPANIES`→products digest into the Opus system prompt, instructing product→parent-company attribution. Prompt text only — **no new json_schema union params** ([[anthropic-structured-output-union-limit]]).
- Tests: prompt-builder unit test asserts the digest is present and bounded in size.

## Self-Review

- **Spec coverage:** KB structure + resolver → Tasks 1–2. Watchlist-by-company → Task 3. Analytics dedup → Phase 2. Coverage facts + LLM draft (service/channel, no re-ask) → Phase 3. 3-stage funnel + confirmed-absent + completeness → Phase 4. Extraction digest → Phase 5. All spec sections mapped.
- **Placeholder scan:** Phase 1 tasks contain full test + implementation code and exact commands. Phases 2–5 are an explicitly-labeled roadmap (deliverables + interfaces fixed), not placeholder tasks — each gets full TDD steps when started.
- **Type consistency:** `resolveCompany` returns `{ canonical, slug, role, matchedAs, product? }` everywhere; `matchWatchlist(names): string[]` unchanged; `companyBySlug(slug)` used consistently; `buildCoverageFacts` shape fixed for Phases 3–4.
