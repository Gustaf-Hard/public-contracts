# V1 Pilot — Autonomous offentlighetsprincipen request loop

**Date:** 2026-05-18
**Phase:** 2 / v1 (pilot — 5 kommuner, ~4-week run)
**Owner:** gustaf@binogi.com
**Builds on:** Phase 1 contact dataset at `data/municipalities.json`

## Goal

Prove that the dispatch + reply + follow-up loop can run autonomously for **five small Swedish kommuner** with minimal human intervention. Success of the pilot determines whether to scale to all 290 kommuner in v2.

This pilot does **not** parse contracts. PDFs land in a folder; structured extraction (leverantör / produkt / värde / avtalsperiod) is v2.

## Two-stage rollout

To minimise blast radius before any real kommun is contacted, the v1 pilot runs in two stages:

- **Stage 0 — Rehearsal**: bot communicates with a synthetic "Testkommun" controlled by the project owner. The owner plays the registrator from a separate Gmail account (`gustaf.hard@gmail.com`) and walks through six scripted scenarios that exercise every state transition, template, and escalation path. No real kommun is involved.
- **Stage 1 — Live pilot**: only after every Stage 0 scenario passes, the same bot is pointed at the five real kommuner listed below. The flip between stages is a config change, not a code change.

Stage 0 is detailed in its own section near the end of this spec.

## Approval-first autonomy model

**v1 is human-in-the-loop for every outbound message except the initial request.** The previous design assumed "the bot is right by default, escalate the unknowns" — but classifier patterns like the bare word *precisera* are too brittle to bet on before we've seen real reply phrasings. The correct model is the inverse: "the bot is wrong by default, promote what proves itself safe."

Concretely:

- **Inbound processing is automatic.** Bot pulls new mail, saves PDFs, records the message, runs the classifier, updates conversation state. Nothing leaves the laptop.
- **Outbound messages always pause on Slack approval**, except `T-INITIAL` (which is approved by virtue of being the template the owner personally wrote). For every other outbound — `T-PRECISION`, `T-RECEIPT`, `T-FOLLOWUP-NUDGE`, `T-FOLLOWUP-CLOSE`, or a free-form reply for an unclassifiable message — the bot drafts the message and posts it to Slack with **Approve / Edit / Skip** buttons. Nothing gets sent until the human clicks.
- **The classifier's job is to suggest the right draft**, not to decide on autopilot. Even when the classifier is highly confident, the human still approves before send.
- **Every decision is logged** to a `decisions` table: which classifier guess, which draft, whether the human approved unmodified / edited / skipped. After the pilot, this log is the basis for deciding which classifier classes are safe to auto-handle in v2.

This trades a small amount of click-time (~30 seconds per inbound reply, ~5 minutes/day at pilot scale) for zero risk of an embarrassing auto-sent wrong reply, and produces the labelled dataset we need to safely automate at 290-kommun scale.

**v2 graduation criterion**: any (classifier_class, conversation_state) pair where the human approved the bot's draft unmodified ≥5 consecutive times AND zero edits during the pilot becomes eligible for promotion to auto-handle. The promotion is a manual config edit — there's no auto-trust algorithm.

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
- ≥80% of suggested drafts are approved unmodified in Slack — these become the v2 auto-handle promotion candidates. (Note: this is a measure of *classifier quality*, not autonomy — every draft is still human-approved in v1.)
- Zero state loss: bot can be killed and restarted; every conversation resumes correctly from SQLite.
- Total contracts received ≥10 PDFs across all 5 kommuner.
- The `decisions` log accumulates ≥30 reviewed drafts across all kommuner — enough sample size to inform v2 auto-promotion decisions.

