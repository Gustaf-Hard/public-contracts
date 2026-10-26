// Mediagraf Studio design system (ux-audit.md §4.1–4.4). All studio CSS lives
// here and is inlined in the studio layout head: pane-swap partials return the
// body only, so a page can never bring its own stylesheet.
//
// Tokens follow ux-audit §4.2. Deviations, all forced by the dataviz palette
// validator (validate_palette.js, run 2026-10-26):
//  - --viz-1 light #0e6e6a fails the chroma floor (C 0.081 < 0.10, reads grey
//    as a mark); marks use #00897b. --accent stays #0e6e6a for links and UI.
//  - --viz-3..5 light (#4f46e5, #a16207, #7c3aed) put indigo next to violet
//    (normal-vision ΔE 7.5) and amber next to orange (deutan ΔE 0.6). Replaced
//    with indigo #5b4fd6, ochre #a16207, magenta #c2397a; the first three slots
//    pass all-pairs (maps, scatter), all five pass adjacent.
//  - --viz-seq light end #eef5f4 is 1.09:1 on the surface (floor 2:1); the ramp
//    is #82c1b9 → #0a5753. Dark steps were validated against #16191c.
// Light: categorical "#00897b,#c2410c,#5b4fd6,#a16207,#c2397a" on #fffdf9.
// Dark:  categorical "#2aa596,#e8662c,#8a80ee,#c08a1c,#de5e9a" on #16191c.

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0f1113; --surface: #16191c; --surface-2: #1d2125; --surface-3: #262b30;
  --ink: #ece9e2; --ink-2: #b7b3aa; --ink-3: #868a91;
  --line: #2a2f35; --line-strong: #3a4047;
  --accent: #4fb3a9; --accent-ink: #0f1113;
  --pos: #63b46e; --caution: #e0a24a; --neg: #ef7065; --unknown: #7d828a;
  --viz-1: #2aa596; --viz-2: #e8662c; --viz-3: #8a80ee; --viz-4: #c08a1c; --viz-5: #de5e9a; --viz-other: #4a4f56;
  --viz-seq-0: #235c56; --viz-seq-1: #2a7a72; --viz-seq-2: #33998f; --viz-seq-3: #55b8ad; --viz-seq-4: #8ad6cc;
  --viz-highlight: #e8662c;
  --shadow-1: 0 1px 0 rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.35);
  --shadow-2: 0 10px 28px -10px rgba(0,0,0,.6);
  --rail-bg: #121517;
`;

export const studioCss = `
@font-face {
  font-family: "Fraunces";
  src: url("/fonts/fraunces/fraunces-var-latin.woff2") format("woff2");
  font-weight: 300 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/fonts/inter/inter-var-latin.woff2") format("woff2");
  font-weight: 400 700; font-style: normal; font-display: swap;
}

:root {
  color-scheme: light;
  /* surfaces */
  --bg: #f6f4ef;  --surface: #fffdf9;  --surface-2: #f0ede6;  --surface-3: #e7e3da;
  --ink: #16181d; --ink-2: #4a4f59; --ink-3: #7b808a;
  --line: #e2ddd2; --line-strong: #cfc8ba;
  /* brand */
  --accent: #0e6e6a;
  --accent-ink: #ffffff;
  --accent-wash: color-mix(in oklab, var(--accent) 10%, var(--surface));
  /* semantic: status only, never decoration */
  --pos: #2f7d3a; --caution: #b26a00; --neg: #b3261e; --unknown: #8a8f98;
  /* data viz (validated, see header comment) */
  --viz-1: #00897b; --viz-2: #c2410c; --viz-3: #5b4fd6; --viz-4: #a16207; --viz-5: #c2397a; --viz-other: #b9b3a6;
  --viz-seq-0: #82c1b9; --viz-seq-1: #57a89f; --viz-seq-2: #358f86; --viz-seq-3: #1b746d; --viz-seq-4: #0a5753;
  --viz-highlight: #c2410c;
  --hatch: repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in oklab, var(--ink-3) 22%, transparent) 4px 5px);
  /* type */
  --font-display: "Fraunces", ui-serif, Georgia, serif;
  --font-ui: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --t-xs: 12px; --t-sm: 13px; --t-md: 15px; --t-lg: 18px; --t-xl: 24px; --t-2xl: 32px; --t-3xl: 44px; --t-4xl: 60px;
  /* space (4-pt) */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-5: 24px; --s-6: 32px; --s-7: 48px; --s-8: 64px;
  --r-1: 6px; --r-2: 10px; --r-3: 16px;
  --shadow-1: 0 1px 0 rgba(22,24,29,.04), 0 1px 2px rgba(22,24,29,.06);
  --shadow-2: 0 8px 24px -8px rgba(22,24,29,.18);
  --ease: cubic-bezier(.2,.7,.2,1); --dur: 180ms;
  /* shell */
  --rail-w: 256px;
  --rail-bg: #efece5;
  --tabbar-h: 62px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
