// HTML view layer for the pilot dashboard. Pure functions that take data
// objects and return HTML strings. No template engine, no client-side JS.

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtInt(n) {
  if (n === null || n === undefined) return '';
  return Number(n).toLocaleString('sv-SE');
}

function daysAgo(iso, now = new Date()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / (1000 * 60 * 60 * 24));
}

function fmtAgo(iso) {
  const d = daysAgo(iso);
  if (d === null) return '—';
  if (d === 0) return 'idag';
  if (d === 1) return '1 dag sedan';
  return `${d} dagar sedan`;
}

// Returns days from today (UTC, date-only) to the given YYYY-MM-DD string.
// Negative = past, 0 = today, positive = future.
function daysUntil(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const target = new Date(isoDate + 'T00:00:00Z').getTime();
  if (Number.isNaN(target)) return null;
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

// Compact countdown pill for follow_up_at. Color encodes source:
//   - 'kommun_promise' → green: the kommun committed to this date
//   - 'our_followup'   → red: stale-rule default, no promise from them
//   - overdue: amber regardless of source
// Returns null when no date set.
function fmtFollowUpBadge(isoDate, source = 'our_followup') {
  const d = daysUntil(isoDate);
  if (d === null) return null;
  const tooltipSource = source === 'kommun_promise'
    ? 'kommunen utlovade detta datum'
    : 'standardpåminnelse (de har inte utlovat något datum)';
  const title = `${isoDate} · ${tooltipSource}`;
  // Overdue trumps source — always amber
  if (d < 0) {
    return `<span class="pill pill-overdue" title="${escapeHtml(title)}">försenad ${-d}d</span>`;
  }
  const klass = source === 'kommun_promise' ? 'pill pill-promise' : 'pill pill-default';
  const label = d === 0 ? 'idag' : d === 1 ? 'imorgon' : `om ${d}d`;
  return `<span class="${klass}" title="${escapeHtml(title)}">${label}</span>`;
}

const INTENT_LABELS = {
  auto_ack: 'Mottagningskvitto',
  clarification: 'Begär precisering',
  delivery: 'Leverans',
  delay_promise: 'Utlovar svar',
  handoff: 'Hänvisar vidare',
  dead_end: 'Återvändsgränd',
  fee_demand: 'Kräver avgift',
  unknown: 'Okänt',
};

const INTENT_COLORS = {
  auto_ack: '#6366f1',
  clarification: '#a855f7',
  delivery: '#10b981',
  delay_promise: '#3b82f6',
  handoff: '#f59e0b',
  dead_end: '#9ca3af',
  fee_demand: '#ef4444',
  unknown: '#ef4444',
};

function intentBadge(intent) {
  const color = INTENT_COLORS[intent] ?? '#6b7280';
  const label = INTENT_LABELS[intent] ?? intent;
  return `<span class="badge" style="background:${color}1a;color:${color};border:1px solid ${color}66">${escapeHtml(label)}</span>`;
}

function parseJsonSafe(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const CASE_STATUS = {
  INITIAL:            { label: 'Schemalagt',         color: '#9ca3af', terminal: false },
  SENT:               { label: 'Öppet · väntar svar', color: '#3b82f6', terminal: false },
  ACK_RECEIVED:       { label: 'Öppet · bekräftat',   color: '#6366f1', terminal: false },
  AWAITING_PRECISION: { label: 'Öppet · väntar precisering', color: '#a855f7', terminal: false },
  DELIVERING:         { label: 'Öppet · tar emot avtal', color: '#10b981', terminal: false },
  DONE:               { label: '✅ Stängt — klart',    color: '#22c55e', terminal: true  },
  DEAD_END:           { label: '🚫 Återvändsgränd',    color: '#9ca3af', terminal: true  },
  NEEDS_HUMAN:        { label: '⚠️ Behöver dig',       color: '#ef4444', terminal: false },
};

function caseStatusBadge(state) {
  const meta = CASE_STATUS[state] ?? { label: state, color: '#6b7280', terminal: false };
  return `<span class="badge" style="background:${meta.color}1a;color:${meta.color};border:1px solid ${meta.color}66;font-size:12px;padding:4px 10px">${escapeHtml(meta.label)}</span>`;
}

// Days between two ISO timestamps. Both required.
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.floor((b - a) / (1000 * 60 * 60 * 24)));
}

// Human-readable case duration: "öppet sedan X dagar" or "stängt efter X dagar".
function caseDuration(conv, messages, now = new Date()) {
  const firstOutbound = messages.find((m) => m.direction === 'outbound');
  const startIso = firstOutbound?.received_at ?? conv.scheduled_send_at ?? conv.state_changed_at;
  const isTerminal = CASE_STATUS[conv.state]?.terminal;
  if (isTerminal) {
    const d = daysBetween(startIso, conv.state_changed_at);
    return d === null ? null : `stängt efter ${d} dag${d === 1 ? '' : 'ar'}`;
  }
  const d = daysBetween(startIso, now.toISOString());
  return d === null ? null : `öppet sedan ${d} dag${d === 1 ? '' : 'ar'}`;
}

// Build a chronologically sorted list of timeline events for one case.
// Sources: outbound + inbound messages (each with attachments + LLM analysis),
// plus the closed-state event when the case is terminal.
function buildTimeline(conv, messages, attachmentsByMsg, signatures = {}) {
  const events = [];
  for (const m of messages) {
    const ts = m.received_at;
    if (m.direction === 'outbound') {
      events.push({
        ts,
        icon: '📤',
        title: m.subject?.startsWith('Re:') ? 'Svar skickat' : (m.subject?.startsWith('Påminnelse') ? 'Påminnelse skickad' : 'Begäran skickad'),
        sub: m.subject ?? '',
        body: m.body_text,
        bodyClass: 'body-quote-outbound',
      });
    } else {
      const analysis = parseJsonSafe(m.analysis_json);
      const intent = analysis?.intent ?? m.classification ?? 'inkommande';
      const conf = (analysis?.confidence ?? m.classification_confidence ?? 0).toFixed(2);
      events.push({
        ts,
        icon: '📥',
        title: `Svar mottaget · ${INTENT_LABELS[intent] ?? intent}`,
        rawIntent: intent, // included verbatim so test assertions / log scrapers can match
        sub: analysis?.summary ?? m.subject ?? '',
        body: m.body_text,
        bodyClass: 'body-quote-inbound',
        confidence: conf,
        analysis,
        signature: signatures[m.id] ?? null,
      });
      for (const att of attachmentsByMsg[m.id] ?? []) {
        events.push({
          ts,
          icon: '📎',
          title: 'Avtal mottaget',
          sub: att.filename,
          link: `/attachments/${att.id}`,
        });
      }
    }
  }
  if (CASE_STATUS[conv.state]?.terminal) {
    events.push({
      ts: conv.state_changed_at,
      icon: conv.state === 'DONE' ? '🏁' : '🚫',
      title: conv.state === 'DONE' ? 'Ärende stängt — klart' : 'Ärende markerat som återvändsgränd',
    });
  }
  // Stable sort by timestamp, ties broken by insertion order
  return events
    .map((e, i) => ({ ...e, _i: i }))
    .sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? '') || a._i - b._i);
}

