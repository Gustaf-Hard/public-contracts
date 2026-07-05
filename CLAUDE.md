# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project shape

Two layers, both live:

1. **Phase 1 — collection** (done, kept regenerable): three idempotent npm
   scripts that build the recipient dataset (290 kommuner + registrator
   emails) as JSON/CSV in `data/`. HTML-only fetching with `cheerio`, no JS
   execution, no headless browser.
2. **Pilot runtime — the actual product**: a daemon that sends
   *offentlighetsprincipen* requests to Swedish municipalities over Gmail,
   ingests replies, classifies them with an LLM (Claude Haiku; regex
   fallback offline), extracts delivered contract PDFs (Claude Opus),
   advances a per-conversation FSM in **SQLite** (`data/pilot.db`,
   better-sqlite3, WAL), and escalates every outbound reply to a human via
   **Slack buttons** and a local **Express dashboard**. No outbound (except
   the scheduled T-INITIAL) is ever sent without human approval in v1.

Node.js ESM (Node 20+). Design history lives in `docs/superpowers/specs/` —
read `2026-07-05-autopilot-readiness-review.md` for the current safety
invariants and the path to autopilot.

## Commands

```bash
npm install
npm test                 # vitest, all ~360 tests, fully offline (fakes + fixtures)

# Phase 1 collection (regenerable dataset)
npm run seed             # Stage 1 — 290 kommuner from Wikipedia (~5 min network)
npm run discover         # Stage 2 — walk kommun sites for registrator emails (~15 min)
npm run verify           # Stage 3 — MX/syntax checks + data/review-report.md

# Pilot runtime
npm run pilot-auth       # one-time Gmail OAuth (state+PKCE, token under ~/.config/mediagraf/)
npm run pilot-init       # enroll kommuner into data/pilot.db
npm run pilot-daemon     # cron ticks (15 min) + daily follow-up + Slack interactivity
npm run pilot-dashboard  # local dashboard on 127.0.0.1:3100 (unauthenticated — loopback only)
npm run pilot-resolve    # CLI escalation resolve (delegates to send-reply.js)
```

Single test file: `npx vitest run tests/<name>.test.js`. Single test name: append `-t "<substring>"`.

## Pilot architecture

```
scripts/pilot-daemon.js → src/daemon.js
  ├── src/tick.js            runTick (15-min): recover stuck sends → dispatch
  │                          T-INITIAL → fetch/match/ingest inbound → draft +
  │                          escalate → contract analysis
  │                          runDailyFollowup: staleness nudges
  ├── src/conversation.js    pure FSM (INITIAL→SENT→ACK_RECEIVED→…→DONE/DEAD_END)
  ├── src/analyse-message.js LLM reply analysis (Haiku) — identity from env
  ├── src/analyse-contract.js LLM PDF extraction (Opus) → vendors/contracts tables
  ├── src/classifier.js      regex fallback classifier (offline path)
  ├── src/send-reply.js      THE only approved-send path (Slack, dashboard, CLI)
  ├── src/slack.js           escalation blocks, signatures, chat.update
  ├── src/storage.js         SQLite schema + all queries (do NOT confuse with
  │                          src/store.js, which is the Phase-1 JSON/CSV store)
  └── src/dashboard.js/-views.js  Express UI over the same DB
```

Phase-1 pipeline: `scripts/01|02|03 → src/seed.js|crawl.js|verify.js → data/*.json|csv` (see README).

## Safety invariants (do not weaken — see the 2026-07-05 review)

- **Never double-message a kommun.** Every approved send goes through
  `sendApprovedReply`, which atomically claims the escalation
  (`open → sending`) before Gmail and parks failures as `send_failed` /
  `send_unconfirmed` — never back to `open`, never auto-retried. T-INITIAL
  uses the same two-phase shape (`INITIAL → SENDING → SENT`);
  `recoverStuckSends` escalates orphaned claims to a human. Do not add a
  send path that bypasses this.
- **At most one open escalation per conversation.** `escalateWithDraft`
  supersedes any existing open one; `runDailyFollowup` is gated on it.
