# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Phase 1 of a pipeline that sends *offentlighetsprincipen* (Public Access to Information) requests to Swedish municipalities. This phase only **collects** the recipient dataset — no requests are sent. Output is structured data files in `data/`, regenerable from scratch via three idempotent npm scripts.

Node.js ESM (Node 20+). No framework, no database. Storage is JSON + CSV in git so diffs are reviewable. Fetching is HTML-only with `cheerio` — no JS execution, no headless browser.

## Commands

```bash
npm install
npm run seed       # Stage 1 — fetch 290 kommuner from Wikipedia, ~5 min real network
npm run discover   # Stage 2 — walk each kommun website for registrator emails, ~15 min real network
npm run verify     # Stage 3 — MX/syntax checks + emit data/review-report.md, ~1 min DNS
npm test           # vitest, all 65 tests, fully offline (HTML fixtures only)
```

Single test file: `npx vitest run tests/<name>.test.js`. Single test name: append `-t "<substring>"`. Watch mode: `npm run test:watch`.

Stage 2 supports incremental targeting:

```bash
node scripts/02-discover-emails.js --only=1980,0180   # only Västerås and Stockholm
```

Re-runs of `02-discover-emails.js` are idempotent: results merge by `kommun_kod` into the existing `data/municipalities.json`; un-targeted kommuner are preserved.

There is also `scripts/04-patch-data.js` — a one-off post-processor that re-applies `isPersonalEmail` / `isValidEmail` / `classifyRole` over the existing JSON without re-crawling. Useful when filter or classifier rules change.

## Architecture

The pipeline is **three stages that compose pure modules**. Pure functions live in `src/*.js`; IO (network, DNS, file) is concentrated in `src/http.js`, `src/store.js`, and the runner scripts.

```
scripts/01-fetch-seed.js   → src/seed.js   → data/seed-municipalities.json
scripts/02-discover-emails → src/crawl.js  → data/municipalities.json + 2 CSVs
                              ├── src/extract.js     (email regex + obfuscation)
                              ├── src/classify.js    (role from URL/page context + email)
                              ├── src/confidence.js  (high/medium/low)
                              └── src/http.js        (politeFetch — used by every fetch)
scripts/03-verify.js       → src/verify.js → data/review-report.md
```

`src/store.js` reads/writes the canonical JSON and emits two derived CSV views (one row/kommun summary; one row/contact long format). Schema is documented in the spec under `docs/superpowers/specs/`.

## Conventions that aren't obvious from the code alone

**Polite scraping is enforced in `src/http.js`.** Every outbound HTTP call must go through `politeFetch` so per-host rate limiting (1 req/sec), retry on 429/503, and the contactable User-Agent header are guaranteed. Do not call `undici` or `node:fetch` directly from anywhere else.

**Swedish genitive correction has a whitelist, not a heuristic.** Wikipedia article titles use the genitive form ("Stockholms kommun" = Stockholm's municipality). The correct kommun name is the nominative ("Stockholm"). `src/seed.js` strips trailing `s` from kommun names unless they're in the `NAMES_ENDING_IN_S_NATURALLY` set (-ås, -näs, -fors suffixes plus Grums). When adding a new -fors kommun: extend the whitelist or it will be silently corrupted (this happened with Bengtsfors during development).

**Cross-domain email filter is strict.** `src/crawl.js` only accepts emails whose domain equals the kommun's home domain OR is a subdomain of it (`endsWith('.' + homeDomain)`). A bare `endsWith(homeDomain)` is wrong and would accept look-alike domains (`xvasteras.se` for `vasteras.se`).

**Personal-email filter targets `firstname.lastname[N]@` patterns** with two trimmed dot-parts of alphabetic-only characters (digits stripped as suffix), and rejects local-parts starting with digits (catches `0224-36015ulrika.axelsson@`). The functional-words allowlist (`registrator`, `kontakt`, `it`, `barn`, `utbildning`, …) keeps multi-word functional addresses from being misflagged. When adding a new role keyword to `classify.js`, consider whether it should also join `FUNCTIONAL_EMAIL_WORDS`.

**Confidence is structural, not heuristic.** `high` requires ≥1 `central` AND ≥1 utbildning-family contact (`utbildning` / `gymnasie` / `vuxenutbildning`). `medium` is one of the two. `low` is neither. The original spec set a ≥90% high-confidence target; **in practice this is not achievable** from Swedish kommun websites (many publish only one or the other) — current numbers are ~24% high / 66% medium / 11% low. The 221 non-high kommuner are listed in `data/review-report.md` with the URLs already visited for cheap manual completion.

## Test pattern

All tests run offline. Network/IO is faked by:

- `politeFetch.__setFetch(fakeFetch)` for HTTP tests
- A `{ fetch: fakeFetch }` option to `crawlKommun` for crawler tests
- A `{ checkMx }` stub for `verifyAll` in verifier tests
- Hand-crafted HTML fixtures in `tests/fixtures/` for parser tests

When the live behaviour of a parser/classifier needs to change because a real site uses a pattern the fixture doesn't, **update the fixture first** so the test still expresses the live contract — don't make the test more permissive to paper over the change.

## Where to look for what

- Schema, role taxonomy, success criteria: `docs/superpowers/specs/2026-05-16-municipality-email-collection-design.md`
- Original 10-task implementation plan: `docs/superpowers/plans/2026-05-16-municipality-email-collection.md`
- User-facing usage/outputs: `README.md`
- All persistent state: `data/`
