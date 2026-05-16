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