- **Ticks never overlap** (`makeExclusive` latch in the daemon), and
  per-message ingest is one SQLite transaction with attachments fetched
  before commit — a crash mid-ingest leaves the message unrecorded and
  retried, never half-written.
- **Inbound matching is two-pass**: Gmail-thread matches first across all
  conversations, then sender-domain (subdomain-aware) for unclaimed
  messages only; domain ambiguity and no-match go to a Slack digest, never
  first-conv-wins.
- **`received_at` is Gmail `internalDate`**, never processing time. The
  inbound fetch window derives from heartbeat `last_success_at` (30d floor).

## Conventions that aren't obvious from the code alone

**No schema changes casually.** `storage.js` migrations are append-only
probes (`PRAGMA table_info`). New *string values* in existing TEXT columns
(escalation statuses like `superseded`, `send_failed`; conversation state
`SENDING`) are how state is extended without migrations.

**LLM identity comes from env.** The analysis prompt signs drafts with
`GMAIL_FROM_NAME` / `GMAIL_USER_EMAIL` (`buildSystemPrompt`) — never
hardcode a name or address into a prompt.

**Polite scraping is enforced in `src/http.js`** (Phase 1). Every outbound
HTTP call must go through `politeFetch` (1 req/sec/host, retry on 429/503,
contactable User-Agent). Do not call `undici`/`fetch` directly.

**Swedish genitive correction has a whitelist, not a heuristic.**
`src/seed.js` strips trailing `s` from kommun names unless they're in
`NAMES_ENDING_IN_S_NATURALLY` (-ås/-näs/-fors + Grums). Extend the whitelist
when adding a -fors kommun or it will be silently corrupted (Bengtsfors was).

**Cross-domain email filter is strict** (`src/crawl.js`): domain equals or is
a dot-anchored subdomain of the kommun's home domain. A bare
`endsWith(homeDomain)` would accept look-alikes (`xvasteras.se`). The same
rule shapes `sameEmailDomain` in `src/gmail.js`.

**Personal-email filter targets `firstname.lastname[N]@` patterns**; the
functional-words allowlist in `crawl.js` keeps multi-word functional
addresses from being misflagged. New role keywords in `classify.js` may also
belong in `FUNCTIONAL_EMAIL_WORDS`.

## Test pattern

All tests run offline. Network/IO is faked by:

- `politeFetch.__setFetch(fakeFetch)` for HTTP tests
- `{ fetch: fakeFetch }` option to `crawlKommun`; `{ checkMx }` stub for `verifyAll`
- Fake `gmailOps` / `slackOps` objects injected into `runTick` deps; a
  `gmailSendImpl` seam in `sendApprovedReply`; `vi.spyOn(analyseMod,
  'analyseMessage')` to force/skip the LLM path; injected `analyseContracts`
- Temp-dir SQLite DBs (`mkdtempSync` + `openDb` + `migrate()`) — never the
  live `data/pilot.db`
- Hand-crafted HTML fixtures in `tests/fixtures/` for parser tests

When the live behaviour of a parser/classifier needs to change because a real
site/mail uses a pattern the fixture doesn't, **update the fixture first** so
the test still expresses the live contract — don't make the test more
permissive to paper over the change.

## Where to look for what

- Safety review + autopilot roadmap: `docs/superpowers/specs/2026-07-05-autopilot-readiness-review.md`
- Pilot FSM/automation design: `docs/superpowers/specs/2026-05-18-pilot-automation-design.md`
- Next-action/staleness rules: `docs/superpowers/specs/2026-06-23-trustworthy-next-action-design.md`
- Threads & recipient routing: `docs/superpowers/specs/2026-07-03-conversation-threads-and-recipients-design.md`
- Collection schema/roles: `docs/superpowers/specs/2026-05-16-municipality-email-collection-design.md`
- User-facing usage/outputs: `README.md`
- Persistent state: `data/` (JSON/CSV committed; `pilot.db`, backups, and
  `contracts/` git-ignored — they contain PII)
