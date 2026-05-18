# V1 Pilot — Autonomous offentlighetsprincipen request loop

**Date:** 2026-05-18
**Phase:** 2 / v1 (pilot — 5 kommuner, ~4-week run)
**Owner:** gustaf@binogi.com
**Builds on:** Phase 1 contact dataset at `data/municipalities.json`

## Goal

Prove that the dispatch + reply + follow-up loop can run autonomously for **five small Swedish kommuner** with minimal human intervention. Success of the pilot determines whether to scale to all 290 kommuner in v2.

This pilot does **not** parse contracts. PDFs land in a folder; structured extraction (leverantör / produkt / värde / avtalsperiod) is v2.

## Pilot kommuner

Selected from `data/municipalities.json` as the five smallest `confidence: high` kommuner:

| Kommun_kod | Namn | Folkmängd |
|---|---|---|
| 2418 | Malå | 2 902 |
| 1438 | Dals-Ed | 4 571 |
| 0509 | Ödeshög | 5 221 |
| 2404 | Vindeln | 5 421 |
| 0560 | Boxholm | 5 451 |

Each kommun has a `central` contact AND a `utbildning`-family contact (verified by their `high` confidence rating). Two parallel email threads will run per kommun → **10 active conversations** at peak.

## Success criteria

- All 10 threads (5 × 2) dispatch their initial request within the 5-day stagger window.
- ≥3 of 5 kommuner reach `DELIVERING` (at least one contract PDF received) within 4 weeks.
- ≥80% of incoming replies are handled by the bot without human escalation.
- Zero state loss: bot can be killed and restarted; every conversation resumes correctly from SQLite.
- Total contracts received ≥10 PDFs across all 5 kommuner.

If those bars are met, scale to all 290 kommuner. If not, iterate on what failed before scaling.

## Out of scope

- Structured PDF extraction (leverantör/produkt/värde/avtalsperiod) — v2.
- Sekretess (redaction) handling — pilot stores PDFs verbatim.
- Multi-user / multi-tenant — single Gmail account, single Slack channel.
- Cloud deploy — runs on a local laptop (or local always-on machine).
- Discovery for low-confidence kommuner — pilot ignores those entirely.
- Outbound at scale — Gmail rate limits not a concern at this volume.
- Any förvaltning outside `central` + utbildning-family for this pilot (gymnasie, vuxenutbildning, IT etc. wait for v2).

## Architecture

Extends the existing repo. No new top-level project.

### New files

```
src/
  gmail.js          # Gmail API: read threads, send replies, fetch attachments
  slack.js          # Slack app: post escalations, receive button payloads
  conversation.js   # State machine + persistence (SQLite via better-sqlite3)
  classifier.js     # Regex/keyword classification of incoming Swedish replies
  templates.js      # T-INITIAL, T-PRECISION, T-RECEIPT, T-FOLLOWUP
  pilot-config.js   # Pilot config: 5 kommun_kods, signature, follow-up cadence
scripts/
  pilot-auth.js     # One-time Gmail OAuth flow → writes token to ~/.config/...
  pilot-init.js     # Seeds SQLite from data/municipalities.json + sends day-N initial mail
  pilot-tick.js     # Cron tick: pulls new mail, classifies, acts, escalates
  pilot-resolve.js  # CLI fallback: apply a Slack decision (send/edit/skip) from terminal
data/
  pilot.db          # SQLite — see schema below
  contracts/
    2418/           # Malå
    1438/           # Dals-Ed
    …               # received PDFs + .meta.json sidecars per file
```

### Conversation state machine

One `conversation` row per (kommun_kod, role) pair — so 10 rows initially.

```
INITIAL                                  (row exists, T-INITIAL not yet sent)
   │
   ▼ T-INITIAL sent
SENT                                     (waiting for any reply)
   │
   ├── auto-ack matched ──▶ ACK_RECEIVED    (waiting for human registrator)
   │                            │
   │                            ▼ human reply received
   │                       classify reply ──┐
   ▼                                        │
DELIVERING ◀── contract reply ──────────────┤
   │                                        │
   │                                        │
   ├── clarification reply ──▶ AWAITING_PRECISION ──▶ T-PRECISION sent ──▶ ACK_RECEIVED
   │                                        │                                 │
   │                                        ▼                                 ▼
   │                                   DEAD_END ◀── "finns inte" / "hänvisar till"
   ▼
DONE ◀── "samtliga avtal" / "inga ytterligare" / 14 days silent after DELIVERING

NEEDS_HUMAN  (side-state — any state can be flagged; resume after Slack action)
```

