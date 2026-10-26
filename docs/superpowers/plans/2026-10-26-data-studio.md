# Mediagraf Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate, modern market-intelligence studio under `/studio` built on a curated catalogue, fair kr/elev comparisons and answer-first pages.

**Architecture:** Three pure read-time layers (catalogue → kommun open data → studio facts/aggregates) feed server-rendered pages through a new studio layout and component library. Same Express app, same DB, no schema change; the back office is untouched apart from one nav link.

**Tech Stack:** Node 20 ESM, Express, better-sqlite3, server-rendered HTML strings, inline SVG charts, vitest. No build step, no CDN.

**Spec:** `docs/superpowers/specs/2026-10-26-data-studio-design.md`. Research: `docs/research/studio-2026-10-26/`.

## Global Constraints

- Work in worktree `/Users/gustafhard/Projects/mmc-studio`, branch `feat/studio`. Never touch the live DB, AWS, Gmail or Slack. Tests offline only (temp-dir SQLite, `openDb` + `migrate()`).
- **The GitHub repo is public.** Never commit data derived from the live DB (no snapshots, no per-kommun prices, no fixtures copied from real avtal). Test fixtures are hand-written. Open data and the catalogue (company/product names) may be committed.
- No build step, no CDN. Static assets only under `public/`. Fonts self-hosted (OFL), woff2, Latin subset.
- Pane swap: inline `<script>` in a page never runs; interactivity = CSS, native HTML (`details`, `popover`, GET forms) or an ES module initialised from `public/app.js`. Partial requests (`?partial=1` / `X-Partial: 1`) return the body only, so all studio CSS lives in the studio layout head.
- Charts: server-rendered inline SVG, never dual-axis, chart colours validated with `node <dataviz skill>/scripts/validate_palette.js "<hex,...>" --mode light|dark --surface <hex>` before shipping (dataviz skill dir: `/private/tmp/claude-501/bundled-skills/2.1.306/655c89b07f2e2f01a554e4154ae87548/dataviz`; load the `dataviz` skill before writing chart code).
- Honesty: unknown is never 0 and never red; every aggregate shows its basis; medians/percentiles/dots hidden when n < 5 (`MIN_N = 5`), with the reason shown; "no avtal" ≠ "collection open" ≠ "not contacted".
- No personal data in studio output: no staff names, emails, phone numbers, PDF filenames, thread text. Studio routes never link to back-office routes.
- Active avtal (headline figures): `period_end >= today`, or `period_end` null and `period_start` within the last 4 years. Newest avtal per kommun × company × product counts.
- All studio copy in Swedish, plain, sentence case, **no em-dash or en-dash characters** (use commas or "till").
- Every task: full suite `npx vitest run` green before commit. Commit per task with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A kommun with zero avtal, or never contacted, opened at `/studio/kommun/:kod` → full page with header, peers and category landscape, "vi har inte begärt ut avtal här än"; never a 500. (Task 7 test.)
2. Vendor/product names containing `<script>` or quotes from extraction → escaped everywhere, including SVG `<title>` and popovers. (Task 5 test.)
3. Exactly n = 4 vs n = 5 priced avtal → 4 renders the hatched "för få avtal (n = 4)" panel with no dots; 5 renders the plot. (Task 3 + Task 5 tests.)
4. `student_count` 0 or null, or Skolverket elever missing for a segment → `kr_per_elev` null, never Infinity/NaN in output. (Task 3 test.)
5. Pane-swap navigation inside the studio (`?partial=1`) → body only, no `<html>`, no back-office sidebar, charts still render. (Task 4 test.)

---

### Task 1: Catalogue module

**Files:**
- Create: `src/catalogue-def.js` (ported from `docs/research/studio-2026-10-26/catalogue-def.mjs`; keep the doubts as comments, apply spec §6.1 decisions)
- Create: `src/catalogue.js`
- Test: `tests/catalogue.test.js`

