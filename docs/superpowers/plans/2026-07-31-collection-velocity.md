# Collection Velocity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/takt` page showing week-by-week avtal collected, how fast kommuner
reply with a human, how long to the first avtal, the funnel, and who has gone
silent — plus correcting the `Avtal mottagna` headline from attachments (154) to
real avtal (91).

**Architecture:** A pure analytics module (`src/collection-velocity.js`) over
plain rows, three read-only storage queries, one route, and a server-rendered
inline-SVG view. Mirrors the `/leverantorer` pattern: pure logic is unit-tested
offline, the view is HTML, no client JS and no build step.

**Tech Stack:** Node 20+ ESM, Express, vitest, better-sqlite3, inline SVG.
No new dependencies.

## Global Constraints

- **Node 20+ ESM** — `import`/`export`, no CommonJS.
- **`src/collection-velocity.js` is pure** — no IO, no DB, deterministic. Same
  rule as `vendor-analytics.js`, `vendor-kb.js`, `coverage.js`.
- **No schema change.** All three queries are read-only `SELECT`s over existing
  tables; `storage.js` migrations stay append-only probes.
- **No client JS, no build step, no CDN.** The chart is server-rendered inline
  SVG so it survives the `app.js` pane swap (scripts inside `innerHTML` never
  execute — this is exactly why `explorer.js` needs special handling).
- **Never a dual-axis chart.** Avtal-per-week (max ~23) and cumulative (max 91)
  are different scales: **two stacked panels sharing one x-axis**, never one
  plot with two y-scales. This is the dataviz skill's #1 non-negotiable.
- **Chart mark colors (validated, do not eyeball):** light `#4f46e5` on
  `#ffffff` — all checks PASS. Dark `#6d7ff5` on `#14181d` — all checks PASS.
  The dashboard's own dark accent `#818cf8` **FAILS** the lightness band
  (L 0.68 > 0.67 ceiling), so the chart gets its own token; the UI accent is
  unchanged. Re-run
  `node scripts/validate_palette.js "<hex>" --mode <light|dark> --surface <hex>`
  in the dataviz skill dir if a color changes.
- **One series per panel ⇒ no legend** (the panel title names it); recessive
  grid/axes in `var(--border)`, labels in `var(--fg-muted)`.
- **Mark specs:** bars with 4px rounded data-ends anchored to the baseline, a
  2px surface gap between adjacent bars; the cumulative line 2px.
- **Every figure states its sample.** Medians always render with range and `n`;
  an empty sample renders `—`, never `0`.
- **All tests offline** — fixtures and temp-dir SQLite (`mkdtempSync` +
  `openDb` + `migrate()`), never `data/pilot.db`.
- **No em-dash / en-dash in user-facing Swedish copy** on the page.

---

## Task 1: `src/collection-velocity.js` — pure facts

**Files:**
- Create: `src/collection-velocity.js`
- Test: `tests/collection-velocity.test.js`

**Interfaces:**
- Produces:
```js
buildVelocityFacts({ contractEvents, caseTimings, files, now }) → {
  weeks:   [{ iso_week, week_start, contracts, cumulative, kommuner }],
  timings: {
    first_human_reply: { median, min, max, n, of },
    first_contract:    { median, min, max, n, of },
  },
  funnel:  { contacted, human_replied, delivered },
  silent:  [{ conversation_id, kommun_namn, days_waiting }],
  files:   { total, avtal, by_type: [{ document_type, n }] },
}
export function isoWeek(iso)  → { iso_week: '2026-W30', week_start: '2026-07-27' }
export function median(nums)  → number | null
```
- Inputs (plain rows, so the module stays testable offline):
  - `contractEvents`: `{ conversation_id, kommun_namn, received_at }` per avtal.
  - `caseTimings`: `{ conversation_id, kommun_namn, first_outbound_at,
    first_human_inbound_at, first_contract_at }` per conversation.
  - `files`: `{ total, by_type: [{ document_type, n }] }`.
  - `now`: ISO string — `days_waiting` is measured from it (never `Date.now()`
    inside the module, so tests are deterministic).