:root[data-theme="dark"] {${DARK_TOKENS}}

/* ---------- base ---------- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--font-ui); font-size: var(--t-md); line-height: 1.5;
  font-feature-settings: "ss01", "cv11";
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
a { color: var(--accent); text-decoration: none; text-underline-offset: 3px; }
a:hover { text-decoration: underline; text-decoration-thickness: 1px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::selection { background: color-mix(in oklab, var(--accent) 24%, transparent); }
h1, h2, h3, h4 { margin: 0; font-weight: 600; }
p { margin: 0; }
.num, .tnum, table { font-variant-numeric: tabular-nums; font-feature-settings: "tnum", "ss01", "cv11"; }
.nowrap { white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: var(--s-4); top: -60px; z-index: 50; background: var(--accent); color: var(--accent-ink); padding: var(--s-2) var(--s-3); border-radius: var(--r-1); }
.skip-link:focus { top: var(--s-3); }

/* ---------- shell: left rail + main ---------- */
.st-shell { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); min-height: 100vh; }
.st-rail {
  position: sticky; top: 0; height: 100vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: var(--s-5);
  padding: var(--s-5) var(--s-4) var(--s-4);
  background: var(--rail-bg); border-right: 1px solid var(--line);
}
.st-brand { display: flex; align-items: center; gap: var(--s-3); color: var(--ink); padding: 0 var(--s-2); }
.st-brand:hover { text-decoration: none; }
.st-mark {
  flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center;
  background: var(--accent); color: var(--accent-ink);
  font-family: var(--font-display); font-weight: 600; font-size: 21px; line-height: 1;
  box-shadow: inset 0 -3px 0 color-mix(in oklab, #000 18%, transparent);
}
.st-wordmark { display: flex; flex-direction: column; line-height: 1.15; white-space: nowrap; min-width: 0; }
.st-wordmark b { font-family: var(--font-display); font-weight: 600; font-size: 18px; letter-spacing: -.015em; }
.st-wordmark span { font-size: var(--t-xs); color: var(--ink-3); letter-spacing: .02em; }

.st-search { position: relative; }
.st-search input {
  width: 100%; height: 38px; padding: 0 var(--s-3) 0 34px;
  font: inherit; font-size: var(--t-sm); color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-2);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.st-search input::placeholder { color: var(--ink-3); }
.st-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent); }
.st-search svg { position: absolute; left: 11px; top: 50%; translate: 0 -50%; width: 16px; height: 16px; color: var(--ink-3); pointer-events: none; }