**Interfaces:**
- Produces (from `src/catalogue.js`):
  - `normName(s: string): string` (lowercase, å/ä→a, ö→o, é→e, ü→u, non `[a-z0-9]` runs → one space, trimmed)
  - `classifyVendor(raw: string|null): { slug, canonical, role: 'service'|'channel', category } | null`
  - `classifyLine(ownerSlug: string|null, raw: string): { kind: 'product'|'addon'|'discount'|'segment'|'noise'|'bundle'|'unresolved'|'uncatalogued', companySlug: string|null, productSlug: string|null, products?: string[], addonType?: string }`
  - `companies(): Company[]`, `companyBySlug(slug): Company|undefined`, `productBySlug(slug): { product, company }|undefined`, `CATEGORIES: { slug, label }[]` (läromedel, lärplattform, skoladministration, prov, stödverktyg, elevhälsa, övrigt)
  - `Company = { slug, canonical, role, category, website, products: { slug, name, category, whatItIs, editions?: string[] }[], singleProduct?: string, defaultProduct?: string, hiddenInStudio?: boolean }`
- Rules: exactly the order in `catalogue.md` "Regler, i den ordning de körs" (13 rules); port `build.mjs` classification logic into `classifyLine`.

- [ ] **Step 1: Write failing tests** in `tests/catalogue.test.js`:
  - `classifyVendor('ILT Inläsningstjänst').slug === 'ilt'`, `classifyVendor('Matteappen').slug === 'radish'`, `classifyVendor('Skola24').slug === 'nova-software'` (use the slug the def file assigns), `classifyVendor('Okänd Firma AB') === null`.
  - `classifyLine('ilt','Polyglutt skola F-3')` → `{ kind:'product', productSlug: <Polyglutt slug> }`; `'Polyglutt förskola Huvudmannalicens'` → same product; `'Rabatt 3-årsavtal'` → `kind:'discount'`; `'Införande Edlevo elevregister förskola'` with owner tietoevry → `kind:'addon'`; `'Kommunlicens'` with owner haldor → `kind:'segment'`.
  - Binogi: `'Binogi.se årskurs 7-9'`, `'Språkprojektet'` → product Binogi.
  - Owner-agnostic brand match: `classifyLine('skolon','Polylino')` → `companySlug:'ilt'`, product Polylino.
  - Renames: `classifyLine('tietoevry','Procapita')` → product Edlevo; `classifyLine('radish','Matteappen')` → Magma.
  - Product lists are short: `companyBySlug('ilt').products.length <= 10`, `companyBySlug('tietoevry').products.length <= 3`.
  - No product name in any company contains a segment word: for every product, `!/förskola|skola\b|f-\d|huvudmannalicens|kommunlicens|årskurs|\båk\b/i.test(name)`.
  - KB consistency: every `COMPANIES` entry in `src/vendor-kb.js` resolves via `classifyVendor(kb.canonical)` to a company (list exceptions explicitly in the test with a reason if any).
- [ ] **Step 2: Run** `npx vitest run tests/catalogue.test.js` → FAIL (module missing).
- [ ] **Step 3: Implement** `src/catalogue-def.js` and `src/catalogue.js` per Interfaces. Apply spec §6.1 doubts: merges 1–11 applied, 12–15 separate, item 24 → `hiddenInStudio: true`.
- [ ] **Step 4: Run** the test file → PASS; then `npx vitest run` → all green.
- [ ] **Step 5: Commit** `feat(studio): curated vendor and product catalogue`.

### Task 2: Kommun open data and tile grid

**Files:**
- Create: `scripts/16-fetch-kommun-stats.js` (network; not run in tests)
- Create: `data/kommun-stats/kommun-stats.json` (generated by the script, committed), `public/geo/kommun-tiles.json` (generated, committed)
- Create: `src/kommun-stats.js`
- Test: `tests/kommun-stats.test.js` (uses an injected hand-written fixture, not the committed file)