function renderTimeline(events) {
  if (events.length === 0) return '<p class="muted">Ingen aktivitet ännu.</p>';
  return `<ul class="timeline">${events.map((e) => {
    const date = e.ts ? e.ts.slice(0, 10) : '';
    const time = e.ts ? e.ts.slice(11, 16) : '';
    const analysisBlock = e.analysis ? `
      <details style="margin-top:6px">
        <summary class="muted" style="font-size:11px">LLM-analys (${e.confidence}) · klass: ${escapeHtml(e.rawIntent ?? '')}</summary>
        <div style="margin-top:4px;font-size:12px">
          ${e.analysis.extracted?.arendenummer ? `<div>Ärendenummer: <code>${escapeHtml(e.analysis.extracted.arendenummer)}</code></div>` : ''}
          ${e.analysis.extracted?.promised_response_date ? `<div>Utlovat datum: <strong>${escapeHtml(e.analysis.extracted.promised_response_date)}</strong></div>` : ''}
          ${e.analysis.extracted?.handoff_to_email ? `<div>Hänvisar till: <code>${escapeHtml(e.analysis.extracted.handoff_to_email)}</code></div>` : ''}
          ${e.analysis.draft_reply ? `<details><summary>Föreslaget svar</summary><div class="body-quote body-quote-outbound" style="margin-top:4px">${escapeHtml(e.analysis.draft_reply)}</div></details>` : ''}
        </div>
      </details>` : (e.rawIntent ? `<div class="ev-sub muted" style="font-size:11px">Klass: ${escapeHtml(e.rawIntent)}</div>` : '');
    const sigBlock = e.signature ? `
      <details style="margin-top:6px">
        <summary class="muted" style="font-size:11px">Extraherad kontaktinfo</summary>
        <dl class="signature-fields" style="margin-top:4px">
          ${e.signature.name        ? `<dt>Namn</dt><dd>${escapeHtml(e.signature.name)}</dd>` : ''}
          ${e.signature.title       ? `<dt>Titel</dt><dd>${escapeHtml(e.signature.title)}</dd>` : ''}
          ${e.signature.forvaltning ? `<dt>Förvaltning</dt><dd>${escapeHtml(e.signature.forvaltning)}</dd>` : ''}
          ${e.signature.email       ? `<dt>E-post</dt><dd>${escapeHtml(e.signature.email)}</dd>` : ''}
          ${e.signature.phone       ? `<dt>Telefon</dt><dd>${escapeHtml(e.signature.phone)}</dd>` : ''}
        </dl>
      </details>` : '';
    return `<li class="timeline-item">
      <div class="timeline-date" title="${escapeHtml(e.ts ?? '')}">${escapeHtml(date)}<br>${escapeHtml(time)}</div>
      <div class="timeline-icon">${e.icon}</div>
      <div class="timeline-body">
        <div class="ev-title">${escapeHtml(e.title)}</div>
        ${e.sub ? `<div class="ev-sub">${e.link ? `<a href="${escapeHtml(e.link)}" target="_blank" rel="noopener">${escapeHtml(e.sub)}</a>` : escapeHtml(e.sub)}</div>` : ''}
        ${e.body ? `<button type="button" class="collapse-toggle" data-collapse aria-expanded="false">Visa meddelande</button><div class="body-quote ${e.bodyClass}" data-collapse-target hidden>${escapeHtml(e.body)}</div>` : ''}
        ${analysisBlock}
        ${sigBlock}
      </div>
    </li>`;
  }).join('')}</ul>`;
}

function renderCaseActions(conv, gmailReady, returnTo = null) {
  const paneAttrs = returnTo ? ` data-pane-form data-return="${escapeHtml(returnTo)}"` : '';
  const returnField = returnTo ? `<input type="hidden" name="return" value="${escapeHtml(returnTo)}">` : '';
  const isTerminal = CASE_STATUS[conv.state]?.terminal;
  if (isTerminal) {
    return `<div class="case-actions">
      <form method="post" action="/conversations/${conv.id}/reopen"${paneAttrs}>
        ${returnField}
        <button class="btn btn-secondary" type="submit"
          onclick="return confirm('Återöppna ärende? Status sätts till Bekräftat.')">↩️ Återöppna</button>
      </form>
    </div>`;
  }
  return `<div class="case-actions">
    <form method="post" action="/conversations/${conv.id}/close"${paneAttrs}>
      ${returnField}
      <input type="hidden" name="state" value="DONE">
      <button class="btn btn-primary" type="submit"
        onclick="return confirm('Stäng ärendet som klart? (state = DONE)')">✅ Stäng som klart</button>
    </form>
    <form method="post" action="/conversations/${conv.id}/close"${paneAttrs}>
      ${returnField}
      <input type="hidden" name="state" value="DEAD_END">
      <button class="btn btn-secondary" type="submit"
        onclick="return confirm('Markera ärendet som återvändsgränd? (state = DEAD_END)')">🚫 Återvändsgränd</button>
    </form>
  </div>`;
}

const STATE_LABELS = {
  INITIAL: 'Schemalagt',
  SENT: 'Skickat',
  ACK_RECEIVED: 'Bekräftat',
  AWAITING_PRECISION: 'Väntar precisering',
  DELIVERING: 'Avtal kommer in',
  DONE: 'Klart',
  DEAD_END: 'Återvändsgränd',
  NEEDS_HUMAN: 'Behöver dig',
};

const STATE_COLORS = {
  INITIAL: '#9ca3af',
  SENT: '#3b82f6',
  ACK_RECEIVED: '#6366f1',
  AWAITING_PRECISION: '#a855f7',
  DELIVERING: '#10b981',
  DONE: '#22c55e',
  DEAD_END: '#9ca3af',
  NEEDS_HUMAN: '#ef4444',
};

function stateBadge(state) {
  if (!state) return '<span class="badge badge-empty">—</span>';
  const color = STATE_COLORS[state] ?? '#6b7280';
  const label = STATE_LABELS[state] ?? state;
  return `<span class="badge" style="background:${color}1a;color:${color};border:1px solid ${color}66">${escapeHtml(label)}</span>`;
}

