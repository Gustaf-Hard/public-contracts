# Conversation Threads & Recipient Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model each Gmail thread within a kommun conversation as a first-class entity so replies route to the counterparty we are actually answering (visible + editable), and auto-ack "noise" threads can be muted.

**Architecture:** Add a `threads` table and per-message `gmail_thread_id` / `thread_id`. Ingest upserts a thread per message and (Phase 2) auto-classifies it `primary`/`muted`/`neutral`. Replies resolve their recipient + Gmail thread from the escalation's triggering message instead of the conversation's single `contact_email`. Phase 1 delivers recipient correctness; Phase 2 adds the status model, escalation scoping, and thread-grouped UI.

**Tech Stack:** Node 20 ESM, better-sqlite3, Express (server-rendered template-literal HTML), vitest. No build step. Tests are fully offline with fake-gmail / in-memory-db.

## Global Constraints

- Node ESM only (`import`/`export`); Node 20+. No TypeScript.
- All outbound HTTP must go through `politeFetch` (`src/http.js`). This feature adds no new outbound HTTP — Gmail calls go through the injected `gmailOps`.
- Tests run fully offline: fake gmail (`getMessage(gmail,id)`, `listInboundQuery`, `sendMessage` returning `{id, threadId}`), in-memory sqlite via `openDb(':memory:')` + `migrate()`.
- No auto-sending of replies. Only the initial begäran is auto-sent; every reply stays human-approved. This plan changes recipient + display only.
- Muting a thread suppresses inbound-reply suggestions for that thread ONLY. It must never stop the conversation-level follow-up nudge (`runDailyFollowup`).
- Thread status sets use the **stored legacy `classification`** values: `SUBSTANCE = {delivery, clarification}`, `NOISE = {auto_ack}`. `unknown` and `dead_end` → `neutral` (must NOT mute — `unknown` carries handoffs/fee-demands that escalate to a human). Unmapped classes → `neutral` (safe).
- Migrations are additive and idempotent, following the existing `PRAGMA table_info` probe pattern in `src/storage.js` `migrate()`.
- Every commit ends with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Run the full suite with `npm test`; a single file with `npx vitest run tests/<name>.test.js`.

## File Structure

- `src/storage.js` — MODIFY: `threads` table + `messages.gmail_thread_id`/`messages.thread_id` in schema/migrate; new helpers `upsertThread`, `getThread`, `getThreadById`, `listThreadsForConversation`, `setThreadStatus`, `getMessageById`; `recordMessage` accepts `gmail_thread_id`/`thread_id`.
- `src/threads.js` — CREATE: pure logic. `SUBSTANCE`, `NOISE`, `inferThreadStatus(inbound)`, `resolveReplyRecipient({triggeringMessage, conv, primaryThreads})`.
- `src/tick.js` — MODIFY: ingest stores thread id + upserts thread; `escalateWithDraft` records the triggering `message_id`; tick-efficiency (fetch inbound once, match before `getMessage`); (Phase 2) status inference + escalation scoping.
- `src/send-reply.js` — MODIFY: `sendApprovedReply` resolves recipient/thread from the escalation's triggering message; accepts `finalTo`.
- `src/backfill-threads.js` — CREATE: `backfillThreads({db, gmail, gmailOps})` (testable core).
- `scripts/05-backfill-threads.js` — CREATE: thin runner wiring real gmail into `backfillThreads`.
- `src/dashboard.js` — MODIFY: `POST /escalations/:id` reads `to`; loaders compute per-escalation recipient + group threads; (Phase 2) `POST /threads/:id/status`.
- `src/dashboard-views.js` — MODIFY: `renderEscalationForm` gains `Till:` field; (Phase 2) thread-grouped case rendering + status chips/toggles.
- `tests/threads.test.js` — CREATE.
- `tests/send-reply.test.js` — CREATE.
- `tests/storage.test.js`, `tests/tick.test.js`, `tests/dashboard.test.js` — MODIFY (add cases).

---

# PHASE 1 — Correctness (ships on its own; stops the live bug)

## Task 1: threads table + messages columns + storage helpers

**Files:**
- Modify: `src/storage.js` (SCHEMA ~3-131, `migrate` ~138-154, helper block ~199-227, exports ~475-507)
- Test: `tests/storage.test.js`

**Interfaces:**
- Produces:
  - `db.upsertThread({conversation_id, gmail_thread_id, counterparty_email?, counterparty_name?, last_inbound_at?})` → thread row `{id, conversation_id, gmail_thread_id, counterparty_email, counterparty_name, status, status_source, last_inbound_at, created_at}`. Upserts by `(conversation_id, gmail_thread_id)`; on existing row, overwrites `counterparty_email`/`counterparty_name`/`last_inbound_at` only when the arg is non-null.
  - `db.getThread(conversation_id, gmail_thread_id)` → row | undefined
  - `db.getThreadById(id)` → row | undefined
  - `db.listThreadsForConversation(conversation_id)` → rows, newest `last_inbound_at` first
  - `db.setThreadStatus(id, status, source)` → void (sets `status`, `status_source`)
  - `db.getMessageById(id)` → row | undefined
  - `db.recordMessage(m)` now reads optional `m.gmail_thread_id`, `m.thread_id`

- [ ] **Step 1: Write the failing test**

Add to `tests/storage.test.js`:

```javascript
describe('threads', () => {
  it('creates the threads table and upserts idempotently by (conversation_id, gmail_thread_id)', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'X', role: 'central',
      contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z',
    });
    const t1 = db.upsertThread({
      conversation_id: convId, gmail_thread_id: 'thr-a',
      counterparty_email: 'a@x.se', counterparty_name: 'A', last_inbound_at: '2026-06-01T00:00:00Z',
    });
    expect(t1.status).toBe('neutral');
    expect(t1.status_source).toBe('auto');
    const t2 = db.upsertThread({
      conversation_id: convId, gmail_thread_id: 'thr-a',
      counterparty_email: 'a2@x.se', last_inbound_at: '2026-06-02T00:00:00Z',
    });
    expect(t2.id).toBe(t1.id);                 // same row
    expect(t2.counterparty_email).toBe('a2@x.se');
    expect(t2.last_inbound_at).toBe('2026-06-02T00:00:00Z');
    expect(db.listThreadsForConversation(convId)).toHaveLength(1);
  });

  it('setThreadStatus persists status + source; recordMessage stores thread ids', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'X', role: 'central',
      contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z',
    });
    const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a' });
    db.setThreadStatus(t.id, 'muted', 'manual');
    expect(db.getThreadById(t.id).status).toBe('muted');
    expect(db.getThreadById(t.id).status_source).toBe('manual');
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'g1', direction: 'inbound',
      from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: 'b',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-01T00:00:00Z', attachment_count: 1,
      gmail_thread_id: 'thr-a', thread_id: t.id,
    });
    const m = db.getMessageById(mid);
    expect(m.gmail_thread_id).toBe('thr-a');
    expect(m.thread_id).toBe(t.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage.test.js -t "threads"`
