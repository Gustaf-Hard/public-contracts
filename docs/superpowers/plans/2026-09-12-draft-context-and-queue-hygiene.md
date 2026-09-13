# Draft Context & Queue Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The reply-drafting LLM sees the conversation (thread, attachments, contracts, original request), kommun-imposed deadlines are extracted and surfaced first in the queue, and a daily Slack digest stops escalations from silently aging.

**Architecture:** Package A adds a pure context-builder module (`src/draft-context.js`) whose output rides into the existing `analyseMessage` user prompt — the cached system prompt is only extended with static rules, so prompt caching keeps working. Package B adds one nullable schema field (`respond_by_date`), one escalation column (`respond_by`), and sorting/badges. Package C adds three read-only storage queries and one daily Slack digest next to the existing hänvisning nag digest.

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest (all offline — fake Anthropic client, fake slackOps, temp-dir DBs), Claude Haiku via structured output (json_schema — union-param count must stay ≤16, see memory `anthropic-structured-output-union-limit`).

**Spec:** `docs/superpowers/specs/2026-09-12-draft-context-and-queue-hygiene-design.md`

## Global Constraints

- Schema changes ONLY via the append-only `PRAGMA table_info` probe pattern in `migrate()` (storage.js), plus the same column in the base `SCHEMA` string (the `messages.analysis_json` precedent).
- Never break the ingest IO ordering (tick.js `ingestMessage` comment): analysis → attachment fetch → ONE transaction. The context builder reads only the DB (prior messages) and `parsed.attachments` METADATA — never fetched bytes.
- The system prompt carries `cache_control: ephemeral` — per-conversation content goes in the USER message only; the system prompt gets only static rule text.
- `ANALYSIS_SCHEMA` union-typed params: currently 9 (`extracted`'s 8 nullable fields + `follow_up_at`). This plan adds exactly 1 (`respond_by_date`) → 10. Do not add more.
- All tests offline; run a file with `npx vitest run tests/<name>.test.js`.
- Outbound email prose rules apply to prompt-rule wording examples: no em-dash/en-dash separators in draft text the model is told to produce.
- Do not commit or push beyond the commits named in tasks; never touch `data/pilot.db`.

---

### Task 1: Storage helpers for the context builder

**Files:**
- Modify: `src/storage.js` (add `listAttachmentsForConversation` next to `listContractInfoForConversation` ~line 1159; extend `listContractInfoForConversation`'s SELECT)
- Test: `tests/storage.test.js` (append a describe block)

**Interfaces:**
- Produces: `db.listAttachmentsForConversation(conversationId)` → `[{ message_id, filename }]` ordered by attachment id.
- Produces: `db.listContractInfoForConversation(conversationId)` rows now ALSO carry `document_type` (existing callers in coverage logic are unaffected — additive column).

- [ ] **Step 1: Write the failing tests** (append to `tests/storage.test.js`):

```js
describe('draft-context storage helpers (2026-09-12 design)', () => {
  it('listAttachmentsForConversation returns filename per message, in attachment order', () => {
    const convId = db.createConversation({
      kommun_kod: '1280', kommun_namn: 'Malmö', role: 'central',
      contact_email: 'malmostad@malmo.se', scheduled_send_at: '2026-08-01T08:00:00Z',
    });
    const m1 = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'dc-m1', direction: 'inbound',
      from_email: 'k@malmo.se', to_email: 'us', subject: 's', body_text: 'b',
      received_at: '2026-08-19T14:15:00Z', attachment_count: 2,
    });
    db.recordAttachment({ message_id: m1, filename: 'NE Avtal.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    db.recordAttachment({ message_id: m1, filename: 'Dugga.pdf', saved_path: '/x/2.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const rows = db.listAttachmentsForConversation(convId);
    expect(rows).toEqual([
      { message_id: m1, filename: 'NE Avtal.pdf' },
      { message_id: m1, filename: 'Dugga.pdf' },
    ]);
  });

  it('listContractInfoForConversation includes document_type', () => {
    const convId = db.createConversation({
      kommun_kod: '1281', kommun_namn: 'Lund', role: 'central',
      contact_email: 'k@lund.se', scheduled_send_at: '2026-08-01T08:00:00Z',
    });
    const m = db.recordMessage({
      conversation_id: convId, gmail_message_id: 'dc-m2', direction: 'inbound',
      from_email: 'k@lund.se', to_email: 'us', subject: 's', body_text: 'b',
      received_at: '2026-08-19T14:15:00Z', attachment_count: 1,
    });
    const att = db.recordAttachment({ message_id: m, filename: 'oversikt.pdf', saved_path: '/x/3.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    // recordContract takes vendor_id (from upsertVendor), never vendor_name — see tests/contracts-storage.test.js:59
    db.recordContract({ attachment_id: att, vendor_id: null, is_contract: 0, document_type: 'följebrev_sammanställning', summary: 'En översikt.' });
    const rows = db.listContractInfoForConversation(convId);
    expect(rows).toHaveLength(1);
    expect(rows[0].document_type).toBe('följebrev_sammanställning');
    expect(rows[0].is_contract).toBe(0);
  });
});
```

`recordContract(c)` (storage.js ~line 958) takes `attachment_id`, optional `vendor_id` (resolve with `db.upsertVendor(name).id`), `is_contract`, `document_type`, `summary` and the value columns; all optional fields default to null. `listContractInfoForConversation` currently selects only `is_contract`, `vendor_name`, `analysis_json` (line ~1159).

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/storage.test.js -t "draft-context storage"` — expect FAIL (`listAttachmentsForConversation is not a function`).

- [ ] **Step 3: Implement.** In `src/storage.js`, next to `listContractInfoForConversation`:

```js
  // Filenames per message for the WHOLE conversation, in attachment-id order.
  // Feeds the draft-context thread log (2026-09-12 design): the draft LLM must
  // see what each mail carried so it can never claim a delivered avtal is
  // missing.
  function listAttachmentsForConversation(conversationId) {
    return db.prepare(`
      SELECT a.message_id AS message_id, a.filename AS filename
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ?
      ORDER BY a.id
    `).all(conversationId);
  }
```

Extend `listContractInfoForConversation`'s SELECT with `c.document_type AS document_type` (same join, purely additive). Export `listAttachmentsForConversation` in the returned db object alongside the existing functions.

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/storage.test.js` — all green.

- [ ] **Step 5: Commit:** `git add src/storage.js tests/storage.test.js && git commit -m "feat(storage): attachment + document_type projections for draft context"`

---

### Task 2: The context builder module

**Files:**
- Create: `src/draft-context.js`
- Test: `tests/draft-context.test.js`

**Interfaces:**
- Consumes: `db.listMessages`, `db.listAttachmentsForConversation`, `db.listContractInfoForConversation` (Task 1).
- Produces: `buildDraftContext(db, conv, parsed)` → string. `parsed` needs only `{ attachments: [{ filename }] }`. The trigger message is NOT yet in the DB when this runs (ingest IO ordering), so `db.listMessages` returns exactly the prior thread.

- [ ] **Step 1: Write the failing tests** (`tests/draft-context.test.js`, temp-dir DB like `tests/storage.test.js` — copy its `beforeEach` with `mkdtempSync` + `openDb` + `migrate()`):

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { buildDraftContext } from '../src/draft-context.js';

let dir, db, convId;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draft-ctx-'));
  db = openDb(join(dir, 'test.db'));
  db.migrate();
  convId = db.createConversation({
    kommun_kod: '1280', kommun_namn: 'Malmö', role: 'central',
    contact_email: 'malmostad@malmo.se', scheduled_send_at: '2026-08-01T08:00:00Z',
  });
});
afterEach(() => { db.close?.(); rmSync(dir, { recursive: true, force: true }); });

