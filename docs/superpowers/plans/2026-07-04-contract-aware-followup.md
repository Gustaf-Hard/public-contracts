# Contract-Aware Follow-Up Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the delivery follow-up reply reflect what the attachments actually contain — request the specific missing avtal instead of blindly thanking "för avtalen."

**Architecture:** Approach A (analyze-then-draft in one tick). The PDF analyzer gains `document_type` + `mentioned_agreements`. When an inbound classifies as a delivery, the tick analyzes that message's attachments inline, computes `received` (is_contract=1 vendors) vs `missing` (mentioned agreements with `doc_attached=false`, minus received), and picks `T_RECEIPT` (missing empty) or a new `T_REQUEST_MISSING` (missing non-empty, overriding the PDF-blind LLM draft).

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest. LLM via `@anthropic-ai/sdk` (injected/stubbed in tests). No build step.

## Global Constraints

- Node ESM only (`import`/`export`), Node 20+. No TypeScript.
- No auto-sending. The follow-up stays a human-approved escalation draft. This changes only which template/body is drafted.
- No conversation FSM change. Delivery still transitions to `DELIVERING`.
- No DB migration. `mentioned_agreements` + `document_type` live inside the existing `contracts.analysis_json` (a följebrev already produces a row with `is_contract=0`).
- `received` is scoped to the CURRENT message's attachments (the reply acknowledges what came in this delivery).
- Dedup vendor names case-insensitively; a vendor in both received and mentioned is NOT asked for.
- Tests fully offline: stubbed Anthropic client (`{ messages: { create } }`), fake gmail (`gmailOps`), `:memory:` db. No real network.
- Every commit message ends with the trailer (exactly):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Full suite: `npm test`. Single file: `npx vitest run tests/<name>.test.js`.

## File Structure

- `src/analyse-contract.js` — MODIFY: `SYSTEM_PROMPT` (document_type rules, reinforce följebrev→false, mentioned_agreements), `CONTRACT_SCHEMA` (2 new fields), and `analysePendingContracts` (new `onlyMessageId` filter).
- `src/templates.js` — MODIFY: add `T_REQUEST_MISSING(ctx)` template, and pure helpers `computeReceivedMissing(rows)` + `chooseDeliveryReply({received,missing})`.
- `src/storage.js` — MODIFY: add + export `listContractInfoForMessage(messageId)`.
- `src/tick.js` — MODIFY: import `T_REQUEST_MISSING` (into `TEMPLATES`), `computeReceivedMissing`, `chooseDeliveryReply`; `tplCtx` passes `received`/`missing`; `escalateWithDraft` gains a `templateCtx` param; delivery branch analyzes inline and overrides the draft when avtal are missing.
- Tests: `tests/analyse-contract.test.js`, `tests/templates.test.js`, `tests/storage.test.js`, `tests/tick.test.js` — MODIFY.

---

## Task 1: Analyzer — document_type + mentioned_agreements

**Files:**
- Modify: `src/analyse-contract.js` (SYSTEM_PROMPT ~15-28, CONTRACT_SCHEMA ~30-45)
- Test: `tests/analyse-contract.test.js`

**Interfaces:**
- Produces: `analyseContractPdf(...)` return object now also carries `document_type: 'avtal'|'följebrev_sammanställning'|'prislista'|'sekretessbeslut'|'övrigt'` and `mentioned_agreements: Array<{vendor: string, product: string|null, doc_attached: boolean}>`. `storeContractAnalysis` already persists the whole analysis object into `analysis_json` — no change needed there.

- [ ] **Step 1: Write the failing test**

Add to `tests/analyse-contract.test.js` (reuse its `fakeClientReturning`, `pdf`, `ctx`):