**Interfaces:**
- `kommun-stats.json` shape: `{ fetched_at, sources: { [key]: url }, laar: '2025/26', kommuner: { [kod]: { folkmangd, lan, kommungrupp: string|null, peers: string[] (kods), elever: { 'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux' } (numbers or null; kommunal regi) } } }`. Grade keys exactly match `GRADE_LEVELS` in `src/vendor-analytics.js`.
- `kommun-tiles.json`: `{ cols, rows, tiles: { [kod]: { x, y } } }`, 290 kods, no two at the same `x,y`.
- Produces (from `src/kommun-stats.js`):
  - `loadKommunStats({ path? , data? } = {}): KommunStats` (memoised; `data` injection for tests)
  - `KommunStats.get(kod) → { kod, namn, lan, folkmangd, sizeBand, kommungrupp, peers, elever }`; `sizeBand` from folkmängd: `'<10k'|'10-25k'|'25-50k'|'50-100k'|'>100k'` (ASCII keys; UI labels like `'10 till 25 tusen invånare'`)
  - `KommunStats.peersOf(kod) → string[]`: kommungrupp members, else same `sizeBand`, excluding `kod`
  - `KommunStats.eleverIn(kod, grades: string[]) → number|null` (null if any requested grade is null)
  - `KommunStats.all() → array`

- [ ] **Step 1: Failing tests**: `peersOf` uses kommungrupp when present and falls back to size band; `eleverIn('0001',['4-6','7-9'])` sums; returns null when one grade is null; `sizeBand(9999) === '<10k'`, `sizeBand(10000) === '10-25k'` boundary.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `src/kommun-stats.js`. Write `scripts/16-fetch-kommun-stats.js` using the sources and endpoints in `docs/research/studio-2026-10-26/kommuner.md` §2 (SIRIS export 6 per årskurs summed to bands, export 57 gymnasiet, PxWeb/Kolada for förskola, förskoleklass, komvux; Kolada groups G92786–G92794 for kommungrupp; Kolada "Liknande kommuner grundskola" for peers if fetchable; folkmängd from `data/municipalities.json`). Tile positions: fetch kommun centroids (e.g. Wikidata SPARQL P625 for Swedish municipalities by kommunkod P525), project to a grid of about 18×32, resolve collisions to the nearest free cell. Any source that fails → those fields null and the source URL recorded with `"status": "failed"`.
- [ ] **Step 4: Run** the script once (network): `node scripts/16-fetch-kommun-stats.js`. Expected: writes both JSON files; prints counts (290 kommuner, elever coverage per grade, kommungrupp coverage). Inspect a few known values (Göteborg grundskola elever in the tens of thousands).
- [ ] **Step 5: Run** `npx vitest run` → green. **Commit** `feat(studio): kommun open data (elever, kommungrupp, peers) and tile grid`.

### Task 3: Studio facts and aggregates

**Files:**
- Create: `src/studio-data.js`
- Test: `tests/studio-data.test.js`

**Interfaces:**
- Consumes: Task 1 `classifyVendor`, `classifyLine`, `companyBySlug`; Task 2 `KommunStats`; `db.listContractFacts()`, `db.listLineItems()`, `db.listCoverage()`, `db.listAllConversations()`.
- Produces:
  - `MIN_N = 5`
  - `buildStudioFacts({ contracts, lineItems, coverage, stats, today: 'YYYY-MM-DD' }) → StudioFact[]`; one row per avtal × owner company. `StudioFact = { contract_id, kommun_kod, kommun_namn, company_slug|null, company_name, channel_slug|null, category|null, product_slugs: string[], segments: string[], annual_value_sek|null, value_basis: 'stated'|'split'|'unsplit_channel'|null, pricing_model|null, period_start|null, period_end|null, next_renewal|null, active: boolean, superseded: boolean, elever_in_scope|null, kr_per_elev|null, kr_per_elev_basis: 'styckpris'|'avtalets_elevantal'|'skolverket'|null, attachment_id }`
  - `collectionStatus(conversations) → Map<kod, 'done'|'open'|'not_contacted'>` ('done' = ≥1 conversation and all DONE/DEAD_END)
  - `distribution(values: number[]) → { n, median|null, p25|null, p75|null, min|null, max|null, suppressed: boolean }` (suppressed when n < MIN_N; then all stats null)
  - `marketByCategory(facts) → [{ category, value_known_sek, n_avtal, n_known, kommuner, topCompanies: [{slug,name,share}] }]`
  - `companyShares(facts, { category? }) → [{ slug, name, value_known_sek, share_value, kommuner, share_kommuner, n_avtal, n_known }]` sorted by value then kommuner
  - `priceDistribution(facts, { productSlug?, category?, segment?, kommunKods? }) → distribution & { values: [{ kommun_kod, kr_per_elev }] }` (values empty when suppressed)
  - `renewalBuckets(facts, { today, months: 24 }) → [{ month: 'YYYY-MM', n, value_known_sek, byCategory }]`
  - `whiteSpots(facts, statusMap, { category }) → { has: kod[], none_done: kod[], none_open: kod[], not_contacted: kod[] }`
  - `coOccurrence(facts, companySlug) → [{ slug, name, kommuner }]` (other companies in the same kommuner)
  - `kommunProfile(facts, stats, kod) → { spendByCategory, peerMedianByCategory, overlaps: [{ category, companies }], renewals }`
  - `dataBasis(facts, statusMap) → { active, collected, kommuner_with_avtal, kommuner_total: 290, done }`

