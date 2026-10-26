// Mediagraf Studio shell. Separate from the back-office layout on purpose: no
// heartbeat pill, escalation badge, health modal or any link into the back
// office. Partial (pane-swap) requests get the body only, so every style the
// studio needs is in studioCss in the head.

import { studioCss } from './css.js';
import { basisSentence } from './format.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const ICON = {
  marknad: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  kategorier: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  leverantorer: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M16 9h2a2 2 0 0 1 2 2v10"/><path d="M8 7h4M8 11h4M8 15h4M3 21h18"/>',
  kommuner: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  fornyelser: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8.5 14.5h3"/>',
  utforska: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  theme: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
};

const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

// `match`: path prefixes that make the item current. Marknad is exact-only so
// it does not light up on every studio page.
export const STUDIO_NAV = Object.freeze([
  { label: 'Marknad', href: '/studio', icon: 'marknad', match: [] },
  { label: 'Kategorier', href: '/studio/kategorier', icon: 'kategorier', match: ['/studio/kategori'] },
  { label: 'Leverantörer', href: '/studio/leverantorer', icon: 'leverantorer', match: ['/studio/leverantor', '/studio/produkt'] },
  { label: 'Kommuner', href: '/studio/kommuner', icon: 'kommuner', match: ['/studio/kommun'] },
  { label: 'Förnyelser', href: '/studio/fornyelser', icon: 'fornyelser', match: ['/studio/fornyelser'] },
  { label: 'Utforska', href: '/studio/utforska', icon: 'utforska', match: ['/studio/utforska'] },
]);

export function isNavCurrent(item, currentPath) {
  const p = String(currentPath ?? '').split('?')[0].replace(/\/+$/, '') || '/';
  if (p === item.href) return true;
  return item.match.some((m) => p.startsWith(m));
}

function navLinks(currentPath, cls = '') {
  return STUDIO_NAV.map((item) => {
    const cur = isNavCurrent(item, currentPath) ? ' aria-current="page"' : '';
    return `<a href="${item.href}" data-pane-link data-nav-match="${esc([item.href, ...item.match].join('|'))}"${cls}${cur}>${svg(item.icon)}<span>${esc(item.label)}</span></a>`;
  }).join('');
}

function searchForm(id) {
  return `<form class="st-search" role="search" action="/studio/sok" method="get">
      <label class="sr-only" for="${id}">Sök kommun, leverantör eller produkt</label>
      ${svg('search')}
      <input name="q" list="studio-search" id="${id}" type="search" placeholder="Sök i studion" autocomplete="off" enterkeyhint="search">
    </form>`;
}

const themeButton = `<button type="button" class="st-theme" data-theme-toggle aria-label="Växla mellan ljust och mörkt tema">${svg('theme')}<span>Tema</span></button>`;

const brand = `<a class="st-brand" href="/studio" data-pane-link aria-label="Mediagraf Studio, till marknadsöversikten">
      <span class="st-mark" aria-hidden="true">M</span>
      <span class="st-wordmark"><b>Mediagraf Studio</b><span>Skolans digitala marknad</span></span>
    </a>`;

export function studioLayout({ title, body, currentPath = '/studio', partial = false, basis = null, searchOptions = [] }) {
  if (partial) return body;
  const options = [...new Set(searchOptions.filter(Boolean))]
    .map((o) => `<option value="${esc(o)}"></option>`).join('');
  return `<!doctype html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0f1113" media="(prefers-color-scheme: dark)">
  <title>${esc(title)} · Mediagraf Studio</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230e6e6a'/%3E%3Ctext x='16' y='23' font-family='Georgia,serif' font-size='20' font-weight='700' fill='white' text-anchor='middle'%3EM%3C/text%3E%3C/svg%3E">
  <script>(function(){try{var t=localStorage.getItem('pilot-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>
  <link rel="preload" href="/fonts/inter/inter-var-latin.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="/fonts/fraunces/fraunces-var-latin.woff2" as="font" type="font/woff2" crossorigin>
  <style>${studioCss}</style>
</head>
<body data-studio>
  <a class="skip-link" href="#content">Till innehållet</a>
  <div class="st-shell">
    <aside class="st-rail">
      ${brand}
      ${searchForm('st-q-rail')}
      <nav class="st-nav" aria-label="Studio">${navLinks(currentPath)}</nav>
      <div class="st-rail-foot">
        <p>Avtal begärda ur allmänna handlingar från Sveriges kommuner, tolkade och sammanställda.</p>
        ${themeButton}
      </div>
    </aside>
    <div class="st-main">
      <header class="st-topbar">
        <div class="st-topbar-row">${brand}${themeButton}</div>
        ${searchForm('st-q-top')}
      </header>
      <main id="content" class="st-content" data-path="${esc(currentPath)}">${body}</main>
      <footer class="st-footer">
        <span data-basis>${esc(basisSentence(basis))}</span>
        <a href="/studio/om" data-pane-link>Om datan</a>
      </footer>
    </div>
  </div>
  <nav class="st-tabbar" aria-label="Studio, flikar">${navLinks(currentPath)}</nav>
  <datalist id="studio-search">${options}</datalist>
  <script src="/app.js" defer></script>
</body>
</html>`;
}
