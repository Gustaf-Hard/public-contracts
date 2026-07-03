# Conversation Threads & Recipient Routing — Design

**Date:** 2026-07-03
**Status:** Approved (brainstorming) — ready for implementation plan
**Related:** [2026-06-23-trustworthy-next-action-design.md](2026-06-23-trustworthy-next-action-design.md) (cross-domain handoff matching, single next-action)

## Problem

A pilot *conversation* is one kommun + role with a single `contact_email` and a
single `gmail_thread_id`. Inbound mail is matched into it by Gmail thread **or**
by sender domain, so several distinct counterparties collapse into one
conversation with one reply-to address.

This produced a real misfire on **Arboga** (conversation #3):

- `Anneli.Waern@arboga.se` (handläggare) delivered 10 contract PDFs — the
  substantive counterparty.
- `arboga.kommun@arboga.se` (registrator) sent only auto-acknowledgements.

Both were folded into conversation #3. When the operator sent a follow-up
("tack för avtalen, är fler på väg?"), `sendApprovedReply` routed it to
`conv.contact_email` — the **registrator**, not Anneli. The reply box also shows
only *Ämne* and *Brödtext*; it never shows or lets you change the recipient, so
the mistake was invisible until after sending.

## Goals

1. Model each Gmail thread within a conversation as a first-class entity with
   its own counterparty and status.
2. Route replies to the correct counterparty — the person we are actually
   answering — and make the recipient visible and editable before sending.
3. Let threads be marked **primary** (real engagement, needs replies) or
   **muted** (auto-ack noise, no reply), auto-inferred with manual override.
4. Show suggested replies / escalations only for primary (or neutral) threads.
5. Fix the tick-efficiency regression that makes ingest crawl on a large inbox
   (folded into Phase 1 because it lives in the same ingest code).

## Non-goals

- No auto-sending of replies. As today, only the initial begäran is auto-sent;
  every reply remains human-approved. This design changes *where* a reply is
  addressed and *how it is displayed*, not the human-in-the-loop gate.
- No change to the conversation ↔ kommun/role model. Threads live *inside* a
  conversation; conversations are unchanged.
- No merging/splitting of conversations across kommuner.

## Definitions

- **Thread** — a distinct Gmail thread id within one conversation. This is the
  grouping unit (chosen over grouping-by-counterparty: it is literally "the
  Gmail way", and a reply to a thread naturally threads in Gmail).
- **Counterparty** — the kommun-side address for a thread: the most recent
  inbound sender in that thread. This is the default reply recipient.
- **Status** — `primary` · `muted` · `neutral`, with `status_source` `auto` ·
  `manual`.

## Data model

### New table `threads`

| column | type | meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `conversation_id` | INTEGER NOT NULL | FK → conversations |
| `gmail_thread_id` | TEXT NOT NULL | the Gmail thread |
| `counterparty_email` | TEXT | address we reply to (latest inbound sender) |
| `counterparty_name` | TEXT | display name parsed from `From` |
| `status` | TEXT NOT NULL DEFAULT `'neutral'` | `primary` · `muted` · `neutral` |
| `status_source` | TEXT NOT NULL DEFAULT `'auto'` | `auto` · `manual` |
| `last_inbound_at` | TEXT | newest inbound timestamp, for sorting |
| `created_at` | TEXT | |

`UNIQUE(conversation_id, gmail_thread_id)`.

### `messages` — two new columns

- `gmail_thread_id TEXT` — this message's Gmail thread. Already available at
  ingest as `full.threadId`; simply not stored today.
- `thread_id INTEGER` — FK → `threads.id` (convenience for grouping/queries).

### Migration

Additive only (new table + two nullable columns). Follows the existing
`migrate()` pattern in `src/storage.js`.

## Thread inference

On every message ingest, upsert the thread row for
`(conversation_id, full.threadId)`, set/refresh `counterparty_email/name` and
`last_inbound_at` from the latest inbound, and — **only when
`status_source = 'auto'`** — recompute `status`:

Using two explicit sets over the **stored legacy `classification` values**
(`auto_ack`, `clarification`, `delivery`, `dead_end`, `unknown` — the LLM intents
`handoff`/`fee_demand`/`delay_promise` are already folded into these by
`analysisToLegacyClassification`):

- `SUBSTANCE = {delivery, clarification}` — a real registrator engagement that
  we act on.
- `NOISE = {auto_ack}` — automatic diarium acknowledgements only.

- → **`primary`** if the thread has any inbound with attachments, or any inbound
  whose classification is in `SUBSTANCE`.
- → **`muted`** if the thread has ≥1 inbound and *all* of its inbound are in
  `NOISE` with no attachments.
- → **`neutral`** otherwise — including `unknown` and `dead_end`, and
  outbound-only threads.

Critically, `unknown` is **not** muted: in the legacy taxonomy it carries
handoffs and fee demands that must escalate to a human. Muting is reserved for
pure diarium auto-acks, plus any thread the operator manually mutes. New/unmapped
classifications default to `neutral` (escalates, does not mute) — the safe
direction.

A manual override sets `status_source = 'manual'`; inference never touches such
rows again.

**Muting is scoped.** A muted thread suppresses *inbound-reply suggestions for
that thread only*. It does **not** stop the conversation-level follow-up nudge
("any update on our begäran?"), which targets the original begäran thread. So
muting the registrator's auto-ack thread never silences our chasing.

## Recipient routing & send

Two kinds of outbound, each routed explicitly:

1. **Reply to a specific inbound** (escalation-driven). The escalation already
   carries `message_id`. Resolve recipient + thread from that message's thread:
   - `to` = the triggering message's `from_email`
   - `threadId` = the triggering message's `gmail_thread_id`
   `sendApprovedReply` stops reading `conv.contact_email` /
   `conv.gmail_thread_id` for this case.

2. **Conversation-level follow-up nudge** (no triggering inbound). Route to the
   conversation's **primary thread** if exactly one exists; otherwise fall back
   to the original begäran thread / `conv.contact_email`.

**Editable recipient.** The resolved `to` becomes a real form field (`Till:`)
in the reply box — pre-filled, editable, and submitted with the send. The server
uses the submitted recipient (validated as a plausible email), never a hidden
default.

**Safety fallback.** If a thread row is missing (e.g. a message ingested before
backfill completes), recipient resolution falls back to `conv.contact_email` so
a send never goes out with an empty `to`.

## Escalation scoping

When the daemon drafts a suggested reply for an inbound message, it consults the
message's thread status:

- `primary` or `neutral` → draft + escalate as today.
- `muted` → **no escalation**. The message is still ingested, stored, and
  visible; it just generates no work.

Because each primary thread is evaluated independently, a conversation with two
primary threads produces a suggested reply under each — satisfying "sometimes
several threads are primary."

## UI

The case view (both the Ärenden tab and the kommun page) groups messages under a
per-thread header:

```
Arboga · central
──────────────────────────────────────────
▎ Anneli Waern · Anneli.Waern@arboga.se   [★ primary]  [mute]
    ● Anneli → Du        10 avtal            23 jun
    ● Du → Anneli        tack, fler på väg?  29 jun
    ┌ Föreslaget svar → Anneli.Waern@arboga.se ─┐
    │ Till: [Anneli.Waern@arboga.se        ]     │  ← editable
    │ …suggested reply…                 [Skicka] │
    └────────────────────────────────────────────┘

▎ Arboga kommun (registrator) · arboga.kommun@arboga.se   [muted · auto-ack]  [make primary]
    ▸ 2 auto-svar (collapsed)                    — no suggested reply
```

- Threads render newest-inbound-first; primary/neutral expanded with their reply
  box, muted collapsed with a one-line label.
- Each thread header carries a status chip and a toggle: `mute` ↔ `make primary`
  (a form POST that sets `status` + `status_source = 'manual'`, progressive-
  enhancement like the existing case actions).
- The reply box reuses the existing escalation form plus the new `Till:` field.
- Reuses the Gmail-style `threadMessage` renderer already shared by both views.

## Backfill

One-off `scripts/05-backfill-threads.js`, idempotent:

1. For each existing message, fetch its Gmail `threadId` via `getMessage` on the
   stored `gmail_message_id`; set `messages.gmail_thread_id`.
2. Upsert `threads` rows per `(conversation_id, gmail_thread_id)`.
3. Run status inference; set `messages.thread_id`.

Skips messages already populated so re-runs are cheap. Going forward, ingest
populates these fields inline (no backfill needed for new mail).

## Tick-efficiency fix (Phase 1)

The paginated inbound query interacts badly with the tick's structure and makes
the startup tick crawl (~5 min observed) on a large/backed-up inbox:

- `listInboundQuery` (paginated) is re-run **once per conversation** (identical
  query, N× redundant fetch).
- For every not-yet-recorded message it calls `getMessage` (a full fetch)
  **before** checking whether the message even matches the conversation.

Fix, in `src/tick.js`:

1. Fetch the inbound window **once** per tick, before the conversation loop.
2. Match each message to a conversation by thread id / sender domain using the
   **list metadata** (or a single `getMessage` per genuinely-new message,
   reused across conversations), so `getMessage` is called at most once per new
   message total — not once per conversation per message.

This is included in Phase 1 because it edits the same ingest path the thread
model changes.

## Phasing

**Phase 1 — correctness (stops the live bug):**
- Migration (`threads` table + `messages` columns).
- Store `gmail_thread_id` / `thread_id` on ingest; thread upsert.
- Backfill script.
- Recipient routing in `sendApprovedReply` (reply to the triggering message's
  thread + sender) + editable `Till:` field.
- Tick-efficiency fix.

After Phase 1, replies go to the right person and the operator sees/controls the
recipient — even before the richer UI.

**Phase 2 — model + UI:**
- Auto status inference (`primary` / `muted` / `neutral`) on ingest.
- Manual override toggle + `status_source`.
- Escalation scoping to primary/neutral threads.
- Thread-grouped case view with status chips and toggles.

## Testing

All offline, using the existing fake-gmail / in-memory-db patterns.

**Unit:**
- Thread upsert: new message creates/updates the right thread row; counterparty
  + `last_inbound_at` reflect the latest inbound.
- Status inference: attachments or `delivery` → `primary`; `auto_ack`-only →
  `muted`; no inbound → `neutral`; manual override is not overwritten.
- Recipient resolution: triggering message → its sender/thread; follow-up →
  single primary thread; missing thread → `conv.contact_email` fallback.
- `Till:` field validation rejects a non-email, keeps the resolved default.

**Regression / integration:**
- `sendApprovedReply` for an Arboga-shaped escalation routes to
  `Anneli.Waern@arboga.se` (the triggering message's sender), **not**
  `conv.contact_email` — the exact bug.
- A muted thread produces no escalation; its messages are still ingested.
- Backfill splits Arboga into 2 threads with correct statuses (Anneli primary,
  registrator muted).
- Tick-efficiency: `getMessage` is called at most once per new message across a
  tick with multiple conversations (assert call count with a fake gmail).

## Success criteria

- A reply to a multi-counterparty conversation goes to the counterparty we are
  answering, shown in an editable `Till:` field before send.
- Arboga displays two threads: Anneli (primary, with the contracts and a
  suggested reply) and the registrator (muted, collapsed, no suggested reply).
- Muted threads generate no escalations but never suppress the conversation-level
  follow-up nudge.
- A cold-start tick on a backed-up inbox completes in well under a minute (no
  per-conversation redundant fetching).
