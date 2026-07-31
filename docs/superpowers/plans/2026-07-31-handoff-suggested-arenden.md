# Handoff → Suggested Ärenden Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a kommun redirects us to another förvaltning, show one suggested
ärende per extracted address on `/arenden/:id`, and start it with one click
through the existing `sendInitial` path.

**Architecture:** A pure module (`src/handoff.js`) derives targets from the
stored `analysis_json` at read time. The view renders them as rows; a POST
route re-derives them server-side, validates the posted address against that
set, and delegates to `sendInitial`. No schema change, no new send path, no
row created until the operator clicks.

**Tech Stack:** Node 20+ ESM, Express, vitest, better-sqlite3. No new deps.

**Spec:** `docs/superpowers/specs/2026-07-31-handoff-suggested-arenden-design.md`

## Global Constraints

- **Node 20+ ESM**; `src/handoff.js` is **pure** — no IO, no DB (same rule as
  `vendor-kb.js`, `coverage.js`, `collection-velocity.js`).
- **No schema change.** Suggestions are derived from `messages.analysis_json`;
  nothing is persisted.
- **Read `analysis_json.intent`, never the `classification` column.**
  `analysisToLegacyClassification` maps `handoff → 'unknown'` deliberately, so a
  rule keyed on `classification` silently never fires.
- **No conversation row until the operator clicks.** An `INITIAL` row with a due
  `scheduled_send_at` is auto-sent by the tick (`listConversationsDueForInitialSend`
  → `dispatchInitial`), which would defeat the whole point.
- **`sendInitial` is the only send path.** Reuse it verbatim; do not add another.
  Its two-phase `INITIAL → SENDING → SENT` claim is a safety invariant.
- **Domain matching is dot-anchored** (`d === home || d.endsWith('.' + home)`).
  A bare `endsWith` accepts `xgoteborg.se` — called out in CLAUDE.md.
- **No em-dash / en-dash** in any user-facing Swedish copy.
- **All tests offline**: temp-dir SQLite (`mkdtempSync` + `openDb` + `migrate()`),
  fixture JSON, Gmail faked via `vi.spyOn(gmailMod, 'sendMessage')`.
- **Fixture reality:** `messages` requires `attachment_count`;
  `attachments.saved_path` is `NOT NULL`. Both bite in test setup.

---

## Task 1: `src/handoff.js` — parse targets

**Files:**
- Create: `src/handoff.js`
- Test: `tests/handoff.test.js`

**Interfaces:**
- Produces:
```js
export function parseHandoffTargets({ analysis, bodyText, homeDomain, usedRoles = [] })
  → [{ email, forvaltning, verbatim, sameDomain, roleSlug }]
export function homeDomainFromWebbplats(webbplats) → string | null
```
`analysis` is the parsed `analysis_json` object. `usedRoles` are the roles that
already exist for that kommun, so `roleSlug` can be de-duplicated.

- [ ] **Step 1: Write the failing test**