- [ ] **Step 1: Write the failing test**

```js
// tests/collection-velocity.test.js
import { describe, it, expect } from 'vitest';
import { buildVelocityFacts, isoWeek, median } from '../src/collection-velocity.js';

const NOW = '2026-07-31T00:00:00Z';

describe('isoWeek', () => {
  it('buckets to ISO weeks starting Monday', () => {
    expect(isoWeek('2026-07-31T09:00:00Z')).toMatchObject({ iso_week: '2026-W31', week_start: '2026-07-27' });
    // Sunday belongs to the week that started the previous Monday.
    expect(isoWeek('2026-07-26T23:00:00Z')).toMatchObject({ week_start: '2026-07-20' });
  });
});

describe('median', () => {
  it('is the middle value, averages the middle pair, and is null when empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();   // never 0 — that would read as "instant"
  });
});

describe('buildVelocityFacts', () => {
  const events = [
    { conversation_id: 1, kommun_namn: 'A', received_at: '2026-07-06T10:00:00Z' }, // W28
    { conversation_id: 1, kommun_namn: 'A', received_at: '2026-07-06T11:00:00Z' }, // W28
    { conversation_id: 2, kommun_namn: 'B', received_at: '2026-07-27T10:00:00Z' }, // W31
  ];
  const timings = [
    { conversation_id: 1, kommun_namn: 'A', first_outbound_at: '2026-07-01T00:00:00Z',
      first_human_inbound_at: '2026-07-03T00:00:00Z', first_contract_at: '2026-07-06T10:00:00Z' },
    { conversation_id: 2, kommun_namn: 'B', first_outbound_at: '2026-07-01T00:00:00Z',
      first_human_inbound_at: '2026-07-11T00:00:00Z', first_contract_at: '2026-07-27T10:00:00Z' },
    { conversation_id: 3, kommun_namn: 'C', first_outbound_at: '2026-07-21T00:00:00Z',
      first_human_inbound_at: null, first_contract_at: null },
  ];
  const files = { total: 10, by_type: [{ document_type: 'avtal', n: 3 }, { document_type: 'bilaga', n: 7 }] };
  const facts = () => buildVelocityFacts({ contractEvents: events, caseTimings: timings, files, now: NOW });

  it('buckets avtal by week and fills the empty weeks between', () => {
    const w = facts().weeks;
    // W28 and W31 have data; W29 and W30 are empty but MUST be present, so a
    // gap in collection reads as a gap rather than disappearing.
    expect(w.map((x) => x.iso_week)).toEqual(['2026-W28', '2026-W29', '2026-W30', '2026-W31']);
    expect(w.map((x) => x.contracts)).toEqual([2, 0, 0, 1]);
    expect(w.map((x) => x.cumulative)).toEqual([2, 2, 2, 3]);
    expect(w.map((x) => x.kommuner)).toEqual([1, 0, 0, 1]);
  });

  it('reports medians with range and sample size, over conversations', () => {
    const t = facts().timings;
    expect(t.first_human_reply).toMatchObject({ median: 6, min: 2, max: 10, n: 2, of: 3 });
    expect(t.first_contract).toMatchObject({ median: 15, min: 5, max: 26, n: 2, of: 3 });
  });

  it('counts the funnel from real events', () => {
    expect(facts().funnel).toEqual({ contacted: 3, human_replied: 2, delivered: 2 });
  });

  it('lists still-silent kommuner, longest wait first', () => {
    expect(facts().silent).toEqual([{ conversation_id: 3, kommun_namn: 'C', days_waiting: 10 }]);
  });

  it('passes the file split through, with avtal derived from by_type', () => {
    expect(facts().files).toMatchObject({ total: 10, avtal: 3 });
  });

  it('drops negative durations rather than counting them as zero', () => {
    // An inbound stamped before our first outbound (clock skew / late match).
    const odd = [{ conversation_id: 9, kommun_namn: 'Z', first_outbound_at: '2026-07-10T00:00:00Z',
      first_human_inbound_at: '2026-07-01T00:00:00Z', first_contract_at: null }];
    const f = buildVelocityFacts({ contractEvents: [], caseTimings: odd, files, now: NOW });
    expect(f.timings.first_human_reply).toMatchObject({ median: null, n: 0, of: 1 });
  });

  it('is safe on an empty pilot', () => {
    const f = buildVelocityFacts({ contractEvents: [], caseTimings: [], files: { total: 0, by_type: [] }, now: NOW });
    expect(f.weeks).toEqual([]);
    expect(f.timings.first_contract).toMatchObject({ median: null, n: 0, of: 0 });
    expect(f.funnel).toEqual({ contacted: 0, human_replied: 0, delivered: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/collection-velocity.test.js`
