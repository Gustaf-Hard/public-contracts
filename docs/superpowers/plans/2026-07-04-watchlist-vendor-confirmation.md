# Watchlist-Vendor Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a delivery names a strategically-sensitive vendor (Binogi / Nationalencyklopedin / Inläsningstjänst-ILT / Magma), flag the escalation prominently and hold the draft so the operator consciously authors the reply instead of rubber-stamping an auto-draft.

**Architecture:** Match-then-hold inside the existing contract-aware delivery branch in `src/tick.js`. A new pure `src/watchlist.js` matches all vendors named in the delivery against a code-constant watchlist. On any match the tick overrides the draft to the existing held `free_form` path (no sendable reply), stamps the matched vendors onto the escalation (new `escalations.watchlist_vendors` column), and surfaces a ⚠️ banner in Slack and the dashboard. The watchlist decision supersedes the T_RECEIPT/T_REQUEST_MISSING contract-aware draft.

**Tech Stack:** Node 20 ESM, better-sqlite3, vitest. No build step. LLM (Anthropic) is injected/stubbed in tests.

## Global Constraints

- Node ESM only (`import`/`export`), Node 20+. No TypeScript. No build step.
- No auto-sending. The follow-up stays a human-approved escalation draft. A watchlist match only *holds* the draft (no pre-filled sendable reply) and adds a flag.
- No conversation FSM change. Only the delivery branch of `src/tick.js` is affected; precision/escalate/followup are untouched.
- Watchlist is a **code constant** in `src/watchlist.js` (4 entries). Not configurable/external.
- Matching is **whole-word on a normalized string** (lowercase + ASCII-fold `å/ä→a, ö→o, é→e, ü→u` + punctuation→space + collapse). Short aliases (`ne`, `ilt`) must NOT false-positive on unrelated names.
- The hold reuses the existing `free_form` template path (already used for the `escalate` action). Do NOT hard-block the Slack "Approve" button — that is an explicit non-goal (follow-up).
- `escalations.watchlist_vendors` stores a JSON array of matched canonical names, or `NULL` when none.
- Tests fully offline: stubbed Anthropic client, fake gmail (`gmailOps`), `:memory:` db. No real network.
- Every commit message ends with the trailer (exactly):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Full suite: `npm test`. Single file: `npx vitest run tests/<name>.test.js`.

## File Structure

- `src/watchlist.js` — CREATE: `WATCHLIST` constant + pure `matchWatchlist(names)`.
- `src/templates.js` — MODIFY: `computeReceivedMissing(rows)` also returns `all`.
- `src/storage.js` — MODIFY: `escalations.watchlist_vendors` column (SCHEMA + `migrate()`), `recordEscalation` persists it.
- `src/slack.js` — MODIFY: `buildEscalationBlocks` renders the ⚠️ banner.
- `src/dashboard-views.js` — MODIFY: export + banner in `renderEscalationForm` + CSS.
- `src/tick.js` — MODIFY: match + hold in the delivery branch; thread `watchlistVendors` through `escalateWithDraft`.
- Tests: `tests/watchlist.test.js` (new); `tests/templates.test.js`, `tests/storage.test.js`, `tests/slack.test.js`, `tests/dashboard.test.js`, `tests/tick.test.js` (modify).

---

## Task 1: Watchlist module

**Files:**
- Create: `src/watchlist.js`
- Test: `tests/watchlist.test.js`