.st-nav { display: flex; flex-direction: column; gap: 2px; }
.st-nav-label { font-size: var(--t-xs); color: var(--ink-3); padding: 0 var(--s-3) var(--s-2); }
.st-nav a {
  display: flex; align-items: center; gap: var(--s-3);
  padding: 9px var(--s-3); border-radius: var(--r-1);
  color: var(--ink-2); font-size: var(--t-md); font-weight: 500;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.st-nav a svg { width: 18px; height: 18px; flex: none; opacity: .8; }
.st-nav a:hover { background: color-mix(in oklab, var(--ink) 5%, transparent); color: var(--ink); text-decoration: none; }
.st-nav a[aria-current="page"] { background: var(--surface); color: var(--ink); box-shadow: var(--shadow-1), inset 3px 0 0 var(--accent); }
.st-nav a[aria-current="page"] svg { color: var(--accent); opacity: 1; }

.st-rail-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--s-3); padding: 0 var(--s-2); }
.st-rail-foot p { font-size: var(--t-xs); color: var(--ink-3); line-height: 1.45; }
.st-theme {
  display: inline-flex; align-items: center; gap: var(--s-2); align-self: flex-start;
  font: inherit; font-size: var(--t-sm); color: var(--ink-2);
  background: transparent; border: 1px solid var(--line); border-radius: 999px;
  padding: 5px var(--s-3); cursor: pointer;
}
.st-theme:hover { color: var(--ink); border-color: var(--line-strong); }
.st-theme svg { width: 15px; height: 15px; }

.st-main { min-width: 0; display: flex; flex-direction: column; }
.st-content { width: 100%; max-width: 1280px; margin: 0 auto; padding: var(--s-7) var(--s-6) var(--s-7); flex: 1; }
.st-footer {
  width: 100%; max-width: 1280px; margin: 0 auto; padding: var(--s-5) var(--s-6) var(--s-6);
  display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-5); justify-content: space-between; align-items: baseline;
  font-size: var(--t-xs); color: var(--ink-3); border-top: 1px solid var(--line);
}
.st-footer a { color: var(--ink-2); }
.st-topbar, .st-tabbar { display: none; }

/* ---------- type roles ---------- */
.page-title { font-family: var(--font-display); font-size: var(--t-3xl); line-height: 1.05; font-weight: 600; letter-spacing: -.02em; font-optical-sizing: auto; text-wrap: balance; }
.kicker { display: block; font-size: var(--t-sm); color: var(--ink-3); font-weight: 500; margin-bottom: var(--s-2); }
.section { margin-top: var(--s-7); }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-4); margin-bottom: var(--s-4); flex-wrap: wrap; }
.section-title { font-size: var(--t-lg); font-weight: 600; letter-spacing: -.005em; }
.lede { font-size: var(--t-lg); line-height: 1.45; color: var(--ink-2); max-width: 62ch; text-wrap: pretty; }
.meta { font-size: var(--t-xs); color: var(--ink-3); }
.muted { color: var(--ink-2); }

/* ---------- layout: 12-col grid + container queries ---------- */
.grid-12 { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: var(--s-5); }
.span-3 { grid-column: span 3; } .span-4 { grid-column: span 4; } .span-5 { grid-column: span 5; }
.span-6 { grid-column: span 6; } .span-7 { grid-column: span 7; } .span-8 { grid-column: span 8; }
.span-12 { grid-column: 1 / -1; }
.cq { container-type: inline-size; }

/* ---------- surfaces ---------- */
.card {
  container-type: inline-size;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-3);
  padding: var(--s-5); box-shadow: var(--shadow-1);
}
.entity-header {
  position: relative; overflow: hidden; view-transition-name: entity-header; container-type: inline-size;
  background:
    radial-gradient(120% 140% at 100% 0%, var(--accent-wash) 0%, transparent 55%),
    var(--surface);
  border: 1px solid var(--line); border-radius: var(--r-3);
  padding: var(--s-6) var(--s-6) var(--s-6);
  box-shadow: var(--shadow-1);
}
.entity-header::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--accent); }
.entity-header .lede { margin-top: var(--s-3); }
.entity-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: var(--s-6); align-items: end; }
@container (max-width: 760px) { .entity-grid { grid-template-columns: 1fr; } }

/* ---------- meters ---------- */
.coverage-meter { display: flex; flex-direction: column; gap: var(--s-2); }
.coverage-meter-head { display: flex; align-items: baseline; gap: var(--s-2); }
.coverage-meter .kpi-num { font-size: var(--t-4xl); line-height: 1; }
.meter { position: relative; height: 10px; border-radius: 999px; background: var(--hatch), var(--surface-3); overflow: hidden; }
.meter-fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--viz-1); }

