# Mediagraf Studio: the market view of Swedish school edtech contracts

Date: 2026-10-26. Status: design. Research behind it: `docs/research/studio-2026-10-26/`
(`vendors.md`, `kommuner.md`, `ux-audit.md`, `catalogue.md`, `catalogue-proposal.json`,
`catalogue-def.mjs`, `build.mjs`).

## 1. Intent

Mediagraf collects the real signed avtal between Swedish kommuner and edtech vendors through
offentlighetsprincipen. Today the dashboard is an operator back office (Behöver dig, ärenden,
drafts, Gmail) with a few market pages bolted on. The operator wants the market side to become a
real product: a **data studio** someone pays for, that looks modern and interesting on every page,
where every page answers a question you can act on.

Two customers, one core:

- **Edtech vendors**, especially companies that just launched a product: how big is my category,
  who holds which kommun, how do competitors price per segment, when do their avtal expire (the
  sales window), do kommuner buy direct or through Skolon/Läromedia/Adda/Atea, where are the
  white spots. (Ranked questions: `vendors.md` §3.)
- **Kommuner as buyers**: do we pay the right price compared with kommuner like us, which other
  products do the same thing, what do similar kommuner use, when should we tender.
  (Ranked questions: `kommuner.md` §4.)

Both need the same core: a clean catalogue (leverantör → products with a price → segments),
comparable prices per elev per segment, and time (renewals). The edge nobody else has: the source
avtal behind every number, and direct buys, call-offs and rektor purchases that tender-based tools
(Tendium, Mercell/Opic, Pabliq) never see.

Timing that makes this matter now: Adda's *Digitala läromedel 2022* ends 2027-01-31; about 70% of
kommuner must re-avropa under *Digitala läromedel 2026* from 2027-02-01.

## 2. Goals

1. A **separate studio** inside the existing app: its own routes (`/studio/...`), its own layout
   and navigation, no back-office content, no personal data.
2. A **curated catalogue** that reads every raw vendor and product name into: company, product,
   add-on, discount, segment or noise. Product lists are short, real product names only.
   Operator's rule: *a product is something with a price; products are sold to segments*.
3. **Comparable prices**: kr per elev per year where it can be computed honestly, with n,
   median and spread, peer groups ("kommuner som liknar oss"), and suppression below n = 5.
4. Seven studio pages, each opening with an answer and a visual (no page opens with a table):
   Marknad (landing), Kategori, Leverantör, Produkt, Kommun, Förnyelser, Utforska.
5. A new visual identity ("Mediagraf Studio") applied to the studio, modern and interesting in
   every state, including empty and partial data.

## 3. Non-goals (this round)

- Login, accounts, billing, multi-tenancy, a vendor "claiming" its company.
- Saved searches, alerts, CRM sync. (CSV download of a list is in scope if cheap; see §8.)
- A real geographic kommun map with boundary geometry (tile grid instead, §7.4).
- Clause extraction (exit terms, indexation), licence usage, school-level (skolenhet) mapping.
- Changing the extraction pipeline or the DB schema. The catalogue is read-time only, like
  `resolveCompany` today. (Recommended pipeline rules are recorded in `catalogue.md` for later.)
- Redesigning the back office. It keeps working unchanged; only a small "Studio" link is added
  to its nav, and the old market pages (`/leverantorer`, `/leverantor/:slug`, `/avtal`,
  `/ramavtal/:slug`, product pages) stay for the operator until the studio replaces them.

## 4. Anti-goals (would make it a failure even if it works)

- **Over-claiming.** A paying customer acting on a wrong number is the worst outcome. Unknown is
  never 0 and never red. Every aggregate shows its basis ("känd för 41 av 63 avtal",
  "18 kommuner"). Medians and per-elev prices are hidden below n = 5, with the reason shown.
  "No avtal" is kept apart from "not asked yet" and "collection not finished".
- **Personal data in the studio.** No staff names, emails, phone numbers, signatures, thread text
  or PDF filenames containing names. Roles only. The studio never links into back-office routes.