Expected: FAIL — `db.upsertThread is not a function` (and no `threads` table).

- [ ] **Step 3: Add the schema**

In `src/storage.js`, inside the `SCHEMA` template literal, after the `messages` index (line 39) add:

```sql
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  gmail_thread_id TEXT NOT NULL,
  counterparty_email TEXT,
  counterparty_name TEXT,
  status TEXT NOT NULL DEFAULT 'neutral',
  status_source TEXT NOT NULL DEFAULT 'auto',
  last_inbound_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(conversation_id, gmail_thread_id)
);
CREATE INDEX IF NOT EXISTS idx_threads_conversation ON threads(conversation_id);
```

- [ ] **Step 4: Add idempotent ALTERs for messages**

In `migrate()`, after the existing `analysis_json` probe (line 149), add:

```javascript
    if (!msgCols.includes('gmail_thread_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN gmail_thread_id TEXT');
    }
    if (!msgCols.includes('thread_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN thread_id INTEGER');
    }
```

- [ ] **Step 5: Add the thread + message helpers**

In `src/storage.js`, after `hasGmailMessageId` (line 227) add:

```javascript
  function getMessageById(id) {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  function upsertThread({ conversation_id, gmail_thread_id, counterparty_email = null, counterparty_name = null, last_inbound_at = null }) {
    const existing = db.prepare(
      'SELECT * FROM threads WHERE conversation_id = ? AND gmail_thread_id = ?'
    ).get(conversation_id, gmail_thread_id);
    if (existing) {
      db.prepare(`
        UPDATE threads SET
          counterparty_email = COALESCE(?, counterparty_email),
          counterparty_name  = COALESCE(?, counterparty_name),
          last_inbound_at    = COALESCE(?, last_inbound_at)
        WHERE id = ?
      `).run(counterparty_email, counterparty_name, last_inbound_at, existing.id);
      return db.prepare('SELECT * FROM threads WHERE id = ?').get(existing.id);
    }
    const r = db.prepare(`
      INSERT INTO threads (conversation_id, gmail_thread_id, counterparty_email, counterparty_name, last_inbound_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(conversation_id, gmail_thread_id, counterparty_email, counterparty_name, last_inbound_at);
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(Number(r.lastInsertRowid));
  }

  function getThread(conversation_id, gmail_thread_id) {
    return db.prepare('SELECT * FROM threads WHERE conversation_id = ? AND gmail_thread_id = ?')
      .get(conversation_id, gmail_thread_id);
  }

  function getThreadById(id) {
    return db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  }

  function listThreadsForConversation(conversation_id) {
    return db.prepare(
      "SELECT * FROM threads WHERE conversation_id = ? ORDER BY last_inbound_at DESC NULLS LAST, id"
    ).all(conversation_id);
  }

  function setThreadStatus(id, status, source = 'manual') {
    db.prepare('UPDATE threads SET status = ?, status_source = ? WHERE id = ?').run(status, source, id);
  }
