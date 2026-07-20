# Keep the operator's inbox clean — archive tracked mail on ingest

**Date:** 2026-07-20
**Status:** approved (operator chose archive-on-ingest), ready for implementation

## Problem

The pilot runs from the operator's **personal Gmail inbox**. Every kommun reply
we ingest (auto-acks, deliveries, autosvar, clarifications) is recorded and
tracked in the tool, but the message keeps sitting in the inbox, so the inbox
fills with mail the tool has already captured. Today we archive a thread ONLY
after we send a reply into it (`archiveThreadBestEffort` in `send-reply.js`);
everything we ingest-but-don't-reply-to stays in the inbox.

## Decision (from the operator)

**Archive-on-ingest.** The moment a tick successfully records an inbound message
into a *tracked* conversation, drop the `INBOX` label from its Gmail thread. The
inbox then holds only mail the tool has NOT captured (genuinely new / unmatched).
The operator relies on the dashboard + Slack for what needs action. Plus a
**one-time backfill** to clear the tracked threads already in the inbox.

## Design

### 1. Archive after a confirmed ingest (`src/tick.js`)
- Reuse `archiveThread(gmail, threadId)` (`src/gmail.js` — `threads.modify`,
  `removeLabelIds: ['INBOX']`; idempotent, reversible, never deletes).
- Archive **strictly after** the per-message ingest transaction COMMITS (row +
  attachments written). A crash mid-ingest must never archive an unrecorded
  message — same ordering guarantee the send path uses.
- **Best-effort**, mirroring `archiveThreadBestEffort`: an archive failure is
  logged and swallowed, never blocks or fails ingest.
- Archive only the Gmail thread of a message that matched a tracked conversation
  (both matching passes). **Unmatched / ambiguous messages** (the Slack-digest
  path) are NEVER archived — they must stay in the inbox for human attention.
- **Injection seam:** pass `archiveThreadImpl` into `runTick` deps (fake in
  tests), like the existing `gmailOps` / `archiveThreadImpl` seams. No live
  Gmail in tests.

### 2. Config flag
- `PILOT_ARCHIVE_ON_INGEST` (default: **on**). When off, ingest never archives
  (revert to send-only archiving). Read once in the daemon, threaded into deps.

### 3. One-time backfill (offline-testable helper + supervised script)
- A helper `archiveTrackedThreads(db, { archiveThreadImpl, log })` that iterates
  every conversation's `gmail_thread_id` and archives each thread, **skipping**
  any conversation with an open unmatched/pending state that should stay visible
  (none by default — every tracked thread is fair game since it's recorded).
- Idempotent (re-archiving an already-archived thread is a no-op) and
  rate-limited to Gmail's limits. Logs the count archived.
- The OPERATOR runs it once, supervised (it mutates the live inbox; no DB
  writes, so no backup strictly needed, but confirm the count first via a
  dry-run flag that lists thread ids without modifying).

## Constraints (non-negotiable)

- **Archive only** — remove the `INBOX` label; never trash/delete. Fully
  reversible (the thread stays in All Mail).
- **Never archive un-ingested or unmatched mail** — only threads of messages we
  successfully recorded in a tracked conversation.
- **Archive AFTER the DB commit**, best-effort; an archive failure never affects
  ingest correctness. `received_at` / two-pass matching invariants unchanged.
- **Idempotent + rate-limited.**
- **Subagent works offline only** — temp/`:memory:` SQLite, injected fake
  `archiveThreadImpl`; no live `data/pilot.db`, daemon, or Gmail.
- **Base:** reset the worktree onto the current `main` tip first
  ([[worktree-stale-base]]). Leave commits on an `inbox-archive` branch.
- Full offline `npm test` green.

## Testing (offline)

- `runTick`: a matched inbound → after ingest, `archiveThreadImpl` called once
  with the message's thread id; the DB row exists before the archive call.
- An **unmatched** message → `archiveThreadImpl` NOT called; message stays for
  the digest.
- Archive throws → ingest still succeeds, message recorded, error logged.
- `PILOT_ARCHIVE_ON_INGEST=off` → no archive call.
- `archiveTrackedThreads` backfill → archives each tracked thread once; dry-run
  lists ids without calling modify.

## Out of scope

- Trashing/deleting mail, label foldering, archiving Sent items (our T-INITIALs
  live in Sent, not the inbox).
- Un-archiving / restoring (Gmail search in All Mail covers recovery).