- [ ] **Step 1: Failing tests** (hand-written fixtures):
  - Channel split: one Läromedia avtal (value 100 000) with line items Polylino 30 000 and Magma 50 000 → rows for ilt (30 000, `split`), radish (50 000, `split`) and läromedia (20 000, `unsplit_channel`).
  - Active rule: period_end yesterday → `active:false`; null end + start 3 years ago → true; null end + start 5 years ago → false. Two avtal same kommun × company × product → older `superseded:true`, excluded from headline aggregates.
  - kr_per_elev: unit `elev` 120 → 120 `styckpris`; annual 100 000, coverage 4-6 with student_count 500 → 200 `avtalets_elevantal`; no student_count, stats elever 4-6 = 1000 → 100 `skolverket`; student_count 0 → null; no segments → null.
  - `distribution([1,2,3,4])` → `suppressed:true, median:null`; five values → median and quartiles.
  - `whiteSpots` separates the four buckets correctly.
  - Unknown vendor (vendor_id null) → `company_slug:null`, counted in category "okänd" only via `company_name: 'Okänd leverantör'`, never crashes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** file then full suite → green.
- [ ] **Step 5: Commit** `feat(studio): studio facts layer and aggregates`.

### Task 4: Studio shell, tokens, fonts, theming

**Files:**
- Create: `src/studio/layout.js`, `src/studio/css.js`, `src/studio/format.js`
- Create: `public/fonts/` (Fraunces variable + Inter variable woff2, OFL licence files)
- Create: `src/studio/routes.js` (mounted by `createDashboardApp`)
- Modify: `src/dashboard.js` (mount `mountStudio(app, deps)` before the 404s; add "Studio ↗" nav link in back-office `layout` in `src/dashboard-views.js`)
- Modify: `public/app.js` (wrap the innerHTML swap in `document.startViewTransition` when available; re-run `initExplorerIfPresent`; store theme `'light'` explicitly)
- Test: `tests/studio-shell.test.js`

**Interfaces:**
- `studioLayout({ title, body, currentPath, partial, basis }) → string`; nav: Marknad `/studio`, Kategorier `/studio/kategorier`, Leverantörer `/studio/leverantorer`, Kommuner `/studio/kommuner`, Förnyelser `/studio/fornyelser`, Utforska `/studio/utforska`; search form `GET /studio/sok` with `<input name="q" list="studio-search">`; footer with `basis` sentence and link `/studio/om`.
- `studioCss`: tokens exactly as `ux-audit.md` §4.2 (light, dark under `:root[data-theme="dark"]` AND `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {…} }`), type scale, 12-col grid, container queries, phone bottom tab bar at ≤ 760 px, table→row-card on phone, `.hatch` utility, motion behind `prefers-reduced-motion: no-preference`.
- `format.js`: `fmtKr(n)`, `fmtKrCompact(n)` ("30,9 mkr", "412 tkr"), `fmtInt(n)`, `fmtPct(x)`, `basisLine(known, total, noun)` → "känd för 41 av 63 avtal", `monthsUntil(date, today)` → "om 2 mån"; all return "okänt" for null.
- `mountStudio(app, { db, statsLoader, now })` registers all `/studio*` routes (later tasks add handlers to `routes.js`); handlers read facts via a per-request `getStudioData()` memoised on `db` + day.