- **Naming and shaming.** No ranked "most expensive kommun" lists. On a kommun page, other
  kommuner appear as an anonymous peer distribution with the viewing kommun highlighted. On
  vendor/product pages, kommun names appear for *who has what* and *when it renews* (public
  record), and individual kommun prices appear only on hover/drill-down, never as a sorted price
  ranking. (My call; reversible.)
- **Comparing unlike things.** Per-elev prices compare the same product (or category), same
  pricing model family, and normalise by elever in the segments the avtal covers. Mixed-scope
  avtal are flagged, not averaged in silently.
- **Looking like a table dump or an admin tool.** See §7.
- **Leaking via the public repo.** The GitHub repo is public. Nothing per-kommun-per-contract
  (prices, avtal content) may be committed: no generated fixtures from the live DB, no snapshots.
  Public open data (elevantal, kommungrupper) and the catalogue (company/product names) are fine.

## 5. Constraints (from the codebase, `ux-audit.md` §3)

- Node ESM + Express, server-rendered HTML strings, **no build step, no CDN**. Static files from
  `public/` (fonts, small JSON, SVG) are allowed.
- Pane-swap navigation (`public/app.js`): links with `data-pane-link` load `?partial=1` into
  `#content`; inline scripts in swapped HTML never run. Interactivity must be CSS, native HTML
  (`<details>`, `popover`, `<dialog>`, GET forms), or an ES module that `app.js` (re)initialises
  after each swap (the `explorer.js` pattern). Page CSS must live in the layout's CSS (partials
  return body only).
- Charts are **server-rendered inline SVG**, never dual-axis, colours validated with the dataviz
  palette validator (`dashboard-chart-conventions` memory). Hover via HTML overlay + CSS, as on
  `/takt`.
- Both themes; OS dark mode must be honoured (`prefers-color-scheme`, currently broken).
- Mobile: no clipped tables; 16 px gutters; no horizontal page scroll.
- Tests run offline (vitest); temp-dir SQLite DBs; never the live DB. Existing test count must
  stay green.
- Data volume: ~1,700 avtal, 2,400 line items, 9,100 coverage rows. All studio aggregation can be
  computed per request from `listContractFacts` / `listLineItems` / `listCoverage`, with a small
  in-process memo keyed on a DB change marker if a page is slow (> 300 ms).

## 6. Data model (read-time layers)

### 6.1 Catalogue (`src/catalogue.js` + `data/catalogue/`)

Port the research catalogue (`catalogue-def.mjs`, 106 companies, 199 products; rules in
`catalogue.md` "Regler") into the app:

- `classifyVendor(rawVendorName)` → `{ company }` or null.
- `classifyLine(companySlug | null, rawName)` → `{ kind: 'product'|'addon'|'discount'|'segment'|'noise'|'bundle'|'unresolved', company, product, addonType, products? }`.
- `companies()`, `companyBySlug()`, `productBySlug()`: catalogue entries with `canonical`, `slug`,
  `role` (service/channel), `category`, `website`, `products[{ name, slug, category, what_it_is,
  editions? }]`, `singleProduct?`, `defaultProduct?`.
- Uncatalogued vendors (84 one-avtal vendors): pass through as their cleaned name, flagged
  `uncatalogued`, shown in lists under "Övriga" and never given their own product taxonomy.
- Doubts (`catalogue.md` "Tveksamheter" 1–25) are applied as the research agent proposed
  (merges 1–11 applied, 12–15 kept separate). Item 24: adult-education providers and Upplands-Bro
  kommun are hidden from studio vendor lists. The operator can reverse any of these by editing
  the catalogue file; record them in the file as comments.
- The existing `vendor-kb.js` stays for the back office (drafting probes, watchlist). The studio
  uses only the catalogue. A consistency test asserts every KB company resolves to a catalogue
  company with the same slug where both exist.
- Channel vs owner: a line bought via Skolon/Läromedia/Atea is attributed to the **product's
  owner**, with `channel` recorded. Prices are analysed per owner and filterable by channel.

### 6.2 Open data (`data/kommun-stats/`, committed, public)