**Interfaces:**
- Produces:
  - `WATCHLIST` — array of `{ canonical: string, aliases: string[] }`.
  - `matchWatchlist(names: string[]) → string[]` — canonical names of matched entries, deduped, in `WATCHLIST` order. Whole-word match on the normalized form of each name; short aliases never match inside unrelated tokens. `matchWatchlist([])` and blank/null names → `[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/watchlist.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { matchWatchlist } from '../src/watchlist.js';

describe('matchWatchlist', () => {
  it('matches canonical and alias forms of each watchlist vendor', () => {
    expect(matchWatchlist(['Nationalencyklopedin'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['NE'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['ILT Education'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['ILT Inläsningstjänst'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['Inläsningstjänst'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['inlasningstjanst'])).toEqual(['Inläsningstjänst (ILT)']); // OCR / ascii-folded
    expect(matchWatchlist(['Binogi AB'])).toEqual(['Binogi']);
    expect(matchWatchlist(['Magma'])).toEqual(['Magma']);
  });

  it('does not false-positive on short aliases inside unrelated names', () => {
    expect(matchWatchlist(['Skillster', 'Skolplus', 'Vinge', 'Dugga'])).toEqual([]);
    expect(matchWatchlist(['Quiculum', 'Teachiq', 'LäroMedia Bokhandel Örebro'])).toEqual([]);
  });

  it('is case-insensitive, deduped, and returns canonical names in WATCHLIST order', () => {
    expect(matchWatchlist(['binogi', 'BINOGI', 'ne', 'NatIonalEncyklopedin']))
      .toEqual(['Nationalencyklopedin', 'Binogi']);
  });

  it('returns empty for no/blank names', () => {
    expect(matchWatchlist([])).toEqual([]);
    expect(matchWatchlist(['', null, undefined])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/watchlist.test.js`
Expected: FAIL — `src/watchlist.js` does not exist / `matchWatchlist` not exported.

- [ ] **Step 3: Implement `src/watchlist.js`**

Create `src/watchlist.js`:

```javascript
// src/watchlist.js
// Strategically-sensitive vendors. When a delivery names one of these, the
// pipeline holds the draft and flags the escalation so the operator consciously
// authors the reply (see docs/superpowers/specs/2026-07-04-watchlist-vendor-confirmation-design.md).
// Pure: no IO.

export const WATCHLIST = [
  { canonical: 'Nationalencyklopedin',   aliases: ['nationalencyklopedin', 'ne'] },
  { canonical: 'Magma',                  aliases: ['magma'] },
  { canonical: 'Inläsningstjänst (ILT)', aliases: ['inläsningstjänst', 'ilt'] },
  { canonical: 'Binogi',                 aliases: ['binogi'] },
];

// Lowercase, ASCII-fold Swedish letters, punctuation→space, collapse whitespace.
function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/é/g, 'e')
    .replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Canonical names of watchlist entries matched by any of `names`, deduped,
// in WATCHLIST order. An alias matches only as a whole word on the normalized
// string, so short aliases (ne, ilt) never fire inside unrelated tokens.
export function matchWatchlist(names = []) {
  const normed = names.map(normalize).filter(Boolean);
  const matched = [];
  for (const entry of WATCHLIST) {
    const hit = entry.aliases.some((alias) => {
      const a = normalize(alias);
      if (!a) return false;
      const re = new RegExp(`\\b${escapeRegExp(a)}\\b`);
      return normed.some((n) => re.test(n));
    });
    if (hit) matched.push(entry.canonical);
  }
  return matched;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/watchlist.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/watchlist.js tests/watchlist.test.js
git commit -m "feat(watchlist): vendor watchlist + matchWatchlist (whole-word, ascii-folded)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: computeReceivedMissing returns `all`

**Files:**
- Modify: `src/templates.js` (`computeReceivedMissing`, currently ~line 116)
- Test: `tests/templates.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `computeReceivedMissing(rows)` now returns `{ received, missing, all }`. `all` = distinct union (case-insensitive dedup, first-seen casing) of every row's `vendor_name` that is present AND every `mentioned_agreements[].vendor` across all rows, **regardless of `doc_attached`**. `received`/`missing` are unchanged. Adding a field is backward compatible.

- [ ] **Step 1: Write the failing test**

Add to `tests/templates.test.js` (the `computeReceivedMissing` import already exists):

```javascript
describe('computeReceivedMissing — all vendors', () => {
  it('returns all = union of received and every mentioned vendor (incl doc_attached=true)', () => {
    const rows = [
      { is_contract: 1, vendor_name: 'Quiculum', analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'Quiculum', product: null, doc_attached: true },
        { vendor: 'Teachiq', product: null, doc_attached: false },
      ] }) },
      { is_contract: 0, vendor_name: null, analysis_json: JSON.stringify({ mentioned_agreements: [
        { vendor: 'LäroMedia Bokhandel Örebro', product: null, doc_attached: false },
      ] }) },
    ];
    const { received, missing, all } = computeReceivedMissing(rows);
    expect(received).toEqual(['Quiculum']);
    expect(missing).toEqual(['Teachiq', 'LäroMedia Bokhandel Örebro']);
    expect(all).toEqual(['Quiculum', 'Teachiq', 'LäroMedia Bokhandel Örebro']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/templates.test.js -t "all vendors"`