const baseCss = `
<style>
  :root {
    /* Light is the default theme. */
    --bg: #f7f8fa;
    --bg-elev: #ffffff;
    --bg-elev-2: #f1f3f6;
    --fg: #1a1f29;
    --fg-muted: #5b6573;
    --border: #e4e7ec;
    --accent: #4f46e5;
    --accent-fg: #ffffff;
    --good: #16a34a;
    --warn: #d97706;
    --bad: #dc2626;
    --r-1: 4px; --r-2: 8px; --r-3: 12px;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06);
  }
  :root[data-theme="dark"] {
    --bg: #0b0d10;
    --bg-elev: #14181d;
    --bg-elev-2: #1c2128;
    --fg: #e6edf3;
    --fg-muted: #9aa4b2;
    --border: #2a313c;
    --accent: #818cf8;
    --accent-fg: #0b0d10;
    --good: #22c55e;
    --warn: #f59e0b;
    --bad: #ef4444;
    --shadow: 0 1px 2px rgba(0,0,0,.35);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    font-size: 14px;
    line-height: 1.45;
    display: flex;
    min-height: 100vh;
  }
  /* App shell: persistent left sidebar + scrollable content region */
  .sidebar {
    width: 208px; flex: none; box-sizing: border-box;
    border-right: 1px solid var(--border); background: var(--bg-elev);
    display: flex; flex-direction: column; gap: var(--sp-4);
    padding: var(--sp-4) var(--sp-3);
    position: sticky; top: 0; height: 100vh;
  }
  .sidebar .brand { font-size: 14px; font-weight: 700; letter-spacing: .2px; padding: 4px 10px 0; }
  .sidebar nav { display: flex; flex-direction: column; gap: 2px; }
  .sidebar .nav-item {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 8px 10px; border-radius: var(--r-2); color: var(--fg-muted); font-weight: 500;
  }
  .sidebar .nav-item:hover { background: var(--bg-elev-2); color: var(--fg); text-decoration: none; }
  .sidebar .nav-item.active { background: var(--bg-elev-2); color: var(--fg); }
  .sidebar .nav-item .nav-badge {
    background: var(--bad); color: #fff; font-size: 11px; font-weight: 600;
    min-width: 18px; text-align: center; padding: 1px 6px; border-radius: 999px;
  }
  .sidebar-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--sp-2); align-items: flex-start; }
  .theme-toggle {
    background: var(--bg-elev-2); color: var(--fg-muted); border: 1px solid var(--border);
    border-radius: var(--r-2); padding: 6px 10px; font: inherit; font-size: 12px; cursor: pointer; width: 100%;
    text-align: left;
  }
  .theme-toggle:hover { color: var(--fg); border-color: var(--accent); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  header {
    background: var(--bg-elev);
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 24px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header nav { display: flex; gap: 16px; }
  header nav a { color: var(--fg-muted); padding: 4px 8px; border-radius: 6px; }
  header nav a:hover { background: var(--bg-elev-2); text-decoration: none; color: var(--fg); }
  header .spacer { flex: 1; }
  header .refresh-info { font-size: 12px; color: var(--fg-muted); }
  main#content { flex: 1; min-width: 0; padding: var(--sp-5) var(--sp-6) 60px; max-width: 1500px; overflow-x: hidden; }
  h2 { margin: 28px 0 12px; font-size: 16px; font-weight: 600; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .stat-card .label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-card .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .stat-card .value.warn { color: var(--warn); }
  .stat-card .value.good { color: var(--good); }
  .stat-card .value.bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  table th, table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  table th { background: var(--bg-elev-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); font-weight: 600; }
  table th a.th-sort { color: var(--fg-muted); text-decoration: none; display: block; }
  table th a.th-sort:hover { color: var(--fg); text-decoration: none; }
  table th a.th-sort-active { color: var(--fg); }
  table tr:last-child td { border-bottom: none; }
  table tr:hover td { background: var(--bg-elev-2); }
  table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge-empty { background: transparent; color: var(--fg-muted); border: 1px dashed var(--border); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; border: 1px solid; }
  .pill-promise  { background: #22c55e1a; color: var(--good); border-color: #22c55e66; }
  .pill-default  { background: #ef44441a; color: var(--bad);  border-color: #ef444466; }
  .pill-overdue  { background: #f59e0b1a; color: var(--warn); border-color: #f59e0b66; }
  .heartbeat { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid; font-weight: 500; }
  .heartbeat-live  { background: #22c55e1a; color: var(--good); border-color: #22c55e66; }
  .heartbeat-stale { background: #f59e0b1a; color: var(--warn); border-color: #f59e0b66; }
  .heartbeat-off   { background: #ef44441a; color: var(--bad);  border-color: #ef444466; }
  .pill-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .muted { color: var(--fg-muted); }
  .danger { color: var(--bad); font-weight: 500; }
  .warn { color: var(--warn); font-weight: 500; }
  .good { color: var(--good); font-weight: 500; }
  .card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; margin-bottom: 14px; }
  .card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
  .body-quote { background: var(--bg-elev-2); border-left: 3px solid var(--border); padding: 10px 12px; white-space: pre-wrap; font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 12px; max-height: 240px; overflow: auto; border-radius: 4px; margin: 8px 0; }
  .body-quote-inbound { border-left-color: var(--accent); }
  .body-quote-outbound { border-left-color: var(--good); }
  details { background: var(--bg-elev-2); border-radius: 4px; padding: 6px 10px; margin: 8px 0; }
  details summary { cursor: pointer; color: var(--fg-muted); font-size: 12px; }
  .kommun-link { font-weight: 500; }
  .empty-row td { color: var(--fg-muted); font-style: italic; text-align: center; padding: 20px; }
  .filter-bar { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .filter-bar a { padding: 4px 10px; border-radius: 6px; background: var(--bg-elev); border: 1px solid var(--border); color: var(--fg-muted); font-size: 12px; }
  .filter-bar a.active { background: var(--accent); color: white; border-color: var(--accent); }
  .signature-fields dl { margin: 4px 0; display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 12px; }
  .signature-fields dt { color: var(--fg-muted); }
  /* Action forms (send / edit / init) */
  .action-form { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .action-form input[type=text], .action-form textarea, .action-form select {
    width: 100%; background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; padding: 8px 10px; font: inherit; font-size: 12px;
    font-family: ui-monospace, SF Mono, Menlo, monospace;
  }
  .action-form textarea { min-height: 200px; resize: vertical; }
  .action-form .field { display: flex; flex-direction: column; gap: 4px; }
  .action-form .field-row { display: flex; gap: 12px; align-items: flex-end; }
  .action-form .field-row > .field { flex: 1; }
  .action-form label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .action-form .buttons { display: flex; gap: 8px; align-items: center; }
  .btn { display: inline-block; padding: 7px 14px; border-radius: 6px; border: 1px solid; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn-primary  { background: var(--good); color: white; border-color: var(--good); }
  .btn-primary:hover  { filter: brightness(1.1); }
  .btn-secondary { background: transparent; color: var(--fg); border-color: var(--border); }
  .btn-danger { background: transparent; color: var(--bad); border-color: var(--bad); }
  .btn-disabled { background: var(--bg-elev-2); color: var(--fg-muted); border-color: var(--border); cursor: not-allowed; }
  .send-warning { font-size: 12px; color: var(--warn); margin-left: auto; }
  /* Email-replica composer */
  .compose-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; max-width: 820px; overflow: hidden; }
  .compose-card .field-row { display: grid; grid-template-columns: 70px 1fr; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--border); }
  .compose-card .field-label { font-size: 11px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .compose-card .field-value, .compose-card .field-value input, .compose-card .field-value select {
    font-size: 14px; color: var(--fg); width: 100%;
    background: transparent; border: none; padding: 0; font-family: inherit;
  }
  .compose-card .field-value input:focus, .compose-card .field-value select:focus { outline: none; }
  .compose-card .compose-body { padding: 16px 18px; }
  .compose-card .compose-body textarea {
    width: 100%; min-height: 320px; background: transparent; color: var(--fg);
    border: none; padding: 0; resize: vertical; font-size: 14px; line-height: 1.5;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .compose-card .compose-body textarea:focus { outline: none; }
  .compose-card .compose-footer { padding: 14px 18px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: var(--bg-elev-2); }
  .compose-card .compose-footer .spacer { flex: 1; }
  .compose-link { color: var(--fg-muted); border-bottom: 1px dashed currentColor; }
  .compose-link:hover { color: var(--accent); text-decoration: none; }
  .role-tabs { display: flex; gap: 6px; margin: 0 0 14px; }
  .role-tabs a { padding: 4px 12px; border-radius: 6px; background: var(--bg-elev); border: 1px solid var(--border); color: var(--fg-muted); font-size: 12px; }
  .role-tabs a.active { background: var(--accent); color: white; border-color: var(--accent); }
  /* CRM-style kommun page layout: sticky sidebar + main column */
  .kommun-page { display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start; }
  @media (max-width: 980px) { .kommun-page { grid-template-columns: 1fr; } }
  .kommun-sidebar { position: sticky; top: 64px; align-self: start; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; max-height: calc(100vh - 80px); overflow-y: auto; }
  .kommun-sidebar h2 { margin: 0 0 2px; font-size: 18px; }
  .kommun-sidebar .ident-meta { color: var(--fg-muted); font-size: 12px; margin-bottom: 14px; }
  .kommun-sidebar h3 { margin: 14px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--fg-muted); font-weight: 600; }
  .kommun-sidebar .side-section { padding-top: 12px; border-top: 1px solid var(--border); }
  .kommun-sidebar .side-section:first-of-type { border-top: none; padding-top: 0; }
  .kommun-sidebar ul.plain { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  .kommun-sidebar ul.plain li { padding: 4px 0; border-bottom: 1px dashed var(--border); }
  .kommun-sidebar ul.plain li:last-child { border-bottom: none; }
  .kommun-sidebar .next-step { display: flex; flex-direction: column; gap: 2px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed var(--border); }
  .kommun-sidebar .next-step:last-child { border-bottom: none; }
  .kommun-sidebar .next-step .case-link { font-weight: 500; }
  .kommun-sidebar .next-step .step-text { color: var(--fg-muted); }
  .kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .kpi-cell { background: var(--bg-elev-2); border-radius: 6px; padding: 8px 10px; }
  .kpi-cell .kpi-label { font-size: 10px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-cell .kpi-value { font-size: 18px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .completeness { padding: 10px 12px; border-radius: 6px; font-size: 12px; line-height: 1.4; margin-top: 10px; border: 1px solid; }
  .completeness-good { background: #22c55e1a; color: var(--good); border-color: #22c55e66; }
  .completeness-pending { background: #3b82f61a; color: var(--accent); border-color: #3b82f666; }
  .completeness-bad { background: #ef44441a; color: var(--bad); border-color: #ef444466; }
  .person-card { padding: 6px 0; border-bottom: 1px dashed var(--border); font-size: 12px; }
  .person-card:last-child { border-bottom: none; }
  .person-card .person-name { font-weight: 500; font-size: 13px; }
  .person-card .person-meta { color: var(--fg-muted); }
  .tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg-muted); }
  .contracts-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .contracts-table th, .contracts-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  .contracts-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
  .quick-actions { display: flex; flex-direction: column; gap: 6px; }
  .quick-actions a { font-size: 12px; padding: 6px 10px; border-radius: 6px; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg); text-decoration: none; display: flex; align-items: center; gap: 6px; }
  .quick-actions a:hover { border-color: var(--accent); color: var(--accent); }
  /* Case card + timeline */
  .case-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .case-header h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 200px; }
  .case-meta { color: var(--fg-muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 12px; }
  .case-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .case-actions form { display: inline-block; margin: 0; }
  .timeline { list-style: none; padding: 0; margin: 0; }
  .timeline-item { display: grid; grid-template-columns: 90px 28px 1fr; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
  .timeline-item:last-child { border-bottom: none; }
  .timeline-date { color: var(--fg-muted); font-size: 11px; font-variant-numeric: tabular-nums; padding-top: 2px; }
  .timeline-icon { font-size: 16px; line-height: 1.2; }
  .timeline-body { font-size: 13px; }
  .timeline-body .ev-title { font-weight: 500; }
  .timeline-body .ev-sub { color: var(--fg-muted); font-size: 12px; margin-top: 2px; }
  .timeline-body .body-quote { margin: 6px 0 4px; max-height: 160px; }
  footer { margin-top: 60px; padding: 20px 24px; text-align: center; color: var(--fg-muted); font-size: 11px; border-top: 1px solid var(--border); }
  /* Page heading + KPI band */
  .page-head { display: flex; align-items: baseline; gap: 12px; margin: 0 0 var(--sp-4); }
  .page-head h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -.2px; }
  .stats-band { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--sp-3); }
  .stats-band .stat-card { padding: 10px 14px; box-shadow: var(--shadow); }
  .stats-band .stat-card .value { font-size: 22px; }
  .stat-card.stat-alert { border-color: var(--bad); }
  /* Action board */
  .board { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); margin-bottom: var(--sp-5); align-items: start; }
  @media (max-width: 1100px) { .board { grid-template-columns: 1fr; } }
  .board-section { margin-bottom: var(--sp-5); }
  .board-section > h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 var(--sp-3); font-size: 14px; }
  .board-section > h2 .count { background: var(--bg-elev-2); color: var(--fg-muted); border-radius: 999px; font-size: 12px; padding: 1px 9px; font-weight: 600; }
  .queue { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--r-2); overflow: hidden; background: var(--bg-elev); box-shadow: var(--shadow); }
  .queue-row { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: var(--sp-3); padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--fg); }
  .queue-row:last-child { border-bottom: none; }
  .queue-row:hover { background: var(--bg-elev-2); text-decoration: none; }
  .queue-alert .queue-row { border-left: 3px solid var(--bad); }
  .queue-row .q-kommun { font-weight: 600; }
  .queue-row .q-action { color: var(--bad); font-size: 13px; font-weight: 500; }
  .queue-row .q-age { font-size: 12px; white-space: nowrap; }
  .empty-state { padding: 20px; text-align: center; color: var(--fg-muted); background: var(--bg-elev); border: 1px dashed var(--border); border-radius: var(--r-2); font-size: 13px; }
  .table-search { margin: 0 0 var(--sp-3); }
  .table-search input[type=search] { width: 320px; max-width: 100%; padding: 8px 12px; font: inherit; background: var(--bg-elev); color: var(--fg); border: 1px solid var(--border); border-radius: var(--r-2); }
  .table-search input[type=search]:focus { outline: none; border-color: var(--accent); }
  /* Master–detail (Ärenden, Leverantörer) */
  .master-detail { display: grid; grid-template-columns: 340px 1fr; gap: var(--sp-4); align-items: start; }
  @media (max-width: 980px) { .master-detail { grid-template-columns: 1fr; } }
  .md-list { position: sticky; top: var(--sp-5); align-self: start; max-height: calc(100vh - 80px); overflow-y: auto;
    border: 1px solid var(--border); border-radius: var(--r-2); background: var(--bg-elev); box-shadow: var(--shadow); }
  .case-group + .case-group { border-top: 1px solid var(--border); }
  .case-group-head { display: flex; align-items: center; gap: 8px; padding: 8px 14px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .5px; color: var(--fg-muted); background: var(--bg-elev-2); position: sticky; top: 0; }
  .case-group-head .count { background: var(--bg-elev); border-radius: 999px; padding: 0 7px; }
  .case-item { display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--fg); }
  .case-item:last-child { border-bottom: none; }
  .case-item:hover { background: var(--bg-elev-2); text-decoration: none; }
  .case-item.active { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
  .ci-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
  .ci-dot.bad { background: var(--bad); } .ci-dot.ok { background: var(--accent); } .ci-dot.muted { background: var(--border); }
  .ci-kommun { font-weight: 600; }
  .ci-meta { font-size: 12px; white-space: nowrap; }
  .md-detail { min-width: 0; }
  .detail-empty { display: flex; align-items: center; justify-content: center; min-height: 50vh;
    border: 1px dashed var(--border); border-radius: var(--r-2); }
  .case-detail .case-header { display: flex; align-items: center; gap: 12px; }
  .case-detail .case-header h3 { font-size: 18px; }
  .card.card-alert { border-color: var(--bad); }
  .esc-reason { margin-bottom: 8px; }
  hr.soft { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .collapse-toggle { background: none; border: none; color: var(--accent); font: inherit; font-size: 12px;
    cursor: pointer; padding: 4px 0; }
  .collapse-toggle:hover { text-decoration: underline; }
</style>
`;