Fetched once by a script (`scripts/16-fetch-kommun-stats.js`, network, run by the operator or by
me, not in tests), output committed as JSON with source URLs and fetch date:

- **Elever per kommun and segment, kommunal regi, latest läsår**: Skolverket SIRIS export 6
  (grundskola per årskurs; sum to 1-3, 4-6, 7-9), export 57 (gymnasiet), förskoleklass and
  förskola and komvux via Skolverket PxWeb or Kolada. Exact endpoints in `kommuner.md` §2.
- **SKR kommungrupp** (9 groups) via Kolada groups G92786–G92794, and **Kolada "Liknande kommuner
  grundskola"** (7 peers per kommun) if fetchable.
- **Folkmängd** per kommun (SCB or the existing `data/municipalities.json`).
- If a source cannot be fetched, the dependent figures show "underlag saknas" (hatched), never a
  guess. Folkmängd size bands are the fallback peer definition.

### 6.3 Studio facts (`src/studio-data.js`, pure, tested)

Built from the existing storage queries + catalogue + open data. One row per avtal:
`{ contract_id, kommun_kod, kommun_namn, company, company_slug, channel, category, products[],
segments[], annual_value_sek, value_basis, pricing_model, period_start, period_end,
next_renewal, elever_in_scope, kr_per_elev, kr_per_elev_basis, attachment_id }`.

Rules:
- `segments` from coverage rows (grade levels) and catalogue segment lines; empty = unknown.
- `kr_per_elev` = stated unit price when unit is elev; else `annual_value_sek / elever_in_scope`
  where `elever_in_scope` = student_count from coverage when present, else Skolverket elever for
  the kommun in the covered segments. Null when value or scope is unknown. `kr_per_elev_basis`
  records which ("styckpris", "avtalets elevantal", "Skolverkets elevantal").
- A kommun-wide licence with no stated segments is not normalised (null), not guessed.
- Aggregators (all return `{ value, n, known, total, suppressed }`):
  market by category, company share of known value and of kommuner, price distribution
  (median, IQR, n) by product/category × segment × peer group, renewal buckets (0–6, 6–12,
  12–18, 18–24 months), pricing-model mix, channel mix, white spots per category split into
  `no_avtal_collection_done`, `no_avtal_collection_open`, `not_contacted`, co-occurrence
  ("bought together"), kommun peer sets.
- Suppression: any median/percentile with n < 5 returns `suppressed: true`.

## 7. Experience

### 7.1 Studio shell

- Routes under `/studio`. Layout `studioLayout` (separate from back-office `layout`): left rail on
  desktop, bottom tab bar on phone. Nav: **Marknad, Kategorier, Leverantörer, Kommuner,
  Förnyelser, Utforska**. Global search (kommun, leverantör, produkt) via native
  `<input list>` + server datalist, submitting to `/studio/sok?q=`.
- No heartbeat pill, escalation badge, health modal or back-office link in the studio. The back
  office gets a "Studio ↗" nav link.
