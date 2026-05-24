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
    --bg: #0b0d10;
    --bg-elev: #14181d;
    --bg-elev-2: #1c2128;
    --fg: #e6edf3;
    --fg-muted: #9aa4b2;
    --border: #2a313c;
    --accent: #58a6ff;
    --good: #22c55e;
    --warn: #f59e0b;
    --bad: #ef4444;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #ffffff;
      --bg-elev: #f6f8fa;
      --bg-elev-2: #eef1f4;
      --fg: #1f2937;
      --fg-muted: #4b5563;
      --border: #d0d7de;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg);
    color: var(--fg);
    font-size: 14px;
    line-height: 1.45;
  }
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
  main { padding: 20px 24px 60px; max-width: 1400px; margin: 0 auto; }
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
  footer { margin-top: 60px; padding: 20px 24px; text-align: center; color: var(--fg-muted); font-size: 11px; border-top: 1px solid var(--border); }
</style>
`;

function layout({ title, body, currentPath = '/' }) {
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Pilot dashboard</title>
  ${baseCss}
</head>
<body>
  <header>
    <h1>Mediagraf · Pilot</h1>
    <nav>
      <a href="/"${currentPath === '/' ? ' style="color:var(--fg)"' : ''}>Översikt</a>
      <a href="/escalations"${currentPath === '/escalations' ? ' style="color:var(--fg)"' : ''}>Eskaleringar</a>
      <a href="/activity"${currentPath === '/activity' ? ' style="color:var(--fg)"' : ''}>Aktivitet</a>
    </nav>
    <div class="spacer"></div>
    <div class="refresh-info">auto-refresh 30s · ${new Date().toLocaleTimeString('sv-SE')}</div>
  </header>
  <main>${body}</main>
  <footer>data/pilot.db · data/municipalities.json · data/contracts/</footer>
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

export function renderOverview({ summary, rows, filter, sort, order, totalKommuner }) {
  const filters = [
    { key: 'all', label: `Alla (${totalKommuner})` },
    { key: 'in-pilot', label: `I pilot (${summary.in_pilot})` },
    { key: 'needs-attention', label: `Behöver dig (${summary.needs_human + summary.open_escalations})` },
    { key: 'delivering', label: `Levererar (${summary.delivering})` },
    { key: 'done', label: `Klart (${summary.done})` },
    { key: 'dead-end', label: `Återvändsgränd (${summary.dead_end})` },
  ];

  // Preserve sort+order when switching filter
  const filterParams = (key) => {
    const p = new URLSearchParams();
    if (key !== 'all') p.set('filter', key);
    if (sort) p.set('sort', sort);
    if (order) p.set('order', order);
    return p.toString();
  };

  const filterBar = `<div class="filter-bar">${filters
    .map(
      (f) =>
        `<a href="?${filterParams(f.key)}"${(filter ?? 'all') === f.key ? ' class="active"' : ''}>${escapeHtml(f.label)}</a>`
    )
    .join('')}</div>`;

  const stats = `
    <div class="stats">
      <div class="stat-card"><div class="label">I pilot</div><div class="value">${summary.in_pilot}</div></div>
      <div class="stat-card"><div class="label">Levererar</div><div class="value good">${summary.delivering}</div></div>
      <div class="stat-card"><div class="label">Klart</div><div class="value good">${summary.done}</div></div>
      <div class="stat-card"><div class="label">Behöver dig</div><div class="value ${summary.needs_human + summary.open_escalations > 0 ? 'bad' : ''}">${summary.needs_human + summary.open_escalations}</div></div>
      <div class="stat-card"><div class="label">Avtal mottagna</div><div class="value">${summary.contracts}</div></div>
      <div class="stat-card"><div class="label">Snittsvarstid</div><div class="value">${summary.avg_reply_days === null ? '—' : summary.avg_reply_days + ' d'}</div></div>
    </div>
  `;

  const tableRows = rows.length === 0
    ? '<tr class="empty-row"><td colspan="8">Inga kommuner matchar filtret.</td></tr>'
    : rows
        .map((r) => {
          const stateCell = r.states.length === 0
            ? '<span class="muted">— ej kontaktad —</span>'
            : `<div class="pill-list">${r.states.map((s) => `<span title="${escapeHtml(s.role)}">${stateBadge(s.state)}</span>`).join('')}</div>`;
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

  const headerArgs = { currentSort: sort, currentOrder: order, filter };
  const body = `
    ${stats}
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
  `;

  return layout({ title: 'Översikt', body, currentPath: '/' });
}

// ---- Kommun detail ----

export function renderKommunDetail({ kommun, conversations, messagesByConv, attachmentsByMsg, escalationsByConv, signatures, followUpByConv = {} }) {
  if (!kommun) {
    return layout({ title: 'Saknad kommun', body: '<p>Hittade inte kommunen.</p>', currentPath: '/' });
  }
  const contactBlock = kommun.contacts && kommun.contacts.length > 0
    ? `<details><summary>Kontaktadresser i datasetet (${kommun.contacts.length})</summary>
        <ul>${kommun.contacts.map((c) => `<li><code>${escapeHtml(c.email)}</code> <span class="muted">${escapeHtml(c.role)}${c.forvaltning_namn ? ' · ' + escapeHtml(c.forvaltning_namn) : ''}</span></li>`).join('')}</ul>
      </details>`
    : '<p class="muted">Inga kontaktadresser i datasetet.</p>';

  const convCards = conversations.length === 0
    ? '<p class="muted">Ingen pilot-konversation för denna kommun ännu.</p>'
    : conversations.map((conv) => {
        const msgs = messagesByConv[conv.id] ?? [];
        const escs = escalationsByConv[conv.id] ?? [];

        const messagesHtml = msgs.length === 0 ? '<p class="muted">Inga meddelanden ännu.</p>' : msgs.map((m) => {
          const direction = m.direction === 'inbound' ? '⬇ Inkommande' : '⬆ Utgående';
          const cls = m.direction === 'inbound' ? 'body-quote-inbound' : 'body-quote-outbound';
          const analysis = parseJsonSafe(m.analysis_json);
          const classBadge = analysis
            ? ` · ${intentBadge(analysis.intent)} <span class="muted">(${(analysis.confidence ?? 0).toFixed(2)})</span>`
            : (m.classification ? ` · <span class="badge" style="background:#a855f71a;color:#a855f7;border:1px solid #a855f766">${escapeHtml(m.classification)} (${(m.classification_confidence ?? 0).toFixed(2)})</span>` : '');
          const analysisBlock = analysis ? `
            <div class="card" style="background:var(--bg-elev-2);margin:8px 0;padding:10px 12px">
              <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">LLM-analys · ${escapeHtml(analysis.suggested_action ?? '')}</div>
              <div>${escapeHtml(analysis.summary ?? '')}</div>
              ${analysis.follow_up_at ? `<div class="muted" style="margin-top:4px">Återkommer: <strong>${escapeHtml(analysis.follow_up_at)}</strong> · ${fmtFollowUpBadge(analysis.follow_up_at)}</div>` : ''}
              ${analysis.extracted && Object.values(analysis.extracted).some((v) => v != null && (!Array.isArray(v) || v.length > 0)) ? `
                <details style="margin-top:6px">
                  <summary>Extraherade fält</summary>
                  <dl class="signature-fields" style="margin-top:4px"><div class="signature-fields"><dl>
                    ${analysis.extracted.arendenummer ? `<dt>Ärendenummer</dt><dd>${escapeHtml(analysis.extracted.arendenummer)}</dd>` : ''}
                    ${analysis.extracted.promised_response_days != null ? `<dt>Utlovade dagar</dt><dd>${analysis.extracted.promised_response_days}</dd>` : ''}
                    ${analysis.extracted.promised_response_date ? `<dt>Utlovat datum</dt><dd>${escapeHtml(analysis.extracted.promised_response_date)}</dd>` : ''}
                    ${analysis.extracted.handoff_to_email ? `<dt>Hänvisar till e-post</dt><dd>${escapeHtml(analysis.extracted.handoff_to_email)}</dd>` : ''}
                    ${analysis.extracted.handoff_to_forvaltning ? `<dt>Hänvisar till förvaltning</dt><dd>${escapeHtml(analysis.extracted.handoff_to_forvaltning)}</dd>` : ''}
                    ${analysis.extracted.questions?.length ? `<dt>Frågor</dt><dd>${analysis.extracted.questions.map((q) => escapeHtml(q)).join('<br>')}</dd>` : ''}
                    ${analysis.extracted.mentioned_vendors?.length ? `<dt>Nämnda leverantörer</dt><dd>${analysis.extracted.mentioned_vendors.map((v) => escapeHtml(v)).join(', ')}</dd>` : ''}
                  </dl></div></dl>
                </details>` : ''}
              ${analysis.draft_reply ? `
                <details style="margin-top:6px">
                  <summary>Föreslaget svar (för manuell granskning)</summary>
                  <div class="body-quote body-quote-outbound" style="margin-top:6px">${escapeHtml(analysis.draft_reply)}</div>
                </details>` : ''}
            </div>` : '';
          const atts = (attachmentsByMsg[m.id] ?? []).map((a) => `📎 ${escapeHtml(a.filename)}`).join(', ');
          const sig = signatures[m.id];
          const sigBlock = sig ? `
            <div class="signature-fields">
              <details>
                <summary>Extraherad kontaktinfo</summary>
                <dl>
                  ${sig.name ? `<dt>Namn</dt><dd>${escapeHtml(sig.name)}</dd>` : ''}
                  ${sig.title ? `<dt>Titel</dt><dd>${escapeHtml(sig.title)}</dd>` : ''}
                  ${sig.forvaltning ? `<dt>Förvaltning</dt><dd>${escapeHtml(sig.forvaltning)}</dd>` : ''}
                  ${sig.email ? `<dt>E-post</dt><dd>${escapeHtml(sig.email)}</dd>` : ''}
                  ${sig.phone ? `<dt>Telefon</dt><dd>${escapeHtml(sig.phone)}</dd>` : ''}
                  ${sig.postal ? `<dt>Adress</dt><dd>${escapeHtml(sig.postal)}</dd>` : ''}
                  ${sig.website ? `<dt>Webb</dt><dd>${escapeHtml(sig.website)}</dd>` : ''}
                </dl>
              </details>
            </div>` : '';
          return `
            <div class="card">
              <h3>${direction} · <span class="muted">${escapeHtml(m.received_at)}</span>${classBadge}</h3>
              <div>${escapeHtml(m.subject ?? '')}</div>
              <div class="body-quote ${cls}">${escapeHtml(m.body_text ?? '')}</div>
              ${analysisBlock}
              ${atts ? `<div>${atts}</div>` : ''}
              ${sigBlock}
            </div>`;
        }).join('');

        const escHtml = escs.length === 0 ? '' : `
          <h3 style="margin:14px 0 6px">Öppna eskaleringar (${escs.length})</h3>
          ${escs.map((e) => `
            <div class="card">
              <strong>${escapeHtml(e.draft_template ?? 'free_form')}</strong> · <span class="muted">${escapeHtml(e.reason)}</span>
              <div class="body-quote">${escapeHtml(e.draft_body ?? '(ingen draft)')}</div>
            </div>`).join('')}`;

        const fu = followUpByConv[conv.id] ?? { date: null, source: null };
        const followUpBadge = fu.date ? fmtFollowUpBadge(fu.date, fu.source) : null;
        const followUpLine = fu.date
          ? `<div class="muted">⏳ Nästa kontakt: <strong>${escapeHtml(fu.date)}</strong> · ${followUpBadge} <span class="muted">(${fu.source === 'kommun_promise' ? 'kommunen utlovade detta datum' : 'standardpåminnelse efter ' + (fu.source === 'our_followup' ? 'tystnad' : '')})</span></div>`
          : '';
        return `
          <div class="card">
            <h3>Roll: ${escapeHtml(conv.role)} · ${stateBadge(conv.state)} ${conv.arendenummer ? ` · <span class="muted">Ärendenummer: ${escapeHtml(conv.arendenummer)}</span>` : ''}</h3>
            <div class="muted">Kontaktadress: <code>${escapeHtml(conv.contact_email)}</code> · Senast utgående: ${fmtAgo(conv.last_outbound_at)} · Tillstånd ändrat: ${fmtAgo(conv.state_changed_at)} · Påminnelser: ${conv.followup_count}</div>
            ${followUpLine}
            ${messagesHtml}
            ${escHtml}
          </div>`;
      }).join('');

  const body = `
    <p><a href="/">← Översikt</a></p>
    <h2>${escapeHtml(kommun.kommun_namn)} kommun <span class="muted" style="font-weight:400">${escapeHtml(kommun.kommun_kod)} · ${escapeHtml(kommun.lan ?? '')} · ${fmtInt(kommun.folkmangd)} inv.</span></h2>
    ${contactBlock}
    <h2>Pilot-konversationer</h2>
    ${convCards}
  `;
  return layout({ title: kommun.kommun_namn, body, currentPath: '/' });
}

// ---- Escalations queue ----

export function renderEscalations({ items }) {
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
          <div style="margin-top:8px">Förslag på svar:</div>
          <div class="body-quote body-quote-outbound">${escapeHtml(e.draft_subject ? 'Subject: ' + e.draft_subject + '\n\n' : '')}${escapeHtml(e.draft_body ?? '(ingen draft)')}</div>
          <div class="muted" style="margin-top:8px;font-family:ui-monospace,monospace;font-size:11px">
            För att svara från terminalen: <code>npm run pilot-resolve -- --escalation=${e.id} --action=send</code>
            eller <code>--action=edit --text="..."</code>
            eller <code>--action=skip</code>
          </div>
        </div>`).join('');

  return layout({ title: 'Eskaleringar', body: `<h2>Öppna eskaleringar (${items.length})</h2>${body}`, currentPath: '/escalations' });
}

// ---- Activity feed ----

export function renderActivity({ events }) {
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
  return layout({ title: 'Aktivitet', body: `<h2>Senaste aktivitet (${events.length})</h2>${body}`, currentPath: '/activity' });
}