// Render the daemon-heartbeat pill for the header. Thresholds: live <= 20 min,
// stale 20-60 min, off > 60 min or no tick recorded yet.
function renderHeartbeatPill(heartbeat) {
  const lastTick = heartbeat?.last_tick_at;
  if (!lastTick) {
    return `<span class="heartbeat heartbeat-off" title="Inga ticks registrerade. Starta daemonen med 'npm run pilot-daemon'.">🔴 daemon AV</span>`;
  }
  const ageMs = Date.now() - new Date(lastTick).getTime();
  const ageMin = Math.floor(ageMs / 60000);
  const ageLabel = ageMin < 1 ? 'just nu' : ageMin === 1 ? '1 min sedan' : `${ageMin} min sedan`;
  const titleAttr = `Senaste tick: ${lastTick} (totalt ${heartbeat.tick_count ?? 0} ticks)${heartbeat.last_error ? '\nSenaste fel: ' + heartbeat.last_error : ''}`;
  if (ageMin <= 20) {
    return `<span class="heartbeat heartbeat-live" title="${escapeHtml(titleAttr)}">🟢 daemon · ${ageLabel}</span>`;
  }
  if (ageMin <= 60) {
    return `<span class="heartbeat heartbeat-stale" title="${escapeHtml(titleAttr)}">🟡 daemon släpar · ${ageLabel}</span>`;
  }
  return `<span class="heartbeat heartbeat-off" title="${escapeHtml(titleAttr)}">🔴 daemon AV · senast ${ageLabel}</span>`;
}