- Footer line on every page: data basis ("1 676 avtal från 185 av 290 kommuner · uppdaterad
  2026-10-26") and a "Om datan" link to a short methodology page (`/studio/om`).

### 7.2 Identity ("Mediagraf Studio", `ux-audit.md` §4.1–4.2)

Editorial market report, not admin: warm paper surfaces, ink text, one confident deep-teal
accent; serif display numerals and titles (Fraunces, self-hosted under `public/fonts/`, OFL),
Inter for UI and tables (self-hosted, tabular numbers). Token set as in `ux-audit.md` §4.2,
light and dark, dark also under `prefers-color-scheme`. A 3 px accent rule on entity headers, big
serif numbers with a small sans unit and a muted basis line under every number, and one hatched
pattern meaning "okänt / för få" everywhere. Data-viz colours validated with the palette script
before use. Motion: view transitions on pane swap, chart grow-in, hover lift; all off under
`prefers-reduced-motion`.

### 7.3 Components (`ux-audit.md` §4.3)

Entity header (kicker, serif name, one generated answer sentence, 3 facts + micro-viz); KPI tile
(known / partial / unknown states); price strip plot (dot per kommun, IQR band, median tick,
highlighted entity, n and "utan känt pris"); segment price matrix (rows peer group or size band,
columns segment, cell median kr/elev with n, hatched when suppressed, popover with detail);
ranking bars (share of value and of kommuner, max 7 rows + "Övriga N" fold); renewal timeline (24
months, lanes, dots sized by value, "idag" line); coverage heat strip; tile map (§7.4); filter
bar (chips + GET params); empty/uncertain panel; evidence drawer ("Visa underlag (N avtal)",
server-paginated 50 per page, PDF link per row without filename text).

### 7.4 Tile map

A kommun tile cartogram: 290 square tiles placed on a Sweden-shaped grid (positions in
`public/geo/kommun-tiles.json`, derived once from kommun centroids; committed). Fill classes per
kommun (`has`, `none-done`, `none-open` hatched, `not-contacted` empty, `highlight`). Hover/focus
shows the kommun name and the value. Used for vendor footprint, product footprint, category white
spots, and "you are here" on the kommun page. If deriving a decent grid fails, fall back to a
21-län grid; the component API stays the same.

### 7.5 Pages (each: answer first, visual second, evidence last)

1. **Marknad** `/studio`: header with known annual market value + completeness ring; category
   tiles (value, kommuner, top-3 share bar, median kr/elev); renewal wave (avtal ending per month,
   next 24 months, highlighting the Adda 2027-01-31 cliff); "Största leverantörer" ranking; latest
   avtal received. Answers: how big, who leads, what is coming up.
2. **Kategori** `/studio/kategori/:slug` (läromedel, lärplattform, skoladministration, prov,
   stödverktyg, …): share-of-value and share-of-kommuner ranking; segment price matrix (peer group
   × segment, median kr/elev per product family); pricing-model mix; white-spot tile map; renewal
   timeline per vendor lane; "Produkter i kategorin" cards. Answers vendor Q3, 6, 7, 10 and buyer
   Q3, 4.
3. **Leverantör** `/studio/leverantor/:slug`: header (category, kommuner, known annual value,
   share of category); product cards (name, what it is, kommuner bar, median kr/elev, segment
   strip); footprint tile map; price strip plot; competitors in the same kommuner ("säljs ofta
   tillsammans med" and "konkurrerar med"); renewal timeline per kommun; channel split; evidence.
   Answers vendor Q2, 8, 9, 14.
4. **Produkt** `/studio/produkt/:slug`: header (owner, category, what it is); price strip plot by
   segment; segment matrix; footprint map; substitutes (other products in the category with their
   median kr/elev and kommuner); renewals; evidence. Answers buyer Q1, 2, 4, 5.
5. **Kommun** `/studio/kommun/:kod` (customer view, no PII): header (län, folkmängd, kommungrupp,
   elever, collection status); "Så här köper ni" stacked spend by category vs peer median;
   per active avtal a row "ert pris vs liknande kommuner" (mini strip with this kommun
   highlighted, peers anonymous); "Alternativ" per category (what peers use, median kr/elev);
   overlap warning (≥2 active products in one category); renewal timeline with "upphandla om X
   mån" cues; evidence. If collection is not done, say so prominently. Answers buyer Q1, 2, 3, 6,
   8, 9 and vendor Q8.
6. **Förnyelser** `/studio/fornyelser`: the sales/tender calendar. Filters (kategori, segment,
   län, kommungrupp, kanal, months ahead); chart first (avtal ending per month by category), then
   a list sorted by date: kommun, incumbent, product, known value, end date, option years if
   known. CSV download. Answers vendor Q1, 13 and buyer Q6.
7. **Utforska** `/studio/utforska`: replaces `/avtal` for customers. Filter bar, a chart of the
   current grouping first, then a server-paginated table (50 rows), no 2 MB page. Reuses
   `explorer-core.js` logic server-side.
8. **Listor**: `/studio/leverantorer` (company directory: cards grouped by category, search),
   `/studio/kommuner` (tile map + list with collection status and avtal count),
   `/studio/kategorier`.
9. **Om datan** `/studio/om`: how the data is collected, coverage, how kr/elev is computed,
   suppression rule, peer definitions, update cadence. Plain Swedish.

Empty/partial states (all pages): full header always; hatched tiles with the reason; the market
around the entity shown and labelled ("ingen känd data än för X; så här ser kategorin ut"). A
kommun not yet contacted still gets a page: its peers, its category landscape, "vi har inte
begärt ut avtal här än".

### 7.6 Language

All studio UI text in Swedish, plain and short, no em-dashes, sentence case.

## 8. Decided by the operator vs. left to the builder

Decided by the operator (this conversation):
- Two customer segments (vendors, kommuner); the back office stays private and separate.
- Product = something with a price; leverantör → products → segments.
- No login/accounts now; just the views.
- Modern and interesting on every page at all times; real value you can look at and act on.
- Simple to understand and use.

My calls (reversible, flagged for the operator):
- Studio lives in the same app under `/studio` (same data, no second deployment).
- Peer group default: SKR kommungrupp; fallback folkmängd bands.
- n ≥ 5 suppression for medians/percentiles.
- Kommun prices visible on hover/drill-down on vendor/product pages, never as a ranking.
- Catalogue doubts applied as in §6.1.
- Fraunces + Inter, teal accent (the audit's proposal).
- Tile cartogram instead of a boundary map.

Settled after the builder check (my calls, from the operator's "no login yet"):
- **Access this round: operator-only.** `/studio` stays behind the existing auth gate
  (`requireAuth`, one allowed email). It is a working demo for the operator to show prospects
  on screen. No auth carve-out, no CloudFront change. The privacy rules (§4) are still built in
  now, so opening the studio to customers later is an access change, not a redesign.
- **Evidence PDFs:** while access is operator-only, each evidence row links to the source PDF
  through a studio route (`/studio/underlag/:attachmentId`) that serves the same file as the
  back office, marked in code as "operator-only; must be replaced by a redacted or metadata-only
  view before external access". Rows show kommun, date range, value, model, never the filename.
- **Suppression applies to the dots too.** A price distribution with n < 5 renders a hatched
  "för få avtal (n = 3)" panel, no individual dots, on every surface (strip plot, matrix popover,
  kommun "ert pris vs liknande"). The kommun's own price may still be shown to that kommun's page
  as a single number with "för få jämförbara kommuner". Individual avtal values remain listed in
  the evidence drawer (public record), not as a ranking.
- **Which avtal count:** headline figures (market value, shares, kommun counts, price
  distributions) use **active avtal**: `period_end` ≥ today, or `period_end` unknown and
  `period_start` within the last 4 years (counted, and the unknown-end share shown in the basis
  line). Of several avtal for the same kommun × company × product, the newest counts. Expired
  avtal appear only in evidence and in renewal history. `is_contract = 1` only. The footer
  reports both: "X aktiva avtal (Y insamlade) från Z kommuner".
- **Channel avtal with several owners:** facts are one row per **avtal × owner company**.
  Value is split by line-item `amount_sek` where line items exist; the unsplit remainder stays on
  a row with `company = channel`, labelled "via Läromedia, ej fördelat". Kommun counts per owner
  count the avtal once per owner named. Channel views sum the whole avtal.

Left to the builder: component internals, SVG geometry, CSS structure, memoisation, exact
copy, query shapes, test layout, CSV format.

## 9. Delivery order

1. Catalogue module + tests (port + consistency tests), studio facts layer + tests.
2. Open-data fetch script + committed JSON (network step run once, outside tests).
3. Studio shell, tokens, fonts, components (with a component gallery page `/studio/_komponenter`
   for visual review), theming and mobile fixes for the studio layout.
4. Pages in this order: Leverantör, Produkt, Kommun, Kategori, Marknad, Förnyelser, Utforska,
   lists, Om datan.
5. Back-office nav link; old market pages remain.
6. Visual QA: every page rendered from a local snapshot copy, light/dark, desktop/phone,
   screenshots reviewed, palette validated; three-way code review (Binogi, codex, adversarial).
7. Deploy by the operator.