- [ ] **Step 1: Failing tests**: `GET /studio` 200 contains `<nav` with the six labels and no "Eskaleringar", no `data-health-modal`, no `heartbeat`; contains `prefers-color-scheme: dark`; `GET /studio?partial=1` has no `<html` and no `<nav`; back-office `GET /` contains `href="/studio"`; studio HTML contains no `—` or `–` characters in copy (assert on a rendered page with test data); `fmtKrCompact(30_900_000) === '30,9 mkr'`, `fmtKr(null) === 'okänt'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (the `/studio` handler may render a placeholder body until Task 8). Fonts: download Fraunces and Inter variable woff2 from their official OFL repos (google/fonts on GitHub), commit with `OFL.txt`; `@font-face` with `font-display: swap`.
- [ ] **Step 4: Run** → green. **Step 5: Commit** `feat(studio): studio shell, Mediagraf Studio tokens, fonts, theming`.

### Task 5: Component library and gallery

**Files:**
- Create: `src/studio/components.js`, `src/studio/charts.js`
- Create: route `/studio/_komponenter` (gallery with hand-written demo data, every component in every state)
- Test: `tests/studio-components.test.js`

**Interfaces (all return HTML strings, escape every text input):**
- `entityHeader({ kicker, title, answer, facts: [{label, value, sub}], viz? })`
- `kpiTile({ label, value, unit?, basis, state: 'known'|'partial'|'unknown', reason?, spark?: number[] })`
- `stripPlot({ dist /* from priceDistribution */, highlightKod?, unit: 'kr/elev', label })` → hatched panel `för få avtal (n = N)` when `dist.suppressed`
- `segmentMatrix({ rows: [{key,label}], cols: [{key,label}], cell: (r,c) => dist })` → CSS grid, cell median + n, hatched when suppressed, native `popover` per cell
- `rankingBars({ items: [{ label, href, value, valueLabel, share, sub }], max: 7, highlight? })` + "Övriga N" fold
- `renewalTimeline({ lanes: [{ label, href?, items: [{ date, value|null, title, href? }] }], today, months: 24 })`
- `tileMap({ tiles /* kommun-tiles.json */, classOf: (kod) => 'has'|'none-done'|'none-open'|'not-contacted'|'highlight', titleOf: (kod) => string, legend })`
- `segmentStrip(segments: string[])` (the 7 grade levels as small filled/empty cells)
- `filterBar({ action, fields: [{ name, label, options, value }], resultLine })` (GET form, chips)
- `emptyPanel({ title, text, context? })`
- `evidenceDrawer({ rows: [{ kommun, period, value, model, pdfHref }], total, page, pageHref })`
- Hover detail for SVG: HTML overlay + CSS as `/takt` does; no inline scripts.

- [ ] **Step 1: Failing tests**: `stripPlot` with 4 values → contains `för få avtal (n = 4)` and no `<circle`; with 5 → 5 `<circle` and a median tick; names with `<script>"` are escaped in `rankingBars`, `tileMap` titles and `stripPlot` labels; `kpiTile({state:'unknown'})` contains the `hatch` class and the reason; `tileMap` renders 290 tiles from a 290-entry tile fixture; gallery route returns 200.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; load the `dataviz` skill first; validate `--viz-*` light and dark with the palette script and record the output in a code comment next to the tokens.
- [ ] **Step 4: Render the gallery** from a local snapshot copy (renderer pattern: `createDashboardApp({ db, env:{AUTH_ENABLED:'0'}, slackClient:null, gmailClient:{} })`, serve saved HTML on 127.0.0.1, Playwright screenshots under `/Users/gustafhard/Projects/mediagraf-municipal-contracs/.playwright-mcp/studio/`, light + dark + 390 px). Fix anything that looks broken, collides or clips.
- [ ] **Step 5: Run** suite → green. **Commit** `feat(studio): component library and gallery`.

### Task 6: Leverantör and Produkt pages, evidence route

