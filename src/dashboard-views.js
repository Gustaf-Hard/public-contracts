// HTML view layer for the pilot dashboard. Pure functions that take data
// objects and return HTML strings. No template engine; the only client-side
// JS is the progressive enhancement in public/app.js and the /leverantorer
// explorer (public/explorer.js over the pure public/explorer-core.js).

// The explorer's pure logic is shared verbatim between server (initial
// render + filter options) and browser (live slice & dice) — one source of
// truth for bands, labels and aggregates.
import {
  deriveOptions,
  aggregateFacts,
  renewalWindow,
  PRICING_MODEL_LABELS,
  UNKNOWN,
} from '../public/explorer-core.js';
import { GRADE_LEVELS, slugifyProductName } from './vendor-analytics.js';
import { matchResellers, RESELLERS } from './resellers.js';

// Canonical reseller name → slug, for linking a vendor's framed ramavtal tag
// to /ramavtal/:slug. Built once from the curated RESELLERS list.
const RESELLER_SLUG_BY_CANONICAL = new Map(RESELLERS.map((r) => [r.canonical, r.slug]));

// A generic vendor glyph (small inline SVG) for the vertical Leverantörer list.
const VENDOR_ICON = '<svg class="vendor-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 1.8 14 5v6L8 14.2 2 11V5L8 1.8Z"/><path d="M2 5l6 3 6-3M8 8v6.2"/></svg>';

// A frame ("ram" = frame in Swedish) glyph for ramavtal — the visual for the
// framework-agreement entity in the header and the per-vendor pill.
const FRAME_ICON = '<svg class="frame-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="1.5"/><rect x="4.75" y="4.75" width="6.5" height="6.5" rx="0.75"/></svg>';

// An "open in a new tab" glyph — a quick affordance next to each stored
// document so the operator can open the file without hunting for the filename.
const EXTLINK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';

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