```javascript
describe('analyseContractPdf — document_type + mentioned_agreements', () => {
  it('returns document_type and mentioned_agreements when the model provides them', async () => {
    const letter = {
      is_contract: false, document_type: 'följebrev_sammanställning',
      vendor_name: null, products: [], avtalsvarde: null, valuta: null,
      period_start: null, period_end: null, summary: 'Följebrev som listar avtal.',
      confidence: 0.9,
      mentioned_agreements: [
        { vendor: 'Quiculum', product: 'Quiculum', doc_attached: false },
        { vendor: 'Teachiq', product: 'Exam.net', doc_attached: false },
      ],
    };
    const client = fakeClientReturning(letter);
    const result = await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(result.document_type).toBe('följebrev_sammanställning');
    expect(result.is_contract).toBe(false);
    expect(result.mentioned_agreements.map((m) => m.vendor)).toEqual(['Quiculum', 'Teachiq']);
    expect(result.mentioned_agreements.every((m) => m.doc_attached === false)).toBe(true);
    // The request schema advertises the new fields as required.
    const schema = client.messages.create.mock.calls[0][0].output_config.format.schema;
    expect(schema.required).toContain('document_type');
    expect(schema.required).toContain('mentioned_agreements');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/analyse-contract.test.js -t "document_type"`
Expected: FAIL — schema.required lacks the new fields (and result may drop them).

- [ ] **Step 3: Extend the schema**

In `src/analyse-contract.js`, replace `CONTRACT_SCHEMA` (lines 30-45) with:

```javascript
const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_contract', 'document_type', 'vendor_name', 'products', 'avtalsvarde', 'valuta', 'period_start', 'period_end', 'summary', 'confidence', 'mentioned_agreements'],
  properties: {
    is_contract: { type: 'boolean' },
    document_type: { type: 'string', enum: ['avtal', 'följebrev_sammanställning', 'prislista', 'sekretessbeslut', 'övrigt'] },
    vendor_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    products: { type: 'array', items: { type: 'string' } },
    avtalsvarde: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    valuta: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    summary: { type: 'string' },
    confidence: { type: 'number' },
    mentioned_agreements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vendor', 'product', 'doc_attached'],
        properties: {
          vendor: { type: 'string' },
          product: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          doc_attached: { type: 'boolean' },
        },
      },
    },
  },
};
```

- [ ] **Step 4: Tighten the prompt**

In `src/analyse-contract.js`, replace `SYSTEM_PROMPT` (lines 15-28) with:

```javascript
const SYSTEM_PROMPT = `Du analyserar PDF:er som svenska kommuner lämnat ut efter en begäran om allmänna handlingar om digitala verktyg i utbildningsförvaltningen.

Din uppgift: avgör dokumentets typ, om det är ett avtal, och extrahera strukturerade fält.