export function layout({ title, body, currentPath = '/', heartbeat = null, partial = false, escalationCount = 0 }) {
  // Partial requests (client pane-swap) get only the inner content fragment.
  if (partial) return body;

  const isActive = (href) => href === '/'
    ? currentPath === '/'
    : currentPath.startsWith(href);
  const navItem = (href, label, badge = '') =>
    `<a href="${href}" data-pane-link class="nav-item${isActive(href) ? ' active' : ''}">${escapeHtml(label)}${badge}</a>`;
  const escBadge = escalationCount > 0
    ? `<span class="nav-badge" data-poll="esc-count">${escalationCount}</span>`
    : '';

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
      ${navItem('/escalations', 'Eskaleringar', escBadge)}
      ${navItem('/leverantorer', 'Leverantörer')}
      ${navItem('/activity', 'Aktivitet')}
    </nav>
    <div class="sidebar-foot">
      ${renderHeartbeatPill(heartbeat)}
      <button type="button" class="theme-toggle" data-theme-toggle title="Växla ljust/mörkt tema">◐ Tema</button>
    </div>
  </aside>
  <main id="content" data-path="${escapeHtml(currentPath)}">${body}</main>
  <script src="/app.js" defer></script>
</body>
</html>`;
}

// ---- Overview ----

const COLUMN_DEFAULT_ORDER = {
  kommun_namn: 'asc',
  lan: 'asc',
  folkmangd: 'desc',
  state: 'asc',
  contracts: 'desc',
  open_escalations: 'desc',
  last_activity: 'desc',
  follow_up: 'asc',
};

function sortHeader({ key, label, currentSort, currentOrder, filter, align = 'left' }) {
  const isActive = currentSort === key;
  // Toggle order when clicking the already-active column; otherwise use column's default order
  let nextOrder;
  if (isActive) {
    nextOrder = currentOrder === 'desc' ? 'asc' : 'desc';
  } else {
    nextOrder = COLUMN_DEFAULT_ORDER[key] ?? 'asc';
  }
  const params = new URLSearchParams();
  if (filter && filter !== 'all') params.set('filter', filter);
  params.set('sort', key);
  params.set('order', nextOrder);
  const indicator = isActive ? (currentOrder === 'desc' ? ' ▼' : ' ▲') : '';
  const style = align === 'right' ? ' style="text-align:right"' : '';
  return `<th${style}><a href="?${params.toString()}" class="th-sort${isActive ? ' th-sort-active' : ''}">${escapeHtml(label)}${indicator}</a></th>`;
}

export function renderOverview({ summary, rows, filter, sort, order, totalKommuner, q = '', actionQueue = [], waiting = [], heartbeat = null, partial = false, escalationCount = 0 }) {
  const activeFilter = filter ?? 'active';
  const filters = [
    { key: 'active', label: `Aktiva (${summary.in_pilot})` },
    { key: 'needs-attention', label: `Behöver dig (${summary.needs_human + summary.open_escalations})` },
    { key: 'delivering', label: `Levererar (${summary.delivering})` },
    { key: 'done', label: `Klart (${summary.done})` },
    { key: 'dead-end', label: `Återvändsgränd (${summary.dead_end})` },
    { key: 'all', label: `Visa alla (${totalKommuner})` },
  ];

  // Preserve sort+order+search when switching filter
  const filterParams = (key) => {
    const p = new URLSearchParams();
    if (key !== 'all') p.set('filter', key);
    if (sort) p.set('sort', sort);
    if (order) p.set('order', order);
    if (q) p.set('q', q);
    return p.toString();
  };

  const filterBar = `<div class="filter-bar">${filters
    .map(
      (f) =>
        `<a href="?${filterParams(f.key)}" data-pane-link${activeFilter === f.key ? ' class="active"' : ''}>${escapeHtml(f.label)}</a>`
    )
    .join('')}</div>`;

  const needsCount = summary.needs_human + summary.open_escalations;
  const stats = `
    <div class="stats stats-band">
      <div class="stat-card${needsCount > 0 ? ' stat-alert' : ''}"><div class="label">Behöver dig</div><div class="value ${needsCount > 0 ? 'bad' : 'good'}">${needsCount}</div></div>
      <div class="stat-card"><div class="label">Aktiva</div><div class="value">${summary.in_pilot}</div></div>
      <div class="stat-card"><div class="label">Levererar</div><div class="value good">${summary.delivering}</div></div>
      <div class="stat-card"><div class="label">Klart</div><div class="value good">${summary.done}</div></div>
      <div class="stat-card"><div class="label">Avtal mottagna</div><div class="value">${summary.contracts}</div></div>
      <div class="stat-card"><div class="label">Snittsvarstid</div><div class="value">${summary.avg_reply_days === null ? '—' : summary.avg_reply_days + ' d'}</div></div>
    </div>
  `;

  // --- Action-first queues ---
  const queueRow = (item, badgeHtml) => `<a class="queue-row" data-pane-link href="/arenden/${item.conv_id}">
      <span class="q-kommun">${escapeHtml(item.kommun_namn)} <span class="muted">· ${escapeHtml(item.role)}</span></span>
      <span class="q-mid">${badgeHtml}</span>
      <span class="q-age muted" title="${escapeHtml(item.since ?? '')}">${escapeHtml(fmtAgo(item.since))}</span>
    </a>`;

  const actionSection = `
    <section class="board-section">
      <h2>Behöver dig <span class="count">${actionQueue.length}</span></h2>
      ${actionQueue.length === 0
        ? '<div class="empty-state">Inget kräver din uppmärksamhet just nu. 🎉</div>'
        : `<div class="queue queue-alert">${actionQueue.map((a) =>
            queueRow(a, `<span class="q-action">${escapeHtml(a.action)}</span>`)).join('')}</div>`}
    </section>`;

  const waitingSection = `
    <section class="board-section">
      <h2>Pågår · väntar <span class="count">${waiting.length}</span></h2>
      ${waiting.length === 0
        ? '<div class="empty-state">Inga öppna ärenden väntar på svar.</div>'
        : `<div class="queue">${waiting.map((w) =>
            queueRow(w, `${stateBadge(w.state)} ${fmtFollowUpBadge(w.follow_up_at, w.follow_up_source) ?? ''}`)).join('')}</div>`}
    </section>`;

  const searchForm = `
    <form class="table-search" method="get" action="/">
      <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Sök kommun eller kod…" autocomplete="off">
      ${activeFilter !== 'active' ? `<input type="hidden" name="filter" value="${escapeHtml(activeFilter)}">` : ''}
    </form>`;

  const tableRows = rows.length === 0
    ? '<tr class="empty-row"><td colspan="8">Inga kommuner matchar filtret.</td></tr>'
    : rows
        .map((r) => {
          const stateCell = r.states.length === 0
            ? `<a class="compose-link" href="/kommun/${escapeHtml(r.kommun_kod)}/compose">— ej kontaktad —</a>`
            : `<div class="pill-list">${r.states.map((s) => {
                // Title attribute supports newlines on macOS/most modern browsers;
                // we lead with "Roll: X" then the "Senast / Nästa" narrative.
                const tip = `Roll: ${s.role}${s.tooltip ? '\n\n' + s.tooltip : ''}`;
                return `<span title="${escapeHtml(tip)}">${stateBadge(s.state)}</span>`;
              }).join('')}</div>`;
          const escalCell = r.open_escalations > 0
            ? `<a href="/escalations" class="danger">${r.open_escalations}</a>`
            : `<span class="muted">0</span>`;
          const lastActivity = r.last_activity_at
            ? `<span title="${escapeHtml(r.last_activity_at)}">${escapeHtml(fmtAgo(r.last_activity_at))}</span>`
            : '<span class="muted">—</span>';
          const followUpCell = fmtFollowUpBadge(r.follow_up_at, r.follow_up_source) ?? '<span class="muted">—</span>';
          return `<tr>
            <td><a class="kommun-link" href="/kommun/${escapeHtml(r.kommun_kod)}">${escapeHtml(r.kommun_namn)}</a> <span class="muted">${escapeHtml(r.kommun_kod)}</span></td>
            <td>${escapeHtml(r.lan ?? '')}</td>
            <td class="num">${fmtInt(r.folkmangd)}</td>
            <td>${stateCell}</td>
            <td class="num">${r.contracts > 0 ? `<a href="/kommun/${escapeHtml(r.kommun_kod)}">${r.contracts}</a>` : '<span class="muted">0</span>'}</td>
            <td class="num">${escalCell}</td>
            <td>${followUpCell}</td>
            <td>${lastActivity}</td>
          </tr>`;
        })
        .join('');

  const headerArgs = { currentSort: sort, currentOrder: order, filter: activeFilter };
  const body = `
    <div class="page-head"><h1>Översikt</h1></div>
    ${stats}
    <div class="board">
      ${actionSection}
      ${waitingSection}
    </div>
    <section class="board-section">
      <h2>Alla kommuner</h2>
      ${searchForm}
      ${filterBar}
      <table>
        <thead>
          <tr>
            ${sortHeader({ ...headerArgs, key: 'kommun_namn', label: 'Kommun' })}
            ${sortHeader({ ...headerArgs, key: 'lan', label: 'Län' })}
            ${sortHeader({ ...headerArgs, key: 'folkmangd', label: 'Folkmängd', align: 'right' })}
            ${sortHeader({ ...headerArgs, key: 'state', label: 'Status' })}
            ${sortHeader({ ...headerArgs, key: 'contracts', label: 'Avtal', align: 'right' })}
            ${sortHeader({ ...headerArgs, key: 'open_escalations', label: 'Esk.', align: 'right' })}
            ${sortHeader({ ...headerArgs, key: 'follow_up', label: 'Återkommer' })}
            ${sortHeader({ ...headerArgs, key: 'last_activity', label: 'Senaste aktivitet' })}
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>
  `;

  return layout({ title: 'Översikt', body, currentPath: '/', heartbeat, partial, escalationCount });
}

// ---- Kommun detail ----

function renderEscalationForm(esc, gmailReady, returnTo = null) {
  const disabled = gmailReady ? '' : 'disabled';
  const warn = gmailReady ? '' : '<span class="send-warning">⚠️ Gmail-token saknas — kör <code>npm run pilot-auth</code></span>';
  // When rendered inside a swappable pane, forms post via fetch and return to
  // `returnTo` (so the operator stays on the case). Otherwise they full-reload.
  const paneAttrs = returnTo ? ` data-pane-form data-return="${escapeHtml(returnTo)}"` : '';
  const returnField = returnTo ? `<input type="hidden" name="return" value="${escapeHtml(returnTo)}">` : '';
  // Two forms in the card: edit-and-send (uses textarea contents) + skip.
  // Keeping subject editable lets the user fix a wrong "Re:" prefix.
  return `
    <form class="action-form" method="post" action="/escalations/${esc.id}"${paneAttrs}>
      ${returnField}
      <div class="field">
        <label>Ämne</label>
        <input type="text" name="subject" value="${escapeHtml(esc.draft_subject ?? '')}">
      </div>
      <div class="field">
        <label>Brödtext</label>
        <textarea name="body">${escapeHtml(esc.draft_body ?? '')}</textarea>
      </div>
      <div class="buttons">
        <button class="btn ${gmailReady ? 'btn-primary' : 'btn-disabled'}" type="submit" name="action" value="edit" ${disabled}>📨 Skicka</button>
        ${warn}
      </div>
    </form>
    <form method="post" action="/escalations/${esc.id}" style="margin-top:8px"${paneAttrs}>
      ${returnField}
      <input type="hidden" name="action" value="skip">
      <button class="btn btn-secondary" type="submit"
        onclick="return confirm('Hoppa över denna eskalering utan att svara?')">Hoppa över</button>
    </form>`;
}

export function renderCompose({ kommun, draft, availableRoles = [], selectedRole, candidateEmails = [], gmailReady = false, env = {}, heartbeat = null, partial = false, escalationCount = 0 }) {
  if (!kommun) {
    return layout({ title: 'Saknad kommun', body: '<p>Hittade inte kommunen.</p>', currentPath: '/', heartbeat, partial, escalationCount });
  }
  const backLinks = `<p><a href="/">← Översikt</a> · <a href="/kommun/${escapeHtml(kommun.kommun_kod)}">${escapeHtml(kommun.kommun_namn)} kommun (detalj)</a></p>`;

  if (!selectedRole) {
    const reason = (kommun.contacts?.length ?? 0) === 0
      ? 'Inga kontakter i datasetet för denna kommun. Lägg till en e-postadress i <code>data/municipalities.json</code> först.'
      : 'Alla roller för denna kommun har redan en pågående konversation.';
    const body = `
      ${backLinks}
      <h2>${escapeHtml(kommun.kommun_namn)} kommun</h2>
      <p class="muted">${reason}</p>`;
    return layout({ title: kommun.kommun_namn, body, currentPath: '/', heartbeat, partial, escalationCount });
  }

  const roleTabs = availableRoles.length > 1
    ? `<div class="role-tabs">${availableRoles
        .map((r) => `<a href="?role=${encodeURIComponent(r)}"${r === selectedRole ? ' class="active"' : ''}>${escapeHtml(r)}</a>`)
        .join('')}</div>`
    : '';

  const fromLine = `${env.GMAIL_FROM_NAME ?? ''} &lt;${escapeHtml(env.GMAIL_USER_EMAIL ?? '')}&gt;`;
  const toField = candidateEmails.length <= 1
    ? `<input type="text" name="contact_email" value="${escapeHtml(candidateEmails[0] ?? '')}" readonly>`
    : `<select name="contact_email" required>${candidateEmails.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('')}</select>`;

  const warn = gmailReady ? '' : '<span class="send-warning">⚠️ Gmail-token saknas — kör <code>npm run pilot-auth</code></span>';
  const disabled = gmailReady ? '' : 'disabled';

  const body = `
    ${backLinks}
    <h2>Ny begäran · ${escapeHtml(kommun.kommun_namn)} kommun
      <span class="muted" style="font-weight:400;font-size:13px">${escapeHtml(kommun.lan ?? '')} · ${fmtInt(kommun.folkmangd)} inv.</span>
    </h2>
    ${roleTabs}
    <form method="post" action="/kommun/${escapeHtml(kommun.kommun_kod)}/init"
      onsubmit="return confirm('Skicka begäran till ' + this.contact_email.value + '?')">
      <input type="hidden" name="role" value="${escapeHtml(selectedRole)}">
      <div class="compose-card">
        <div class="field-row">
          <span class="field-label">Från</span>
          <span class="field-value">${fromLine}</span>
        </div>
        <div class="field-row">
          <span class="field-label">Till</span>
          <span class="field-value">${toField}</span>
        </div>
        <div class="field-row">
          <span class="field-label">Roll</span>
          <span class="field-value muted">${escapeHtml(selectedRole)}</span>
        </div>
        <div class="field-row">
          <span class="field-label">Ämne</span>
          <span class="field-value"><input type="text" name="subject" value="${escapeHtml(draft.subject)}"></span>
        </div>
        <div class="compose-body">
          <textarea name="body">${escapeHtml(draft.body)}</textarea>
        </div>
        <div class="compose-footer">
          <button class="btn ${gmailReady ? 'btn-primary' : 'btn-disabled'}" type="submit" ${disabled}>📨 Skicka</button>
          <span class="spacer"></span>
          ${warn}
        </div>
      </div>
    </form>`;
  return layout({ title: `Skicka — ${kommun.kommun_namn}`, body, currentPath: '/', heartbeat, partial, escalationCount });
}

// Derive a short "what happens next" string per case. Used in the sidebar.
function nextStepFor(conv, fu, today = new Date().toISOString().slice(0, 10)) {
  const meta = CASE_STATUS[conv.state] ?? { terminal: false };
  if (meta.terminal) {
    return { text: conv.state === 'DONE' ? 'Stängt — klart' : 'Återvändsgränd', urgent: false };
  }
  if (conv.state === 'NEEDS_HUMAN') {
    return { text: 'Du behöver agera — eskalering öppen', urgent: true };
  }
  if (fu?.date) {
    if (fu.date <= today) return { text: `Skicka påminnelse (förfallen ${fu.date})`, urgent: true };
    const stepLabel = conv.state === 'AWAITING_PRECISION' ? 'Inväntar precisering till' : 'Bevakar svar till';
    return { text: `${stepLabel} ${fu.date}`, urgent: false };
  }
  return { text: `Bevakar (${CASE_STATUS[conv.state]?.label ?? conv.state})`, urgent: false };
}

// Closed-cases (DONE) signal we've been told we have everything. Open cases
// or only DEAD_END mean we don't. Returns {kind, text} for the sidebar banner.
function completenessBanner(conversations) {
  if (conversations.length === 0) return { kind: 'pending', text: 'Inga ärenden ännu.' };
  const hasDone = conversations.some((c) => c.state === 'DONE');
  const allTerminal = conversations.every((c) => CASE_STATUS[c.state]?.terminal);
  const allDeadEnd = conversations.every((c) => c.state === 'DEAD_END');
  if (allDeadEnd) return { kind: 'bad', text: 'Inga avtal mottagna — kommunen avvisade.' };
  if (allTerminal && hasDone) return { kind: 'good', text: '✅ Alla ärenden klara — bedöms ha samtliga avtal.' };
  if (hasDone) return { kind: 'pending', text: 'Minst ett ärende klart, andra pågår fortfarande.' };
  return { kind: 'pending', text: 'Pågående — vi har inte bekräftat att alla avtal är mottagna.' };
}

// Aggregate unique contact people across all inbound messages for this kommun
// (deduplicated by email or fall-back to name).
function aggregatePeople(conversations, messagesByConv, signatures) {
  const byKey = new Map();
  for (const conv of conversations) {
    for (const m of messagesByConv[conv.id] ?? []) {
      const sig = signatures[m.id];
      if (!sig) continue;
      if (!sig.name && !sig.email) continue;
      const key = (sig.email ?? sig.name ?? '').toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { ...sig, role: conv.role });
    }
  }
  return [...byKey.values()];
}

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

// Aggregate vendor names mentioned in any inbound message's LLM analysis.
function aggregateVendors(conversations, messagesByConv) {
  const vendors = new Set();
  for (const conv of conversations) {
    for (const m of messagesByConv[conv.id] ?? []) {
      const a = parseJsonSafe(m.analysis_json);
      for (const v of a?.extracted?.mentioned_vendors ?? []) vendors.add(v);
    }
  }
  return [...vendors];
}

// Flatten attachments across cases into a single "contracts inventory" list.
function aggregateContracts(conversations, messagesByConv, attachmentsByMsg) {
  const out = [];
  for (const conv of conversations) {
    for (const m of messagesByConv[conv.id] ?? []) {
      for (const att of attachmentsByMsg[m.id] ?? []) {
        out.push({
          id: att.id,
          filename: att.filename,
          size_bytes: att.size_bytes,
          received_at: m.received_at,
          role: conv.role,
          conv_id: conv.id,
        });
      }
    }
  }
  return out.sort((a, b) => (b.received_at ?? '').localeCompare(a.received_at ?? ''));
}

function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderKommunDetail({ kommun, conversations, messagesByConv, attachmentsByMsg, escalationsByConv, signatures, followUpByConv = {}, initialDrafts = {}, gmailReady = false, vendorSlugsByName = new Map(), handoffContacts = [], heartbeat = null, partial = false, escalationCount = 0 }) {
  if (!kommun) {
    return layout({ title: 'Saknad kommun', body: '<p>Hittade inte kommunen.</p>', currentPath: '/', heartbeat, partial, escalationCount });
  }

  // ----- Aggregations for the sidebar + bottom sections -----
  const today = new Date().toISOString().slice(0, 10);
  const activeCases = conversations.filter((c) => !CASE_STATUS[c.state]?.terminal);
  const closedCases = conversations.filter((c) => CASE_STATUS[c.state]?.terminal);
  const completeness = completenessBanner(conversations);
  const people = aggregatePeople(conversations, messagesByConv, signatures);
  const vendors = aggregateVendors(conversations, messagesByConv);
  const contracts = aggregateContracts(conversations, messagesByConv, attachmentsByMsg);
  const needsHumanCount = conversations.filter((c) => c.state === 'NEEDS_HUMAN').length;

  // ----- Sidebar -----
  const nextSteps = activeCases.length === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga aktiva ärenden.</p>'
    : activeCases.map((c) => {
        const step = nextStepFor(c, followUpByConv[c.id], today);
        return `<div class="next-step">
          <a class="case-link" href="#case-${c.id}">Ärende #${c.id} · ${escapeHtml(c.role)}</a>
          <span class="step-text ${step.urgent ? 'danger' : ''}">${escapeHtml(step.text)}</span>
        </div>`;
      }).join('');

  const peopleHtml = people.length === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga personer fångade ännu.</p>'
    : people.map((p) => `
        <div class="person-card">
          <div class="person-name">${escapeHtml(p.name ?? p.email ?? '?')}</div>
          <div class="person-meta">
            ${p.title ? escapeHtml(p.title) : ''}${p.forvaltning ? ' · ' + escapeHtml(p.forvaltning) : ''}
          </div>
          ${p.email ? `<div class="person-meta"><code>${escapeHtml(p.email)}</code></div>` : ''}
          ${p.phone ? `<div class="person-meta">📞 ${escapeHtml(p.phone)}</div>` : ''}
        </div>`).join('');

  const mergedContacts = mergeContacts(kommun.contacts ?? [], handoffContacts);
  const datasetContacts = mergedContacts.length === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga adresser.</p>'
    : `<ul class="plain">${mergedContacts.map((c) => {
        const badgeClass = c.source === 'kommun_handoff' ? 'pill pill-promise' : 'pill pill-default';
        return `<li><code>${escapeHtml(c.email)}</code><br><span class="muted" style="font-size:11px">${escapeHtml(c.role ?? '')}${c.forvaltning ? ' · ' + escapeHtml(c.forvaltning) : ''}</span><br><span class="${badgeClass}" style="margin-top:3px">${escapeHtml(contactSourceLabel(c.source))}</span></li>`;
      }).join('')}</ul>`;

  const quickActions = `<div class="quick-actions">
    <a href="/kommun/${escapeHtml(kommun.kommun_kod)}/compose">📨 Ny begäran (T-INITIAL)</a>
    ${kommun.website_url ? `<a target="_blank" rel="noopener" href="${escapeHtml(kommun.website_url)}">🌐 Kommunens webbplats</a>` : ''}
  </div>`;

  const sidebar = `
    <aside class="kommun-sidebar">
      <h2>${escapeHtml(kommun.kommun_namn)} kommun</h2>
      <div class="ident-meta">${escapeHtml(kommun.kommun_kod)} · ${escapeHtml(kommun.lan ?? '')} · ${fmtInt(kommun.folkmangd)} inv.</div>

      <div class="kpi-grid">
        <div class="kpi-cell"><div class="kpi-label">Aktiva ärenden</div><div class="kpi-value">${activeCases.length}</div></div>
        <div class="kpi-cell"><div class="kpi-label">Stängda</div><div class="kpi-value">${closedCases.length}</div></div>
        <div class="kpi-cell"><div class="kpi-label">Avtal mottagna</div><div class="kpi-value">${contracts.length}</div></div>
        <div class="kpi-cell"><div class="kpi-label">Behöver dig</div><div class="kpi-value ${needsHumanCount > 0 ? 'danger' : ''}">${needsHumanCount}</div></div>
      </div>

      <div class="completeness completeness-${completeness.kind}">${escapeHtml(completeness.text)}</div>

      <div class="side-section">
        <h3>Nästa steg</h3>
        ${nextSteps}
      </div>

      <div class="side-section">
        <h3>Personer (${people.length})</h3>
        ${peopleHtml}
      </div>

      <div class="side-section">
        <h3>E-postadresser</h3>
        ${datasetContacts}
      </div>

      <div class="side-section">
        <h3>Snabbåtgärder</h3>
        ${quickActions}
      </div>
    </aside>`;

  // ----- Main column -----
  const initialDraftCards = Object.keys(initialDrafts).length === 0
    ? ''
    : `<div class="card">
        <h3>Ingen pågående konversation för: ${Object.values(initialDrafts).map((d) => `<code>${escapeHtml(d.role)}</code>`).join(', ')}</h3>
        <p style="margin:6px 0"><a class="btn btn-primary" style="display:inline-block;text-decoration:none" href="/kommun/${escapeHtml(kommun.kommun_kod)}/compose">📨 Skapa och skicka begäran →</a></p>
      </div>`;

  const contractsSection = contracts.length === 0
    ? `<div class="card"><h3>Mottagna avtal (0)</h3><p class="muted">Inga avtal mottagna ännu.</p></div>`
    : `<div class="card">
        <h3>Mottagna avtal (${contracts.length})</h3>
        <table class="contracts-table">
          <thead><tr><th>Datum</th><th>Ärende</th><th>Roll</th><th>Filnamn</th><th>Storlek</th></tr></thead>
          <tbody>${contracts.map((c) => `
            <tr>
              <td>${escapeHtml(c.received_at?.slice(0, 10) ?? '')}</td>
              <td><a href="#case-${c.conv_id}">#${c.conv_id}</a></td>
              <td>${escapeHtml(c.role)}</td>
              <td><a href="/attachments/${c.id}" target="_blank" rel="noopener">📎 ${escapeHtml(c.filename)}</a></td>
              <td>${escapeHtml(fmtBytes(c.size_bytes))}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>`;

  const vendorsSection = vendors.length === 0
    ? ''
    : `<div class="card">
        <h3>Nämnda leverantörer (${vendors.length})</h3>
        <div class="muted" style="font-size:12px;margin-bottom:6px">Extraherade från inkommande svar via LLM-analys.</div>
        <div class="tag-list">${vendors.map((v) => {
          const slug = vendorSlugsByName.get(v.toLowerCase());
          return slug
            ? `<a class="tag" href="/leverantor/${escapeHtml(slug)}">${escapeHtml(v)}</a>`
            : `<span class="tag">${escapeHtml(v)}</span>`;
        }).join('')}</div>
      </div>`;

  const convCards = conversations.length === 0
    ? (Object.keys(initialDrafts).length === 0
        ? '<p class="muted">Inga ärenden för denna kommun ännu.</p>'
        : '')
    : conversations.map((conv) => {
        const msgs = messagesByConv[conv.id] ?? [];
        const escs = escalationsByConv[conv.id] ?? [];
        const fu = followUpByConv[conv.id] ?? { date: null, source: null };

        const duration = caseDuration(conv, msgs);
        const followUpBadge = fu.date ? fmtFollowUpBadge(fu.date, fu.source) : null;
        const followUpLine = fu.date
          ? `<span>⏳ Nästa kontakt: <strong>${escapeHtml(fu.date)}</strong> · ${followUpBadge}</span>`
          : '';

        const events = buildTimeline(conv, msgs, attachmentsByMsg, signatures);
        const timeline = renderTimeline(events);

        const escHtml = escs.length === 0 ? '' : `
          <h4 style="margin:18px 0 6px;font-size:13px">⚠️ Öppna eskaleringar (${escs.length})</h4>
          ${escs.map((e) => `
            <div class="card" style="background:var(--bg-elev-2);margin-top:6px">
              <strong>${escapeHtml(e.draft_template ?? 'free_form')}</strong> · <span class="muted">${escapeHtml(e.reason)}</span>
              ${renderEscalationForm(e, gmailReady)}
            </div>`).join('')}`;

        return `
          <div class="card" id="case-${conv.id}">
            <div class="case-header">
              <h3>Ärende #${conv.id} · roll: ${escapeHtml(conv.role)}</h3>
              ${caseStatusBadge(conv.state)}
            </div>
            <div class="case-meta">
              <span>📧 <code>${escapeHtml(conv.contact_email)}</code></span>
              ${conv.arendenummer ? `<span>📌 Diarienr hos kommun: <code>${escapeHtml(conv.arendenummer)}</code></span>` : ''}
              ${duration ? `<span>⌛ ${escapeHtml(duration)}</span>` : ''}
              ${followUpLine}
            </div>
            <h4 style="margin:14px 0 8px;font-size:13px">Tidslinje</h4>
            ${timeline}
            ${escHtml}
            ${renderCaseActions(conv, gmailReady)}
          </div>`;
      }).join('');

  const mainColumn = `
    <div>
      <p><a href="/">← Översikt</a></p>
      <h2 style="margin:6px 0 14px">Ärenden (${conversations.length})</h2>
      ${convCards}
      ${initialDraftCards}
      ${contractsSection}
      ${vendorsSection}
    </div>`;

  const body = `<div class="kommun-page">${sidebar}${mainColumn}</div>`;
  return layout({ title: kommun.kommun_namn, body, currentPath: '/', heartbeat, partial, escalationCount });
}

// ---- Ärenden (master–detail) ----

const ARENDEN_BUCKETS = [
  { key: 'behover_dig', label: 'Behöver dig' },
  { key: 'oppna', label: 'Öppna' },
  { key: 'stangda', label: 'Stängda' },
];

function caseBucket(c) {
  if (c.state === 'NEEDS_HUMAN' || (c.open_esc ?? 0) > 0) return 'behover_dig';
  if (CASE_STATUS[c.state]?.terminal) return 'stangda';
  return 'oppna';
}

function renderCaseList(cases, selectedId) {
  if (cases.length === 0) return '<div class="empty-state">Inga ärenden ännu.</div>';
  const groups = { behover_dig: [], oppna: [], stangda: [] };
  for (const c of cases) groups[caseBucket(c)].push(c);
  return ARENDEN_BUCKETS.map((b) => {
    const items = groups[b.key];
    if (items.length === 0) return '';
    return `<div class="case-group">
      <div class="case-group-head">${escapeHtml(b.label)} <span class="count">${items.length}</span></div>
      ${items.map((c) => {
        const dot = b.key === 'behover_dig' ? 'bad' : (b.key === 'stangda' ? 'muted' : 'ok');
        const meta = b.key === 'oppna'
          ? (fmtFollowUpBadge(c.follow_up_at, c.follow_up_source) ?? `<span class="muted">${escapeHtml(fmtAgo(c.since))}</span>`)
          : `<span class="muted">${escapeHtml(fmtAgo(c.since))}</span>`;
        return `<a class="case-item${c.conv_id === selectedId ? ' active' : ''}" data-pane-link href="/arenden/${c.conv_id}">
          <span class="ci-dot ${dot}"></span>
          <span class="ci-main"><span class="ci-kommun">${escapeHtml(c.kommun_namn)}</span> <span class="muted">· ${escapeHtml(c.role)}</span></span>
          <span class="ci-meta">${meta}</span>
        </a>`;
      }).join('')}
    </div>`;
  }).join('');
}

function renderCaseDetailPane(selected, gmailReady) {
  if (!selected) return '<div class="detail-empty"><p class="muted">Välj ett ärende i listan till vänster.</p></div>';
  const { conv, messages, attachmentsByMsg, signatures, escalations, follow_up } = selected;
  const returnTo = `/arenden/${conv.id}`;
  const events = buildTimeline(conv, messages, attachmentsByMsg, signatures);
  const duration = caseDuration(conv, messages);
  const fuBadge = fmtFollowUpBadge(follow_up?.date, follow_up?.source);
  const escBlock = escalations.length
    ? `<div class="card card-alert"><h3>⚠️ Behöver ditt svar</h3>${escalations.map((e) => `
        <div class="esc-reason">${intentBadge(e.classifier_class ?? 'unknown')} <span class="muted">Föreslaget svar — granska och skicka:</span></div>
        ${renderEscalationForm(e, gmailReady, returnTo)}`).join('<hr class="soft">')}</div>`
    : '';
  return `<div class="case-detail">
    <div class="case-header">
      <h3>${escapeHtml(conv.kommun_namn)} <span class="muted">· ${escapeHtml(conv.role)}</span></h3>
      ${caseStatusBadge(conv.state)}
    </div>
    <div class="case-meta">
      <span>📧 ${escapeHtml(conv.contact_email ?? '')}</span>
      ${conv.arendenummer ? `<span>Ärendenr: <code>${escapeHtml(conv.arendenummer)}</code></span>` : ''}
      ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
      ${fuBadge ? `<span>Återkommer: ${fuBadge}</span>` : ''}
      <span><a href="/kommun/${escapeHtml(conv.kommun_kod)}" data-pane-link>Kommunprofil →</a></span>
    </div>
    ${escBlock}
    <div class="card"><h3>Tidslinje</h3>${renderTimeline(events)}</div>
    ${renderCaseActions(conv, gmailReady, returnTo)}
  </div>`;
}

export function renderArenden({ cases = [], selected = null, selectedId = null, gmailReady = false, heartbeat = null, partial = false, escalationCount = 0 }) {
  const body = `
    <div class="page-head"><h1>Ärenden</h1></div>
    <div class="master-detail">
      <aside class="md-list">${renderCaseList(cases, selectedId)}</aside>
      <div class="md-detail">${renderCaseDetailPane(selected, gmailReady)}</div>
    </div>`;
  return layout({ title: 'Ärenden', body, currentPath: '/arenden', heartbeat, partial, escalationCount });
}

// ---- Escalations queue ----

export function renderEscalations({ items, gmailReady = false, heartbeat = null, partial = false, escalationCount = 0 }) {
  const body = items.length === 0
    ? '<p class="muted">Inga öppna eskaleringar. ✨</p>'
    : items.map((e) => `
        <div class="card">
          <h3>
            <a class="kommun-link" href="/kommun/${escapeHtml(e.kommun_kod)}">${escapeHtml(e.kommun_namn)}</a>
            <span class="muted">· ${escapeHtml(e.role)}</span>
            · <span class="badge" style="background:#a855f71a;color:#a855f7">${escapeHtml(e.draft_template ?? 'free_form')}</span>
            · <span class="muted">${escapeHtml(fmtAgo(e.created_at))}</span>
          </h3>
          <div class="muted">${escapeHtml(e.reason)}</div>
          ${e.inbound_body ? `
            <div style="margin-top:8px">Inkommande:</div>
            <div class="body-quote body-quote-inbound">${escapeHtml(e.inbound_body)}</div>` : ''}
          ${renderEscalationForm(e, gmailReady)}
        </div>`).join('');

  return layout({ title: 'Eskaleringar', body: `<h2>Öppna eskaleringar (${items.length})</h2>${body}`, currentPath: '/escalations', heartbeat, partial, escalationCount });
}

// ---- Activity feed ----

export function renderActivity({ events, heartbeat = null, partial = false, escalationCount = 0 }) {
  const body = events.length === 0
    ? '<p class="muted">Ingen aktivitet ännu.</p>'
    : `<table>
        <thead><tr><th>Tid</th><th>Kommun</th><th>Roll</th><th>Händelse</th><th>Detalj</th></tr></thead>
        <tbody>
          ${events.map((e) => `<tr>
            <td><span title="${escapeHtml(e.timestamp)}">${escapeHtml(fmtAgo(e.timestamp))}</span></td>
            <td><a href="/kommun/${escapeHtml(e.kommun_kod)}">${escapeHtml(e.kommun_namn)}</a></td>
            <td>${escapeHtml(e.role)}</td>
            <td>${escapeHtml(e.event)}</td>
            <td class="muted">${escapeHtml(e.detail ?? '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  return layout({ title: 'Aktivitet', body: `<h2>Senaste aktivitet (${events.length})</h2>${body}`, currentPath: '/activity', heartbeat, partial, escalationCount });
}

function activeBadge(periodEnd) {
  if (!periodEnd) return '<span class="muted">okänd avtalstid</span>';
  const active = periodEnd >= new Date().toISOString().slice(0, 10);
  return active
    ? `<span class="pill pill-promise">aktivt t.o.m. ${escapeHtml(periodEnd)}</span>`
    : `<span class="pill pill-overdue">utgånget ${escapeHtml(periodEnd)}</span>`;
}

export function renderVendors({ vendors = [], heartbeat = null, partial = false, escalationCount = 0 } = {}) {
  const rows = vendors.map((v) => `
    <tr>
      <td><a href="/leverantor/${escapeHtml(v.slug)}">${escapeHtml(v.name)}</a></td>
      <td><div class="tag-list">${v.products.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div></td>
      <td>${v.contract_count}</td>
      <td>${v.kommun_count}</td>
      <td>${escapeHtml(v.last_contract_at?.slice(0, 10) ?? '—')}</td>
    </tr>`).join('');
  const body = `
    <div class="card">
      <h3>Leverantörer (${vendors.length})</h3>
      ${vendors.length === 0
        ? '<p class="muted">Inga leverantörer ännu — kör <code>npm run analyse-contracts</code>.</p>'
        : `<table class="contracts-table">
            <thead><tr><th>Leverantör</th><th>Produkter</th><th>Avtal</th><th>Kommuner</th><th>Senaste avtal</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
  return layout({ title: 'Leverantörer', body, currentPath: '/leverantorer', heartbeat, partial, escalationCount });
}

export function renderVendorDetail({ vendor, contracts = [], heartbeat = null, partial = false, escalationCount = 0 } = {}) {
  if (!vendor) {
    return layout({
      title: 'Okänd leverantör',
      body: '<div class="card"><h3>Okänd leverantör</h3><p><a href="/leverantorer">← Leverantörer</a></p></div>',
      currentPath: '/leverantorer', heartbeat, partial, escalationCount,
    });
  }
  const allProducts = [...new Set(contracts.flatMap((c) => c.products))];
  const kommuner = [...new Map(contracts.map((c) => [c.kommun_kod, c.kommun_namn])).entries()];
  const rows = contracts.map((c) => `
    <tr>
      <td><a href="/kommun/${escapeHtml(c.kommun_kod)}">${escapeHtml(c.kommun_namn)}</a></td>
      <td>${escapeHtml(c.received_at?.slice(0, 10) ?? '')}</td>
      <td><a href="/attachments/${c.attachment_id}" target="_blank" rel="noopener">📎 ${escapeHtml(c.filename)}</a></td>
      <td><div class="tag-list">${c.products.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div></td>
      <td>${escapeHtml(c.avtalsvarde ?? '—')}</td>
      <td>${activeBadge(c.period_end)}</td>
    </tr>`).join('');
  const body = `
    <p><a href="/leverantorer">← Leverantörer</a></p>
    <div class="card">
      <h3>${escapeHtml(vendor.name)}</h3>
      ${allProducts.length ? `<div class="tag-list" style="margin:6px 0">${allProducts.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div>` : ''}
      <p class="muted">${contracts.length} avtal · ${kommuner.length} kommun(er): ${kommuner.map(([kod, namn]) => `<a href="/kommun/${escapeHtml(kod)}">${escapeHtml(namn)}</a>`).join(', ')}</p>
    </div>
    <div class="card">
      <h3>Avtal (${contracts.length})</h3>
      <table class="contracts-table">
        <thead><tr><th>Kommun</th><th>Datum</th><th>Fil</th><th>Produkter</th><th>Värde</th><th>Avtalstid</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return layout({ title: vendor.name, body, currentPath: '/leverantorer', heartbeat, partial, escalationCount });
}
