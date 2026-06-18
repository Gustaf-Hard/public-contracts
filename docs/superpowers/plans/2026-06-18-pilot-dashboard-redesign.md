# Pilot Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the pilot dashboard as a master–detail app shell with a calm light theme (+ dark toggle), an action-first split home, and collapsed/progressive content — replacing the 290-row scroll, the inline content dumps, and the full-page meta-refresh.

**Architecture:** Keep server-rendered HTML (no framework, no build step). `layout()` gains a `partial` branch that returns just the content fragment; routes serve either a full page (direct nav / no-JS) or a fragment (`?partial=1`). One hand-written `public/app.js` intercepts navigation/forms to swap the content pane via `fetch` + History API, runs a quiet background poll (replacing meta-refresh), and toggles the theme. Render functions are reorganized around a left-sidebar shell and master–detail panes.

**Tech Stack:** Node 20 ESM, Express, `cheerio` (none new), vanilla DOM APIs in `public/app.js`, vitest. CSS via the existing `<style>` block in `dashboard-views.js` promoted to a token set.

## Global Constraints

- Node.js ESM, Node 20+. No new runtime dependencies; no bundler; no TypeScript. (CLAUDE.md)
- All outbound HTTP still goes through `politeFetch` — irrelevant here (dashboard does no scraping), but do not add direct fetches server-side.
- UI copy is Swedish (existing convention): "Översikt", "Ärenden", "Eskaleringar", "Leverantörer", "Aktivitet", "Behöver dig", "Pågår", "Stängda".
- Tests run fully offline. Use the existing `tests/dashboard.test.js` harness pattern: temp dir, `openDb(dbPath)`, `db.migrate()`, `createDashboardApp({ db, municipalitiesLoader })`, and the `supertest`-style request already used in that file.
- Progressive enhancement is mandatory: every interaction must work with JS disabled (full-page nav + standard form POST). `public/app.js` only enhances.
- Light theme is the default; dark is opt-in via `[data-theme="dark"]` on `<html>`, persisted in `localStorage` under key `pilot-theme`, applied before first paint.
- Do not change DB schema, daemon logic, or the Gmail/Slack send paths. Reuse `sendApprovedReply`, `sendInitial`, `db.*` helpers as-is.

---

## File Structure

- `src/dashboard-views.js` (modify) — CSS tokens, `layout()` shell + partial branch, all `render*` functions. Largest set of changes.
- `src/dashboard.js` (modify) — partial detection helper, `express.static('public')`, new `/arenden` + `/arenden/:id` routes, `/escalations` → filtered Ärenden, partial-aware responses on existing routes, new bucketing helpers (`buildActionQueue`, `buildCaseList`).
- `public/app.js` (create) — client enhancement: pane nav, form-in-place, collapse, theme toggle, quiet poll.
- `tests/dashboard.test.js` (modify) — assertions for shell, partial branch, home buckets, new routes.
- `tests/dashboard-views-contacts.test.js`, `tests/overview-tooltip.test.js` (modify only if class/markup assertions break) — update to the new live contract first, don't loosen.

A new `src/case-views.js` is **not** introduced unless `dashboard-views.js` exceeds ~1400 lines after Task 5; if it does, split the Ärenden renderers out then (noted in Task 5).

---

## Task 1: Design tokens + app shell + theme toggle (no behavior change yet)

**Files:**
- Modify: `src/dashboard-views.js` — `baseCss` (line ~285–480) and `layout()` (line ~502–529)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Produces: `layout({ title, body, currentPath, heartbeat, partial = false })` — when `partial` is true returns only the inner content HTML (the `<main>` inner) with no `<!doctype>`, `<head>`, sidebar, or `<script>`. When false, returns the full document with a **left sidebar** shell, an inline theme-bootstrap script, `<script src="/app.js" defer>`, and a content region `<main id="content" data-path="...">…</main>`. No `<meta http-equiv="refresh">`.
- Produces CSS custom properties on `:root` (light) and `:root[data-theme="dark"]` (dark): `--bg, --surface, --surface-2, --fg, --fg-muted, --border, --accent (#4f46e5), --accent-fg, --good, --warn, --bad`, plus spacing `--sp-1..6` and radius `--r-1/2/3`.

- [ ] **Step 1: Write the failing test**