Regler:
- document_type: "avtal" för avtal/kontrakt/ramavtal/underskrivna beställningar. "följebrev_sammanställning" för svarsbrev eller tabeller som RÄKNAR UPP avtal/leverantörer utan att själva innehålla avtalstexten (t.ex. "Svar på begäran om allmän handling" med en tabell över leverantörer och kostnader). "prislista", "sekretessbeslut" eller "övrigt" för annat.
- is_contract: true ENDAST när document_type = "avtal". false för följebrev_sammanställning, prislista, sekretessbeslut och övrigt. Ett brev som hänvisar till "bifogat avtal" är INTE självt ett avtal.
- vendor_name: leverantörens kanoniska företagsnamn utan bolagsform — "Skolon", inte "Skolon AB". null om oklart.
- products: namngivna produkter/tjänster som avtalet omfattar. Tom array om inga kan identifieras.
- avtalsvarde: avtalets värde eller årskostnad som text (t.ex. "120 000 kr/år"). null om det inte framgår.
- valuta: "SEK" etc. null om det inte framgår.
- period_start / period_end: avtalstidens start- och slutdatum som ISO-datum (YYYY-MM-DD). null om det inte framgår. Vid automatisk förlängning: använd innevarande periods slutdatum.
- summary: 1-2 meningar på svenska om vad dokumentet gäller.
- mentioned_agreements: lista de avtal/leverantörer som dokumentet NÄMNER, med { vendor, product, doc_attached }. doc_attached = true endast om själva avtalshandlingen finns i DETTA dokument; false när dokumentet bara refererar till eller sammanställer avtalet utan att innehålla det. Tom array om inga nämns.
- confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker.
- Svara ENBART med JSON som matchar schemat.`;
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/analyse-contract.test.js`
Expected: PASS (new test + existing — existing GOOD fixtures may need the two new fields; if an existing test's canned object lacks `document_type`/`mentioned_agreements`, add `document_type: 'avtal', mentioned_agreements: []` to that fixture so it matches the new schema shape).

- [ ] **Step 6: Commit**

```bash
git add src/analyse-contract.js tests/analyse-contract.test.js
git commit -m "feat(analyse-contract): document_type + mentioned_agreements; följebrev is_contract=false

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure helpers + T_REQUEST_MISSING template

**Files:**
- Modify: `src/templates.js` (add near the other templates)
- Test: `tests/templates.test.js`

**Interfaces:**
- Produces:
  - `computeReceivedMissing(rows)` where each row is `{ is_contract: 0|1, vendor_name: string|null, analysis_json: string|object|null }` → `{ received: string[], missing: string[] }`. `received` = distinct `vendor_name` of rows with `is_contract` truthy. `missing` = distinct `vendor` across all rows' `analysis_json.mentioned_agreements` with `doc_attached === false`, excluding any already in `received`. Both case-insensitive dedup, first-seen casing preserved.
  - `chooseDeliveryReply({ received = [], missing = [] })` → `{ template: 'T_RECEIPT' | 'T_REQUEST_MISSING' }`. `T_REQUEST_MISSING` when `missing.length > 0`, else `T_RECEIPT`.
  - `T_REQUEST_MISSING(ctx)` → `{ subject, body }` using `ctx.received` / `ctx.missing` / `ctx.thread_subject` / `ctx.from_name` / `ctx.from_email`.

- [ ] **Step 1: Write the failing test**

Add to `tests/templates.test.js` (top import already has the templates; add the new names):

```javascript
import { T_REQUEST_MISSING, computeReceivedMissing, chooseDeliveryReply } from '../src/templates.js';

describe('computeReceivedMissing', () => {
  it('splits received (is_contract) vs missing (mentioned, doc_attached=false), deduped', () => {
    const rows = [
      { is_contract: 1, vendor_name: 'Skolon', analysis_json: JSON.stringify({ mentioned_agreements: [] }) },
      { is_contract: 0, vendor_name: null, analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'Quiculum', product: null, doc_attached: false },
        { vendor: 'Teachiq', product: 'Exam.net', doc_attached: false },
        { vendor: 'Skolon', product: null, doc_attached: false }, // already received → excluded
      ] }) },
    ];
    expect(computeReceivedMissing(rows)).toEqual({ received: ['Skolon'], missing: ['Quiculum', 'Teachiq'] });
  });

  it('handles object analysis_json and no mentions', () => {
    const rows = [{ is_contract: 1, vendor_name: 'Google', analysis_json: { mentioned_agreements: [] } }];
    expect(computeReceivedMissing(rows)).toEqual({ received: ['Google'], missing: [] });
  });
});

describe('chooseDeliveryReply', () => {
  it('picks T_RECEIPT when nothing is missing, T_REQUEST_MISSING otherwise', () => {
    expect(chooseDeliveryReply({ received: ['Skolon'], missing: [] }).template).toBe('T_RECEIPT');
    expect(chooseDeliveryReply({ received: [], missing: ['Quiculum'] }).template).toBe('T_REQUEST_MISSING');
    expect(chooseDeliveryReply({ received: ['Skolon'], missing: ['Quiculum'] }).template).toBe('T_REQUEST_MISSING');
  });
});