function seedMsg({ dir = 'inbound', gmailId, body, at, analysis = null, cls = null }) {
  return db.recordMessage({
    conversation_id: convId, gmail_message_id: gmailId, direction: dir,
    from_email: dir === 'inbound' ? 'k@malmo.se' : 'gustaf.hard@gmail.com',
    to_email: 'x', subject: 's', body_text: body, received_at: at,
    attachment_count: 0, classification: cls,
    analysis_json: analysis ? JSON.stringify(analysis) : null,
  });
}

const conv = () => db.getConversation(convId);
const noAtts = { attachments: [] };

describe('buildDraftContext', () => {
  it('leads with the first outbound verbatim under Ursprunglig begäran', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Hej,\n\nJag begär avtal enligt offentlighetsprincipen.', at: '2026-08-17T14:45:24Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('# Ursprunglig begäran');
    expect(out).toContain('Jag begär avtal enligt offentlighetsprincipen.');
  });

  it('prior outbounds appear in full; prior inbounds as stored summary + classification', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    seedMsg({ dir: 'outbound', gmailId: 'o2', body: 'Om avgift krävs kan jag faktureras på Mediagraf i Stockholm AB.', at: '2026-08-20T10:00:00Z' });
    seedMsg({ gmailId: 'i1', body: 'Långt originalmejl med citerad svans...', at: '2026-08-21T09:00:00Z', cls: 'delay_promise', analysis: { summary: 'Kommunen återkommer nästa vecka.' } });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('Om avgift krävs kan jag faktureras på Mediagraf i Stockholm AB.');
    expect(out).toContain('Kommunen återkommer nästa vecka.');
    expect(out).toContain('delay_promise');
    expect(out).not.toContain('citerad svans'); // inbound bodies come from summaries, not raw text
  });

  it('inbound without stored analysis falls back to a 300-char body prefix', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    seedMsg({ gmailId: 'i1', body: 'X'.repeat(500), at: '2026-08-21T09:00:00Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('X'.repeat(300));
    expect(out).not.toContain('X'.repeat(301));
  });

  it('lists stored attachment filenames on prior messages and the trigger mail', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const m = seedMsg({ gmailId: 'i1', body: 'Här kommer avtalen.', at: '2026-08-19T14:15:00Z', analysis: { summary: 'Levererar avtal.' } });
    db.recordAttachment({ message_id: m, filename: 'NE Avtal.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const out = buildDraftContext(db, conv(), { attachments: [{ filename: 'Skolplus_avtal.pdf' }] });
    expect(out).toContain('NE Avtal.pdf');
    expect(out).toContain('# Bilagor i det inkommande mejlet');
    expect(out).toContain('Skolplus_avtal.pdf');
  });

  it('summarises extracted contracts with document_type', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const m = seedMsg({ gmailId: 'i1', body: 'Bifogat.', at: '2026-08-19T14:15:00Z' });
    const att = db.recordAttachment({ message_id: m, filename: 'oversikt.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const vendor = db.upsertVendor('NE');
    db.recordContract({ attachment_id: att, vendor_id: vendor.id, is_contract: 1, document_type: 'avtal', summary: 'Avtal med NE.' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('# Avtal vi redan extraherat');
    expect(out).toContain('NE');
    expect(out).toContain('avtal');
  });

  it('caps the log at 20 messages and says so', () => {
    for (let i = 0; i < 25; i++) {
      seedMsg({ dir: i % 2 ? 'inbound' : 'outbound', gmailId: `m${i}`, body: `msg${i}`, at: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z` });
    }
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('äldre meddelanden utelämnade');
    expect(out).not.toContain('msg3\n'); // an elided middle message
    expect(out).toContain('msg24');      // newest survives
  });
});
```


- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/draft-context.test.js` — FAIL (module missing).

- [ ] **Step 3: Implement `src/draft-context.js`:**

```js
// Conversation context for the reply-drafting LLM (2026-09-12 design).
// The model previously saw ONLY the incoming body; every generation-time
// failure in the 2026-09-12 queue review traced back to that gap: drafts
// claimed delivered avtal were missing, re-argued accepted fees, and sent
// "resends" without the request text. This block is appended to the USER
// message (never the cached system prompt).
//
// Runs BEFORE the trigger message is ingested (tick.js IO ordering), so
// db.listMessages returns exactly the prior thread; the trigger mail's
// attachments arrive as parsed metadata only.

const MAX_MESSAGES = 20;
const MAX_OUTBOUND_CHARS = 1500;
const MAX_INBOUND_CHARS = 300;

export function buildDraftContext(db, conv, parsed) {
  const msgs = db.listMessages(conv.id);
  const attRows = db.listAttachmentsForConversation?.(conv.id) ?? [];
  const attsByMsg = new Map();
  for (const a of attRows) {
    if (!attsByMsg.has(a.message_id)) attsByMsg.set(a.message_id, []);
    attsByMsg.get(a.message_id).push(a.filename);
  }

  const lines = [];

  const firstOutbound = msgs.find((m) => m.direction === 'outbound');
  lines.push('# Ursprunglig begäran (vårt första mejl, ordagrant)');
  lines.push((firstOutbound?.body_text ?? '(saknas)').trim());
  lines.push('');

  lines.push('# Tidigare korrespondens (äldst först)');
  const shown = msgs.slice(-MAX_MESSAGES);
  if (msgs.length > shown.length) {
    lines.push(`(${msgs.length - shown.length} äldre meddelanden utelämnade)`);
  }
  for (const m of shown) {
    const date = (m.received_at ?? '').slice(0, 10);
    const files = attsByMsg.get(m.id) ?? [];
    const fileNote = files.length ? ` [bilagor: ${files.join(', ')}]` : '';
    if (m.direction === 'outbound') {
      const body = (m.body_text ?? '').trim().slice(0, MAX_OUTBOUND_CHARS);
      lines.push(`## VI skrev (${date})${fileNote}`);
      lines.push(body);
    } else {
      let summary = null;
      try { summary = JSON.parse(m.analysis_json ?? 'null')?.summary ?? null; } catch { /* unparsable */ }
      const text = summary ?? (m.body_text ?? '').trim().slice(0, MAX_INBOUND_CHARS);
      lines.push(`## KOMMUNEN skrev (${date}, klassning: ${m.classification ?? 'okänd'})${fileNote}`);
      lines.push(text);
    }
    lines.push('');
  }

  lines.push('# Bilagor i det inkommande mejlet');
  const triggerFiles = (parsed?.attachments ?? []).map((a) => a.filename).filter(Boolean);
  lines.push(triggerFiles.length ? triggerFiles.map((f) => `- ${f}`).join('\n') : '(inga)');
  lines.push('');

  lines.push('# Avtal vi redan extraherat ur mottagna bilagor');
  const contracts = db.listContractInfoForConversation?.(conv.id) ?? [];
  lines.push(contracts.length
    ? contracts.map((c) => `- ${c.vendor_name ?? 'okänd leverantör'}: ${c.document_type ?? 'okänt dokument'}${c.is_contract ? '' : ' (EJ ett avtal)'}`).join('\n')
    : '(inga extraherade ännu)');

  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/draft-context.test.js`

- [ ] **Step 5: Commit:** `git add src/draft-context.js tests/draft-context.test.js && git commit -m "feat: buildDraftContext — thread/attachment/contract context for drafting"`

---

### Task 3: Prompt wiring + the three new drafting rules

**Files:**
- Modify: `src/analyse-message.js` (`userPromptFor` ~line 318; `buildSystemPrompt` SKRIVREGLER section ~line 100)
- Test: `tests/analyse-message.test.js` (append)

**Interfaces:**
- Consumes: nothing new at runtime — `ctx.thread_context` is an optional string.
- Produces: `analyseMessage(body, ctx, …)` accepts `ctx.thread_context`; when present it is appended to the user message under a labelled heading. System prompt carries SKRIVREGLER 3–5 verbatim (below).

- [ ] **Step 1: Write the failing tests** (append to `tests/analyse-message.test.js`, reusing its `fakeClientReturning` + `baseCtx`):

```js
describe('thread context (2026-09-12 design)', () => {
  it('appends ctx.thread_context to the user message after the incoming body', async () => {
    const client = fakeClientReturning({ intent: 'delivery', confidence: 0.9, summary: 's', extracted: {}, suggested_action: 'send_receipt', is_final_delivery: false, draft_reply: 'd', follow_up_at: null });
    await analyseMessage('Här kommer avtalen.', {
      ...baseCtx,
      thread_context: '# Ursprunglig begäran (vårt första mejl, ordagrant)\nBegärantext.',
    }, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    const call = client.messages.create.mock.calls[0][0];
    const user = call.messages[0].content;
    expect(user).toContain('Här kommer avtalen.');
    expect(user).toContain('# Konversationskontext');
    expect(user).toContain('Begärantext.');
    expect(user.indexOf('Här kommer avtalen.')).toBeLessThan(user.indexOf('Begärantext.'));
    // system prompt stays context-free so its cache_control keeps hitting
    expect(call.system[0].text).not.toContain('Begärantext.');
  });

  it('system prompt carries the three new drafting rules', async () => {
    const client = fakeClientReturning({ intent: 'auto_ack', confidence: 0.95, summary: 's', extracted: {}, suggested_action: 'wait', is_final_delivery: false, draft_reply: '', follow_up_at: null });
    await analyseMessage('Tack.', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    const sys = client.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toContain('Påstå ALDRIG att handlingar saknas');
    expect(sys).toContain('Upprepa ALDRIG en fråga');
    expect(sys).toContain('begäran aldrig nått dem');
  });
});
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/analyse-message.test.js -t "thread context"`

- [ ] **Step 3: Implement.** In `userPromptFor`, after the closing `---` line:

```js
  if (ctx.thread_context) {
    lines.push('');
    lines.push('# Konversationskontext (bakgrund; det inkommande svaret ovan är det du analyserar)');
    lines.push(ctx.thread_context);
  }
```

In `buildSystemPrompt`, extend the numbered SKRIVREGLER list (after rule 2) with, verbatim:

```
3. Påstå ALDRIG att handlingar saknas eller inte bifogats när konversationskontextens bilagelista visar mottagna filer. Bekräfta mottagna handlingar med filnamn eller leverantörsnamn. "Jag saknar X" får bara skrivas när X varken finns i bilagelistan eller bland redan extraherade avtal.
4. Upprepa ALDRIG en fråga som ett tidigare utgående mejl (se "VI skrev" i konversationskontexten) redan ställt, om inte kommunen lämnat den obesvarad. Omförhandla ALDRIG en avgift som ett tidigare utgående mejl accepterat eller som kommunen redan besvarat med ett motiverat nej: ett lämnat åtagande (accepterad avgift, lämnade faktureringsuppgifter) står fast.
5. Om kommunen uppger att vår begäran aldrig nått dem: draft_reply MÅSTE innehålla den ursprungliga begäran i sin helhet, kopierad ordagrant från "Ursprunglig begäran" i konversationskontexten. Aldrig en sammanfattning, aldrig bara "jag skickar den på nytt".
```

Add one few-shot example at the END of the `# Few-shot exempel` section (starts ~line 98; each example is `Inkommande:` quote + `Output:` JSON on one line, copy that exact shape):

```
Inkommande:
> Hej, vi kan tyvärr inte se att din begäran har kommit fram till oss. Vänligen skicka den på nytt så registrerar vi den.

Konversationskontext innehåller under "Ursprunglig begäran": "Hej,\n\nMed stöd av offentlighetsprincipen begär jag ut kommunens avtal för digitala läromedel och lärplattformar. [...]"

Output:
{"intent":"clarification","confidence":0.9,"summary":"Registratorn hittar inte begäran och ber oss skicka den igen.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"respond_by_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":["Skicka begäran på nytt"],"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"send_precision","is_final_delivery":false,"draft_reply":"Hej,\n\nTack för ditt svar. Här kommer begäran i sin helhet igen:\n\nMed stöd av offentlighetsprincipen begär jag ut kommunens avtal för digitala läromedel och lärplattformar. [...]\n\nMed vänlig hälsning\nGustaf Hård af Segerstad","follow_up_at":null}
```

(Task 6 adds `respond_by_date` to the schema; include it in this example's `extracted` now so the example stays valid once Task 6 lands — it is a plain prompt string, the schema does not validate examples.) The draft in the example must visibly copy the request text, not summarise it.

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/analyse-message.test.js`

- [ ] **Step 5: Commit:** `git add src/analyse-message.js tests/analyse-message.test.js && git commit -m "feat(analyse): thread context in user prompt + drafting rules 3-5"`

---

### Task 4: Tick wiring

**Files:**
- Modify: `src/tick.js` (`ingestMessage`, the `analyseMessage` call ~line 368; import at top)
- Test: `tests/tick-ingest.test.js` (append)

**Interfaces:**
- Consumes: `buildDraftContext(db, conv, parsed)` (Task 2), `ctx.thread_context` (Task 3).

- [ ] **Step 1: Write the failing test** (append to `tests/tick-ingest.test.js`, copying its harness for a matched inbound message; the file already uses `vi.spyOn(analyseMod, 'analyseMessage')`):

```js
describe('runTick — drafting LLM sees the thread (2026-09-12 design)', () => {
  it('passes thread_context with the original request and the attachment section to analyseMessage', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const convId = seedConv({ thread: 'thr-ctx' }); // SENT, gmail_thread_id thr-ctx
    db.recordMessage({
      conversation_id: convId, gmail_message_id: 'out-ctx-1', direction: 'outbound',
      from_email: 'gustaf.hard@gmail.com', to_email: 'kansli@ale.se', subject: 'Begäran om allmän handling',
      body_text: 'Hej,\n\nMed stöd av offentlighetsprincipen begär jag ut avtal för digitala läromedel.',
      received_at: '2026-06-10T10:00:00Z', attachment_count: 0,
    });
    const gmail = fakeGmail({
      listResult: [{ id: 'in-ctx-1' }],
      getResult: { 'in-ctx-1': mkMsg('in-ctx-1', 'thr-ctx', 'Registrator <registrator@ale.se>', 'Vi hittar inte din begäran, skicka den igen.') },
    });
    await runTick(deps({ gmail }));
    const ctx = spy.mock.calls[0][1];
    spy.mockRestore();
    expect(ctx.thread_context).toContain('# Ursprunglig begäran');
    expect(ctx.thread_context).toContain('begär jag ut avtal för digitala läromedel');
    expect(ctx.thread_context).toContain('# Bilagor i det inkommande mejlet');
    expect(ctx.thread_context).toContain('(inga)'); // text/plain fixture carries no attachments
  });
});
```

`seedConv`, `fakeGmail`, `mkMsg`, `deps` and `db` are the file's own top-level helpers (lines ~32–78); `db.recordMessage` is the same call `tests/storage.test.js` uses. The spy's second argument is the `ctx` object `ingestMessage` builds.

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/tick-ingest.test.js -t "thread context"`

- [ ] **Step 3: Implement.** In `src/tick.js`: `import { buildDraftContext } from './draft-context.js';` and change the call:

```js
  const analysis = await analyseMessage(parsed.body, {
    kommun_namn: conv.kommun_namn,
    role: conv.role,
    conversation_state: conv.state,
    days_since_last_outbound: daysSinceLastOutbound,
    today_iso: now.toISOString().slice(0, 10),
    thread_context: buildDraftContext(db, conv, parsed),
  }, { env });
```

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/tick-ingest.test.js` and `npx vitest run tests/tick.test.js` (regression).

- [ ] **Step 5: Commit:** `git add src/tick.js tests/tick-ingest.test.js && git commit -m "feat(tick): drafting LLM sees the conversation context"`

---

### Task 5: Regression tests named for the live failures (Malmö, Halmstad, Luleå)

**Files:**
- Test: `tests/draft-context.test.js` (append a describe block; add `analyseMessage` from `../src/analyse-message.js` and `vi` from vitest to the imports)

**Interfaces:**
- Consumes: `buildDraftContext` (Task 2), `analyseMessage(body, ctx, { env, client })` with `ctx.thread_context` (Task 3).
- Produces: nothing new; these tests pin what the model is SHOWN end-to-end (seeded DB → context → captured request), since model output cannot be asserted offline (spec §A "Tests").

- [ ] **Step 1: Write the three tests** (append to `tests/draft-context.test.js`; `seedMsg`, `conv`, `db` are the file's helpers from Task 2):

```js
function captureClient() {
  return { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ intent: 'unknown', confidence: 0.5, summary: 's', extracted: {}, suggested_action: 'escalate', is_final_delivery: false, draft_reply: 'd', follow_up_at: null }) }] })) } };
}
const baseCtx = { kommun_namn: 'Malmö', role: 'central', conversation_state: 'SENT', days_since_last_outbound: 3, today_iso: '2026-09-12' };
const env = { ANTHROPIC_API_KEY: 'k' };

describe('live-failure regressions (2026-09-12 queue review)', () => {
  it('malmö: prompt lists every stored attachment and carries rule 3 (never claim documents are missing)', async () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const m = seedMsg({ gmailId: 'i1', body: 'Bifogat finner ni avtalen.', at: '2026-08-19T14:15:00Z', cls: 'delivery', analysis: { summary: 'Levererar avtal.' } });
    const names = ['NE Avtal.pdf', 'Skolon.pdf', 'Gleerups.pdf', 'Clio.pdf', 'Binogi.pdf', 'Studi.pdf', 'Kunskapsmedia.pdf', 'Liber.pdf', 'Sanoma.pdf', 'Natur&Kultur.pdf', 'Magma.pdf'];
    for (const [i, f] of names.entries()) db.recordAttachment({ message_id: m, filename: f, saved_path: `/x/${i}.pdf`, mime_type: 'application/pdf', size_bytes: 10 });
    const client = captureClient();
    await analyseMessage('Har ni fått allt ni behöver?', { ...baseCtx, thread_context: buildDraftContext(db, conv(), { attachments: [] }) }, { env, client });
    const call = client.messages.create.mock.calls[0][0];
    const user = call.messages[0].content;
    for (const f of names) expect(user).toContain(f);
    expect(call.system[0].text).toContain('Påstå ALDRIG att handlingar saknas');
  });

  it('halmstad: our prior outbound with invoice details appears verbatim and rule 4 is present', async () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-05T09:00:00Z' });
    seedMsg({ gmailId: 'i1', body: 'Avgift 4 kr/sida tillkommer. Faktureringsuppgifter?', at: '2026-08-10T09:00:00Z', cls: 'fee_demand', analysis: { summary: 'Kräver avgift och faktureringsuppgifter.' } });
    const invoice = 'Vi accepterar avgiften. Fakturera Mediagraf i Stockholm AB, org.nr 559000-0000, Box 1, 111 11 Stockholm.';
    seedMsg({ dir: 'outbound', gmailId: 'o2', body: invoice, at: '2026-08-11T09:00:00Z' });
    const client = captureClient();
    await analyseMessage('Vi behöver era faktureringsuppgifter innan vi kan lämna ut.', { ...baseCtx, kommun_namn: 'Halmstad', thread_context: buildDraftContext(db, conv(), { attachments: [] }) }, { env, client });
    const call = client.messages.create.mock.calls[0][0];
    expect(call.messages[0].content).toContain(invoice);
    expect(call.system[0].text).toContain('Upprepa ALDRIG en fråga');
    expect(call.system[0].text).toContain('står fast');
  });

  it('luleå: the full original request sits under Ursprunglig begäran and rule 5 is present', async () => {
    const request = 'Hej,\n\nMed stöd av offentlighetsprincipen begär jag ut kommunens avtal för digitala läromedel och lärplattformar.\n\nMed vänlig hälsning\nGustaf';
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: request, at: '2026-08-17T14:45:24Z' });
    const client = captureClient();
    await analyseMessage('Vi kan inte se att din begäran kommit fram. Skicka den på nytt.', { ...baseCtx, kommun_namn: 'Luleå', thread_context: buildDraftContext(db, conv(), { attachments: [] }) }, { env, client });
    const call = client.messages.create.mock.calls[0][0];
    const user = call.messages[0].content;
    expect(user).toContain('# Ursprunglig begäran');
    expect(user).toContain(request);
    expect(call.system[0].text).toContain('begäran aldrig nått dem');
  });
});
```

- [ ] **Step 2: Run:** `npx vitest run tests/draft-context.test.js -t "live-failure"` — all three PASS immediately if Tasks 2–3 are correct; a failure here means a Task 2/3 gap, fix THERE (these tests are the spec's regression contract, do not loosen them).

- [ ] **Step 3: Commit:** `git add tests/draft-context.test.js && git commit -m "test: regression tests for the Malmö/Halmstad/Luleå draft failures"`

---

### Task 6: respond_by_date extraction (package B)

**Files:**
- Modify: `src/analyse-message.js` (ANALYSIS_SCHEMA `extracted`; prompt section + few-shot; new `normaliseRespondBy` applied next to `normaliseDelayAnalysis` at line ~372)
- Test: `tests/analyse-message.test.js` (append)

**Interfaces:**
- Produces: `analysis.extracted.respond_by_date` (ISO string | null) on every analysis; exported `normaliseRespondBy(analysis, todayIso)` nulls non-ISO values and dates more than one day before `todayIso` (spec §B: "ISO validity, not in the past by more than a day").

- [ ] **Step 1: Write the failing tests:**

```js
describe('respond_by_date (2026-09-12 design)', () => {
  it('survives the schema round-trip and normalisation', async () => {
    const expected = { intent: 'unknown', confidence: 0.95, summary: 'Komplettering krävs inom 7 dagar.', extracted: { arendenummer: 'KC-1', promised_response_days: null, promised_response_date: null, respond_by_date: '2026-09-02', handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null, reseller_relations: null }, suggested_action: 'escalate', is_final_delivery: false, draft_reply: 'd', follow_up_at: null };
    const r = await analyseMessage('Svara inom 7 dagar annars stängs ärendet.', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client: fakeClientReturning(expected) });
    expect(r.extracted.respond_by_date).toBe('2026-09-02');
  });
  it('normaliseRespondBy nulls a non-ISO value', () => {
    const a = { extracted: { respond_by_date: 'nästa vecka' } };
    expect(normaliseRespondBy(a, '2026-09-12').extracted.respond_by_date).toBeNull();
  });
  it('normaliseRespondBy nulls a deadline more than a day in the past (hallucinated or stale), keeps yesterday and today', () => {
    expect(normaliseRespondBy({ extracted: { respond_by_date: '2026-09-01' } }, '2026-09-12').extracted.respond_by_date).toBeNull();
    expect(normaliseRespondBy({ extracted: { respond_by_date: '2026-09-11' } }, '2026-09-12').extracted.respond_by_date).toBe('2026-09-11');
    expect(normaliseRespondBy({ extracted: { respond_by_date: '2026-09-19' } }, '2026-09-12').extracted.respond_by_date).toBe('2026-09-19');
  });
  it('normaliseRespondBy tolerates a missing extracted block', () => {
    expect(normaliseRespondBy({ intent: 'unknown' }, '2026-09-12').intent).toBe('unknown');
  });
  it('schema stays at 10 union-typed params', () => {
    // count anyOf occurrences — the 16-limit guard from memory
    const json = JSON.stringify(ANALYSIS_SCHEMA);
    expect((json.match(/"anyOf"/g) ?? []).length).toBe(10);
  });
});
```

(`ANALYSIS_SCHEMA` and `normaliseRespondBy` must be exported; ANALYSIS_SCHEMA is currently module-private — export it.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Schema: add to `extracted.required` and `properties`: `respond_by_date: { anyOf: [{ type: 'string' }, { type: 'null' }] }`. Prompt: new short section after `# follow_up_at`:

