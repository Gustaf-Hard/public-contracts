# Handoff-kontakter + kontaktkällor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface handoff e-postadresser (som kommunen explicit angav i mejl) som kontakter på kommun-sidan och i compose, med källa-badge och trust-rang (handoff > webbplats), utan att mutera `data/municipalities.json`.

**Architecture:** A storage query (`listHandoffContacts`) derives handoff addresses from `messages.analysis_json` via SQL `json_extract`. A pure view helper (`mergeContacts`) unifies dataset + handoff contacts into one source-tagged, trust-sorted list. The kommun page renders that list with badges; the compose route uses it (handoff-first) for candidate e-mail ordering.

**Tech Stack:** Node 20 ESM, better-sqlite3 (json_extract), express, vitest (offline).

**Spec:** `docs/superpowers/specs/2026-06-09-handoff-contacts-and-sources-design.md`

## File structure

| File | Responsibility |
|---|---|
| `src/storage.js` (modify) | `listHandoffContacts(kommunKod)` — derive handoff addresses from analysis_json |
| `src/dashboard-views.js` (modify) | `mergeContacts(dataset, handoff)` pure helper + source-badged contacts section |
| `src/dashboard.js` (modify) | kommun route passes handoff contacts; compose route trust-sorts candidates |
| `tests/contracts-storage.test.js` (modify) | `listHandoffContacts` tests |
| `tests/dashboard.test.js` (modify) | merge/badge + compose ordering tests |

---

### Task 1: `listHandoffContacts` storage helper

**Files:**
- Modify: `src/storage.js` (helper inside `openDb` + export it)
- Test: `tests/contracts-storage.test.js`

- [ ] **Step 1: Append failing tests** to `tests/contracts-storage.test.js`:

```js
describe('listHandoffContacts', () => {
  function seedConvWithHandoff({ kommun_kod = '1984', role = 'central', handoff_email = 'barn.utbildning@arboga.se', handoff_forv = 'Barn- och utbildningsförvaltningen' } = {}) {
    const convId = db.createConversation({
      kommun_kod, kommun_namn: 'Arboga', role,
      contact_email: 'arboga.kommun@arboga.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'arboga.kommun@arboga.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta BoU',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: handoff_email, handoff_to_forvaltning: handoff_forv } },
    });
    return convId;
  }

  it('extracts handoff_to_email + forvaltning + role for a kommun', () => {
    seedConvWithHandoff();
    const rows = db.listHandoffContacts('1984');
    expect(rows).toEqual([
      { email: 'barn.utbildning@arboga.se', forvaltning: 'Barn- och utbildningsförvaltningen', role: 'central' },
    ]);
  });

  it('dedups repeated handoff addresses (case-insensitive)', () => {
    seedConvWithHandoff();
    seedConvWithHandoff({ role: 'utbildning', handoff_email: 'BARN.UTBILDNING@arboga.se' });
    const rows = db.listHandoffContacts('1984');
    expect(rows).toHaveLength(1);
  });

  it('ignores messages without a handoff address; empty for unknown kommun', () => {
    const convId = db.createConversation({
      kommun_kod: '1980', kommun_namn: 'Västerås', role: 'central',
      contact_email: 'r@v.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'r@v.se', to_email: 'me@x.com', subject: 'Re', body_text: 'hej',
      classification: 'auto_ack', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'auto_ack', extracted: { handoff_to_email: null } },
    });
    expect(db.listHandoffContacts('1980')).toEqual([]);
    expect(db.listHandoffContacts('0000')).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/contracts-storage.test.js` → FAIL (`listHandoffContacts is not a function`).

- [ ] **Step 3: Implement** in `src/storage.js` — add helper inside `openDb` and add `listHandoffContacts` to the returned object:

```js
function listHandoffContacts(kommunKod) {
  // Handoff addresses the kommun explicitly gave us, derived from inbound
  // LLM analysis. Dedup by lowercased email; first occurrence wins for role.
  const rows = db.prepare(`
    SELECT conv.role AS role,
           json_extract(m.analysis_json, '$.extracted.handoff_to_email') AS email,
           json_extract(m.analysis_json, '$.extracted.handoff_to_forvaltning') AS forvaltning
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    WHERE conv.kommun_kod = ?
      AND m.direction = 'inbound'
      AND email IS NOT NULL AND email != ''
    ORDER BY m.received_at, m.id
  `).all(kommunKod);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ email: r.email, forvaltning: r.forvaltning ?? null, role: r.role });
  }
  return out;
}
```

- [ ] **Step 4:** Run `npx vitest run tests/contracts-storage.test.js` → PASS. Run `npx vitest run tests/storage.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/contracts-storage.test.js
git commit -m "feat(storage): listHandoffContacts — derive kommun-given addresses from analysis_json"
```

---

### Task 2: `mergeContacts` pure helper

**Files:**
- Modify: `src/dashboard-views.js` (exported pure helper)
- Test: `tests/dashboard-views-contacts.test.js` (create — pure unit test, no server)