```js
// tests/handoff.test.js
import { describe, it, expect } from 'vitest';
import { parseHandoffTargets, homeDomainFromWebbplats } from '../src/handoff.js';

// The real Göteborg #63 extraction (message 255), abbreviated body.
const GBG = {
  intent: 'handoff',
  extracted: {
    handoff_to_email: 'info@educ.goteborg.se;grundskola@grundskola.goteborg.se',
    handoff_to_forvaltning: 'Utbildningsförvaltningen och Grundskoleförvaltningen',
  },
};
const GBG_BODY = `Hej Gustaf, Vi på inköps- och upphandlingsförvaltningen har hand om gemensamma ramavtal.
Kontakta Utbildningsförvaltningen: info@educ.goteborg.se
och Grundskoleförvaltningen: grundskola@grundskola.goteborg.se`;

describe('homeDomainFromWebbplats', () => {
  it('strips scheme and www, and tolerates junk', () => {
    expect(homeDomainFromWebbplats('http://www.goteborg.se')).toBe('goteborg.se');
    expect(homeDomainFromWebbplats('https://mala.se/')).toBe('mala.se');
    expect(homeDomainFromWebbplats(null)).toBeNull();
    expect(homeDomainFromWebbplats('not a url')).toBeNull();
  });
});

describe('parseHandoffTargets', () => {
  const gbg = (over = {}) => parseHandoffTargets({
    analysis: GBG, bodyText: GBG_BODY, homeDomain: 'goteborg.se', ...over,
  });

  it('splits the Göteborg handoff into two paired targets', () => {
    const t = gbg();
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      email: 'info@educ.goteborg.se', forvaltning: 'Utbildningsförvaltningen',
      verbatim: true, sameDomain: true, roleSlug: 'utbildning',
    });
    expect(t[1]).toMatchObject({
      email: 'grundskola@grundskola.goteborg.se', forvaltning: 'Grundskoleförvaltningen',
      verbatim: true, sameDomain: true, roleSlug: 'grundskola',
    });
  });

  it('returns nothing for a non-handoff intent', () => {
    for (const intent of ['delivery', 'handoff_internal', 'auto_ack', 'clarification']) {
      expect(parseHandoffTargets({ analysis: { ...GBG, intent }, bodyText: GBG_BODY, homeDomain: 'goteborg.se' })).toEqual([]);
    }
    expect(parseHandoffTargets({ analysis: null, bodyText: '', homeDomain: 'x.se' })).toEqual([]);
  });

  it('flags an address the kommun never wrote', () => {
    // The hallucination signal: extraction says it, the body does not.
    const t = parseHandoffTargets({ analysis: GBG, bodyText: 'Hej, kontakta någon annan.', homeDomain: 'goteborg.se' });
    expect(t.map((x) => x.verbatim)).toEqual([false, false]);
  });

  it('rejects a look-alike domain but accepts a real subdomain', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@xgoteborg.se;b@educ.goteborg.se', handoff_to_forvaltning: 'X och Y' } },
      bodyText: 'a@xgoteborg.se b@educ.goteborg.se', homeDomain: 'goteborg.se',
    });
    expect(t.map((x) => x.sameDomain)).toEqual([false, true]);
  });

  it('keeps the full förvaltning text when the counts disagree', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se, b@k.se, c@k.se', handoff_to_forvaltning: 'Skolan och IT' } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t).toHaveLength(3);
    for (const x of t) expect(x.forvaltning).toBe('Skolan och IT');
  });

  it('dedupes addresses and ignores non-addresses', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'A@k.se; a@k.se; inte-en-adress', handoff_to_forvaltning: null } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t.map((x) => x.email)).toEqual(['a@k.se']);
    expect(t[0].forvaltning).toBe('');
  });

  it('de-duplicates a role that the kommun already uses', () => {
    // sendInitial throws on a duplicate kommun+role, so the slug must dodge it.
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se', handoff_to_forvaltning: 'Utbildningsförvaltningen' } },
      bodyText: '', homeDomain: 'k.se', usedRoles: ['central', 'utbildning'],
    });
    expect(t[0].roleSlug).toBe('utbildning-2');
  });

  it('falls back to a generic role when no förvaltning is named', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se', handoff_to_forvaltning: null } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t[0].roleSlug).toBe('handoff');
  });

  it('survives a missing home domain without crashing', () => {
    const t = parseHandoffTargets({ analysis: GBG, bodyText: GBG_BODY, homeDomain: null });
    expect(t.map((x) => x.sameDomain)).toEqual([false, false]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/handoff.test.js`