```
# respond_by_date

ISO-datum (YYYY-MM-DD) när KOMMUNEN kräver svar av OSS ("svara inom 7 dagar annars stängs ärendet", "återkom senast 2026-09-02 med faktureringsuppgifter"). Skilj från promised_response_date (kommunens löfte till oss). Anges dagar: räkna från Dagens datum. null när ingen frist ställs.
```

Plus one few-shot (komplettering with "Svara på detta mejl inom 7 dagar annars stängs ditt ärende", Dagens datum in ctx, output carries the computed ISO date). Implementation:

```js
// Kommun-imposed reply deadline (2026-09-12 design). Fails closed: anything
// that is not a real ISO date, or lies more than a day behind today (a
// hallucinated or already-expired frist), becomes null rather than sorting
// the queue on garbage. Yesterday is kept: a deadline that expired overnight
// is exactly what the operator must see first.
export function normaliseRespondBy(analysis, todayIso) {
  const ex = analysis?.extracted;
  if (!ex || ex.respond_by_date == null) return analysis;
  const v = ex.respond_by_date;
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) { ex.respond_by_date = null; return analysis; }
  const floor = todayIso && ISO_DATE_RE.test(todayIso) ? addDaysIso(todayIso, -1) : null;
  if (floor && v < floor) ex.respond_by_date = null;
  return analysis;
}
```

