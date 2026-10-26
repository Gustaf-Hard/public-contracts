// Mediagraf Studio building blocks (ux-audit.md §4.3). Every function returns
// an HTML string and escapes every text input. Parameters named `viz` or
// `contextHtml` take already-rendered component HTML (trusted markup built
// by these functions), never raw data.

import { esc } from './layout.js';
import { fmtInt, UNKNOWN } from './format.js';
import { sparkline } from './charts.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const show = (v) => (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? null : isNum(v) ? fmtInt(v) : String(v));

// ------------------------------------------------------------- entity header

export function entityHeader({ kicker = '', title = '', answer = '', facts = [], viz = '' } = {}) {
  const factHtml = facts.slice(0, 3).map((f) => {
    const v = show(f.value);
    return `<div class="eh-fact${v == null ? ' is-unknown' : ''}">
      <dt>${esc(f.label)}</dt>
      <dd class="eh-val">${esc(v ?? UNKNOWN)}${f.unit ? `<small>${esc(f.unit)}</small>` : ''}</dd>
      ${f.sub ? `<dd class="eh-sub">${esc(f.sub)}</dd>` : ''}
    </div>`;
  }).join('');
  return `<section class="entity-header">
  <div class="entity-grid">
    <div class="eh-main">
      ${kicker ? `<span class="kicker">${esc(kicker)}</span>` : ''}
      <h1 class="page-title">${esc(title)}</h1>
      ${answer ? `<p class="lede">${esc(answer)}</p>` : ''}
    </div>
    <div class="eh-side">
      ${factHtml ? `<dl class="eh-facts">${factHtml}</dl>` : ''}
      ${viz ? `<div class="eh-viz">${viz}</div>` : ''}
    </div>
  </div>
</section>`;
}

// ------------------------------------------------------------------ KPI tile

const STATES = new Set(['known', 'partial', 'unknown']);

export function kpiTile({ label = '', value = null, unit = '', basis = '', state = 'known', reason = '', spark = null } = {}) {
  const st = STATES.has(state) ? state : 'unknown';
  const v = st === 'unknown' ? null : show(value);
  const unknown = v == null;
  const cls = unknown ? 'is-unknown hatch' : st === 'partial' ? 'is-partial' : 'is-known';
  const sp = !unknown && Array.isArray(spark) ? sparkline(spark) : '';
  return `<div class="kpi ${cls}">
  <span class="kpi-label">${esc(label)}</span>
  <span class="kpi-value"><span class="kpi-num">${esc(v ?? UNKNOWN)}</span>${!unknown && unit ? `<span class="kpi-unit">${esc(unit)}</span>` : ''}${sp ? `<span class="kpi-spark">${sp}</span>` : ''}</span>
  ${unknown && reason ? `<span class="kpi-reason">${esc(reason)}</span>` : ''}
  ${basis ? `<span class="kpi-basis">${st === 'partial' ? '<i class="kpi-flag" aria-hidden="true"></i>' : ''}${esc(basis)}</span>` : ''}
</div>`;
}

// ------------------------------------------------------------- segment strip

// The seven school forms a kommun buys for, in canonical order.
export const STRIP_SEGMENTS = Object.freeze([
  { key: 'Förskola', short: 'F' },
  { key: 'Förskoleklass', short: 'Fk' },
  { key: '1-3', short: '1-3' },
  { key: '4-6', short: '4-6' },
  { key: '7-9', short: '7-9' },
  { key: 'Gymnasiet', short: 'Gy' },
  { key: 'Komvux', short: 'Vux' },
]);

export function segmentStrip(segments = []) {
  const on = new Set(Array.isArray(segments) ? segments : []);
  const unknown = on.size === 0;
  const names = STRIP_SEGMENTS.filter((s) => on.has(s.key)).map((s) => s.key);
  const aria = unknown ? 'Segment okänt' : `Segment: ${names.join(', ')}`;
  return `<span class="seg-strip${unknown ? ' is-unknown hatch' : ''}" role="img" aria-label="${esc(aria)}">${STRIP_SEGMENTS.map((s) => `<span class="seg${on.has(s.key) ? ' is-on' : ''}" title="${esc(s.key)}">${esc(s.short)}</span>`).join('')}${unknown ? '<span class="seg-note">segment okänt</span>' : ''}</span>`;
}

// ---------------------------------------------------------------- filter bar

const opt = (o) => (o && typeof o === 'object' ? { value: String(o.value ?? ''), label: String(o.label ?? o.value ?? '') } : { value: String(o ?? ''), label: String(o ?? '') });

function hrefWith(action, fields, dropName) {
  const qs = new URLSearchParams();
  for (const f of fields) if (f.name !== dropName && f.value) qs.set(f.name, f.value);
  const s = qs.toString();
  return s ? `${action}?${s}` : action;
}

