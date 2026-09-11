# Handoff Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kommun handoff ("contact X instead") becomes a durable `handoff_tasks` row that surfaces everywhere, nags daily, and resolves itself when a conversation to the address starts — a missed click can no longer lose data.

**Architecture:** New SQLite table via the append-only migration probe pattern; task creation inside the tick's per-message ingest transaction; the pending→started flip inside `sendInitial`'s conversation creation; read paths feed Behöver dig, the ärende panel, and a daily Slack nag digest. No new send paths.

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest (offline fakes).

**Spec:** `docs/superpowers/specs/2026-09-06-handoff-lifecycle-design.md`

## Global Constraints

- Never auto-send: `pending` becomes outbound only via operator clicks on existing paths (`sendInitial`, `sendApprovedReply`).
- At most one `pending` task per (kommun_kod, address) — partial unique index.
- Nag state (`last_nag_at`) durable in the DB, stamped only after a successful Slack post, only for tasks the post named.
- All tests offline; temp-dir DBs; injected `slackOps`/`gmailOps` fakes.
- Addresses stored lowercased.

---

### Task 1: storage — `handoff_tasks` table + queries

**Files:**
- Modify: `src/storage.js` (migration + new query functions + export block)
- Test: `tests/handoff-tasks.test.js` (new)

**Interfaces:**
- Produces: `db.upsertHandoffTask({kommun_kod,address,forvaltning,role,source_conversation_id,source_message_id,verbatim,same_domain,started_conv_id?}) → {id,status}`;
  `db.listPendingHandoffTasks() → rows`; `db.listHandoffTasksForConversation(convId)`;
  `db.startHandoffTasksForAddress(kommun_kod,address,convId) → n`;
  `db.dismissHandoffTask(id,reason)`; `db.listNaggableHandoffTasks({now,minAgeDays:2,renagDays:3})`;
  `db.markHandoffTasksNagged(ids,now)`.

- [ ] **Step 1: failing tests** — migration creates table; upsert dedupes on pending (second upsert same kommun+address returns existing); upsert with `started_conv_id` births `started`; upsert for a NEW address from the same source conversation supersedes that conversation's other pending tasks; `startHandoffTasksForAddress` flips pending→started and stamps `resolved_at`; dismiss requires reason; naggable respects age/renag windows; `markHandoffTasksNagged` stamps only given ids.
- [ ] **Step 2: run, verify all fail** (`npx vitest run tests/handoff-tasks.test.js`)
- [ ] **Step 3: implement** — migration probe (`CREATE TABLE IF NOT EXISTS` + partial unique index exactly as in spec §1); queries as prepared statements; upsert logic: address lowercased; if a conversation exists for (kommun_kod,address) at insert time caller passes `started_conv_id`.
- [ ] **Step 4: run, verify pass**
- [ ] **Step 5: commit** `feat(storage): handoff_tasks table + lifecycle queries`

### Task 2: backfill in `migrate()`

**Files:**
- Modify: `src/storage.js` (one-shot backfill after table creation)
- Test: `tests/handoff-tasks.test.js` (extend)

**Interfaces:**
- Consumes: `parseHandoffTargets` cannot run in storage (layer); backfill scans `messages.analysis_json` for `intent==='handoff'` and uses `extracted.handoff_to_email` directly (same field the dashboard parses), plus conversations table for started-detection.

- [ ] **Step 1: failing test** — seed a conv with a handoff-classified message (analysis_json carrying `extracted.handoff_to_email`), re-open db → pending task exists; seed sibling conversation whose contact_email equals the handoff address → task is `started`; run migrate twice → no dupes.
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — guarded by `SELECT COUNT(*) FROM handoff_tasks` == 0 AND a probe that the table was just created (idempotence via the partial unique index makes re-runs no-ops anyway); newest handoff per conversation wins.
- [ ] **Step 4: verify pass**
- [ ] **Step 5: commit** `feat(storage): backfill handoff_tasks from existing handoff mail`

### Task 3: tick ingest creates tasks

**Files:**
- Modify: `src/tick.js` (in the per-message ingest, where analysis lands)
- Test: `tests/tick-ingest.test.js` (extend)

**Interfaces:**
- Consumes: `parseHandoffTargets` from `src/handoff.js`, `homeDomainFromWebbplats`, `db.upsertHandoffTask`.
- Produces: tasks exist after a tick that ingests a handoff mail.

- [ ] **Step 1: failing test** — tick ingests a mail whose (spied) analysis returns `intent:'handoff'`, `extracted:{handoff_to_email:'ny@kommun.se'}` → one pending task for the kommun with `source_message_id` set; a second identical tick run does not duplicate; a handoff to an address that already has a conversation records `started`.
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — after the escalation branch, `if (analysis?.intent === 'handoff')`: run `parseHandoffTargets` with the kommun's home domain and sibling roles (same inputs as `dashboard.js:565`), then per target `db.upsertHandoffTask({... started_conv_id: existingConvByEmail ?? null})`. Inside the existing message transaction.
- [ ] **Step 4: verify pass** and run `npx vitest run tests/tick.test.js` for regressions
- [ ] **Step 5: commit** `feat(tick): durable handoff task per extracted handoff address`