describe('T_REQUEST_MISSING', () => {
  const base = { thread_subject: 'Begäran', from_name: 'Gustaf Hård af Segerstad', from_email: 'gustaf@mediagraf.se' };
  it('acknowledges received and names missing when both present', () => {
    const m = T_REQUEST_MISSING({ ...base, received: ['Skolon'], missing: ['Quiculum', 'Teachiq'] });
    expect(m.subject).toBe('Re: Begäran');
    expect(m.body).toMatch(/Tack för avtalen gällande Skolon/);
    expect(m.body).toMatch(/Quiculum och Teachiq/);
    expect(m.body).toMatch(/Gustaf Hård af Segerstad/);
  });
  it('asks for the documents when nothing real arrived', () => {
    const m = T_REQUEST_MISSING({ ...base, received: [], missing: ['Quiculum'] });
    expect(m.body).toMatch(/inte (vara )?bifogade/);
    expect(m.body).toMatch(/Quiculum/);
  });
  it('falls back to a generic ask when there are no names', () => {
    const m = T_REQUEST_MISSING({ ...base, received: [], missing: [] });
    expect(m.body).toMatch(/faktiska avtalshandlingarna/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/templates.test.js -t "computeReceivedMissing|chooseDeliveryReply|T_REQUEST_MISSING"`
Expected: FAIL — the three names are not exported yet.

- [ ] **Step 3: Implement in `src/templates.js`**

Append (after `T_FOLLOWUP_CLOSE`, reusing the existing `signature` helper at the top of the file):

```javascript
// Join a list the Swedish way: "A", "A och B", "A, B och C".
function listSv(items) {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(', ') + ' och ' + items[items.length - 1];
}

// Which reply to draft for a delivery, from what actually arrived.
export function chooseDeliveryReply({ received = [], missing = [] } = {}) {
  return { template: missing.length > 0 ? 'T_REQUEST_MISSING' : 'T_RECEIPT' };
}

// Derive received (real contracts) vs missing (named but undocumented) vendors
// from the contract-analysis rows of one delivery's attachments.
export function computeReceivedMissing(rows = []) {
  const received = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.is_contract && r.vendor_name) {
      const k = r.vendor_name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); received.push(r.vendor_name); }
    }
  }
  const missing = [];
  const seenMissing = new Set(seen); // never ask for something already received
  for (const r of rows) {
    let a = r.analysis_json;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    for (const m of a?.mentioned_agreements ?? []) {
      if (m && m.doc_attached === false && m.vendor) {
        const k = m.vendor.toLowerCase();
        if (!seenMissing.has(k)) { seenMissing.add(k); missing.push(m.vendor); }
      }
    }
  }
  return { received, missing };
}

// Follow-up when a delivery lacks (some of) the actual avtal documents.
export function T_REQUEST_MISSING(ctx) {
  const received = ctx.received ?? [];
  const missing = ctx.missing ?? [];
  let ask;
  if (missing.length && received.length) {
    ask = `Tack för avtalen gällande ${listSv(received)}. Jag saknar dock ännu de faktiska avtalshandlingarna för ${listSv(missing)} — kan ni skicka dem?`;
  } else if (missing.length) {
    ask = `Tack för ert svar. Själva avtalshandlingarna verkar dock inte vara bifogade — kan ni skicka de fullständiga avtalen för ${listSv(missing)}?`;
  } else {
    ask = 'Tack för ert svar. Jag ser dock inte de faktiska avtalshandlingarna bifogade — kan ni skicka de fullständiga avtalen?';
  }
  return {
    subject: `Re: ${ctx.thread_subject}`,
    body: ['Hej,', '', ask, '', signature(ctx)].join('\n'),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/templates.test.js`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/templates.js tests/templates.test.js
git commit -m "feat(templates): T_REQUEST_MISSING + computeReceivedMissing/chooseDeliveryReply

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Storage — per-message contract info + onlyMessageId analysis

**Files:**
- Modify: `src/storage.js` (helper near `listPendingContractAttachments` ~377-388, export in the return object ~475-507)
- Modify: `src/analyse-contract.js` (`analysePendingContracts` signature + filter ~126-139)
- Test: `tests/storage.test.js`, `tests/analyse-contract.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `db.listContractInfoForMessage(messageId)` → rows `{ is_contract: 0|1, vendor_name: string|null, analysis_json: string|null }`, one per analyzed attachment of that message (attachments with no contract row are omitted).
  - `analysePendingContracts({ ..., onlyMessageId = null })` — when set, only attachments whose `message_id === onlyMessageId` are analyzed.

- [ ] **Step 1: Write the failing test**

Add to `tests/storage.test.js`:

```javascript
describe('listContractInfoForMessage', () => {
  it('returns is_contract, vendor_name (via vendor_id) and analysis_json per analyzed attachment', () => {
    const db = openDb(':memory:');
    db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: 'm1', direction: 'inbound', from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: 'b', classification: 'delivery', classification_confidence: 0.9, received_at: '2026-06-01T00:00:00Z', attachment_count: 2 });
    const a1 = db.recordAttachment({ message_id: msgId, filename: 'avtal.pdf', saved_path: '/x/avtal.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const a2 = db.recordAttachment({ message_id: msgId, filename: 'brev.pdf', saved_path: '/x/brev.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const v = db.upsertVendor('Skolon');
    db.recordContract({ attachment_id: a1, vendor_id: v.id, is_contract: 1, summary: 'avtal', analysis_json: { mentioned_agreements: [] } });
    db.recordContract({ attachment_id: a2, vendor_id: null, is_contract: 0, summary: 'brev', analysis_json: { mentioned_agreements: [{ vendor: 'Quiculum', product: null, doc_attached: false }] } });

    const rows = db.listContractInfoForMessage(msgId);
    expect(rows).toHaveLength(2);
    const contract = rows.find((r) => r.is_contract === 1);
    expect(contract.vendor_name).toBe('Skolon');
    const letter = rows.find((r) => r.is_contract === 0);
    expect(JSON.parse(letter.analysis_json).mentioned_agreements[0].vendor).toBe('Quiculum');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage.test.js -t "listContractInfoForMessage"`
Expected: FAIL — `db.listContractInfoForMessage is not a function`.

- [ ] **Step 3: Add the storage helper**

In `src/storage.js`, after `listPendingContractAttachments` (ends ~line 388) add:

```javascript
  function listContractInfoForMessage(messageId) {
    return db.prepare(`
      SELECT c.is_contract AS is_contract, v.name AS vendor_name, c.analysis_json AS analysis_json
      FROM attachments a
      JOIN contracts c ON c.attachment_id = a.id
      LEFT JOIN vendors v ON v.id = c.vendor_id
      WHERE a.message_id = ?
      ORDER BY a.id
    `).all(messageId);
  }
```

Add `listContractInfoForMessage` to the returned object (the block starting ~line 475).

- [ ] **Step 4: Add `onlyMessageId` to `analysePendingContracts`**

In `src/analyse-contract.js`, change the signature (line 126) to include `onlyMessageId = null`:

```javascript
export async function analysePendingContracts({ db, env = process.env, client = null, log = null, force = false, onlyId = null, onlyMessageId = null } = {}) {
```

After the existing `if (onlyId != null) pending = pending.filter((a) => a.id === onlyId);` (line 139) add:

```javascript
  if (onlyMessageId != null) pending = pending.filter((a) => a.message_id === onlyMessageId);
```

- [ ] **Step 5: Write the onlyMessageId test**

Add to `tests/analyse-contract.test.js`. It needs two messages in ONE db (the
`seedDbWithPdf` helper makes a fresh db per call, so write it self-contained
using the imports already at the top of the file — `mkdtempSync`, `tmpdir`,
`join`, `dirname`, `mkdirSync`, `writeFileSync`, `openDb`):

```javascript
describe('analysePendingContracts onlyMessageId', () => {
  it('analyses only the attachments of the given message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    try {
      const db = openDb(join(tmp, 'pilot.db'));
      db.migrate();
      const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
      const seedMsgWithPdf = (name) => {
        const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: `gm-${name}`, direction: 'inbound', from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: '', classification: null, classification_confidence: null, received_at: '2026-06-01T00:00:00Z', attachment_count: 1 });
        const p = join(tmp, `${name}.pdf`);
        writeFileSync(p, '%PDF-1.4 fake');
        db.recordAttachment({ message_id: msgId, filename: `${name}.pdf`, saved_path: p, mime_type: 'application/pdf', size_bytes: 12 });
        return msgId;
      };
      const mA = seedMsgWithPdf('a');
      seedMsgWithPdf('b');

      const client = fakeClientReturning({ ...GOOD, document_type: 'avtal', mentioned_agreements: [] });
      const done = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client, onlyMessageId: mA });
      expect(done).toBe(1);
      expect(client.messages.create).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/storage.test.js tests/analyse-contract.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage.js src/analyse-contract.js tests/storage.test.js tests/analyse-contract.test.js
git commit -m "feat(storage): listContractInfoForMessage + analysePendingContracts onlyMessageId

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tick — contract-aware delivery draft

**Files:**
- Modify: `src/tick.js` (imports ~1, `TEMPLATES` ~12, `tplCtx` ~18-26, `escalateWithDraft` ~48-68, delivery branch ~236-258)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `computeReceivedMissing`, `chooseDeliveryReply`, `T_REQUEST_MISSING` (Task 2); `db.listContractInfoForMessage` (Task 3); `analysePendingContracts` `onlyMessageId` (Task 3); the injectable `deps.analyseContracts`.
- Produces: when a delivery's attachments lack real contracts (or name undocumented agreements), the drafted escalation uses `draft_template = 'T_REQUEST_MISSING'` with a body naming the missing avtal, and the LLM `draft_reply` is not used.

- [ ] **Step 1: Write the failing test**

Add to `tests/tick.test.js` (reuse `makeDeps`, `fakeGmail`, `mkMsg`/`b64`, and the `analyseMod` import already present):

```javascript
it('drafts T_REQUEST_MISSING (not T_RECEIPT) when a delivery lacks the actual avtal', async () => {
  const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'Arjeplog', role: 'central', contact_email: 'kommun@arjeplog.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-p', last_outbound_at: '2026-05-01T00:00:00Z' });

  // Force the delivery classification + an LLM draft that must be overridden.
  const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
    intent: 'delivery', confidence: 0.9, summary: 'Svar bifogat.',
    suggested_action: 'send_receipt', draft_reply: 'Tack så mycket för avtalen!', follow_up_at: null,
    extracted: {},
  });

  // A message with one PDF attachment.
  const msg = {
    id: 'in-1', threadId: 'thr-p',
    payload: { headers: [
      { name: 'From', value: 'Stoltz Pernilla <Pernilla.Stoltz@arjeplog.se>' },
      { name: 'To', value: 'me@x.se' }, { name: 'Subject', value: 'Svar' },
    ], mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { data: b64('Bifogat finner du svar.') } },
      { mimeType: 'application/pdf', filename: 'Svar.pdf', body: { attachmentId: 'att-1', size: 100 } },
    ] },
  };

  // Stub the inline analyzer: mark this message's attachment as a följebrev
  // naming Quiculum (doc_attached=false), so received=[] and missing=[Quiculum].
  const analyseContracts = async ({ db: d, onlyMessageId }) => {
    const atts = d.raw.prepare('SELECT id FROM attachments WHERE message_id = ?').all(onlyMessageId);
    for (const a of atts) {
      storeContractAnalysis(d, a.id, {
        is_contract: false, document_type: 'följebrev_sammanställning', vendor_name: null,
        products: [], avtalsvarde: null, valuta: null, period_start: null, period_end: null,
        summary: 'följebrev', confidence: 0.9,
        mentioned_agreements: [{ vendor: 'Quiculum', product: null, doc_attached: false }],
      }, { model: 'test' });
    }
    return atts.length;
  };

  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'in-1' }], getResult: { 'in-1': msg }, }), analyseContracts }));
  spy.mockRestore();

  const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(convId);
  expect(esc.draft_template).toBe('T_REQUEST_MISSING');
  expect(esc.draft_body).toMatch(/Quiculum/);
  expect(esc.draft_body).not.toMatch(/Tack så mycket för avtalen!/); // LLM draft overridden
});
```

Add `import { storeContractAnalysis } from '../src/analyse-contract.js';` at the top of `tests/tick.test.js` if not already imported. `makeDeps` must pass `analyseContracts` through to deps — if it doesn't already, extend it: `return { ..., analyseContracts: opts.analyseContracts };` (accept an `analyseContracts` field).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "T_REQUEST_MISSING"`
Expected: FAIL — draft_template is `T_RECEIPT` and body is the LLM draft.