**Files:**
- Create: `src/studio/pages/leverantor.js`, `src/studio/pages/produkt.js`
- Modify: `src/studio/routes.js` (`/studio/leverantor/:slug`, `/studio/produkt/:slug`, `/studio/underlag/:attachmentId`)
- Test: `tests/studio-pages-vendor.test.js`

**Interfaces:**
- `renderLeverantor({ company, facts, stats, statusMap, today, page })`, `renderProdukt({ product, company, facts, stats, statusMap, today, page })`.
- `/studio/underlag/:attachmentId` serves the same file as `/attachments/:id` with a code comment: operator-only; must be replaced by a redacted or metadata-only view before external access.
- Leverantör sections in order: header (category, kommuner, known annual value, share of category); product cards (name, whatItIs, kommuner bar, median kr/elev or hatched, segment strip); footprint tile map; price strip plot; "Konkurrerar med" (same-category companies in the same kommuner) and "Köps ofta tillsammans med" (co-occurrence); renewal timeline (lanes per kommun, next 24 months); channel split; evidence drawer (active first, then expired). Produkt: header (owner, category, whatItIs); strip plot per segment; segment matrix (peer kommungrupp × segment); footprint map; substitutes (same-category products with median kr/elev and kommuner); renewals; evidence.

- [ ] **Step 1: Failing tests** (temp DB, hand-written seeds): `/studio/leverantor/ilt` 200 shows product names from the catalogue only (no "skola F-3", no "Rabatt"), the kommun count, a tile map; no `@` email patterns and no PDF filename in the HTML; unknown slug → 404 studio page; a company with one avtal renders hatched tiles and the category context, not an empty page; `/studio/underlag/:id` returns the PDF bytes with `Content-Type: application/pdf`.
- [ ] **Step 2–4:** Run → FAIL, implement, run → green.
- [ ] **Step 5: Commit** `feat(studio): leverantör and produkt pages`.

### Task 7: Kommun page

**Files:**
- Create: `src/studio/pages/kommun.js`; Modify `src/studio/routes.js` (`/studio/kommun/:kod`)
- Test: `tests/studio-pages-kommun.test.js`