Expected: FAIL — `Cannot find module '../src/handoff.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/handoff.js
// Suggested ärenden from an external handoff. Pure: no IO, no DB — the caller
// passes the stored analysis, the message body and the kommun's home domain.
//
// Reads analysis.intent, NOT the stored classification column: a handoff is
// deliberately persisted as classification 'unknown' (see
// analysisToLegacyClassification), so a rule keyed on the column never fires.
// See docs/superpowers/specs/2026-07-31-handoff-suggested-arenden-design.md

// 'http://www.goteborg.se' → 'goteborg.se'. Same derivation as crawl.js.
export function homeDomainFromWebbplats(webbplats) {
  if (!webbplats) return null;
  try {
    return new URL(webbplats).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

// Dot-anchored, never a bare endsWith: 'xgoteborg.se' must not match
// 'goteborg.se' (CLAUDE.md, cross-domain filter).
function onDomain(email, homeDomain) {
  if (!homeDomain) return false;
  const d = String(email).split('@')[1]?.toLowerCase();
  if (!d) return false;
  return d === homeDomain || d.endsWith('.' + homeDomain);
}

const ASCII = (s) => String(s ?? '').toLowerCase()
  .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e').replace(/ü/g, 'u')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// 'Utbildningsförvaltningen' → 'utbildning'; 'Grundskoleförvaltningen' → 'grundskola'.
function roleFromForvaltning(forvaltning) {
  const first = ASCII(forvaltning).split(' ')[0] ?? '';
  const stem = first
    .replace(/forvaltningen$|forvaltning$/, '')
    .replace(/namnden$|namnd$/, '')
    .replace(/kontoret$|kontor$/, '')
    .replace(/e$/, '');
  return stem.length >= 3 ? stem : 'handoff';
}

export function parseHandoffTargets({ analysis, bodyText = '', homeDomain = null, usedRoles = [] }) {
  if (!analysis || analysis.intent !== 'handoff') return [];
  const raw = analysis.extracted?.handoff_to_email;
  if (!raw) return [];

  const emails = [];
  const seen = new Set();
  for (const part of String(raw).split(/[;,\s]+/)) {
    const e = part.trim().toLowerCase();
    if (!e || !e.includes('@') || seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }
  if (emails.length === 0) return [];

  const labels = String(analysis.extracted?.handoff_to_forvaltning ?? '')
    .split(/\s+och\s+|,/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Pair by index only when the counts line up; otherwise every address carries
  // the full text rather than a guessed label.
  const paired = labels.length === emails.length;
  const fullLabel = labels.join(' och ');

  const body = String(bodyText ?? '').toLowerCase();
  const taken = new Set(usedRoles);
  return emails.map((email, i) => {
    const forvaltning = paired ? labels[i] : fullLabel;
    let roleSlug = roleFromForvaltning(forvaltning);
    if (taken.has(roleSlug)) {
      let n = 2;
      while (taken.has(`${roleSlug}-${n}`)) n++;
      roleSlug = `${roleSlug}-${n}`;
    }
    taken.add(roleSlug);
    return {
      email,
      forvaltning,
      verbatim: body.includes(email),
      sameDomain: onDomain(email, homeDomain),
      roleSlug,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/handoff.test.js`