- [ ] **Step 3: Wire imports + TEMPLATES + tplCtx**

In `src/tick.js` line 1, extend the templates import and add the helpers import:

```javascript
import { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING, computeReceivedMissing, chooseDeliveryReply } from './templates.js';
```

Line 12, add `T_REQUEST_MISSING` to the map:

```javascript
const TEMPLATES = { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING };
```

In `tplCtx` (lines 18-26), add received/missing passthrough — replace the returned object with:

```javascript
function tplCtx(conv, env, extra = {}) {
  return {
    kommun_namn: conv.kommun_namn,
    role: conv.role,
    from_email: env.GMAIL_USER_EMAIL,
    from_name: env.GMAIL_FROM_NAME,
    thread_subject: extra.thread_subject ?? 'Begäran om allmänna handlingar – avtal för digitala verktyg',
    days_since_send: extra.days_since_send ?? 0,
    received: extra.received ?? [],
    missing: extra.missing ?? [],
  };
}
```

- [ ] **Step 4: Thread `templateCtx` through `escalateWithDraft`**

In `escalateWithDraft` (line 48), add `templateCtx = {}` to the destructured params:

```javascript
async function escalateWithDraft({ conv, parsedInbound, messageId = null, classification, previousState, draftTemplate, llmDraft, reason, templateCtx = {}, deps }) {
```