// Perpetual contract refresh (2026-07-09 design §3.7): a closed (DONE) case is
// not the end of the story — it shows when the bot will re-contact the kommun
// and which contract drove that date. Sourced from conversations.next_review_at
// / next_review_source (NOT effectiveFollowUp, which is null on DONE by design).
export function fmtNextReviewBadge(conv) {
  if (!conv || conv.state !== 'DONE' || !conv.next_review_at) return null;
  const vendorClause = conv.next_review_source
    ? ` — pga ${escapeHtml(conv.next_review_source)}`
    : '';
  return `<span class="pill pill-default" title="Automatisk uppdateringsförfrågan planerad">Återkommer ${escapeHtml(conv.next_review_at)}${vendorClause}</span>`;
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
  REFRESH_DUE:        { label: '🔄 Uppdatering — väntar godkännande', color: '#0ea5e9', terminal: false },
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
  /* Reseller/framework-channel badge: deliberately muted (an information
     marker, not an alarm) — the elevation/border vars keep it legible in
     both colour schemes. */
  .pill-reseller { background: var(--bg-elev-2); color: var(--fg-muted); border-color: var(--border); }
  .cov-toggle { margin-left: 8px; font-size: 12px; white-space: nowrap; }
  .heartbeat { font-size: 11px; padding: 3px 9px; border-radius: 999px; border: 1px solid; font-weight: 500; }
  .heartbeat-live  { background: #22c55e1a; color: var(--good); border-color: #22c55e66; }
  .heartbeat-stale { background: #f59e0b1a; color: var(--warn); border-color: #f59e0b66; }
  .heartbeat-off   { background: #ef44441a; color: var(--bad);  border-color: #ef444466; }
  .pill-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .muted { color: var(--fg-muted); }
  .vacation-banner { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; font-size: 13px;
    background: var(--bg-elev-2); color: var(--fg-muted); border: 1px solid var(--border); }
  /* Product intelligence: coverage matrix (2026-07-10 design) */
  .cov-table th.cov-head { text-align: center; }
  .cov-table td.cov-cell { text-align: center; font-size: 13px; }
  .cov-cell.cov-full    { background: #22c55e1a; color: var(--good); }
  .cov-cell.cov-partial { background: #f59e0b1a; color: var(--warn); }
  .cov-cell.cov-none    { background: #ef44441a; color: var(--bad); }
  /* unknown = insamling pågår: translucent grey works in both colour schemes,
     --fg-muted flips with prefers-color-scheme. Distinct from cov-na (no bg). */
  .cov-cell.cov-unknown { background: #6b72801a; color: var(--fg-muted); }
  .cov-cell.cov-na      { color: var(--fg-muted); }
  .cov-detail { background: transparent; border-radius: 0; padding: 0; margin: 0; display: inline-block; position: relative; }
  .cov-detail summary { cursor: pointer; list-style: none; color: inherit; font-size: 13px; }
  .cov-detail summary::-webkit-details-marker { display: none; }
  .cov-pop {
    position: absolute; z-index: 20; left: 50%; transform: translateX(-50%);
    background: var(--bg-elev); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; box-shadow: var(--shadow); text-align: left;
    color: var(--fg); font-size: 12px; white-space: nowrap;
  }
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
  /* Vertical Leverantörer list (kommun page) */
  .vendor-list { display: flex; flex-direction: column; gap: 2px; }
  .vendor-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 3px 0; font-size: 12px; }
  .vendor-row.muted { opacity: 0.72; }
  .vendor-row .vendor-icon { flex: none; color: var(--fg-muted); }
  .vendor-row .vendor-name { font-weight: 500; }
  .vendor-row .vendor-name a { color: var(--fg); text-decoration: none; }
  .vendor-row .vendor-name a:hover { color: var(--accent); text-decoration: underline; }
  .pill-ramavtal { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border: 1px solid var(--border); border-radius: 4px; font-size: 10px; color: var(--fg-muted); background: var(--bg-elev-2); text-decoration: none; }
  a.pill-ramavtal:hover { border-color: var(--accent); color: var(--accent); }
  .contracts-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
  .contracts-table th, .contracts-table td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  .contracts-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); }
  .doc-open { display: inline-flex; align-items: center; color: var(--fg-muted); }
  .doc-open:hover { color: var(--accent); }
  .doc-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; border: 1px solid; }
  .doc-badge-avtal { background: #22c55e1a; color: var(--good); border-color: #22c55e66; }
  .doc-badge-muted { background: var(--bg-elev-2); color: var(--fg-muted); border-color: var(--border); font-weight: 500; }
  .doc-row-muted { opacity: 0.62; }
  .quick-actions { display: flex; flex-direction: column; gap: 6px; }
  .quick-actions a { font-size: 12px; padding: 6px 10px; border-radius: 6px; background: var(--bg-elev-2); border: 1px solid var(--border); color: var(--fg); text-decoration: none; display: flex; align-items: center; gap: 6px; }
  .quick-actions a:hover { border-color: var(--accent); color: var(--accent); }
  /* Case card */
  .case-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
  .case-header h3 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; min-width: 200px; }
  .case-meta { color: var(--fg-muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0 0 12px; }
  .case-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .case-actions form { display: inline-block; margin: 0; }
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
  .master-detail { display: grid; grid-template-columns: 380px 1fr; gap: var(--sp-4); align-items: start; }
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
  .esc-watchlist { margin-bottom: 8px; padding: 6px 10px; border-radius: 6px; background: #fde8e8; color: #9b1c1c; font-weight: 600; }
  hr.soft { border: none; border-top: 1px solid var(--border); margin: 12px 0; }
  .collapse-toggle { background: none; border: none; color: var(--accent); font: inherit; font-size: 12px;
    cursor: pointer; padding: 4px 0; }
  .collapse-toggle:hover { text-decoration: underline; }
  /* Vendor list pane */
  .vendor-item { display: block; padding: 12px 14px; border-bottom: 1px solid var(--border); color: var(--fg); }
  .vendor-item:last-child { border-bottom: none; }
  .vendor-item:hover { background: var(--bg-elev-2); text-decoration: none; }
  .vendor-item.active { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
  .vendor-item .vi-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-bottom: 6px; font-size: 12px; }
  .vendor-item .vi-name { font-weight: 600; font-size: 14px; }
  .chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
  .quick-init { display: inline; } .quick-init-edit { margin-left: 6px; text-decoration: none; }
  .tag-more { background: transparent; border-style: dashed; }
  /* Gmail-style inbox rows (Ärenden list) */
  .mail-row { display: grid; grid-template-columns: 10px minmax(110px, 150px) 1fr auto; align-items: center; gap: 10px;
    padding: 9px 14px; border-bottom: 1px solid var(--border); color: var(--fg); }
  .mail-row:last-child { border-bottom: none; }
  .mail-row:hover { background: var(--bg-elev-2); text-decoration: none; }
  .mail-row.active { background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
  .mail-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); }
  .mail-dot.bad { background: var(--bad); } .mail-dot.ok { background: var(--accent); } .mail-dot.muted { background: var(--border); }
  .mail-sender { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
  .mail-row.unread .mail-sender, .mail-row.unread .mail-subject { font-weight: 700; }
  .mail-line { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
  .mail-date { font-size: 12px; white-space: nowrap; }
  /* Gmail-style thread (Ärenden detail) */
  .thread-head { padding-bottom: var(--sp-3); border-bottom: 1px solid var(--border); margin-bottom: var(--sp-4); }
  .thread-title-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .thread-subject { margin: 0; font-size: 20px; font-weight: 600; }
  .thread-meta { margin-top: 6px; font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
  .thread-msgs { display: flex; flex-direction: column; }
  .msg { border: 1px solid var(--border); border-radius: var(--r-2); margin-bottom: 10px; background: var(--bg-elev); overflow: hidden; box-shadow: var(--shadow); }
  .msg-outbound { background: color-mix(in srgb, var(--good) 6%, var(--bg-elev)); }
  .msg-head { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; }
  .msg-head:hover { background: var(--bg-elev-2); }
  .avatar { width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-weight: 600; font-size: 14px; background: var(--bg-elev-2); color: var(--fg-muted); flex: none; }
  .avatar-inbound { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .avatar-outbound { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
  .msg-who { min-width: 0; }
  .msg-from { font-weight: 600; font-size: 13px; }
  .msg-addr { font-weight: 400; }
  .msg-snippet { display: block; font-size: 12px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .msg-date { font-size: 12px; white-space: nowrap; }
  .msg-body { padding: 0 16px 16px 60px; }
  .msg-text { white-space: pre-wrap; font-size: 13px; line-height: 1.55; }
  .msg-atts { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
  .msg-att { font-size: 12px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--r-2); background: var(--bg-elev-2); }
  /* Gmail-style reply box */
  .reply-box { border: 1px solid var(--accent); border-radius: var(--r-2); margin: 14px 0; background: var(--bg-elev); box-shadow: var(--shadow); overflow: hidden; }
  .reply-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .reply-box > form { padding: 0 14px; }
  .reply-box > form:first-of-type { padding-top: 12px; }
  .reply-box > form:last-of-type { padding-bottom: 14px; }
  /* Health modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(8,11,16,.55); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 20px; }
  .modal { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--r-3); box-shadow: 0 12px 40px rgba(0,0,0,.35); max-width: 520px; width: 100%; padding: 24px 26px; }
  .modal h2 { margin: 0 0 12px; font-size: 18px; }
  .modal p { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
  .modal code { background: var(--bg-elev-2); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .modal-actions { display: flex; gap: 10px; margin-top: 18px; }
  .modal-status { font-size: 13px; padding: 10px 12px; border-radius: var(--r-2); background: var(--bg-elev-2); margin: 4px 0 0; }
  .modal-status.ok { color: var(--good); } .modal-status.err { color: var(--bad); }
  .thread-group { border: 1px solid var(--border); border-radius: 8px; margin: 10px 0; overflow: hidden; }
  .thread-group.thread-muted { opacity: 0.72; }
  /* A thread with a pending escalation needs the operator — light-red tint. */
  .thread-group.thread-needs-action { background: rgba(220, 38, 38, 0.06); border-color: rgba(220, 38, 38, 0.45); opacity: 1; }
  .thread-group.thread-needs-action .thread-head:hover { background: rgba(220, 38, 38, 0.10); }
  /* Collapsed thread row: clickable inbox-style header, hidden body until opened. */
  .thread-group .thread-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; cursor: pointer; margin: 0; border-bottom: none; }
  .thread-group .thread-head:hover { background: var(--bg-elev-2); }
  .thread-group[data-open] .thread-head, .thread-group .thread-head[aria-expanded="true"] { border-bottom: 1px solid var(--border); }
  .thread-head-main { flex: 1; min-width: 0; }
  .thread-head-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .thread-email { font-size: 12px; }
  .thread-preview { font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .thread-head-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 11px; white-space: nowrap; }
  .thread-body { padding: 8px 12px 12px; }
  .thread-status { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--border); }
  .thread-status-primary { color: var(--accent); border-color: var(--accent); }
  .thread-status-muted { color: var(--fg-muted); }
  .thread-group .btn-link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; }
  /* Vendor data center (/leverantorer) */
  .stat-card .stat-sub { font-size: 11px; margin-top: 4px; }
  .honesty-note { font-size: 12px; margin: -8px 0 20px; }
  .explorer-controls { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end; margin: 0 0 12px;
    background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--r-2); padding: 12px 14px; box-shadow: var(--shadow); }
  .explorer-controls .x-control { display: flex; flex-direction: column; gap: 3px; font-size: 11px;
    color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .explorer-controls select, .explorer-controls input[type=search] {
    font: inherit; font-size: 13px; text-transform: none; letter-spacing: normal;
    background: var(--bg-elev-2); color: var(--fg); border: 1px solid var(--border);
    border-radius: var(--r-1); padding: 6px 8px; min-width: 120px; }
  .explorer-controls input[type=search] { min-width: 220px; }
  .explorer-controls select:focus, .explorer-controls input[type=search]:focus { outline: none; border-color: var(--accent); }
  .explorer-controls .btn { padding: 6px 12px; font-size: 12px; }
  .explorer-summary { font-size: 13px; font-weight: 600; margin: 0 0 8px; font-variant-numeric: tabular-nums; }
  .explorer-table td, .explorer-table th { font-size: 13px; }
  tr.x-group-row td { background: var(--bg-elev-2); font-weight: 700; font-size: 12px;
    text-transform: uppercase; letter-spacing: .4px; }
  tr.x-group-row td .x-group-agg { font-weight: 500; text-transform: none; letter-spacing: normal; color: var(--fg-muted); margin-left: 10px; }
  .renewal-list { list-style: none; margin: 0; padding: 0; }
  .renewal-item { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--border); font-size: 13px; }
  .renewal-item:last-child { border-bottom: none; }
  .renewal-date { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 90px; }
</style>
`;

// Render the daemon-heartbeat pill for the header. Thresholds: live <= 20 min,
// stale 20-60 min, off > 60 min or no tick recorded yet.
// Human "X min/h/dagar sedan" for an ISO timestamp.
function agoLabel(iso) {
  if (!iso) return '—';
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just nu';
  if (m === 1) return '1 min sedan';
  if (m < 120) return `${m} min sedan`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h sedan`;
  return `${Math.floor(h / 24)} dagar sedan`;
}

// The pill keys off the last *successful* tick — so a daemon that's up but
// failing (e.g. invalid_grant) reads red, not green.
function renderHeartbeatPill(h) {
  if (!h || !h.ever) {
    return `<span class="heartbeat heartbeat-off" title="Ingen lyckad bearbetning ännu.">🔴 daemon AV</span>`;
  }
  const title = `Senaste lyckade bearbetning: ${h.last_success_at}${h.last_error ? '\nSenaste fel: ' + h.last_error : ''}`;
  if (!h.stale) {
    return `<span class="heartbeat heartbeat-live" title="${escapeHtml(title)}">🟢 daemon · ${agoLabel(h.last_success_at)}</span>`;
  }
  return `<span class="heartbeat heartbeat-off" title="${escapeHtml(title)}">🔴 daemon blind · ${agoLabel(h.last_success_at)}</span>`;
}

// Blocking modal shown on full page loads when the pipeline is unhealthy, with
// a one-click in-app Gmail re-auth. `app.js` handles dismiss + the reauth flow.
function renderHealthModal(h) {
  const invalidGrant = (h.last_error ?? '').toLowerCase().includes('invalid_grant');
  let cause;
  if (invalidGrant) cause = 'Gmail-behörigheten har gått ut (<code>invalid_grant</code>).';
  else if (!h.ever) cause = 'Daemonen har inte kört någon lyckad bearbetning ännu.';
  else cause = `Daemonen har inte bearbetat mejl sedan <strong>${escapeHtml((h.last_success_at ?? '').slice(0, 16).replace('T', ' '))}</strong>.`;
  return `
  <div class="modal-overlay" data-health-modal>
    <div class="modal" role="dialog" aria-modal="true">
      <h2>⚠️ Inkommande mejl bearbetas inte</h2>
      <p>${cause}</p>
      <p class="muted">Nya svar och avtal fångas inte, och statusarna nedan kan vara inaktuella (de visar senast kända läge).</p>
      <div class="modal-status" data-reauth-status hidden></div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary" data-reauth>🔌 Återanslut Gmail</button>
        <button type="button" class="btn btn-secondary" data-dismiss-modal>Stäng</button>
      </div>
    </div>
  </div>`;
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
  ${heartbeat?.stale ? renderHealthModal(heartbeat) : ''}
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

export function renderOverview({ summary, rows, filter, sort, order, totalKommuner, q = '', actionQueue = [], waiting = [], vacationActive = false, heartbeat = null, partial = false, escalationCount = 0 }) {
  const activeFilter = filter ?? 'active';
  // Vacation mode (2026-07-17): a muted banner so the operator knows the
  // proactive staleness loop is paused for the summer. Real inbound and the
  // refresh scan keep running.
  const vacationBanner = vacationActive
    ? '<div class="vacation-banner">☀️ Sommarläge — automatisk bevakning pausad t.o.m. 30 juli</div>'
    : '';
  const filters = [
    { key: 'active', label: `Aktiva (${summary.in_pilot})` },
    { key: 'needs-attention', label: `Behöver dig (${actionQueue.length})` },
    { key: 'delivering', label: `Levererar (${summary.delivering})` },
    { key: 'done', label: `Klart (${summary.done})` },
    { key: 'dead-end', label: `Återvändsgränd (${summary.dead_end})` },
    { key: 'all', label: `Visa alla (${totalKommuner})` },
  ];

  // Preserve sort+order+search when switching filter. The filter is always set
  // explicitly (incl. 'all') — the route defaults to 'active', so an omitted
  // param would silently fall back to active instead of showing all kommuner.
  const filterParams = (key) => {
    const p = new URLSearchParams();
    p.set('filter', key);
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

  const needsCount = actionQueue.length;
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
            ? `<form method="post" action="/kommun/${escapeHtml(r.kommun_kod)}/quick-init" class="quick-init">
                 <button type="submit" class="compose-link" title="Skicka T-INITIAL till första kontakten">📨 Skicka</button>
               </form>
               <a class="muted quick-init-edit" href="/kommun/${escapeHtml(r.kommun_kod)}/compose" title="Redigera innan du skickar">✎</a>`
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
    ${vacationBanner}
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

export function renderEscalationForm(esc, gmailReady, returnTo = null) {
  const disabled = gmailReady ? '' : 'disabled';
  const warn = gmailReady ? '' : '<span class="send-warning">⚠️ Gmail-token saknas — kör <code>npm run pilot-auth</code></span>';
  // When rendered inside a swappable pane, forms post via fetch and return to
  // `returnTo` (so the operator stays on the case). Otherwise they full-reload.
  const paneAttrs = returnTo ? ` data-pane-form data-return="${escapeHtml(returnTo)}"` : '';
  const returnField = returnTo ? `<input type="hidden" name="return" value="${escapeHtml(returnTo)}">` : '';
  // Two forms in the card: edit-and-send (uses textarea contents) + skip.
  // Keeping subject editable lets the user fix a wrong "Re:" prefix.
  const watchVendors = (() => { try { return JSON.parse(esc.watchlist_vendors ?? '[]'); } catch { return []; } })();
  const watchBanner = Array.isArray(watchVendors) && watchVendors.length
    ? `<div class="esc-watchlist">⚠️ Bevakad leverantör: ${escapeHtml(watchVendors.join(', '))} — kontrollera innan du svarar.</div>`
    : '';
  return `
    ${watchBanner}
    <form class="action-form" method="post" action="/escalations/${esc.id}"${paneAttrs}>
      ${returnField}
      <div class="field">
        <label>Till</label>
        <!-- type=text, not email: the recipient is an RFC 5322 "Namn <adress>"
             value, which the browser's native email validation rejects. -->
        <input type="text" name="to" value="${escapeHtml(esc.recipient ?? '')}">
      </div>
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

// Distinct vendor names on this kommun's CONFIRMED contracts (is_contract=1
// attachments carry contract_vendor_name via the route's LEFT JOIN vendors).
// These are the vendors we actually hold a signed avtal for — a stronger
// claim than "mentioned".
function aggregateConfirmedVendors(conversations, messagesByConv, attachmentsByMsg) {
  const vendors = new Set();
  for (const conv of conversations) {
    for (const m of messagesByConv[conv.id] ?? []) {
      for (const att of attachmentsByMsg[m.id] ?? []) {
        const isContract = att.contract_is_contract === 1 || att.contract_is_contract === true;
        if (isContract && att.contract_vendor_name) vendors.add(att.contract_vendor_name);
      }
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
          mime_type: att.mime_type,
          size_bytes: att.size_bytes,
          received_at: m.received_at,
          role: conv.role,
          conv_id: conv.id,
          is_contract: att.contract_is_contract,
          document_type: att.contract_document_type,
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

// Type badge for a received document (2026-07-15 contract-validation). A real
// avtal (is_contract=1) is prominent; bilagor / PUB-avtal / följebrev / övrigt
// are muted — visible but de-emphasized. NULL classification (legacy / not-yet
// re-analysed) gets no badge rather than a wrong one.
function docTypeBadge(att) {
  const isContract = att.is_contract === 1 || att.is_contract === true;
  if (isContract) return { label: 'Avtal', muted: false };
  switch (att.document_type) {
    case 'bilaga': return { label: 'Bilaga', muted: true };
    case 'personuppgiftsbiträdesavtal': return { label: 'PUB-avtal', muted: true };
    case 'följebrev_sammanställning': return { label: 'Följebrev', muted: true };
    case 'prislista':
    case 'sekretessbeslut':
    case 'övrigt': return { label: 'Övrigt', muted: true };
    default: return null; // NULL / unknown → no badge
  }
}

export function renderKommunDetail({ kommun, conversations, messagesByConv, attachmentsByMsg, escalationsByConv, signatures, followUpByConv = {}, threadsByConv = {}, initialDrafts = {}, gmailReady = false, vendorSlugsByName = new Map(), resellerRelationsByVendor = new Map(), handoffContacts = [], heartbeat = null, partial = false, escalationCount = 0 }) {
  if (!kommun) {
    return layout({ title: 'Saknad kommun', body: '<p>Hittade inte kommunen.</p>', currentPath: '/', heartbeat, partial, escalationCount });
  }

  // ----- Aggregations for the sidebar + bottom sections -----
  const today = new Date().toISOString().slice(0, 10);
  const activeCases = conversations.filter((c) => !CASE_STATUS[c.state]?.terminal);
  const closedCases = conversations.filter((c) => CASE_STATUS[c.state]?.terminal);
  const completeness = completenessBanner(conversations);
  const people = aggregatePeople(conversations, messagesByConv, signatures);
  const mentionedVendors = aggregateVendors(conversations, messagesByConv);
  const confirmedVendors = aggregateConfirmedVendors(conversations, messagesByConv, attachmentsByMsg);
  const contracts = aggregateContracts(conversations, messagesByConv, attachmentsByMsg);

  // Reseller/framework channel names must not appear as "Nämnda" rows — that
  // just clutters the panel (ADDA/Skolon/Läromedia noise). The per-vendor
  // framed ramavtal tags below carry the specific, extracted signal instead;
  // the old kommun-level "🛒 Köper via ramavtal" summary line is gone.
  const isChannelName = (v) => matchResellers([v]).length > 0;
  // A confirmed contract vendor must NEVER also appear under "Nämnda" — the
  // stronger claim wins (data-honesty). Confirmed avtal chips stay as-is
  // (including a signed avtal that happens to be with a reseller).
  const confirmedLower = new Set(confirmedVendors.map((v) => v.toLowerCase()));
  const mentionedOnly = mentionedVendors.filter(
    (v) => !confirmedLower.has(v.toLowerCase()) && !isChannelName(v)
  );
  const vendorCount = new Set(
    [...confirmedVendors, ...mentionedOnly].map((v) => v.toLowerCase())
  ).size;

  // Render one vendor as a VERTICAL row: icon + name (linked to /leverantor/:slug
  // when we have a vendor page, else a muted plain name — no dead links), plus
  // a bordered FRAME pill `▢ <Ramavtal>` per extracted vendor→ramavtal relation
  // (from storage.listResellerRelationsForKommun), each linking to the ramavtal
  // page. The tag appears ONLY when a relation was extracted for that vendor —
  // never inferred from the kommun's channel set (data-honesty).
  const renderVendorRow = (v, { muted = false } = {}) => {
    const slug = vendorSlugsByName.get(v.toLowerCase());
    const nameHtml = slug
      ? `<a href="/leverantor/${escapeHtml(slug)}">${escapeHtml(v)}</a>`
      : `<span class="muted" title="${escapeHtml('ingen leverantörssida än')}">${escapeHtml(v)}</span>`;
    const ramavtal = resellerRelationsByVendor.get(v.toLowerCase()) ?? [];
    const pills = ramavtal.map((r) => {
      const rslug = RESELLER_SLUG_BY_CANONICAL.get(r);
      const label = `▢ ${escapeHtml(r)}`;
      return rslug
        ? `<a class="pill-ramavtal" href="/ramavtal/${escapeHtml(rslug)}" title="${escapeHtml(`Nås via ramavtal: ${r}`)}">${label}</a>`
        : `<span class="pill-ramavtal" title="${escapeHtml(`Nås via ramavtal: ${r}`)}">${label}</span>`;
    }).join('');
    return `<div class="vendor-row${muted ? ' muted' : ''}">${VENDOR_ICON}<span class="vendor-name">${nameHtml}</span>${pills}</div>`;
  };
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

  // ----- Leverantörer sidebar panel (confirmed vs. merely mentioned) -----
  // A vertical list (Pipedrive-style), each vendor its own row. The old
  // kommun-level "🛒 Köper via ramavtal" summary line is removed — the specific
  // signal now rides on the per-vendor framed ramavtal tags.
  const confirmedGroup = confirmedVendors.length === 0
    ? ''
    : `<div style="margin-bottom:8px">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Avtal bekräftat</div>
        <div class="vendor-list">${confirmedVendors.map((v) => renderVendorRow(v)).join('')}</div>
      </div>`;

  const mentionedGroup = mentionedOnly.length === 0
    ? ''
    : `<div>
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">Nämnda <span title="${escapeHtml('Endast omnämnda i kommunens svar — vi har inte sett något signerat avtal.')}">?</span></div>
        <div class="vendor-list">${mentionedOnly.map((v) => renderVendorRow(v, { muted: true })).join('')}</div>
      </div>`;

  const vendorPanel = vendorCount === 0
    ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Inga leverantörer fångade ännu.</p>'
    : `${confirmedGroup}${mentionedGroup}`;

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
        <div class="kpi-cell"><div class="kpi-label">Avtal mottagna</div><div class="kpi-value">${contracts.filter((c) => c.is_contract === 1 || c.is_contract === true).length}</div></div>
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
        <h3>Leverantörer (${vendorCount})</h3>
        ${vendorPanel}
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

  const avtalCount = contracts.filter((c) => c.is_contract === 1 || c.is_contract === true).length;
  const contractsSection = contracts.length === 0
    ? `<div class="card"><h3>Mottagna dokument (0)</h3><p class="muted">Inga dokument mottagna ännu.</p></div>`
    : `<div class="card">
        <h3>Mottagna dokument (${contracts.length}) · ${avtalCount} avtal</h3>
        <table class="contracts-table">
          <thead><tr><th>Datum</th><th>Ärende</th><th>Roll</th><th>Typ</th><th>Filnamn</th><th>Storlek</th><th></th></tr></thead>
          <tbody>${contracts.map((c) => {
            const badge = docTypeBadge(c);
            const badgeHtml = badge
              ? `<span class="doc-badge ${badge.muted ? 'doc-badge-muted' : 'doc-badge-avtal'}">${escapeHtml(badge.label)}</span>`
              : '<span class="muted">—</span>';
            return `
            <tr class="${badge && badge.muted ? 'doc-row-muted' : ''}">
              <td>${escapeHtml(c.received_at?.slice(0, 10) ?? '')}</td>
              <td><a href="#case-${c.conv_id}">#${c.conv_id}</a></td>
              <td>${escapeHtml(c.role)}</td>
              <td>${badgeHtml}</td>
              <td><a href="/attachments/${c.id}" target="_blank" rel="noopener">📎 ${escapeHtml(c.filename)}</a>${isPdfAttachment(c) ? '' : ' <span class="muted">— sparad, ej avtalsanalyserad (ej PDF)</span>'}</td>
              <td>${escapeHtml(fmtBytes(c.size_bytes))}</td>
              <td><a class="doc-open" href="/attachments/${c.id}" target="_blank" rel="noopener" title="Öppna i ny flik" aria-label="Öppna ${escapeHtml(c.filename)} i ny flik">${EXTLINK_ICON}</a></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
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

        // Gmail-style thread grouped by thread_id — identical rendering to the
        // Ärenden tab (renderCaseDetailPane), so a conversation looks the same
        // wherever it's viewed.
        const convThreads = threadsByConv[conv.id] ?? [];
        // Group escalations under their thread (by triggering message, else by
        // recipient↔counterparty match — see groupEscalationsByThread).
        const escByThread = groupEscalationsByThread(escs, convThreads);
        const thread = convThreads.length
          ? renderThreadGroups(convThreads, msgs, attachmentsByMsg, signatures, escByThread, gmailReady)
          : (msgs.length
              ? msgs.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], i === msgs.length - 1)).join('')
              : '<p class="muted">Inga meddelanden ännu.</p>');

        // Only show separate escalation cards for escalations not tied to a thread
        // (ungrouped). Thread-tied ones are rendered inside renderThreadGroups.
        const ungroupedEscs = convThreads.length
          ? (escByThread.get(null) ?? [])
          : escs;
        const escHtml = ungroupedEscs.length === 0 ? '' : `
          <h4 style="margin:18px 0 6px;font-size:13px">⚠️ Öppna eskaleringar (${ungroupedEscs.length})</h4>
          ${ungroupedEscs.map((e) => `
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
            <h4 style="margin:14px 0 8px;font-size:13px">Konversation</h4>
            <div class="thread-msgs">${thread}</div>
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

// Gmail-style inbox rows: leading status dot, bold sender, subject + grey
// snippet, date on the right. Grouped under the status buckets.
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
        const date = b.key === 'oppna'
          ? (fmtFollowUpBadge(c.follow_up_at, c.follow_up_source) ?? `<span class="muted">${escapeHtml(fmtAgo(c.since))}</span>`)
          : `<span class="muted">${escapeHtml(fmtAgo(c.since))}</span>`;
        const unread = b.key === 'behover_dig' ? ' unread' : '';
        return `<a class="mail-row${unread}${c.conv_id === selectedId ? ' active' : ''}" data-pane-link href="/arenden/${c.conv_id}">
          <span class="mail-dot ${dot}"></span>
          <span class="mail-sender">${escapeHtml(c.kommun_namn)} <span class="muted">· ${escapeHtml(c.role)}</span></span>
          <span class="mail-line"><span class="mail-subject">${escapeHtml(c.subject ?? '')}</span>${c.snippet ? ` <span class="mail-snippet">— ${escapeHtml(c.snippet)}</span>` : ''}</span>
          <span class="mail-date">${date}</span>
        </a>`;
      }).join('')}
    </div>`;
  }).join('');
}

// Split a raw From/To header ("Display Name <a@b.se>" or "a@b.se") into parts.
function parseAddr(raw) {
  if (!raw) return { name: '', email: '' };
  const m = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: '', email: String(raw).trim() };
}

// One Gmail-style message block. Latest message is expanded; older ones are
// collapsed to a header (sender · snippet · date) you click to open.
function threadMessage(m, attachments, sig, expanded) {
  const isOut = m.direction === 'outbound';
  const from = parseAddr(m.from_email);
  const to = parseAddr(m.to_email);
  const name = isOut ? 'Du' : (from.name || from.email || 'Avsändare');
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const date = m.received_at
    ? `${m.received_at.slice(0, 10)} ${m.received_at.slice(11, 16)} · ${fmtAgo(m.received_at)}`
    : '';
  const addr = isOut
    ? `till ${to.email || m.to_email || ''}`
    : (from.email ? `<${from.email}>` : '');
  const snippet = (m.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const atts = (attachments ?? [])
    .map((a) => {
      const link = `<a class="msg-att" href="/attachments/${a.id}" target="_blank" rel="noopener">📎 ${escapeHtml(a.filename)}</a>`;
      // Stored non-PDFs (.xlsx/.docx/scans…) never reach the contract
      // analyser — say so, so a delivered document is never invisibly "just
      // a file" the operator assumes was analysed.
      return isPdfAttachment(a) ? link : `${link} <span class="muted">— sparad, ej avtalsanalyserad (ej PDF)</span>`;
    })
    .join('');
  // The mail carried more attachments than we stored → the ingest skipped
  // tiny images (signature logos). Surface the gap instead of hiding it.
  const skipped = m.direction === 'inbound'
    ? (m.attachment_count ?? 0) - (attachments?.length ?? 0)
    : 0;
  const skippedNote = skipped > 0
    ? `<div class="muted" style="font-size:11px;margin-top:4px">${skipped} ${skipped === 1 ? 'bilaga' : 'bilagor'} hoppades över (liten bild)</div>`
    : '';
  return `<div class="msg msg-${m.direction}">
    <div class="msg-head" data-collapse aria-expanded="${expanded ? 'true' : 'false'}">
      <span class="avatar avatar-${m.direction}">${escapeHtml(initial)}</span>
      <div class="msg-who">
        <span class="msg-from">${escapeHtml(name)} <span class="msg-addr muted">${escapeHtml(addr)}</span></span>
        ${expanded ? '' : `<span class="msg-snippet muted">${escapeHtml(snippet)}</span>`}
      </div>
      <span class="msg-date muted">${escapeHtml(date)}</span>
    </div>
    <div class="msg-body" data-collapse-target${expanded ? '' : ' hidden'}>
      <div class="msg-text">${escapeHtml(m.body_text ?? '')}</div>
      ${atts ? `<div class="msg-atts">${atts}</div>` : ''}
      ${skippedNote}
    </div>
  </div>`;
}

// PDFs (and zip-expanded inner PDFs, saved as PDFs) are the only attachments
// the contract analyser consumes — mirrors listPendingContractAttachments.
function isPdfAttachment(a) {
  return a.mime_type === 'application/pdf' || (a.filename ?? '').toLowerCase().endsWith('.pdf');
}

// A status chip + manual toggle for one thread.
function threadStatusControls(t) {
  const label = { primary: '★ primary', muted: 'muted', neutral: 'neutral' }[t.status] ?? t.status;
  const next = t.status === 'muted' ? 'primary' : 'muted';
  const nextLabel = next === 'muted' ? 'mute' : 'make primary';
  return `<span class="thread-status thread-status-${escapeHtml(t.status)}">${escapeHtml(label)}</span>
    <form method="post" action="/threads/${t.id}/status" style="display:inline" data-pane-form>
      <input type="hidden" name="status" value="${escapeHtml(next)}">
      <button type="submit" class="btn-link">${escapeHtml(nextLabel)}</button>
    </form>`;
}

// Associate each open escalation with a thread: by its triggering message's
// thread_id when known, else by matching its resolved recipient against a
// thread's counterparty email (handles legacy escalations with no message_id).
// Escalations matching no thread land under the null key (rendered separately).
function groupEscalationsByThread(escalations, threads) {
  const emailOf = (s) => parseAddr(s || '').email.toLowerCase();
  const byCounterparty = new Map();
  for (const t of threads) {
    const em = emailOf(t.counterparty_email);
    if (em && !byCounterparty.has(em)) byCounterparty.set(em, t.id);
  }
  const map = new Map();
  for (const e of escalations) {
    let tid = e.thread_id ?? null;
    if (tid == null) {
      const match = byCounterparty.get(emailOf(e.recipient));
      if (match != null) tid = match;
    }
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid).push(e);
  }
  return map;
}

// A compact preview line for a collapsed thread row: latest message's snippet,
// its date, and the message count — so the row is informative without opening.
function threadPreview(msgs) {
  const latest = msgs[msgs.length - 1];
  if (!latest) return { snippet: 'Inga meddelanden', date: '', count: 0 };
  const who = latest.direction === 'outbound' ? 'Du: ' : '';
  const snippet = who + (latest.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const date = latest.received_at ? `${latest.received_at.slice(0, 10)} · ${fmtAgo(latest.received_at)}` : '';
  return { snippet, date, count: msgs.length };
}

// Render each thread as a collapsed accordion row (clickable header + hidden
// body), newest thread first (threads arrive ordered by last_inbound_at DESC).
// Clicking a row reveals the full conversation + reply boxes. The header uses a
// dedicated data-thread-toggle/data-thread-body pair so it never clashes with
// the per-message data-collapse toggles inside the body. Messages with no
// thread_id (pre-backfill) render in an always-visible "Ogrupperat" section.
function renderThreadGroups(threads, messages, attachmentsByMsg, signatures, escalationsByThread, gmailReady) {
  const byThread = new Map();
  for (const m of messages) {
    const key = m.thread_id ?? 'none';
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key).push(m);
  }
  const groups = threads.map((t) => {
    const msgs = byThread.get(t.id) ?? [];
    const parsed = parseAddr(t.counterparty_name || t.counterparty_email || '');
    const displayName = parsed.name || parsed.email || t.counterparty_email || 'Okänd';
    const displayEmail = t.counterparty_email || '';
    const pv = threadPreview(msgs);
    const header = `<div class="thread-head" data-thread-toggle aria-expanded="false">
      <div class="thread-head-main">
        <div class="thread-head-top">
          <strong>${escapeHtml(displayName)}</strong>
          <span class="muted thread-email">${escapeHtml(displayEmail)}</span>
          ${threadStatusControls(t)}
        </div>
        <div class="thread-preview muted">${escapeHtml(pv.snippet)}</div>
      </div>
      <div class="thread-head-meta muted">
        <span>${escapeHtml(pv.date)}</span>
        <span class="thread-count">${pv.count} meddelanden</span>
      </div>
    </div>`;
    const msgHtml = msgs.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], i === msgs.length - 1)).join('');
    // Open escalations are pending actions — always render their reply forms,
    // even on a muted thread. Muting suppresses NEW suggestions at ingest; it
    // must never hide an escalation that was already opened (e.g. before the
    // operator muted the thread), or the action silently disappears.
    const threadEscs = escalationsByThread.get(t.id) ?? [];
    const replies = threadEscs.map((e) => renderEscalationForm(e, gmailReady)).join('');
    // A thread with a pending escalation needs the operator — flag it light red.
    const needsAction = threadEscs.length > 0 ? ' thread-needs-action' : '';
    return `<section class="thread-group thread-${escapeHtml(t.status)}${needsAction}">${header}<div class="thread-body" data-thread-body hidden>${msgHtml}${replies}</div></section>`;
  });
  // Orphan messages (thread_id null — only before backfill) must never vanish.
  const orphans = byThread.get('none') ?? [];
  if (orphans.length) {
    const body = orphans.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], i === orphans.length - 1)).join('');
    groups.push(`<section class="thread-group"><div class="thread-head"><span class="muted">Ogrupperat</span></div>${body}</section>`);
  }
  return groups.join('');
}

function renderCaseDetailPane(selected, gmailReady) {
  if (!selected) return '<div class="detail-empty"><p class="muted">Välj ett ärende i listan till vänster.</p></div>';
  const { conv, messages, attachmentsByMsg, signatures, escalations, threads = [], follow_up } = selected;
  const returnTo = `/arenden/${conv.id}`;
  const duration = caseDuration(conv, messages);
  const fuBadge = fmtFollowUpBadge(follow_up?.date, follow_up?.source);
  const reviewBadge = fmtNextReviewBadge(conv);
  const subject = messages.find((m) => m.subject)?.subject ?? `Begäran — ${conv.kommun_namn}`;

  // Group escalations under their thread (by triggering message, else by
  // recipient↔counterparty match — see groupEscalationsByThread).
  const escalationsByThread = groupEscalationsByThread(escalations, threads);

  const thread = threads.length
    ? renderThreadGroups(threads, messages, attachmentsByMsg, signatures, escalationsByThread, gmailReady)
    : (messages.length
        ? messages.map((m, i) => threadMessage(m, attachmentsByMsg[m.id], signatures[m.id], i === messages.length - 1)).join('')
        : '<p class="muted">Inga meddelanden ännu.</p>');

  // Suggested reply (Gmail-style reply box) for escalations not tied to any thread.
  const ungroupedEscalations = escalationsByThread.get(null) ?? (threads.length === 0 ? escalations : []);
  const replyBoxes = ungroupedEscalations.map((e) => `
    <div class="reply-box">
      <div class="reply-head">
        <span class="avatar avatar-outbound">↩</span>
        <span class="muted">Föreslaget svar till <strong>${escapeHtml(conv.contact_email ?? '')}</strong></span>
        ${intentBadge(e.classifier_class ?? 'unknown')}
      </div>
      ${renderEscalationForm(e, gmailReady, returnTo)}
    </div>`).join('');

  return `<div class="thread">
    <div class="thread-head">
      <div class="thread-title-row">
        <h2 class="thread-subject">${escapeHtml(subject)}</h2>
        ${caseStatusBadge(conv.state)}
      </div>
      <div class="thread-meta muted">
        <strong>${escapeHtml(conv.kommun_namn)} · ${escapeHtml(conv.role)}</strong>
        · ${escapeHtml(conv.contact_email ?? '')}
        ${conv.arendenummer ? `· Ärendenr ${escapeHtml(conv.arendenummer)}` : ''}
        ${duration ? `· ${escapeHtml(duration)}` : ''}
        ${fuBadge ? `· Återkommer ${fuBadge}` : ''}
        ${reviewBadge ? `· ${reviewBadge}` : ''}
        · <a href="/kommun/${escapeHtml(conv.kommun_kod)}" data-pane-link>Kommunprofil →</a>
      </div>
    </div>
    <div class="thread-msgs">${thread}</div>
    ${replyBoxes}
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

// ---- Activity feed ----
// (Escalations are handled inside Ärenden — the old /escalations page redirects there.)

export function renderActivity({ events, heartbeat = null, partial = false, escalationCount = 0 }) {
  const body = events.length === 0
    ? '<div class="empty-state">Ingen aktivitet ännu.</div>'
    : `<table>
        <thead><tr><th>Tid</th><th>Kommun</th><th>Roll</th><th>Händelse</th><th>Detalj</th></tr></thead>
        <tbody>
          ${events.map((e) => `<tr>
            <td><span title="${escapeHtml(e.timestamp)}">${escapeHtml(fmtAgo(e.timestamp))}</span></td>
            <td><a href="/kommun/${escapeHtml(e.kommun_kod)}" data-pane-link>${escapeHtml(e.kommun_namn)}</a></td>
            <td>${escapeHtml(e.role)}</td>
            <td>${escapeHtml(e.event)}</td>
            <td class="muted">${escapeHtml(e.detail ?? '')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  return layout({ title: 'Aktivitet', body: `<div class="page-head"><h1>Aktivitet</h1><span class="muted">senaste ${events.length}</span></div>${body}`, currentPath: '/activity', heartbeat, partial, escalationCount });
}

function activeBadge(periodEnd) {
  if (!periodEnd) return '<span class="muted">okänd avtalstid</span>';
  const active = periodEnd >= new Date().toISOString().slice(0, 10);
  return active
    ? `<span class="pill pill-promise">aktivt t.o.m. ${escapeHtml(periodEnd)}</span>`
    : `<span class="pill pill-overdue">utgånget ${escapeHtml(periodEnd)}</span>`;
}

// Product chips, capped so a prolific vendor doesn't flood the list pane.
function chipRow(products, cap = 10) {
  const list = products ?? [];
  const shown = list.slice(0, cap);
  const extra = list.length - shown.length;
  return `<div class="chip-row">${shown.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}${
    extra > 0 ? `<span class="tag tag-more">+${extra} till</span>` : ''}</div>`;
}

// ---- Vendor data center (2026-07-09-vendor-data-center-design.md Part 3) ----

// SEK formatting. Aggregates use the compact form ("6,1 mkr/år"); table cells
// use the full sv-SE integer ("612 500 kr/år"). Unknown is ALWAYS the word
// "okänt" — never 0, never a dash that could read as zero.
function fmtSekFull(n) {
  return `${Number(n).toLocaleString('sv-SE')} kr`;
}

function fmtSekCompact(n) {
  if (n >= 1000000) {
    return `${(n / 1000000).toLocaleString('sv-SE', { maximumFractionDigits: 1 })} mkr`;
  }
  if (n >= 10000) return `${Math.round(n / 1000).toLocaleString('sv-SE')} tkr`;
  return fmtSekFull(n);
}

function annualValueCell(f) {
  if (f.annual_value_sek == null) {
    const title = f.avtalsvarde ? ` title="Ur avtalet: ${escapeHtml(f.avtalsvarde)}"` : '';
    return `<span class="muted"${title}>okänt</span>`;
  }
  const title = f.avtalsvarde ? ` title="Ur avtalet: ${escapeHtml(f.avtalsvarde)}"` : '';
  return `<span${title}>${escapeHtml(fmtSekFull(f.annual_value_sek))}/år</span>`;
}

function pricingModelBadge(model) {
  if (!model) return '<span class="muted">okänt</span>';
  const label = PRICING_MODEL_LABELS[model] ?? model;
  return `<span class="tag">${escapeHtml(label)}</span>`;
}

// The one-line honesty statement that must accompany every aggregate.
function completenessLine(known, total, what = 'årlig kostnad') {
  return `<span class="muted">${escapeHtml(what)} känd för ${known} av ${total} avtal</span>`;
}

function renewalCell(f, todayIso) {
  if (!f.next_review_date) return '<span class="muted">okänt</span>';
  const w = renewalWindow(f, todayIso);
  const klass = w === 'passerat' ? 'pill pill-overdue' : w === 'inom 3 mån' ? 'pill pill-default' : 'pill pill-promise';
  return `${escapeHtml(f.next_review_date)} <span class="${klass}">${escapeHtml(w)}</span>`;
}

function lengthCell(months) {
  return months == null ? '<span class="muted">okänt</span>' : `${months} mån`;
}

// One explorer table row. The client (public/explorer.js) re-renders rows
// with the same columns after filtering/grouping — keep the two in sync.
function explorerRow(f, todayIso) {
  const vendor = f.vendor_slug
    ? `<a href="/leverantor/${escapeHtml(f.vendor_slug)}" data-pane-link>${escapeHtml(f.vendor_name)}</a>`
    : '<span class="muted">okänd</span>';
  return `<tr>
    <td>${vendor}</td>
    <td><a href="/kommun/${escapeHtml(f.kommun_kod)}" data-pane-link>${escapeHtml(f.kommun_namn)}</a></td>
    <td>${escapeHtml(f.lan ?? '') || '<span class="muted">—</span>'}</td>
    <td>${(f.products ?? []).length ? escapeHtml(f.products.join(', ')) : '<span class="muted">—</span>'}</td>
    <td class="num">${annualValueCell(f)}</td>
    <td>${pricingModelBadge(f.pricing_model)}</td>
    <td class="num">${lengthCell(f.contract_length_months)}</td>
    <td>${renewalCell(f, todayIso)}</td>
    <td>${f.attachment_id ? `<a href="/attachments/${f.attachment_id}" target="_blank" rel="noopener" title="${escapeHtml(f.filename ?? '')}">📎 PDF</a>` : ''}</td>
  </tr>`;
}

// Aggregate line above the explorer table — mirrored by the client.
function explorerSummaryLine(facts) {
  const a = aggregateFacts(facts);
  const sum = a.total_annual_sek == null
    ? 'summa okänd'
    : `summa ${fmtSekCompact(a.total_annual_sek)}/år (känd för ${a.value_known} av ${a.count} avtal)`;
  return `${a.count} avtal · ${sum} · ${a.kommun_count} kommuner · ${a.vendor_count} leverantörer`;
}

const VALUE_BAND_OPTIONS = ['0 kr', '< 100 tkr', '100–500 tkr', '0,5–1 mkr', '> 1 mkr', UNKNOWN];
const LENGTH_BAND_OPTIONS = ['≤ 1 år', '1–2 år', '2–4 år', '> 4 år', UNKNOWN];
const RENEWAL_WINDOW_OPTIONS = ['passerat', 'inom 3 mån', 'inom 12 mån', 'senare', UNKNOWN];

const GROUP_DIMENSIONS = [
  ['', '— ingen gruppering —'],
  ['vendor', 'Leverantör'],
  ['lan', 'Län'],
  ['kommun', 'Kommun'],
  ['pricing_model', 'Prismodell'],
  ['value_band', 'Årskostnad'],
  ['length_band', 'Avtalslängd'],
  ['renewal_window', 'Förnyelsefönster'],
  ['product', 'Produkt'],
];

function selectControl({ name, label, options, labelFor = (v) => v }) {
  const opts = options.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(labelFor(v))}</option>`).join('');
  return `<label class="x-control">${escapeHtml(label)}
    <select data-x-filter="${escapeHtml(name)}"><option value="">alla</option>${opts}</select>
  </label>`;
}

// The slice & dice explorer shell. The dataset rides along as a JSON blob;
// `</` is escaped so a hostile product/vendor string can never break out of
// the <script> element. Without JS the initial server-rendered rows (the
// full dataset) remain a plain readable table.
function renderExplorer(facts, todayIso) {
  const json = JSON.stringify(facts).replace(/</g, '\\u003c');
  const opts = deriveOptions(facts);
  return `
  <section class="board-section" data-explorer data-today="${escapeHtml(todayIso)}">
    <h2>Utforska avtalen <span class="count">${facts.length}</span></h2>
    <script type="application/json" data-contract-facts>${json}</script>
    <div class="explorer-controls">
      <input type="search" data-x-filter="q" placeholder="Sök leverantör, kommun, produkt…" autocomplete="off">
      ${selectControl({ name: 'lan', label: 'Län', options: opts.lan })}
      ${selectControl({ name: 'vendor', label: 'Leverantör', options: opts.vendor })}
      ${selectControl({ name: 'pricing_model', label: 'Prismodell', options: opts.pricing_model, labelFor: (v) => PRICING_MODEL_LABELS[v] ?? v })}
      ${selectControl({ name: 'value_band', label: 'Årskostnad', options: VALUE_BAND_OPTIONS })}
      ${selectControl({ name: 'length_band', label: 'Avtalslängd', options: LENGTH_BAND_OPTIONS })}
      ${selectControl({ name: 'renewal_window', label: 'Förnyelse', options: RENEWAL_WINDOW_OPTIONS })}
      ${selectControl({ name: 'product', label: 'Produkt', options: opts.product })}
      <label class="x-control x-control-group">Gruppera efter
        <select data-x-group>${GROUP_DIMENSIONS.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}</select>
      </label>
      <button type="button" class="btn btn-secondary" data-x-reset>Återställ</button>
    </div>
    <div class="explorer-summary" data-x-summary>${escapeHtml(explorerSummaryLine(facts))}</div>
    <table class="explorer-table">
      <thead><tr>
        <th>Leverantör</th><th>Kommun</th><th>Län</th><th>Produkter</th>
        <th style="text-align:right">Årlig kostnad</th><th>Prismodell</th>
        <th style="text-align:right">Längd</th><th>Nästa förnyelse</th><th>Källa</th>
      </tr></thead>
      <tbody data-x-body>${facts.map((f) => explorerRow(f, todayIso)).join('')}</tbody>
    </table>
  </section>`;
}

// ---- Surface 1: market overview (/leverantorer) ----

const VENDOR_COLUMN_DEFAULT_ORDER = {
  vendor_name: 'asc',
  kommun_count: 'desc',
  contract_count: 'desc',
  total_annual_sek: 'desc',
  dominant_pricing_model: 'asc',
  next_renewal_date: 'asc',
};

function vendorSortHeader({ key, label, currentSort, currentOrder, align = 'left' }) {
  const isActive = currentSort === key;
  const nextOrder = isActive
    ? (currentOrder === 'desc' ? 'asc' : 'desc')
    : (VENDOR_COLUMN_DEFAULT_ORDER[key] ?? 'asc');
  const indicator = isActive ? (currentOrder === 'desc' ? ' ▼' : ' ▲') : '';
  const style = align === 'right' ? ' style="text-align:right"' : '';
  return `<th${style}><a href="?sort=${key}&order=${nextOrder}" data-pane-link class="th-sort${isActive ? ' th-sort-active' : ''}">${escapeHtml(label)}${indicator}</a></th>`;
}

function marketRollupRow(r, todayIso) {
  const total = r.total_annual_sek == null
    ? '<span class="muted">okänt</span>'
    : `${escapeHtml(fmtSekFull(r.total_annual_sek))}/år`;
  const share = r.value_known_count < r.contract_count
    ? ` <span class="muted">(${r.value_known_count} av ${r.contract_count} kända)</span>`
    : '';
  const mixTitle = Object.entries(r.pricing_model_mix)
    .map(([m, n]) => `${PRICING_MODEL_LABELS[m] ?? m}: ${n}`).join(', ');
  const renewal = r.next_renewal_date
    ? renewalCell({ next_review_date: r.next_renewal_date }, todayIso)
    : '<span class="muted">okänt</span>';
  return `<tr>
    <td><a class="kommun-link" href="/leverantor/${escapeHtml(r.vendor_slug)}" data-pane-link>${escapeHtml(r.vendor_name)}</a></td>
    <td class="num">${r.kommun_count}</td>
    <td class="num">${r.contract_count}</td>
    <td class="num">${total}${share}</td>
    <td><span title="${escapeHtml(mixTitle)}">${pricingModelBadge(r.dominant_pricing_model)}</span></td>
    <td>${chipRow(r.products, 4)}</td>
    <td>${renewal}</td>
  </tr>`;
}

export function renderVendorMarket({ summary, rollups = [], facts = [], sort = null, order = null, todayIso, heartbeat = null, partial = false, escalationCount = 0 }) {
  const totalCard = summary.total_annual_sek == null
    ? '<div class="value">okänt</div>'
    : `<div class="value good">${escapeHtml(fmtSekCompact(summary.total_annual_sek))}/år</div>`;
  const stats = `
    <div class="stats stats-band">
      <div class="stat-card"><div class="label">Leverantörer</div><div class="value">${summary.vendor_count}</div></div>
      <div class="stat-card"><div class="label">Kommuner med avtal</div><div class="value">${summary.kommun_count}</div></div>
      <div class="stat-card"><div class="label">Avtal</div><div class="value">${summary.contract_count}</div></div>
      <div class="stat-card"><div class="label">Känd årskostnad</div>${totalCard}
        <div class="stat-sub">${completenessLine(summary.value_completeness.known, summary.value_completeness.total)}</div></div>
      <div class="stat-card"><div class="label">Förnyelser inom 12 mån</div><div class="value${summary.renewals_within_12mo > 0 ? ' warn' : ''}">${summary.renewals_within_12mo}</div></div>
    </div>`;

  const headerArgs = { currentSort: sort, currentOrder: order };
  const table = rollups.length === 0
    ? '<div class="empty-state">Inga leverantörer ännu — avtal analyseras när kommuner levererar.</div>'
    : `<table>
        <thead><tr>
          ${vendorSortHeader({ ...headerArgs, key: 'vendor_name', label: 'Leverantör' })}
          ${vendorSortHeader({ ...headerArgs, key: 'kommun_count', label: 'Kommuner', align: 'right' })}
          ${vendorSortHeader({ ...headerArgs, key: 'contract_count', label: 'Avtal', align: 'right' })}
          ${vendorSortHeader({ ...headerArgs, key: 'total_annual_sek', label: 'Känd årskostnad', align: 'right' })}
          ${vendorSortHeader({ ...headerArgs, key: 'dominant_pricing_model', label: 'Prismodell' })}
          <th>Produkter</th>
          ${vendorSortHeader({ ...headerArgs, key: 'next_renewal_date', label: 'Nästa förnyelse' })}
        </tr></thead>
        <tbody>${rollups.map((r) => marketRollupRow(r, todayIso)).join('')}</tbody>
      </table>`;

  const body = `
    <div class="page-head"><h1>Leverantörer</h1><span class="muted">marknadsöversikt · ${facts.length} avtal</span></div>
    ${stats}
    <p class="muted honesty-note">Summor bygger enbart på avtal med känd årskostnad — okända värden visas som ”okänt” och hittas i utforskaren nedan.</p>
    <section class="board-section">
      <h2>Marknadsöversikt <span class="count">${rollups.length}</span></h2>
      ${table}
    </section>
    ${renderExplorer(facts, todayIso)}
  `;
  return layout({ title: 'Leverantörer', body, currentPath: '/leverantorer', heartbeat, partial, escalationCount });
}

// ---- Ramavtal page (/ramavtal/:slug) — a framework agreement as a first-class
// entity (2026-07-19 design). `kommuner` = kommuner procuring via this channel
// (derived from the kommun-level reseller_channels), each { kommun_kod,
// kommun_namn }; `vendors` = distinct vendors reached through it (from extracted
// reseller_relations), each { name, slug|null } (slug present → link to its
// vendor page, else shown but not linked — no dead links). Pure: all data via
// params. ----
export function renderRamavtal({ reseller, kommuner = [], vendors = [], heartbeat = null, partial = false, escalationCount = 0 }) {
  if (!reseller) {
    return layout({ title: 'Saknat ramavtal', body: '<p>Hittade inte ramavtalet.</p>', currentPath: '/leverantorer', heartbeat, partial, escalationCount });
  }

  const kommunerSection = kommuner.length === 0
    ? '<div class="empty-state">Inga kända kommuner som upphandlar via detta ramavtal än.</div>'
    : `<div class="tag-list">${kommuner.map((k) =>
        `<a class="tag" href="/kommun/${escapeHtml(k.kommun_kod)}">${escapeHtml(k.kommun_namn)}</a>`).join('')}</div>`;

  const vendorsSection = vendors.length === 0
    ? '<div class="empty-state">Inga kända leverantörer via detta ramavtal än.</div>'
    : `<div class="vendor-list">${vendors.map((v) => {
        const nameHtml = v.slug
          ? `<a href="/leverantor/${escapeHtml(v.slug)}">${escapeHtml(v.name)}</a>`
          : `<span class="muted" title="${escapeHtml('ingen leverantörssida än')}">${escapeHtml(v.name)}</span>`;
        return `<div class="vendor-row">${VENDOR_ICON}<span class="vendor-name">${nameHtml}</span></div>`;
      }).join('')}</div>`;

  const body = `
    <div class="page-head">
      <h1><span class="ramavtal-head-icon">${FRAME_ICON}</span> ${escapeHtml(reseller.canonical)}</h1>
      <span class="muted">ramavtal / återförsäljare</span>
    </div>
    <p class="muted honesty-note">En kommun som köper via detta ramavtal kan ha produkter den vägen utan att vi sett ett direktavtal. En leverantör listas här endast när en kommun uttryckligen angett att den nås genom ${escapeHtml(reseller.canonical)}.</p>
    <section class="board-section">
      <h2>Kommuner som upphandlar via ${escapeHtml(reseller.canonical)} <span class="count">${kommuner.length}</span></h2>
      ${kommunerSection}
    </section>
    <section class="board-section">
      <h2>Leverantörer som nås via ${escapeHtml(reseller.canonical)} <span class="count">${vendors.length}</span></h2>
      ${vendorsSection}
    </section>
  `;
  return layout({ title: `Ramavtal · ${reseller.canonical}`, body, currentPath: '/leverantorer', heartbeat, partial, escalationCount });
}

// ---- Surface 2: vendor dossier (/leverantor/:slug) ----

// ---- Product intelligence (2026-07-10 design): product table + matrix ----

const GRADE_SHORT_LABELS = { Förskoleklass: 'F-klass', Introduktionsprogrammet: 'IM' };

// Pris cell: per-product summed line items — a per-kommun value or a range.
// A product only ever seen inside a lump sum is honestly "ingår,
// ospecificerat pris"; partial knowledge gets a completeness note.
function productPriceCell(p) {
  if (!p.priceRange) return '<span class="muted">ingår, ospecificerat pris</span>';
  const known = p.priceByKommun.filter((k) => k.amount_sek != null).length;
  const value = p.priceRange.min === p.priceRange.max
    ? fmtSekFull(p.priceRange.min)
    : `${fmtSekFull(p.priceRange.min)} – ${fmtSekFull(p.priceRange.max)}`;
  const per = p.kommunCount > 1 ? ' per kommun' : '';
  const note = known < p.kommunCount
    ? ` <span class="muted">(känd för ${known} av ${p.kommunCount} kommuner)</span>` : '';
  const title = p.priceByKommun
    .map((k) => `${k.kommun_namn}: ${k.amount_sek != null ? fmtSekFull(k.amount_sek) : 'ospecificerat'}`)
    .join(' · ');
  return `<span title="${escapeHtml(title)}">${escapeHtml(value + per)}</span>${note}`;
}

function productTable(productRollups) {
  const rows = productRollups.map((p) => `<tr>
    <td>${escapeHtml(p.name)}</td>
    <td class="num"><span title="${escapeHtml(p.kommuns.join(', '))}">${p.kommunCount}</span></td>
    <td class="num">${productPriceCell(p)}</td>
    <td>${pricingModelBadge(p.dominantPricingModel)}</td>
  </tr>`).join('');
  return `
    <section class="board-section">
      <h2>Produkter <span class="count">${productRollups.length}</span></h2>
      <table class="product-table">
        <thead><tr>
          <th>Produkt</th><th style="text-align:right">Kommuner</th>
          <th style="text-align:right">Pris</th><th>Prismodell</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted honesty-note">Pris = summan av avtalets egna prisspecifikationsrader per produkt — aldrig en påhittad fördelning av en klumpsumma.</p>
    </section>`;
}

// 🛒 badge for a kommun that procures via framework agreements / resellers
// (src/resellers.js). A muted pill, never an alarm: it explains why the
// kommun's missing products render "?" (kan finnas via ramavtal) instead of
// a confident red. Empty channels → no badge at all.
function resellerBadge(channels) {
  if (!channels || channels.length === 0) return '';
  const list = channels.join(', ');
  return ` <span class="pill pill-reseller" title="${escapeHtml(`Kommunen köper via ramavtal/återförsäljare (${list}) — produkter kan finnas den vägen utan direktavtal med leverantören`)}">🛒 via ramavtal: ${escapeHtml(list)}</span>`;
}

// One coverage-matrix cell. Green/yellow cells expand (server-rendered
// <details>, no JS needed) to the per-kommun detail; red/grey/neutral cells
// carry their meaning in a tooltip. Red is a CONFIDENT negative (some
// collection-complete, non-reseller kommun lacks the level); "?" means the
// only kommuner lacking it are still mid-collection — or procure via a
// framework/reseller channel (`anyReseller` widens the tooltip) — we don't
// know yet.
function coverageCell(p, grade, anyReseller = false) {
  const colour = p.coverageByGrade[grade];
  if (colour === 'na') {
    return `<td class="cov-cell cov-na" title="${escapeHtml(`${grade}: förekommer inte i leverantörens avtal`)}">–</td>`;
  }
  if (colour === 'unknown') {
    const why = anyReseller
      ? `insamling pågår eller köp via ramavtal i kommunerna utan ${p.name} här — vet inte än`
      : `insamling pågår i kommunerna utan ${p.name} här — vet inte än`;
    return `<td class="cov-cell cov-unknown" title="${escapeHtml(`${grade}: ${why}`)}">?</td>`;
  }
  if (colour === 'red') {
    return `<td class="cov-cell cov-none" title="${escapeHtml(`${grade}: leverantören säljs på nivån i andra sammanhang, men ${p.name} når ingen kommun här`)}">✕</td>`;
  }
  const covered = p.coverageDetail[grade] ?? [];
  const coveredNames = new Set(covered.map((d) => d.kommun_namn));
  const lines = [
    ...covered.map((d) => `${d.kommun_namn}: ${d.status === 'full' ? 'full täckning' : 'delvis'}${d.student_count != null ? ` (${fmtInt(d.student_count)} elever/barn)` : ''}`),
    ...p.kommuns.filter((n) => !coveredNames.has(n)).map((n) => `${n}: ingen täckning extraherad`),
  ];
  const mark = colour === 'green' ? '●' : '◐';
  const klass = colour === 'green' ? 'cov-full' : 'cov-partial';
  return `<td class="cov-cell ${klass}"><details class="cov-detail"><summary title="${escapeHtml(grade)}">${mark}</summary><div class="cov-pop">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}</div></details></td>`;
}

function coverageMatrix(productRollups, vendorSlug, anyReseller = false) {
  if (!productRollups.some((p) => p.coverageKnown)) {
    return `
    <section class="board-section">
      <h2>Täckning per skolnivå</h2>
      <p class="muted">Ingen täckningsdata extraherad ännu — avtalens enhetslistor fylls på vid (om)analys.</p>
    </section>`;
  }
  const head = GRADE_LEVELS
    .map((g) => `<th class="cov-head" title="${escapeHtml(g)}">${escapeHtml(GRADE_SHORT_LABELS[g] ?? g)}</th>`)
    .join('');
  // Product name → the per-kommun drill-down (same matrix, rows = kommuner).
  const productCell = (p) => (vendorSlug
    ? `<a href="/leverantor/${escapeHtml(vendorSlug)}/produkt/${escapeHtml(slugifyProductName(p.name))}" data-pane-link title="${escapeHtml(`${p.name}: täckning per kommun`)}">${escapeHtml(p.name)}</a>`
    : escapeHtml(p.name));
  const rows = productRollups.map((p) =>
    `<tr><td>${productCell(p)}</td>${GRADE_LEVELS.map((g) => coverageCell(p, g, anyReseller)).join('')}</tr>`).join('');
  const resellerLegend = anyReseller
    ? ' · 🛒 via ramavtal — kommunen köper via ramavtal/återförsäljare, så produkten kan finnas via ramavtal utan direktavtal (ett ? i stället för ✕).'
    : '';
  return `
    <section class="board-section">
      <h2>Täckning per skolnivå</h2>
      <table class="cov-table">
        <thead><tr><th>Produkt</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted honesty-note">● full i alla köpande kommuner · ◐ delvis eller blandat · ✕ nivån säljs av leverantören men inte här · ? · insamling pågår (vet inte än) · – nivån förekommer inte i leverantörens avtal${resellerLegend}. Klicka på en cell för detalj per kommun, eller på produktnamnet för täckning per kommun.</p>
    </section>`;
}

function dossierLifecycleCell(f) {
  const bits = [];
  if (f.auto_renews) {
    bits.push('<span class="pill pill-default" title="Förlängs automatiskt om det inte sägs upp">förlängs automatiskt</span>');
  }
  if (f.period_end) bits.push(activeBadge(f.period_end));
  return bits.length ? bits.join(' ') : '<span class="muted">okänt</span>';
}

function dossierContractRow(f, todayIso, resellerChannelsByKommun = new Map()) {
  const period = f.period_start || f.period_end
    ? `${escapeHtml(f.period_start ?? '?')} – ${escapeHtml(f.period_end ?? '?')}${f.contract_length_months != null ? ` <span class="muted">(${f.contract_length_months} mån)</span>` : ''}`
    : '<span class="muted">okänd</span>';
  return `<tr>
    <td><a href="/kommun/${escapeHtml(f.kommun_kod)}" data-pane-link>${escapeHtml(f.kommun_namn)}</a>${resellerBadge(resellerChannelsByKommun.get(f.kommun_kod))}
      <span class="muted">${escapeHtml(f.lan ?? '')}</span></td>
    <td>${(f.products ?? []).length ? chipRow(f.products, 4) : '<span class="muted">—</span>'}</td>
    <td class="num">${annualValueCell(f)}</td>
    <td>${pricingModelBadge(f.pricing_model)}</td>
    <td>${period}</td>
    <td>${dossierLifecycleCell(f)}</td>
    <td>${renewalCell(f, todayIso)}</td>
    <td>${f.attachment_id ? `<a href="/attachments/${f.attachment_id}" target="_blank" rel="noopener" title="${escapeHtml(f.filename ?? '')}">📎 ${escapeHtml(f.filename ?? 'PDF')}</a>` : ''}</td>
  </tr>`;
}

function renewalCalendar(facts, todayIso) {
  const upcoming = facts
    .filter((f) => f.next_review_date && f.next_review_date >= todayIso)
    .sort((a, b) => a.next_review_date.localeCompare(b.next_review_date));
  const unknownOrPast = facts.length - upcoming.length;
  if (upcoming.length === 0) {
    return `<p class="muted">Inga kommande förnyelsedatum kända${facts.length ? ` (${facts.length} avtal utan känt eller framtida datum)` : ''}.</p>`;
  }
  const items = upcoming.map((f) => `
    <li class="renewal-item">
      <span class="renewal-date">${escapeHtml(f.next_review_date)}</span>
      <a href="/kommun/${escapeHtml(f.kommun_kod)}" data-pane-link>${escapeHtml(f.kommun_namn)}</a>
      ${f.auto_renews ? '<span class="pill pill-default">förlängs automatiskt</span>' : ''}
      <span class="tag">${escapeHtml(renewalWindow(f, todayIso))}</span>
    </li>`).join('');
  const note = unknownOrPast > 0
    ? `<p class="muted">${unknownOrPast} avtal utan känt eller framtida förnyelsedatum.</p>` : '';
  return `<ul class="renewal-list">${items}</ul>${note}`;
}

// `resellerChannelsByKommun` (kommun_kod → reseller canonicals, from
// storage.listKommunerWithContracts().reseller_channels) badges kommuner that
// procure via framework/reseller channels and widens the ?-legend.
export function renderVendorDossier({ vendor, rollup = null, facts = [], productRollups = [], todayIso, resellerChannelsByKommun = new Map(), heartbeat = null, partial = false, escalationCount = 0 }) {
  // Only THIS vendor's kommuner matter for the badge/legend: a reseller
  // kommun elsewhere in the DB can't soften this dossier's aggregates.
  const anyReseller = facts.some((f) =>
    (resellerChannelsByKommun.get(f.kommun_kod) ?? []).length > 0);
  const r = rollup ?? {
    contract_count: 0, kommun_count: 0, total_annual_sek: null, value_known_count: 0,
    median_length_months: null, length_known_count: 0,
    price_per_student_min: null, price_per_student_max: null,
    dominant_pricing_model: null, pricing_model_mix: {}, products: [], next_renewal_date: null,
    avg_annual_per_kommun: null,
  };
  const arrCard = r.total_annual_sek == null
    ? '<div class="value">okänt</div>'
    : `<div class="value good">${escapeHtml(fmtSekCompact(r.total_annual_sek))}/år</div>`;
  const lengthVal = r.median_length_months == null ? 'okänt' : `${r.median_length_months} mån`;
  const elevVal = r.price_per_student_min == null
    ? 'okänt'
    : (r.price_per_student_min === r.price_per_student_max
        ? `${fmtSekFull(r.price_per_student_min)}`
        : `${fmtSekFull(r.price_per_student_min)} – ${fmtSekFull(r.price_per_student_max)}`);
  const stats = `
    <div class="stats stats-band">
      <div class="stat-card"><div class="label">Kommuner</div><div class="value">${r.kommun_count}</div></div>
      <div class="stat-card"><div class="label">Avtal</div><div class="value">${r.contract_count}</div></div>
      <div class="stat-card"><div class="label">Känd årskostnad</div>${arrCard}
        <div class="stat-sub">${completenessLine(r.value_known_count, r.contract_count)}</div></div>
      <div class="stat-card"><div class="label">Snitt per kommun</div>${
        r.avg_annual_per_kommun == null
          ? '<div class="value">okänt</div>'
          : `<div class="value">${escapeHtml(fmtSekCompact(r.avg_annual_per_kommun))}/år</div>`}
        <div class="stat-sub">${completenessLine(r.value_known_count, r.contract_count)} · ${r.kommun_count} kommuner</div></div>
      <div class="stat-card"><div class="label">Median avtalslängd</div><div class="value">${escapeHtml(lengthVal)}</div>
        <div class="stat-sub">${completenessLine(r.length_known_count, r.contract_count, 'avtalstid')}</div></div>
      <div class="stat-card"><div class="label">Pris per elev</div><div class="value">${escapeHtml(elevVal)}</div></div>
      <div class="stat-card"><div class="label">Nästa förnyelse</div><div class="value">${escapeHtml(r.next_renewal_date ?? 'okänt')}</div></div>
    </div>`;

  const table = facts.length === 0
    ? '<div class="empty-state">Inga lagrade avtal för denna leverantör ännu.</div>'
    : `<table class="contracts-table">
        <thead><tr>
          <th>Kommun</th><th>Produkter</th><th style="text-align:right">Årlig kostnad</th>
          <th>Prismodell</th><th>Avtalstid</th><th>Livscykel</th><th>Nästa förnyelse</th><th>Källa</th>
        </tr></thead>
        <tbody>${facts.map((f) => dossierContractRow(f, todayIso, resellerChannelsByKommun)).join('')}</tbody>
      </table>`;

  const body = `
    <div class="page-head">
      <h1>${escapeHtml(vendor.name)}</h1>
      <a href="/leverantorer" data-pane-link class="muted">← alla leverantörer</a>
    </div>
    ${stats}
    ${productRollups.length
      ? productTable(productRollups) + coverageMatrix(productRollups, vendor.slug, anyReseller)
      : (r.products.length ? `<div class="card"><h3>Produkter (${r.products.length})</h3>${chipRow(r.products, 50)}</div>` : '')}
    <div class="card">
      <h3>Förnyelsekalender</h3>
      ${renewalCalendar(facts, todayIso)}
    </div>
    <section class="board-section">
      <h2>Avtal per kommun <span class="count">${facts.length}</span></h2>
      ${table}
    </section>
  `;
  return layout({ title: vendor.name, body, currentPath: '/leverantorer', heartbeat, partial, escalationCount });
}

// One cell of the per-product kommun×grade drill-down. Same colour language
// as the dossier's product×grade matrix (cov-full/-partial/-none/-unknown/-na),
// but red here means "this kommun's collection is COMPLETE, it buys direct,
// and it gave us no contract for this product at this level" — a confident
// negative. An uncovered level is "?" instead when the kommun's collection is
// still in progress (insamling pågår, vet inte än) OR when it procures via a
// framework/reseller channel (kan finnas via ramavtal) — never red then.
// `k` is one buildProductCoverageByKommun row (carries reseller_channels +
// collection_done so the tooltip can name the actual reason).
function kommunCoverageCell(k, grade, productName) {
  const state = k.coverageByGrade[grade];
  if (state === 'na') {
    return `<td class="cov-cell cov-na" title="${escapeHtml(`${grade}: förekommer inte i leverantörens avtal`)}">–</td>`;
  }
  if (state === 'unknown') {
    const why = (k.reseller_channels ?? []).length > 0 && k.collection_done !== false
      ? `kan finnas via ramavtal (${k.reseller_channels.join(', ')}) — inget direktavtal för ${productName} sett`
      : `insamling pågår hos kommunen — vet inte än om ${productName} finns på nivån`;
    return `<td class="cov-cell cov-unknown" title="${escapeHtml(`${grade}: ${why}`)}">?</td>`;
  }
  if (state === 'none') {
    return `<td class="cov-cell cov-none" title="${escapeHtml(`${grade}: kommunen har lämnat avtal till oss, men inget för ${productName} på nivån`)}">✕</td>`;
  }
  const mark = state === 'full' ? '●' : '◐';
  const klass = state === 'full' ? 'cov-full' : 'cov-partial';
  const label = state === 'full' ? 'full täckning' : 'delvis täckning';
  return `<td class="cov-cell ${klass}" title="${escapeHtml(`${grade}: ${label}`)}">${mark}</td>`;
}

// Product-coverage drill-down (/leverantor/:slug/produkt/:productSlug): the
// dossier matrix pivoted for ONE product — columns the 9 grade levels. Rows
// default to only kommuner whose collection is COMPLETE (every conversation
// DONE), so the picture is confident by default — a kommun mid-collection is
// all "?" and only adds noise. `showAll` (from ?visa=alla) reveals the
// in-progress kommuner too. `drilldown` is buildProductCoverageByKommun output.
export function renderProductCoverage({ vendor, drilldown, showAll = false, heartbeat = null, partial = false, escalationCount = 0 }) {
  const head = GRADE_LEVELS
    .map((g) => `<th class="cov-head" title="${escapeHtml(g)}">${escapeHtml(GRADE_SHORT_LABELS[g] ?? g)}</th>`)
    .join('');

  // collection_done !== false: treat a row with no flag as complete (legacy
  // callers), matching buildProductCoverageByKommun's own convention.
  const doneKommuner = drilldown.kommuner.filter((k) => k.collection_done !== false);
  const inProgressCount = drilldown.kommuner.length - doneKommuner.length;
  const shown = showAll ? drilldown.kommuner : doneKommuner;

  // "Has the product" = at least one green/yellow cell — matches what the grid
  // visibly shows, so the count never claims more than the matrix.
  const hasProduct = (k) => GRADE_LEVELS.some((g) => k.coverageByGrade[g] === 'full' || k.coverageByGrade[g] === 'partial');
  const shownWithProduct = shown.filter(hasProduct).length;

  const rows = shown.map((k) => `<tr>
    <td><a href="/kommun/${escapeHtml(k.kommun_kod)}" data-pane-link>${escapeHtml(k.kommun_namn)}</a>${resellerBadge(k.reseller_channels)}</td>
    ${GRADE_LEVELS.map((g) => kommunCoverageCell(k, g, drilldown.productName)).join('')}
  </tr>`).join('');
  const anyReseller = shown.some((k) => (k.reseller_channels ?? []).length > 0);
  const resellerLegend = anyReseller
    ? ' · 🛒 via ramavtal — kommunen köper via ramavtal/återförsäljare, så ett ? betyder att produkten kan finnas via ramavtal utan direktavtal'
    : '';
  const matrix = shown.length === 0
    ? `<div class="empty-state">Inga kommuner med klar insamling ännu${inProgressCount > 0 ? ` — insamling pågår i ${inProgressCount}.` : '.'}</div>`
    : `<table class="cov-table">
        <thead><tr><th>Kommun</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted honesty-note">● full täckning · ◐ delvis · ✕ har avtal med oss men inte denna produkt/nivå (insamling klar) · ? · insamling pågår (vet inte än) · – nivån förekommer inte i leverantörens avtal${resellerLegend}.</p>`;

  // Summary + toggle. With nothing in progress, done-only == all, so the
  // wording and count stay the classic "X av Y kommuner (med data)".
  const summaryLine = (showAll || inProgressCount === 0)
    ? `${shownWithProduct} av ${shown.length} kommuner (med data) har produkten — endast kommuner vi hämtat avtal från visas.`
    : `${shownWithProduct} av ${shown.length} klara kommuner har produkten — ${inProgressCount} med pågående insamling är dolda.`;
  const base = `/leverantor/${escapeHtml(vendor.slug)}/produkt/${escapeHtml(slugifyProductName(drilldown.productName))}`;
  const toggle = inProgressCount === 0
    ? ''
    : (showAll
      ? ` <a href="${base}" data-pane-link class="cov-toggle">Visa endast klara kommuner</a>`
      : ` <a href="${base}?visa=alla" data-pane-link class="cov-toggle">Visa alla (inkl. ${inProgressCount} med insamling pågår)</a>`);

  const body = `
    <div class="page-head">
      <h1>${escapeHtml(drilldown.productName)} — ${escapeHtml(vendor.name)} · täckning per kommun</h1>
      <a href="/leverantor/${escapeHtml(vendor.slug)}" data-pane-link class="muted">← ${escapeHtml(vendor.name)}</a>
    </div>
    <p class="muted">${summaryLine}${toggle}</p>
    <section class="board-section">
      <h2>Täckning per skolnivå och kommun</h2>
      ${matrix}
    </section>
  `;
  return layout({
    title: `${drilldown.productName} — ${vendor.name}`,
    body, currentPath: '/leverantorer', heartbeat, partial, escalationCount,
  });
}