(`addDaysIso` and `ISO_DATE_RE` already live in this module, lines ~223–227.) Apply at the parse site (line ~372): `return normaliseRespondBy(normaliseDelayAnalysis(parsed, ctx.today_iso), ctx.today_iso);`

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/analyse-message.test.js`

- [ ] **Step 5: Commit:** `git add src/analyse-message.js tests/analyse-message.test.js && git commit -m "feat(analyse): extract kommun-imposed respond_by_date"`

---

### Task 7: Persist respond_by on escalations + Slack line

**Files:**
- Modify: `src/storage.js` (SCHEMA escalations table + migrate() probe + `recordEscalation`)
- Modify: `src/tick.js` (`escalateWithDraft` signature ~line 159 and its `recordEscalation` call ~line 226; the inbound call site ~line 824 passing `llmDraft`; the `buildEscalationBlocks` call in `escalateWithDraft`'s Slack-post section)
- Modify: `src/slack.js` (`buildEscalationBlocks` ~line 8)
- Test: `tests/storage.test.js`, `tests/slack.test.js` (append)

**Interfaces:**
- Produces: `escalations.respond_by TEXT` column; `recordEscalation({ …, respond_by })`; `escalateWithDraft({ …, respondBy })`; `buildEscalationBlocks({ …, respond_by })`.

- [ ] **Step 1: Write the failing tests.** storage.test.js:

```js
it('recordEscalation persists respond_by and migrate() adds the column to old DBs', () => {
  const convId = db.createConversation({ kommun_kod: '0580', kommun_namn: 'Linköping', role: 'central', contact_email: 'k@linkoping.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
  const id = db.recordEscalation({ conversation_id: convId, reason: 'fee_demand', respond_by: '2026-09-02' });
  expect(db.raw.prepare('SELECT respond_by FROM escalations WHERE id = ?').get(id).respond_by).toBe('2026-09-02');
});
```

slack.test.js:

```js
it('buildEscalationBlocks renders a deadline line when respond_by is set', () => {
  const blocks = buildEscalationBlocks({ escalation_id: 1, kommun_namn: 'Linköping', from_email: 'k@l.se', reply_text: 't', draft_reply: 'd', gmail_thread_id: 'g', respond_by: '2026-09-02' });
  const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
  expect(texts).toContain('⏰');
  expect(texts).toContain('2026-09-02');
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  - SCHEMA: add `respond_by TEXT,` to the escalations CREATE TABLE (before `created_at`). Migrate probe (mirrors the heartbeat pattern):

```js
    const escCols = db.prepare("PRAGMA table_info(escalations)").all().map((r) => r.name);
    // Kommun-imposed reply deadline (2026-09-12 design) — sorts the queue and
    // feeds the daily hygiene digest. NULL = no deadline stated.
    if (!escCols.includes('respond_by')) {
      db.exec('ALTER TABLE escalations ADD COLUMN respond_by TEXT');
    }
```

  - `recordEscalation`: add `respond_by` to the column list and `e.respond_by ?? null` to the values.
  - `escalateWithDraft`: add param `respondBy = null`; pass `respond_by: respondBy` to `db.recordEscalation`; pass `respond_by: respondBy` into the `buildEscalationBlocks` call.
  - Inbound call site (tick.js ~line 824): add `respondBy: analysis?.extracted?.respond_by_date ?? null,`. All other `escalateWithDraft` call sites keep the default null.
  - `buildEscalationBlocks`: add `respond_by = null` param; after the watchlist block:

```js
  if (respond_by) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⏰ *Kommunens svarsfrist:* ${respond_by}. Skickas inget innan dess kan kommunen stänga ärendet.` } });
  }