In its `TEMPLATES[draftTemplate]` branch (around lines 60-67), merge `templateCtx` into the ctx:

```javascript
  } else if (TEMPLATES[draftTemplate]) {
    const ctx = tplCtx(conv, env, {
      thread_subject: parsedInbound?.subject?.replace(/^Re: /, '') ?? undefined,
      days_since_send: deps.daysSinceSend ?? 0,
      ...templateCtx,
    });
    const rendered = TEMPLATES[draftTemplate](ctx);
    subject = rendered.subject;
    body = rendered.body;
  }
```

- [ ] **Step 5: Add the delivery-branch analysis + override**

In the inbound loop of `runTick`, right after the `llmDraft` assignment block (lines 242-244, the `if (draftTemplate && analysis?.draft_reply) { llmDraft = { body: analysis.draft_reply }; }`) and BEFORE the `const threadStatus = ...` line (246), insert:

```javascript
        // Contract-aware delivery: a "delivery" reply must reflect what the
        // attachments actually contain, not the email body. Analyse this
        // message's attachments inline, then request the specific missing avtal
        // instead of blindly thanking for contracts.
        let templateCtx = {};
        if (draftTemplate === 'T_RECEIPT') {
          const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
          try {
            await analyseContracts({ db, env, log: deps.log, onlyMessageId: messageId });
          } catch (e) {
            deps.log?.(`inline contract analysis error: ${e.message}`);
          }
          const { received, missing } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
          if (chooseDeliveryReply({ received, missing }).template === 'T_REQUEST_MISSING') {
            draftTemplate = 'T_REQUEST_MISSING';
            llmDraft = null; // the PDF-blind LLM draft must not win here
            templateCtx = { received, missing };
          }
        }
```

Then pass `templateCtx` into the `escalateWithDraft({ ... })` call (around line 251-258) — add `templateCtx,` to the argument object.

Note: `analysePendingContracts` is already imported at the top of `src/tick.js` (used by step 3 of the tick).

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS (new test + all existing tick tests).

- [ ] **Step 7: Full suite + commit**

```bash
npm test    # expect all green
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): contract-aware delivery draft — request missing avtal, override LLM draft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `npm test` — all green.
- [ ] Restart the daemon so the running process picks up the new code: `pkill -f pilot-daemon.js` then `npm run pilot-daemon &`.
- [ ] (Optional, live) Re-analyze Arjeplog's attachment with the new prompt and confirm it now reads `document_type='följebrev_sammanställning'`, `is_contract=0`, `mentioned_agreements=[Quiculum, LäroMedia, Teachiq]` — and that a fresh delivery there would draft `T_REQUEST_MISSING`. Existing stale escalation on the (now closed) case is unaffected.
