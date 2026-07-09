// DOM glue for the /leverantorer slice & dice explorer. Thin by design:
// every decision (filtering, grouping, banding, aggregation) lives in the
// unit-tested pure module public/explorer-core.js — this file only reads
// controls, calls the core, and writes rows. No framework, no dependencies.
//
// Loaded as an ES module: on full page loads via the auto-init at the
// bottom, and after a pane swap via the dynamic import() hook in app.js
// (scripts inside innerHTML never execute, so app.js must re-init).
import {
  applyFilters,
  groupFacts,
  aggregateFacts,
  renewalWindow,
  PRICING_MODEL_LABELS,
} from './explorer-core.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtSekFull(n) { return Number(n).toLocaleString('sv-SE') + ' kr'; }

function fmtSekCompact(n) {
  if (n >= 1000000) return (n / 1000000).toLocaleString('sv-SE', { maximumFractionDigits: 1 }) + ' mkr';
  if (n >= 10000) return Math.round(n / 1000).toLocaleString('sv-SE') + ' tkr';
  return fmtSekFull(n);
}

// Mirrors the server-rendered initial rows in dashboard-views.js
// (explorerRow) — same columns, same okänt semantics.
function rowHtml(f, todayIso) {
  var vendor = f.vendor_slug
    ? '<a href="/leverantor/' + esc(f.vendor_slug) + '" data-pane-link>' + esc(f.vendor_name) + '</a>'
    : '<span class="muted">okänd</span>';
  var value = f.annual_value_sek == null
    ? '<span class="muted"' + (f.avtalsvarde ? ' title="Ur avtalet: ' + esc(f.avtalsvarde) + '"' : '') + '>okänt</span>'
    : '<span' + (f.avtalsvarde ? ' title="Ur avtalet: ' + esc(f.avtalsvarde) + '"' : '') + '>' + esc(fmtSekFull(f.annual_value_sek)) + '/år</span>';
  var model = f.pricing_model
    ? '<span class="tag">' + esc(PRICING_MODEL_LABELS[f.pricing_model] || f.pricing_model) + '</span>'
    : '<span class="muted">okänt</span>';
  var len = f.contract_length_months == null ? '<span class="muted">okänt</span>' : f.contract_length_months + ' mån';
  var w = renewalWindow(f, todayIso);
  var renew = !f.next_review_date
    ? '<span class="muted">okänt</span>'
    : esc(f.next_review_date) + ' <span class="' +
      (w === 'passerat' ? 'pill pill-overdue' : w === 'inom 3 mån' ? 'pill pill-default' : 'pill pill-promise') +
      '">' + esc(w) + '</span>';
  return '<tr>' +
    '<td>' + vendor + '</td>' +
    '<td><a href="/kommun/' + esc(f.kommun_kod) + '" data-pane-link>' + esc(f.kommun_namn) + '</a></td>' +
    '<td>' + (f.lan ? esc(f.lan) : '<span class="muted">—</span>') + '</td>' +
    '<td>' + ((f.products || []).length ? esc(f.products.join(', ')) : '<span class="muted">—</span>') + '</td>' +
    '<td class="num">' + value + '</td>' +
    '<td>' + model + '</td>' +
    '<td class="num">' + len + '</td>' +
    '<td>' + renew + '</td>' +
    '<td>' + (f.attachment_id ? '<a href="/attachments/' + f.attachment_id + '" target="_blank" rel="noopener" title="' + esc(f.filename || '') + '">📎 PDF</a>' : '') + '</td>' +
    '</tr>';
}

function summaryText(facts) {
  var a = aggregateFacts(facts);
  var sum = a.total_annual_sek == null
    ? 'summa okänd'
    : 'summa ' + fmtSekCompact(a.total_annual_sek) + '/år (känd för ' + a.value_known + ' av ' + a.count + ' avtal)';
  return a.count + ' avtal · ' + sum + ' · ' + a.kommun_count + ' kommuner · ' + a.vendor_count + ' leverantörer';
}

function groupHeaderHtml(key, facts, groupLabel) {
  var a = aggregateFacts(facts);
  var sum = a.total_annual_sek == null
    ? 'summa okänd'
    : 'summa ' + fmtSekCompact(a.total_annual_sek) + '/år (' + a.value_known + ' av ' + a.count + ' kända)';
  var label = groupLabel === 'pricing_model' ? (PRICING_MODEL_LABELS[key] || key) : key;
  return '<tr class="x-group-row"><td colspan="9">' + esc(label) +
    '<span class="x-group-agg">' + a.count + ' avtal · ' + esc(sum) + '</span></td></tr>';
}

export function initExplorer() {
  var root = document.querySelector('[data-explorer]');
  if (!root || root.dataset.xInit) return;
  root.dataset.xInit = '1';

  var dataEl = root.querySelector('[data-contract-facts]');
  var body = root.querySelector('[data-x-body]');
  var summary = root.querySelector('[data-x-summary]');
  if (!dataEl || !body || !summary) return;

  var facts;
  try { facts = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var todayIso = root.dataset.today || new Date().toISOString().slice(0, 10);

  function currentFilters() {
    var filters = {};
    root.querySelectorAll('[data-x-filter]').forEach(function (el) {
      if (el.value) filters[el.getAttribute('data-x-filter')] = el.value;
    });
    return filters;
  }

  function render() {
    var filtered = applyFilters(facts, currentFilters(), todayIso);
    var groupSel = root.querySelector('[data-x-group]');
    var dim = groupSel ? groupSel.value : '';
    var groups = groupFacts(filtered, dim, todayIso);
    var html = '';
    groups.forEach(function (g) {
      if (dim) html += groupHeaderHtml(g.key, g.facts, dim);
      g.facts.forEach(function (f) { html += rowHtml(f, todayIso); });
    });
    body.innerHTML = html || '<tr class="empty-row"><td colspan="9">Inga avtal matchar filtren.</td></tr>';
    summary.textContent = summaryText(filtered);
  }

  root.addEventListener('change', function (e) {
    if (e.target.closest('[data-x-filter], [data-x-group]')) render();
  });
  root.addEventListener('input', function (e) {
    if (e.target.matches('input[data-x-filter]')) render();
  });
  root.addEventListener('click', function (e) {
    if (!e.target.closest('[data-x-reset]')) return;
    root.querySelectorAll('[data-x-filter], [data-x-group]').forEach(function (el) { el.value = ''; });
    render();
  });
}

initExplorer();