/* ---------- KPI tiles ---------- */
.kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-4); }
.kpi-row > .kpi { min-width: 0; }
@container (max-width: 820px) { .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.kpi {
  container-type: inline-size;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-2);
  padding: var(--s-4) var(--s-4) var(--s-4); display: flex; flex-direction: column; gap: 2px;
}
.kpi-label { font-size: var(--t-sm); color: var(--ink-2); }
.kpi-value { display: flex; align-items: baseline; gap: 6px; margin-top: var(--s-1); white-space: nowrap; }
.kpi-num { font-family: var(--font-display); font-size: var(--t-2xl); font-weight: 500; line-height: 1.1; letter-spacing: -.015em; font-variant-numeric: lining-nums tabular-nums; }
.kpi-unit { font-size: var(--t-sm); color: var(--ink-2); }
.kpi-basis { font-size: var(--t-xs); color: var(--ink-3); margin-top: var(--s-1); }
.kpi.is-partial .kpi-basis { color: var(--caution); }
.kpi.is-unknown { background: var(--hatch), var(--surface-2); }
.kpi.is-unknown .kpi-num { color: var(--ink-3); }

/* ---------- unknown / too few ---------- */
.hatch { background-image: var(--hatch); background-color: var(--surface-2); }
.panel-unknown {
  background: var(--hatch), var(--surface-2); border: 1px dashed var(--line-strong);
  border-radius: var(--r-2); padding: var(--s-5); color: var(--ink-2);
}
.panel-unknown strong { color: var(--ink); font-weight: 600; }

/* ---------- chips, badges ---------- */
.chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: var(--t-xs); font-weight: 500; background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); white-space: nowrap; }
.chip.is-accent { background: var(--accent-wash); color: var(--accent); border-color: color-mix(in oklab, var(--accent) 25%, transparent); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }

/* ---------- tables (desktop) → row cards (phone) ---------- */
.st-table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.st-table th { text-align: left; font-weight: 500; color: var(--ink-3); font-size: var(--t-xs); padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--line-strong); white-space: nowrap; }
.st-table td { padding: var(--s-3); border-bottom: 1px solid var(--line); vertical-align: middle; }
.st-table td.r, .st-table th.r { text-align: right; }
.st-table tbody tr { transition: background var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
.st-table tbody tr:hover { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--accent); }
.scroll-x {
  overflow-x: auto; -webkit-overflow-scrolling: touch;
  mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
}
.scroll-x .st-table th:first-child, .scroll-x .st-table td:first-child { position: sticky; left: 0; background: var(--surface); z-index: 1; }

/* ---------- popovers ---------- */
[popover] {
  border: 1px solid var(--line); border-radius: var(--r-2); background: var(--surface); color: var(--ink);
  box-shadow: var(--shadow-2); padding: var(--s-4); max-width: min(360px, calc(100vw - 32px));
}

