# Municipality contact dataset for public-records requests

**Date:** 2026-05-16
**Phase:** 1 of N (data collection only — no requests sent yet)
**Owner:** gustaf@binogi.com

## Goal

Produce an authoritative dataset of all 290 Swedish municipalities with the contact addresses needed to send formal *offentlighetsprincipen* (Public Access to Information) requests asking for every digital contract held by their educational operations.

Output is regeneratable, version-controlled, and complete enough to drive the next phase (request dispatch).

## Why multiple addresses per kommun

Contracts for digital tools used in schools are diariumförda (registered) in different places depending on how the kommun is organised. A single kommun can have an arbitrary number of relevant registrator inboxes:

- **Central kommun level** — kommun-wide registrator / purchasing / IT.
- **Education administration** — `utbildningsförvaltning`, `barn- och utbildningsförvaltning`, `skolförvaltning` (name varies).
- **Sub-areas** — some kommuner split further: separate gymnasieförvaltning, vuxenutbildning, kulturskola, district-level skolområden.
- **Adjacent förvaltningar** — IT-, digitaliserings-, or upphandlingsförvaltning that may also hold education-relevant contracts.

Confirmed example: Västerås — contracts held both centrally and at utbildningsförvaltningen. Other kommuner may legitimately have three, four, or more addresses worth contacting.

Sending to only one address misses contracts diariumförda elsewhere. Therefore the schema captures an **unbounded list** of contact addresses per kommun, each tagged with its role, and the dispatch phase sends to every one of them.

## Dataset schema

JSON is the canonical format (`data/municipalities.json`) because each kommun has a variable number of contacts. A flat long-format CSV (`data/municipalities-contacts.csv`, one row per contact) is generated as a convenience view; a summary CSV (`data/municipalities.csv`, one row per kommun with contact counts) is also generated.

### Per-kommun record

| Field | Type | Description |
|---|---|---|
| `kommun_kod` | string (4 digits) | SCB's official kommunkod (e.g. `1980` for Västerås). Primary key. |
| `kommun_namn` | string | Official name (e.g. `Västerås`). |
| `lan` | string | Län the kommun belongs to. |
| `org_nr` | string | Organisationsnummer (10 digits, with dash). |
| `webbplats` | URL | Official kommun website. |
| `folkmangd` | integer \| null | Population from kommun's Wikipedia infobox (Folkmängd); integer or null. |
| `diarium_url` | URL \| null | Public diarium search page, if one exists. |
| `contacts` | `Contact[]` | Unbounded list — see below. May be empty (flagged `low`). |
| `confidence` | enum | `high` (≥1 central + ≥1 education contact on official site), `medium` (some found, gaps), `low` (none found or only patterns inferred). |
| `notes` | string \| null | Free text for edge cases. |
| `verified_at` | ISO date | When the row was last scraped/verified. |

### Contact record

| Field | Type | Description |
|---|---|---|
| `email` | string | The address. |
| `role` | enum | `central` \| `utbildning` \| `gymnasie` \| `vuxenutbildning` \| `it_digitalisering` \| `upphandling` \| `other` |
| `forvaltning_namn` | string \| null | Actual förvaltning name as published (e.g. `Barn- och utbildningsförvaltningen`). |
| `source_url` | URL | Page where this email was found. |
| `found_via` | enum | `pattern_match` \| `contact_page` \| `manual` — how we got it. |

A kommun must have **at least one** `central` contact and **at least one** `utbildning`-family contact (utbildning / gymnasie / vuxenutbildning) to qualify as `high` confidence.

## Architecture

Three pipeline stages, each independently runnable and idempotent.

### Stage 1 — Seed list (`scripts/01-fetch-seed.js`)