If those bars are met, scale to all 290 kommuner with selectively auto-handled classes. If not, iterate on what failed before scaling.

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
  draft_subject TEXT,                 -- bot's suggested reply subject
  draft_body TEXT,                    -- bot's suggested reply body
  slack_ts TEXT,                      -- Slack message timestamp for callback matching
  status TEXT NOT NULL,               -- 'open' | 'resolved_send' | 'resolved_edit' | 'resolved_skip'
  resolved_at TEXT,
  resolved_text TEXT                  -- final outbound text if status was send/edit
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  escalation_id INTEGER NOT NULL REFERENCES escalations(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  conversation_state TEXT NOT NULL,   -- state at time of decision
  classifier_class TEXT,              -- classifier's guess on the inbound
  classifier_confidence REAL,
  draft_template TEXT,                -- 'T_PRECISION' | 'T_RECEIPT' | 'T_FOLLOWUP_NUDGE' | 'T_FOLLOWUP_CLOSE' | 'free_form'
  draft_body TEXT NOT NULL,
  decision TEXT NOT NULL,             -- 'approve_unmodified' | 'edit' | 'skip'
  final_body TEXT,                    -- actual sent body (== draft_body for approve_unmodified, edited body for edit, null for skip)
  decided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_class_state ON decisions(classifier_class, conversation_state, decision);
```

The `decisions` index is the v2 promotion query: `SELECT classifier_class, conversation_state, decision, count(*) FROM decisions GROUP BY 1,2,3` shows which (class, state) pairs got unmodified approvals.

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

**The classifier in v1 is a draft suggestion engine, not a decision engine.** Every classifier output produces a draft that gets posted to Slack for the human to approve. The classifier's quality is measured by how often its drafts get approved unmodified — that's the signal for what's safe to promote to auto-handle in v2.

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
GMAIL_USER_EMAIL=gustaf@mediagraf.se
GMAIL_FROM_NAME=Gustaf Hård af Segerstad

SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=
SLACK_INTERACTIVITY_PUBLIC_URL=   # ngrok URL while pilot is running
```

The bot's outbound identity is `gustaf@mediagraf.se` — a Google Workspace mailbox on the mediagraf.se domain. Replies from kommuner come back to the same address. Kommuner see a `From: Gustaf Hård af Segerstad <gustaf@mediagraf.se>` header, which reads as a real company contact rather than a personal Gmail.

The OAuth client is registered in **Google Cloud Console** under a project owned by the Mediagraf Workspace. Because mediagraf.se is a Workspace domain you control, you can register the OAuth consent screen as **Internal** (user type = "Internal" in the consent-screen config) — this avoids Google's external-app verification process entirely and the only user who can grant consent is you. Required scopes: `gmail.send`, `gmail.readonly`, `gmail.modify`.

The Slack app is registered at api.slack.com/apps. Setup steps documented in the plan.

The synthetic "Testkommun" used in Stage 0 keeps `gustaf.hard@gmail.com` (a plain Gmail account, not on the Workspace) precisely so it's externally addressable and there's no accidental same-Workspace coupling between the bot's sending account and the fake kommun's receiving account.

A second file `data/pilot-overrides.json` (committed — no secrets in it) selects which kommuner the pilot acts on:

```json
{
  "active_pilot_kommun_kods": ["9999"],
  "rehearsal_kommuner": [
    {
      "kommun_kod": "9999",
      "kommun_namn": "Testkommun",
      "lan": "Testlän",
      "folkmangd": 0,
      "contacts": [
        { "role": "central",     "email": "gustaf.hard@gmail.com" },
        { "role": "utbildning",  "email": "gustaf.hard@gmail.com" }
      ]
    }
  ]
}
```

`pilot-init.js` and the daemon honour `active_pilot_kommun_kods` as a whitelist. When it contains `9999`, the bot picks the kommun definition from `rehearsal_kommuner`; otherwise it picks the kommun from `data/municipalities.json`. The Stage 0 → Stage 1 transition is a one-line edit (`["9999"]` → `["2418","1438","0509","2404","0560"]`) followed by a daemon restart.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Classifier mis-categorises a real reply and the bot drafts the wrong response | Every draft is approved in Slack before send. Worst case: you edit or skip. No mis-sent emails reach kommuner. |
| Click fatigue — too many Slack approvals per day | Pilot scale is ~10 inbound replies/week across 5 kommuner. ~5 min/day of attention. If that's too much, classes with high unmodified-approve rates get promoted to auto in v2. |
| A kommun considers the request abusive or asks for fees | All such replies surface in Slack as drafts you review. You can edit, escalate, or contact the kommun out-of-band. |
| The bot accidentally double-sends because it polls a message before its own outbound is recorded | All Gmail message IDs (both inbound and outbound) are written to SQLite atomically before the bot considers itself done with that message |
| ngrok URL changes (free tier) and Slack interactivity breaks | Daemon re-prints the current ngrok URL on startup; you update the Slack app's URL once per session — or pay $8/mo for static ngrok. The CLI fallback `pilot-resolve.js` works without Slack. |
| Gmail OAuth token expires while you're away | Use offline refresh tokens (standard); auth flow only required once |
| PDFs are scanned images that we can't parse later | Pilot doesn't parse — defer to v2. Storing the source PDF preserves the option. |

## Stage 0 — Rehearsal against synthetic kommun

Before the bot ever sends an email to a real kommun, run the entire pipeline against a synthetic "Testkommun" (kod `9999`). You play the registrator from a separate Gmail account (`gustaf.hard@gmail.com`); the bot doesn't know it's not a real kommun. The purpose is to exercise every state-machine transition, every template, and the Slack escalation flow with zero blast radius.

### Setup

1. The "Testkommun" inbox is your existing personal Gmail account `gustaf.hard@gmail.com`. You'll play the registrator from there. Setup tip: create a Gmail filter that labels anything from `gustaf@mediagraf.se` as `Testkommun` so the rehearsal mail stays visually separated from your normal personal mail.
2. Set `data/pilot-overrides.json` `active_pilot_kommun_kods` to `["9999"]` and confirm `rehearsal_kommuner` contains the synthetic kommun as shown in the Configuration section.
3. Start the daemon as you would in live mode.

### Clock-skew override

For follow-up timing tests, the daemon accepts a `PILOT_CLOCK_OFFSET_DAYS` env var (default `0`) that artificially advances "now" by N days. This lets us validate 7-/10-/14-day follow-up rules in a single afternoon instead of waiting weeks. The override is rejected when `active_pilot_kommun_kods` contains any kod other than `9999` — it must not be possible to clock-skew the live pilot.

### Six scripted scenarios

Run through these in order from the test Gmail account. After each scenario, inspect `data/pilot.db` (e.g. `sqlite3 data/pilot.db "select state, state_changed_at from conversations"`) to confirm the expected transitions happened.

Note: in v1 every outbound reply goes through Slack approval. The scenarios below assume the daemon is running and Slack interactivity is wired. *T-INITIAL* is the only auto-sent message (it's scheduled).

**Scenario A — Happy path (no clarification needed)**
1. Trigger: `node scripts/pilot-init.js`. Bot sends T-INITIAL to `gustaf.hard@gmail.com` automatically on schedule (both `central` and `utbildning` roles — two separate threads).
2. From the test account, reply on the `utbildning` thread with: *"Tack för din begäran. Ärendenummer: K9999001. Vi återkommer."*
   - **Expected:** classifier `auto_ack`, state `SENT → ACK_RECEIVED`, `arendenummer = "K9999001"` saved. No outbound (auto_ack doesn't need a reply). No Slack post.
3. Reply with a small dummy PDF attached and body *"Hej! Här kommer ett avtal med Skolon. Med vänlig hälsning, Test Registrator."*
   - **Expected:** classifier `delivery`, state `ACK_RECEIVED → DELIVERING`, PDF saved to `data/contracts/9999/`. Slack post appears with T-RECEIPT draft + Approve/Edit/Skip buttons.
4. In Slack, click **Approve**.
   - **Expected:** T-RECEIPT outbound sent to test account, `decisions` row written with `decision = 'approve_unmodified'`, `receipt_sent = 1`.
5. Set `PILOT_CLOCK_OFFSET_DAYS=14` and trigger the daily follow-up tick.
   - **Expected:** Slack post appears with T-FOLLOWUP-CLOSE draft.
6. In Slack, click **Approve**. Then reply *"Detta var samtliga avtal vi har."*
   - **Expected:** classifier `dead_end` (specifically the "samtliga avtal" closer), state `DELIVERING → DONE`.

**Scenario B — Clarification round-trip**
1. Re-run `pilot-init` for a fresh conversation (or reset DB).
2. Reply auto-ack as in Scenario A. State `SENT → ACK_RECEIVED`, no Slack post.
3. Reply: *"Kan du precisera vilken tidsperiod du önskar? Och om du vill ha alla avtal eller bara aktiva?"*
   - **Expected:** classifier `clarification`, state `ACK_RECEIVED → AWAITING_PRECISION`. Slack post appears with T-PRECISION draft.
4. In Slack, click **Edit**, slightly modify the draft text, submit.
   - **Expected:** edited reply sent. `decisions` row with `decision = 'edit'` and the edited `final_body`. Conversation stays in `AWAITING_PRECISION`.
5. Reply with PDF attachment.
   - **Expected:** state `AWAITING_PRECISION → DELIVERING`. Slack post for T-RECEIPT. Approve it.

**Scenario C — Dead-end straight from the start**
1. Reply to T-INITIAL with: *"Vi har tyvärr inga avtal av detta slag i vår verksamhet."*
   - **Expected:** classifier `dead_end`, state `SENT → DEAD_END`, no further outbound, no Slack post (dead_end is terminal).

**Scenario D — Silent kommun → follow-up nudge**
1. Don't reply to T-INITIAL.
2. Set `PILOT_CLOCK_OFFSET_DAYS=7` and trigger the daily follow-up tick.
   - **Expected:** Slack post appears with T-FOLLOWUP-NUDGE draft.
3. In Slack, click **Approve**. Then reply auto-ack belatedly from the test account.
   - **Expected:** outbound sent, state `SENT → ACK_RECEIVED`, follow-up counter reset to 0.

**Scenario E — Ambiguous reply → Slack escalation with no draft**
1. Reply to T-INITIAL with something the classifier shouldn't recognise: *"Hej, kan du ringa mig på 070-1234567 så pratar vi om detta?"*
   - **Expected:** classifier `unknown` (no signals above threshold), state stays `SENT` (or moves to `NEEDS_HUMAN`). Slack post appears with `draft_body = "(ingen draft — skriv själv)"` placeholder text. The post emphasises this is a `free_form` decision.
2. In Slack, click **Edit**, type a reply: *"Tack, men jag föredrar att vi håller kommunikationen via e-post."*, submit.
   - **Expected:** outbound sent. `decisions` row with `draft_template = 'free_form'`, `decision = 'edit'`, the typed `final_body`. State returns to whatever the natural next state is.

**Scenario F — Multi-batch delivery**
1. Reply auto-ack. State `SENT → ACK_RECEIVED`, no Slack post.
2. Reply with PDF #1. Slack post with T-RECEIPT draft → **Approve**. State → `DELIVERING`, `receipt_sent = 1`.
3. Reply 3 days later (use clock skew) with PDF #2, no body text.
   - **Expected:** state stays `DELIVERING`, PDF #2 saved, **no Slack post** (the bot skips drafting T-RECEIPT a second time because `receipt_sent = 1`).
4. Reply 5 days later with PDF #3 plus *"Detta var samtliga avtal."*
   - **Expected:** state `DELIVERING → DONE` because the closer pattern matched. No Slack post (DONE is terminal).

### Stage 0 → Stage 1 gate

Stage 1 (live pilot) must NOT be unlocked until every one of the six scenarios runs through to its expected end state without manual DB intervention. After the gate passes:

1. Reset `data/pilot.db` (delete and let `pilot-init.js` recreate).
2. Clear `data/contracts/9999/`.
3. Edit `data/pilot-overrides.json`: set `active_pilot_kommun_kods` to `["2418","1438","0509","2404","0560"]`.
4. Restart the daemon.

The same code runs both stages — only the config differs.

## Open questions deferred to v2

- Structured contract extraction (LLM, OCR, or human-in-the-loop coding)
- Sekretess (redaction) handling and re-requests for unredacted versions when justified
- Vendor/product canonicalization (does Google Classroom = Google Workspace = G Suite?)
- Search/query UI for the resulting market-intelligence database
- Multi-conversation correlation when a registrator hands off to another förvaltning (Mikaela's "ligger hos stadsledningskontoret" case)
- Scaling to all 290 kommuner — rate limits, monitoring, error budgets