Transitions are explicit table-driven, not implicit. Every transition logs the message that triggered it.

### SQLite schema

```sql
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  kommun_kod TEXT NOT NULL,
  kommun_namn TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'central' | 'utbildning' | 'gymnasie' | …
  contact_email TEXT NOT NULL,
  gmail_thread_id TEXT,               -- set after T-INITIAL sent
  state TEXT NOT NULL,                -- INITIAL / SENT / ACK_RECEIVED / …
  state_changed_at TEXT NOT NULL,     -- ISO timestamp; drives follow-up scheduling
  last_outbound_at TEXT,              -- when we last sent something
  arendenummer TEXT,                  -- e.g. K202642713
  notes TEXT,
  UNIQUE(kommun_kod, role)
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  gmail_message_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL,            -- 'outbound' | 'inbound'
  from_email TEXT,
  to_email TEXT,
  subject TEXT,
  body_text TEXT,                     -- plain text body
  classification TEXT,                -- 'auto_ack' | 'clarification' | 'delivery' | 'dead_end' | 'unknown'
  classification_confidence REAL,     -- 0.0–1.0
  received_at TEXT NOT NULL,
  attachment_count INTEGER DEFAULT 0
);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  filename TEXT NOT NULL,
  saved_path TEXT NOT NULL,           -- data/contracts/<kod>/<id>__<filename>
  mime_type TEXT,
  size_bytes INTEGER
);

CREATE TABLE escalations (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  message_id INTEGER REFERENCES messages(id),
  reason TEXT NOT NULL,
  draft_reply TEXT,                   -- bot's suggested response (or null)
  slack_ts TEXT,                      -- Slack message timestamp for callback matching
  status TEXT NOT NULL,               -- 'open' | 'resolved_send' | 'resolved_edit' | 'resolved_skip'
  resolved_at TEXT,
  resolved_text TEXT                  -- final outbound text if status was send/edit
);
```

### Gmail integration

- OAuth scopes: `gmail.send`, `gmail.readonly`, `gmail.modify` (to label messages).
- Auth flow: `node scripts/pilot-auth.js` opens a browser → consent → token stored at `~/.config/mediagraf/pilot-gmail-token.json` (path configurable).
- Gmail label `mediagraf/pilot/<state>` applied to threads so you can see state in the Gmail UI alongside the SQLite truth.
- Sending: `gmail.users.messages.send` with `threadId` set so replies thread correctly. `In-Reply-To` / `References` headers set explicitly.
- Receiving: `pilot-tick.js` queries `users.history.list` with the last `historyId` checkpoint OR (simpler for v1) `users.messages.list?q=label:mediagraf/pilot newer_than:1d` and processes any unseen.
- Attachments fetched via `users.messages.attachments.get` then written to disk.

### Slack integration

- Slack app (you'll register it at api.slack.com/apps) with bot token + signing secret + interactivity URL.
- Local long-running process exposes `/slack/interactivity` on port 3000.
- `ngrok http 3000` provides the public URL during the pilot. Token + ngrok URL stored in a `.env` file (gitignored — extend `.gitignore`).
- Posts use Block Kit with three buttons: `Approve` (sends the draft reply as-is), `Edit` (opens a modal so you can rewrite the reply), `Skip` (marks the escalation `resolved_skip` and parks the conversation in `NEEDS_HUMAN` until you act otherwise).
- Fallback if ngrok is down: `node scripts/pilot-resolve.js --escalation=<id> --action=send|edit|skip [--text="..."]`.

### Cron / scheduling

Two ticks:

1. **15-minute tick** (`pilot-tick.js`):
   - Pull new inbound Gmail messages for tracked threads.
   - For each new message: extract text + attachments, classify, transition state, take action (send reply, save PDFs, escalate, do nothing).

2. **09:00 daily tick** (`pilot-followup.js`, or `pilot-tick.js --daily`):
   - Find conversations stale per follow-up policy:
     - `SENT` for ≥7 days → send T-FOLLOWUP-NUDGE.
     - `ACK_RECEIVED` for ≥14 days → send T-FOLLOWUP-NUDGE.
     - `AWAITING_PRECISION` for ≥10 days → send T-FOLLOWUP-NUDGE.
     - `DELIVERING` for ≥14 days with no new attachment → send T-FOLLOWUP-CLOSE ("har du fler avtal som inte skickats än?"); if no reply within 7 more days, transition to `DONE`.
   - Maximum 2 follow-up nudges per conversation before flagging to `NEEDS_HUMAN`.

Schedule via local `cron` OR `node-cron` inside a long-running `npm run pilot-daemon` process (recommended — keeps the Slack listener and the ticker in one process).

### Initial dispatch — staggered 1/day over 5 days

`pilot-init.js` is run once. It seeds SQLite for all 10 conversations in state `INITIAL`. Then each day at 10:00 the daemon sends the next day's batch (2 emails — central + utbildning for that day's kommun). Order:

- Day 1: Malå
- Day 2: Dals-Ed
- Day 3: Ödeshög
- Day 4: Vindeln
- Day 5: Boxholm

This lets us watch each kommun's auto-ack pattern before all 5 are in flight — if Malå's auto-ack uses an unusual format, we fix the classifier before Day 2.

## Reply classifier

Goal: classify each inbound message into one of `{auto_ack, clarification, delivery, dead_end, unknown}`. Regex + keyword scoring, **no LLM in v1**.

| Class | Signals (any of) | Examples from your Västerås thread |
|---|---|---|
| `auto_ack` | `Ärendenummer:\s*[KkA-Z]\d{6,}`, `Tack för att du hörde av dig`, `flexiteBPMS`, `kvittens` | "Ärendenummer: K202642713" |
| `clarification` | `precisera`, `förtydliga`, `vilken tidsperiod`, `vilka system`, `sammanställning eller specifika`, body ends with `?` and contains `behöver`/`önskar`/`kan du` | Mikaela's first reply |
| `delivery` | ≥1 PDF attachment AND body contains `bifogat`/`avtal`/`avtalshandlingar`/`här kommer` | Subsequent emails with attached contracts |
| `dead_end` | `finns inte`, `hänvisar (er )?till`, `omfattas inte`, `kan vi inte lämna ut`, `ligger hos`/`hanteras centralt` (without a usable address) | Mikaela: "huvudavtalet finns på stadsledningen" |
| `unknown` | none of the above | escalate |

Each signal contributes a confidence score; class wins if its score > threshold (e.g. 0.6) and beats the second-best by margin (e.g. 0.2). Otherwise → `unknown` → escalate.

The classifier is intentionally simple — when it gets things wrong, we add patterns. After 1 week of pilot we'll know what we missed.

## Reply templates

Templates live in `src/templates.js` as functions returning `{ subject, body }`.

### T-INITIAL (sent to each role)

```
Subject: Begäran om allmänna handlingar – avtal för digitala verktyg, lärplattformar och läromedel

Hej,

Jag begär härmed att ta del av allmänna handlingar med stöd av offentlighets-
principen (2 kap. tryckfrihetsförordningen).

Jag önskar ta del av de faktiska avtalsdokumenten för samtliga gällande avtal
avseende digitala verktyg, lärplattformar och läromedel inom
{förvaltning_kontext}.

Specifikt önskar jag information om aktiva avtal (ej utgångna):
- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)
- Digitala läromedel och licenser
- Administrativa system kopplade till undervisning

Per avtal önskar jag följande uppgifter där möjligt:
- Leverantör
- Produktnamn/tjänst
- Avtalsvärde eller årskostnad
- Avtalstid (start- och slutdatum)

Handlingarna önskas i digital form (PDF eller motsvarande).

Om delar av handlingarna bedöms sekretessbelagda ber jag om ett motiverat
avslagsbeslut för dessa delar enligt 6 kap. 3 § offentlighets- och sekretess-
lagen.

Med vänliga hälsningar,
Gustaf Hård af Segerstad
{kontakt_email}
```

`{förvaltning_kontext}` resolves to "utbildningsförvaltningen" for utbildning-role threads and to "kommunen" for central-role threads. This pre-empts Mikaela's "specify time period / specific systems / summary or full" question — by including the specificity up front we reduce clarification round-trips.

### T-PRECISION

Sent when the classifier sees `clarification`. Re-states the same specifics from T-INITIAL but in conversational tone:

```
Subject: Re: <thread subject>

Hej,

Tack för snabbt svar! Jag preciserar gärna min begäran.

Jag efterfrågar aktiva avtal (ej utgångna) avseende digitala verktyg
inom {förvaltning_kontext}:

- Lärplattformar och LMS (t.ex. Google Workspace, Microsoft 365, Skolon)
- Digitala läromedel och licenser
- Administrativa system kopplade till undervisning

Per avtal önskar jag: leverantör, produktnamn/tjänst, avtalsvärde eller
årskostnad, avtalstid (start- och slutdatum). Dels de fullständiga
avtalshandlingarna i PDF-format.

Med vänliga hälsningar,
Gustaf
```

### T-RECEIPT

Sent when `delivery` was classified AND it's the first delivery in the thread (subsequent deliveries don't get a receipt — that creates noise).

```
Subject: Re: <thread subject>

Hej,

Tack så mycket för avtalen — jag har tagit emot dem. Är detta samtliga
avtal eller är fler på väg?

Med vänliga hälsningar,
Gustaf
```

### T-FOLLOWUP-NUDGE

Sent per the cron schedule above.

```
Subject: Påminnelse: <original thread subject>

Hej,

Jag vill bara följa upp om min begäran om allmänna handlingar (skickad
{X dagar} sedan). Behöver ni ytterligare information från min sida för
att kunna behandla ärendet?

Med vänliga hälsningar,
Gustaf
```

### T-FOLLOWUP-CLOSE

Sent when in `DELIVERING` for ≥14 days with no new attachments.

```
Subject: Re: <thread subject>

Hej,

Tack igen för avtalen jag fått. Har ni ytterligare avtal som inte
skickats än, eller kan vi betrakta begäran som slutförd från er sida?

Med vänliga hälsningar,
Gustaf
```

## Storage of received contracts

For every PDF attachment in a `delivery` message:

- Path: `data/contracts/<kommun_kod>/<received_date>__<gmail_message_id>__<safe_filename>.pdf`
- Sidecar: same path with `.meta.json` containing:

  ```json
  {
    "kommun_kod": "2418",
    "kommun_namn": "Malå",
    "role": "utbildning",
    "received_at": "2026-05-22T10:14:00+02:00",
    "from_email": "barn.utbildning@mala.se",
    "from_name": "...",
    "gmail_message_id": "...",
    "gmail_thread_id": "...",
    "subject": "...",
    "original_filename": "..."
  }
  ```

## Configuration & secrets

A new file `.env` (gitignored) holds:

```
GMAIL_OAUTH_CLIENT_ID=
GMAIL_OAUTH_CLIENT_SECRET=
GMAIL_USER_EMAIL=gustaf.hard@gmail.com
GMAIL_FROM_NAME=Gustaf Hård af Segerstad

SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=
SLACK_INTERACTIVITY_PUBLIC_URL=   # ngrok URL while pilot is running
```

The OAuth client is registered in Google Cloud Console once (you'll need to verify the OAuth consent screen for personal Gmail). The Slack app is registered at api.slack.com/apps. Setup steps documented in the plan.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Classifier mis-categorises a real reply as `unknown` and the bot stalls | Escalation is preferred over silent failure — `unknown` → Slack ping, you decide |
| A kommun considers the request abusive or asks for fees | The bot detects `dead_end` patterns including "avgift" / "kostnad" / "kan ej lämna ut" — escalates instead of acting |
| The bot accidentally double-sends because it polls a message before its own outbound is recorded | All Gmail message IDs (both inbound and outbound) are written to SQLite atomically before the bot considers itself done with that message |
| ngrok URL changes (free tier) and Slack interactivity breaks | Daemon re-prints the current ngrok URL on startup; you update the Slack app's URL once per session — or pay $8/mo for static ngrok |
| Gmail OAuth token expires while you're away | Use offline refresh tokens (standard); auth flow only required once |
| PDFs are scanned images that we can't parse later | Pilot doesn't parse — defer to v2. Storing the source PDF preserves the option. |

## Open questions deferred to v2

- Structured contract extraction (LLM, OCR, or human-in-the-loop coding)
- Sekretess (redaction) handling and re-requests for unredacted versions when justified
- Vendor/product canonicalization (does Google Classroom = Google Workspace = G Suite?)
- Search/query UI for the resulting market-intelligence database
- Multi-conversation correlation when a registrator hands off to another förvaltning (Mikaela's "ligger hos stadsledningskontoret" case)
- Scaling to all 290 kommuner — rate limits, monitoring, error budgets
