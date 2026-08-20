# Auto-send T_DELAY_ACK + answered-clarification nudges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the deterministic `T_DELAY_ACK` acknowledgement go out unattended behind an 8-rule guard stack, and let the auto-nudge accept conversations whose only substantive inbound is a clarification we already answered.

**Architecture:** No new send path. Drafting is untouched; a new sweep phase at the end of `runDailyFollowup` (after the staleness loop, before `markFollowupCompleted`) sends eligible open T_DELAY_ACK escalations via `sendApprovedReply` with `decision: 'auto_send'`, gated by a pure predicate in `conversation.js` and a pure body-shape gate in `classifier.js`. `isLazyConversation` widens to admit answered clarifications. The Auto-skickade feed gains the trigger mail's sender + snippet.

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest (all offline — fake `gmailOps`/`slackOps`, temp-dir DBs).

**Spec:** `docs/superpowers/specs/2026-08-20-auto-send-delay-ack-design.md` — read it first; every guard constant and regex below is argued there with the live mail that motivated it.

## Global Constraints

- **Never add a send path that bypasses `sendApprovedReply`** (CLAUDE.md invariant #1). The sweep only calls `sendApprovedReply`.
- **Fail closed everywhere:** NULL classification, NULL confidence, unparseable `created_at`, missing trigger message, missing attachment counts → manual, never auto-send.
- **The automation never retries:** a refusal leaves the escalation `open`, a Gmail failure parks `send_failed`; the sweep makes exactly one attempt per escalation per run.
- **No schema changes.** New behaviour = new string value (`"T_DELAY_ACK"` in the existing `auto_send_templates` array) + read-only queries.
- **Tests are offline** (temp-dir SQLite via `mkdtempSync` + `openDb` + `migrate()`, injected fakes). Never touch `data/pilot.db`.
- **No em-dashes in outbound email prose** (not an issue here — no template text changes).
- Feature ships **OFF**: the committed `data/pilot-overrides.json` lists no `auto_send_templates`; the operator flips the box file.

## File Structure

- `src/classifier.js` — add `delayAckBodyGate(body)` (pure text gate, uses existing `stripQuotedText`).
- `src/conversation.js` — add `isAutoSendableDelayAck(...)` + constants; widen `isLazyConversation`.
- `src/storage.js` — add `countAutoSendDecisions(conversationId, draftTemplate)`; extend `listAutoSendDecisions` join.
- `src/tick.js` — add the sweep phase in `runDailyFollowup`.
- `src/dashboard-views.js` — Auto-skickade table: `—` for non-nudge Påminnelse, trigger snippet row.
- `CLAUDE.md` — update the auto-send safety invariant.
- Tests: `tests/auto-send-delay-ack.test.js` (new), `tests/classifier.test.js`, `tests/auto-send-nudge.test.js`, `tests/dashboard.test.js` (extend).

---

### Task 1: `delayAckBodyGate` in classifier.js

**Files:**
- Modify: `src/classifier.js` (append after `stripQuotedText`, ~line 140)
- Test: `tests/classifier.test.js` (append a new `describe`)

**Interfaces:**
- Consumes: `stripQuotedText(body)` (already exported from `src/classifier.js`).
- Produces: `export function delayAckBodyGate(body)` → `{ ok: boolean, reason: string|null }`. `reason` ∈ `'empty' | 'currency' | 'pickup' | 'attachment_language' | 'too_long'` when `ok === false`. Also `export const DELAY_ACK_AUTO_MAX_WORDS = 200`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/classifier.test.js` (it already imports from `../src/classifier.js`; extend the import line with `delayAckBodyGate`):

```js
describe('delayAckBodyGate', () => {
  it('passes a short clean delay promise (with signature + GDPR boilerplate)', () => {
    const body = [
      'Hej Gustaf,', '',
      'Vi har mottagit ditt mail och jag arbetar med din fråga, återkommer så snart jag kan.', '',
      'Med vänlig hälsning', 'Frida Örnborg', 'Gruppchef upphandling',
      'Kommunen hanterar dina personuppgifter enligt Dataskyddsförordningen.',
    ].join('\n');
    expect(delayAckBodyGate(body)).toEqual({ ok: true, reason: null });
  });

  it('blocks a body-text contract table (currency amounts) — Borås shape', () => {
    const body = 'Hej\n\nHär kommer resterande svar:\nBinogi\nBinogi Nordics AB\n2023-12-31\n911 000,00 kr\n';
    expect(delayAckBodyGate(body)).toEqual({ ok: false, reason: 'currency' });
  });

  it('does not mistake a phone number for a currency amount', () => {
    const body = 'Hej,\nVi återkommer inom kort.\nTel. 0472-15067\nPernilla';
    expect(delayAckBodyGate(body).ok).toBe(true);
  });

  it('blocks pickup/paper-delivery language — Eslöv shape', () => {
    const body = 'Hej,\nJag kommer inte maila avtalen, utan lägga dom i receptionen för dig att hämta.\nVänligen Malin';
    expect(delayAckBodyGate(body)).toEqual({ ok: false, reason: 'pickup' });
  });

  it('blocks attachment language', () => {
    const body = 'Hej,\nSe bifogade avtal, fler kommer.\nMvh';
    expect(delayAckBodyGate(body)).toEqual({ ok: false, reason: 'attachment_language' });
  });

  it('blocks visible text over 200 words', () => {
    const body = Array.from({ length: 201 }, (_, i) => `ord${i}`).join(' ');
    expect(delayAckBodyGate(body)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('blocks an empty / quoted-only body', () => {
    expect(delayAckBodyGate('')).toEqual({ ok: false, reason: 'empty' });
    expect(delayAckBodyGate(null)).toEqual({ ok: false, reason: 'empty' });
    expect(delayAckBodyGate('Från: Gustaf <g@x.se>\n> gammal text')).toEqual({ ok: false, reason: 'empty' });
  });

  it('ignores currency inside the quoted trailing history', () => {
    const body = 'Hej, vi återkommer inom kort.\n\nFrån: Gustaf Hård af Segerstad <gustaf.hard@gmail.com>\nSkickat: den 11 augusti\n…avtal värda 911 000 kr…';
    expect(delayAckBodyGate(body).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/classifier.test.js -t delayAckBodyGate`
Expected: FAIL — `delayAckBodyGate` is not exported.

- [ ] **Step 3: Implement**

Append to `src/classifier.js`:

```js
// ---- T_DELAY_ACK auto-send body gate (2026-08-20 design) ----
//
// A delay ack may only auto-send when the triggering mail is a plain "vi
// återkommer" promise. This gate blocks the shapes the 2026-08-19 evaluation
// found misfiled under delay_promise: a contract table pasted in the body
// (Borås — currency amounts), a paper-pickup instruction that needs a real
// answer (Eslöv — "hämta i receptionen"), and attachment talk that means the
// mail is a delivery whatever the classifier thought. Operates on
// stripQuotedText(body) so OUR OWN words quoted back never trigger it.
// Deliberately a blocklist, not a promise-phrase allowlist: a false block
// costs one manual approval; a false pass costs a wrong outbound.
export const DELAY_ACK_AUTO_MAX_WORDS = 200;

// "911 000,00 kr" / "1 234 SEK" — requires a digit group ending in a currency
// token, so phone numbers ("0472-15067") and dates never match.
const CURRENCY_RE = /\d[\d\s.,]*\s?(?:kr|sek)\b/i;
const PICKUP_RE = /\bhämta[sr]?\b|\breception(?:en)?\b|\bavhämt/i;
const ATTACHMENT_RE = /\bbifoga[rtd]?\b|\bbifogat\b|\bbilag(?:a|an|or|orna)\b/i;

export function delayAckBodyGate(body) {
  const visible = stripQuotedText(body ?? '').trim();
  if (!visible) return { ok: false, reason: 'empty' };
  if (CURRENCY_RE.test(visible)) return { ok: false, reason: 'currency' };
  if (PICKUP_RE.test(visible)) return { ok: false, reason: 'pickup' };
  if (ATTACHMENT_RE.test(visible)) return { ok: false, reason: 'attachment_language' };
  if (visible.split(/\s+/).length > DELAY_ACK_AUTO_MAX_WORDS) return { ok: false, reason: 'too_long' };
  return { ok: true, reason: null };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/classifier.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/classifier.js tests/classifier.test.js
git commit -m "feat(followup): body-shape gate for auto-sendable delay acks"
```

---

### Task 2: `isAutoSendableDelayAck` in conversation.js

**Files:**
- Modify: `src/conversation.js` (append after `isLazyConversation`, ~line 232)
- Test: `tests/auto-send-delay-ack.test.js` (create — unit `describe` only in this task)

**Interfaces:**
- Consumes: `delayAckBodyGate` from `./classifier.js` (Task 1).
- Produces:
  - `export const DELAY_ACK_AUTO_MIN_CONFIDENCE = 0.85`
  - `export const DELAY_ACK_AUTO_MAX_AGE_HOURS = 48`
  - `export const DELAY_ACK_AUTO_MAX_PER_CONV = 2`
  - `export function isAutoSendableDelayAck({ esc, messages, autoSentCount, now })` → `{ ok: boolean, reason: string|null }`. `esc` is an escalations row; `messages` is `db.listMessages(convId)` output (both directions, with `stored_attachment_count`); `autoSentCount` is a number; `now` is a `Date`. Never reads disk or DB.

- [ ] **Step 1: Write the failing tests**

Create `tests/auto-send-delay-ack.test.js`:

```js
// Auto-send of T_DELAY_ACK (2026-08-20 design): the second graduated class.
// Unit half: the pure eligibility predicate. Integration half (Task 4): the
// runDailyFollowup sweep.

import { describe, it, expect } from 'vitest';
import { isAutoSendableDelayAck, DELAY_ACK_AUTO_MIN_CONFIDENCE } from '../src/conversation.js';

const NOW = new Date('2026-08-20T09:00:00Z');

function esc(overrides = {}) {
  return {
    id: 1, conversation_id: 10, message_id: 100, status: 'open',
    draft_template: 'T_DELAY_ACK', classifier_class: 'delay_promise',
    classifier_confidence: 0.9,
    created_at: '2026-08-20 07:00:00', // SQLite datetime('now') shape, UTC
    ...overrides,
  };
}
function inbound(overrides = {}) {
  return {
    id: 100, direction: 'inbound', classification: 'delay_promise',
    received_at: '2026-08-20T06:55:00Z',
    body_text: 'Hej,\nVi återkommer så snart underlaget är klart.\nMvh Frida',
    attachment_count: 0, stored_attachment_count: 0,
    ...overrides,
  };
}
function check({ e = esc(), messages = [inbound()], autoSentCount = 0, now = NOW } = {}) {
  return isAutoSendableDelayAck({ esc: e, messages, autoSentCount, now });
}

describe('isAutoSendableDelayAck', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });

  it('rejects wrong template, non-open status', () => {
    expect(check({ e: esc({ draft_template: 'free_form' }) }).ok).toBe(false);
    expect(check({ e: esc({ status: 'send_failed' }) }).ok).toBe(false);
  });

  it('rejects low/NULL confidence and non-delay class (fail closed)', () => {
    expect(check({ e: esc({ classifier_confidence: 0.65 }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_confidence: null }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_class: null }) }).reason).toBe('class');
    expect(check({ e: esc({ classifier_confidence: DELAY_ACK_AUTO_MIN_CONFIDENCE }) }).ok).toBe(true); // >= is inclusive
  });

  it('rejects an escalation older than 48h — the deploy-backlog guard', () => {
    expect(check({ e: esc({ created_at: '2026-08-17 07:00:00' }) }).reason).toBe('stale_draft');
  });

  it('rejects an unparseable created_at (fail closed)', () => {
    expect(check({ e: esc({ created_at: 'not-a-date' }) }).reason).toBe('stale_draft');
  });

  it('rejects when the trigger is missing or not the newest inbound', () => {
    expect(check({ messages: [] }).reason).toBe('trigger_missing');
    expect(check({ messages: [inbound(), inbound({ id: 101, received_at: '2026-08-20T08:00:00Z' })] }).reason).toBe('not_latest_inbound');
    // tie on received_at → manual
    expect(check({ messages: [inbound(), inbound({ id: 101 })] }).reason).toBe('not_latest_inbound');
  });

  it('outbound rows never count as "newer inbound"', () => {
    const out = { id: 101, direction: 'outbound', received_at: '2026-08-20T08:30:00Z', body_text: 'x', attachment_count: 0 };
    expect(check({ messages: [inbound(), out] }).ok).toBe(true);
  });

  it('rejects a trigger with stored attachments; missing counts fail closed', () => {
    expect(check({ messages: [inbound({ stored_attachment_count: 1 })] }).reason).toBe('attachments');
    expect(check({ messages: [inbound({ stored_attachment_count: undefined, attachment_count: 2 })] }).reason).toBe('attachments');
  });

  it('applies the body gate and surfaces its reason', () => {
    expect(check({ messages: [inbound({ body_text: 'Avtalet kostar 911 000,00 kr per år' })] }).reason).toBe('currency');
  });

  it('caps lifetime auto-sends per conversation at 2', () => {
    expect(check({ autoSentCount: 1 }).ok).toBe(true);
    expect(check({ autoSentCount: 2 }).reason).toBe('auto_send_cap');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/auto-send-delay-ack.test.js`
Expected: FAIL — `isAutoSendableDelayAck` is not exported.

- [ ] **Step 3: Implement**

In `src/conversation.js`: add `import { delayAckBodyGate } from './classifier.js';` at the top (check for import cycles: `classifier.js` must not import from `conversation.js` — it does not today), then append after `isLazyConversation`:

```js
// ---- T_DELAY_ACK auto-send eligibility (2026-08-20 design) ----
//
// Pure predicate over rows the caller fetched; never reads disk or DB. Every
// unknown fails closed. Returns { ok, reason } so the sweep can log WHY a
// draft stayed manual — the reasons are the spec's rule names.
export const DELAY_ACK_AUTO_MIN_CONFIDENCE = 0.85;
// Rollout guard: drafts already open when the feature deploys (including the
// known-bad Borås/Eslöv ones) must never auto-send; only fresh drafts qualify.
export const DELAY_ACK_AUTO_MAX_AGE_HOURS = 48;
// Mail-loop bound (Örebro shape): our ack can trigger an autoresponder that
// classifies delay_promise again with a fresh date, which hasDelayAckForDate
// does not dedupe. Two lifetime auto-acks bounds the loop; later drafts
// escalate to the operator as today. Operator sends never count.
export const DELAY_ACK_AUTO_MAX_PER_CONV = 2;

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC; normalise like
// tick.js parseDbTime. Unparseable → null → fail closed.
function dbTimeMs(s) {
  const raw = String(s ?? '');
  const ms = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function isAutoSendableDelayAck({ esc, messages, autoSentCount, now }) {
  const no = (reason) => ({ ok: false, reason });
  if (!esc || esc.draft_template !== 'T_DELAY_ACK' || esc.status !== 'open') return no('not_delay_ack');
  if (esc.classifier_class !== 'delay_promise') return no('class');
  if (typeof esc.classifier_confidence !== 'number'
    || esc.classifier_confidence < DELAY_ACK_AUTO_MIN_CONFIDENCE) return no('confidence');

  const createdMs = dbTimeMs(esc.created_at);
  if (createdMs == null
    || now.getTime() - createdMs > DELAY_ACK_AUTO_MAX_AGE_HOURS * 3600 * 1000) return no('stale_draft');

  const inbound = (messages ?? []).filter((m) => m.direction === 'inbound');
  const trigger = inbound.find((m) => m.id === esc.message_id);
  if (!trigger) return no('trigger_missing');
  // Strictly newest: any OTHER inbound at the same or a later received_at
  // means the world may have moved — manual. Complementary to the
  // STALE_ESCALATION guard in sendApprovedReply (which compares against the
  // escalation's creation time, not the trigger's position).
  const triggerMs = dbTimeMs(trigger.received_at);
  if (triggerMs == null) return no('not_latest_inbound');
  for (const m of inbound) {
    if (m.id === trigger.id) continue;
    const ms = dbTimeMs(m.received_at);
    if (ms == null || ms >= triggerMs) return no('not_latest_inbound');
  }

  // Same fail-closed chain as isLazyConversation: missing computed column
  // falls back to the raw carried count.
  if ((trigger.stored_attachment_count ?? trigger.attachment_count ?? 0) !== 0) return no('attachments');

  const gate = delayAckBodyGate(trigger.body_text);
  if (!gate.ok) return no(gate.reason);

  if ((autoSentCount ?? 0) >= DELAY_ACK_AUTO_MAX_PER_CONV) return no('auto_send_cap');
  return { ok: true, reason: null };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/auto-send-delay-ack.test.js tests/classifier.test.js tests/conversation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conversation.js tests/auto-send-delay-ack.test.js
git commit -m "feat(followup): pure eligibility predicate for auto-send delay acks"
```

---

### Task 3: storage — `countAutoSendDecisions` + trigger fields in the feed query

**Files:**
- Modify: `src/storage.js` (`listAutoSendDecisions` ~line 583; add `countAutoSendDecisions` next to it; both must be added to the returned object ~line 1418+)
- Test: `tests/storage.test.js` (append a `describe`; it already has the temp-DB harness)

**Interfaces:**
- Consumes: existing `decisions`/`escalations`/`messages` tables (no schema change).
- Produces:
  - `db.countAutoSendDecisions(conversationId, draftTemplate)` → integer count of rows with `decision='auto_send'`, that conversation, that template.
  - `db.listAutoSendDecisions(limit)` rows gain `trigger_from` (string|null) and `trigger_snippet` (string|null, ≤160 chars).

- [ ] **Step 1: Write the failing tests**

Append to `tests/storage.test.js` (reuse its existing `openDb`+`migrate` beforeEach harness; seed with the same `db.createConversation` / `db.recordMessage` / `db.recordEscalation` / `db.recordDecision` helpers used elsewhere in the file):

```js
describe('auto-send decision queries (2026-08-20 delay-ack design)', () => {
  function seed() {
    const convId = db.createConversation({
      kommun_kod: '1440', kommun_namn: 'Ale', role: 'central',
      contact_email: 'kansli@ale.se', scheduled_send_at: '2026-07-01T00:00:00Z',
    });
    const msgId = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'in-1', direction: 'inbound',
      from_email: 'upphandling@ale.se', to_email: 'me@x.se',
      subject: 'SV: Begäran', body_text: 'Hej, vi återkommer så snart vi kan. Mvh',
      classification: 'delay_promise', classification_confidence: 0.9,
      received_at: '2026-08-20T06:00:00Z', attachment_count: 0, gmail_thread_id: 'thr-1',
    });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: msgId, reason: 'delay ack until=2026-08-25',
      draft_template: 'T_DELAY_ACK', draft_subject: 'Re: Begäran', draft_body: 'Hej,\n\nTack…',
      classifier_class: 'delay_promise', classifier_confidence: 0.9, previous_state: 'ACK_RECEIVED',
    });
    return { convId, msgId, escId };
  }

  it('countAutoSendDecisions counts only auto_send rows for that conversation+template', () => {
    const { convId, escId } = seed();
    const base = { escalation_id: escId, conversation_id: convId, conversation_state: 'ACK_RECEIVED', draft_body: 'x' };
    db.recordDecision({ ...base, draft_template: 'T_DELAY_ACK', decision: 'auto_send' });
    db.recordDecision({ ...base, draft_template: 'T_DELAY_ACK', decision: 'edit' });          // operator: not counted
    db.recordDecision({ ...base, draft_template: 'T_FOLLOWUP_NUDGE', decision: 'auto_send' }); // other template: not counted
    expect(db.countAutoSendDecisions(convId, 'T_DELAY_ACK')).toBe(1);
    expect(db.countAutoSendDecisions(convId + 999, 'T_DELAY_ACK')).toBe(0);
  });

  it('listAutoSendDecisions carries the trigger sender + snippet, NULL for proactive drafts', () => {
    const { convId, escId } = seed();
    db.recordDecision({
      escalation_id: escId, conversation_id: convId, conversation_state: 'ACK_RECEIVED',
      draft_template: 'T_DELAY_ACK', draft_body: 'x', decision: 'auto_send',
    });
    const nudgeEsc = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'stale SENT',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_body: 'y', classifier_class: 'followup_stale',
    });
    db.recordDecision({
      escalation_id: nudgeEsc, conversation_id: convId, conversation_state: 'SENT',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_body: 'y', decision: 'auto_send',
    });
    const rows = db.listAutoSendDecisions(10);
    const ack = rows.find((r) => r.draft_template === 'T_DELAY_ACK');
    const nudge = rows.find((r) => r.draft_template === 'T_FOLLOWUP_NUDGE');
    expect(ack.trigger_from).toBe('upphandling@ale.se');
    expect(ack.trigger_snippet).toContain('vi återkommer');
    expect(ack.trigger_snippet.length).toBeLessThanOrEqual(160);
    expect(nudge.trigger_from).toBeNull();
    expect(nudge.trigger_snippet).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/storage.test.js -t "auto-send decision queries"`
Expected: FAIL — `countAutoSendDecisions` is not a function.

- [ ] **Step 3: Implement**

In `src/storage.js`, next to `listAutoSendDecisions`:

```js
  // How many times the machine has already sent this template for this
  // conversation (2026-08-20 delay-ack design, loop bound). Operator
  // decisions (edit / approve_unmodified) deliberately do not count.
  function countAutoSendDecisions(conversationId, draftTemplate) {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM decisions
      WHERE conversation_id = ? AND draft_template = ? AND decision = 'auto_send'
    `).get(conversationId, draftTemplate).n;
  }
```

Extend `listAutoSendDecisions`'s SELECT with the trigger join (2026-08-20
design, Visibility): add to the column list

```sql
        m.from_email AS trigger_from,
        substr(m.body_text, 1, 160) AS trigger_snippet
```

and after the existing `JOIN conversations conv …` add

```sql
      LEFT JOIN escalations e ON e.id = d.escalation_id
      LEFT JOIN messages m ON m.id = e.message_id
```

(LEFT joins: a proactive draft has `message_id` NULL — the feed row survives with NULL trigger fields.)

Register `countAutoSendDecisions` in the returned object next to `listAutoSendDecisions`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/storage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/storage.test.js
git commit -m "feat(storage): auto-send decision count + trigger fields in the feed query"
```

---

### Task 4: the sweep in `runDailyFollowup`

**Files:**
- Modify: `src/tick.js` — insert the sweep between the end of the staleness `for` loop and `db.markFollowupCompleted(localDateStr(now))` (~line 1466). Extend the import from `./conversation.js` (line 8) with `isAutoSendableDelayAck`.
- Test: `tests/auto-send-delay-ack.test.js` (append the integration `describe`)

**Interfaces:**
- Consumes: `isAutoSendableDelayAck` (Task 2), `db.countAutoSendDecisions` (Task 3), existing `db.listEscalationsByStatus('open')`, `db.listMessages`, `sendApprovedReply`, `loadAutoSendTemplates` result already in `autoSendTemplates`, `isInVacation(todayIso, cfg)`.
- Produces: eligible open T_DELAY_ACK escalations are sent with `decision: 'auto_send'`; every skip and outcome is logged.

- [ ] **Step 1: Write the failing integration tests**

Append to `tests/auto-send-delay-ack.test.js`. Copy the harness from `tests/auto-send-nudge.test.js` verbatim: the imports (`mkdtempSync`/`rmSync`/`writeFileSync`, `openDb`, `runDailyFollowup`, `vi`), the `beforeEach`/`afterEach` temp-dir DB, `env`, `writeSwitch`, `fakeSlackOps`, `fakeGmail`, `seedHealthyTick` (including its max-of-both-clocks comment — it is load-bearing), `fakeSlackClient`, `deps`, `seedConv`, `seedInbound` — with `now` defaulting to `new Date('2026-08-20T09:00:00Z')` and `seedInbound` extended to accept `{ fromEmail, bodyText }` overrides. Then:

```js
function seedDelayAckEscalation(convId, msgId, { confidence = 0.9, createdAt = null } = {}) {
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: msgId, reason: 'delay ack until=2026-08-25',
    draft_template: 'T_DELAY_ACK', draft_subject: 'Re: Begäran om allmänna handlingar',
    draft_body: 'Hej,\n\nTack för ditt svar! Då avvaktar vi så länge och hör av oss igen om vi inte fått något.\n\nMvh Gustaf',
    classifier_class: 'delay_promise', classifier_confidence: confidence, previous_state: 'ACK_RECEIVED',
  });
  if (createdAt) db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run(createdAt, escId);
  return escId;
}

describe('runDailyFollowup delay-ack sweep', () => {
  it('sends an eligible fresh draft: resolved_send + auto_send decision, exactly one mail', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, {
      classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z',
      bodyText: 'Hej,\nVi återkommer så snart underlaget är klart.\nMvh',
    });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(1);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
    const d = db.listDecisions().find((x) => x.decision === 'auto_send');
    expect(d.draft_template).toBe('T_DELAY_ACK');
  });

  it('switch off / nudge-only switch → draft stays open, nothing sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('the deploy-day backlog never auto-sends (created_at 3 days ago)', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-10T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-17T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId, { createdAt: '2026-08-17 06:05:00' });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('lifetime cap: third auto delay-ack stays open; operator sends do not count', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    // two prior machine sends
    for (let i = 0; i < 2; i += 1) {
      const m = seedInbound(id, { classification: 'delay_promise', receivedAt: `2026-08-1${i}T06:00:00Z`, bodyText: 'Vi återkommer.' });
      const e = seedDelayAckEscalation(id, m);
      db.resolveEscalation(e, { status: 'resolved_send' });
      db.recordDecision({ escalation_id: e, conversation_id: id, conversation_state: 'ACK_RECEIVED', draft_template: 'T_DELAY_ACK', draft_body: 'x', decision: 'auto_send' });
    }
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('Gmail failure parks send_failed, records no decision, and the next run does not retry', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const failing = fakeGmail({ sendError: 'quota' });
    await runDailyFollowup(deps({ gmail: failing, now: new Date('2026-08-20T09:00:00Z') }));
    expect(db.listEscalationsByStatus('send_failed')).toHaveLength(1);
    expect(db.listDecisions().filter((d) => d.decision === 'auto_send')).toHaveLength(0);
    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-21T09:00:00Z') }));
    expect(gmail2.sent).toHaveLength(0);
  });

  it('a swept conversation does not also get a nudge draft in the same run', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK', 'T_FOLLOWUP_NUDGE'] });
    // 30 days stale — past any jittered nudge threshold — but holding an open delay ack.
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-07-21T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(1); // the ack, nothing else
    expect(db.listEscalationsByStatus('open')).toHaveLength(0);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
  });

  it('vacation window skips the sweep, draft stays open', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    const d = deps({ gmail, now: new Date('2026-08-20T09:00:00Z') });
    d.vacationConfig = { enabled: true, start: '2026-08-01', end: '2026-08-31' };
    await runDailyFollowup(d);
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });
});
```

(If `seedInbound`'s copy does not already take `bodyText`, extend the copied helper: `body_text: bodyText ?? 'Vi har mottagit din begäran.'`. Check the exact `vacationConfig` shape against `src/vacation.js` `isInVacation` before writing the vacation test — use whatever keys `tests/vacation-followup.test.js` uses.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/auto-send-delay-ack.test.js`
Expected: unit `describe` passes (Task 2), sweep `describe` FAILS — nothing sent / drafts untouched.

- [ ] **Step 3: Implement the sweep**

In `src/tick.js`, extend the line-8 import with `isAutoSendableDelayAck`, then insert between the staleness loop's closing brace and the `// Reached the end` comment (~line 1466):

```js
  // ---- T_DELAY_ACK auto-send sweep (2026-08-20 design) ----
  // Drafting happened at ingest (dispatchEscalationForIngest); this sweep sends
  // the eligible fresh ones on the morning cadence. It runs AFTER the staleness
  // loop so every swept conversation was already skipped there via
  // hasActiveEscalation — no same-run interleaving. Skipped entirely inside the
  // vacation window (drafts stay open for the operator) and, like the whole
  // run, never reached while ingest is blind (the gate at the top returned).
  if (autoSendTemplates.includes('T_DELAY_ACK') && !isInVacation(todayIso, cfg)) {
    const openDelayAcks = db.listEscalationsByStatus('open')
      .filter((e) => e.draft_template === 'T_DELAY_ACK');
    for (const esc of openDelayAcks) {
      const conv = db.getConversation(esc.conversation_id);
      if (!conv) continue;
      const verdict = isAutoSendableDelayAck({
        esc,
        messages: db.listMessages(conv.id),
        autoSentCount: db.countAutoSendDecisions(conv.id, 'T_DELAY_ACK'),
        now,
      });
      if (!verdict.ok) {
        log?.(`DELAY-ACK stays manual for ${conv.kommun_namn}/${conv.role} (escalation ${esc.id}): ${verdict.reason}`);
        continue;
      }
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
        log?.(`AUTO-SENT T_DELAY_ACK → ${conv.kommun_namn}/${conv.role} (escalation ${esc.id})`);
      } catch (e) {
        // Same truthful outcome log as the nudge auto-send: read the status
        // back and claim only what it proves. No retry, no status mutation.
        const after = db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id)?.status ?? null;
        const outcome = after === 'open'
          ? 'refused before the send claim, did not go out'
          : after === 'send_failed'
            ? 'Gmail rejected it, did not go out'
            : `outcome UNCERTAIN (escalation status ${after ?? 'unknown'}) — the mail may have been sent; recoverStuckSends will escalate it to a human`;
        log?.(`AUTO-SEND ${outcome} for ${conv.kommun_namn}/${conv.role} (${e.code ?? 'SEND_ERROR'}): ${e.message}`);
      }
    }
  }
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: everything green — in particular `tests/auto-send-nudge.test.js`, `tests/tick-followup.test.js`, `tests/vacation-followup.test.js` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/auto-send-delay-ack.test.js
git commit -m "feat(followup): auto-send fresh eligible T_DELAY_ACK drafts in the daily run"
```

---

### Task 5: answered-clarification widening of `isLazyConversation`

**Files:**
- Modify: `src/conversation.js:227-232` (`isLazyConversation`) and its doc comment
- Test: `tests/auto-send-nudge.test.js` (extend the existing lazy-gate `describe` — find it with `grep -n "isLazyConversation\|lazy" tests/auto-send-nudge.test.js`)

**Interfaces:**
- Consumes/Produces: `isLazyConversation(messages)` — signature unchanged; `messages` is `db.listMessages(convId)` (both directions).

- [ ] **Step 1: Write the failing tests**

Add unit tests (import `isLazyConversation` from `../src/conversation.js` — if the file tests it only via `runDailyFollowup`, add a small unit `describe`):

```js
describe('isLazyConversation with answered clarifications (2026-08-20)', () => {
  const IN = (classification, received_at, extra = {}) => ({ direction: 'inbound', classification, received_at, stored_attachment_count: 0, attachment_count: 0, ...extra });
  const OUT = (received_at) => ({ direction: 'outbound', classification: null, received_at, attachment_count: 0 });

  it('answered clarification qualifies (Jönköping shape)', () => {
    expect(isLazyConversation([
      IN('auto_ack', '2026-07-05T10:00:00Z'),
      IN('clarification', '2026-07-06T10:00:00Z'),
      OUT('2026-07-11T10:00:00Z'),
      IN('delay_promise', '2026-07-15T10:00:00Z'),
    ])).toBe(true);
  });

  it('unanswered clarification does not (no outbound after it)', () => {
    expect(isLazyConversation([
      OUT('2026-07-05T09:00:00Z'),
      IN('clarification', '2026-07-06T10:00:00Z'),
    ])).toBe(false);
    expect(isLazyConversation([IN('clarification', '2026-07-06T10:00:00Z')])).toBe(false);
  });

  it('clarification at the same timestamp as the outbound is unanswered (strict after)', () => {
    expect(isLazyConversation([
      IN('clarification', '2026-07-06T10:00:00Z'),
      OUT('2026-07-06T10:00:00Z'),
    ])).toBe(false);
  });

  it('a stored attachment on ANY inbound still disqualifies, clarification answered or not', () => {
    expect(isLazyConversation([
      IN('clarification', '2026-07-06T10:00:00Z', { stored_attachment_count: 1 }),
      OUT('2026-07-11T10:00:00Z'),
    ])).toBe(false);
  });

  it('delivery / unknown / NULL still disqualify conversation-wide', () => {
    expect(isLazyConversation([IN('delivery', '2026-07-06T10:00:00Z'), OUT('2026-07-11T10:00:00Z')])).toBe(false);
    expect(isLazyConversation([IN(null, '2026-07-06T10:00:00Z')])).toBe(false);
  });
});
```

Also add ONE end-to-end case to the existing sweep-style nudge tests in the same file: seed the Jönköping shape (`auto_ack` + `clarification` + a later outbound row + `delay_promise` past its follow-up window, state `ACK_RECEIVED`, 30 days stale, switch `['T_FOLLOWUP_NUDGE']`) and assert the nudge auto-sends; flip the clarification's `received_at` to after the outbound and assert it stays manual. Seed the outbound with `db.recordMessage({ direction: 'outbound', … })` mirroring `seedInbound`.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/auto-send-nudge.test.js`
Expected: new cases FAIL (clarification currently disqualifies everywhere); old cases PASS.

- [ ] **Step 3: Implement**

Replace `isLazyConversation` in `src/conversation.js` (keep the existing doc comment, append to it):

```js
// 2026-08-20 widening: a 'clarification' no longer disqualifies IF an
// outbound exists strictly after it — the kommun asked, we answered, and
// everything since is lazy (live: Jönköping conv 23, Burlöv conv 36). An
// UNANSWERED clarification still fails: the generic nudge must never stand in
// for the real reply the operator owes. The zero-stored-attachments condition
// stays conversation-wide on purpose: a delivered file anywhere makes "jag
// vill följa upp" a misdescription whatever came after, and a body-text
// delivery (the Bjuv shape) still fails via its 'delivery' classification.
export function isLazyConversation(messages) {
  const msgs = messages ?? [];
  const lastOutMs = Math.max(-Infinity, ...msgs
    .filter((m) => m.direction === 'outbound')
    .map((m) => Date.parse(m.received_at ?? ''))
    .filter(Number.isFinite));
  return msgs
    .filter((m) => m.direction === 'inbound')
    .every((m) => {
      if ((m.stored_attachment_count ?? m.attachment_count ?? 0) !== 0) return false;
      if (AUTO_SEND_LAZY_CLASSIFICATIONS.has(m.classification)) return true;
      if (m.classification !== 'clarification') return false;
      const ms = Date.parse(m.received_at ?? '');
      return Number.isFinite(ms) && ms < lastOutMs; // answered = an outbound strictly after
    });
}
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS. (`tests/auto-send-nudge.test.js` existing cases must be untouched — none of them seed a clarification-then-outbound history.)

- [ ] **Step 5: Commit**

```bash
git add src/conversation.js tests/auto-send-nudge.test.js
git commit -m "feat(followup): answered clarifications no longer block the auto-nudge"
```

---

### Task 6: dashboard feed + docs

**Files:**
- Modify: `src/dashboard-views.js:2260-2275` (Auto-skickade table in `renderArenden`)
- Modify: `CLAUDE.md` (the "Auto-send is one template, fail-closed, kill-switched" invariant)
- Test: `tests/dashboard.test.js` (find the existing `renderArenden` auto-sends test with `grep -n "Auto-skickade" tests/*.test.js` and extend it)

**Interfaces:**
- Consumes: `listAutoSendDecisions` rows with `trigger_from`/`trigger_snippet` (Task 3).

- [ ] **Step 1: Write the failing test**

Extend the existing Auto-skickade view test:

```js
it('renders — for non-nudge templates and shows the escaped trigger snippet', () => {
  const html = renderArenden({
    cases: [], autoSends: [{
      decision_id: 1, decided_at: '2026-08-20T09:00:00Z', draft_template: 'T_DELAY_ACK',
      conversation_id: 5, kommun_namn: 'Ale', role: 'central', followup_count: 0,
      trigger_from: 'upphandling@ale.se', trigger_snippet: 'Vi återkommer <snart>.',
    }],
  });
  expect(html).toContain('T_DELAY_ACK');
  expect(html).not.toContain('0 av 2');
  expect(html).toContain('Vi återkommer &lt;snart&gt;.');
  expect(html).toContain('upphandling@ale.se');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js`
Expected: FAIL (shows `0 av 2`, no snippet).

- [ ] **Step 3: Implement**

In `renderArenden`'s `autoSends.map`, replace the Påminnelse cell and add the snippet row:

```js
          ${autoSends.map((d) => `<tr>
            <td><span title="${escapeHtml(d.decided_at)}">${escapeHtml(fmtAgo(d.decided_at))}</span></td>
            <td><a href="/arenden/${d.conversation_id}" data-pane-link>${escapeHtml(d.kommun_namn)}</a></td>
            <td>${escapeHtml(d.role)}</td>
            <td>${escapeHtml(d.draft_template ?? '')}</td>
            <td>${d.draft_template === 'T_FOLLOWUP_NUDGE' ? `${d.followup_count} av 2` : '—'}</td>
          </tr>${d.trigger_snippet ? `<tr class="auto-send-trigger">
            <td></td>
            <td colspan="4"><small>svar på ${escapeHtml(d.trigger_from ?? '')}: ${escapeHtml(d.trigger_snippet)}…</small></td>
          </tr>` : ''}`).join('')}
```

(The `—` here is dashboard chrome, not outbound email prose — the no-em-dash rule governs mail bodies only, and this file already uses it in tables.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS.

- [ ] **Step 5: Update CLAUDE.md**

In the "Auto-send is one template, fail-closed, kill-switched" bullet: retitle to "Auto-send is two templates, fail-closed, kill-switched", and after the existing T_FOLLOWUP_NUDGE sentence add:

> `T_DELAY_ACK` (2026-08-20 design) may also go out unattended via the same
> `runDailyFollowup` + `sendApprovedReply` rails, but only when
> `isAutoSendableDelayAck` (conversation.js) passes: switch lists it, open
> draft ≤48h old (`stale_draft` — the deploy-day backlog never auto-sends),
> `delay_promise` ≥0.85, trigger is the strictly-newest inbound with zero
> stored attachments, `delayAckBodyGate` (classifier.js) finds no
> currency/pickup/attachment language and ≤200 visible words, and fewer than
> 2 prior machine sends of this template for the conversation
> (`countAutoSendDecisions` — the autoresponder-loop bound; operator sends
> don't count). Every rule fails closed and every skip logs its reason.
> `isLazyConversation` additionally admits a `clarification` answered by a
> strictly-later outbound (unanswered ones still block; the
> zero-stored-attachment rule stays conversation-wide).

- [ ] **Step 6: Full suite + commit**

Run: `npx vitest run`
Expected: PASS (~1330+ tests).

```bash
git add src/dashboard-views.js tests/dashboard.test.js CLAUDE.md
git commit -m "feat(dashboard): delay-ack rows in Auto-skickade carry their trigger; document the invariant"
```

---

## Rollout (operator steps, after merge + deploy — not part of the plan's code)

1. `git push` + `AWS_PROFILE=personal ./deploy/deploy.sh`.
2. Precompute-then-verify, same as 2026-08-19: on the box, run a read-only
   check of which open delay acks WOULD qualify (all 14 pre-existing ones must
   show `stale_draft`), e.g. via a one-off `node -e` over
   `isAutoSendableDelayAck`.
3. Add `"T_DELAY_ACK"` to `auto_send_templates` in
   `/var/lib/mediagraf/pilot-overrides.json` (NOT the app-dir file — deploys
   overwrite it).
4. Watch the next 09:00Z run's log lines (`AUTO-SENT T_DELAY_ACK` /
   `DELAY-ACK stays manual … reason`) and the Auto-skickade feed.

## Self-Review

- **Spec coverage:** Part 1 guards 1–8 → Tasks 1/2/4 (switch in sweep, predicate rules, body gate); sweep placement/vacation/health → Task 4; Part 2 → Task 5; Visibility → Tasks 3/6; kill-switch value + rollout → Task 6 docs + Rollout. Spec test list items 1–6 → Task 4, 7 → Task 5, 8 → Task 1, 9 → Tasks 3/6. No gaps found.
- **Placeholder scan:** none (the two "check X before writing" notes in Task 4/5 are verification instructions with concrete commands, not deferred design).
- **Type consistency:** `isAutoSendableDelayAck({ esc, messages, autoSentCount, now }) → { ok, reason }` used identically in Tasks 2 and 4; `delayAckBodyGate(body) → { ok, reason }` in Tasks 1 and 2; `countAutoSendDecisions(conversationId, draftTemplate) → number` in Tasks 3 and 4; feed fields `trigger_from`/`trigger_snippet` in Tasks 3 and 6. Consistent.
