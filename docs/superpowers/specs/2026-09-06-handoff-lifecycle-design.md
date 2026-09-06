# Handoff lifecycle — durable hänvisning tasks (2026-09-06)

## Problem

When a kommun answers "contact X instead" (classified `handoff`, address
extracted), acting on it today takes two manual steps on `/arenden/:id`: approve
the polite reply, then click the suggested ärende for the new address. The
suggestion exists only in that page's render. If the operator never revisits the
page, the handoff dies silently — no queue item, no nag, no record that an
extracted address was never contacted. Bengtsfors → helen.pettersson@amal.se sat
unactioned from 2026-08-14 until a manual audit found it.

Decision (operator, 2026-09-06): **auto-draft and nag, never auto-send.** The
system prepares everything and refuses to let the task be forgotten; every
outbound still rides an operator click.

## What already exists (and is kept)

- `parseHandoffTargets` (handoff.js): extracts targets from the analysis with
  `verbatim` and `same_domain` flags; role assignment via `splitHandoffContacts`.
- `db.listHandoffContacts(kommun_kod)`: handoff addresses already merge into the
  kommun page contact list (`kommun_handoff`, highest trust) and quick-init
  candidates. This is the "CRM" half — Helen already shows on Bengtsfors' page.
- The suggested-ärende panel on `/arenden/:id` with per-address double-message
  guard (`startedByEmail`), proven by Göteborg #64/#65.
- `sendInitial` (send-reply.js): the ONE path that starts a new conversation,
  with kommun+role uniqueness and INITIAL→SENDING→SENT two-phase send.

## Design

### 1. `handoff_tasks` table (append-only migration)

```sql
CREATE TABLE IF NOT EXISTS handoff_tasks (
  id INTEGER PRIMARY KEY,
  kommun_kod TEXT NOT NULL,
  address TEXT NOT NULL,            -- lowercased
  forvaltning TEXT,                 -- from splitHandoffContacts, nullable
  role TEXT,                        -- suggested role slug for the new conversation
  source_conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  source_message_id INTEGER NOT NULL REFERENCES messages(id),
  verbatim INTEGER NOT NULL DEFAULT 0,
  same_domain INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | started | dismissed | superseded
  started_conv_id INTEGER REFERENCES conversations(id),
  dismissed_reason TEXT,
  last_nag_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_tasks_pending
  ON handoff_tasks(kommun_kod, address) WHERE status = 'pending';
```

Status semantics:
- `pending` — address extracted, no conversation to it exists. At most ONE
  pending row per (kommun_kod, address) — the partial unique index enforces it.
- `started` — a conversation to the address exists (`started_conv_id` set).
  Tasks are born `started` when the address already has a conversation at
  detection time (link, don't nag).
- `dismissed` — operator explicitly declined, with a reason (auditable).
- `superseded` — a newer handoff from the same source conversation replaced
  this one (mirrors the escalation supersede rule).

### 2. Detection → task creation (tick ingest)

In the ingest step, after a message's analysis lands with `intent === 'handoff'`
and extracted address(es): run `parseHandoffTargets` (same inputs the dashboard
uses today) and upsert tasks:

- address already has a conversation for this kommun → insert as `started`.
- open `pending` task for the same (kommun, address) → keep it (no dupe).
- pending task(s) from the SAME source conversation for OTHER addresses →
  mark `superseded` (newest handoff wins, like the dashboard's "newest wins").
- otherwise insert `pending`.

Detection is part of the per-message ingest transaction — a crash mid-ingest
leaves the message unrecorded and the tasks are created on retry, never
half-written (existing invariant, extended to the new table).

**Backfill:** a migration-time one-shot scans existing inbound messages with
`intent === 'handoff'` (newest per conversation) and creates tasks under the
same rules. Bengtsfors/Helen becomes `pending`; Göteborg's targets become
`started` linked to #64/#65. The backfill is idempotent (the unique index makes
re-runs no-ops).

### 3. Surfacing

- **Overview "Behöver dig" queue**: pending tasks render as queue rows —
  "Hänvisning: starta ärende → {address} ({kommun} angav adressen)" — linking to
  the source ärende. The queue count includes them.
- **`/arenden/:id`**: the suggested-ärende panel reads from `handoff_tasks`
  instead of recomputing from the last message. Buttons per pending task:
  **Starta & skicka** (existing quick-init flow, pre-filled T-INITIAL draft) and
  **Avfärda** (POST with required reason → `dismissed`). Cross-domain tasks
  keep their warning badge; `verbatim: false` (address inferred, not literally
  in their mail) renders an extra caution marker.
- **Kommun page**: pending tasks show as a banner above the contact list.
- **Slack + post-send view**: when `sendApprovedReply` resolves an escalation
  whose conversation has pending tasks, the Slack chat.update and the dashboard
  redirect target include "⚠️ hänvisning väntar: starta ärende till {address}" —
  the second click is presented at the moment of the first.

### 4. Starting and resolving

"Starta & skicka" rides `sendInitial` unchanged. The flip `pending → started`
(with `started_conv_id`) lives INSIDE `sendInitial`'s conversation-creation
step, keyed on (kommun_kod, lowercased contact_email) — so a conversation
started by ANY route (the task button, manual compose, quick-init) resolves a
matching pending task in the same transaction. Tasks can never nag about an
address that is already in play, and the flip cannot be forgotten by a new
caller because it is not the caller's job.

### 5. Nagging (runDailyFollowup)

Daily follow-up adds a handoff digest: pending tasks with
`created_at < now - 2 days` and (`last_nag_at` null or `< now - 3 days`) are
posted to Slack as ONE digest line per run ("N hänvisningar väntar på ärende:
Bengtsfors → helen.pettersson@amal.se (12 d), …"). `last_nag_at` is stamped
only after a successful post and only for the tasks the post named (same
pattern as `analysis_parked_alerted_at`). The digest is gated on tick health
like every other follow-up and never sends anything itself.

### 6. What this deliberately does NOT do

- No auto-send. `pending` never becomes outbound without an operator click.
- No new send path — `sendInitial` and `sendApprovedReply` remain the only two.
- No change to inbound matching: replies from a started cross-domain ärende
  (Helen answering from amal.se) already match via the Gmail-thread first pass.
- No dataset (Phase-1 JSON/CSV) writes — handoff contacts are runtime state.

## Safety invariants (unchanged, restated)

Never double-message: per-address pending uniqueness + `startedByEmail` guard +
`sendInitial`'s kommun+role claim. At most one open escalation per conversation
is untouched (tasks are not escalations). Ticks stay exclusive; task writes ride
the existing ingest transaction. Nag state is durable, never per-process.

## Test plan

- storage: migration probe, pending uniqueness, upsert rules (started-at-birth,
  supersede, dupe-keep), backfill idempotence.
- tick: handoff message → pending task in same transaction; address-already-
  conversed → started; crash-retry leaves no half-state (existing harness).
- dashboard: queue rows render + count; Starta & skicka flips to started and is
  guarded against double-click; Avfärda requires a reason; panel reads tasks.
- followup: digest respects 2-day age + 3-day renag + tick-health gate;
  `last_nag_at` stamped only on successful post; nothing sent.
- send-reply: post-approve surface includes the pending-task warning.