Expected: FAIL — `Cannot find module '../src/collection-velocity.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/collection-velocity.js
// Pure collection-velocity facts: how fast avtal are actually arriving.
// No IO, no DB — callers pass stored rows in (same rule as vendor-kb.js).
// Every figure carries its own sample size; an empty sample is null, never 0,
// because "0 dagar" would read as instant. See
// docs/superpowers/specs/2026-07-31-collection-velocity-design.md

const DAY_MS = 86400000;

// ISO week (Mon-Sun) of an instant, plus the date its Monday falls on.
export function isoWeek(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;                 // Mon=0 … Sun=6
  const monday = new Date(d.getTime() - day * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  // ISO week number: Thursday of this week decides the year.
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const jan1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.floor((thursday - jan1) / (7 * DAY_MS)) + 1;
  return {
    iso_week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`,
    week_start: monday.toISOString().slice(0, 10),
  };
}

export function median(nums) {
  const xs = [...nums].sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

const round1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

// Durations in whole days between two ISO instants. Negative spans (an inbound
// stamped before our first outbound) are dropped by the caller, never clamped
// to 0 — a fabricated zero would flatter the median.
function daysBetween(a, b) { return (new Date(b) - new Date(a)) / DAY_MS; }

function spanStats(rows, from, to, of) {
  const days = rows
    .filter((r) => r[from] && r[to])
    .map((r) => daysBetween(r[from], r[to]))
    .filter((d) => d >= 0);
  return {
    median: round1(median(days)),
    min: days.length ? round1(Math.min(...days)) : null,
    max: days.length ? round1(Math.max(...days)) : null,
    n: days.length,
    of,
  };
}

export function buildVelocityFacts({ contractEvents = [], caseTimings = [], files = { total: 0, by_type: [] }, now }) {
  // --- weeks: bucket, then fill the gaps so a silent stretch stays visible ---
  const byWeek = new Map();
  for (const e of contractEvents) {
    const { iso_week, week_start } = isoWeek(e.received_at);
    const w = byWeek.get(iso_week) ?? { iso_week, week_start, contracts: 0, kommuner: new Set() };
    w.contracts += 1;
    w.kommuner.add(e.conversation_id);
    byWeek.set(iso_week, w);
  }
  const ordered = [...byWeek.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
  const weeks = [];
  if (ordered.length) {
    let cursor = new Date(ordered[0].week_start + 'T00:00:00Z');
    const last = new Date(ordered[ordered.length - 1].week_start + 'T00:00:00Z');
    let cumulative = 0;
    while (cursor <= last) {
      const key = isoWeek(cursor.toISOString());
      const hit = byWeek.get(key.iso_week);
      cumulative += hit?.contracts ?? 0;
      weeks.push({
        iso_week: key.iso_week, week_start: key.week_start,
        contracts: hit?.contracts ?? 0,
        cumulative,
        kommuner: hit ? hit.kommuner.size : 0,
      });
      cursor = new Date(cursor.getTime() + 7 * DAY_MS);
    }
  }

  // --- timings + funnel over conversations (not messages, so one chatty
  //     kommun cannot weight the median) ---
  const contacted = caseTimings.filter((c) => c.first_outbound_at);
  const timings = {
    first_human_reply: spanStats(contacted, 'first_outbound_at', 'first_human_inbound_at', contacted.length),
    first_contract: spanStats(contacted, 'first_outbound_at', 'first_contract_at', contacted.length),
  };
  const funnel = {
    contacted: contacted.length,
    human_replied: contacted.filter((c) => c.first_human_inbound_at).length,
    delivered: contacted.filter((c) => c.first_contract_at).length,
  };

  // --- silent: contacted, no human reply yet, longest wait first ---
  const silent = contacted
    .filter((c) => !c.first_human_inbound_at)
    .map((c) => ({
      conversation_id: c.conversation_id,
      kommun_namn: c.kommun_namn,
      days_waiting: Math.floor(daysBetween(c.first_outbound_at, now)),
    }))
    .filter((c) => c.days_waiting >= 0)
    .sort((a, b) => b.days_waiting - a.days_waiting || a.kommun_namn.localeCompare(b.kommun_namn));

  const avtal = files.by_type.find((t) => t.document_type === 'avtal')?.n ?? 0;

  return { weeks, timings, funnel, silent, files: { total: files.total, avtal, by_type: files.by_type } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/collection-velocity.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/collection-velocity.js tests/collection-velocity.test.js
git commit -m "feat(velocity): pure collection-velocity facts over stored rows"
```

---

## Task 2: Storage queries

**Files:**
- Modify: `src/storage.js` (add three functions + export them in the returned object)
- Test: `tests/storage-velocity.test.js`

**Interfaces:**
- Produces, on the object `openDb()` returns:
  - `listContractDeliveryEvents()` → `[{ conversation_id, kommun_namn, received_at }]`
    for every `contracts.is_contract = 1`.
  - `listCaseTimings()` → `[{ conversation_id, kommun_namn, first_outbound_at,
    first_human_inbound_at, first_contract_at }]` per conversation.
  - `countFilesByDocumentType()` → `{ total, by_type: [{ document_type, n }] }`.
- Consumes: nothing from Task 1 (shapes are matched by contract, verified here).

**Robot definition** lives in exactly one place — this query. `auto_ack` and
`auto_reply` are machine replies; `unknown` and NULL count as human because no
robot marker matched.

- [ ] **Step 1: Write the failing test**

```js
// tests/storage-velocity.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let dir, db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vel-'));
  db = openDb(join(dir, 'test.db'));
  db.migrate();
});
afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

function seedCase({ kod, namn, out, inbounds = [], contractAt = null }) {
  const convId = db.createConversation({ kommun_kod: kod, kommun_namn: namn, role: 'central', contact_email: `k@${kod}.se`, scheduled_send_at: out });
  db.recordMessage({ conversation_id: convId, gmail_message_id: `out-${kod}`, direction: 'outbound',
    from_email: 'me@x.se', to_email: `k@${kod}.se`, subject: 'B', body_text: 'b',
    classification: null, classification_confidence: null, received_at: out });
  for (const [i, m] of inbounds.entries()) {
    db.recordMessage({ conversation_id: convId, gmail_message_id: `in-${kod}-${i}`, direction: 'inbound',
      from_email: `k@${kod}.se`, to_email: 'me@x.se', subject: 'Sv', body_text: 'b',
      classification: m.cls, classification_confidence: 0.9, received_at: m.at });
  }
  return convId;
}

describe('velocity storage queries', () => {
  it('first_human_inbound_at skips auto_ack and auto_reply but accepts unknown', () => {
    seedCase({ kod: '0001', namn: 'Alfa', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'auto_ack',  at: '2026-07-01T01:00:00Z' },   // robot — skipped
      { cls: 'auto_reply', at: '2026-07-02T00:00:00Z' },  // robot — skipped
      { cls: 'unknown',   at: '2026-07-04T00:00:00Z' },   // human — this one counts
      { cls: 'delivery',  at: '2026-07-05T00:00:00Z' },
    ] });
    const [row] = db.listCaseTimings();
    expect(row.first_outbound_at).toBe('2026-07-01T00:00:00Z');
    expect(row.first_human_inbound_at).toBe('2026-07-04T00:00:00Z');
  });

  it('reports a contacted kommun with no human reply as null, not missing', () => {
    seedCase({ kod: '0002', namn: 'Beta', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'auto_ack', at: '2026-07-01T02:00:00Z' },
    ] });
    const rows = db.listCaseTimings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kommun_namn: 'Beta', first_human_inbound_at: null, first_contract_at: null });
  });

  it('counts only is_contract=1 as a delivery event, and splits files by type', () => {
    const convId = seedCase({ kod: '0003', namn: 'Gamma', out: '2026-07-01T00:00:00Z', inbounds: [
      { cls: 'delivery', at: '2026-07-08T00:00:00Z' },
    ] });
    const msgId = db.raw.prepare("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'inbound'").get(convId).id;
    const att = (name) => db.raw.prepare(
      'INSERT INTO attachments (message_id, filename, mime_type, size_bytes) VALUES (?,?,?,?)'
    ).run(msgId, name, 'application/pdf', 10).lastInsertRowid;
    const a1 = att('avtal.pdf'), a2 = att('bilaga.pdf');
    const vId = db.upsertVendor('Testleverantör').id;
    db.raw.prepare('INSERT INTO contracts (attachment_id, vendor_id, is_contract, document_type, analysis_json) VALUES (?,?,?,?,?)')
      .run(a1, vId, 1, 'avtal', '{}');
    db.raw.prepare('INSERT INTO contracts (attachment_id, vendor_id, is_contract, document_type, analysis_json) VALUES (?,?,?,?,?)')
      .run(a2, vId, 0, 'bilaga', '{}');

    const events = db.listContractDeliveryEvents();
    expect(events).toEqual([{ conversation_id: convId, kommun_namn: 'Gamma', received_at: '2026-07-08T00:00:00Z' }]);
    expect(db.listCaseTimings()[0].first_contract_at).toBe('2026-07-08T00:00:00Z');

    const files = db.countFilesByDocumentType();
    expect(files.total).toBe(2);
    expect(files.by_type).toEqual(expect.arrayContaining([
      { document_type: 'avtal', n: 1 }, { document_type: 'bilaga', n: 1 },
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage-velocity.test.js`
Expected: FAIL — `db.listCaseTimings is not a function`.

- [ ] **Step 3: Write the implementation**

Add near `listContractInfoForConversation` in `src/storage.js`:

```js
  // --- Collection velocity (read-only; no schema change) ---
  // A machine reply is auto_ack (diariesystem receipt) or auto_reply (OOO).
  // `unknown` and NULL count as HUMAN: no robot marker matched, so a person
  // almost certainly wrote it. This is the ONLY place that definition lives.
  const ROBOT_CLASSES = "('auto_ack','auto_reply')";

  function listContractDeliveryEvents() {
    return db.prepare(`
      SELECT m.conversation_id AS conversation_id, conv.kommun_namn AS kommun_namn,
             m.received_at AS received_at
      FROM contracts c
      JOIN attachments a ON a.id = c.attachment_id
      JOIN messages m ON m.id = a.message_id
      JOIN conversations conv ON conv.id = m.conversation_id
      WHERE c.is_contract = 1
      ORDER BY m.received_at
    `).all();
  }

  function listCaseTimings() {
    return db.prepare(`
      SELECT conv.id AS conversation_id, conv.kommun_namn AS kommun_namn,
        (SELECT min(m.received_at) FROM messages m
           WHERE m.conversation_id = conv.id AND m.direction = 'outbound') AS first_outbound_at,
        (SELECT min(m.received_at) FROM messages m
           WHERE m.conversation_id = conv.id AND m.direction = 'inbound'
             AND COALESCE(m.classification, 'unknown') NOT IN ${ROBOT_CLASSES}) AS first_human_inbound_at,
        (SELECT min(m.received_at) FROM contracts c
           JOIN attachments a ON a.id = c.attachment_id
           JOIN messages m ON m.id = a.message_id
           WHERE m.conversation_id = conv.id AND c.is_contract = 1) AS first_contract_at
      FROM conversations conv
      ORDER BY conv.id
    `).all();
  }

  function countFilesByDocumentType() {
    const total = db.prepare('SELECT count(*) AS n FROM attachments').get().n;
    const by_type = db.prepare(`
      SELECT COALESCE(c.document_type, 'ej analyserad') AS document_type, count(*) AS n
      FROM attachments a
      LEFT JOIN contracts c ON c.attachment_id = a.id
      GROUP BY document_type
      ORDER BY n DESC
    `).all();
    return { total, by_type };
  }
```

Export them alongside `listContractInfoForConversation`:

```js
    listContractDeliveryEvents,
    listCaseTimings,
    countFilesByDocumentType,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage-velocity.test.js`
Expected: PASS (3 tests). If `upsertVendor`'s return shape differs, read the
function in `storage.js` and adjust the test's `vId` line — do not change the
query.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/storage-velocity.test.js
git commit -m "feat(storage): read-only velocity queries (delivery events, case timings, file split)"
```

---

## Task 3: Correct the `Avtal mottagna` headline

**Files:**
- Modify: `src/dashboard.js` (`buildOverviewRows` — the `attachmentCounts` query
  around line 213)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: nothing new. Produces: `row.contracts` and `summary.contracts` now
  mean **avtal** (`is_contract = 1`), not attachments.

The tile and the per-kommun column both read from the same count, so both
change together — that is the point: today they agree with each other only
because they are both wrong.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard.test.js — add inside the existing describe for overview rows
it('counts real avtal, not every attachment, for the tile and the column', async () => {
  // 3 files on one delivery: 1 avtal, 1 bilaga, 1 unanalysed. Only the avtal counts.
  const convId = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
    contact_email: 'k@mala.se', scheduled_send_at: '2026-07-01T00:00:00Z' });
  db.recordMessage({ conversation_id: convId, gmail_message_id: 'in-x', direction: 'inbound',
    from_email: 'k@mala.se', to_email: 'me@x.se', subject: 'Sv', body_text: 'b',
    classification: 'delivery', classification_confidence: 0.9, received_at: '2026-07-08T00:00:00Z' });
  const msgId = db.raw.prepare("SELECT id FROM messages WHERE gmail_message_id = 'in-x'").get().id;
  const att = (n) => db.raw.prepare('INSERT INTO attachments (message_id, filename, mime_type, size_bytes) VALUES (?,?,?,?)')
    .run(msgId, n, 'application/pdf', 10).lastInsertRowid;
  const a1 = att('avtal.pdf'), a2 = att('bilaga.pdf'); att('okand.pdf');
  const vId = db.upsertVendor('Lev').id;
  db.raw.prepare('INSERT INTO contracts (attachment_id, vendor_id, is_contract, document_type, analysis_json) VALUES (?,?,?,?,?)').run(a1, vId, 1, 'avtal', '{}');
  db.raw.prepare('INSERT INTO contracts (attachment_id, vendor_id, is_contract, document_type, analysis_json) VALUES (?,?,?,?,?)').run(a2, vId, 0, 'bilaga', '{}');

  const rows = buildOverviewRows({ db, municipalities: [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }] });
  expect(rows.find((r) => r.kommun_kod === '2418').contracts).toBe(1);   // not 3
});
```

Check `buildOverviewRows`'s real call signature in `src/dashboard.js` before
writing this and match it exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "counts real avtal"`
Expected: FAIL — `expected 3 to be 1`. **If it passes, the test is wrong** —
the current query counts attachments; fix the test before touching the source.

- [ ] **Step 3: Write the implementation**

In `buildOverviewRows`, replace the attachment count with an avtal count:

```js
        SELECT m.conversation_id, count(c.id) as n
        FROM contracts c
        JOIN attachments a ON a.id = c.attachment_id
        JOIN messages m ON m.id = a.message_id
        WHERE c.is_contract = 1
        GROUP BY m.conversation_id
```

Rename the local `attachmentCounts` / `attachByConvId` to `avtalCounts` /
`avtalByConvId` so the name stops lying, and update the two use sites.

- [ ] **Step 4: Run the full suite** (other tests assert overview counts)

Run: `npx vitest run`
Expected: PASS. Any test asserting a file-based count must be updated to the
avtal count — update the assertion, not the query.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.js
git commit -m "fix(overview): Avtal mottagna counts real avtal, not every attachment"
```

---

## Task 4: `/takt` route + view

**Files:**
- Modify: `src/dashboard-views.js` (add `renderVelocity`, chart CSS, tile link, nav item)
- Modify: `src/dashboard.js` (add the `GET /takt` route)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `buildVelocityFacts` (Task 1), the three storage queries (Task 2).
- Produces: `export function renderVelocity({ facts, heartbeat, partial, escalationCount })` → HTML string.

**Chart construction (follow exactly):**
- **Two stacked panels, one shared x-axis.** Panel A: bars, avtal per week.
  Panel B: a 2px cumulative line. **Never one plot with two y-scales.**
- Bars: `rx="4"` rounded data-ends anchored to the baseline, 2px gap between
  adjacent bars, fill `var(--chart-series)`.
- Grid/axis lines `var(--border)`; tick and axis labels `var(--fg-muted)`,
  11px. One series per panel, so **no legend** — each panel's `<h3>` names it.
- Hover: a `<title>` element inside each bar and each line marker gives a native
  tooltip with no JS (`"v.28: 16 avtal, 3 kommuner"`).
- Accessibility: `role="img"` + `aria-label` on each `<svg>`, and the same
  numbers repeated in a `<table>` below the chart — that table is both the
  screen-reader path and the honest figures.
- Empty pilot: render `<p class="empty-state">Inga avtal mottagna än.</p>`
  instead of an axis with no marks.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard.test.js — add
describe('/takt collection velocity', () => {
  it('renders the two panels, the definitions and the numbers', async () => {
    const app = appWithFakes();
    const res = await get(app, '/takt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Avtal per vecka');
    expect(res.text).toContain('Kumulativt');
    expect(res.text).toContain('<svg');
    // The robot definition must be stated on the page, not just in the spec.
    expect(res.text).toMatch(/autosvar/i);
    // No dual axis: the two series live in two separate <svg> panels.
    expect((res.text.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('says so plainly when nothing has arrived yet', async () => {
    const app = appWithFakes();
    const res = await get(app, '/takt');
    expect(res.text).toMatch(/Inga avtal mottagna än|Avtal per vecka/);
  });
});

it('links the Avtal-mottagna tile to /takt', () => {
  const html = renderOverview({
    summary: { in_pilot: 0, delivering: 0, done: 0, dead_end: 0, contracts: 7, avg_reply_days: null },
    rows: [], totalKommuner: 0, filter: 'all',
  });
  expect(html).toMatch(/href="\/takt"[^>]*>[\s\S]{0,200}Avtal mottagna|Avtal mottagna[\s\S]{0,200}href="\/takt"/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "takt"`
Expected: FAIL — 404 on `/takt`.

- [ ] **Step 3: Write the implementation**

Chart tokens, added to the two `:root` blocks in `baseCss`:

```css
  /* Chart marks. Validated with the dataviz palette validator against the
     card surface: light #4f46e5 on #ffffff PASS; dark #6d7ff5 on #14181d PASS.
     The UI accent #818cf8 FAILS the dark lightness band (0.68 > 0.67), which
     is why the chart carries its own token. */
  --chart-series: #4f46e5;
```
```css
  /* in :root[data-theme="dark"] */
  --chart-series: #6d7ff5;
```

`renderVelocity` builds both panels with plain string interpolation over
`facts.weeks` — bar `x` from the index, `height` from
`contracts / maxContracts`, the polyline points from
`cumulative / maxCumulative`. Then the timing blocks
(`median · spann min–max · n av <of> kontaktade`, `—` when `median === null`),
the funnel, the silent list (first 10, then `+N fler` when longer), and the
file split.

Route in `src/dashboard.js`:

```js
  app.get('/takt', (req, res) => {
    if (!db) return res.status(503).send('No DB');
    const facts = buildVelocityFacts({
      contractEvents: db.listContractDeliveryEvents(),
      caseTimings: db.listCaseTimings(),
      files: db.countFilesByDocumentType(),
      now: new Date().toISOString(),
    });
    res.send(renderVelocity({
      facts,
      heartbeat: db.getHeartbeat?.() ?? null,
      partial: isPartial(req),
      escalationCount: countOpenEscalations(db),
    }));
  });
```

Match `isPartial` / `escalationCount` to how the neighbouring routes do it —
read one first (e.g. the `/activity` route) and copy its exact idiom.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): /takt collection-velocity page with weekly avtal chart"
```

---

## Task 5: Render check + deploy

**Files:** none (verification only)

- [ ] **Step 1: Full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 2: Look at the page**

The validator checks color, not layout. Serve the dashboard against a temp DB
seeded with a few weeks of events (or the harness pattern used for the Skicka
fix) and open `/takt` in a browser. Check: no label collisions on the week
axis, bars not overflowing the panel, the empty-week gap visible, both themes
legible. **Do not point a Gmail-configured dashboard at the live DB for this.**

- [ ] **Step 3: Deploy**

```bash
git push origin main
AWS_PROFILE=personal ./deploy/deploy.sh
```

- [ ] **Step 4: Verify live**

Confirm `pilot-daemon` and `pilot-dashboard` are `active`, then open
`/takt` in the browser and check the headline reads 91 rather than 154.

---

## Self-Review

- **Spec coverage:** `/takt` page → Tasks 4–5. Pure module + all five facts →
  Task 1. Three read-only queries + the robot definition → Task 2. Tile and
  column correction → Task 3. Definitions shown on the page → Task 4 (asserted
  by test). Week gaps, median-not-mean, negative-duration drop, empty-sample
  `null` → Task 1 tests. Silent-list cap → Task 4.
- **Placeholder scan:** no TBD/TODO; every code step carries real code. Two
  steps deliberately say "read the neighbouring code first and match its idiom"
  (`buildOverviewRows`'s signature, `isPartial`) rather than guessing at a
  signature I have not verified — that is an instruction, not a placeholder.
- **Type consistency:** `buildVelocityFacts` returns `{weeks, timings, funnel,
  silent, files}` in Task 1 and is consumed with those exact keys in Task 4.
  `listContractDeliveryEvents` returns `{conversation_id, kommun_namn,
  received_at}` in Task 2, matching Task 1's `contractEvents` input.
  `listCaseTimings` returns the five fields Task 1's `caseTimings` expects.
  `countFilesByDocumentType` returns `{total, by_type}`, matching Task 1's
  `files`.