// Field options: `type: 'text'` renders a text input instead of a select;
// `all: false` drops the "Alla" option and `def` is then the value shown
// when none is chosen (a chosen value equal to `def` gets no chip).
export function filterBar({ action = '', fields = [], resultLine = '' } = {}) {
  const selects = fields.map((f) => {
    const id = `fb-${String(f.name).replace(/[^a-zA-Z0-9_-]/g, '')}`;
    if (f.type === 'text') {
      return `<label class="fb-field fb-text" for="${esc(id)}">
      <span>${esc(f.label)}</span>
      <input id="${esc(id)}" name="${esc(f.name)}" type="search" value="${esc(f.value ?? '')}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ''} autocomplete="off">
    </label>`;
    }
    const opts = (f.options || []).map(opt);
    const cur = String(f.value || (f.def ?? ''));
    return `<label class="fb-field" for="${esc(id)}">
      <span>${esc(f.label)}</span>
      <select id="${esc(id)}" name="${esc(f.name)}">
        ${f.all === false ? '' : '<option value="">Alla</option>'}
        ${opts.map((o) => `<option value="${esc(o.value)}"${cur && o.value === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </label>`;
  }).join('');
  const active = fields.filter((f) => f.value && f.chip !== false && !(f.def != null && String(f.value) === String(f.def)));
  const chips = active.map((f) => {
    const o = f.type === 'text' ? null : (f.options || []).map(opt).find((x) => x.value === String(f.value));
    return `<a class="chip is-accent fb-chip" href="${esc(hrefWith(action, fields, f.name))}" data-pane-link aria-label="${esc(`Ta bort filter ${f.label}: ${o ? o.label : f.value}`)}"><span>${esc(f.label)}: <b>${esc(o ? o.label : f.value)}</b></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></a>`;
  }).join('');
  return `<form class="filter-bar" method="get" action="${esc(action)}" data-pane-form>
  <div class="fb-fields">${selects}<button type="submit" class="fb-submit">Visa</button></div>
  ${chips || resultLine ? `<div class="fb-status">
    ${chips ? `<div class="fb-chips">${chips}${active.length > 1 ? `<a class="fb-clear" href="${esc(action)}" data-pane-link>Rensa alla</a>` : ''}</div>` : ''}
    ${resultLine ? `<p class="fb-result">${esc(resultLine)}</p>` : ''}
  </div>` : ''}
</form>`;
}

// --------------------------------------------------------------- empty panel

export function emptyPanel({ title = '', text = '', context = '', contextHtml = '' } = {}) {
  return `<div class="panel-unknown empty-panel">
  <span class="ep-mark" aria-hidden="true"><i></i><i></i><i></i></span>
  <div class="ep-body">
    <strong class="ep-title">${esc(title)}</strong>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${context ? `<p class="ep-context">${esc(context)}</p>` : ''}
  </div>
  ${contextHtml ? `<div class="ep-near">${contextHtml}</div>` : ''}
</div>`;
}

// ----------------------------------------------------------- evidence drawer

export const EVIDENCE_PAGE_SIZE = 50;

const PDF_ICON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h6.5L15.5 6.5v11h-10.5z"/><path d="M11.5 2.5v4h4"/><path d="M7.5 11h5M7.5 14h5"/></svg>';

export function evidenceDrawer({ rows = [], total = null, page = 1, pageHref = (p) => `?sida=${p}`, noun = 'avtal' } = {}) {
  const tot = isNum(total) ? total : rows.length;
  const pages = Math.max(1, Math.ceil(tot / EVIDENCE_PAGE_SIZE));
  const cur = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const from = (cur - 1) * EVIDENCE_PAGE_SIZE + 1;
  const to = Math.min(tot, from + rows.length - 1);
  const body = rows.map((r) => `<tr>
      <td data-label="Kommun">${esc(r.kommun)}</td>
      <td data-label="Period" class="nowrap">${esc(r.period ?? UNKNOWN)}</td>
      <td data-label="Värde" class="r nowrap">${esc(r.value ?? UNKNOWN)}</td>
      <td data-label="Prismodell">${esc(r.model ?? UNKNOWN)}</td>
      <td data-label="Källa" class="r">${r.pdfHref ? `<a class="ev-pdf" href="${esc(r.pdfHref)}" target="_blank" rel="noopener" aria-label="Öppna avtalet som PDF" title="Öppna avtalet som PDF">${PDF_ICON}<span>PDF</span></a>` : '<span class="muted">saknas</span>'}</td>
    </tr>`).join('');

  const nums = [];
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - cur) <= 1) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const nav = pages > 1 ? `<nav class="ev-pages" aria-label="Sidor">
      ${cur > 1 ? `<a href="${esc(pageHref(cur - 1))}" data-pane-link rel="prev">Föregående</a>` : '<span class="is-off">Föregående</span>'}
      ${nums.map((p) => (p === '…' ? '<span class="ev-gap">…</span>' : p === cur ? `<span class="is-cur" aria-current="page">${p}</span>` : `<a href="${esc(pageHref(p))}" data-pane-link>${p}</a>`)).join('')}
      ${cur < pages ? `<a href="${esc(pageHref(cur + 1))}" data-pane-link rel="next">Nästa</a>` : '<span class="is-off">Nästa</span>'}
    </nav>` : '';

  return `<details class="evidence"${cur > 1 ? ' open' : ''}>
  <summary><span class="ev-sum">Visa underlag (${esc(fmtInt(tot))} ${esc(noun)})</span><span class="ev-hint">kommun, period, värde och källa per avtal</span></summary>
  <div class="ev-body">
    ${rows.length ? `<p class="meta">Visar ${esc(fmtInt(from))} till ${esc(fmtInt(to))} av ${esc(fmtInt(tot))}</p>
    <table class="st-table cards ev-table">
      <thead><tr><th>Kommun</th><th>Period</th><th class="r">Värde per år</th><th>Prismodell</th><th class="r">Källa</th></tr></thead>
      <tbody>${body}</tbody>
    </table>${nav}` : '<p class="meta">Inga avtal att visa.</p>'}
  </div>
</details>`;
}