```js
// in tests/dashboard.test.js
import { layout } from '../src/dashboard-views.js'; // add to existing imports

describe('app shell', () => {
  it('full layout has a sidebar nav, theme bootstrap, app.js, no meta-refresh', () => {
    const html = layout({ title: 'X', body: '<p>hi</p>', currentPath: '/' });
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toContain('class="sidebar"');
    expect(html).toContain('href="/arenden"');
    expect(html).toContain('id="content"');
    expect(html).toContain('/app.js');
    expect(html).toContain("localStorage.getItem('pilot-theme')");
    expect(html).not.toMatch(/http-equiv="refresh"/);
  });

  it('partial layout returns only the inner body fragment', () => {
    const html = layout({ title: 'X', body: '<p>hi</p>', currentPath: '/', partial: true });
    expect(html).toBe('<p>hi</p>');
    expect(html).not.toMatch(/<!doctype/i);
    expect(html).not.toContain('class="sidebar"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/dashboard.test.js -t "app shell"`
Expected: FAIL — `layout` not exported / contains meta refresh / no sidebar.

- [ ] **Step 3: Implement — export `layout`, add partial branch, sidebar shell, tokens**

In `dashboard-views.js`: change `function layout(...)` to `export function layout({ title, body, currentPath = '/', heartbeat = null, partial = false })`. At the top of the body:

```js
  if (partial) return body;
  const navItem = (href, label, badge = '') =>
    `<a href="${href}" data-pane-link class="nav-item${currentPath === href || (href !== '/' && currentPath.startsWith(href)) ? ' active' : ''}">${escapeHtml(label)}${badge}</a>`;
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Pilot dashboard</title>
  <script>(function(){try{var t=localStorage.getItem('pilot-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  ${baseCss}
</head>
<body>
  <aside class="sidebar">
    <div class="brand">Mediagraf · Pilot</div>
    <nav>
      ${navItem('/', 'Översikt')}
      ${navItem('/arenden', 'Ärenden')}
      ${navItem('/escalations', 'Eskaleringar')}
      ${navItem('/leverantorer', 'Leverantörer')}
      ${navItem('/activity', 'Aktivitet')}
    </nav>
    <div class="sidebar-foot">
      ${renderHeartbeatPill(heartbeat)}
      <button type="button" class="theme-toggle" data-theme-toggle title="Växla tema">◐ Tema</button>
    </div>
  </aside>
  <main id="content" data-path="${escapeHtml(currentPath)}">${body}</main>
</body>
</html>`;
```

Promote `baseCss`: replace the `:root{…}` + `@media (prefers-color-scheme: light)` blocks with light-default tokens on `:root` and a `:root[data-theme="dark"]{…}` override block (set `--accent:#4f46e5`). Add layout rules: `body{display:flex;min-height:100vh}`, `.sidebar{width:200px;flex:none;border-right:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;padding:16px 12px;position:sticky;top:0;height:100vh}`, `.nav-item{display:block;padding:8px 10px;border-radius:var(--r-2);color:var(--fg-muted)}`, `.nav-item.active{background:var(--surface-2);color:var(--fg)}`, `.sidebar-foot{margin-top:auto;display:flex;flex-direction:column;gap:8px}`, `main#content{flex:1;min-width:0;padding:24px 28px;max-width:1500px}`. Keep existing component classes; retune colors to tokens.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/dashboard.test.js -t "app shell"`
Expected: PASS.

- [ ] **Step 5: Run full suite (catch markup-assertion breakage early)**

