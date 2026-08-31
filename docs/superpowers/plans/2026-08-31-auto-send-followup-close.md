# Auto-send T_FOLLOWUP_CLOSE + honest ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record untouched dashboard "edits" honestly as `approve_unmodified`, and graduate `T_FOLLOWUP_CLOSE` to unattended auto-send behind the existing kill switch.

**Architecture:** Part A is a normalization + reclassification inside the dashboard resolve endpoint only. Part B adds a pure eligibility guard in `conversation.js` and a capped sweep in `runDailyFollowup` that rides the proven `sendApprovedReply` rails (`decision: 'auto_send'`), mirroring the T_DELAY_ACK sweep.

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest (offline fakes).

**Spec:** `docs/superpowers/specs/2026-08-31-auto-send-followup-close-design.md`

## Global Constraints

- No send path may bypass `sendApprovedReply`; auto-send decision value is exactly `'auto_send'`.
- Every guard rule fails closed; non-finite numbers (`NaN`, `undefined`, `null`) never pass a numeric check (`Number.isFinite`).
- The sweep never retries and never mutates escalation status on failure; catch-blocks read the status back and log only what it proves (copy the T_DELAY_ACK sweep's catch verbatim in shape).
- Reclassification lives ONLY in the dashboard resolve endpoint (`POST /escalations/:id`) — never in `sendApprovedReply` (free-form composer stores draft=final by construction and would misclassify).
- Tests are offline: temp-dir SQLite (`mkdtempSync` + `openDb`), fake `gmailOps`, overrides via a temp `pilot-overrides.json`. Never the live `data/pilot.db`.
- No em-dashes in any outbound email prose (none is added by this plan; the close template is unchanged).
- CLAUDE.md's auto-send invariant paragraph must be updated in the same branch (Task 3).

---

### Task 1: Honest ledger — CRLF normalization + reclassification in the dashboard resolve endpoint

**Files:**
- Modify: `src/dashboard.js` (resolve endpoint ~line 1297–1345; free-form composer body ~line 1020–1040)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `sendApprovedReply({ decision })`, `db.recordDecision` (unchanged).
- Produces: dashboard resolve decisions are `approve_unmodified` when the operator changed nothing. Later tasks rely on nothing here; Part B benefits indirectly (honest future evidence).

- [ ] **Step 1: Write failing tests** in `tests/dashboard.test.js` (use the existing `postForm(app, path, fields)` helper and the file's existing seeding pattern for an open escalation; inject a `gmailSendImpl`-capturing fake the way the file's existing resolve tests do — read the nearest resolve-endpoint test in that file first and copy its setup):

```js
describe('resolve endpoint edit/approve honesty (2026-08-31)', () => {
  it('records approve_unmodified when the edited body is byte-identical modulo CRLF', async () => {
    const { escId } = seedOpenEscalation(); // same-file helper/pattern
    const draft = db.raw.prepare('SELECT draft_body, draft_subject FROM escalations WHERE id = ?').get(escId);
    const res = await postForm(app, `/escalations/${escId}`, {
      action: 'edit',
      subject: draft.draft_subject,
      body: draft.draft_body.replace(/\n/g, '\r\n'),  // what a browser textarea posts
    });
    expect(res.status).toBe(302);
    const d = db.raw.prepare('SELECT decision, final_body FROM decisions WHERE escalation_id = ?').get(escId);
    expect(d.decision).toBe('approve_unmodified');
    expect(d.final_body).not.toContain('\r');          // stored normalized
  });

  it('still records edit when the text actually changed', async () => {
    const { escId } = seedOpenEscalation();
    const draft = db.raw.prepare('SELECT draft_body, draft_subject FROM escalations WHERE id = ?').get(escId);
    const res = await postForm(app, `/escalations/${escId}`, {
      action: 'edit', subject: draft.draft_subject,
      body: (draft.draft_body + '\r\nPS. En rad till.').replace(/\n/g, '\r\n'),
    });
    expect(res.status).toBe(302);
    const d = db.raw.prepare('SELECT decision FROM decisions WHERE escalation_id = ?').get(escId);
    expect(d.decision).toBe('edit');
  });

  it('blocks an untouched edit on a stale escalation with 409 (faces STALE_ESCALATION like an approve)', async () => {
    const { escId, convId } = seedOpenEscalation();
    // a newer inbound AFTER the draft was created makes it stale
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-newer-${Math.random()}`, direction: 'inbound',
      from_email: 'kommun@x.se', to_email: 'me@x.com', subject: 'Sv', body_text: 'Nytt svar',
      received_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    const draft = db.raw.prepare('SELECT draft_body FROM escalations WHERE id = ?').get(escId);
    const res = await postForm(app, `/escalations/${escId}`, {
      action: 'edit', body: draft.draft_body.replace(/\n/g, '\r\n'),
    });
    expect(res.status).toBe(409);
    expect(db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId).status).toBe('open');
  });
});
```

- [ ] **Step 2: Run the new tests, verify they FAIL** (`npx vitest run tests/dashboard.test.js -t "edit/approve honesty"`).

- [ ] **Step 3: Implement** in `src/dashboard.js`. Module-scope helper near the resolve endpoint:

```js
// Browser textareas submit \r\n; drafts are stored with \n. Normalize before
// comparing or storing, or every untouched approval books as an 'edit'
// (2026-08-31 honest-ledger design) — the ledger had ZERO approve_unmodified
// rows despite most "edits" changing nothing.
const normalizeNewlines = (s) => (s ?? '').replace(/\r\n/g, '\n');
```

In the resolve endpoint replace the `finalBody`/`decision` derivation:

```js
const finalBody = (action === 'edit' ? normalizeNewlines(req.body.body) : esc.draft_body) ?? '';
const finalSubject = (action === 'edit' ? req.body.subject : esc.draft_subject) ?? undefined;
if (!finalBody.trim()) return res.status(400).send('Cannot send an empty body');