- Fetch the official 290-kommun list from SCB's open data (kommunkod + name + län).
- Enrich with org.nr and primary website URL from a secondary authoritative source (SKR's open data or scraping kommun.se directories).
- Output: `data/seed-municipalities.json` (just the static fields — kommun_kod, kommun_namn, lan, org_nr, webbplats).

This stage rarely changes — kommun boundaries shift only when SCB publishes new codes.

### Stage 2 — Email discovery (`scripts/02-discover-emails.js`)

For each kommun in the seed:

1. Fetch the homepage; follow likely contact / förvaltning links: `/kontakt`, `/kontakta-oss`, `/om-kommunen/kontakt`, `/diarium`, `/registrator`, `/forvaltningar`, `/organisation`, plus any link whose anchor text matches `förvaltning`, `nämnd`, `registrator`, `diarium`.
2. Walk one or two levels deep into förvaltning pages to find department-specific addresses.
3. Extract candidate email addresses. Classify each into a `role` based on the context it was found in (URL slug, surrounding page heading, nearest förvaltning name):
   - `central` — registrator on the kommun's top-level contact / diarium page (`registrator@`, `kommun@`, `<kommun>@`).
   - `utbildning` — found on a page about barn- och utbildningsförvaltningen / utbildningsförvaltning / skolförvaltning.
   - `gymnasie`, `vuxenutbildning` — found on dedicated pages for those operations.
   - `it_digitalisering`, `upphandling` — found on those förvaltningar.
   - `other` — registrator found on any förvaltning page not matching the above (kept because it might still hold education contracts).
4. Capture **every** registrator-like address encountered — do not deduplicate by role. The list is unbounded.
5. Handle obfuscated emails: `[at]`, ` (at) `, `&#64;`, JS-rendered. Don't execute JS in this pass — flag for manual review instead.
6. Record source URL for every email captured.
7. Polite scraping: 1 request/sec/host, identifying `User-Agent` with contact email, respect `robots.txt`.

Output: merges into `data/municipalities.json` (and regenerates the derived CSVs), setting `confidence` based on what was found.

### Stage 3 — Verification & enrichment (`scripts/03-verify.js`)

- Validate every email syntactically and confirm the domain has MX records (DNS check, no SMTP probing — that would be noisy).
- For each `low`/`medium` confidence row: print a manual-review checklist to stdout.
- Dedupe within a kommun: if the same email appears under multiple roles, keep all role rows but mark `notes` accordingly so we don't email the same inbox twice in dispatch.

## Stack

- **Runtime:** Node.js (LTS), per global default.
- **Dependencies:** `undici` (HTTP), `cheerio` (HTML parsing), `p-limit` (concurrency), `csv-stringify` (CSV output). No framework.
- **Storage:** plain files in `data/`, checked into git so diffs are reviewable.
- **No database** in this phase — 290 rows fits in memory and JSON. A DB makes sense once we start tracking sent requests and responses (later phase).

## Error handling

- Network errors: retry 3× with exponential backoff, then mark the row `low` confidence and continue. Never crash the run on one bad kommun.
- Parse errors: log, mark `low`, continue.
- Anti-scraping (403/429): respect, back off, log the host for manual review. Do not try to evade.
- Missing seed data (a kommun SCB lists but with no resolvable website): row is created with `low` confidence and only the static fields populated.

## Testing

- Unit tests for the email-extraction logic against fixtures captured from 5–10 real kommun pages (Västerås, Stockholm, a small kommun, one with obfuscated emails, one with JS-rendered contact info).
- Integration test: full pipeline run against a 3-kommun subset, asserting the output schema and that confidence levels are assigned correctly.
- No live network in CI — fixtures only.

## Success criteria

- All 290 kommuner present in the output (no missing rows).
- ≥90% of kommuner have **at least one** `central` and **at least one** `utbildning`-family contact captured.
- All `low`-confidence rows are listed in a human-review report with the URLs already visited, so manual completion is cheap.
- Re-running the pipeline is idempotent and surfaces a diff (which contacts were added/removed/changed since last run).

## Out of scope for this phase

- Sending the actual requests.
- Tracking responses or extracting contract data from replies.
- Any UI or dashboard.
- Multi-language support (everything is Swedish-only).
- Region-level (`region` / `landsting`) contacts — kommuner only.

## Open questions deferred to next phases

- Request template wording and legal framing (next phase).
- How to handle kommuner that respond with a fee demand for the records.
- Bookkeeping for the 4-week statutory response window.
