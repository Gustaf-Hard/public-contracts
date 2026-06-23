// Pilot dashboard — client enhancement. No framework, no build step.
// Pure progressive enhancement: every interaction here also works with the
// script absent (full-page navigation + standard form POST).
(function () {
  'use strict';
  var content = function () { return document.getElementById('content'); };

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
    var body = new URLSearchParams(new FormData(form));
    fetch(form.action, { method: 'POST', body: body })
      .then(function (res) {
        var next = res.redirected ? res.url.replace(location.origin, '')
          : (form.getAttribute('data-return') || content().dataset.path || '/');
        return loadPane(next, true);
      })
      .catch(function () { form.submit(); });
  });

  // Collapse/expand: a [data-collapse] toggles the sibling [data-collapse-target].
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-collapse]');
    if (!t) return;
    var tgt = t.parentElement.querySelector('[data-collapse-target]');
    if (!tgt) return;
    tgt.hidden = !tgt.hidden;
    t.setAttribute('aria-expanded', String(!tgt.hidden));
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
  }, 30000);
})();
