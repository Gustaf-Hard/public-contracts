# Runbook — activating perpetual contract refresh (2026-07-09)

Live-activation steps for the perpetual-refresh feature
(`2026-07-09-perpetual-contract-refresh-design.md`). **Nothing in the feature
branch touched the live system.** Run these under supervision, after code
review, on the machine that holds `data/pilot.db`.

> **Also activates the vendor data center**
> (`2026-07-09-vendor-data-center-design.md`, branch `vendor-data-center`):
> the same migration adds the structured pricing columns and the same Step-3
> backfill populates them — no extra steps, only the extra verifications
> marked "pricing" below. Until the backfill has run, /leverantorer still
> works: values fall back to a conservative parse of the raw avtalsvarde
> text (~28 of the 47 valued contracts at review time), the rest show
> "okänt" with completeness lines.

The pilot allowlist ships as `refresh_pilot_kommun_kods: ["1489","1980"]`
(Alingsås, Västerås) in `data/pilot-overrides.json`. Only these kommuner arm
and trigger; expanding is a config edit.

## Preconditions

- Feature branch `perpetual-contract-refresh` merged (or checked out).
- `npm test` green locally (≥425).
- `ANTHROPIC_API_KEY` present in `.env` (the backfill calls Opus).
- Daemon and dashboard **stopped** before the migration + backfill.

## Step 1 — Back up the live DB

```bash
cp data/pilot.db "data/pilot.db.bak-$(date +%Y%m%d-%H%M%S)"
ls -la data/pilot.db.bak-*   # confirm the backup exists and is non-empty
```

`data/pilot.db.bak-*` is git-ignored (PII) — keep it out of commits.

## Step 2 — Run the guarded migration

The migration is idempotent PRAGMA-guarded `ALTER TABLE ADD COLUMN`s; running
it on the live DB only adds the missing columns.

```bash
node -e "import('./src/storage.js').then(async ({openDb})=>{const db=openDb('data/pilot.db');db.migrate();console.log('migrated');db.close();})"
```

Verify the columns exist:

```bash
sqlite3 data/pilot.db "PRAGMA table_info(contracts);"      # expect auto_renews, renewal_term, last_cancellation_date, extension_option_until
                                                           # + pricing: annual_value_sek, one_time_value_sek, pricing_model,
                                                           #            unit_price_sek, unit, quantity, value_incl_moms
sqlite3 data/pilot.db "PRAGMA table_info(conversations);"  # expect next_review_at, next_review_source, refresh_round
```

## Step 3 — Backfill lifecycle fields (re-analysis)

Dry-run first (no changes, no API calls):

```bash
node scripts/07-reanalyse-lifecycle.js --dry-run
```

Then the real backfill. This re-runs Opus over EVERY stored contract PDF and
replaces each `contracts` row in place, populating the four new lifecycle
fields. Cost scales with the number of stored PDFs (~50 at review time).

```bash
node scripts/07-reanalyse-lifecycle.js
```

Spot-check a few rows for the known archetypes (Tieto auto-renew, Skola24 /
Teachiq extension options):

```bash
sqlite3 data/pilot.db "SELECT v.name, c.period_end, c.auto_renews, c.last_cancellation_date, c.extension_option_until FROM contracts c LEFT JOIN vendors v ON v.id=c.vendor_id WHERE c.is_contract=1 ORDER BY c.id;"
```

Pricing spot-checks (vendor data center). Compare against the raw
avtalsvarde text — the analyser must NOT invent numbers; a value the
document doesn't state should be NULL:

```bash
sqlite3 data/pilot.db "SELECT v.name, c.avtalsvarde, c.annual_value_sek, c.pricing_model, c.unit_price_sek, c.unit, c.quantity FROM contracts c LEFT JOIN vendors v ON v.id=c.vendor_id WHERE c.is_contract=1 ORDER BY c.id;"
```

Known archetypes to eyeball:

- "80 417 SEK per månad" → `annual_value_sek` ≈ 965 004, `pricing_model` fixed
- Radish "40 kr/elev (3744 elever)" → per_student, unit elev, quantity 3744
- ILT "585 649 SEK år 1, …" → tiered, current-year amount
- "121 272 SEK" (no period) → `annual_value_sek` NULL — correct, not a failure
- "Ingen årlig abonnemangskostnad" → free, 0

Then open `/leverantorer` (Step 5) — the KPI band's "känd för X av Y avtal"
should jump versus the pre-backfill text-parse-only completeness.

## Step 4 — Arm next_review_at for 1489 / 1980

Arming runs automatically at the end of each tick for allowlisted DONE
conversations. Either start the daemon (Step 6) and wait one tick, or arm once
manually:

```bash
node -e "import('./src/storage.js').then(async ({openDb})=>{ \
  const {armRefresh}=await import('./src/tick.js'); \
  const db=openDb('data/pilot.db'); const now=new Date(); \
  for (const c of db.listConversationsByState('DONE')) armRefresh(c,{db,now,refreshAllowlist:['1489','1980']}); \
  console.log('armed'); db.close(); })"
```

Verify:

```bash
sqlite3 data/pilot.db "SELECT kommun_kod, kommun_namn, state, next_review_at, next_review_source FROM conversations WHERE kommun_kod IN ('1489','1980');"
```

Expect DONE conversations for 1489/1980 with a non-null `next_review_at` (when
their contract set yields a usable date). No usable date → stays null; that is
correct, not a failure.

## Step 5 — Confirm on the dashboard

```bash
npm run pilot-dashboard   # 127.0.0.1:3100
```

Open a DONE case for Alingsås or Västerås — the case header should read
"Återkommer <date> — pga <vendor>". A case whose review date is in the past
will, on the next daily follow-up run, become `REFRESH_DUE` with one `T_UPDATE`
escalation awaiting approval in Slack / the dashboard.

## Step 6 — Resume the daemon

```bash
npm run pilot-daemon
```

The daily follow-up cron now also runs `runRefreshScan` (same escalation
mutex). The first approved `T_UPDATE` starts a new Gmail thread; when that round
reaches DONE again, arming recomputes `next_review_at` — perpetual.

## Rollback

Stop the daemon/dashboard and restore the backup:

```bash
cp data/pilot.db.bak-<stamp> data/pilot.db
```

The added columns are additive and harmless if left in place; rollback is only
needed if the backfill produced bad extractions.