/* ---------- responsive ---------- */
@media (max-width: 1100px) {
  .span-3 { grid-column: span 6; }
  .span-4, .span-5, .span-6, .span-7, .span-8 { grid-column: 1 / -1; }
  .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  :root { --t-3xl: 34px; --t-2xl: 28px; }
  .st-shell { display: block; }
  .st-rail { display: none; }
  .st-topbar {
    display: flex; flex-direction: column; gap: var(--s-3);
    position: sticky; top: 0; z-index: 20;
    padding: var(--s-3) var(--s-4) var(--s-3);
    background: color-mix(in oklab, var(--bg) 88%, transparent);
    -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .st-topbar-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
  .st-topbar .st-mark { width: 30px; height: 30px; font-size: 18px; border-radius: 8px; }
  .st-topbar .st-wordmark b { font-size: 17px; }
  .st-topbar .st-theme span { display: none; }
  .st-content { padding: var(--s-5) var(--s-4) var(--s-6); }
  .st-footer { padding: var(--s-4) var(--s-4) calc(var(--tabbar-h) + var(--s-5) + env(safe-area-inset-bottom)); }
  .st-tabbar {
    display: grid; grid-template-columns: repeat(6, minmax(0, 1fr));
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    height: calc(var(--tabbar-h) + env(safe-area-inset-bottom));
    padding: 6px 4px env(safe-area-inset-bottom);
    background: color-mix(in oklab, var(--surface) 92%, transparent);
    -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
    border-top: 1px solid var(--line);
  }
  .st-tabbar a {
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    min-width: 0; border-radius: var(--r-1); color: var(--ink-3);
    font-size: 10px; font-weight: 500; letter-spacing: -.01em;
  }
  .st-tabbar a span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st-tabbar a svg { width: 21px; height: 21px; }
  .st-tabbar a:hover { text-decoration: none; color: var(--ink); }
  .st-tabbar a[aria-current="page"] { color: var(--accent); }
  .entity-header { padding: var(--s-5) var(--s-4); border-radius: var(--r-2); }
  .grid-12 { gap: var(--s-4); }
  .span-3 { grid-column: 1 / -1; }
  .kpi-row { gap: var(--s-3); }
  .kpi { padding: var(--s-3); }
  /* tables become stacked row cards; never clipped */
  .st-table.cards thead { display: none; }
  .st-table.cards, .st-table.cards tbody { display: block; }
  .st-table.cards tr {
    display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2) var(--s-4);
    padding: var(--s-3) var(--s-4); margin-bottom: var(--s-3);
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-2);
  }
  .st-table.cards td { border: 0; padding: 0; text-align: left !important; min-width: 0; }
  .st-table.cards td:first-child { grid-column: 1 / -1; font-weight: 600; font-size: var(--t-md); }
  .st-table.cards td[data-label]:not(:first-child)::before { content: attr(data-label); display: block; font-size: var(--t-xs); color: var(--ink-3); }
}

/* ---------- motion: only when the reader has not asked for less ---------- */
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
  ::view-transition-old(root) { animation: st-fade-out 140ms var(--ease) both; }
  ::view-transition-new(root) { animation: st-fade-up 260ms var(--ease) both; }
  ::view-transition-group(entity-header) { animation-duration: 320ms; animation-timing-function: var(--ease); }
  .st-content > * { animation: st-fade-up 360ms var(--ease) both; }
  .st-content > *:nth-child(2) { animation-delay: 40ms; }
  .st-content > *:nth-child(3) { animation-delay: 80ms; }
  .st-content > *:nth-child(n+4) { animation-delay: 120ms; }
  .grow-y { transform-origin: bottom; animation: st-grow-y 400ms var(--ease) both; animation-delay: calc(var(--i, 0) * 20ms); }
  .grow-x { transform-origin: left; animation: st-grow-x 500ms var(--ease) both; animation-delay: calc(var(--i, 0) * 20ms); }
  .fade-in { animation: st-fade 400ms var(--ease) both; animation-delay: calc(var(--i, 0) * 12ms); }
  .kpi, .card { transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease), border-color var(--dur) var(--ease); }
  .kpi:hover, .card.is-link:hover { box-shadow: var(--shadow-2); transform: translateY(-1px); border-color: var(--line-strong); }
  .chart:hover .mark:not(:hover) { opacity: .35; }
  .chart .mark { transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease); transform-box: fill-box; transform-origin: center; }
  .chart .mark:hover { transform: scale(1.3); }
  [popover] { transition: opacity 160ms var(--ease), translate 160ms var(--ease), display 160ms allow-discrete, overlay 160ms allow-discrete; }
  [popover]:popover-open { opacity: 1; translate: 0 0; }
  @starting-style { [popover]:popover-open { opacity: 0; translate: 0 4px; } }
}
@keyframes st-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes st-fade-out { to { opacity: 0; } }
@keyframes st-fade-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes st-grow-y { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes st-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
`;