### Task 4: `sendInitial` flips pending→started

**Files:**
- Modify: `src/send-reply.js:356` (after `createConversation`)
- Test: `tests/send-reply.test.js` or `tests/handoff-tasks.test.js` (extend)

**Interfaces:**
- Consumes: `db.startHandoffTasksForAddress(kommun_kod, contact_email, convId)`.

- [ ] **Step 1: failing test** — pending task for (kommun,address); `sendInitial` with a fake gmail impl to that address → task `started` with `started_conv_id` = new conv; a failed claim/send does NOT flip (park path leaves task pending).
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — call `startHandoffTasksForAddress(kommun_kod, contact_email, convId)` immediately after `createConversation` succeeds. Rule (spec §4): a conversation EXISTS from that point — even one later parked NEEDS_HUMAN — so the address is in play and the task must stop nagging. No conditional on the send outcome.
- [ ] **Step 4: verify pass**
- [ ] **Step 5: commit** `feat(send-reply): starting a conversation resolves matching handoff tasks`

### Task 5: dashboard — queue rows, ärende panel, Avfärda

**Files:**
- Modify: `src/dashboard.js` (`buildActionQueue` merge; `/arenden/:id` uses tasks instead of recompute; new POST `/handoff-tasks/:id/dismiss`)
- Modify: `src/dashboard-views.js` (queue row variant; panel buttons incl. Avfärda form with required reason; kommun-page pending-task banner above the contact list, spec §3)
- Test: `tests/dashboard.test.js` (extend)

**Interfaces:**
- Consumes: `db.listPendingHandoffTasks()`, `db.listHandoffTasksForConversation`, `db.dismissHandoffTask`.
- Produces: Behöver dig rows labeled `Hänvisning: starta ärende → {address}`; panel on `/arenden/:id` driven by task rows (pending → buttons; started → "✓ Startat · Ärende #N"; dismissed hidden).

- [ ] **Step 1: failing tests** — overview contains the hänvisning row and count includes it; `/arenden/:id` renders task-backed panel; POST dismiss without reason → 400, with reason → task dismissed and panel row gone.
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — `buildActionQueue` appends task items (`{kind:'handoff', conv_id: source_conversation_id, action: 'Starta ärende → '+address, since: created_at}`); `/arenden/:id` replaces the render-time `handoff_targets` computation with `listHandoffTasksForConversation` (keep `parseHandoffTargets` for ingest only); dismiss endpoint validates reason non-empty.
- [ ] **Step 4: verify pass**
- [ ] **Step 5: commit** `feat(dashboard): handoff tasks in Behöver dig + task-backed ärende panel`

### Task 6: daily nag digest

**Files:**
- Modify: `src/tick.js` (`runDailyFollowup`)
- Test: `tests/tick-followup.test.js` (extend)

**Interfaces:**
- Consumes: `db.listNaggableHandoffTasks`, `db.markHandoffTasksNagged`, existing `slackOps`.

- [ ] **Step 1: failing tests** — a pending task 3 days old → one Slack digest line naming kommun+address; re-run same day → no repost; failed Slack post → `last_nag_at` NOT stamped; tick-health gate respected (blind ingest → no digest).
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — after existing follow-up work, same gating; single message for all naggable tasks; stamp only named ids on success.
- [ ] **Step 4: verify pass**
- [ ] **Step 5: commit** `feat(followup): daily hänvisning nag digest`

### Task 7: post-approve warning surface

**Files:**
- Modify: `src/slack.js` (resolution chat.update text) and `src/dashboard.js` (resolve redirect carries flag → banner on ärende page)
- Test: `tests/dashboard.test.js` / `tests/slack.test.js` (extend)

**Interfaces:**
- Consumes: `db.listHandoffTasksForConversation` (pending only).

- [ ] **Step 1: failing test** — resolving an escalation for a conversation with a pending task includes "hänvisning väntar" in the Slack update text and the dashboard response.
- [ ] **Step 2: verify fail**
- [ ] **Step 3: implement** — read pending tasks at resolve time; append warning line.
- [ ] **Step 4: verify pass**
- [ ] **Step 5: commit** `feat: pending-handoff warning at the moment of approve`

### Task 8: full verification + deploy

- [ ] `npx vitest run` — all green
- [ ] Merge feature branch to main (work happens on `feat/handoff-lifecycle`)
- [ ] `./deploy/deploy.sh`; verify backfill on live created the Bengtsfors→Helen pending task (read-only SSM query) and it renders in Behöver dig