// An "edit" that changed nothing is an unmodified approve and is held to an
// unmodified approve's bar: it faces STALE_ESCALATION (the operator did not
// write with newer context if they did not write at all).
const untouched = action === 'edit'
  && finalBody === normalizeNewlines(esc.draft_body ?? '')
  && (req.body.subject == null || req.body.subject === (esc.draft_subject ?? ''));
```

and pass `decision: action === 'send' || untouched ? 'approve_unmodified' : 'edit'` to `sendApprovedReply`. In the free-form composer endpoint, wrap its body input in the same `normalizeNewlines(...)` where `finalBody` is first built.

- [ ] **Step 4: Run the new tests, verify PASS**, then the whole file: `npx vitest run tests/dashboard.test.js`.

- [ ] **Step 5: Commit** — `fix(ledger): record untouched dashboard edits as approve_unmodified, normalize CRLF`

---

### Task 2: Pure guard `isAutoSendableFollowupClose`

**Files:**
- Modify: `src/conversation.js` (place directly after `isAutoSendableDelayAck`)
- Test: `tests/auto-send-followup-close.test.js` (create; unit half)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isAutoSendableFollowupClose({ esc, conv, unreadDocs, autoSentCount }) → { ok: boolean, reason: string|null }` and `export const CLOSE_AUTO_MAX_PER_RUN = 5` (exported from `src/tick.js` in Task 3 — the guard file exports only the predicate). Task 3 calls the predicate with `unreadDocs: db.countUnreadAnalysableAttachments(conv.id)` and `autoSentCount: db.countAutoSendDecisions(conv.id, 'T_FOLLOWUP_CLOSE')`.

- [ ] **Step 1: Write failing unit tests** in `tests/auto-send-followup-close.test.js`:

```js
// Auto-send of T_FOLLOWUP_CLOSE (2026-08-31 design): the third graduated
// template. Unit half: the pure eligibility predicate. Integration half
// (Task 3): the runDailyFollowup sweep.

import { describe, it, expect } from 'vitest';
import { isAutoSendableFollowupClose } from '../src/conversation.js';

function esc(overrides = {}) {
  return { id: 1, conversation_id: 10, status: 'open', draft_template: 'T_FOLLOWUP_CLOSE', ...overrides };
}
function conv(overrides = {}) {
  return { id: 10, state: 'DELIVERING', kommun_namn: 'Grums', role: 'other', ...overrides };
}
function check({ e = esc(), c = conv(), unreadDocs = 0, autoSentCount = 0 } = {}) {
  return isAutoSendableFollowupClose({ esc: e, conv: c, unreadDocs, autoSentCount });
}

describe('isAutoSendableFollowupClose', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });
  it('rejects wrong template and non-open status', () => {
    expect(check({ e: esc({ draft_template: 'T_FOLLOWUP_NUDGE' }) }).reason).toBe('not_followup_close');
    expect(check({ e: esc({ status: 'send_failed' }) }).reason).toBe('not_open');
    expect(check({ e: null }).reason).toBe('not_followup_close');
  });
  it('rejects every non-DELIVERING state — CROSSCHECK close reminders stay manual', () => {
    expect(check({ c: conv({ state: 'CROSSCHECK' }) }).reason).toBe('wrong_state');
    expect(check({ c: conv({ state: 'ACK_RECEIVED' }) }).reason).toBe('wrong_state');
    expect(check({ c: null }).reason).toBe('wrong_state');
  });
  it('rejects unread analysable documents, failing closed on non-finite counts', () => {
    expect(check({ unreadDocs: 1 }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: NaN }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: undefined }).reason).toBe('unread_documents');
  });
  it('rejects a conversation that already got a machine close, failing closed on non-finite counts', () => {
    expect(check({ autoSentCount: 1 }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: NaN }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: undefined }).reason).toBe('auto_send_cap');
  });
});
```

