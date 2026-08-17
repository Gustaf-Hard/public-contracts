# Auto-send follow-up nudges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate `T_FOLLOWUP_NUDGE` from human-approved to automatic for conversations with no substantive response, behind a file-based kill switch, with a 9–15-day deterministic jitter on the nudge threshold and a dashboard "Auto-skickade" feed.

**Architecture:** No new send path. `runDailyFollowup` keeps drafting via `escalateWithDraft` first (crash-safe: an orphaned intention is an open escalation a human can act on), then — for a qualifying `T_FOLLOWUP_NUDGE` only — immediately calls the existing `sendApprovedReply` with a new decision string `'auto_send'`. All existing guards (atomic claim, `STALE_INGEST`, parking) apply; the `STALE_ESCALATION` guard is widened to also cover `'auto_send'`. The kill switch is re-read from disk at the start of every daily run.

**Tech Stack:** Node 20+ ESM, better-sqlite3, vitest (all offline, fakes + temp DBs), Express dashboard with server-rendered HTML.

**Spec:** `docs/superpowers/specs/2026-08-17-auto-send-followup-nudge-design.md`

## Global Constraints

- **No SQLite schema changes.** `'auto_send'` is a new string value in the existing `decisions.decision` TEXT column (repo convention: extend by value, never migrate).
- **No new send path.** Every outbound goes through `sendApprovedReply` (safety invariant #1). Auto-send failures/refusals are **never retried** by the automation.
- **Fail closed.** Any inbound classified `delivery`, `clarification`, `dead_end`, `bounce`, `unknown`, or NULL blocks auto-send — the escalation stays for the operator.
- **Kill switch ships OFF.** Absent key, empty array, missing file, or malformed `data/pilot-overrides.json` → `[]` → fully manual. Read fresh from disk at the start of every `runDailyFollowup`, never from the daemon's startup-loaded overrides object.
- **Only `T_FOLLOWUP_NUDGE`** auto-sends. `T_FOLLOWUP_CLOSE`, `T_RECEIPT`, `free_form`, bounce resends, `T_UPDATE` all stay human-approved. No change to `MAX_NUDGES` (2) or the escalate-after-cap behavior.
- **Jitter is deterministic** — a pure integer hash of `conv.id`, never `Math.random`. Effective nudge threshold: 9 + (0–6) days for `SENT` and `ACK_RECEIVED`. `AWAITING_PRECISION` stays fixed at 10, `DELIVERING`/`CROSSCHECK` at 14.
- **All tests offline** (temp-dir SQLite via `mkdtempSync` + `openDb` + `migrate()`, fake `gmailOps`/`slackOps`, injected `gmailSendImpl`). Never touch `data/pilot.db`.
- When an existing test fails because a threshold changed, **update the seed/fixture to express the new contract** (move stale seeds past the jitter window) — never weaken an assertion.

**Spec deviation, resolved here once:** the spec's implementation sketch says jitter is "added to `rule.days` only when `rule.action === 'send_followup_nudge'`", but its Timing section and test item 5 require `AWAITING_PRECISION` (whose action IS `send_followup_nudge`) to stay fixed at 10. The action-based condition cannot satisfy both, so this plan puts a `jitter: true` flag on the two rules that jitter (`SENT`, `ACK_RECEIVED`). Behavior matches the spec's Timing table and its tests exactly.

**Branch:** create `feat/auto-send-followup-nudge` off up-to-date `main` (`git fetch` first, per user global instructions).

---

### Task 1: Deterministic nudge jitter (9–15 days)

**Files:**
- Modify: `src/conversation.js` (STALE_RULES, staleAction, effectiveFollowUp, new `nudgeJitterDays`)
- Modify: `src/tick.js:1373` (staleAction call in `runDailyFollowup`) and its import at `src/tick.js:8`
- Test: `tests/conversation.test.js` (new describe + updated thresholds), `tests/tick-followup.test.js` (stale seeds), possibly `tests/vacation-followup.test.js`, `tests/tick-health.test.js`, `tests/arenden-order.test.js`, dashboard tests (stale seeds / expected dates)

**Interfaces:**
- Produces: `export function nudgeJitterDays(convId)` → integer 0–6, pure, deterministic. `staleAction(state, daysInState, followupCount, opts)` now honors `opts.nudgeJitterDays` (number, default 0) for rules flagged `jitter: true`. `STALE_RULES.SENT.days === 9`, `STALE_RULES.ACK_RECEIVED.days === 9`, both with `jitter: true`. `effectiveFollowUp(conv, cfg)` applies the same jitter when `conv.id` is an integer.

- [ ] **Step 1: Write the failing tests** — append to `tests/conversation.test.js` (add `nudgeJitterDays` to the import from `../src/conversation.js`):

```js
describe('nudgeJitterDays + jittered STALE_RULES (2026-08-17 auto-send design)', () => {
  it('is deterministic and within [0, 6] for arbitrary ids', () => {
    for (const id of [1, 2, 3, 17, 291, 1000, 123456]) {
      const j = nudgeJitterDays(id);
      expect(j).toBe(nudgeJitterDays(id));
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(6);
    }
  });

  it('varies across conversations — reminders must not land like clockwork', () => {
    const values = new Set(Array.from({ length: 50 }, (_, i) => nudgeJitterDays(i + 1)));
    expect(values.size).toBeGreaterThan(1);
  });

  it('SENT threshold is 9 + jitter days', () => {
    expect(staleAction('SENT', 8, 0, { nudgeJitterDays: 0 })).toBe('none');
    expect(staleAction('SENT', 9, 0, { nudgeJitterDays: 0 })).toBe('send_followup_nudge');
    expect(staleAction('SENT', 14, 0, { nudgeJitterDays: 6 })).toBe('none');
    expect(staleAction('SENT', 15, 0, { nudgeJitterDays: 6 })).toBe('send_followup_nudge');
  });

  it('ACK_RECEIVED uses the same jittered 9-day base', () => {
    expect(staleAction('ACK_RECEIVED', 8, 0, { nudgeJitterDays: 0 })).toBe('none');
    expect(staleAction('ACK_RECEIVED', 9, 0, { nudgeJitterDays: 0 })).toBe('send_followup_nudge');
    expect(staleAction('ACK_RECEIVED', 11, 0, { nudgeJitterDays: 3 })).toBe('none');
    expect(staleAction('ACK_RECEIVED', 12, 0, { nudgeJitterDays: 3 })).toBe('send_followup_nudge');
  });

  it('AWAITING_PRECISION stays fixed at 10 — jitter never applies', () => {
    expect(staleAction('AWAITING_PRECISION', 10, 0, { nudgeJitterDays: 6 })).toBe('send_followup_nudge');
    expect(staleAction('AWAITING_PRECISION', 9, 0, { nudgeJitterDays: 0 })).toBe('none');
  });

  it('effectiveFollowUp reflects the per-conversation jittered date', () => {
    const j = nudgeJitterDays(42);
    const r = effectiveFollowUp({ id: 42, state: 'SENT', state_changed_at: '2026-05-24T10:00:00Z', follow_up_at: null });
    const expected = new Date(Date.parse('2026-05-24T10:00:00Z') + (9 + j) * 86400000).toISOString().slice(0, 10);
    expect(r).toEqual({ date: expected, source: 'our_followup' });
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run tests/conversation.test.js -t "nudgeJitterDays"`
Expected: FAIL — `nudgeJitterDays` is not exported.

- [ ] **Step 3: Implement in `src/conversation.js`**

Add above `STALE_RULES`:

```js
// Per-conversation deterministic jitter for the nudge threshold (2026-08-17
// auto-send design): 0–6 extra days derived from the conversation id, so
// reminders land 9–15 days out rather than firing on the same day-count like
// clockwork across kommuner. A pure integer hash, NOT Math.random — stable
// across ticks and in tests.
export function nudgeJitterDays(convId) {
  let h = (convId >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3bd) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % 7;
}
```

Replace `STALE_RULES` (keep the existing CROSSCHECK comment in place):

```js
export const STALE_RULES = {
  // `jitter: true` marks the thresholds that take the per-conversation 0–6-day
  // jitter (9–15 effective days). AWAITING_PRECISION shares the nudge ACTION
  // but keeps its fixed 10 days by design (2026-08-17 spec, Timing), so the
  // flag lives on the rule, not on the action.
  SENT: { days: 9, action: 'send_followup_nudge', jitter: true },
  ACK_RECEIVED: { days: 9, action: 'send_followup_nudge', jitter: true },
  AWAITING_PRECISION: { days: 10, action: 'send_followup_nudge' },
  DELIVERING: { days: 14, action: 'send_followup_close' },
  // An unanswered checklist must not strand: nudge, and the nudge cap then
  // escalates to a human rather than looping.
  CROSSCHECK: { days: 14, action: 'send_followup_close' },
};
```

In `staleAction`, replace `if (daysInState < rule.days) return 'none';` with:

```js
  const jitter = rule.jitter ? (opts.nudgeJitterDays ?? 0) : 0;
  if (daysInState < rule.days + jitter) return 'none';
```

In `effectiveFollowUp`, replace the `const date = ...` line with (the dashboard must advertise the date the loop will actually act on — data honesty):

```js
  const jitter = rule.jitter && Number.isInteger(conv.id) ? nudgeJitterDays(conv.id) : 0;
  const date = new Date(t + (rule.days + jitter) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
```

- [ ] **Step 4: Wire the caller in `src/tick.js`**

Line 8: extend the import to `import { nextActionForClassification, staleAction, nudgeJitterDays } from './conversation.js';`

At `src/tick.js:1373`, the `staleAction` call in `runDailyFollowup` becomes:

```js
    const action = staleAction(conv.state, days, conv.followup_count, {
      today: todayIso,
      follow_up_at: conv.follow_up_at ?? null,
      nudgeJitterDays: nudgeJitterDays(conv.id),
    });
```

- [ ] **Step 5: Update existing tests to the new contract** (seeds/expectations, never weakened assertions):

`tests/conversation.test.js`:
- Line 99–105: `staleAction('SENT', 9, 0)` → `'send_followup_nudge'`, `staleAction('SENT', 8, 0)` → `'none'`; retitle to "SENT for ≥9 days (base, jitter 0)".
- Line 107–110: `staleAction('ACK_RECEIVED', 9, 0)` → nudge, `('ACK_RECEIVED', 8, 0)` → `'none'`; retitle.
- Line 156–158: comment "SENT rule = 9 days; state_changed 2026-05-24 → derived = 2026-06-02"; expect `'2026-06-02'` (no `id` on the object → jitter 0).
- Line 171–174: ACK_RECEIVED now 9 days → expect `'2026-06-02'`; retitle "uses ACK_RECEIVED 9-day base rule".
- Line 180–182: comment becomes "SENT 9-day rule; 2026-06-20 → 2026-06-29 (inside)"; expectation `'2026-07-31'` unchanged.
- Line 186–187: expect `'2026-06-02'` (still outside the 06-15 window start).
- Lines 191–192 and 197–198: expect `'2026-06-27'` → `'2026-06-29'`.

`tests/tick-followup.test.js` — conversations get real ids, so their jitter is opaque; move every seed that must draft a nudge safely past the 15-day maximum (and leave "fresh" seeds under 9):
- Line 87: `stateChangedAt: '2026-06-14T00:00:00Z'` → `'2026-06-01T00:00:00Z'`; retitle "stale past the 9–15-day jittered threshold".
- Line 119: `'2026-06-10'` → `'2026-06-01'` (the follow-on runs go to 06-27; 06-10 gives only 14–17 days).
- Lines 136, 150: `'2026-06-10'` → `'2026-06-01'`.
- Lines 504, 513, 529, 554: `'2026-06-14'` → `'2026-06-01'`.
- Line 103 (`'2026-06-20'`, 4 days) stays — still under the 9-day floor.

`tests/vacation-followup.test.js` and `tests/tick-health.test.js`: inspect each `stateChangedAt`/`state_changed_at` seed against the `now` that test uses; any seed expecting a nudge with 9–15 effective stale days moves to ≥16 days. Seeds already ≥16 days (e.g. `'2026-05-01'` vs a late-June `now`) stay.

- [ ] **Step 6: Run the full suite and fix stragglers**

Run: `npm test`
Expected: PASS. If `arenden-order.test.js` or dashboard tests assert next-action dates derived from the old 7/14-day rules, recompute expected dates as `state_changed_at + 9 + nudgeJitterDays(conv.id)` (import the function into the test) — do not loosen assertions.

- [ ] **Step 7: Commit**

```bash
git add src/conversation.js src/tick.js tests/
git commit -m "feat(followup): 9-15 day deterministic jitter on nudge thresholds"
```

---

### Task 2: Kill-switch loader

**Files:**
- Modify: `src/pilot-config.js`
- Test: `tests/pilot-config.test.js`

**Interfaces:**
- Produces: `export function loadAutoSendTemplates(path = 'data/pilot-overrides.json')` → `string[]`; never throws; `[]` on any failure. Consumed by Task 5.

- [ ] **Step 1: Write the failing tests** — append to `tests/pilot-config.test.js` (extend the vitest import with `beforeEach, afterEach`, add `loadAutoSendTemplates` to the pilot-config import, and add `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';`):

```js
describe('loadAutoSendTemplates (auto-send kill switch, 2026-08-17 design)', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'overrides-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });
  const write = (content) => {
    const p = join(tmp, 'overrides.json');
    writeFileSync(p, content);
    return p;
  };

  it('returns the declared templates', () => {
    expect(loadAutoSendTemplates(write('{"auto_send_templates":["T_FOLLOWUP_NUDGE"]}')))
      .toEqual(['T_FOLLOWUP_NUDGE']);
  });

  it('missing file → [] (never throws — broken config fails toward manual)', () => {
    expect(loadAutoSendTemplates(join(tmp, 'nope.json'))).toEqual([]);
  });

  it('absent key / empty array / malformed JSON / non-array value → []', () => {
    expect(loadAutoSendTemplates(write('{}'))).toEqual([]);
    expect(loadAutoSendTemplates(write('{"auto_send_templates":[]}'))).toEqual([]);
    expect(loadAutoSendTemplates(write('{oops'))).toEqual([]);
    expect(loadAutoSendTemplates(write('{"auto_send_templates":"T_FOLLOWUP_NUDGE"}'))).toEqual([]);
  });

  it('non-string entries are dropped', () => {
    expect(loadAutoSendTemplates(write('{"auto_send_templates":[1,"T_FOLLOWUP_NUDGE",null]}')))
      .toEqual(['T_FOLLOWUP_NUDGE']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/pilot-config.test.js -t "loadAutoSendTemplates"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `src/pilot-config.js`** (append at the end; `readFileSync` is already imported):

```js
// Auto-send kill switch (2026-08-17 design): the draft templates the daily
// follow-up may send WITHOUT operator approval. Read fresh from disk at the
// start of every runDailyFollowup — a stale in-memory copy must not keep
// sending after the operator pulls the switch, so the daemon's startup-loaded
// overrides object is deliberately not consulted for this key. Unlike
// loadOverrides this NEVER throws: absent file, absent key, empty array and
// malformed JSON all mean [] — fully manual, the shipped default.
export function loadAutoSendTemplates(path = 'data/pilot-overrides.json') {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const list = parsed?.auto_send_templates;
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/pilot-config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pilot-config.js tests/pilot-config.test.js
git commit -m "feat(config): loadAutoSendTemplates kill switch, fail-toward-manual"
```

---

### Task 3: Lazy-conversation eligibility helper

**Files:**
- Modify: `src/conversation.js`
- Test: `tests/conversation.test.js`

**Interfaces:**
- Produces: `export const AUTO_SEND_LAZY_CLASSIFICATIONS` (Set) and `export function isLazyConversation(messages)` → boolean; `messages` are rows from `db.listMessages(convId)` (fields used: `direction`, `classification`). Consumed by Task 5.

- [ ] **Step 1: Write the failing tests** — append to `tests/conversation.test.js` (add `isLazyConversation` to the import):

```js
describe('isLazyConversation — auto-send eligibility rule 2 (fail closed)', () => {
  const inbound = (classification) => ({ direction: 'inbound', classification });
  const outbound = () => ({ direction: 'outbound', classification: null });

  it('zero inbound qualifies (outbound rows are ignored)', () => {
    expect(isLazyConversation([])).toBe(true);
    expect(isLazyConversation([outbound()])).toBe(true);
  });

  it('every LAZY classification qualifies', () => {
    expect(isLazyConversation([
      outbound(), inbound('auto_ack'), inbound('auto_reply'),
      inbound('delay_promise'), inbound('handoff_internal'),
    ])).toBe(true);
  });

  it('any substantive or unclassified inbound disqualifies', () => {
    for (const c of ['delivery', 'clarification', 'dead_end', 'bounce', 'unknown', null]) {
      expect(isLazyConversation([inbound('auto_ack'), inbound(c)])).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/conversation.test.js -t "isLazyConversation"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `src/conversation.js`** (append near `staleAction`):

```js
// The inbound classifications that mean "the kommun has not substantively
// responded" (2026-08-17 auto-send design). A conversation whose EVERY inbound
// is in this set — zero inbound also qualifies — is "lazy": a follow-up nudge
// cannot contradict anything a human told us. delivery / clarification /
// dead_end / bounce / unknown and NULL classification are all
// substantive-or-unclassifiable → fail closed, the operator decides.
export const AUTO_SEND_LAZY_CLASSIFICATIONS = new Set([
  'auto_ack', 'auto_reply', 'delay_promise', 'handoff_internal',
]);

// messages: rows from db.listMessages(convId). Outbound rows are ignored.
export function isLazyConversation(messages) {
  return (messages ?? [])
    .filter((m) => m.direction === 'inbound')
    .every((m) => AUTO_SEND_LAZY_CLASSIFICATIONS.has(m.classification));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/conversation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conversation.js tests/conversation.test.js
git commit -m "feat(conversation): lazy-conversation predicate for auto-send eligibility"
```

---

### Task 4: `auto_send` decision in send-reply + widened STALE_ESCALATION guard

**Files:**
- Modify: `src/send-reply.js:151`
- Create: `tests/auto-send-nudge.test.js` (shared scaffold + guard tests; Task 5 appends to it)

**Interfaces:**
- Consumes: nothing new — `sendApprovedReply` already resolves `decision !== 'edit'` to escalation status `resolved_send` and records `decision` verbatim in the ledger.
- Produces: `sendApprovedReply({ ..., decision: 'auto_send' })` behaves exactly like `'approve_unmodified'` including the STALE_ESCALATION guard. Task 5 calls it with `finalBody: esc.draft_body`, `finalSubject: esc.draft_subject`, no `finalTo`.

- [ ] **Step 1: Create `tests/auto-send-nudge.test.js` with the scaffold and two failing guard tests**

```js
// Auto-send of T_FOLLOWUP_NUDGE (2026-08-17 design): the first outbound class
// graduated from human-approved to automatic. Everything rides the existing
// approved-send rails; these tests are the contract for the graduation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runDailyFollowup } from '../src/tick.js';
import { sendApprovedReply } from '../src/send-reply.js';

let tmp, db, contractsDir, overridesPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-autosend-'));
  contractsDir = join(tmp, 'contracts');
  overridesPath = join(tmp, 'overrides.json');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

function writeSwitch(value) {
  writeFileSync(overridesPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function fakeSlackOps() {
  return {
    posts: [], updates: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async function (slack, args) { this.updates.push(args); }),
  };
}

// sendMessage is passed DETACHED as gmailSendImpl, so capture via closure, not `this`.
function fakeGmail({ sendError = null } = {}) {
  const sent = [];
  return {
    sent,
    sendMessage: vi.fn(async (gmailClient, args) => {
      if (sendError) throw new Error(sendError);
      sent.push(args);
      return { id: `out-${sent.length}`, threadId: 'thr-a' };
    }),
    archiveThread: vi.fn(async () => {}),
    listInboundQuery: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
  };
}

function seedHealthyTick(now) {
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(now.getTime() - 5 * 60000).toISOString());
}

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), now = new Date('2026-08-17T09:00:00Z') } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
    env, contractsDir, now, overridesPath,
  };
}

// Default seed is 23 days stale — safely past the 9–15-day jittered threshold
// for ANY conversation id.
function seedConv({ state = 'SENT', stateChangedAt = '2026-07-25T00:00:00Z', followupCount = 0, followUpAt = null, role = 'central', kommun = ['1440', 'Ale'], email = 'kansli@ale.se' } = {}) {
  const id = db.createConversation({
    kommun_kod: kommun[0], kommun_namn: kommun[1], role,
    contact_email: email, scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: 'thr-a', last_outbound_at: '2026-07-10T10:00:00Z',
    followup_count: followupCount, follow_up_at: followUpAt,
  });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  return id;
}

let inboundSeq = 0;
function seedInbound(convId, { classification = null, receivedAt = '2026-07-26T10:00:00Z' } = {}) {
  inboundSeq += 1;
  db.recordMessage({
    conversation_id: convId,
    gmail_message_id: `in-${inboundSeq}`,
    direction: 'inbound',
    from_email: 'kansli@ale.se',
    to_email: env.GMAIL_USER_EMAIL,
    subject: 'SV: Begäran om allmänna handlingar',
    body_text: 'Vi har mottagit din begäran.',
    classification,
    classification_confidence: classification ? 0.9 : null,
    received_at: receivedAt,
    attachment_count: 0,
    gmail_thread_id: 'thr-a',
  });
}

function seedNudgeEscalation(convId) {
  return db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'stale SENT',
    draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 'Påminnelse: begäran om allmänna handlingar',
    draft_body: 'Hej,\n\nJag vill bara följa upp min begäran.\n\nMvh Gustaf',
    classifier_class: 'followup_stale', previous_state: 'SENT',
  });
}

describe("sendApprovedReply guards apply to decision 'auto_send'", () => {
  it('STALE_ESCALATION: an inbound newer than the draft blocks auto_send exactly like approve_unmodified', async () => {
    const id = seedConv({});
    const escId = seedNudgeEscalation(id);
    db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run('2026-08-16 08:00:00', escId);
    seedInbound(id, { classification: 'auto_ack', receivedAt: '2026-08-16T10:00:00Z' });
    seedHealthyTick(new Date('2026-08-17T09:00:00Z'));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const gmail = fakeGmail();
    await expect(sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      decision: 'auto_send', gmailSendImpl: gmail.sendMessage,
      archiveThreadImpl: gmail.archiveThread,
    })).rejects.toMatchObject({ code: 'STALE_ESCALATION' });

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('STALE_INGEST refuses an auto_send and leaves the escalation open', async () => {
    const id = seedConv({});
    const escId = seedNudgeEscalation(id);
    db.recordHeartbeat({ kind: 'tick', error: 'invalid_grant' });
    db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
      .run(new Date(Date.now() - 120 * 60000).toISOString());

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
    const gmail = fakeGmail();
    await expect(sendApprovedReply({
      db, gmail: {}, env, conv: db.getConversation(id), esc,
      finalBody: esc.draft_body, finalSubject: esc.draft_subject,
      decision: 'auto_send', gmailSendImpl: gmail.sendMessage,
      archiveThreadImpl: gmail.archiveThread,
    })).rejects.toMatchObject({ code: 'STALE_INGEST' });

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
    expect(db.listDecisions()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify the STALE_ESCALATION test fails**

Run: `npx vitest run tests/auto-send-nudge.test.js`
Expected: the STALE_ESCALATION test FAILS (the guard currently fires only for `approve_unmodified`, so the send goes through). The STALE_INGEST test passes already (template-based guard) — that is fine; it pins the behavior.

- [ ] **Step 3: Widen the guard in `src/send-reply.js:151`**

```js
  if ((decision === 'approve_unmodified' || decision === 'auto_send') && !isRefreshEsc && !isBounceResend) {
```

And extend the comment block directly above it (after "An explicit edit passes — the human wrote with current context."):

```js
  // An 'auto_send' (2026-08-17 design) is held to the SAME bar as an
  // unmodified approve: the machine never writes with current context. The
  // daily-run escalation mutex means no tick can ingest between drafting and
  // auto-sending in the same run, but this guard must not rely on that
  // reasoning holding forever.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/auto-send-nudge.test.js tests/send-reply.test.js tests/send-safety.test.js`
Expected: PASS (existing send tests unaffected — they use `approve_unmodified`/`edit`).

- [ ] **Step 5: Commit**

```bash
git add src/send-reply.js tests/auto-send-nudge.test.js
git commit -m "feat(send-reply): auto_send decision held to the approve_unmodified staleness bar"
```

---

### Task 5: Auto-send in `runDailyFollowup` + daemon wiring

**Files:**
- Modify: `src/tick.js` (imports + `runDailyFollowup` body)
- Modify: `src/daemon.js:362` (pass `overridesPath`)
- Test: `tests/auto-send-nudge.test.js` (append)

**Interfaces:**
- Consumes: `loadAutoSendTemplates(path)` (Task 2), `isLazyConversation(messages)` (Task 3), `sendApprovedReply({ decision: 'auto_send' })` (Task 4), `nudgeJitterDays` (Task 1).
- Produces: `runDailyFollowup(deps)` honors a new optional dep `overridesPath` (string; defaults inside `loadAutoSendTemplates` to `'data/pilot-overrides.json'`). Ledger rows with `decision = 'auto_send'` (consumed by Task 6).

- [ ] **Step 1: Write the failing tests** — append to `tests/auto-send-nudge.test.js`:

```js
describe('runDailyFollowup auto-sends eligible T_FOLLOWUP_NUDGE', () => {
  it('eligible (SENT, zero inbound, switch on): exactly one send, resolved_send, decision auto_send, followup_count 1', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(gmail.sent[0].to).toBe('kansli@ale.se');
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(id);
    expect(esc.status).toBe('resolved_send');
    expect(esc.draft_template).toBe('T_FOLLOWUP_NUDGE');
    expect(gmail.sent[0].body).toBe(esc.draft_body);           // draft exactly as escalated
    expect(gmail.sent[0].subject).toBe(esc.draft_subject);
    const decisions = db.listDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'auto_send', draft_template: 'T_FOLLOWUP_NUDGE', conversation_id: id,
    });
    const conv = db.getConversation(id);
    expect(conv.followup_count).toBe(1);
    expect(conv.state).toBe('SENT');
  });

  it('lazy-only inbound (auto_ack + delay_promise past its follow_up_at) auto-sends', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ state: 'ACK_RECEIVED', followUpAt: '2026-08-10' });
    seedInbound(id, { classification: 'auto_ack' });
    seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-07-27T10:00:00Z' });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
    expect(db.listDecisions()[0]?.decision).toBe('auto_send');
  });

  it('any substantive or unclassified inbound → escalation stays open, nothing sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const cases = [
      ['0180', 'Stockholm', 'delivery'],
      ['1480', 'Göteborg', 'unknown'],
      ['1280', 'Malmö', null],
    ];
    for (const [kod, namn, classification] of cases) {
      const id = seedConv({ kommun: [kod, namn], email: `kansli@${kod}.se` });
      seedInbound(id, { classification });
    }
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    expect(db.listDecisions()).toHaveLength(0);
    expect(db.listOpenEscalations()).toHaveLength(cases.length); // drafted, awaiting the operator
  });

  it('kill switch absent, empty, or malformed → fully manual', async () => {
    const id = seedConv({});
    for (const content of [null, '{}', '{"auto_send_templates":[]}', '{broken']) {
      if (content !== null) writeSwitch(content);
      else rmSync(overridesPath, { force: true });
      const gmail = fakeGmail();
      await runDailyFollowup(deps({ gmail }));
      expect(gmail.sendMessage).not.toHaveBeenCalled();
      // The first pass drafts the escalation and leaves it open; later passes
      // are blocked by hasActiveEscalation — which is itself the contract.
    }
    expect(db.listOpenEscalationsForConversation(id)).toHaveLength(1);
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('switch edited between two runs takes effect without restart — and an open refusal is never retried', async () => {
    // Day 1, switch OFF: conv A drafts a manual escalation.
    rmSync(overridesPath, { force: true });
    const a = seedConv({});
    const gmail1 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail1 }));
    expect(gmail1.sendMessage).not.toHaveBeenCalled();
    expect(db.listOpenEscalationsForConversation(a)).toHaveLength(1);

    // Day 2, operator flips the switch ON. Conv B is due; conv A still holds
    // its open escalation → hasActiveEscalation skips it entirely.
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-18T09:00:00Z') }));

    expect(gmail2.sendMessage).toHaveBeenCalledTimes(1);
    expect(gmail2.sent[0].to).toBe('stad@goteborg.se');
    expect(db.listOpenEscalationsForConversation(a)).toHaveLength(1); // untouched
    expect(db.listDecisions().map((d) => d.conversation_id)).toEqual([b]);
  });

  it('a Gmail failure parks send_failed, books no decision, and the next daily run does not re-attempt', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({});
    const gmail = fakeGmail({ sendError: 'socket hang up' });
    await runDailyFollowup(deps({ gmail }));

    const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(id);
    expect(esc.status).toBe('send_failed');
    expect(db.listDecisions()).toHaveLength(0);
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);

    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-18T09:00:00Z') }));
    expect(gmail2.sendMessage).not.toHaveBeenCalled();
    expect(db.raw.prepare('SELECT COUNT(*) n FROM escalations').get().n).toBe(1);
  });

  it('nudge cap: followup_count = 2 → free_form escalation to a human, never auto-sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ followupCount: 2 });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));

    expect(gmail.sendMessage).not.toHaveBeenCalled();
    const escs = db.listOpenEscalationsForConversation(id);
    expect(escs).toHaveLength(1);
    expect(escs[0].draft_template).toBe('free_form');
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('a mid-run failure does not stop the remaining conversations', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    seedConv({});                                                       // will fail to send
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    let calls = 0;
    const gmail = fakeGmail();
    gmail.sendMessage.mockImplementation(async (gmailClient, args) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      gmail.sent.push(args);
      return { id: `out-${calls}`, threadId: 'thr-a' };
    });
    await runDailyFollowup(deps({ gmail }));

    expect(calls).toBe(2);                                              // second conv still processed
    expect(db.listDecisions().map((d) => d.conversation_id)).toEqual([b]);
    expect(db.getFollowupCompletedDate()).not.toBeNull();               // the run completed
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auto-send-nudge.test.js`
Expected: the new describe FAILS — nothing auto-sends yet (`gmail.sendMessage` never called in the eligible case).

- [ ] **Step 3: Implement in `src/tick.js`**

Add imports at the top (extending the existing conversation.js import from Task 1):

```js
import { nextActionForClassification, staleAction, nudgeJitterDays, isLazyConversation } from './conversation.js';
import { loadAutoSendTemplates } from './pilot-config.js';
import { sendApprovedReply } from './send-reply.js';
```

(`send-reply.js` does not import `tick.js`, so no cycle.)

In `runDailyFollowup`, after the ingest-health gate (right after the `if (health?.stale) { ... return; }` block, before `const todayIso = ...`):

```js
  // Kill switch (2026-08-17 design) — read fresh from disk EVERY run so the
  // operator pulling the switch takes effect on the next daily run without a
  // daemon restart. The daemon's startup-loaded overrides object is
  // deliberately not consulted for this key.
  const autoSendTemplates = loadAutoSendTemplates(deps.overridesPath);
```

Replace the tail of the loop body (currently `if (draftTemplate) { await escalateWithDraft({...}); log?.(...); }`) with:

```js
    if (draftTemplate) {
      const escId = await escalateWithDraft({
        conv,
        parsedInbound: null,
        // Follow-up drafts get a synthetic classifier class so their decisions
        // can form a graduating (class, state) pair — NULL never graduates
        // (review M3).
        classification: { class: 'followup_stale', confidence: null },
        previousState: conv.state,
        draftTemplate,
        reason,
        deps: { ...deps, sentDate: db.getFirstOutboundDate?.(conv.id) ?? null },
      });
      log?.(`FOLLOWUP drafted (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}`);

      // Auto-send (2026-08-17 design): T_FOLLOWUP_NUDGE — and ONLY it — may go
      // out unattended, and only to a kommun that has never substantively
      // responded (every inbound in the LAZY set; NULL classification fails
      // closed). escalateWithDraft ran FIRST so a crash between drafting and
      // sending leaves an open escalation a human can act on — never a lost
      // intention, never an untracked send. The send itself rides the proven
      // approved-send rails (atomic claim, STALE_* guards, send_failed
      // parking); decision 'auto_send' is how the ledger permanently tells
      // machine sends from operator sends.
      if (
        escId != null
        && draftTemplate === 'T_FOLLOWUP_NUDGE'
        && autoSendTemplates.includes('T_FOLLOWUP_NUDGE')
        && isLazyConversation(db.listMessages(conv.id))
      ) {
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        try {
          await sendApprovedReply({
            db,
            gmail: deps.gmailClient?.gmail,
            env: deps.env,
            conv,
            esc,
            finalBody: esc.draft_body,
            finalSubject: esc.draft_subject,
            decision: 'auto_send',
            gmailSendImpl: deps.gmailOps.sendMessage,
            archiveThreadImpl: deps.gmailOps.archiveThread,
            slackClient: deps.slackClient ?? null,
            log,
          });
          log?.(`AUTO-SENT T_FOLLOWUP_NUDGE → ${conv.kommun_namn}/${conv.role} (escalation ${escId})`);
        } catch (e) {
          // A refusal before the claim (STALE_*) left the escalation OPEN in
          // the operator's normal queue; a Gmail failure parked it
          // send_failed. Either way: no retry here — the next daily run skips
          // this conversation entirely (hasActiveEscalation) — and the rest
          // of today's conversations still run.
          log?.(`AUTO-SEND did not go out for ${conv.kommun_namn}/${conv.role} (${e.code ?? 'SEND_ERROR'}): ${e.message}`);
        }
      }
    }
```

(The `escalateWithDraft` argument object is IDENTICAL to today's — the only change is capturing its return value in `escId`.)

- [ ] **Step 4: Wire the daemon** — in `src/daemon.js`, inside `followupOnce` (line ~362), add one dep to the `runDailyFollowup` call:

```js
      await runDailyFollowup({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
        vacationConfig: resolveVacation(overrides),
        overridesPath: env.PILOT_OVERRIDES_PATH ?? 'data/pilot-overrides.json',
      });
```

(`PILOT_OVERRIDES_PATH` mirrors the dashboard's existing convention at `src/dashboard.js:47`.)

- [ ] **Step 5: Run to verify pass, then the full suite**

Run: `npx vitest run tests/auto-send-nudge.test.js` → PASS.
Run: `npm test` → PASS (in particular `tick-followup.test.js` still passes: its `deps()` sets no `overridesPath`, and the repo's `data/pilot-overrides.json` carries no `auto_send_templates` key, so those runs stay fully manual; do NOT add the key to the committed file — the feature ships OFF and is flipped on the box only).

- [ ] **Step 6: Commit**

```bash
git add src/tick.js src/daemon.js tests/auto-send-nudge.test.js
git commit -m "feat(followup): auto-send T_FOLLOWUP_NUDGE to lazy conversations behind kill switch"
```

---

### Task 6: Dashboard "Auto-skickade" feed

**Files:**
- Modify: `src/storage.js` (new query + export)
- Modify: `src/dashboard-views.js:2256` (`renderArenden`)
- Modify: `src/dashboard.js:944` (`/arenden` route)
- Test: `tests/auto-send-nudge.test.js` (append)

**Interfaces:**
- Consumes: `decisions` rows with `decision = 'auto_send'` (Task 5).
- Produces: `db.listAutoSendDecisions(limit = 20)` → `[{ decision_id, decided_at (ISO, 'YYYY-MM-DDTHH:MM:SSZ'), draft_template, conversation_id, kommun_namn, role, followup_count }]`, newest first. `renderArenden` accepts optional `autoSends` array (default `[]`).

- [ ] **Step 1: Write the failing tests** — append to `tests/auto-send-nudge.test.js` (add `import { renderArenden } from '../src/dashboard-views.js';` at the top):

```js
describe('dashboard visibility — Auto-skickade', () => {
  function seedDecision(convId, decision, decidedAt) {
    const escId = seedNudgeEscalation(convId);
    db.resolveEscalation(escId, { status: 'resolved_send', resolved_text: 'b' });
    const decId = db.recordDecision({
      escalation_id: escId, conversation_id: convId, conversation_state: 'SENT',
      classifier_class: 'followup_stale', draft_template: 'T_FOLLOWUP_NUDGE',
      draft_body: 'b', decision, final_body: 'b',
    });
    db.raw.prepare('UPDATE decisions SET decided_at = ? WHERE id = ?').run(decidedAt, decId);
    return decId;
  }

  it('listAutoSendDecisions: only auto_send rows, newest first, with the join fields the view needs', () => {
    const a = seedConv({});
    const b = seedConv({ kommun: ['1480', 'Göteborg'], email: 'stad@goteborg.se' });
    seedDecision(a, 'approve_unmodified', '2026-08-15 09:00:00');
    seedDecision(a, 'auto_send', '2026-08-16 09:00:00');
    seedDecision(b, 'auto_send', '2026-08-17 09:00:00');

    const rows = db.listAutoSendDecisions(20);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kommun_namn: 'Göteborg', role: 'central', conversation_id: b,
      draft_template: 'T_FOLLOWUP_NUDGE',
    });
    expect(rows[0].decided_at).toBe('2026-08-17T09:00:00Z');
    expect(rows[1].kommun_namn).toBe('Ale');
    expect(typeof rows[0].followup_count).toBe('number');
    expect(db.listAutoSendDecisions(1)).toHaveLength(1);
  });

  it('renderArenden shows the section only when rows exist', () => {
    expect(renderArenden({ cases: [] })).not.toContain('Auto-skickade');
    const html = renderArenden({
      cases: [],
      autoSends: [{
        decision_id: 1, decided_at: '2026-08-17T09:00:00Z', draft_template: 'T_FOLLOWUP_NUDGE',
        conversation_id: 3, kommun_namn: 'Ale', role: 'central', followup_count: 1,
      }],
    });
    expect(html).toContain('Auto-skickade');
    expect(html).toContain('/arenden/3');
    expect(html).toContain('Ale');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/auto-send-nudge.test.js -t "Auto-skickade"`
Expected: FAIL — `db.listAutoSendDecisions is not a function`.

- [ ] **Step 3: Implement the storage query** — in `src/storage.js`, directly after `listEditDecisions` (line ~563):

```js
  // Auto-send visibility (2026-08-17 design): the dashboard's "Auto-skickade"
  // feed — the most recent machine sends, joined to their conversation.
  // decided_at is normalized to ISO (T/Z) so the views' time formatting never
  // has to guess at SQLite's space-separated datetime.
  function listAutoSendDecisions(limit = 20) {
    return db.prepare(`
      SELECT
        d.id AS decision_id,
        strftime('%Y-%m-%dT%H:%M:%SZ', d.decided_at) AS decided_at,
        d.draft_template,
        conv.id AS conversation_id,
        conv.kommun_namn,
        conv.role,
        conv.followup_count
      FROM decisions d
      JOIN conversations conv ON conv.id = d.conversation_id
      WHERE d.decision = 'auto_send'
      ORDER BY d.decided_at DESC, d.id DESC
      LIMIT ?
    `).all(limit);
  }
```

Export it in the return object (line ~1412, after `listEditDecisions,`):

```js
    listAutoSendDecisions,
```

- [ ] **Step 4: Implement the view** — in `src/dashboard-views.js`, replace `renderArenden` (line 2256):

```js
export function renderArenden({ cases = [], selected = null, selectedId = null, gmailReady = false, heartbeat = null, partial = false, escalationCount = 0, autoSends = [] }) {
  // "Auto-skickade" (2026-08-17 design): the FYI surface for unattended sends.
  // Slack is not configured on the box, so this section IS the notification —
  // rendered only when at least one auto_send decision exists.
  const autoSection = autoSends.length === 0 ? '' : `
    <section class="auto-sends">
      <h2>Auto-skickade</h2>
      <table>
        <thead><tr><th>Skickat</th><th>Kommun</th><th>Roll</th><th>Mall</th><th>Påminnelse</th></tr></thead>
        <tbody>
          ${autoSends.map((d) => `<tr>
            <td><span title="${escapeHtml(d.decided_at)}">${escapeHtml(fmtAgo(d.decided_at))}</span></td>
            <td><a href="/arenden/${d.conversation_id}" data-pane-link>${escapeHtml(d.kommun_namn)}</a></td>
            <td>${escapeHtml(d.role)}</td>
            <td>${escapeHtml(d.draft_template ?? '')}</td>
            <td>${d.followup_count} av 2</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
  const body = `
    <div class="page-head"><h1>Ärenden</h1></div>
    <div class="master-detail">
      <aside class="md-list">${renderCaseList(cases, selectedId)}</aside>
      <div class="md-detail">${renderCaseDetailPane(selected, gmailReady)}</div>
    </div>${autoSection}`;
  return layout({ title: 'Ärenden', body, currentPath: '/arenden', heartbeat, partial, escalationCount });
}
```

(`escapeHtml` and `fmtAgo` already exist in this file — `fmtAgo` at line 59, used the same way by `renderActivity`.)

- [ ] **Step 5: Wire the route** — in `src/dashboard.js`, the `/arenden` list route (line 944) gains one property:

```js
  app.get('/arenden', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderArenden({
      cases: loadCaseSummaries(db),
      selected: null,
      gmailReady: !!currentGmail(),
      heartbeat: hb(), partial: isPartial(req), escalationCount: escCount(),
      autoSends: db.listAutoSendDecisions(20),
    }));
  });
```

(The detail route `/arenden/:id` stays as-is — the spec puts the feed on the list page only.)

- [ ] **Step 6: Run to verify pass, then the full suite**

Run: `npx vitest run tests/auto-send-nudge.test.js` → PASS.
Run: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage.js src/dashboard-views.js src/dashboard.js tests/auto-send-nudge.test.js
git commit -m "feat(dashboard): Auto-skickade feed on /arenden"
```

---

### Task 7: Document the changed invariant

**Files:**
- Modify: `CLAUDE.md` (project shape §2 + safety invariants + "Where to look")

**Interfaces:** none — documentation only, but it changes what every future session believes about the send policy, so it gets its own reviewable task.

- [ ] **Step 1: Update the "no unattended outbound" sentence** in CLAUDE.md's project-shape section. Replace:

> No outbound (except the scheduled T-INITIAL) is ever sent without human approval in v1.

with:

> No outbound is sent without human approval, with two exceptions: the scheduled T-INITIAL, and — behind the `auto_send_templates` kill switch in `data/pilot-overrides.json` — `T_FOLLOWUP_NUDGE` to kommuner whose every inbound is a lazy ack (2026-08-17 auto-send design).

- [ ] **Step 2: Add a safety-invariant bullet** at the end of the "Safety invariants" list:

```markdown
- **Auto-send is one template, fail-closed, kill-switched.** Only
  `T_FOLLOWUP_NUDGE` may go out unattended, and only when EVERY inbound in the
  conversation is classified in the LAZY set (`auto_ack`, `auto_reply`,
  `delay_promise`, `handoff_internal`; zero inbound qualifies; NULL/`unknown`
  never do) AND `auto_send_templates` in `data/pilot-overrides.json` lists it —
  the file is re-read at the start of every `runDailyFollowup`, so pulling the
  key stops the next run without a restart. The send rides `sendApprovedReply`
  with decision `auto_send` (the ledger's machine-vs-operator marker); the
  `STALE_ESCALATION` guard applies to `auto_send` exactly as to
  `approve_unmodified`. A refusal leaves the escalation open for the operator, a
  Gmail failure parks it `send_failed` — the automation NEVER retries either.
  Nudge thresholds are 9 + `nudgeJitterDays(conv.id)` (0–6, pure hash) days for
  SENT/ACK_RECEIVED so reminders don't fire like clockwork.
```

- [ ] **Step 3: Add the spec to "Where to look for what"**:

```markdown
- Auto-send follow-up nudges (first unattended send): `docs/superpowers/specs/2026-08-17-auto-send-followup-nudge-design.md`
```

- [ ] **Step 4: Run the full suite one last time**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record auto-send invariant (T_FOLLOWUP_NUDGE, kill switch, fail closed)"
```

---

## Self-review against the spec

- **Eligibility rules 1–4** → Task 5 condition (`draftTemplate === 'T_FOLLOWUP_NUDGE'` covers rule 1 — `T_FOLLOWUP_CLOSE` and `free_form` branches can never enter), Task 3 (rule 2, fail closed on NULL), Task 2 + fresh read in Task 5 (rule 3), untouched upstream gates (rule 4 — no gate is modified anywhere in this plan). Nudge #1 and #2 both auto-send (cap check lives in `staleAction`, unchanged at `MAX_NUDGES` 2 → `escalate` → `free_form`, Task 5 test).
- **Timing** → Task 1 (SENT 7→9, ACK_RECEIVED 14→9, both jittered; AWAITING_PRECISION/DELIVERING/CROSSCHECK untouched; jitter shifts drafting for manual approvals too since it sits in `staleAction`). Deviation from the spec's action-based condition documented under Global Constraints. `effectiveFollowUp` updated so the dashboard advertises the real date.
- **Mechanism** → Task 5 (escalate-then-send ordering, no overrides of body/subject/recipient, outcome handling delegated to the proven path), Task 4 (`STALE_ESCALATION` widening — the spec's MUST).
- **Kill switch** → Task 2 + Task 5 (fresh read per run; ships OFF; committed `data/pilot-overrides.json` is NOT given the key).
- **Visibility** → Task 6 (`listAutoSendDecisions`, section renders only when rows exist; auto-sent messages appear in existing surfaces for free — same `recordMessage`/`recordDecision` path).
- **Spec test items 1–9** → 1,2,3,4,6,7 in Task 5's describe; 5 in Task 1; 8 in Task 4 (+ Task 5's mid-run-failure test covers "remaining conversations still processed"); 9 in Task 6.
- **Out of scope respected**: no other template gains auto-send; no intra-day jitter; no Slack FYI (slackClient stays a guarded no-op); `MAX_NUDGES`/bounce/resend untouched; LAZY set not widened.
