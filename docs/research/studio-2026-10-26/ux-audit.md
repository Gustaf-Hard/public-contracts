# Dashboard UX audit: groundwork for the "data studio" redesign

Date: 2026-10-26. Code: `/Users/gustafhard/Projects/mmc-priced` (HEAD 9924afb). Data: copy of `snap2.db`
(1676 avtal, 185 kommuner with avtal, 290 enrolled). Rendered with `createDashboardApp` and served
statically; screenshots at 1440x900 unless noted, in
`/Users/gustafhard/Projects/mediagraf-municipal-contracs/.playwright-mcp/ux/`.
Rendered HTML: `/private/tmp/claude-501/-Users-gustafhard-Projects-mediagraf-municipal-contracs/7d270309-5efe-4914-a255-042a2ed94450/scratchpad/ux/html/`.

Overall diagnosis: the product is good data presented as an admin console. Every page is
`h1 + row of stat cards + full-width table`. One font size range (11 to 24 px), one accent (indigo),
uppercase grey table headers, pills everywhere. Nothing tells a story, nothing compares, and there is
one chart in the whole app (`/takt`, back office). The market pages and the back office share one sidebar,
so a customer would see "Eskaleringar 163" and "daemon blind" next to market data.

---

## 1. Page by page

### `/` Översikt (back office) — `oversikt-top.png`
- Shows: 7 stat cards (Behöver dig, Pausade, Aktiva, Levererar, Klart, Avtal mottagna, Snittsvarstid),
  Behöver dig queue (163), Pausade (42), Pågår, then a 290-row kommun table. 430 KB HTML, 19 500 px tall.
- Valuable: the queue. Stays internal.
- Noise for a customer: all of it. Snittsvarstid card shows only "—" with no explanation.
- Problems: all queue reasons in red (red loses meaning when 163 rows are red); Pausade notes are raw
  operator English in red paragraphs; the 290-row table below a 163-row queue is unreachable.

### `/kommun/:kod` (1440 Ale; 1489 rendered too) — `kommun-1440-top.png`
- Shows: left sticky card (KPIs about ärenden, completeness banner, Nästa steg, Personer with staff
  emails/phone, Leverantörer list with doc counts, e-postadresser, snabbåtgärder), right: Trådar, Mottagna dokument.
- Valuable for the market product: the vendor list (14) and the avtal behind it. Nothing else.
- Noise/risk: staff names, emails and phone numbers (PII) and threads. Must never reach the customer view.
- Problems: no money anywhere (what does Ale spend, on what, vs peers?); left card starts ~50 px lower
  than right column (misaligned tops); date column wraps ("2026-\n06-23"); vendor list is plain text with
  📄 counts, not linked to price or renewal. **This is the page kommun buyers would live on, and it has zero
  of what they want** ("do I pay the right price, what alternatives exist").

### `/leverantorer` — `leverantorer-top.png`, mobile `leverantorer-mobile.png`, `leverantorer-mobile-table.png`
- Shows: 5 KPI cards (197 leverantörer, 185 kommuner, 1676 avtal, 250 mkr/år known for 1049 of 1676,
  308 renewals in 12 mo), category filter pills, market table (company, kategori chip, kommuner, avtal,
  känd årskostnad with "(n av N kända)", prismodell, product chips +N, nästa förnyelse + pill).
  169 KB HTML, 12 600 px tall.
- Valuable: the rollup itself, the completeness notes (good honesty), categories, renewal date.
- Noise: product chip clouds ("Adobe, Google Education Plus Edition, +13 till") in a ranking table;
  the 1-row-tall "Utan kategori 129" pill (2/3 of vendors uncategorised) is shown as a normal filter.
- Problems: the money column wraps into 2-3 lines ("30 867 190 kr/år (158 av 190 kända)"); full-kronor
  precision on a market overview; no share-of-market visual (bar in cell would do it); renewal pills are
  red for "inom 3 mån" on almost every row, so red means nothing; "Återförsäljare" (Insight) ranks #1 by
  value, mixing channels with makers. Counts disagree across pages: 197 leverantörer here vs
  227 on `/avtal` (company grouping vs raw rows).
- Mobile (390 px): table is 1605 px wide inside `main { overflow-x: hidden }` plus `table { overflow: hidden }`,
  so every column after the name is **clipped and unreachable**. The stacked nav takes ~210 px of 844.