**Interfaces:**
- `renderKommun({ kod, stats, facts, statusMap, today })`.
- Sections: header (län, folkmängd, kommungrupp, elever F-9, collection status chip); "Så här köper ni" spend by category vs peer median (bars, hatched where suppressed); per active avtal a row "Ert pris vs liknande kommuner" (kommun's kr/elev as number, peers as anonymous strip only if n ≥ 5, else "för få jämförbara kommuner"); "Alternativ" per category (products peers use, median kr/elev, kommuner count); overlap warning when ≥ 2 active products in one category; renewal timeline with "upphandla om X mån"; tile map with this kommun highlighted among peers; evidence.
- Peers are never named on this page.

- [ ] **Step 1: Failing tests**: a kommun with avtal renders its own products and a peer comparison; peer kommun names do NOT appear in the HTML; a kommun not contacted renders 200 with `vi har inte begärt ut avtal här än` and the category landscape; collection-open kommun shows `insamling pågår`; unknown kod → 404.
- [ ] **Step 2–4:** Run → FAIL, implement, run → green. **Step 5: Commit** `feat(studio): kommun page`.

### Task 8: Kategori pages and Marknad landing

**Files:**
- Create: `src/studio/pages/kategori.js`, `src/studio/pages/marknad.js`; Modify `src/studio/routes.js` (`/studio`, `/studio/kategorier`, `/studio/kategori/:slug`)
- Test: `tests/studio-pages-market.test.js`

**Interfaces:**
- `renderMarknad({ facts, stats, statusMap, today, basis })`: header with known market value + completeness ring (active avtal, kommuner with avtal of 290); category tiles (value, kommuner, top-3 share bar, median kr/elev or hatched); renewal wave (24 months, the month 2027-01 annotated "Addas ramavtal Digitala läromedel 2022 löper ut 31 jan 2027"); "Största leverantörer" ranking; latest avtal received (kommun, company, date; no prices).
- `renderKategori({ category, facts, stats, statusMap, today })`: share ranking (value and kommuner); segment matrix (kommungrupp × segment, median kr/elev); pricing-model mix bar; white-spot tile map with the four classes and legend; renewal timeline per company lane; product cards in the category.
- `/studio/kategorier`: one tile per category with the same numbers as the landing.

- [ ] **Step 1: Failing tests**: `/studio` 200 shows the basis sentence with active and collected counts; the Adda annotation appears when the renewal window includes 2027-01; `/studio/kategori/laromedel` shows a ranking and a tile map whose legend has the four classes; unknown category → 404.
- [ ] **Step 2–4:** Run → FAIL, implement, run → green. **Step 5: Commit** `feat(studio): marknad landing and kategori pages`.

### Task 9: Förnyelser, Utforska, directories, search, Om datan

**Files:**
- Create: `src/studio/pages/fornyelser.js`, `src/studio/pages/utforska.js`, `src/studio/pages/lists.js`, `src/studio/pages/om.js`
- Modify: `src/studio/routes.js` (`/studio/fornyelser`, `/studio/fornyelser.csv`, `/studio/utforska`, `/studio/leverantorer`, `/studio/kommuner`, `/studio/sok`, `/studio/om`)
- Test: `tests/studio-pages-lists.test.js`

**Interfaces:**
- Förnyelser: GET filters `kategori, segment, lan, kommungrupp, kanal, man` (months ahead, default 18); chart (avtal ending per month by category) then list sorted by date: kommun, company, product(s), known value, end date. CSV: same rows, `;` separated, UTF-8 BOM, header in Swedish.
- Utforska: GET filters (reuse `public/explorer-core.js` `applyFilters`/`groupFacts` server-side on studio facts), grouping chart first, table paginated 50 per page (`?sida=`); HTML for page 1 under 300 KB with full data.
- Directories: Leverantörer = company cards grouped by category (hiddenInStudio excluded; uncatalogued under "Övriga" collapsed); Kommuner = tile map coloured by collection status + list (name, län, avtal, status).
- `/studio/sok?q=` → exact match redirects to the entity page; otherwise a results page with kommuner, companies and products.
- Om datan: collection method, coverage numbers from `dataBasis`, kr/elev method and bases, MIN_N rule, peer definition, update cadence; plain Swedish.

- [ ] **Step 1: Failing tests**: Förnyelser with `kategori=laromedel&man=12` lists only matching rows within 12 months; CSV starts with the BOM and `Kommun;Leverantör;`; Utforska page 1 has 50 rows and a link to page 2; `/studio/sok?q=Ale` redirects to `/studio/kommun/1440`; directory excludes a `hiddenInStudio` company.
- [ ] **Step 2–4:** Run → FAIL, implement, run → green. **Step 5: Commit** `feat(studio): förnyelser, utforska, directories, search, om datan`.

### Task 10: Visual QA pass

**Files:** any studio file needing fixes; no new features.

- [ ] **Step 1:** Render every studio route from a local snapshot copy (pages: `/studio`, `/studio/kategorier`, `/studio/kategori/laromedel`, `/studio/leverantorer`, `/studio/leverantor/ilt`, `/studio/leverantor/binogi`, a one-avtal company, `/studio/produkt/<polyglutt slug>`, `/studio/kommuner`, `/studio/kommun/1440`, a not-contacted kommun, `/studio/fornyelser`, `/studio/utforska`, `/studio/om`) in light, dark (OS preference, no toggle) and 390 px. Screenshots under `/Users/gustafhard/Projects/mediagraf-municipal-contracs/.playwright-mcp/studio/qa/`.
- [ ] **Step 2:** Check each against: no clipped tables, no horizontal page scroll on phone, no label collisions, no "NaN"/"Infinity"/"undefined"/"null" text, no em/en dashes, every number has a basis line, every page opens with a header and a visual, hatched states have a reason. Fix and re-shoot.
- [ ] **Step 3:** Grep rendered HTML of all pages for `@` addresses, phone-number patterns and `.pdf` filenames → none.
- [ ] **Step 4:** Full suite green. **Commit** `fix(studio): visual QA pass`.