- [ ] **Step 1: Write failing test** — create `tests/dashboard-views-contacts.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mergeContacts, contactSourceLabel } from '../src/dashboard-views.js';

describe('contactSourceLabel', () => {
  it('maps source to Swedish label', () => {
    expect(contactSourceLabel('kommun_handoff')).toBe('kommunen angav i mejl');
    expect(contactSourceLabel('website')).toBe('hittad på webbplats');
  });
});

describe('mergeContacts', () => {
  const dataset = [{ email: 'arboga.kommun@arboga.se', role: 'central', forvaltning_namn: null }];
  const handoff = [{ email: 'barn.utbildning@arboga.se', role: 'central', forvaltning: 'Barn- och utbildningsförvaltningen' }];

  it('tags sources and ranks handoff first', () => {
    const merged = mergeContacts(dataset, handoff);
    expect(merged.map((c) => c.email)).toEqual(['barn.utbildning@arboga.se', 'arboga.kommun@arboga.se']);
    expect(merged[0].source).toBe('kommun_handoff');
    expect(merged[0].forvaltning).toBe('Barn- och utbildningsförvaltningen');
    expect(merged[1].source).toBe('website');
  });

  it('handoff wins on duplicate email (highest trust)', () => {
    const merged = mergeContacts(
      [{ email: 'X@arboga.se', role: 'central' }],
      [{ email: 'x@arboga.se', role: 'central', forvaltning: 'BoU' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('kommun_handoff');
  });

  it('handles empty inputs', () => {
    expect(mergeContacts([], [])).toEqual([]);
    expect(mergeContacts(undefined, undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/dashboard-views-contacts.test.js` → FAIL (not exported).

- [ ] **Step 3: Implement** in `src/dashboard-views.js` (add near the other contact helpers, export both):

```js
const CONTACT_SOURCE_LABELS = {
  kommun_handoff: 'kommunen angav i mejl',
  website: 'hittad på webbplats',
};
export function contactSourceLabel(source) {
  return CONTACT_SOURCE_LABELS[source] ?? source;
}

// Unify dataset contacts (website) and handoff contacts (kommun_handoff) into a
// single source-tagged list. Dedup by lowercased email; highest trust wins
// (kommun_handoff > website). Sort: trust first, then email.
export function mergeContacts(datasetContacts = [], handoffContacts = []) {
  const TRUST = { kommun_handoff: 0, website: 1 };
  const byEmail = new Map();
  const add = (email, role, forvaltning, source) => {
    if (!email) return;
    const key = email.toLowerCase();
    const existing = byEmail.get(key);
    if (existing && TRUST[existing.source] <= TRUST[source]) return; // keep higher trust
    byEmail.set(key, { email, role, forvaltning: forvaltning ?? null, source });
  };
  for (const c of handoffContacts ?? []) add(c.email, c.role, c.forvaltning, 'kommun_handoff');
  for (const c of datasetContacts ?? []) add(c.email, c.role, c.forvaltning_namn ?? c.forvaltning, 'website');
  return [...byEmail.values()].sort((a, b) =>
    (TRUST[a.source] - TRUST[b.source]) || a.email.localeCompare(b.email));
}
```

- [ ] **Step 4:** Run `npx vitest run tests/dashboard-views-contacts.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-views.js tests/dashboard-views-contacts.test.js
git commit -m "feat(views): mergeContacts — unified source-tagged, trust-ranked contacts"
```

---

### Task 3: Kommun page renders merged contacts with source badges

**Files:**
- Modify: `src/dashboard.js` (kommun route passes `handoffContacts`)
- Modify: `src/dashboard-views.js` (`renderKommunDetail` param + contacts section)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing test** — append to `tests/dashboard.test.js`:

```js
describe('kommun page contact sources', () => {
  it('shows handoff address with source badge, ranked above website contact', async () => {
    const convId = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta BoU',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: 'bou@mala.se', handoff_to_forvaltning: 'BoU' } },
    });
    const app = createDashboardApp({
      db,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1,
        contacts: [{ email: 'kommun@mala.se', role: 'central' }] }],
    });
    const res = await get(app, '/kommun/2418');
    expect(res.text).toContain('bou@mala.se');
    expect(res.text).toContain('kommunen angav i mejl');
    expect(res.text).toContain('hittad på webbplats');
    // handoff address appears before the website address in the contacts section
    expect(res.text.indexOf('bou@mala.se')).toBeLessThan(res.text.indexOf('kommun@mala.se'));
  });
});
```

- [ ] **Step 2:** Run `npx vitest run tests/dashboard.test.js -t "contact sources"` → FAIL.

- [ ] **Step 3: Implement.**

(a) `src/dashboard.js` — in the `/kommun/:kod` handler, before the `renderKommunDetail({...})` call, add:
```js
    const handoffContacts = db ? db.listHandoffContacts(kommun.kommun_kod) : [];
```
and pass `handoffContacts,` into the `renderKommunDetail({...})` call (alongside `vendorSlugsByName`).