```

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/storage.test.js tests/slack.test.js tests/tick-ingest.test.js`

- [ ] **Step 5: Commit:** `git add src/storage.js src/tick.js src/slack.js tests/storage.test.js tests/slack.test.js && git commit -m "feat: persist and surface kommun reply deadlines on escalations"`

---

### Task 8: Deadline-first queue sorting + dashboard badge

**Files:**
- Modify: `src/dashboard.js` (`buildActionQueue` ~line 427: include `respond_by` in rows, new sort)
- Modify: `src/dashboard-views.js` (actionQueue map ~line 1027)
- Test: `tests/dashboard.test.js` (append near the existing `buildActionQueue` tests ~line 768)

**Interfaces:**
- Produces: action-queue rows carry `respond_by` (string | null); deadline rows sort first, soonest first; handoff rows (no respond_by) unaffected. Queue rows ≥7 days old render with class `q-age-old` (red).

- [ ] **Step 1: Write the failing test:**

```js
it('buildActionQueue sorts deadline-bearing escalations first, soonest first', () => {
  const a = seedConvWithOpenEscalation({ kommun: 'Aneby' });                       // helper pattern from the test above
  const b = seedConvWithOpenEscalation({ kommun: 'Boden', respond_by: '2026-09-20' });
  const c = seedConvWithOpenEscalation({ kommun: 'Cala', respond_by: '2026-09-14' });
  const q = buildActionQueue(db);
  expect(q.map((r) => r.kommun_namn).slice(0, 2)).toEqual(['Cala', 'Boden']);
  expect(q.find((r) => r.kommun_namn === 'Aneby').respond_by).toBeNull();
});
```

