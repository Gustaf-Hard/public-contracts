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

- `data/seed-municipalities.json` — 290 kommuner with name, län, org.nr, website, and population.
- `data/municipalities.json` — full records with `contacts[]` per kommun (canonical); each record includes `folkmangd` (population).
- `data/municipalities.csv` — one row per kommun, with `folkmangd`, `contact_count` and `confidence`.
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