Expected: PASS (9 tests). If `roleFromForvaltning` mis-stems a real Swedish
förvaltning name, fix the stem rules — do not loosen the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/handoff.js tests/handoff.test.js
git commit -m "feat(handoff): pure parseHandoffTargets over the stored analysis"
```

---

## Task 2: Derive suggestions in `loadCaseDetail`

**Files:**
- Modify: `src/dashboard.js` (`loadCaseDetail`, around line 488)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `parseHandoffTargets`, `homeDomainFromWebbplats` (Task 1).
- Produces: `detail.handoff_targets` — the array from Task 1, `[]` when none.

`loadCaseDetail` currently takes `(db, convId)`. It needs the kommun record for
`webbplats`, so give it a third parameter rather than reaching for a loader
inside: `loadCaseDetail(db, convId, kommun = null)`. The `/arenden/:id` route
looks the kommun up via `municipalitiesLoader()` and passes it.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard.test.js — add
describe('handoff suggested ärenden', () => {
  const GBG_ANALYSIS = JSON.stringify({
    intent: 'handoff', confidence: 0.88,
    extracted: {
      handoff_to_email: 'info@educ.goteborg.se;grundskola@grundskola.goteborg.se',
      handoff_to_forvaltning: 'Utbildningsförvaltningen och Grundskoleförvaltningen',
    },
  });
  const BODY = 'Kontakta info@educ.goteborg.se och grundskola@grundskola.goteborg.se';

  function seedHandoff() {
    const convId = db.createConversation({ kommun_kod: '1480', kommun_namn: 'Göteborg', role: 'upphandling', contact_email: 'ink@ink.goteborg.se', scheduled_send_at: '2026-07-31T07:00:00Z' });
    db.updateConversationState(convId, 'NEEDS_HUMAN', {});
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'in-h', direction: 'inbound',
      from_email: 'ink@ink.goteborg.se', to_email: 'me@x.se', subject: 'SV', body_text: BODY,
      classification: 'unknown', classification_confidence: 0.88,
      received_at: '2026-07-31T07:44:00Z', attachment_count: 0, analysis_json: GBG_ANALYSIS });
    return convId;
  }
  const MUNIS = [{ kommun_kod: '1480', kommun_namn: 'Göteborg', lan: 'X', folkmangd: 1,
    webbplats: 'http://www.goteborg.se', contacts: [] }];
  const appG = () => createDashboardApp({ db, municipalitiesLoader: () => MUNIS });

  it('offers one suggestion per extracted address, with its signals', async () => {
    const convId = seedHandoff();
    const res = await get(appG(), `/arenden/${convId}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Föreslagna ärenden');
    expect(res.text).toContain('info@educ.goteborg.se');
    expect(res.text).toContain('grundskola@grundskola.goteborg.se');
    expect(res.text).toContain('Utbildningsförvaltningen');
    expect(res.text).toMatch(/står i mejlet/);
  });

  it('shows no panel for an ärende with no handoff', async () => {
    const convId = db.createConversation({ kommun_kod: '1480', kommun_namn: 'Göteborg', role: 'central', contact_email: 'g@goteborg.se', scheduled_send_at: '2026-07-31T07:00:00Z' });
    db.recordMessage({ conversation_id: convId, gmail_message_id: 'in-n', direction: 'inbound',
      from_email: 'g@goteborg.se', to_email: 'me@x.se', subject: 'Sv', body_text: 'Hej',
      classification: 'clarification', classification_confidence: 0.9,
      received_at: '2026-07-31T07:00:00Z', attachment_count: 0,
      analysis_json: JSON.stringify({ intent: 'clarification', extracted: {} }) });
    const res = await get(appG(), `/arenden/${convId}`);
    expect(res.text).not.toContain('Föreslagna ärenden');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "handoff suggested"`
Expected: FAIL — no "Föreslagna ärenden" in the output.

- [ ] **Step 3: Implement the derivation**

In `src/dashboard.js`, import the module and extend `loadCaseDetail`:

```js
import { parseHandoffTargets, homeDomainFromWebbplats } from './handoff.js';
```

At the end of `loadCaseDetail`, before the return:

```js
  // Suggested ärenden from the most recent EXTERNAL handoff. Newest wins: an
  // older redirect that a later message superseded is not re-suggested.
  let handoff_targets = [];
  const lastHandoff = [...messages].reverse().find((m) => {
    if (m.direction !== 'inbound' || !m.analysis_json) return false;
    try { return JSON.parse(m.analysis_json)?.intent === 'handoff'; } catch { return false; }
  });
  if (lastHandoff) {
    const usedRoles = db.raw.prepare('SELECT role FROM conversations WHERE kommun_kod = ?')
      .all(conv.kommun_kod).map((r) => r.role);
    handoff_targets = parseHandoffTargets({
      analysis: JSON.parse(lastHandoff.analysis_json),
      bodyText: lastHandoff.body_text ?? '',
      homeDomain: homeDomainFromWebbplats(kommun?.webbplats),
      usedRoles,
    });
  }
```

Add `handoff_targets` to the returned object. Change the signature to
`loadCaseDetail(db, convId, kommun = null)` and update the `/arenden/:id` route
to look the kommun up and pass it:

```js
    const kommun = (municipalitiesLoader() ?? []).find((m) => m.kommun_kod === conv?.kommun_kod);
```
(read the route first — it calls `loadCaseDetail(db, parseInt(req.params.id, 10))`
in two places, and the kommun_kod is only known after the detail loads, so look
the kommun up from `detail.conv.kommun_kod` and re-derive, or fetch the
conversation first. Pick whichever reads cleanest; do not duplicate the query.)

- [ ] **Step 4: Render the panel**

In `src/dashboard-views.js`, inside the case-detail body of `renderArenden`,
add (only when `handoff_targets.length`):

```js
  const badge = (ok, yes, no) => ok
    ? `<span class="pill pill-promise">✓ ${yes}</span>`
    : `<span class="pill pill-overdue">⚠ ${no}</span>`;
  const handoffPanel = (targets, convId) => targets.length === 0 ? '' : `
    <section class="board-section">
      <h2>Föreslagna ärenden <span class="count">${targets.length}</span></h2>
      <p class="muted">Kommunen hänvisade vidare. Inget skickas förrän du klickar.</p>
      <table>
        <thead><tr><th>Adress</th><th>Förvaltning</th><th>Kontroll</th><th>Roll</th><th></th></tr></thead>
        <tbody>${targets.map((t) => `<tr data-handoff-email="${escapeHtml(t.email)}">
          <td>${escapeHtml(t.email)}</td>
          <td>${escapeHtml(t.forvaltning)}</td>
          <td>${badge(t.verbatim, 'står i mejlet', 'hittades inte i mejlet')} ${badge(t.sameDomain, 'kommunens domän', 'annan domän')}</td>
          <td class="muted">${escapeHtml(t.roleSlug)}</td>
          <td data-state-cell>
            <form method="post" action="/arenden/${convId}/handoff-start" data-row-form>
              <input type="hidden" name="email" value="${escapeHtml(t.email)}">
              <button type="submit" class="compose-link" title="Starta ärende och skicka T-INITIAL">📨 Skicka</button>
            </form>
          </td>
        </tr>`).join('')}</tbody>
      </table>
    </section>`;
```

`data-row-form` + `data-state-cell` reuse the in-place-update behaviour from the
2026-07-31 Skicka fix. The row swap in `app.js` keys on `data-kommun-kod`, which
these rows do not have, so the handler falls through to a normal submit — that
is acceptable (the page reloads and the started ärende disappears from the
panel). **If in-place update is wanted, generalise the app.js selector in a
follow-up; do not fork the handler here.**

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/dashboard.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): suggest ärenden from an external handoff"
```

---

## Task 3: `POST /arenden/:id/handoff-start`

**Files:**
- Modify: `src/dashboard.js`
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Consumes: `parseHandoffTargets` (Task 1), `detail.handoff_targets` (Task 2),
  `sendInitial` + `renderInitialDraft` (already imported in `dashboard.js`).
- Produces: `204` to an `X-Partial` fetch, `302 /arenden/:id` otherwise.

- [ ] **Step 1: Write the failing test**

```js
// tests/dashboard.test.js — inside the handoff describe
it('starts an ärende for a suggested address and sends T-INITIAL once', async () => {
  const convId = seedHandoff();
  const spy = vi.spyOn(gmailMod, 'sendMessage').mockResolvedValue({ id: 'm9', threadId: 't9' });
  try {
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNIS,
      gmailClient: { gmail: {} }, env: { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Test' } });
    const res = await postForm(app, `/arenden/${convId}/handoff-start`, { email: 'info@educ.goteborg.se' });
    expect(res.status).toBe(302);
    expect(spy).toHaveBeenCalledTimes(1);
    const created = db.raw.prepare("SELECT * FROM conversations WHERE kommun_kod = '1480' AND role != 'upphandling'").all();
    expect(created).toHaveLength(1);
    expect(created[0].contact_email).toBe('info@educ.goteborg.se');
    expect(created[0].state).toBe('SENT');
  } finally { spy.mockRestore(); }
});

it('refuses an address that is not among the extracted targets', async () => {
  const convId = seedHandoff();
  const spy = vi.spyOn(gmailMod, 'sendMessage').mockResolvedValue({ id: 'm9', threadId: 't9' });
  try {
    const app = createDashboardApp({ db, municipalitiesLoader: () => MUNIS,
      gmailClient: { gmail: {} }, env: { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Test' } });
    const res = await postForm(app, `/arenden/${convId}/handoff-start`, { email: 'angripare@example.com' });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();   // nothing may be mailed
  } finally { spy.mockRestore(); }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "handoff"`
Expected: FAIL — 404 on the POST.

- [ ] **Step 3: Implement the route**

Place it beside `/kommun/:kod/quick-init` so the two send-triggering routes sit
together:

```js
  // Start an ärende for an address the KOMMUN named in a handoff. The posted
  // email is validated against the targets re-derived from the stored message:
  // the form is a convenience, not the authority, so a hand-crafted POST cannot
  // mail an arbitrary address. Sending goes through sendInitial, unchanged.
  app.post('/arenden/:id/handoff-start', async (req, res) => {
    if (!db) return res.status(503).send('No DB');
    if (!gmailClient) return res.status(503).send('Gmail not configured — run pilot-auth first.');

    const convId = parseInt(req.params.id, 10);
    const conv = db.getConversation(convId);
    if (!conv) return res.status(404).send('Ärende not found');
    const kommun = (municipalitiesLoader() ?? []).find((m) => m.kommun_kod === conv.kommun_kod);
    const detail = loadCaseDetail(db, convId, kommun);
    const target = (detail?.handoff_targets ?? []).find((t) => t.email === String(req.body.email ?? '').trim().toLowerCase());
    if (!target) return res.status(400).send('Adressen finns inte bland de föreslagna ärendena');

    const wantsNoBody = req.get('X-Partial') === '1';
    const done = () => (wantsNoBody ? res.status(204).end() : res.redirect(`/arenden/${convId}`));

    const { subject, body } = renderInitialDraft({ kommun_namn: conv.kommun_namn, role: target.roleSlug, env });
    try {
      await sendInitial({
        db, gmail: gmailClient, env,
        kommun_kod: conv.kommun_kod,
        kommun_namn: conv.kommun_namn,
        role: target.roleSlug,
        contact_email: target.email,
        subject,
        body,
      });
    } catch (e) {
      if (e.code === 'INITIAL_CLAIM_LOST' || /already exists/i.test(e.message)) return done();
      return res.status(500).send(`Send failed: ${escapeForError(e.message)}`);
    }
    done();
  });
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.js
git commit -m "feat(dashboard): start a handoff-suggested ärende via sendInitial"
```

---

## Task 4: Render check + deploy

**Files:** none (verification only)

- [ ] **Step 1: Full suite** — `npx vitest run`, all green.

- [ ] **Step 2: Look at it.** Seed a temp DB with the Göteborg fixture (reuse the
  harness pattern from the `/takt` work — a small script that serves
  `createDashboardApp` over a temp DB) and open `/arenden/:id`. Check both rows
  render, badges read `✓ står i mejlet` / `✓ kommunens domän`, and roles show
  `utbildning` / `grundskola`. **Do not point a Gmail-configured dashboard at
  the live DB** — clicking Skicka there sends real mail.

- [ ] **Step 3: Deploy**

```bash
git push origin main
AWS_PROFILE=personal ./deploy/deploy.sh
```

- [ ] **Step 4: Live check on Göteborg #63.** Open `/arenden/63`. Expect exactly
  two suggestions: `info@educ.goteborg.se` (Utbildningsförvaltningen) and
  `grundskola@grundskola.goteborg.se` (Grundskoleförvaltningen), both `✓✓`,
  roles `utbildning` and `grundskola`. Do **not** click unless the operator
  wants those two emails sent — each click sends a real T-INITIAL.

---

## Self-Review

- **Spec coverage:** pure parser + pairing + flags + role slugs → Task 1.
  Newest-handoff derivation and the panel → Task 2. Validated POST reusing
  `sendInitial` → Task 3. Live Göteborg check → Task 4. The "no row until
  clicked" property is structural: no task creates a conversation outside the
  POST handler.
- **Placeholder scan:** no TBD/TODO. Task 2 Step 3 deliberately says to read the
  `/arenden/:id` route and pick the cleanest way to pass the kommun — the route
  loads the detail before the kommun_kod is known, so the shape depends on code
  best read at the time. That is an instruction with a stated constraint, not a
  placeholder.
- **Type consistency:** `parseHandoffTargets` returns
  `{email, forvaltning, verbatim, sameDomain, roleSlug}` in Task 1; Task 2
  renders exactly those fields; Task 3 reads `.email` and `.roleSlug` from the
  same objects. `loadCaseDetail(db, convId, kommun)` has the same three-arg form
  in Task 2 and Task 3.
- **Known limitation, stated in Task 2 Step 4:** the `app.js` row-swap keys on
  `data-kommun-kod`, which these rows lack, so a started suggestion falls back
  to a full-page submit rather than an in-place update. Acceptable; generalising
  the selector is a follow-up, not a fork of the handler.