Expected: FAIL — `all` is `undefined`.

- [ ] **Step 3: Replace `computeReceivedMissing`**

In `src/templates.js`, replace the whole `computeReceivedMissing` function with:

```javascript
// Derive received (real contracts), missing (named but undocumented), and all
// (every vendor named anywhere in the delivery) from a delivery's contract rows.
export function computeReceivedMissing(rows = []) {
  const all = [];
  const seenAll = new Set();
  const addAll = (name) => {
    if (!name) return;
    const k = name.toLowerCase();
    if (!seenAll.has(k)) { seenAll.add(k); all.push(name); }
  };

  // Parse each row's analysis_json once.
  const parsed = rows.map((r) => {
    let a = r.analysis_json;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    return { r, a };
  });

  const received = [];
  const seen = new Set();
  for (const { r } of parsed) {
    if (r.vendor_name) addAll(r.vendor_name);
    if (r.is_contract && r.vendor_name) {
      const k = r.vendor_name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); received.push(r.vendor_name); }
    }
  }

  const missing = [];
  const seenMissing = new Set(seen); // never ask for something already received
  for (const { a } of parsed) {
    for (const m of a?.mentioned_agreements ?? []) {
      if (m && m.vendor) addAll(m.vendor);
      if (m && m.doc_attached === false && m.vendor) {
        const k = m.vendor.toLowerCase();
        if (!seenMissing.has(k)) { seenMissing.add(k); missing.push(m.vendor); }
      }
    }
  }

  return { received, missing, all };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/templates.test.js`
