# Mediagraf Municipal Contracts

Market intelligence over Swedish kommuner's contracts for digital tools in
schools, collected via *offentlighetsprincipen* (public-records) requests.

Two layers:

1. **Collection pipeline (Phase 1)** — builds the recipient dataset:
   290 kommuner + registrator email addresses, as reviewable JSON/CSV in git.
2. **Pilot runtime** — a daemon + dashboard that actually runs the
   correspondence: sends requests over Gmail, ingests and LLM-classifies
   replies, extracts delivered contract PDFs into a vendor/contract database,
   and escalates every reply draft to a human (Slack buttons or the local
   dashboard) before anything is sent.

See `docs/superpowers/specs/` for the design history;
`2026-07-05-autopilot-readiness-review.md` documents the safety invariants.

## Usage

```
npm install
npm test                 # ~360 offline tests

# Phase 1 — recipient dataset (regenerable)
npm run seed             # Stage 1: fetch 290 kommuner from Wikipedia
npm run discover         # Stage 2: scrape registrator emails (~15 min, real network)
npm run verify           # Stage 3: validate emails + emit review report

# Pilot runtime
npm run pilot-auth       # one-time Gmail OAuth; token stored under ~/.config/mediagraf/
npm run pilot-init       # enroll kommuner into data/pilot.db
npm run pilot-daemon     # 15-min tick + daily follow-up + Slack interactivity webhook
npm run pilot-dashboard  # http://127.0.0.1:3100 (loopback only — no auth)
npm run pilot-resolve    # resolve an escalation from the CLI
npm run analyse-contracts # (re-)run LLM extraction over stored PDFs
```

Environment (`.env`, git-ignored): `GMAIL_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`,
`GMAIL_USER_EMAIL`, `GMAIL_FROM_NAME`, `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`. Without `ANTHROPIC_API_KEY` the
daemon still works — a regex classifier replaces the LLM analysis.

## How the pilot behaves

- **T-INITIAL** is the only automated send; everything else is drafted and
  escalated for human approval. Sends are two-phase and idempotent: a crash
  or double click can never double-message a kommun.
- Replies are matched to conversations by Gmail thread first, then sender
  domain; unmatched/ambiguous inbound is surfaced in Slack, never guessed.
- Delivered PDFs (incl. zipped) are stored under `data/contracts/` and
  analysed by Claude into `vendors` / `contracts` tables; watchlisted
  vendors (Binogi, NE, ILT, Magma) always hold the reply for conscious
  authoring.
- Conversation states: `INITIAL → SENDING → SENT → ACK_RECEIVED →
  AWAITING_PRECISION → DELIVERING → DONE / DEAD_END / NEEDS_HUMAN`.
  Stale cases get follow-up nudges (max 2), gated on "no open escalation".

## Phase-1 outputs

- `data/seed-municipalities.json` — 290 kommuner with name, län, org.nr, website, population.
- `data/municipalities.json` — full records with `contacts[]` per kommun (canonical).
- `data/municipalities.csv` / `data/municipalities-contacts.csv` — derived views.
- `data/review-report.md` — kommuner with confidence ≠ high, with source URLs for manual completion.

Confidence: **high** = ≥1 `central` AND ≥1 utbildning-family contact;
**medium** = one of the two; **low** = neither. Contact roles: `central`,
`utbildning`, `gymnasie`, `vuxenutbildning`, `it_digitalisering`,
`upphandling`, `other`.

All three collection stages are idempotent; pass `--only=<komkod>[,...]` to
`discover` to limit re-crawls.

## Live state (not in git)

`data/pilot.db` (SQLite, WAL) and `data/contracts/` hold correspondence,
extracted signatures, and contract PDFs — they contain PII and are
git-ignored, as are `data/pilot.db.bak-*` backups.