(Write `seedConvWithOpenEscalation` in this test file if absent: createConversation + recordEscalation with the given respond_by, state left at INITIAL is fine since an open escalation alone queues it.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `buildActionQueue`, the escalation branch adds `respond_by: openEsc[0]?.respond_by ?? null` to the pushed row (handoff rows get `respond_by: null`). Replace the final sort:

```js
  return out.sort((a, b) => {
    if (a.respond_by && b.respond_by) return a.respond_by.localeCompare(b.respond_by) || (a.since ?? '').localeCompare(b.since ?? '');
    if (a.respond_by) return -1;
    if (b.respond_by) return 1;
    return (a.since ?? '').localeCompare(b.since ?? '');
  });
```

In `dashboard-views.js`, change the actionQueue map callback to:

```js
queueRow(a, `<span class="q-action">${a.respond_by ? `<span class="q-deadline">⏰ senast ${escapeHtml(a.respond_by)}</span> · ` : ''}${escapeHtml(a.action)}</span>`)
```

and make `queueRow` colour the age red at ≥7 days (spec §C "each row additionally shows age in days, red at ≥7"); `fmtAgo` already renders the age text, so only the class changes:

```js
  const AGE_RED_MS = 7 * 86400000;
  const isOld = (iso) => iso && (Date.now() - new Date(iso).getTime()) >= AGE_RED_MS;
  const queueRow = (item, badgeHtml) => `<a class="queue-row" data-pane-link href="/arenden/${item.conv_id}">
      <span class="q-kommun">${escapeHtml(item.kommun_namn)} <span class="muted">· ${escapeHtml(item.role)}</span></span>
      <span class="q-mid">${badgeHtml}</span>
      <span class="q-age ${isOld(item.since) ? 'q-age-old' : 'muted'}" title="${escapeHtml(item.since ?? '')}">${escapeHtml(fmtAgo(item.since))}</span>
    </a>`;
```

Add to the inline stylesheet next to the existing `.q-age` rule: `.q-age-old { color: var(--bad); font-weight: 600; } .q-deadline { color: var(--bad); font-weight: 600; }` (`--bad` is the existing red token used by `.stat-card .value.bad`, line ~348). `queueRow` is also used by the Väntar list; an old waiting case turning red is intended (same "silence let it age" problem).

Dashboard test for the red age (append to the same describe as the sort test):

```js
it('renders a ≥7-day-old Behöver dig row with the q-age-old class', async () => {
  const cid = db.createConversation({ kommun_kod: '0580', kommun_namn: 'Linköping', role: 'central', contact_email: 'k@l.se', scheduled_send_at: '2026-05-24T10:00:00Z' });
  db.updateConversationState(cid, 'SENT', { last_outbound_at: '2026-01-01T00:00:00Z' });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run('2026-01-01T00:00:00Z', cid);
  db.recordEscalation({ conversation_id: cid, reason: 'x', draft_template: 'free_form', draft_body: 'b' });
  const res = await get(appWithFakes(), '/');
  expect(res.text).toContain('q-age-old');
});
```

(`get` and `appWithFakes` are this test file's existing helpers, see the `/app.js` test ~line 761.)

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/dashboard.test.js`

- [ ] **Step 5: Commit:** `git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js && git commit -m "feat(dashboard): deadline-first Behöver dig ordering, ⏰ badge, red age at 7 days"`

---

### Task 9: Queue-hygiene queries + daily digest (package C)

**Files:**
- Modify: `src/storage.js` (three read-only queries, exported on db)
- Modify: `src/tick.js` (`runDailyFollowup`, immediately after the hänvisning nag digest block ~line 1674)
- Test: `tests/storage.test.js`, `tests/tick-followup.test.js` (append; reuse the `deps({ slackOps, now })` + `fakeSlackOps()` harness of the "hänvisning nag digest" describe at line 614)

**Interfaces:**
- Produces:
  - `db.listOpenEscalationsAgedDays(days)` → `[{ id, conversation_id, created_at, respond_by, kommun_namn, role }]`
  - `db.listOpenEscalationsWithDeadlineDue(byIsoDate)` → same shape, `respond_by <= byIsoDate`
  - `db.listOrphanNeedsHuman()` → `[{ id, kommun_namn, role, state_changed_at }]`

- [ ] **Step 1: Write the failing storage tests:**

```js
describe('queue hygiene queries (2026-09-12 design)', () => {
  it('aged, deadline-due, and orphan queries each find their case', () => {
    const convA = db.createConversation({ kommun_kod: '0001', kommun_namn: 'Gammal', role: 'central', contact_email: 'a@a.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    const escA = db.recordEscalation({ conversation_id: convA, reason: 'r' });
    db.raw.prepare("UPDATE escalations SET created_at = datetime('now', '-9 days') WHERE id = ?").run(escA);
    const convB = db.createConversation({ kommun_kod: '0002', kommun_namn: 'Frist', role: 'central', contact_email: 'b@b.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.recordEscalation({ conversation_id: convB, reason: 'r', respond_by: '2026-09-13' });
    const convC = db.createConversation({ kommun_kod: '0003', kommun_namn: 'Föräldralös', role: 'central', contact_email: 'c@c.se', scheduled_send_at: '2026-08-01T08:00:00Z' });
    db.updateConversationState(convC, 'NEEDS_HUMAN', {});

    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).toContain('Gammal');
    expect(db.listOpenEscalationsAgedDays(7).map((e) => e.kommun_namn)).not.toContain('Frist');
    expect(db.listOpenEscalationsWithDeadlineDue('2026-09-14').map((e) => e.kommun_namn)).toEqual(['Frist']);
    const orphans = db.listOrphanNeedsHuman().map((c) => c.kommun_namn);
    expect(orphans).toContain('Föräldralös');
    expect(orphans).not.toContain('Gammal'); // has an open escalation
  });
});
```

And the failing digest test in `tests/tick-followup.test.js`:

```js
describe('queue hygiene digest (2026-09-12 design)', () => {
  it('posts one digest naming due deadlines, aged drafts, and orphaned NEEDS_HUMAN', async () => {
    const now = new Date('2026-09-12T09:00:00Z');
    const mk = (kod, namn) => db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: `k@${kod}.se`, scheduled_send_at: '2026-08-01T08:00:00Z' });
    const convA = mk('0001', 'Gammal');
    const escA = db.recordEscalation({ conversation_id: convA, reason: 'r', draft_template: 'free_form', draft_body: 'b' });
    // created_at is stored as 'YYYY-MM-DD HH:MM:SS' (sqlite datetime('now')); seed 9 days before the run's `now`
    // so the "(9 d)" label is stable regardless of the wall clock. listOpenEscalationsAgedDays compares
    // against sqlite's real now, so 2026-09-03 is also comfortably older than 7 days on any later date.
    db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run(new Date(now.getTime() - 9 * 86400000).toISOString().replace('T', ' ').slice(0, 19), escA);
    const convB = mk('0002', 'Frist');
    db.recordEscalation({ conversation_id: convB, reason: 'r', draft_template: 'free_form', draft_body: 'b', respond_by: '2026-09-13' });
    const convC = mk('0003', 'Föräldralös');
    db.updateConversationState(convC, 'NEEDS_HUMAN', {});
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now }));
    const digest = slackOps.alerts.find((t) => t.includes('Köhälsa'));
    expect(digest).toBeTruthy();
    expect(digest).toContain('⏰');
    expect(digest).toContain('🕰');
    expect(digest).toContain('🧭');
    expect(digest).toContain('Frist (senast 2026-09-13)');
    expect(digest).toContain('Gammal (9 d)');
    expect(digest).toContain('Föräldralös');
  });
  it('posts nothing when the queue is healthy', async () => {
    const slackOps = fakeSlackOps();
    await runDailyFollowup(deps({ slackOps, now: new Date('2026-09-12T09:00:00Z') }));
    expect(slackOps.alerts.find((t) => t.includes('Köhälsa'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** Storage:

```js
  function listOpenEscalationsAgedDays(days) {
    return db.prepare(`
      SELECT e.id, e.conversation_id, e.created_at, e.respond_by, c.kommun_namn, c.role
      FROM escalations e JOIN conversations c ON c.id = e.conversation_id
      WHERE e.status = 'open' AND e.created_at <= datetime('now', ?)
      ORDER BY e.created_at
    `).all(`-${Math.floor(days)} days`);
  }
  function listOpenEscalationsWithDeadlineDue(byIsoDate) {
    return db.prepare(`
      SELECT e.id, e.conversation_id, e.created_at, e.respond_by, c.kommun_namn, c.role
      FROM escalations e JOIN conversations c ON c.id = e.conversation_id
      WHERE e.status = 'open' AND e.respond_by IS NOT NULL AND e.respond_by <= ?
      ORDER BY e.respond_by
    `).all(byIsoDate);
  }
  // NEEDS_HUMAN with nothing actionable: no open escalation AND no pending
  // handoff task. The void path in tick.js legitimately produces this state
  // (kommun replied after a draft, reply warranted no new draft) — the digest
  // is what stops it from being invisible (Karlstad/Avesta, 2026-09-12 review).
  function listOrphanNeedsHuman() {
    return db.prepare(`
      SELECT c.id, c.kommun_namn, c.role, c.state_changed_at
      FROM conversations c
      WHERE c.state = 'NEEDS_HUMAN'
        AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.conversation_id = c.id AND e.status = 'open')
        AND NOT EXISTS (SELECT 1 FROM handoff_tasks t WHERE t.kommun_kod = c.kommun_kod AND t.status = 'pending')
      ORDER BY c.state_changed_at
    `).all();
  }
```

tick.js, after the hänvisning nag digest `try/catch`, same pattern (Gmail-free, DB-read-only, no dedupe marker needed — content is idempotent and daily cadence is the intent):

```js
  // Queue-hygiene digest (2026-09-12 design): due/overdue reply deadlines,
  // open drafts older than 7 days, and NEEDS_HUMAN cases with nothing
  // actionable. Read-only; posts at most one Slack message per run.
  try {
    const todayIso = now.toISOString().slice(0, 10);
    const due = db.listOpenEscalationsWithDeadlineDue?.(addDaysIso(todayIso, 2)) ?? [];
    const dueIds = new Set(due.map((e) => e.id));
    const aged = (db.listOpenEscalationsAgedDays?.(7) ?? []).filter((e) => !dueIds.has(e.id));
    const orphans = db.listOrphanNeedsHuman?.() ?? [];
    if ((due.length > 0 || aged.length > 0 || orphans.length > 0) && deps.slackOps?.postAlert && deps.env?.SLACK_CHANNEL_ID) {
      const ageDays = (iso) => Math.floor((now.getTime() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 86400000);
      const parts = [];
      if (due.length > 0) parts.push(`⏰ *Svarsfrist inom 2 dagar eller passerad:* ${due.map((e) => `${e.kommun_namn} (senast ${e.respond_by})`).join(', ')}`);
      if (aged.length > 0) {
        const top = aged.slice(0, 10).map((e) => `${e.kommun_namn} (${ageDays(e.created_at)} d)`).join(', ');
        parts.push(`🕰 *Öppna utkast äldre än 7 dagar:* ${aged.length} st: ${top}${aged.length > 10 ? ', …' : ''}`);
      }
      if (orphans.length > 0) parts.push(`🧭 *Behöver dig utan utkast:* ${orphans.map((c) => c.kommun_namn).join(', ')}`);
      await deps.slackOps.postAlert(deps.slackClient, {
        channel: deps.env.SLACK_CHANNEL_ID,
        text: `🧹 *Köhälsa:*\n${parts.join('\n')}`,
      });
      log?.(`QUEUE HYGIENE digest posted (${due.length} due, ${aged.length} aged, ${orphans.length} orphaned)`);
    }
  } catch (e) {
    log?.(`queue hygiene digest failed: ${e.message} — will retry on a later run`);
  }
```

(`addDaysIso` is already imported in tick.js from analyse-message.js, line 17. The block goes right after the hänvisning nag `try/catch` that ends ~line 1675 and before `db.markFollowupCompleted(...)`. `now` is `runDailyFollowup`'s `now` from deps. `db.recordEscalation` gains `respond_by` in Task 7, so Task 7 must land first.)

- [ ] **Step 4: Run to verify pass:** `npx vitest run tests/storage.test.js tests/tick-followup.test.js`

- [ ] **Step 5: Commit:** `git add src/storage.js src/tick.js tests/storage.test.js tests/tick-followup.test.js && git commit -m "feat(followup): daily queue-hygiene digest (deadlines, aging, orphans)"`

---

### Task 10: Full-suite verification + docs

**Files:**
- Modify: `CLAUDE.md` (pilot architecture notes)

- [ ] **Step 1: Run the full suite:** `npm test` — all ~1100 tests green (suite was 1094 tests / 69 files on 2026-07-31). Fix anything the integration surfaced (most likely: existing analyse-message prompt-snapshot assertions that now see the new rules — update those fixtures per the "update the fixture first" convention).

- [ ] **Step 2: Update CLAUDE.md.** In the pilot architecture tree add one line under `src/analyse-message.js`: `src/draft-context.js — thread/attachment/contract context for the drafting prompt (2026-09-12); the draft LLM must never see less than the operator does`. In the conventions section note that `escalations.respond_by` is the kommun-imposed deadline and sorts Behöver dig.

- [ ] **Step 3: Commit:** `git add CLAUDE.md && git commit -m "docs: draft-context module and respond_by convention"`

- [ ] **Step 4: Report.** Deployment is a separate, operator-gated step: `AWS_PROFILE=personal ./deploy/deploy.sh`, one restart, then watch the next tick's log for `thread_context` being passed and the 09:00 follow-up run for the first hygiene digest.

---

## Self-review notes

- Spec §A context block items 1–4 → Tasks 2 (builder) + 4 (wiring); §A rules + rule-5 few-shot → Task 3; §A's three named regression tests (malmö/halmstad/luleå) → Task 5 (offline tests pin what the model SEES, not what it says).
- Spec §B extraction incl. the "not in the past by more than a day" guard → Task 6; storage/surfacing → Tasks 7–8; §B "due alerting rides C" → Task 9.
- Spec §C digest → Task 9; dashboard age-in-days red at ≥7 → Task 8 (`q-age-old`).
- 2026-09-13 revision: verified every referenced function/line against the tree at `0d4803d` (recordContract takes vendor_id; state setter is `updateConversationState`; `addDaysIso`/`ISO_DATE_RE` exist in analyse-message.js; `handoff_tasks.kommun_kod` exists; tick-ingest harness helpers are `seedConv`/`fakeGmail`/`mkMsg`/`deps`).
- Out of scope guarded: no auto-send changes, no approve-time guards, no FSM changes, no re-drafting of the existing backlog.