Expected: PASS (new test + all existing template tests — `received`/`missing` behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/templates.js tests/templates.test.js
git commit -m "feat(templates): computeReceivedMissing returns all vendors named in a delivery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Storage — escalations.watchlist_vendors

**Files:**
- Modify: `src/storage.js` (escalations `CREATE TABLE` in `SCHEMA`; `migrate()` ~lines 170-174; `recordEscalation` ~lines 303-315)
- Test: `tests/storage.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - New nullable column `escalations.watchlist_vendors TEXT` (JSON array of canonical names, or `NULL`).
  - `recordEscalation(e)` accepts `e.watchlist_vendors` (a string or null) and persists it.
  - `listOpenEscalations()` returns the column (it already does `SELECT *`).

- [ ] **Step 1: Write the failing test**

Add to `tests/storage.test.js`:

```javascript
describe('escalations watchlist_vendors', () => {
  it('persists and returns watchlist_vendors', () => {
    const db = openDb(':memory:'); db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'r', draft_template: 'free_form', draft_body: '(ingen draft)', watchlist_vendors: JSON.stringify(['Binogi', 'Nationalencyklopedin']) });
    const esc = db.listOpenEscalations().find((e) => e.id === id);
    expect(JSON.parse(esc.watchlist_vendors)).toEqual(['Binogi', 'Nationalencyklopedin']);
  });

  it('defaults watchlist_vendors to null when omitted', () => {
    const db = openDb(':memory:'); db.migrate();
    const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
    const id = db.recordEscalation({ conversation_id: convId, reason: 'r', draft_template: 'T_RECEIPT', draft_body: 'x' });
    const esc = db.listOpenEscalations().find((e) => e.id === id);
    expect(esc.watchlist_vendors).toBeNull();
  });

  it('adds watchlist_vendors to a pre-existing escalations table (migration)', () => {
    const db = openDb(':memory:');
    // Simulate an old DB: escalations without the new column.
    db.raw.exec('DROP TABLE IF EXISTS escalations');
    db.raw.exec(`CREATE TABLE escalations (
      id INTEGER PRIMARY KEY, conversation_id INTEGER, message_id INTEGER, reason TEXT NOT NULL,
      draft_template TEXT, draft_subject TEXT, draft_body TEXT, slack_ts TEXT,
      status TEXT NOT NULL DEFAULT 'open', resolved_at TEXT, resolved_text TEXT,
      classifier_class TEXT, classifier_confidence REAL, previous_state TEXT, created_at TEXT
    )`);
    db.migrate();
    const cols = db.raw.prepare('PRAGMA table_info(escalations)').all().map((r) => r.name);
    expect(cols).toContain('watchlist_vendors');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/storage.test.js -t "watchlist_vendors"`
Expected: FAIL — column/parameter does not exist (`table escalations has no column named watchlist_vendors` or the value is dropped).

- [ ] **Step 3: Add the column to the schema**

In `src/storage.js`, in the `escalations` `CREATE TABLE` block inside `SCHEMA`, add the column immediately before `created_at`:

```sql
  previous_state TEXT,
  watchlist_vendors TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 4: Add the idempotent migration**

In `src/storage.js` `migrate()`, after the `daemon_heartbeat` probe block (the `last_success_at` one, ~line 174) and before the closing `}` of `migrate`, add:

```javascript
    const escCols = db.prepare("PRAGMA table_info(escalations)").all().map((r) => r.name);
    if (!escCols.includes('watchlist_vendors')) {
      db.exec('ALTER TABLE escalations ADD COLUMN watchlist_vendors TEXT');
    }
```

- [ ] **Step 5: Persist it in `recordEscalation`**

In `src/storage.js`, replace the `recordEscalation` INSERT so the new column is written:

```javascript
  function recordEscalation(e) {
    const r = db.prepare(`
      INSERT INTO escalations (conversation_id, message_id, reason, draft_template, draft_subject, draft_body, slack_ts, classifier_class, classifier_confidence, previous_state, watchlist_vendors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      e.conversation_id, e.message_id ?? null, e.reason,
      e.draft_template ?? null, e.draft_subject ?? null, e.draft_body ?? null,
      e.slack_ts ?? null,
      e.classifier_class ?? null, e.classifier_confidence ?? null, e.previous_state ?? null,
      e.watchlist_vendors ?? null
    );
    return Number(r.lastInsertRowid);
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/storage.test.js`
Expected: PASS (3 new tests + all existing storage tests).

- [ ] **Step 7: Commit**

```bash
git add src/storage.js tests/storage.test.js
git commit -m "feat(storage): escalations.watchlist_vendors column + recordEscalation persist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Slack — watchlist banner

**Files:**
- Modify: `src/slack.js` (`buildEscalationBlocks`, ~lines 8-31)
- Test: `tests/slack.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildEscalationBlocks({ ..., watchlist_vendors = [] })` — when `watchlist_vendors` is non-empty, inserts a ⚠️ `*BEVAKAD LEVERANTÖR:*` section block right after the header naming the vendors; otherwise the blocks are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `tests/slack.test.js` (add `buildEscalationBlocks` to the existing `../src/slack.js` import, or a new import line):

```javascript
import { buildEscalationBlocks } from '../src/slack.js';

describe('buildEscalationBlocks watchlist banner', () => {
  const base = { escalation_id: 1, kommun_namn: 'Arjeplog', from_email: 'a@x.se', reply_text: 'hej', draft_reply: 'svar', gmail_thread_id: 't1' };
  it('adds a BEVAKAD LEVERANTÖR banner when watchlist_vendors present', () => {
    const blocks = buildEscalationBlocks({ ...base, watchlist_vendors: ['Binogi', 'Nationalencyklopedin'] });
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).toMatch(/BEVAKAD LEVERANTÖR:.*Binogi.*Nationalencyklopedin/);
  });
  it('omits the banner when no watchlist vendors', () => {
    const blocks = buildEscalationBlocks(base);
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).not.toMatch(/BEVAKAD/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/slack.test.js -t "watchlist banner"`
Expected: FAIL — no banner text in the blocks.

- [ ] **Step 3: Implement the banner**

In `src/slack.js`, replace `buildEscalationBlocks` with:

```javascript
export function buildEscalationBlocks({ escalation_id, kommun_namn, from_email, reply_text, draft_reply, gmail_thread_id, watchlist_vendors = [] }) {
  const idStr = String(escalation_id);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Eskalering: ${kommun_namn}` } },
  ];
  if (watchlist_vendors.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *BEVAKAD LEVERANTÖR:* ${watchlist_vendors.join(', ')} — kontrollera innan du svarar.` } });
  }
  blocks.push(
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Från:*\n${from_email}` },
        { type: 'mrkdwn', text: `*Tråd:*\n${gmail_thread_id}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Inkommande:*\n>${reply_text.replace(/\n/g, '\n>').slice(0, 1500)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Förslag på svar:*\n>${(draft_reply ?? '(ingen draft)').replace(/\n/g, '\n>').slice(0, 1500)}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'esc_approve', value: idStr, text: { type: 'plain_text', text: 'Approve' }, style: 'primary' },
        { type: 'button', action_id: 'esc_edit', value: idStr, text: { type: 'plain_text', text: 'Edit' } },
        { type: 'button', action_id: 'esc_skip', value: idStr, text: { type: 'plain_text', text: 'Skip' }, style: 'danger' },
      ],
    },
  );
  return blocks;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/slack.test.js`
Expected: PASS (2 new tests + all existing slack tests).

- [ ] **Step 5: Commit**

```bash
git add src/slack.js tests/slack.test.js
git commit -m "feat(slack): BEVAKAD LEVERANTÖR banner in escalation blocks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard — watchlist banner

**Files:**
- Modify: `src/dashboard-views.js` (`renderEscalationForm` ~line 817; `.esc-reason` CSS ~line 466)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `esc.watchlist_vendors` (a JSON-array string or null/undefined) from a `SELECT * FROM escalations` row.
- Produces: `renderEscalationForm(esc, gmailReady, returnTo)` is now **exported** and, when `esc.watchlist_vendors` parses to a non-empty array, prepends a `<div class="esc-watchlist">⚠️ Bevakad leverantör: …</div>` banner above the form. This card is reused across the overview action queue, kommun detail, thread groups, and ärenden, so all dashboard surfaces get the banner.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboard.test.js` (add `renderEscalationForm` to the existing `../src/dashboard-views.js` import — currently only `layout`):

```javascript
import { renderEscalationForm } from '../src/dashboard-views.js';

describe('renderEscalationForm watchlist banner', () => {
  it('shows the banner when watchlist_vendors is set', () => {
    const html = renderEscalationForm({ id: 1, recipient: 'a@x.se', draft_subject: 'Re', draft_body: '', watchlist_vendors: JSON.stringify(['Binogi']) }, true);
    expect(html).toMatch(/Bevakad leverantör/);
    expect(html).toMatch(/Binogi/);
  });
  it('omits the banner when watchlist_vendors is absent', () => {
    const html = renderEscalationForm({ id: 1, recipient: 'a@x.se', draft_subject: 'Re', draft_body: 'x' }, true);
    expect(html).not.toMatch(/Bevakad leverantör/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "watchlist banner"`
Expected: FAIL — `renderEscalationForm` is not exported (import is `undefined`).

- [ ] **Step 3: Export the function and add the banner**

In `src/dashboard-views.js`, change the declaration:

```javascript
export function renderEscalationForm(esc, gmailReady, returnTo = null) {
```

Then, inside that function, immediately before the final `return \`` that starts `<form class="action-form" ...>`, add the banner computation, and prepend it to the returned template. The start of the returned template becomes:

```javascript
  const watchVendors = (() => { try { return JSON.parse(esc.watchlist_vendors ?? '[]'); } catch { return []; } })();
  const watchBanner = Array.isArray(watchVendors) && watchVendors.length
    ? `<div class="esc-watchlist">⚠️ Bevakad leverantör: ${escapeHtml(watchVendors.join(', '))} — kontrollera innan du svarar.</div>`
    : '';
  return `
    ${watchBanner}
    <form class="action-form" method="post" action="/escalations/${esc.id}"${paneAttrs}>
```

(The rest of the returned template — the two forms — is unchanged.)

- [ ] **Step 4: Add the CSS**

In `src/dashboard-views.js`, next to `.esc-reason { margin-bottom: 8px; }` (~line 466), add:

```css
  .esc-watchlist { margin-bottom: 8px; padding: 6px 10px; border-radius: 6px; background: #fde8e8; color: #9b1c1c; font-weight: 600; }
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS (2 new tests + all existing dashboard tests).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): watchlist banner on escalation cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Tick — match + hold + flag

**Files:**
- Modify: `src/tick.js` (import ~line 1; `escalateWithDraft` ~line 51 and its `recordEscalation`/`buildEscalationBlocks` calls ~lines 73-93; delivery branch ~lines 253-283)
- Test: `tests/tick.test.js`

**Interfaces:**
- Consumes: `matchWatchlist` (Task 1); `computeReceivedMissing().all` (Task 2); `recordEscalation` `watchlist_vendors` (Task 3); `buildEscalationBlocks` `watchlist_vendors` (Task 4).
- Produces: a delivery naming a watchlist vendor produces a held escalation — `draft_template='free_form'`, `watchlist_vendors` set (JSON array), `reason` prefixed with `⚠️ BEVAKAD LEVERANTÖR: …`, and no contract-aware/LLM draft. The watchlist decision supersedes T_RECEIPT/T_REQUEST_MISSING.

- [ ] **Step 1: Write the failing test**

Add to `tests/tick.test.js`, right after the existing "drafts T_REQUEST_MISSING …" test (reuses `makeDeps`, `fakeGmail`, `b64`, `analyseMod`, and the `storeContractAnalysis` import already added by the contract-aware feature):

```javascript
it('holds the draft (free_form) and flags watchlist vendors when a delivery names one', async () => {
  const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'Testkommun', role: 'central', contact_email: 'kommun@test.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-w', last_outbound_at: '2026-05-01T00:00:00Z' });

  const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
    intent: 'delivery', confidence: 0.9, summary: 'Svar bifogat.',
    suggested_action: 'send_receipt', draft_reply: 'Tack för avtalen!', follow_up_at: null, extracted: {},
  });

  const msg = {
    id: 'in-w', threadId: 'thr-w',
    payload: { headers: [
      { name: 'From', value: 'Kommun <kommun@test.se>' },
      { name: 'To', value: 'me@x.se' }, { name: 'Subject', value: 'Svar' },
    ], mimeType: 'multipart/mixed', parts: [
      { mimeType: 'text/plain', body: { data: b64('Bifogat finner du svar.') } },
      { mimeType: 'application/pdf', filename: 'Svar.pdf', body: { attachmentId: 'att-w', size: 100 } },
    ] },
  };

  // Inline analyzer marks this delivery's attachment as a Binogi contract.
  const analyseContracts = async ({ db: d, onlyMessageId }) => {
    const atts = d.raw.prepare('SELECT id FROM attachments WHERE message_id = ?').all(onlyMessageId);
    for (const a of atts) {
      storeContractAnalysis(d, a.id, {
        is_contract: true, document_type: 'avtal', vendor_name: 'Binogi',
        products: [], avtalsvarde: null, valuta: null, period_start: null, period_end: null,
        summary: 'avtal', confidence: 0.9, mentioned_agreements: [],
      }, { model: 'test' });
    }
    return atts.length;
  };

  await runTick(makeDeps({ gmail: fakeGmail({ listResult: [{ id: 'in-w' }], getResult: { 'in-w': msg } }), analyseContracts }));
  spy.mockRestore();

  const esc = db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ?').get(convId);
  expect(esc.draft_template).toBe('free_form');
  expect(JSON.parse(esc.watchlist_vendors)).toEqual(['Binogi']);
  expect(esc.reason).toMatch(/BEVAKAD LEVERANTÖR/);
  expect(esc.draft_body).not.toMatch(/Tack för avtalen!/); // LLM draft not used
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/tick.test.js -t "holds the draft"`
Expected: FAIL — `draft_template` is `T_RECEIPT` (Binogi has no missing agreements, so today's code keeps T_RECEIPT) and `watchlist_vendors` is null.

- [ ] **Step 3: Import `matchWatchlist`**

In `src/tick.js` line 1 area, add the import (after the existing `./templates.js` import):

```javascript
import { matchWatchlist } from './watchlist.js';
```

- [ ] **Step 4: Match + hold in the delivery branch**

In `src/tick.js`, replace the entire existing contract-aware block — from its leading comment (`// Contract-aware delivery: a "delivery" reply must reflect ...`) and the `let templateCtx = {};` line, through the closing `}` of the `if (draftTemplate === 'T_RECEIPT') { ... }` — with the following (do not leave the old comment behind):

```javascript
        // Contract-aware delivery: a "delivery" reply must reflect what the
        // attachments actually contain. A watchlisted vendor supersedes the
        // contract-aware draft and holds the reply for conscious authoring.
        let templateCtx = {};
        let watchlistVendors = [];
        if (draftTemplate === 'T_RECEIPT') {
          const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
          try {
            await analyseContracts({ db, env, log: deps.log, onlyMessageId: messageId });
            const { received, missing, all } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
            watchlistVendors = matchWatchlist(all);
            if (watchlistVendors.length > 0) {
              // Hold: no sendable draft, so the operator consciously authors the reply.
              draftTemplate = 'free_form';
              llmDraft = null;
              templateCtx = {};
            } else if (chooseDeliveryReply({ received, missing }).template === 'T_REQUEST_MISSING') {
              draftTemplate = 'T_REQUEST_MISSING';
              llmDraft = null; // the PDF-blind LLM draft must not win here
              templateCtx = { received, missing };
            }
          } catch (e) {
            deps.log?.(`inline contract analysis error: ${e.message}`);
            // fall back to T_RECEIPT with the existing llmDraft — never crash the tick
          }
        }
```

- [ ] **Step 5: Prefix the reason and pass `watchlistVendors` to `escalateWithDraft`**

In the same inbound loop, in the `if (draftTemplate && threadStatus !== 'muted')` block, change `const reason` to `let reason`, add the prefix, and pass `watchlistVendors`:

```javascript
        const threadStatus = db.getThreadById(thread.id)?.status ?? 'neutral';
        if (draftTemplate && threadStatus !== 'muted') {
          let reason = analysis
            ? `llm intent=${analysis.intent} action=${analysis.suggested_action} confidence=${(analysis.confidence ?? 0).toFixed(2)}`
            : `classifier=${classification.class} confidence=${classification.confidence.toFixed(2)}`;
          if (watchlistVendors.length > 0) {
            reason = `⚠️ BEVAKAD LEVERANTÖR: ${watchlistVendors.join(', ')} | ${reason}`;
          }
          await escalateWithDraft({
            conv: updated, parsedInbound: parsed, messageId, classification,
            previousState,
            draftTemplate,
            llmDraft,
            reason,
            templateCtx,
            watchlistVendors,
            deps,
          });
        }
```

- [ ] **Step 6: Thread `watchlistVendors` through `escalateWithDraft`**

In `src/tick.js`, add the param to `escalateWithDraft`'s destructured signature:

```javascript
async function escalateWithDraft({ conv, parsedInbound, messageId = null, classification, previousState, draftTemplate, llmDraft, reason, templateCtx = {}, watchlistVendors = [], deps }) {
```

In its `db.recordEscalation({ ... })` call, add the persisted field (after `previous_state`):

```javascript
    previous_state: previousState ?? null,
    watchlist_vendors: watchlistVendors.length ? JSON.stringify(watchlistVendors) : null,
```

In its `buildEscalationBlocks({ ... })` call, add (after `gmail_thread_id`):

```javascript
      gmail_thread_id: conv.gmail_thread_id ?? '(no thread)',
      watchlist_vendors: watchlistVendors,
```

- [ ] **Step 7: Run to verify pass**

Run: `npx vitest run tests/tick.test.js`
Expected: PASS (new test + all existing tick tests, incl. the T_REQUEST_MISSING and crash-safety tests which are unaffected — a non-watchlist delivery still yields T_RECEIPT/T_REQUEST_MISSING).

- [ ] **Step 8: Full suite + commit**

```bash
npm test    # expect all green
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): watchlist match holds delivery draft + flags escalation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run `npm test` — all green.
- [ ] Confirm a non-watchlist delivery is unchanged: the T_REQUEST_MISSING and crash-safety tick tests still pass.
- [ ] (Optional, live) Restart the daemon so the running process picks up the new code: `pkill -f pilot-daemon.js` then `npm run pilot-daemon`. Only if asked.
- [ ] Note deferred follow-up: hard-blocking the Slack "Approve" button for held (`free_form`) watchlist escalations (out of scope; the ⚠️ banner + *(ingen draft)* mitigate).
