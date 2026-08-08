// Pilot dashboard — client enhancement. No framework, no build step.
// Pure progressive enhancement: every interaction here also works with the
// script absent (full-page navigation + standard form POST).
(function () {
  'use strict';
  var content = function () { return document.getElementById('content'); };

  // The /leverantorer explorer ships as an ES module (explorer.js over the
  // pure explorer-core.js). Scripts inside innerHTML never execute, so both
  // the initial full load and every pane swap must (re-)init it from here.
  // The module is cached after the first import; initExplorer() is
  // idempotent per explorer root.
  function initExplorerIfPresent() {
    if (!document.querySelector('[data-explorer]')) return;
    import('/explorer.js')
      .then(function (m) { m.initExplorer(); })
      .catch(function () { /* explorer stays a static table */ });
  }
  initExplorerIfPresent();

  // Swap the #content pane with the fragment for `url`. Falls back to a hard
  // navigation on any error so a failed fetch never leaves a dead pane.
  function loadPane(url, push) {
    var u = new URL(url, location.origin);
    u.searchParams.set('partial', '1');
    return fetch(u.toString(), { headers: { 'X-Partial': '1' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var clean = url.replace(/([?&])partial=1\b/, '$1').replace(/[?&]$/, '');
        content().innerHTML = html;
        content().dataset.path = clean;
        if (push) history.pushState({ url: clean }, '', clean);
        content().scrollTop = 0;
        window.scrollTo(0, 0);
        markActive(clean);
        initExplorerIfPresent();
      })
      .catch(function () { location.href = url; });
  }

  function markActive(url) {
    var links = document.querySelectorAll('.sidebar [data-pane-link]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      var active = href === '/' ? url === '/' : url.indexOf(href) === 0;
      links[i].classList.toggle('active', active);
    }
  }

  // Intercept in-app link clicks (sidebar + any [data-pane-link]).
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-pane-link]');
    if (!a) return;
    if (a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    loadPane(a.getAttribute('href'), true);
  });

  // Submit [data-pane-form] forms via fetch and swap to the resulting pane.
  document.addEventListener('submit', function (e) {
    var form = e.target.closest && e.target.closest('form[data-pane-form]');
    if (!form) return;
    e.preventDefault();
    // Pass the submitter so a clicked button's name/value is serialised —
    // new FormData(form) alone drops it, which silently 400'd button-borne
    // actions. Fall back to appending it for older engines lacking the arg.
    var fd = new FormData(form, e.submitter);
    if (e.submitter && e.submitter.name && !fd.has(e.submitter.name)) {
      fd.append(e.submitter.name, e.submitter.value);
    }
    var body = new URLSearchParams(fd);
    fetch(form.action, { method: 'POST', body: body })
      .then(function (res) {
        // A server error (400/409/503) must NOT masquerade as success by
        // reloading the same pane — fall back to a full submit so the
        // operator actually sees the error response.
        if (!res.ok && !res.redirected) { form.submit(); return; }
        var next = res.redirected ? res.url.replace(location.origin, '')
          : (form.getAttribute('data-return') || content().dataset.path || '/');
        return loadPane(next, true);
      })
      .catch(function () { form.submit(); });
  });

  // Row-scoped actions ([data-row-form], e.g. the overview one-click Skicka):
  // POST via fetch and refresh ONLY that table row. The overview is ~290 rows,
  // so a pane swap (let alone a full reload) throws away the operator's scroll
  // position for every send. Falls back to a normal submit on any error, so a
  // failure is never mistaken for a success.
  document.addEventListener('submit', function (e) {
    var form = e.target.closest && e.target.closest('form[data-row-form]');
    if (!form) return;
    var row = form.closest('tr');
    var kod = row && row.getAttribute('data-kommun-kod');
    if (!row || !kod) return;   // no row to update — let the plain POST happen
    e.preventDefault();
    if (row.classList.contains('row-sending')) return;  // already in flight

    var btn = e.submitter || form.querySelector('button[type="submit"]');
    row.classList.add('row-sending');
    if (btn) { btn.disabled = true; btn.textContent = '📨 Skickar…'; }

    var hardSubmit = function () {
      row.classList.remove('row-sending');
      if (btn) btn.disabled = false;
      form.submit();
    };

    fetch(form.action, { method: 'POST', headers: { 'X-Partial': '1' } })
      .then(function (res) {
        if (!res.ok && !res.redirected) { hardSubmit(); return; }
        return refreshRow(row, kod);
      })
      .catch(hardSubmit);
  });

  // Re-render one overview row from the server, keeping scroll position. The
  // row markup stays server-rendered — we fetch the current pane and lift out
  // the matching <tr> rather than duplicating badge markup in the client.
  function refreshRow(row, kod) {
    var path = (content() && content().dataset.path) || location.pathname + location.search;
    var u = new URL(path, location.origin);
    u.searchParams.set('partial', '1');
    return fetch(u.toString(), { headers: { 'X-Partial': '1' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.querySelector('tr[data-kommun-kod="' + kod + '"]');
        if (fresh) {
          fresh.classList.add('row-sent');
          row.replaceWith(fresh);
          return;
        }
        // The row no longer matches the active filter (it just left "ej
        // påbörjade"). Don't yank it out from under the cursor: mark it sent.
        var cell = row.querySelector('[data-state-cell]');
        if (cell) cell.innerHTML = '<span class="badge">Skickat</span>';
        row.classList.remove('row-sending');
        row.classList.add('row-sent');
      })
      .catch(function () {
        // The send itself succeeded; only the refresh failed. Say so honestly
        // rather than leaving a spinner or implying the send failed.
        var cell = row.querySelector('[data-state-cell]');
        if (cell) cell.innerHTML = '<span class="badge">Skickat</span>';
        row.classList.remove('row-sending');
      });
  }

  // Collapse/expand: a [data-collapse] toggles the sibling [data-collapse-target].
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-collapse]');
    if (!t) return;
    var tgt = t.parentElement.querySelector('[data-collapse-target]');
    if (!tgt) return;
    tgt.hidden = !tgt.hidden;
    t.setAttribute('aria-expanded', String(!tgt.hidden));
  });

  // Thread accordion: a [data-thread-toggle] header shows/hides its sibling
  // [data-thread-body] (the full conversation). Clicks on inner controls — the
  // status-toggle form, links, buttons, inputs — are ignored so they keep
  // working without also collapsing the thread.
  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var head = e.target.closest('[data-thread-toggle]');
    if (!head) return;
    if (e.target.closest('form, a, button, input, textarea, select')) return;
    var body = head.parentElement.querySelector('[data-thread-body]');
    if (!body) return;
    body.hidden = !body.hidden;
    head.setAttribute('aria-expanded', String(!body.hidden));
  });

  // Quoted-history expander: a [data-quote-toggle] button reveals its sibling
  // [data-quote-body] (the collapsed quoted prior thread) and flips its label.
  // It's a <button>, so the data-thread-toggle handler above already ignores it
  // (never collapses the thread); it lives in the msg-body, not the msg-head,
  // so the data-collapse handler never matches it either.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-quote-toggle]');
    if (!btn) return;
    var q = btn.parentElement.querySelector('[data-quote-body]');
    if (!q) return;
    q.hidden = !q.hidden;
    btn.setAttribute('aria-expanded', String(!q.hidden));
    var label = btn.querySelector('.quote-toggle-label');
    if (label) label.textContent = q.hidden ? 'Visa citerad historik' : 'Dölj';
  });

  // Light/dark theme toggle, persisted in localStorage (applied pre-paint by
  // the inline bootstrap in <head>).
  document.addEventListener('click', function (e) {
    if (!(e.target.closest && e.target.closest('[data-theme-toggle]'))) return;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    if (dark) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.setItem('pilot-theme', dark ? '' : 'dark'); } catch (_) {}
  });

  window.addEventListener('popstate', function (e) {
    var url = (e.state && e.state.url) || (location.pathname + location.search);
    loadPane(url, false);
  });

  // --- Health modal: dismiss (per session) + in-app Gmail re-auth ---
  var HEALTH_DISMISS_KEY = 'pilot-health-dismissed';

  function hideHealthModal() {
    var m = document.querySelector('[data-health-modal]');
    if (m) m.remove();
  }

  // If dismissed earlier this session, don't nag again until a full reload in a
  // new session.
  try {
    if (sessionStorage.getItem(HEALTH_DISMISS_KEY)) hideHealthModal();
  } catch (_) {}

  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-dismiss-modal]')) {
      try { sessionStorage.setItem(HEALTH_DISMISS_KEY, '1'); } catch (_) {}
      hideHealthModal();
      return;
    }
    var btn = e.target.closest && e.target.closest('[data-reauth]');
    if (!btn) return;
    var status = document.querySelector('[data-reauth-status]');
    btn.disabled = true;
    if (status) { status.hidden = false; status.className = 'modal-status'; status.textContent = 'Startar…'; }
    fetch('/auth/gmail/start', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.consentUrl) throw new Error(data.error || 'Kunde inte starta');
        // Deployed, re-auth is the ordinary sign-in round-trip: navigate in
        // this tab so the session cookie and the redirect back to / both land
        // where the operator is looking. No status to poll — arriving back on
        // the dashboard signed in IS the success signal.
        if (data.viaSignIn) { window.location.href = data.consentUrl; return; }
        window.open(data.consentUrl, '_blank', 'noopener');
        if (status) {
          status.innerHTML = 'Väntar på Google-inloggning… om fliken inte öppnades: ' +
            '<a href="' + data.consentUrl + '" target="_blank" rel="noopener">öppna inloggning</a>';
        }
        pollReauth(status);
      })
      .catch(function (err) {
        btn.disabled = false;
        if (status) { status.className = 'modal-status err'; status.textContent = 'Fel: ' + err.message; }
      });
  });

  function pollReauth(status) {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      fetch('/auth/gmail/status').then(function (r) { return r.json(); }).then(function (s) {
        if (s.status === 'success') {
          clearInterval(iv);
          try { sessionStorage.setItem(HEALTH_DISMISS_KEY, '1'); } catch (_) {}
          if (status) { status.className = 'modal-status ok'; status.textContent = '✅ Gmail återanslutet. Daemonen hämtar nya mejl inom 15 min.'; }
        } else if (s.status === 'error') {
          clearInterval(iv);
          if (status) { status.className = 'modal-status err'; status.textContent = 'Misslyckades: ' + (s.error || 'okänt fel'); }
        } else if (tries > 150) {
          clearInterval(iv); // ~5 min
        }
      }).catch(function () {});
    }, 2000);
  }

  // Quiet background poll — replaces the old full-page <meta refresh>. Keeps the
  // sidebar escalation badge fresh WITHOUT touching the open pane. Skips while a
  // field is focused so it can never disturb a half-typed reply.
  setInterval(function () {
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
    fetch('/api/escalation-count', { headers: { 'X-Partial': '1' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var badge = document.querySelector('[data-poll="esc-count"]');
        if (badge) badge.textContent = String(data.count);
      })
      .catch(function () {});
    // The health modal is server-rendered once, so a tab left open across a
    // recovery kept warning that mail was not being processed long after it
    // was — the operator's only signal said the opposite of the truth. Poll it
    // down: once the pipeline reports healthy, take the modal away and heal the
    // heartbeat pill in place.
    fetch('/api/health', { headers: { 'X-Partial': '1' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (h) {
        if (!h || h.stale) return;
        var modal = document.querySelector('[data-health-modal]');
        if (modal) modal.remove();
        var pill = document.querySelector('.heartbeat');
        if (pill && pill.classList.contains('heartbeat-off')) {
          pill.classList.replace('heartbeat-off', 'heartbeat-live');
          pill.textContent = '🟢 daemon · nyss';
        }
      })
      .catch(function () {});
  }, 30000);
})();