### `/leverantor/ilt` (vendor dossier) — `leverantor-ilt-top.png`, `-coverage.png`, `-renewals.png`, `-contracts.png`, `-dark.png`
- Shows: 7 KPI cards (121 kommuner, 190 avtal, 30,9 mkr/år, snitt 255 tkr/kommun, median 36 mån,
  pris per elev 36,66–104,9 kr, nästa förnyelse), Produkter table (18), Täckning per skolnivå matrix,
  Förnyelsekalender (flat list, ~118 rows), Avtal per kommun (190 rows). 420 KB, 27 600 px tall.
- Valuable: this is the strongest page. Price per elev range, per-product kommun counts, grade coverage,
  renewal list. It is the seed of the vendor product.
- Noise: "0 kr – 668 678 kr per kommun" — a min–max of absolute kommun totals is meaningless (Stockholm vs
  Bjurholm), and 0 kr lower bounds read as "free". Duplicate products: "Aski Raski"/"AskiRaski",
  "Studiestöd på Modersmål"/"…modersmål" (catalogue work pending, per HEAD commit message).
- Problems: coverage matrix is glyph soup (◐ ? ● × –) on pastel cells with a 3-line legend paragraph that
  collides with the table bottom; renewal "kalender" is a list, not a calendar or timeline; the contracts
  table wraps every cell (dates on 3 lines, "kr/\når", lifecycle pill as a 4-line blob, "🛒 via ramavtal:
  Skolon" pill wrapping inside the kommun cell); Källa column spends 30% of width on filenames.
  Dark mode works only via the toggle (see §3).

### `/leverantor/ilt/produkt/inlasta-laromedel` — `produkt-top.png`
- Shows: "18 av 32 klara kommuner har produkten — 153 dolda", kommun × grade matrix with ●/×/? and
  🛒 ramavtal pills.
- Valuable: honest unknown vs no (grey ? vs red ×) — exactly the data-honesty ethos.
- Missing: **no price at all on the product page**, no price per elev distribution, no renewals,
  no competitors. Title "Inlästa läromedel — ILT · täckning per kommun" is a sentence, not a header.
- Problems: the useful insight (where it is NOT sold = white spots) needs reading 32 rows of glyphs;
  a map or a ranked "white spot" list would answer it in one look.

### `/avtal` (explorer) — `avtal-top.png`
- Shows: 9 filter controls (search, län, leverantör 199 options, prismodell, årskostnad band, längd,
  förnyelse, produkt with **1214 options**, gruppera efter) and a 1676-row table, plus the same facts as
  embedded JSON for `explorer.js`. **2.3 MB HTML, 103 000 px tall.**
- Valuable: the slicing logic (`explorer-core.js`: bands, renewal windows, grouping, aggregates).
  The summary line "1676 avtal · summa 250 mkr/år (känd för 1049 av 1676 avtal)" is the right idea.
- Noise: default sort puts "okänd" vendor rows with "—" products first; four "okänt" in a row.
- Problems: no visual result for a grouping (grouping should yield bars, not more rows); 1214-option select
  is unusable; the page ships every row twice (HTML + JSON).

### `/ramavtal/atea` (and `/ramavtal/adda`) — `ramavtal-atea-top.png`
- Shows: one explanatory sentence, 55 kommun chips, 19 "leverantörer" as a bullet list.
- Valuable: the honest framing sentence; the concept (channel as an entity).
- Problems: vendor list is raw extracted text, not KB-resolved: "ATEA", "Teams", "Microsoft",
  "Microsoft 365", "digitala läromedel", "digitala verktyg utan eget avtal", "Prorenata"/"Prorenata AB".
  Kommun chips are not links to anything market-related. No value, no period, no share. Half the page is empty.

### `/takt` (back office) — `takt-top.png`
- Shows: the only charts (weekly bars + cumulative line, two stacked panels, HTML hover columns) and a weekly table.
- Valuable: the two-panel pattern and the no-JS hover layer (`velocityChart`, `.ch-hover/.ch-col/.ch-tip`).
- Problem worth fixing before reuse: SVG has `viewBox 0 0 720 …` and `width:100%`, so at 1200 px content
  width every label scales ~1.65x (tick text renders ~18 px, bars get chunky). Charts must not scale text
  with width (see §3).

### `/pipeline` (back office) — `pipeline-top.png`
- Kanban of 290 kommuner across 7 stages; columns clip at viewport height with no count of hidden cards.
  Internal only; fine as is apart from the clipping.

---

## 2. Data available per entity

All market data flows through one pipeline in `src/dashboard.js` `vendorData(now)`:
`db.listContractFacts()` → `buildContractFacts(rows, { lanByKommunKod, now })` → rollups. It is recomputed
per request (fast enough at 1.7k contracts; cache per process if pages multiply).

**Contract fact** (`buildContractFacts`, src/vendor-analytics.js:240): `contract_id, vendor_id,
vendor_name, vendor_slug, company_name, kommun_kod, kommun_namn, lan, annual_value_sek (null = unknown),
one_time_value_sek, pricing_model, unit_price_sek, unit, quantity, value_incl_moms, avtalsvarde,
period_start, period_end, contract_length_months, auto_renews, next_review_date, products[] (canonical),
attachment_id, filename, received_at`.
Completeness in snapshot: annual value known 1049/1676; `pricing_model` unknown 683; `unit_price_sek`
known ~600. Line items: 2407 rows (`product_name, unit_price_sek, unit, quantity, period_months,
amount_sek`). Coverage: 9139 rows (`product_name, grade_level, status, student_count`), student_count
known 4992.

### Kommun
- Exists: `data/municipalities.json` (290: `kommun_kod, kommun_namn, lan, folkmangd, org_nr, webbplats`);
  facts filtered by `kommun_kod`; `db.listContractsForKommun`; `db.listKommunerWithContracts()`
  (`collection_done`, `reseller_channels`); `db.listResellerRelationsForKommun`;
  `computeKommunReview` (src/contract-lifecycle.js) for review dates; coverage rows give student counts per
  contract/grade.
- Gaps: no kommun spend rollup (sum known annual value, by category); **no peer group** (folkmängd
  band is derivable now; SKR kommungruppsindelning would need a static CSV added); **no elevantal per kommun**
  (only per-contract `student_count`, 55% filled) so price per elev for a kommun is not computable
  generally — Skolverket/SCB elevstatistik as a static CSV would unlock it; no geo shapes; no
  "alternatives in same category" query (derivable from facts + KB category).

### Leverantör (company)
- Exists: `buildVendorRollups(facts)` (vendor-analytics.js:345) → `vendor_name, vendor_slug, category,
  contract_count, kommun_count, total_annual_sek, value_known_count, pricing_model_mix,
  dominant_pricing_model, avg_length_months, median_length_months, length_known_count,
  price_per_student_min/max, avg_annual_per_kommun, products[], next_renewal_date`;
  `companyFacts(facts, name)`; `buildMarketSummary` (`vendor_count, kommun_count, contract_count,
  total_annual_sek, value_completeness`); KB `resolveCompany`, `CATEGORY_LABELS`, `role` (maker vs channel)
  in src/vendor-kb.js; `db.getVendorBySlug`, `db.listVendorsOverview`.
- Gaps: share of category (not computed, derivable); competitor overlap (kommuner that hold both A and B,
  or hold a category competitor instead — derivable); renewals bucketed by month (derivable from
  `next_review_date`); price per elev distribution (only min/max today; median/IQR needs the per-contract
  values, which exist); 129 vendors have no KB category; history/churn is not tracked (only current contracts).

### Product
- Exists: `buildProductRollups(facts, lineItems, coverage, { doneKods, resellerKods })` (vendor-analytics.js:441)
  → per product `name, kommuns[], price by kommun (amount_sek, null = ospecificerat), priceRange,
  dominant pricing model, coverage per kommun/grade with aggregate full/partial/none/unknown/na`;
  `buildProductCoverageByKommun` (→ `rows[{ kommun, grades, collection_done, reseller_channels }],
  summary { kommun_total, kommun_with_product }`); `slugifyProductName`; `canonicalProductName` (KB).
- Gaps: **price is a kommun total, not normalised** — needs `amount_sek / student_count` (coverage) or
  line-item `unit_price_sek` per `unit` to compare; duplicate/noisy names (1214 distinct strings in the
  explorer select; catalogue work pending); no product-level renewal or competitor view; product page has
  no price.

### Category
- Exists: `CATEGORY_LABELS` (10 categories: läromedel, lärplattform, skoladministration, stödverktyg,
  prov, bedömning, elevhälsa, integration, konsultbolag, övrigt) + `återförsäljare`; `rollup.category`;
  `/leverantorer?kategori=` filter.
- Gaps: no category page and no category aggregates (total value, vendor shares, median price per elev,
  kommuner with zero vendors in category = white spots). All derivable from facts + rollups.

### Ramavtal / återförsäljare
- Exists: `RESELLERS`, `resellerBySlug`, `matchResellers` (src/resellers.js); `db.listResellerRelations()`
  (`vendor, ramavtal` from analysis_json); kommun `reseller_channels`.
- Gaps: vendor names not run through `resolveCompany` (raw strings shown); no ramavtal value, period,
  terms; coverage cannot say "has product via channel", only "may".

---

## 3. Technical constraints and reusable building blocks

Hard constraints a redesign must respect:
- **No build, no CDN.** Server-rendered HTML strings in `src/dashboard-views.js` (3483 lines, one
  `baseCss` template ~600 lines at lines 243–852, 48 inline `style=` attributes). Static files from
  `public/`. Fonts or map geometry can be added as static files under `public/` (allowed; not a CDN).
- **Pane swap** (`public/app.js` `loadPane`): links with `data-pane-link` fetch `?partial=1` and set
  `#content.innerHTML`. Inline `<script>` in the fragment never runs. Any interactivity is either
  CSS-only, native HTML (`<details>`, `popover`, `<dialog>`, forms), or an ES module that `app.js`
  re-inits after each swap (pattern: `initExplorerIfPresent` → `import('/explorer.js')`).
  `layout({ partial })` returns only the body for partials, so page-level CSS must live in `baseCss`.
- **Charts are server-rendered inline SVG**, hover via HTML overlay columns + CSS (`.ch-hover`,
  `.ch-col`, `.ch-tip`) or `<title>`. Never dual-axis. Marks use `--chart-series`; any new chart colour
  must pass `node scripts/validate_palette.js "<hex>" --mode <light|dark> --surface <hex>` in the dataviz
  skill. Gaps stay visible; every figure carries n; unknown is `—`/grey, never 0.
- **Themes:** tokens in `:root` (light) and `:root[data-theme="dark"]`. Bug: there is **no
  `prefers-color-scheme` rule** — the OS setting is ignored (verified: emulated dark still renders
  `#f7f8fa`); the comment at views ~line 385 claims otherwise. Toggle stores `''` or `'dark'` in
  `localStorage['pilot-theme']`. Many colours are hardcoded hex+alpha (`#22c55e1a`, `#ef444466`) outside
  the tokens.
- **Mobile:** one breakpoint (760 px) stacks the sidebar; `main { overflow-x:hidden }` and
  `table { overflow:hidden }` clip wide tables with no scroll (verified on `/leverantorer`).
- Honesty rules (memory `data-honesty-ethos`): completeness shown everywhere, unknown ≠ red, null not 0,
  reseller kommuner never anchor red.
- `src/dashboard.js` and `/kommun/:kod` mix PII and back office; a customer view needs separate routes and
  a separate layout (no heartbeat pill, no escalation badge, no health modal).

Reusable as is:
- Tokens `--bg, --bg-elev, --bg-elev-2, --fg, --fg-muted, --border, --accent, --good/warn/bad,
  --chart-series, --r-1..3, --sp-1..6, --shadow`.
- `velocityChart` two-panel + hover overlay pattern (fix label scaling first).
- `explorer-core.js` (pure, tested): `valueBand, lengthBand, renewalWindow, deriveOptions, applyFilters,
  groupFacts, aggregateFacts` — reusable client side and server side.
- `.cov-*` five-state coverage semantics (full/partial/none/unknown/na) — keep the semantics, change the visual.
- `completenessLine(known, total, what)`, `fmtSekCompact`, `pricingModelBadge`, `renewalCell`.

---

## 4. Design system refresh: "Mediagraf Studio"

Goal: every page reads as an analysed answer first and evidence second. Rule: **no page opens with a
table.** Each page opens with an entity header and a visual (strip plot, bar ranking, timeline, map),
then one or two curated comparison tables, then raw evidence behind a fold. Tables never exceed ~8
columns, never wrap numbers, and always carry an in-cell visual (bar, dot, spark) for the main measure.

### 4.1 Identity
- Mood: editorial market report (think FT/Bloomberg data pages), not admin. Warm paper surfaces, ink text,
  one confident accent, serif display numbers and titles, sans for UI and tables.
- Fonts (self-hosted in `public/fonts/`, OFL, Latin subset, `font-display: swap`, ~60–90 KB each):
  - Display: **Fraunces** variable (opsz, wght) or **Source Serif 4** — entity names, big KPI numerals.
  - UI/data: **Inter** variable with `font-feature-settings: "tnum","ss01","cv11"` — tables, labels.
  - Fallbacks: `ui-serif, Georgia` / `system-ui`. No CDN, served by Express static.
- Signature motifs: a thin 3 px accent rule on top of every entity header; numbers set large in serif
  with a small sans unit ("30,9 mkr/år"); every number has a sub-line in muted sans with its n
  ("känd för 158 av 190 avtal"); a hatched pattern for "unknown/too few" used consistently everywhere.

### 4.2 Tokens (inline CSS)
```css
:root {
  /* surfaces */
  --bg: #f6f4ef;  --surface: #fffdf9;  --surface-2: #f0ede6;  --surface-3: #e7e3da;
  --ink: #16181d; --ink-2: #4a4f59; --ink-3: #7b808a;   /* text tiers */
  --line: #e2ddd2; --line-strong: #cfc8ba;
  /* brand */
  --accent: #0e6e6a;        /* deep teal, links + focus */
  --accent-ink: #ffffff; --accent-wash: color-mix(in oklab, var(--accent) 10%, var(--surface));
  /* semantic (status only, never decoration) */
  --pos: #2f7d3a; --caution: #b26a00; --neg: #b3261e; --unknown: #8a8f98;
  /* data viz: validate each with scripts/validate_palette.js before shipping */
  --viz-1: #0e6e6a; --viz-2: #c2410c; --viz-3: #4f46e5; --viz-4: #a16207; --viz-5: #7c3aed; --viz-other: #b9b3a6;
  --viz-seq-0: #eef5f4; --viz-seq-1: #c7e3df; --viz-seq-2: #8cc6bf; --viz-seq-3: #3f9a91; --viz-seq-4: #0e6e6a;
  --viz-highlight: #c2410c;   /* "you are here" kommun / selected entity */
  --hatch: repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--ink-3) 22%, transparent) 4px 5px);
  /* type */
  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-ui: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --t-xs: 12px; --t-sm: 13px; --t-md: 15px; --t-lg: 18px; --t-xl: 24px; --t-2xl: 32px; --t-3xl: 44px; --t-4xl: 60px;
  /* space (4-pt) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 32px; --s-7: 48px; --s-8: 64px;
  --r-1: 6px; --r-2: 10px; --r-3: 16px;
  --shadow-1: 0 1px 0 rgba(22,24,29,.04), 0 1px 2px rgba(22,24,29,.06);
  --shadow-2: 0 8px 24px -8px rgba(22,24,29,.18);
  --ease: cubic-bezier(.2,.7,.2,1); --dur: 180ms;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark set below */ } }
:root[data-theme="dark"] {
  --bg: #0f1113; --surface: #16191c; --surface-2: #1d2125; --surface-3: #262b30;
  --ink: #ece9e2; --ink-2: #b7b3aa; --ink-3: #868a91; --line: #2a2f35; --line-strong: #3a4047;
  --accent: #4fb3a9; --accent-ink: #0f1113;
  --viz-1: #3aa59a; --viz-2: #f07a3c; /* …re-validate every dark step against #16191c */
}
```
Dark set is duplicated into the `prefers-color-scheme` block (fixes the current OS-ignore bug); the
toggle must store `'light'` explicitly so `:not([data-theme="light"])` can opt out. Replace every
hardcoded `#22c55e1a`-style colour with `color-mix(in oklab, var(--pos) 12%, transparent)`.

Type roles: page title `--t-3xl/1.05 display 600`; entity KPI numeral `--t-2xl display 500 tnum`;
section title `--t-lg ui 600` with `--t-sm ink-3` kicker above (sentence case, not ALL CAPS);
body `--t-md/1.5`; table `--t-sm tnum`; meta `--t-xs ink-3`. Drop uppercase letter-spaced labels except
a single kicker style.

Layout: content max 1280 px, 12-col CSS grid, gap `--s-5`; sections separated by `--s-7`.
Container queries (`container-type: inline-size` on cards) let KPI rows and charts reflow without page
breakpoints. Breakpoints: 1100 (two-column → one), 760 (phone: bottom tab bar instead of stacked
sidebar, 16 px gutter). Tables on phone become stacked "row cards" (`display:grid` per row, `td::before
{ content: attr(data-label) }`), never clipped; wide matrices get an `overflow-x:auto` wrapper with a
sticky first column and an edge fade showing more to scroll.

### 4.3 Components
1. **Entity header** — kicker (type: Leverantör · Läromedel / Kommun · Västra Götalands län), serif
   name, one-line answer sentence generated from data ("Säljs till 121 av 185 kommuner vi har avtal från,
   30,9 mkr/år känt"), right side: 3 facts + a mini sparkline or share bar; 3 px accent rule on top;
   background `--surface` with a subtle radial `--accent-wash` in the top-right corner.
2. **KPI tile** — label (sm, ink-2), numeral (serif 2xl), unit (sans sm), n-line (xs, ink-3), optional
   micro-viz (40 px sparkline or bullet bar vs market median). States: known / partial (numeral + amber
   "känd för 12 av 40") / unknown (hatched tile, "—", one line why). Max 4 per row; no tile is ever just "—"
   without a reason.
3. **Price strip plot** (the hero chart for both customers) — horizontal axis kr per elev (or per user/
   year), one dot per kommun, grey band = IQR, tick = median, highlighted dot + label for the viewing
   kommun or selected vendor; n and "kommuner utan känd pris: 14" under it. Server SVG with fixed
   pixel height and HTML labels (no text scaling). Hover: `<title>` per dot plus CSS enlarge.
4. **Segment price matrix** — rows = kommun size band (folkmängd: <10k, 10–25k, 25–50k, 50–100k, >100k;
   later SKR kommungrupp), columns = category or product or grade band; cell = median price per elev
   (serif), n under it, background on `--viz-seq-*` scale by median; n < 3 → hatched, "för få avtal (2)".
   Hover/focus cell opens a native `popover` listing the kommuner and values. Pure CSS grid, no table tag.
5. **Competitor table / ranking** — per category: rank, company, share-of-known-value bar (in-cell div,
   width %), kommuner (with bar), median price per elev with mini range, dominant model as a quiet text
   label, next renewal as relative ("om 2 mån"). Max 7 rows + "Övriga 23 leverantörer" fold. Selected
   entity row highlighted with `--viz-highlight` left rule.
6. **Renewal timeline** — 24-month horizontal axis, one lane per vendor (or per kommun on a vendor page),
   dots at `next_review_date`, size = known annual value (hatched outline if unknown), a "idag" line;
   month buckets summarise counts on top. Replaces the 118-row list.
7. **Coverage heat strip** — keep the five states but draw them as solid/half/hatched/empty squares in
   a dense grid (12 px cells, gap 2 px), legend as 5 inline swatches, not a paragraph. Product rows sorted
   by kommun count with a count bar.
8. **Map** — feasible without CDN: ship `public/geo/kommuner.svg` (290 kommun paths simplified once offline
   with mapshaper from Lantmäteriet/SCB open boundaries, ~150–250 KB, cached), and have the server inline
   it with `fill` per `data-kod` via a CSS class per bucket (`.k-has`, `.k-none`, `.k-unknown` hatched,
   `.k-reseller`). Uses: white spots for a product, vendor footprint, kommun "you are here" among peers.
   Cheaper fallback with no geometry licence question: a 21-län tile grid or a 290-cell kommun tile
   cartogram (grid positions in a JSON file). Recommend tile grid first, real map second.
9. **Filters bar** — sticky under the header: segment chips (kategori, storlek, län), a typeahead built on
   native `<input list>` + `<datalist>` instead of 1214-option selects, active filters as removable chips,
   result line "412 avtal · 98 mkr/år känt för 260". GET params so it works with the pane swap and with
   no JS.
10. **Empty / uncertain states** — never a blank area. Pattern: hatched panel + an icon-free sentence
    that says what we know and what is missing ("Vi har avtal från 3 av 12 kommuner i segmentet. Medianen
    visas när minst 3 har känt pris."), plus what the market looks like nearby (show the closest segment
    with data, labelled as such). For "insamling pågår": progress ring (SVG) "insamling klar för 32 av 185
    kommuner". Unknown stays grey/hatched; red only for confident "not sold" per the ethos.
11. **Evidence drawer** — the raw contract rows (kommun, period, value, model, källa PDF) live under a
    `<details>` "Visa underlag (190 avtal)" at the bottom of each page, paginated server-side (50 per
    page), dates on one line (`white-space:nowrap`), filename shown as an icon link with the name in `title`.

### 4.4 Motion and hover (no framework)
- Page transitions: wrap the `innerHTML` swap in `document.startViewTransition` when available
  (progressive; one line in `loadPane`), with `view-transition-name` on the entity header so it morphs.
- Charts grow in on load via CSS keyframes (`transform: scaleY(0) → 1`, origin bottom, 400 ms, staggered
  with `animation-delay: calc(var(--i) * 20ms)` set inline per bar). Strip-plot dots fade in.
- Hover: rows lift to `--surface-2` with a 2 px accent left rule; chart marks enlarge 1.3x and dim
  siblings (`.chart:hover .mark:not(:hover) { opacity:.35 }`); tiles raise to `--shadow-2`.
- Details/popovers: native `popover` (+ `@starting-style` fade where supported).
- All behind `@media (prefers-reduced-motion: no-preference)`.
- Tabs within an entity page (Översikt / Priser / Konkurrenter / Förnyelser / Underlag) as plain links
  with `?flik=` so they work with pane swap and no JS.

### 4.5 Page plans: how each page avoids being a table dump
- **Start / Marknad** (new, customer landing): header with total known market value and completeness ring;
  category tiles (each: value, top 3 vendor share bar, median price per elev); renewal wave chart
  (contracts expiring per month, next 24 months); "Största rörelser" cards. Back office Översikt moves to
  `/intern`.
- **Kategori** (new): share-of-value ranking bars, segment price matrix (size band × top vendors),
  white-spot tile map (kommuner with no known vendor in category, hatched where collection unfinished),
  renewal timeline per vendor lane.
- **Leverantör**: entity header + 4 KPI tiles with micro-viz; price strip plot (kr/elev by kommun);
  product cards (not a table): each card = name, kommun count bar, median price/elev, coverage heat strip;
  footprint tile map; competitor table for its category; renewal timeline; evidence drawer.
- **Produkt**: header + price strip plot + segment matrix + footprint/white-spot map + "konkurrerande
  produkter i kategorin" + coverage grid + evidence. (Today it has no price at all.)
- **Kommun (customer view, new route, no PII)**: header (folkmängd, län, size band, peers); spend by
  category stacked bar vs peer median; per contract a "your price vs peers" strip with the kommun dot
  highlighted; "alternativ" list per category (other vendors used by peer kommuner, with their median
  price); renewal timeline for this kommun with "upphandla om X mån" cues; evidence. The current kommun
  page stays as `/intern/kommun/:kod`.
- **Ramavtal**: header (kommuner via channel, share of all data kommuner as a ring), tile map of member
  kommuner, KB-resolved vendor ranking reached through the channel; raw strings only in evidence.
- **Utforska (/avtal)**: filters bar on top; result is a chart first (grouped bar of value or count by the
  chosen "gruppera efter", with n), then a paginated table; do not ship 1676 rows + JSON in one page.
- **Partial-data pages** (a vendor with 1 avtal, a kommun with no avtal yet): header still full; tiles show
  hatched "—" with the reason; the segment/peer chart shows the market around it with the entity marked
  "ingen känd data än"; so the page still has a visual and still says something true.

### 4.6 Pre-work the redesign depends on
1. Normalised price: per-elev / per-user price per contract and per product (line-item `unit_price_sek`
   + `unit`, or `amount_sek / student_count`), with n.
2. Peer segmentation: folkmängd bands now; SKR kommungrupp + Skolverket elevantal as static CSVs in `data/`.
3. Product catalogue dedupe (Aski Raski/AskiRaski) and ramavtal vendor names through `resolveCompany`.
4. One vendor count definition across pages (197 vs 227).
5. Split routes/layouts: customer (`/marknad/...`) vs back office (`/intern/...`), no PII or daemon state
   in the customer layout.
6. Fix chart label scaling (fixed-height SVG + HTML axis labels, or render at measured container width
   buckets) before building new charts on the `velocityChart` pattern.