(b) `src/dashboard-views.js` — add `handoffContacts = []` to the `renderKommunDetail` destructured params (next to `vendorSlugsByName`). Replace the `datasetContacts` block:
```js
  const datasetContacts = (kommun.contacts ?? []).length === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga adresser i datasetet.</p>'
    : `<ul class="plain">${(kommun.contacts ?? []).map((c) => `<li><code>${escapeHtml(c.email)}</code><br><span class="muted" style="font-size:11px">${escapeHtml(c.role)}${c.forvaltning_namn ? ' · ' + escapeHtml(c.forvaltning_namn) : ''}</span></li>`).join('')}</ul>`;
```
with:
```js
  const mergedContacts = mergeContacts(kommun.contacts ?? [], handoffContacts);
  const datasetContacts = mergedContacts.length === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga adresser.</p>'
    : `<ul class="plain">${mergedContacts.map((c) => {
        const badgeClass = c.source === 'kommun_handoff' ? 'pill pill-promise' : 'pill pill-default';
        return `<li><code>${escapeHtml(c.email)}</code><br><span class="muted" style="font-size:11px">${escapeHtml(c.role ?? '')}${c.forvaltning ? ' · ' + escapeHtml(c.forvaltning) : ''}</span><br><span class="${badgeClass}" style="margin-top:3px">${escapeHtml(contactSourceLabel(c.source))}</span></li>`;
      }).join('')}</ul>`;
```
Also update the section heading from "E-postadresser i datasetet" to "E-postadresser" (the list now mixes sources). Find the `<h3>E-postadresser i datasetet</h3>` and change to `<h3>E-postadresser</h3>`.

- [ ] **Step 4:** Run `npx vitest run tests/dashboard.test.js` → PASS (all). Run `npx vitest run` → ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): kommun contacts merge handoff addresses with source badges"
```

---

### Task 4: Compose candidates include handoff, trust-sorted

**Files:**
- Modify: `src/dashboard.js` (compose route candidate ordering)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing test** — append to `tests/dashboard.test.js`:

```js
describe('compose candidates prefer handoff addresses', () => {
  it('lists the handoff address first for the selected role', async () => {
    const convId = db.createConversation({
      kommun_kod: '2418', kommun_namn: 'Malå', role: 'gymnasie',
      contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
    });
    db.recordMessage({
      conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
      from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Kontakta central',
      classification: 'handoff', classification_confidence: 0.9,
      received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
      analysis_json: { intent: 'handoff', extracted: { handoff_to_email: 'registrator@mala.se', handoff_to_forvaltning: 'Kommunkansliet' } },
    });
    const app = createDashboardApp({
      db,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1,
        contacts: [{ email: 'central@mala.se', role: 'central' }] }],
    });
    const res = await get(app, '/kommun/2418/compose?role=central');
    expect(res.text).toContain('registrator@mala.se');
    expect(res.text.indexOf('registrator@mala.se')).toBeLessThan(res.text.indexOf('central@mala.se'));
  });
});
```

(The handoff address carries no role of its own — it is offered for whatever role the operator is composing; we merge it into every role's candidate list, trust-first.)

- [ ] **Step 2:** Run `npx vitest run tests/dashboard.test.js -t "compose candidates prefer"` → FAIL.

- [ ] **Step 3: Implement** in `src/dashboard.js` compose route. Find:
```js
      candidateEmails = (kommun.contacts ?? [])
        .filter((c) => c.role === selectedRole)
        .map((c) => c.email);
```
Replace with:
```js
      const handoffContacts = db ? db.listHandoffContacts(kommun.kommun_kod) : [];
      const datasetForRole = (kommun.contacts ?? []).filter((c) => c.role === selectedRole);
      // Handoff addresses (kommun-given) rank first, then website addresses.
      const merged = mergeContacts(datasetForRole, handoffContacts);
      candidateEmails = merged.map((c) => c.email);
```
Add `mergeContacts` to the import from `./dashboard-views.js` if not already imported (Task 3 may have added it — check; the import list currently has `renderCompose` etc.).

- [ ] **Step 4:** Run `npx vitest run tests/dashboard.test.js` → PASS. Run `npx vitest run` → ALL pass.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.js
git commit -m "feat(dashboard): compose offers handoff addresses first as candidates"
```

---

### Task 5: Live verification

- [ ] **Step 1:** `npx vitest run` → all pass.
- [ ] **Step 2:** Restart dashboard. Visit `http://localhost:3100/kommun/1984` (Arboga) — confirm `barn.utbildning@arboga.se` appears in the E-postadresser section with a green "kommunen angav i mejl" badge, ranked above `arboga.kommun@arboga.se` ("hittad på webbplats").
- [ ] **Step 3:** Report results.

---

## Self-review notes

- Spec coverage: dynamic-from-pilot.db (Task 1, no municipalities.json mutation), source badge + trust rank (Task 2 mergeContacts), kommun page (Task 3), compose ordering (Task 4), live check (Task 5). ✓
- Type consistency: `listHandoffContacts → [{email, forvaltning, role}]`; `mergeContacts(dataset, handoff) → [{email, role, forvaltning, source}]`; both consumed in Tasks 3-4. ✓
- `mergeContacts` reads dataset `forvaltning_namn` OR `forvaltning` so it works for both shapes. ✓