Run: `npm test`
Expected: PASS. If `dashboard-views-contacts.test.js`/`overview-tooltip.test.js` fail on removed `header`/nav markup, update those assertions to the new shell contract (don't loosen intent).

- [ ] **Step 6: Commit**

```bash
git add src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): app-shell layout with sidebar, theme tokens, partial branch"
```

---

## Task 2: Static assets + partial-aware routes

**Files:**
- Modify: `src/dashboard.js` — `createDashboardApp` (line ~343–351 for middleware; each `res.send` route)
- Create: `public/app.js` (1-line stub this task: `// enhanced in Task 3`)
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Produces: helper `isPartial(req)` → `req.query.partial === '1' || req.get('X-Partial') === '1'`. Every GET view route passes `partial: isPartial(req)` through to its `render*`/`layout` call. `app.use(express.static('public'))` serves `/app.js`.
- Consumes: `layout(..., { partial })` from Task 1. Each `render*` must thread a `partial` option into its `layout(...)` call (add `partial = false` param to each `render*` signature).

- [ ] **Step 1: Write the failing test**

```js
describe('partial responses', () => {
  it('GET /?partial=1 returns a fragment, not a full document', async () => {
    const res = await request(appWithFakes()).get('/?partial=1');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<!doctype/i);
    expect(res.text).not.toContain('class="sidebar"');
  });
  it('GET / (no partial) returns the full shell', async () => {
    const res = await request(appWithFakes()).get('/');
    expect(res.text).toContain('class="sidebar"');
  });
  it('serves /app.js', async () => {
    const res = await request(appWithFakes()).get('/app.js');
    expect(res.status).toBe(200);
  });
});
```

(Reuse the existing `request` import already in `dashboard.test.js`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "partial responses"`
Expected: FAIL — full doc returned for `?partial=1`; `/app.js` 404.

- [ ] **Step 3: Implement**

In `dashboard.js`: add near the top of `createDashboardApp`:

```js
  app.use(express.static('public'));
  const isPartial = (req) => req.query.partial === '1' || req.get('X-Partial') === '1';
```

Add `partial: isPartial(req)` to each GET route's render call (`renderOverview`, `renderKommunDetail`, `renderCompose`, `renderEscalations`, `renderActivity`, `renderVendors`, `renderVendorDetail`). In `dashboard-views.js`, add `partial = false` to each `render*` signature and pass it into their `layout({ ..., partial })` calls. Create `public/app.js` with `// enhanced in Task 3`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js -t "partial responses"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js public/app.js tests/dashboard.test.js
git commit -m "feat(dashboard): serve /app.js and partial-fragment responses"
```

---

## Task 3: Client enhancement (`public/app.js`)

**Files:**
- Modify: `public/app.js`
- Verify: manual (Playwright in Task 8) — browser code; no vitest.

**Interfaces:**
- Consumes: `[data-pane-link]` anchors, `[data-pane-form]` forms, `#content[data-path]`, `[data-theme-toggle]`, `[data-collapse]`/`[data-collapse-target]`, and `GET <path>?partial=1`.
- Produces: no server interface. Pure progressive enhancement.

- [ ] **Step 1: Implement the full enhancement script**

```js
// public/app.js — progressive enhancement. No framework, no build.
(function () {
  const content = () => document.getElementById('content');

  async function loadPane(url, push) {
    const u = new URL(url, location.origin);
    u.searchParams.set('partial', '1');
    try {
      const res = await fetch(u, { headers: { 'X-Partial': '1' } });
      if (!res.ok) throw new Error(res.status);
      content().innerHTML = await res.text();
      content().dataset.path = url.replace(/[?&]partial=1\b/, '');
      if (push) history.pushState({ url }, '', url);
      content().scrollTop = 0;
      markActive(url);
    } catch (e) {
      location.href = url; // hard fallback — never a dead pane
    }
  }

  function markActive(url) {
    document.querySelectorAll('[data-pane-link]').forEach((a) => {
      const href = a.getAttribute('href');
      a.classList.toggle('active', href === '/' ? url === '/' : url.startsWith(href));
    });
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-pane-link]');
    if (!a || a.target === '_blank' || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    loadPane(a.getAttribute('href'), true);
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-pane-form]');
    if (!form) return;
    e.preventDefault();
    const body = new URLSearchParams(new FormData(form));
    try {
      const res = await fetch(form.action, { method: 'POST', body });
      const next = res.redirected ? res.url : form.dataset.return || content().dataset.path;
      await loadPane(next.replace(location.origin, ''), true);
    } catch (_) { form.submit(); }
  });

  // Collapse/expand (delegated): a [data-collapse] toggles nearest [data-collapse-target]
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-collapse]');
    if (!t) return;
    const tgt = t.parentElement.querySelector('[data-collapse-target]');
    if (tgt) tgt.hidden = !tgt.hidden;
  });

  // Theme toggle
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
    if (cur) document.documentElement.setAttribute('data-theme', cur);
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('pilot-theme', cur); } catch (_) {}
  });

  window.addEventListener('popstate', (e) => {
    loadPane((e.state && e.state.url) || location.pathname + location.search, false);
  });

  // Quiet poll: refresh sidebar counts every 30s WITHOUT touching the open pane
  // or any focused field. Only updates elements tagged [data-poll].
  setInterval(async () => {
    if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    try {
      const res = await fetch('/escalations?partial=1&countonly=1', { headers: { 'X-Partial': '1' } });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      document.querySelectorAll('[data-poll]').forEach((el) => {
        const src = doc.querySelector('[data-poll="' + el.getAttribute('data-poll') + '"]');
        if (src) el.textContent = src.textContent;
      });
    } catch (_) {}
  }, 30000);
})();
```

- [ ] **Step 2: Smoke that it parses (no syntax error)**

Run: `node --check public/app.js`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat(dashboard): client enhancement — pane nav, form-in-place, theme, quiet poll"
```

---

## Task 4: Home / Översikt — action-first split

**Files:**
- Modify: `src/dashboard.js` — add `buildActionQueue(rows, db)` + `buildWaiting(rows, db)`; `/` route passes them in.
- Modify: `src/dashboard-views.js` — `renderOverview` rewrite.
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Produces: `buildActionQueue(rows, db)` → array of `{ kommun_kod, kommun_namn, role, action, age_days, conv_id }` for cases needing a human (any open escalation; or `state === 'NEEDS_HUMAN'`). `buildWaiting(rows, db)` → open non-terminal cases not in the action queue, with `follow_up_at`. `renderOverview({ summary, rows, filter, sort, order, totalKommuner, heartbeat, actionQueue, waiting, partial })` renders, in order: KPI band (`.kpi-band`), `<section class="queue" >` "Behöver dig" (or a designed empty state when length 0), "Pågår / väntar" section, then "Alla kommuner" with a `<input type="search" data-table-filter>` and the table **defaulting to contacted/active rows** (filter `'active'`) plus a `visa alla 290` link (`?filter=all`).
- Consumes: existing `buildOverviewRows`, `applyFilter`, `sortRows`. Add `'active'` to `applyFilter` meaning "state is not null/ej kontaktad".

- [ ] **Step 1: Write the failing tests**

```js
describe('home buckets', () => {
  it('buildActionQueue surfaces conversations with an open escalation', () => {
    // seed: one conversation + one open escalation via db helpers
    const conv = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se' });
    db.recordEscalation({ conversation_id: conv.id, reason: 'handoff', draft_subject: 'Re', draft_body: 'b' });
    const q = buildActionQueue(buildOverviewRowsExport(JSON.parse(readFileSync(muniPath)), db), db);
    expect(q.some((x) => x.kommun_kod === '2418')).toBe(true);
  });

  it("applyFilter('active') drops never-contacted kommuner", () => {
    const rows = buildOverviewRowsExport(JSON.parse(readFileSync(muniPath)), db);
    const active = applyFilterExport(rows, 'active');
    expect(active.every((r) => r.states && r.states.length > 0)).toBe(true);
  });
});
```

> Note: `buildOverviewRows`, `buildSummary`, `applyFilter`, `buildActionQueue`, `buildWaiting` are module-private. Export them from `dashboard.js` for testing (`export { buildOverviewRows, applyFilter, buildActionQueue, buildWaiting }`) and import in the test as `buildOverviewRowsExport` etc. Seeds use the real `src/storage.js` helpers: `db.createConversation({ kommun_kod, kommun_namn, role, contact_email })` and `db.recordEscalation({ conversation_id, reason, draft_subject, draft_body })`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "home buckets"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

In `dashboard.js`: add `'active'` case to `applyFilter` (`rows.filter(r => (r.states ?? []).length > 0)`); add `buildActionQueue`/`buildWaiting` reading from `rows` joined with per-conversation data already available via `db.raw` (mirror the `/kommun/:kod` queries). Export the five helpers. Update `/` route to compute and pass `actionQueue`, `waiting`, and default `filter` to `'active'` when `req.query.filter` is absent.

In `dashboard-views.js`: rewrite `renderOverview` to emit the KPI band + queue sections + filtered table with the search input. Use existing badge/pill helpers. Queue rows are `<a data-pane-link href="/arenden/${conv_id}">`. Empty state: `<div class="empty-state">Inget kräver din uppmärksamhet just nu 🎉</div>`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js -t "home buckets"` then `npm test`
Expected: PASS (update any overview-markup assertions in the two other test files to the new contract).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): action-first split home with queue + active-default table"
```

---

## Task 5: Ärenden master–detail

**Files:**
- Modify: `src/dashboard.js` — add `GET /arenden`, `GET /arenden/:id`; make `/escalations` 302→`/arenden?bucket=behover-dig` (keep POST `/escalations/:id`).
- Modify: `src/dashboard-views.js` — add `renderCaseList({ cases, selectedId, partial })` and `renderCaseDetail({ kommun, conv, timeline, escalation, draft, gmailReady, partial })`; reuse `buildTimeline`, `intentBadge`, `caseStatusBadge`. Collapse message bodies by default (`[data-collapse-target] hidden`).
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Produces: `GET /arenden` → two-pane page (`.master-detail`): left `renderCaseList`, right empty-prompt or first case. `GET /arenden/:id` → same but right pane = `renderCaseDetail` for that conversation; partial-capable (returns just the detail pane fragment when `?pane=detail&partial=1`, else the whole `.master-detail`). The case detail's reply/escalation form is `<form data-pane-form action="/escalations/:eid" data-return="/arenden/:id">` with the existing `action=send|edit|skip` fields; the close/reopen/init forms likewise carry `data-pane-form`.
- Consumes: `db.raw` conversation/message/escalation queries (copy from `/kommun/:kod`), `buildTimeline`, `sendApprovedReply` (unchanged, via POST `/escalations/:id`).

- [ ] **Step 1: Write the failing tests**

```js
describe('arenden', () => {
  it('GET /arenden lists cases grouped by bucket', async () => {
    const conv = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se' });
    const res = await request(appWithFakes()).get('/arenden');
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="master-detail"');
    expect(res.text).toContain('Malå');
  });
  it('GET /arenden/:id renders the case detail with a collapsed timeline', async () => {
    const conv = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se' });
    const res = await request(appWithFakes()).get('/arenden/' + conv.id);
    expect(res.text).toContain('data-collapse-target');
  });
  it('GET /escalations redirects into the Ärenden behöver-dig bucket', async () => {
    const res = await request(appWithFakes()).get('/escalations').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/arenden');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "arenden"`
Expected: FAIL — routes 404; `/escalations` returns 200 not 302.

- [ ] **Step 3: Implement the routes + renderers**

Add `/arenden` and `/arenden/:id` to `dashboard.js` (factor the conversation-loading block out of `/kommun/:kod` into `loadCase(db, convId)` and `loadAllCases(db)` and reuse). Replace the `/escalations` GET body with `res.redirect('/arenden?bucket=behover-dig')`. Add `renderCaseList` + `renderCaseDetail` to `dashboard-views.js`; timeline message bodies wrapped as `<button data-collapse>Visa meddelande</button><div data-collapse-target hidden>…body…</div>`. Convert the escalation/close/reopen/init forms to include `data-pane-form` and `data-return`.

> If `dashboard-views.js` now exceeds ~1400 lines, move `renderCaseList`/`renderCaseDetail`/`buildTimeline` into a new `src/case-views.js` and re-export from `dashboard-views.js`; update imports in `dashboard.js`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js -t "arenden"` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): Ärenden master-detail; escalations fold into it"
```

---

## Task 6: Leverantörer master–detail + chip products

**Files:**
- Modify: `src/dashboard.js` — `/leverantorer` renders list + (optional `?slug=`) detail in one two-pane page; `/leverantor/:slug` stays for direct/partial detail.
- Modify: `src/dashboard-views.js` — `renderVendors` becomes the list pane; `renderVendorDetail` becomes the detail pane; products rendered as grouped `.chip`s, not comma text.
- Test: `tests/dashboard.test.js`

**Interfaces:**
- Produces: `GET /leverantorer` → `.master-detail` (vendor list left; detail right when `?slug=` present, else prompt). `GET /leverantor/:slug` → detail, partial-capable. Vendor list rows are `<a data-pane-link href="/leverantorer?slug=...">`.
- Consumes: `db.listVendorsOverview()`, `db.getVendorBySlug()`, `db.listContractsForVendor()`.

- [ ] **Step 1: Write the failing test**

```js
describe('leverantorer master-detail', () => {
  it('GET /leverantorer renders a two-pane vendor view', async () => {
    const res = await request(appWithFakes()).get('/leverantorer');
    expect(res.text).toContain('class="master-detail"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "leverantorer master-detail"`
Expected: FAIL — current `/leverantorer` has no `.master-detail`.

- [ ] **Step 3: Implement**

Wrap the vendor list and (optional) detail in `.master-detail`. Render each vendor's products as `<span class="chip">name</span>` items inside a `.chip-row`, capped with a "+N till" affordance if more than ~12.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js -t "leverantorer master-detail"` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): Leverantörer master-detail with product chips"
```

---

## Task 7: Polish — debug text, activity, empty states

**Files:**
- Modify: `src/dashboard-views.js` — remove the raw `llm intent=… action=… confidence=…` line from the escalation/case render; replace with `intentBadge(intent)` + a `title` tooltip carrying action/confidence. Designed empty states for Aktivitet and any zero-row table. Restyle `renderActivity` rows into a clean feed.
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('case detail shows an intent badge, not a raw debug string', async () => {
  const conv = db.createConversation({ kommun_kod: '2418', kommun_namn: 'Malå', role: 'central', contact_email: 'k@mala.se' });
  db.recordEscalation({ conversation_id: conv.id, reason: 'handoff', draft_subject: 'Re', draft_body: 'b' });
  const res = await request(appWithFakes()).get('/arenden/' + conv.id);
  expect(res.text).not.toMatch(/intent=\w+ action=/); // no debug string
  expect(res.text).toContain('class="badge"');        // a real badge instead
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "intent badge"`
Expected: FAIL — debug string still present.

- [ ] **Step 3: Implement** — swap the debug line for `intentBadge` + tooltip; add `.empty-state` blocks; restyle activity feed.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/dashboard.test.js -t "intent badge"` then `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): replace debug text with badges; designed empty states"
```

---

## Task 8: Visual review loop (Playwright) + iterate

**Files:** none committed unless fixes are needed (then the relevant `src/` file + a commit per fix).

- [ ] **Step 1: Launch the dashboard against a populated DB**

Run: `PILOT_DASHBOARD_PORT=3100 npm run pilot-dashboard` (background). Confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/` is `200`.

- [ ] **Step 2: Screenshot every view at 1440×900**

Navigate with Playwright to `/`, `/arenden`, `/arenden/<a real conv id from data/pilot.db>`, `/leverantorer`, `/activity`, and toggle dark theme on `/arenden`. Full-page screenshot each. Read each screenshot.

- [ ] **Step 3: Critique against the spec and fix**

For each view check: no >1.5-screen scroll for a single case; the 4 active cases are above the fold on Home; no debug text; consistent spacing/hierarchy; dark mode legible; no layout shift on pane swap; a half-typed reply survives a poll tick. File a fix per defect, re-screenshot. **Iterate at least twice.**

- [ ] **Step 4: Confirm progressive enhancement**

With JS disabled (Playwright `javaScriptEnabled: false` context), confirm `/arenden/<id>` renders full-page, the reply form POSTs and redirects, and nav links work.

- [ ] **Step 5: Final full suite + commit any fixes**

Run: `npm test` → PASS. Commit outstanding fixes.

---

## Self-Review

**Spec coverage:**
- App shell / left sidebar → Task 1. ✔
- Partial mechanism + static asset → Task 2. ✔
- Thin client JS (pane nav, form-in-place, collapse, theme, quiet poll replacing meta-refresh) → Tasks 1 (bootstrap+toggle markup) + 3. ✔
- Split action-first home (queue + waiting + active-default 290 list + search) → Task 4. ✔
- Ärenden master–detail + collapsed timeline + escalations folded in → Task 5. ✔
- Leverantörer master–detail + chips → Task 6. ✔
- Remove debug text, empty states, activity polish → Task 7. ✔
- Light default + dark toggle persisted → Task 1 (CSS/bootstrap) + Task 3 (toggle). ✔
- Visual review loop ≥2 iterations, PE verified → Task 8. ✔
- Tests stay green, fixtures updated not loosened → Steps in each task + Global Constraints. ✔

**Placeholder scan:** Test seeds depend on real `src/storage.js` helper names (verified in src/storage.js: `createConversation`, `recordEscalation`) — Task 4/5 notes instruct verifying actual names in `storage.js` before writing the seed. No other placeholders.

**Type consistency:** `layout({ partial })` defined Task 1, consumed Tasks 2/5/6. `isPartial(req)` defined Task 2, used throughout. `buildActionQueue(rows, db)`/`buildWaiting(rows, db)` defined+consumed Task 4. `loadCase`/`loadAllCases` introduced Task 5 and reused in routes. `[data-pane-link]`/`[data-pane-form]`/`[data-collapse-target]`/`[data-theme-toggle]` markup (Tasks 1,4,5,6) matches the selectors in `app.js` (Task 3). Consistent.
