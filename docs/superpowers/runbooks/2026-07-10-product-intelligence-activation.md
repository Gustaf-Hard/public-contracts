# Runbook — activating product intelligence (2026-07-10)

Live-activation steps for the product-intelligence feature
(`2026-07-10-product-intelligence-design.md`): line-item per-product pricing
and the grade-coverage matrix on the vendor dossier. **Nothing in the feature
branch touched the live system** — the branch only adds code, tables-on-migrate
and tests. Run these under supervision, after code review, on the machine that
holds `data/pilot.db`.

Same shape as the 2026-07-09 refresh activation: backup → guarded migration →
force re-analysis backfill → verify → restart.

## Preconditions

- Feature branch `product-intelligence` merged (or checked out).
- `npm test` green locally (≥ 615).
- `ANTHROPIC_API_KEY` present in `.env` (the backfill calls Opus).
- Daemon and dashboard **stopped** before the migration + backfill.

## Step 1 — Back up the live DB

```bash
cp data/pilot.db "data/pilot.db.bak-$(date +%Y%m%d-%H%M%S)"
ls -la data/pilot.db.bak-*   # confirm the backup exists and is non-empty
```

`data/pilot.db.bak-*` is git-ignored (PII) — keep it out of commits.

## Step 2 — Baseline counts (read-only, pre-migration safe)

```bash
node scripts/07-reanalyse-lifecycle.js --counts
# expect: "product intelligence: 0 line items across 0 contracts, 0 coverage rows across 0 contracts"
```

## Step 3 — Run the guarded migration

Additive only: two `CREATE TABLE IF NOT EXISTS` (+ indexes) inside the same
idempotent `migrate()`; running it twice is safe, no existing column or row is
touched.

```bash
node -e "import('./src/storage.js').then(async ({openDb})=>{const db=openDb('data/pilot.db');db.migrate();console.log('migrated');db.close();})"
```

Verify the tables exist:

```bash
sqlite3 data/pilot.db "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('contract_line_items','contract_coverage');"
sqlite3 data/pilot.db "PRAGMA table_info(contract_line_items);"   # product_name, description, unit_price_sek, unit, quantity, period_months, amount_sek
sqlite3 data/pilot.db "PRAGMA table_info(contract_coverage);"     # product_name, grade_level, status, student_count
```

## Step 4 — Backfill (force re-analysis)

Dry-run first (no changes, no API calls):

```bash
node scripts/07-reanalyse-lifecycle.js --dry-run
```

Then the real backfill. This re-runs Opus over EVERY stored contract PDF; the
extended schema/prompt now also returns `line_items`, `coverage` and
`whole_municipality`, and `storeContractAnalysis` writes them. The run prints
before/after product-intelligence counts itself.

```bash
node scripts/07-reanalyse-lifecycle.js
```

Non-destructive guarantees (already unit-tested):

- the merge preserves every good lifecycle/pricing field exactly as in the
  2026-07-09 backfill (fill-only, `REANALYSE …` audit lines);
- an empty `line_items`/`coverage` from a degraded pass NEVER wipes rows that
  an earlier pass extracted (empty = "no signal");
- a pass WITH rows replaces that contract's rows (idempotent, not additive).

## Step 5 — Verify

Counts must not regress (compare with Step 2 / the run's own before/after
lines; re-running the backfill must not lower them):

```bash
node scripts/07-reanalyse-lifecycle.js --counts
```

Spot-check the known archetype — the Ale / ILT Education contract (the spec's
motivating example). Expect the per-product sums Inlästa läromedel **250 764**,
Begreppa **166 585**, Polyglutt **168 300** (total 585 649):

```bash
sqlite3 data/pilot.db "SELECT li.product_name, SUM(li.amount_sek) FROM contract_line_items li JOIN contracts c ON c.id=li.contract_id JOIN vendors v ON v.id=c.vendor_id WHERE v.name='ILT Education' GROUP BY li.product_name;"
```

Coverage spot-check — Polyglutt should be Förskola-only, Inlästa läromedel /
Begreppa on 1-3/4-6/7-9/Gymnasiet/Komvux (anpassad skola folded in):

```bash
sqlite3 data/pilot.db "SELECT cc.product_name, cc.grade_level, cc.status FROM contract_coverage cc JOIN contracts c ON c.id=cc.contract_id JOIN vendors v ON v.id=c.vendor_id WHERE v.name='ILT Education' ORDER BY cc.product_name, cc.id;"
```

Honesty check: contracts that state only a lump sum must have NO line items —
absence is correct, not a failure. A vendor page must show
"ingår, ospecificerat pris" for those products, never an invented split.

## Step 6 — Confirm on the dashboard

```bash
npm run pilot-dashboard   # 127.0.0.1:3100
```

Open `/leverantor/ilt-education`:

- product table shows per-product Pris (Begreppa 166 585 kr etc.), not just
  the contract total;
- the coverage matrix colours Förskola green for Polyglutt and red (✕) for
  Begreppa/Inlästa läromedel — red meaning "sold elsewhere, not here";
- unreferenced levels (Högskola, Introduktionsprogrammet …) show "–";
- the KPI band has "Snitt per kommun" with a completeness subtext.

## Step 7 — Resume the daemon

```bash
npm run pilot-daemon
```

New contracts analysed by the tick now populate line items + coverage
automatically — no further backfills needed.

## Rollback

Stop the daemon/dashboard and restore the backup:

```bash
cp data/pilot.db.bak-<stamp> data/pilot.db
```

The added tables are additive and harmless if left in place; rollback is only
needed if the backfill produced bad extractions.