```

Note: SQLite `NULLS LAST` is supported in the bundled better-sqlite3 (SQLite ≥ 3.30). If the local build predates it, replace the ORDER BY with `ORDER BY (last_inbound_at IS NULL), last_inbound_at DESC, id`.

- [ ] **Step 6: Extend recordMessage to store thread ids**

Replace the `recordMessage` INSERT (lines 200-217) with:

```javascript
    const stmt = db.prepare(`
      INSERT INTO messages (
        conversation_id, gmail_message_id, direction, from_email, to_email,
        subject, body_text, classification, classification_confidence,
        received_at, attachment_count, signature_extracted, analysis_json,
        gmail_thread_id, thread_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const sigJson = m.signature_extracted
      ? (typeof m.signature_extracted === 'string' ? m.signature_extracted : JSON.stringify(m.signature_extracted))
      : null;
    const analysisJson = m.analysis_json
      ? (typeof m.analysis_json === 'string' ? m.analysis_json : JSON.stringify(m.analysis_json))
      : null;
    const r = stmt.run(
      m.conversation_id, m.gmail_message_id, m.direction, m.from_email, m.to_email,
      m.subject, m.body_text, m.classification, m.classification_confidence,
      m.received_at, m.attachment_count, sigJson, analysisJson,
      m.gmail_thread_id ?? null, m.thread_id ?? null
    );
    return Number(r.lastInsertRowid);
```

- [ ] **Step 7: Export the new helpers**

In the returned object (lines 475-507) add these keys: `getMessageById`, `upsertThread`, `getThread`, `getThreadById`, `listThreadsForConversation`, `setThreadStatus`.

- [ ] **Step 8: Run to verify pass**

Run: `npx vitest run tests/storage.test.js`
Expected: PASS (new + existing).

- [ ] **Step 9: Commit**

```bash
git add src/storage.js tests/storage.test.js
git commit -m "feat(storage): threads table + per-message thread ids

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: pure recipient resolution (`src/threads.js`)

**Files:**
- Create: `src/threads.js`
- Test: `tests/threads.test.js`

**Interfaces:**
- Produces: `resolveReplyRecipient({triggeringMessage, conv, primaryThreads = []})` → `{to, threadId}`.
  - If `triggeringMessage` is present: `to = triggeringMessage.from_email`, `threadId = triggeringMessage.gmail_thread_id ?? conv.gmail_thread_id`.
  - Else if exactly one `primaryThreads` entry: `to = that.counterparty_email`, `threadId = that.gmail_thread_id` (Phase 2 passes these; Phase 1 passes `[]`).
  - Else fallback: `to = conv.contact_email`, `threadId = conv.gmail_thread_id`.
  - `to` is always non-empty when `conv.contact_email` is set.

- [ ] **Step 1: Write the failing test**

Create `tests/threads.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { resolveReplyRecipient } from '../src/threads.js';

const conv = { contact_email: 'registrator@x.se', gmail_thread_id: 'thr-orig' };

describe('resolveReplyRecipient', () => {
  it('routes to the triggering message sender + its thread', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: { from_email: 'Anneli.Waern@arboga.se', gmail_thread_id: 'thr-anneli' },
      conv,
    });
    expect(r).toEqual({ to: 'Anneli.Waern@arboga.se', threadId: 'thr-anneli' });
  });

  it('falls back to the conversation contact when there is no triggering message and no primary thread', () => {
    const r = resolveReplyRecipient({ triggeringMessage: null, conv, primaryThreads: [] });
    expect(r).toEqual({ to: 'registrator@x.se', threadId: 'thr-orig' });
  });

  it('routes a proactive reply to the single primary thread when present', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: null, conv,
      primaryThreads: [{ counterparty_email: 'anneli@arboga.se', gmail_thread_id: 'thr-anneli' }],
    });
    expect(r).toEqual({ to: 'anneli@arboga.se', threadId: 'thr-anneli' });
  });

  it('falls back to conv thread id when the triggering message lacks one', () => {
    const r = resolveReplyRecipient({
      triggeringMessage: { from_email: 'a@x.se', gmail_thread_id: null }, conv,
    });
    expect(r).toEqual({ to: 'a@x.se', threadId: 'thr-orig' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/threads.test.js`
Expected: FAIL — cannot find module `../src/threads.js`.

- [ ] **Step 3: Implement**

Create `src/threads.js`:

```javascript
// Pure thread logic — no IO. Recipient resolution here; status inference
// (inferThreadStatus) is added in Phase 2.

// Decide who a reply goes to and which Gmail thread it belongs in.
// Priority: the message we are answering → a single primary thread → the
// conversation's original contact. Always yields a non-empty `to` when the
// conversation has a contact_email.
export function resolveReplyRecipient({ triggeringMessage, conv, primaryThreads = [] }) {
  if (triggeringMessage) {
    return {
      to: triggeringMessage.from_email,
      threadId: triggeringMessage.gmail_thread_id ?? conv.gmail_thread_id ?? null,
    };
  }
  if (primaryThreads.length === 1) {
    return {
      to: primaryThreads[0].counterparty_email,
      threadId: primaryThreads[0].gmail_thread_id ?? conv.gmail_thread_id ?? null,
    };
  }
  return { to: conv.contact_email, threadId: conv.gmail_thread_id ?? null };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/threads.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/threads.js tests/threads.test.js
git commit -m "feat(threads): pure reply-recipient resolution

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: ingest stores thread id + records triggering message id

**Files:**
- Modify: `src/tick.js` (ingest recordMessage ~161-169; `escalateWithDraft` signature ~48 and record ~70-80; call site ~223-230)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `db.upsertThread`, `db.recordMessage` (with `gmail_thread_id`/`thread_id`), `parseInboundMessage` (returns `{from, to, subject, body, gmail_thread_id, attachments}`).
- Produces: after an inbound is ingested, a `threads` row exists for `(conv.id, full.threadId)`, the message row has `gmail_thread_id`+`thread_id`, and the escalation (if any) has `message_id` = that message's id.

- [ ] **Step 1: Add a shared `makeDeps` helper to `tests/tick.test.js`**

The existing tests build the `runTick` deps object inline. Add this helper once (near `fakeGmail`, after line 43), and reuse it in this and later tasks. It references the module-level `db`, `env`, `contractsDir`, and `fakeSlack` already present in the file:

```javascript
function makeDeps({ gmail, now = new Date('2026-06-24T00:00:00Z') }) {
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail,
    slackClient: {}, slackOps: fakeSlack(),
    env, contractsDir, now,
  };
}

// base64url-encode a body the way Gmail delivers it (matches existing fixtures).
function b64(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a fake full Gmail message for gmailOps.getResult.
function mkMsg(id, threadId, from, body, subject = 's') {
  return { id, threadId, payload: { headers: [
    { name: 'From', value: from }, { name: 'To', value: 'me@x.se' }, { name: 'Subject', value: subject },
  ], body: { data: b64(body) } } };
}
```

These proven bodies classify deterministically via the regex classifier (no LLM in tests): `'Ärendenummer: K9999001'` → `auto_ack`; `'Kan du precisera din begäran?'` → `clarification`; `'Hej, kan du ringa mig?'` → `unknown`.

- [ ] **Step 2: Write the failing test**

Add to `tests/tick.test.js`:

```javascript
it('ingest creates a thread row, stamps the message, and links the escalation to the message', async () => {
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-orig', last_outbound_at: '2026-05-01T00:00:00Z' });

  const gmail = fakeGmail({
    listResult: [{ id: 'in-1' }],
    getResult: { 'in-1': mkMsg('in-1', 'thr-anneli', 'Anneli Waern <Anneli.Waern@arboga.se>', 'Kan du precisera din begäran?', 'SV: Begäran') },
  });

  await runTick(makeDeps({ gmail }));

  const thread = db.getThread(convId, 'thr-anneli');
  expect(thread).toBeTruthy();
  const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'in-1'").get();
  expect(msg.gmail_thread_id).toBe('thr-anneli');
  expect(msg.thread_id).toBe(thread.id);
  const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(convId);
  if (esc) expect(esc.message_id).toBe(msg.id); // escalation, when drafted, points at the message
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "ingest creates a thread"`
Expected: FAIL — `db.getThread(...)` is undefined-row / message has null `thread_id`.

- [ ] **Step 4: Upsert the thread and stamp the message on ingest**

In `src/tick.js`, in the inbound loop, replace the `db.recordMessage({...})` call (lines 161-169) with a thread upsert first, then a stamped record:

```javascript
      const thread = db.upsertThread({
        conversation_id: conv.id,
        gmail_thread_id: full.threadId,
        counterparty_email: parsed.from,
        counterparty_name: parsed.from,
        last_inbound_at: now.toISOString(),
      });
      const messageId = db.recordMessage({
        conversation_id: conv.id, gmail_message_id: m.id, direction: 'inbound',
        from_email: parsed.from, to_email: parsed.to,
        subject: parsed.subject, body_text: parsed.body,
        classification: classification.class, classification_confidence: classification.confidence,
        received_at: now.toISOString(), attachment_count: parsed.attachments.length,
        signature_extracted: sig,
        analysis_json: analysis ?? null,
        gmail_thread_id: full.threadId,
        thread_id: thread.id,
      });
```

- [ ] **Step 5: Thread the message id into the escalation**

Change `escalateWithDraft`'s signature (line 48) to accept `messageId`:

```javascript
async function escalateWithDraft({ conv, parsedInbound, messageId = null, classification, previousState, draftTemplate, llmDraft, reason, deps }) {
```

In its `db.recordEscalation({...})` call (lines 70-80) change `message_id: null` to:

```javascript
    message_id: messageId,
```

At the inbound call site (lines 223-230) pass it:

```javascript
        await escalateWithDraft({
          conv: updated, parsedInbound: parsed, messageId, classification,
          previousState,
          draftTemplate,
          llmDraft,
          reason,
          deps,
        });
```

(`runDailyFollowup`'s call site at lines 267-275 has no inbound message — leave it without `messageId`, so it defaults to `null`.)

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS (new + existing).

- [ ] **Step 7: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): upsert thread + stamp message thread id + link escalation to message

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: tick-efficiency — fetch inbound once, match before getMessage

**Files:**
- Modify: `src/tick.js` (inbound section ~111-133)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `gmailOps.listInboundQuery`, `gmailOps.getMessage`, `db.hasGmailMessageId`, `sameEmailDomain`.
- Produces: identical matching behaviour (thread OR sender-domain, first-conversation-wins), but `listInboundQuery` is called once per tick and `getMessage` at most once per new message across all conversations.

- [ ] **Step 1: Write the failing test**

Add to `tests/tick.test.js`:

```javascript
it('fetches the inbound list once and getMessage at most once per new message across conversations', async () => {
  const c1 = db.createConversation({ kommun_kod: '1', kommun_namn: 'A', role: 'central', contact_email: 'k@a.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  const c2 = db.createConversation({ kommun_kod: '2', kommun_namn: 'B', role: 'central', contact_email: 'k@b.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(c1, 'SENT', { gmail_thread_id: 'thr-1', last_outbound_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(c2, 'SENT', { gmail_thread_id: 'thr-2', last_outbound_at: '2026-05-01T00:00:00Z' });

  const gmail = fakeGmail({
    listResult: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }],
    getResult: {
      m1: mkMsg('m1', 'thr-1', 'x@a.se', 'Hej, kan du ringa mig?'),
      m2: mkMsg('m2', 'thr-9', 'y@nomatch.se', 'Hej, kan du ringa mig?'),
      m3: mkMsg('m3', 'thr-2', 'z@b.se', 'Hej, kan du ringa mig?'),
    },
  });

  await runTick(makeDeps({ gmail }));

  expect(gmail.listInboundQuery).toHaveBeenCalledTimes(1);
  expect(gmail.getMessage).toHaveBeenCalledTimes(3); // once per new message, NOT 3×2
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "fetches the inbound list once"`
Expected: FAIL — `listInboundQuery` called 2× and `getMessage` called 6×.

- [ ] **Step 3: Restructure the inbound section**

Replace the inbound block that begins `const active = db.listAllConversations().filter((c) => c.gmail_thread_id);` and its per-conversation `const list = await gmailOps.listInboundQuery(...)` loop (lines 112-133) so the fetch is hoisted and full messages are pre-fetched once:

```javascript
  const active = db.listAllConversations().filter((c) => c.gmail_thread_id);
  if (active.length) {
    const list = await gmailOps.listInboundQuery(
      gmailClient.gmail,
      // Widened to 30d so post-outage backlog is caught; see spec. Fetched ONCE
      // per tick (not once per conversation) to keep cold-start ticks fast.
      `to:${env.GMAIL_USER_EMAIL} -from:${env.GMAIL_USER_EMAIL} newer_than:30d`
    );
    // Pre-fetch each not-yet-recorded message exactly once, then match against
    // every conversation using the already-parsed content.
    const fetched = [];
    for (const m of list) {
      if (db.hasGmailMessageId(m.id)) continue;
      const full = await gmailOps.getMessage(gmailClient.gmail, m.id);
      if (!full) continue;
      fetched.push({ id: m.id, full, parsed: parseInboundMessage(full) });
    }

    for (const conv of active) {
      for (const item of fetched) {
        if (db.hasGmailMessageId(item.id)) continue; // recorded under an earlier conv
        const { full, parsed } = item;
        const threadMatch = full.threadId === conv.gmail_thread_id;
        const domainMatch = sameEmailDomain(parsed.from, conv.contact_email);
        if (!threadMatch && !domainMatch) continue;
```

Then keep the existing per-message processing body (LLM analysis, classification, thread upsert + `recordMessage`, attachment saving, state transition, escalation) exactly as-is, but sourced from `item`/`parsed`/`full` (it already uses `parsed` and `full.threadId`). Close the two `for` loops and the `if (active.length)` block where the old single loop ended.

Note the `m` variable inside the body (used as `m.id` for `getMessage`/`recordMessage`/`fetchAttachment`) is now `item.id`; update those references to `item.id`. Attachment fetching uses `gmailOps.fetchAttachment(gmailClient.gmail, item.id, att.attachment_id)`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS — call-count test green, all prior inbound tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "perf(tick): fetch inbound once per tick, match before getMessage

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: recipient routing in `sendApprovedReply`

**Files:**
- Modify: `src/send-reply.js` (`sendApprovedReply` ~17-66)
- Test: `tests/send-reply.test.js`

**Interfaces:**
- Consumes: `resolveReplyRecipient` (Task 2), `db.getMessageById`, `db.recordMessage`.
- Produces: `sendApprovedReply({db, gmail, env, conv, esc, finalBody, finalSubject, finalTo, decision})`. Recipient = `finalTo` (if a non-empty string) else `resolveReplyRecipient({triggeringMessage: esc.message_id ? db.getMessageById(esc.message_id) : null, conv}).to`. Gmail thread = the resolved `threadId`. Outbound message row records `to_email` = the recipient actually used and `gmail_thread_id` = that thread.

- [ ] **Step 1: Write the failing test**

Create `tests/send-reply.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../src/storage.js';
import { sendApprovedReply } from '../src/send-reply.js';

const env = { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me' };

function seedArboga() {
  const db = openDb(':memory:');
  db.migrate();
  const convId = db.createConversation({
    kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
    contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
  const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-anneli', counterparty_email: 'Anneli.Waern@arboga.se' });
  const mid = db.recordMessage({
    conversation_id: convId, gmail_message_id: 'in-anneli', direction: 'inbound',
    from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal',
    classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z',
    attachment_count: 10, gmail_thread_id: 'thr-anneli', thread_id: t.id,
  });
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: mid, reason: 'r',
    draft_template: 'free_form', draft_subject: 'Re: SV', draft_body: 'tack',
  });
  return { db, conv: db.getConversation(convId), esc: db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId) };
}

describe('sendApprovedReply recipient routing', () => {
  it('replies to the triggering message sender + its thread, not conv.contact_email', async () => {
    const { db, conv, esc } = seedArboga();
    const gmail = {};
    const send = vi.fn(async () => ({ id: 'out-1', threadId: 'thr-anneli' }));
    await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: 'tack', decision: 'approve_unmodified', gmailSendImpl: send });
    expect(send.mock.calls[0][1]).toMatchObject({ to: 'Anneli.Waern@arboga.se', threadId: 'thr-anneli' });
    const out = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'out-1'").get();
    expect(out.to_email).toBe('Anneli.Waern@arboga.se');
    expect(out.gmail_thread_id).toBe('thr-anneli');
  });

  it('honours an explicit finalTo override', async () => {
    const { db, conv, esc } = seedArboga();
    const send = vi.fn(async () => ({ id: 'out-2', threadId: 'thr-anneli' }));
    await sendApprovedReply({ db, gmail: {}, env, conv, esc, finalBody: 'tack', finalTo: 'someone.else@arboga.se', decision: 'edit', gmailSendImpl: send });
    expect(send.mock.calls[0][1]).toMatchObject({ to: 'someone.else@arboga.se' });
  });
});
```

Note: the test injects the gmail send via `gmailSendImpl` so no real network is touched. Implement that seam.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/send-reply.test.js`
Expected: FAIL — reply goes `to: conv.contact_email`; no `finalTo`/`gmailSendImpl` seam.

- [ ] **Step 3: Implement routing**

In `src/send-reply.js`, add the import at the top:

```javascript
import { resolveReplyRecipient } from './threads.js';
```

Replace `sendApprovedReply` (lines 17-39, through the `recordMessage` call) with:

```javascript
export async function sendApprovedReply({ db, gmail, env, conv, esc, finalBody, finalSubject, finalTo, decision, gmailSendImpl = gmailSend }) {
  const subject = finalSubject ?? esc.draft_subject ?? 'Re: Begäran om allmänna handlingar';
  const triggeringMessage = esc.message_id ? db.getMessageById(esc.message_id) : null;
  // primaryThreads is empty until Phase 2 sets statuses; then a follow-up nudge
  // with no triggering message routes to the single primary thread.
  const primaryThreads = db.listThreadsForConversation(conv.id).filter((t) => t.status === 'primary');
  const resolved = resolveReplyRecipient({ triggeringMessage, conv, primaryThreads });
  const to = (typeof finalTo === 'string' && finalTo.trim()) ? finalTo.trim() : resolved.to;
  const threadId = resolved.threadId ?? conv.gmail_thread_id;
  const sent = await gmailSendImpl(gmail, {
    from: fromHeader(env),
    to,
    subject,
    body: finalBody,
    threadId,
  });
  const nowIso = new Date().toISOString();
  db.recordMessage({
    conversation_id: conv.id,
    gmail_message_id: sent.id,
    direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL,
    to_email: to,
    subject,
    body_text: finalBody,
    classification: null,
    classification_confidence: null,
    received_at: nowIso,
    attachment_count: 0,
    gmail_thread_id: sent.threadId ?? threadId,
    thread_id: triggeringMessage?.thread_id ?? null,
  });
```

Leave the rest of the function (the `patch`/state/resolve/decision block, lines 40-65) unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/send-reply.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/send-reply.js tests/send-reply.test.js
git commit -m "fix(send-reply): route replies to the triggering thread's counterparty

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: editable `Till:` recipient in the reply form

**Files:**
- Modify: `src/dashboard-views.js` (`renderEscalationForm` ~798-833)
- Modify: `src/dashboard.js` (`POST /escalations/:id` ~774-816; loaders that build escalation view-models ~552-603 and `loadCaseDetail` ~434-453)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `db.getMessageById`, `resolveReplyRecipient`.
- Produces: each escalation passed to `renderEscalationForm` carries `recipient` (resolved `to`); the form renders `<input name="to" value="...">`; `POST /escalations/:id` passes `req.body.to` to `sendApprovedReply` as `finalTo`.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboard.test.js` (kommun-page describe block, using the existing `appWithFakes`/seed helpers):

```javascript
it('reply form shows an editable Till: field prefilled with the thread counterparty', async () => {
  const convId = db.createConversation({
    kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
    contact_email: 'registrator@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z',
  });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
  const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-h', counterparty_email: 'handlaggare@mala.se' });
  const mid = db.recordMessage({
    conversation_id: convId, gmail_message_id: 'in-1', direction: 'inbound',
    from_email: 'handlaggare@mala.se', to_email: 'me@x.se', subject: 'SV', body_text: 'x',
    classification: 'precision', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z',
    attachment_count: 0, gmail_thread_id: 'thr-h', thread_id: t.id,
  });
  db.recordEscalation({ conversation_id: convId, message_id: mid, reason: 'r', draft_template: 'T_PRECISION', draft_subject: 'Re: SV', draft_body: 'svar' });

  const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }] });
  const res = await get(app, '/kommun/2418');
  expect(res.text).toMatch(/name="to"[^>]*value="handlaggare@mala\.se"/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "editable Till"`
Expected: FAIL — no `name="to"` input.

- [ ] **Step 3: Add the field to the form**

In `src/dashboard-views.js`, change `renderEscalationForm(esc, gmailReady, returnTo = null)` to also read `esc.recipient`, and insert a recipient field before the `Ämne` field inside the edit-and-send `<form>`:

```javascript
      <div class="field">
        <label>Till</label>
        <input type="email" name="to" value="${escapeHtml(esc.recipient ?? '')}">
      </div>
```

- [ ] **Step 4: Populate `recipient` on escalation view-models**

In `src/dashboard.js`, add a small helper near the other loaders:

```javascript
  function escalationRecipient(db, esc, conv) {
    const triggeringMessage = esc.message_id ? db.getMessageById(esc.message_id) : null;
    const primaryThreads = db.listThreadsForConversation(conv.id).filter((t) => t.status === 'primary');
    return resolveReplyRecipient({ triggeringMessage, conv, primaryThreads }).to;
  }
```

and import `resolveReplyRecipient` at the top:

```javascript
import { resolveReplyRecipient } from './threads.js';
```

In `loadCaseDetail` (line ~448, where `escalations` is read) map each escalation to include `recipient`:

```javascript
  const escalations = db.raw.prepare("SELECT * FROM escalations WHERE conversation_id = ? AND status = 'open' ORDER BY id").all(convId)
    .map((e) => ({ ...e, recipient: escalationRecipient(db, e, conv) }));
```

In the kommun-page loader where `escalationsByConv[conv.id]` is built (line ~569), do the same mapping so each escalation object carries `recipient`.

- [ ] **Step 5: Read `to` in the POST handler**

In `POST /escalations/:id` (line ~806) pass the submitted recipient:

```javascript
      await sendApprovedReply({
        db, gmail: gmailClient, env, conv, esc,
        finalBody, finalSubject, finalTo: req.body.to,
        decision: action === 'send' ? 'approve_unmodified' : 'edit',
      });
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS (new + existing).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): editable Till: recipient on the reply form

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: backfill existing messages into threads

**Files:**
- Create: `src/backfill-threads.js`
- Create: `scripts/05-backfill-threads.js`
- Test: `tests/threads.test.js` (add a `backfillThreads` describe)

**Interfaces:**
- Consumes: `db.raw` (read messages), `db.upsertThread`, `gmailOps.getMessage`.
- Produces: `backfillThreads({db, gmail, gmailOps})` → `{scanned, updated}`. For each message with a null `gmail_thread_id` and a `gmail_message_id`, fetch its Gmail `threadId`, upsert the thread, and set `messages.gmail_thread_id` + `messages.thread_id`. Idempotent (skips messages already populated).

- [ ] **Step 1: Write the failing test**

Add to `tests/threads.test.js`:

```javascript
import { openDb } from '../src/storage.js';
import { backfillThreads } from '../src/backfill-threads.js';

describe('backfillThreads', () => {
  it('groups existing messages into threads and stamps them, idempotently', async () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'reg-1', direction: 'inbound', from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.se', subject: 'ack', body_text: '', classification: 'auto_ack', classification_confidence: 0.9, received_at: '2026-06-08T00:00:00Z', attachment_count: 0 });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'ann-1', direction: 'inbound', from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z', attachment_count: 10 });

    const gmailOps = { getMessage: vi.fn(async (g, id) => ({ id, threadId: id === 'ann-1' ? 'thr-anneli' : 'thr-orig' })) };
    const r = await backfillThreads({ db, gmail: {}, gmailOps });
    expect(r.updated).toBe(2);
    expect(db.listThreadsForConversation(convId)).toHaveLength(2);
    const ann = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'ann-1'").get();
    expect(ann.gmail_thread_id).toBe('thr-anneli');
    expect(ann.thread_id).toBeTruthy();

    const r2 = await backfillThreads({ db, gmail: {}, gmailOps }); // idempotent
    expect(r2.updated).toBe(0);
  });
});
```

Add `import { vi } from 'vitest';` to the top of `tests/threads.test.js` if not present.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/threads.test.js -t "backfillThreads"`
Expected: FAIL — cannot find `../src/backfill-threads.js`.

- [ ] **Step 3: Implement the core**

Create `src/backfill-threads.js`:

```javascript
// One-off: populate gmail_thread_id/thread_id on messages that predate the
// threads model, grouping them into threads rows. Idempotent — messages that
// already have a gmail_thread_id are skipped.
export async function backfillThreads({ db, gmail, gmailOps }) {
  const rows = db.raw.prepare(
    "SELECT id, conversation_id, gmail_message_id, from_email, direction, received_at FROM messages WHERE gmail_thread_id IS NULL AND gmail_message_id IS NOT NULL ORDER BY id"
  ).all();
  let updated = 0;
  for (const row of rows) {
    const full = await gmailOps.getMessage(gmail, row.gmail_message_id);
    if (!full?.threadId) continue;
    const thread = db.upsertThread({
      conversation_id: row.conversation_id,
      gmail_thread_id: full.threadId,
      counterparty_email: row.direction === 'inbound' ? row.from_email : null,
      counterparty_name: row.direction === 'inbound' ? row.from_email : null,
      last_inbound_at: row.direction === 'inbound' ? row.received_at : null,
    });
    db.raw.prepare('UPDATE messages SET gmail_thread_id = ?, thread_id = ? WHERE id = ?')
      .run(full.threadId, thread.id, row.id);
    updated++;
  }
  return { scanned: rows.length, updated };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/threads.test.js`
Expected: PASS.

- [ ] **Step 5: Add the runner script**

Create `scripts/05-backfill-threads.js`:

```javascript
#!/usr/bin/env node
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, getMessage } from '../src/gmail.js';
import { backfillThreads } from '../src/backfill-threads.js';

const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;

const db = openDb(DB_PATH);
db.migrate();
const auth = buildOAuthClient(process.env);
auth.setCredentials(loadStoredToken(TOKEN_PATH));
const gmail = makeGmail(auth);
const gmailOps = { getMessage };

const r = await backfillThreads({ db, gmail, gmailOps });
console.log(`Backfill complete: scanned ${r.scanned}, updated ${r.updated}.`);
process.exit(0);
```

Verify `DB_PATH`/`TOKEN_PATH` match how `src/daemon.js` resolves them; adjust the env var names if the daemon uses different constants.

- [ ] **Step 6: Commit**

```bash
git add src/backfill-threads.js scripts/05-backfill-threads.js tests/threads.test.js
git commit -m "feat(threads): backfill existing messages into threads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# PHASE 2 — Status model + thread-grouped UI

## Task 8: pure status inference

**Files:**
- Modify: `src/threads.js`
- Test: `tests/threads.test.js`

**Interfaces:**
- Produces: `SUBSTANCE` (Set), `NOISE` (Set), `inferThreadStatus(inbound)` where `inbound` is an array of `{classification, attachment_count}`. Returns `'primary' | 'muted' | 'neutral'`.

- [ ] **Step 1: Write the failing test**

Add to `tests/threads.test.js`:

```javascript
import { inferThreadStatus } from '../src/threads.js';

describe('inferThreadStatus', () => {
  it('primary when any inbound has attachments or a SUBSTANCE classification', () => {
    expect(inferThreadStatus([{ classification: 'auto_ack', attachment_count: 0 }, { classification: 'auto_ack', attachment_count: 3 }])).toBe('primary'); // attachments win
    expect(inferThreadStatus([{ classification: 'delivery', attachment_count: 0 }])).toBe('primary');
    expect(inferThreadStatus([{ classification: 'clarification', attachment_count: 0 }])).toBe('primary');
  });
  it('muted only when every inbound is auto_ack with no attachments', () => {
    expect(inferThreadStatus([{ classification: 'auto_ack', attachment_count: 0 }, { classification: 'auto_ack', attachment_count: 0 }])).toBe('muted');
  });
  it('neutral for no inbound, unknown, dead_end, or unmapped', () => {
    expect(inferThreadStatus([])).toBe('neutral');
    expect(inferThreadStatus([{ classification: 'unknown', attachment_count: 0 }])).toBe('neutral'); // handoff/fee-demand — needs a human, never muted
    expect(inferThreadStatus([{ classification: 'dead_end', attachment_count: 0 }])).toBe('neutral');
    expect(inferThreadStatus([{ classification: 'weird_new_intent', attachment_count: 0 }])).toBe('neutral');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/threads.test.js -t "inferThreadStatus"`
Expected: FAIL — `inferThreadStatus` is not exported.

- [ ] **Step 3: Implement**

Append to `src/threads.js`:

```javascript
// Over the STORED legacy classification values (auto_ack, clarification,
// delivery, dead_end, unknown). `unknown` is deliberately NOT noise — it carries
// handoffs / fee demands that must escalate to a human, so it maps to neutral.
export const SUBSTANCE = new Set(['delivery', 'clarification']);
export const NOISE = new Set(['auto_ack']);

// Classify a thread from its inbound messages.
//  primary  — any inbound has attachments OR a SUBSTANCE classification
//  muted    — ≥1 inbound and ALL inbound are NOISE (auto_ack) with no attachments
//  neutral  — no inbound, or anything else (unknown, dead_end, mixed)
export function inferThreadStatus(inbound) {
  if (!inbound || inbound.length === 0) return 'neutral';
  const anySubstance = inbound.some((m) => (m.attachment_count ?? 0) > 0 || SUBSTANCE.has(m.classification));
  if (anySubstance) return 'primary';
  const allNoise = inbound.every((m) => (m.attachment_count ?? 0) === 0 && NOISE.has(m.classification));
  if (allNoise) return 'muted';
  return 'neutral';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/threads.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/threads.js tests/threads.test.js
git commit -m "feat(threads): pure primary/muted/neutral status inference

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: apply status inference on ingest (respect manual override)

**Files:**
- Modify: `src/tick.js` (inbound processing, right after the thread upsert + message record from Task 3)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `inferThreadStatus`, `db.listMessages` (or a scoped thread-inbound query), `db.setThreadStatus`, `db.getThreadById`.
- Produces: after ingesting an inbound message, the thread's `status` is recomputed from all its inbound messages and written via `setThreadStatus(id, status, 'auto')` — but ONLY if the existing row's `status_source` is `'auto'`.

- [ ] **Step 1: Write the failing test**

Add to `tests/tick.test.js`:

Use `auto_ack`-classified bodies so the outcome is deterministic without relying
on the LLM (which is absent in tests): the regex classifier reliably tags a
"Vi har tagit emot" acknowledgement as `auto_ack`, and an all-`auto_ack` thread
with no attachments infers to `muted`.

```javascript
it('auto-classifies a thread on ingest and never overrides a manual status', async () => {
  const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-orig', last_outbound_at: '2026-05-01T00:00:00Z' });

  // First ingest: an auto-ack (Ärendenummer…) with no attachments → auto-muted.
  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'reg-1' }], getResult: { 'reg-1': mkMsg('reg-1', 'thr-reg', 'arboga.kommun@arboga.se', 'Ärendenummer: K9999001') } }) }));
  const t = db.getThread(convId, 'thr-reg');
  expect(t.status).toBe('muted');
  expect(t.status_source).toBe('auto');

  // Manual override to primary, then another auto-ack arrives → stays primary.
  db.setThreadStatus(t.id, 'primary', 'manual');
  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'reg-2' }], getResult: { 'reg-2': mkMsg('reg-2', 'thr-reg', 'arboga.kommun@arboga.se', 'Ärendenummer: K9999002') } }) }));
  expect(db.getThreadById(t.id).status).toBe('primary'); // manual not overwritten
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "auto-classifies a thread"`
Expected: FAIL — status stays `neutral` (no inference wired).

- [ ] **Step 3: Wire inference after recordMessage**

In `src/tick.js`, immediately after `const messageId = db.recordMessage({...})` (from Task 3) and before attachment saving, add:

```javascript
      // Recompute the thread's auto status from all its inbound messages.
      // Never clobber a manual override.
      const threadRow = db.getThreadById(thread.id);
      if (threadRow?.status_source === 'auto') {
        const inbound = db.listMessages(conv.id)
          .filter((mm) => mm.direction === 'inbound' && mm.thread_id === thread.id)
          .map((mm) => ({ classification: mm.classification, attachment_count: mm.attachment_count }));
        db.setThreadStatus(thread.id, inferThreadStatus(inbound), 'auto');
      }
```

Add the import at the top of `src/tick.js`:

```javascript
import { inferThreadStatus } from './threads.js';
```

Note: attachments are saved after `recordMessage`, so on the very first ingest `attachment_count` on the row already reflects `parsed.attachments.length` (set in `recordMessage`), so a contracts email classifies `primary` immediately.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): auto-classify thread status on ingest, honour manual override

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: scope escalations to non-muted threads

**Files:**
- Modify: `src/tick.js` (the `if (draftTemplate) { ... escalateWithDraft ... }` block ~219-231)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `db.getThreadById`.
- Produces: an inbound message whose thread is `muted` drafts no escalation (the message is still ingested + stored). `primary`/`neutral` threads escalate as before.

- [ ] **Step 1: Write the failing test**

Add to `tests/tick.test.js`:

The message body `'Hej, kan du ringa mig?'` classifies `unknown`, which normally
escalates (→ NEEDS_HUMAN). A control (non-muted) conversation proves the message
does escalate; the muted one proves the guard suppresses it.

```javascript
it('suppresses escalation for a muted thread but not for an equivalent non-muted one', async () => {
  // Control: non-muted thread receives an escalating (unknown) message.
  const ctrl = db.createConversation({ kommun_kod: '1', kommun_namn: 'Ctrl', role: 'central', contact_email: 'k@ctrl.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(ctrl, 'SENT', { gmail_thread_id: 'thr-ctrl', last_outbound_at: '2026-05-01T00:00:00Z' });
  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'c-1' }], getResult: { 'c-1': mkMsg('c-1', 'thr-ctrl', 'someone@ctrl.se', 'Hej, kan du ringa mig?') } }) }));
  expect(db.raw.prepare('SELECT COUNT(*) c FROM escalations WHERE conversation_id = ?').get(ctrl).c).toBeGreaterThan(0);

  // Muted: pre-create the thread, mute it manually, then the same message arrives.
  const conv = db.createConversation({ kommun_kod: '2', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(conv, 'SENT', { gmail_thread_id: 'thr-orig', last_outbound_at: '2026-05-01T00:00:00Z' });
  const t = db.upsertThread({ conversation_id: conv, gmail_thread_id: 'thr-reg', counterparty_email: 'arboga.kommun@arboga.se' });
  db.setThreadStatus(t.id, 'muted', 'manual');
  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'reg-9' }], getResult: { 'reg-9': mkMsg('reg-9', 'thr-reg', 'AR Arboga kommun <arboga.kommun@arboga.se>', 'Hej, kan du ringa mig?') } }) }));
  expect(db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id = 'reg-9'").get()).toBeTruthy(); // still ingested
  expect(db.raw.prepare('SELECT COUNT(*) c FROM escalations WHERE conversation_id = ?').get(conv).c).toBe(0); // no escalation
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "does not escalate an inbound whose thread is muted"`
Expected: FAIL — an escalation row is created.

- [ ] **Step 3: Guard the escalation on thread status**

In `src/tick.js`, change the escalation guard (line 219) from `if (draftTemplate) {` to:

```javascript
      const threadStatus = db.getThreadById(thread.id)?.status ?? 'neutral';
      if (draftTemplate && threadStatus !== 'muted') {
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): suppress escalations for muted threads

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: thread status toggle route

**Files:**
- Modify: `src/dashboard.js` (add `POST /threads/:id/status`)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `db.getThreadById`, `db.setThreadStatus`, `db.getConversation`.
- Produces: `POST /threads/:id/status` with body `{status: 'primary'|'muted'|'neutral'}` sets the thread status with `status_source = 'manual'` and redirects back (respecting `backTo`).

- [ ] **Step 1: Add a `postForm` helper to `tests/dashboard.test.js`**

The file has `get`/`getNoRedirect`/`getRaw` but no POST helper. Add this near them:

```javascript
async function postForm(app, path, fields) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text, location: r.headers.get('location') }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}
```

- [ ] **Step 2: Write the failing test**

Add to `tests/dashboard.test.js`:

```javascript
it('POST /threads/:id/status sets a manual status', async () => {
  const convId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  const t = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-a' });
  const app = createDashboardApp({ db, municipalitiesLoader: () => [] });
  const res = await postForm(app, `/threads/${t.id}/status`, { status: 'muted', return: '/arenden' });
  expect([302, 303]).toContain(res.status);
  expect(db.getThreadById(t.id).status).toBe('muted');
  expect(db.getThreadById(t.id).status_source).toBe('manual');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "threads/:id/status"`
Expected: FAIL — 404 (no route).

- [ ] **Step 4: Add the route**

In `src/dashboard.js`, after the `POST /escalations/:id` handler (line ~816) add:

```javascript
  // Manually flip a thread's primary/muted/neutral status. POST /threads/:id/status
  app.post('/threads/:id/status', (req, res) => {
    if (!db) return res.status(503).send('No DB');
    const t = db.getThreadById(parseInt(req.params.id, 10));
    if (!t) return res.status(404).send('Thread not found');
    const status = req.body.status;
    if (!['primary', 'muted', 'neutral'].includes(status)) {
      return res.status(400).send(`Unknown status: ${status}`);
    }
    db.setThreadStatus(t.id, status, 'manual');
    const kod = db.getConversation(t.conversation_id)?.kommun_kod ?? '';
    return res.redirect(backTo(req, `/kommun/${kod}`));
  });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.js
git commit -m "feat(dashboard): thread status toggle route

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: thread-grouped case view with status chips + toggles

**Files:**
- Modify: `src/dashboard-views.js` (the Gmail-thread rendering shared by the kommun page + Ärenden — group `messages` by `thread_id`, add per-thread header)
- Modify: `src/dashboard.js` (`loadCaseDetail` + kommun loader: attach `threads` list to the view-model)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `db.listThreadsForConversation`, message rows carrying `thread_id`.
- Produces: the case view renders one section per thread with a header (`counterparty_name · counterparty_email`), a status chip, and a status-toggle form (`POST /threads/:id/status`). Muted threads render collapsed and show no reply box; primary/neutral render expanded with their reply box.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboard.test.js`:

```javascript
it('groups the case view by thread with a status chip and a toggle form', async () => {
  const convId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Arboga', role: 'central', contact_email: 'registrator@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-orig' });
  const tA = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-anneli', counterparty_email: 'Anneli.Waern@arboga.se', counterparty_name: 'Anneli Waern' });
  db.setThreadStatus(tA.id, 'primary', 'auto');
  const tR = db.upsertThread({ conversation_id: convId, gmail_thread_id: 'thr-reg', counterparty_email: 'arboga.kommun@arboga.se', counterparty_name: 'Arboga kommun' });
  db.setThreadStatus(tR.id, 'muted', 'auto');
  db.recordMessage({ conversation_id: convId, gmail_message_id: 'ann-1', direction: 'inbound', from_email: 'Anneli.Waern@arboga.se', to_email: 'me@x.se', subject: 'SV', body_text: 'avtal', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-23T00:00:00Z', attachment_count: 10, gmail_thread_id: 'thr-anneli', thread_id: tA.id });
  db.recordMessage({ conversation_id: convId, gmail_message_id: 'reg-1', direction: 'inbound', from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.se', subject: 'ack', body_text: 'mottaget', classification: 'auto_ack', classification_confidence: 0.9, received_at: '2026-06-08T00:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-reg', thread_id: tR.id });

  const app = createDashboardApp({ db, municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Arboga', lan: 'X', folkmangd: 1, contacts: [] }] });
  const res = await get(app, '/kommun/2418');
  expect(res.text).toContain('Anneli Waern');
  expect(res.text).toContain('Arboga kommun');
  expect(res.text).toMatch(/action="\/threads\/\d+\/status"/); // toggle present
  expect(res.text).toMatch(/primary/); // status chip label
  expect(res.text).toMatch(/muted/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "groups the case view by thread"`
Expected: FAIL — no thread headers / toggle form.

- [ ] **Step 3: Attach threads to the case view-model**

In `src/dashboard.js` `loadCaseDetail` (line ~453 return), add `threads: db.listThreadsForConversation(convId)` to the returned object. In the kommun-page loader, attach a `threadsByConv[conv.id] = db.listThreadsForConversation(conv.id)` map alongside the existing `messagesByConv` etc., and pass it to the view.

- [ ] **Step 4: Render per-thread groups**

In `src/dashboard-views.js`, add a helper that renders the thread-grouped conversation and use it where the flat `thread` (Gmail messages) is currently rendered in both the kommun case card and `renderCaseDetailPane`:

```javascript
// A status chip + manual toggle for one thread.
function threadStatusControls(t) {
  const label = { primary: '★ primary', muted: 'muted', neutral: 'neutral' }[t.status] ?? t.status;
  const next = t.status === 'muted' ? 'primary' : 'muted';
  const nextLabel = next === 'muted' ? 'mute' : 'make primary';
  return `<span class="thread-status thread-status-${escapeHtml(t.status)}">${escapeHtml(label)}</span>
    <form method="post" action="/threads/${t.id}/status" style="display:inline" data-pane-form>
      <input type="hidden" name="status" value="${escapeHtml(next)}">
      <button type="submit" class="btn-link">${escapeHtml(nextLabel)}</button>
    </form>`;
}

// Group messages by thread_id and render each thread with a header. Messages
// with no thread_id (pre-backfill) fall into an "Övrigt" group keyed by null.
function renderThreadGroups(threads, messages, attachmentsByMsg, signatures, escalationsByThread, gmailReady) {
  const byThread = new Map();
  for (const m of messages) {
    const key = m.thread_id ?? 'none';
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(m);
  }
  const groups = threads.map((t) => {
    const msgs = byThread.get(t.id) ?? [];
    const collapsed = t.status === 'muted';
    const header = `<div class="thread-head">
      <strong>${escapeHtml(t.counterparty_name || t.counterparty_email || 'Okänd')}</strong>
      <span class="muted">${escapeHtml(t.counterparty_email || '')}</span>
      ${threadStatusControls(t)}
    </div>`;
    const body = msgs.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], !collapsed && i === msgs.length - 1)).join('');
    const replies = collapsed ? '' : (escalationsByThread.get(t.id) ?? []).map((e) => renderEscalationForm(e, gmailReady)).join('');
    return `<section class="thread-group thread-${escapeHtml(t.status)}">${header}${body}${replies}</section>`;
  });
  // Orphan messages (thread_id null — only before backfill) must never vanish.
  const orphans = byThread.get('none') ?? [];
  if (orphans.length) {
    const body = orphans.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], i === orphans.length - 1)).join('');
    groups.push(`<section class="thread-group"><div class="thread-head"><span class="muted">Ogrupperat</span></div>${body}</section>`);
  }
  return groups.join('');
}
```

Wire `renderThreadGroups` into both render paths, building `escalationsByThread` from the open escalations already loaded (group each escalation under the thread of its triggering message: `esc → db.getMessageById(esc.message_id)?.thread_id`; the loader can precompute `thread_id` onto each escalation view-model). Where a case currently renders the flat `thread` variable, replace it with `renderThreadGroups(threads, messages, attachmentsByMsg, signatures, escalationsByThread, gmailReady)`.

- [ ] **Step 5: Add minimal CSS**

In the `<style>` block of `layout()` in `src/dashboard-views.js`, add:

```css
  .thread-group { border: 1px solid var(--border); border-radius: 8px; margin: 10px 0; padding: 10px 12px; }
  .thread-group.thread-muted { opacity: 0.72; }
  .thread-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
  .thread-status { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); }
  .thread-status-primary { color: var(--accent); border-color: var(--accent); }
  .thread-status-muted { color: var(--fg-muted); }
  .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS (new + existing). Then `npm test` for the whole suite.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): thread-grouped case view with status chips and toggles

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `npm test` — all tests pass.
- [ ] Restart the daemon and dashboard so the running processes pick up the code (they cache modules in memory): `pkill -f pilot-daemon.js; pkill -f pilot-dashboard.js` then `npm run pilot-daemon &` and `npm run pilot-dashboard &`.
- [ ] Run the one-off backfill against the live DB: `node scripts/05-backfill-threads.js` (needs a valid Gmail token). Confirm Arboga shows two threads (Anneli primary, registrator muted) and that a reply to Anneli's thread pre-fills `Till: Anneli.Waern@arboga.se`.