- [ ] **Step 2: Run, verify FAIL** (`npx vitest run tests/auto-send-followup-close.test.js`).

- [ ] **Step 3: Implement** in `src/conversation.js` after `isAutoSendableDelayAck`:

```js
// --- T_FOLLOWUP_CLOSE auto-send (2026-08-31 design): the third graduated ---
// template. Evidence: 8/8 operator sends byte-identical to the draft. Pure
// predicate; the sweep in tick.js supplies unreadDocs/autoSentCount from the
// DB. Divergence from the delay-ack guard, deliberate: NO draft-age rule —
// the template is timeless prose and the deploy-day backlog is the point.
// Correctness against a changed world stays with sendApprovedReply
// (STALE_ESCALATION on newer inbound, STALE_INGEST while blind).
export function isAutoSendableFollowupClose({ esc, conv, unreadDocs, autoSentCount }) {
  const no = (reason) => ({ ok: false, reason });
  if (!esc || esc.draft_template !== 'T_FOLLOWUP_CLOSE') return no('not_followup_close');
  if (esc.status !== 'open') return no('not_open');
  // DELIVERING only: all 8 evidence sends were DELIVERING. CROSSCHECK earns
  // its own record before it graduates.
  if (!conv || conv.state !== 'DELIVERING') return no('wrong_state');
  // "Is that everything?" may not go out while a delivered document sits
  // unread (pending OR parked) on our own disk — same principle as the
  // T_REQUEST_MISSING suppression. Non-finite fails closed.
  if (!Number.isFinite(unreadDocs) || unreadDocs !== 0) return no('unread_documents');
  // Once per conversation, ever. Operator sends do not count
  // (countAutoSendDecisions semantics). Non-finite fails closed.
  if (!Number.isFinite(autoSentCount) || autoSentCount !== 0) return no('auto_send_cap');
  return { ok: true, reason: null };
}
```

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Commit** — `feat(followup): pure eligibility guard for unattended T_FOLLOWUP_CLOSE`

---

### Task 3: Sweep in runDailyFollowup + CLAUDE.md

**Files:**
- Modify: `src/tick.js` (immediately after the T_DELAY_ACK sweep block, inside `runDailyFollowup`)
- Modify: `CLAUDE.md` (auto-send invariant paragraph)
- Test: `tests/auto-send-followup-close.test.js` (extend; integration half)

**Interfaces:**
- Consumes: `isAutoSendableFollowupClose` (Task 2), `db.countUnreadAnalysableAttachments(convId)`, `db.countAutoSendDecisions(convId, 'T_FOLLOWUP_CLOSE')`, `db.listEscalationsByStatus('open')`, `sendApprovedReply`.
- Produces: `export const CLOSE_AUTO_MAX_PER_RUN = 5;` in `src/tick.js`.

- [ ] **Step 1: Write failing integration tests.** Mirror the harness of `tests/auto-send-delay-ack.test.js`'s sweep tests EXACTLY (temp-dir DB via `mkdtempSync`+`openDb`+`migrate`, overrides file with `auto_send_templates`, fake `gmailOps` whose `sendMessage` records calls, `runDailyFollowup` deps object — read that file first and reuse its helpers/shape). Seed: a DELIVERING conversation with an open `T_FOLLOWUP_CLOSE` escalation (drafted earlier, any age). Cases:

  1. switch lists `T_FOLLOWUP_CLOSE` + eligible → exactly one Gmail send; decision row `auto_send` with `draft_template='T_FOLLOWUP_CLOSE'`; escalation resolved.
  2. switch does NOT list it → zero sends, escalation stays open.
  3. 7 eligible escalations across 7 conversations → exactly `CLOSE_AUTO_MAX_PER_RUN` (5) sends, oldest escalation ids first, 2 left open, cap log line emitted.
  4. conversation state CROSSCHECK → skipped with logged reason `wrong_state`, stays open.
  5. an unread analysable attachment on the conversation → skipped `unread_documents`.
  6. a prior `auto_send` decision row for this conv+template → skipped `auto_send_cap`.
  7. newer inbound after draft creation → `sendApprovedReply` throws STALE_ESCALATION; escalation still open; log says "refused before the send claim"; no retry within the run.
  8. `gmailOps.sendMessage` throws → escalation parked `send_failed`; not retried; next run does not send it (status not open).
  9. vacation window (`isInVacation` true via cfg) → no sweep, stays open.
  10. an old escalation (created 10 days ago) IS sent — pin the no-age-rule divergence so a future refactor cannot silently copy the delay-ack 48h rule in.

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement the sweep** in `src/tick.js` right after the T_DELAY_ACK sweep:

```js
  // ---- T_FOLLOWUP_CLOSE auto-send sweep (2026-08-31 design) ----
  // Same rails and same run-position rationale as the delay-ack sweep above.
  // Capped per run: the deploy-day backlog (11 open on release day) drains
  // over ~3 daily runs instead of one burst. Oldest escalation first. A
  // catch where the claim went through counts toward the cap — the mail may
  // have left, and the cap bounds outbound volume, not bookkeeping.
  if (autoSendTemplates.includes('T_FOLLOWUP_CLOSE') && !isInVacation(todayIso, cfg)) {
    const openCloses = db.listEscalationsByStatus('open')
      .filter((e) => e.draft_template === 'T_FOLLOWUP_CLOSE')
      .sort((a, b) => a.id - b.id);
    let sentThisRun = 0;
    for (const esc of openCloses) {
      if (sentThisRun >= CLOSE_AUTO_MAX_PER_RUN) {
        log?.(`CLOSE auto-send cap reached (${CLOSE_AUTO_MAX_PER_RUN}/run) — remaining open T_FOLLOWUP_CLOSE drafts wait for the next run`);
        break;
      }
      const conv = db.getConversation(esc.conversation_id);
      const verdict = isAutoSendableFollowupClose({
        esc,
        conv,
        unreadDocs: conv ? db.countUnreadAnalysableAttachments(conv.id) : NaN,
        autoSentCount: conv ? db.countAutoSendDecisions(conv.id, 'T_FOLLOWUP_CLOSE') : NaN,
      });
      if (!verdict.ok) {
        log?.(`CLOSE stays manual for ${conv?.kommun_namn ?? '?'}/${conv?.role ?? '?'} (escalation ${esc.id}): ${verdict.reason}`);
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
        sentThisRun++;
        log?.(`AUTO-SENT T_FOLLOWUP_CLOSE → ${conv.kommun_namn}/${conv.role} (escalation ${esc.id})`);
      } catch (e) {
        // Same truthful outcome log as the delay-ack sweep: read the status
        // back and claim only what it proves. No retry, no status mutation.
        const after = db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id)?.status ?? null;
        if (after !== 'open') sentThisRun++; // claim went through: mail may have left; cap bounds outbound volume
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

Add near the file's other exported constants: `export const CLOSE_AUTO_MAX_PER_RUN = 5;` and import `isAutoSendableFollowupClose` alongside the existing `isAutoSendableDelayAck` import.

- [ ] **Step 4: Run the new file, verify PASS**, then the FULL suite: `npm test`.

- [ ] **Step 5: Update `CLAUDE.md`** — the invariant bullet currently titled "**Auto-send is two templates, fail-closed, kill-switched.**" becomes "…three templates…"; its opening sentence lists `T_FOLLOWUP_NUDGE`, `T_DELAY_ACK` and `T_FOLLOWUP_CLOSE`; append after the delay-ack sentences: "`T_FOLLOWUP_CLOSE` (2026-08-31 design) auto-sends only for a DELIVERING conversation with zero unread (pending or parked) analysable attachments and zero prior machine sends of the template, capped at `CLOSE_AUTO_MAX_PER_RUN` (tick.js) per daily run, oldest first; it has deliberately NO draft-age rule (timeless template, the backlog is the point) — STALE_ESCALATION and STALE_INGEST carry world-changed correctness. The dashboard resolve endpoint records an untouched 'edit' as `approve_unmodified` (CRLF-normalized), so untouched sends face STALE_ESCALATION like any approve."

- [ ] **Step 6: Commit** — `feat(followup): unattended T_FOLLOWUP_CLOSE sweep, capped per run, kill-switched`
