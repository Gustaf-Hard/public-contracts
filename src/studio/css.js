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
// Re-run for the component library (Task 5, 2026-10-26), both ALL CHECKS PASS:
//  light: lightness 0.43-0.77, chroma >= 0.1, worst adjacent CVD #c2397a/#a16207
//         dE 11.3 (deutan), tritan 8.1, normal-vision 18.3, contrast all >= 3:1
//  dark:  lightness 0.48-0.67, chroma >= 0.1, worst adjacent CVD #de5e9a/#c08a1c
//         dE 13.7 (deutan), tritan 8.3, normal-vision 20.8, contrast all >= 3:1
// Text on sequential cells (--seq-ink-*) is chosen per step by WCAG contrast:
//  light ink on steps 0-2 (8.7, 6.4, 4.6:1), white on 3-4 (5.6, 8.4:1);
//  dark #ece9e2 on steps 0-1 (6.3, 4.2:1), #0f1113 on 2-4 (5.5, 8.0, 11.3:1).

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
  --seq-ink-0: #ece9e2; --seq-ink-1: #ece9e2; --seq-ink-2: #0f1113; --seq-ink-3: #0f1113; --seq-ink-4: #0f1113;
  --tile-none: #3a4047;
  --shadow-1: 0 1px 0 rgba(0,0,0,.25), 0 1px 2px rgba(0,0,0,.35);
  --shadow-2: 0 10px 28px -10px rgba(0,0,0,.6);
  --rail-bg: #121517;
`;

// Component styles (Task 5). Chart rules: marks wear --viz-*, text wears ink
// tokens, unknown is always the hatch, never a colour. Hover detail is CSS
// only (.tip shown on :hover / :focus-visible), so pane swaps need no script.
const COMPONENT_CSS = `
/* ---------- shared viz chrome ---------- */
.viz { margin: 0; display: flex; flex-direction: column; gap: var(--s-3); min-width: 0; }
.viz-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-3); flex-wrap: wrap; }
.viz-label { font-size: var(--t-md); font-weight: 600; letter-spacing: -.005em; }
.viz-n { font-size: var(--t-xs); color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.viz-foot { display: flex; flex-wrap: wrap; gap: 6px var(--s-4); font-size: var(--t-xs); color: var(--ink-3); }
.lg { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
.lg i { flex: none; display: inline-block; }
.lg-band { width: 18px; height: 10px; border-radius: 3px; background: color-mix(in oklab, var(--viz-1) 22%, transparent); }
.lg-tick { width: 2px; height: 13px; border-radius: 1px; background: var(--ink); }
.lg-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--viz-1); }
.lg-dot.is-highlight { background: var(--viz-highlight); }
.lg-dot.is-unknown { background: var(--hatch), var(--surface); box-shadow: inset 0 0 0 1.5px var(--ink-3); }
.lg-hatch { width: 14px; height: 14px; border-radius: 3px; background: var(--hatch), var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); }

.tip {
  position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 1px; z-index: 20;
  padding: 7px 10px; border-radius: var(--r-1);
  background: var(--surface); border: 1px solid var(--line-strong); box-shadow: var(--shadow-2);
  font-size: var(--t-xs); line-height: 1.35; color: var(--ink-2); white-space: nowrap; text-align: left;
  pointer-events: none; opacity: 0; visibility: hidden;
}
.tip strong { color: var(--ink); font-size: var(--t-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
.tip-left > .tip { left: auto; right: -4px; transform: none; }
.tip-right > .tip { left: -4px; transform: none; }
:hover > .tip, :focus-visible > .tip { opacity: 1; visibility: visible; }

.axis-x { position: relative; height: 22px; margin-top: 4px; }
.axis-tick { position: absolute; top: 0; transform: translateX(-50%); padding-top: 6px; font-size: 11px; color: var(--ink-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.axis-tick::before { content: ""; position: absolute; top: 0; left: 50%; width: 1px; height: 4px; background: var(--line-strong); }
.axis-tick.is-first { transform: none; } .axis-tick.is-first::before { left: 0; }
.axis-tick.is-last { transform: translateX(-100%); } .axis-tick.is-last::before { left: auto; right: 0; }
.axis-x { margin-bottom: 14px; }
.axis-unit { position: absolute; right: 0; top: 22px; font-size: 10px; color: var(--ink-3); }
@container (max-width: 520px) { .axis-tick:nth-child(even):not(.is-last):not(.is-first) { visibility: hidden; } }

/* ---------- entity header facts ---------- */
.eh-main { min-width: 0; }
.eh-side { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
.eh-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: var(--s-4); margin: 0; }
.eh-fact { min-width: 0; padding-left: var(--s-3); border-left: 2px solid var(--line-strong); }
.eh-fact dt { font-size: var(--t-xs); color: var(--ink-3); }
.eh-val { margin: 2px 0 0; font-family: var(--font-display); font-size: 27px; font-weight: 500; line-height: 1.1; letter-spacing: -.015em; white-space: nowrap; font-variant-numeric: lining-nums tabular-nums; }
.eh-val small { font-family: var(--font-ui); font-size: var(--t-sm); color: var(--ink-2); margin-left: 5px; letter-spacing: 0; }
.eh-sub { margin: 2px 0 0; font-size: var(--t-xs); color: var(--ink-3); line-height: 1.35; }
.eh-fact.is-unknown { border-left-style: dashed; }
.eh-fact.is-unknown .eh-val { color: var(--ink-3); }
.eh-viz { min-width: 0; }

/* ---------- KPI extras ---------- */
.kpi-spark { margin-left: auto; align-self: flex-end; line-height: 0; }
.spark-line { fill: none; stroke: var(--viz-1); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spark-area { fill: color-mix(in oklab, var(--viz-1) 12%, transparent); }
.spark-end { fill: var(--viz-1); stroke: var(--surface); stroke-width: 2; }
.kpi-reason { font-size: var(--t-sm); color: var(--ink-2); line-height: 1.4; margin-top: 2px; }
.kpi-flag { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--caution); margin-right: 6px; vertical-align: 1px; }
.kpi.is-unknown { border-style: dashed; border-color: var(--line-strong); }
@container (max-width: 190px) { .kpi-spark { display: none; } }

/* ---------- strip plot ---------- */
.strip-plot { position: relative; margin: 0 9px; }
.strip-median-label, .strip-hl-label { position: relative; display: inline-flex; align-items: center; gap: 5px; transform: translateX(-50%); font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap; }
.strip-median-label { display: block; width: max-content; margin-bottom: 2px; }
.strip-hl-label { display: flex; width: max-content; margin-top: 2px; }
.strip-median-label b, .strip-hl-label b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.strip-median-label.is-left, .strip-hl-label.is-left { transform: translateX(-10px); }
.strip-median-label.is-right, .strip-hl-label.is-right { transform: translateX(calc(-100% + 10px)); }
.strip-hl-label .dot { width: 9px; height: 9px; background: var(--viz-highlight); }
.strip-area { position: relative; }
.strip-svg { display: block; overflow: visible; }
.strip-base { stroke: var(--line-strong); stroke-width: 1; }
.strip-iqr { fill: color-mix(in oklab, var(--viz-1) 15%, transparent); }
.strip-median { stroke: var(--ink); stroke-width: 2.5; stroke-linecap: round; }
.strip-dot { fill: var(--viz-1); fill-opacity: .88; stroke: var(--surface); stroke-width: 2; transition: opacity var(--dur) var(--ease); }
.strip-dot.is-highlight { fill: var(--viz-highlight); fill-opacity: 1; stroke-width: 2.5; }
.strip-hits { position: absolute; inset: 0; }
.strip-hit { position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; }
.strip-hit:hover { z-index: 5; }
.strip-hit:hover::after { content: ""; position: absolute; inset: 2px; border-radius: 50%; border: 2px solid var(--ink); }
.strip-area:has(.strip-hit:hover) .strip-dot { opacity: .45; }
.strip-empty {
  position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  gap: 6px; min-height: 132px; padding: var(--s-5); border-radius: var(--r-2); border: 1px dashed var(--line-strong);
}
.strip-empty strong { font-family: var(--font-display); font-size: var(--t-xl); font-weight: 500; letter-spacing: -.01em; color: var(--ink); line-height: 1.15; }
.strip-empty > span:last-child { font-size: var(--t-sm); color: var(--ink-2); max-width: 46ch; }
.strip-ghost { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
.strip-ghost i { display: block; width: 46px; height: 2px; border-radius: 2px; background: var(--line-strong); }
.strip-ghost i:nth-child(2) { width: 2px; height: 16px; background: var(--ink-3); }

/* ---------- segment matrix ---------- */
.sm-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; mask-image: none; padding-bottom: 2px; }
.sm-grid {
  display: grid; gap: 3px;
  grid-template-columns: minmax(150px, 1.3fr) repeat(var(--sm-cols), minmax(84px, 1fr));
  min-width: calc(150px + var(--sm-cols) * 87px);
}
.sm-corner, .sm-colhead { font-size: var(--t-xs); color: var(--ink-3); font-weight: 500; padding: 0 4px 6px; align-self: end; }
.sm-colhead { text-align: center; }
.sm-rowhead { position: sticky; left: 0; z-index: 1; display: flex; align-items: center; padding-right: var(--s-3); background: var(--surface); font-size: var(--t-sm); font-weight: 500; line-height: 1.3; }
.sm-cell {
  appearance: none; border: 0; margin: 0; font: inherit; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-height: 66px; padding: 6px 4px; border-radius: 7px;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.sm-cell:hover { transform: translateY(-1px); box-shadow: var(--shadow-2); position: relative; z-index: 2; }
.sm-med { font-family: var(--font-display); font-size: 23px; font-weight: 500; line-height: 1.1; letter-spacing: -.01em; font-variant-numeric: lining-nums tabular-nums; }
.sm-n { font-size: 11px; opacity: .82; font-variant-numeric: tabular-nums; }
.sm-few { font-size: var(--t-sm); font-weight: 600; }
.sm-cell.is-few { color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
.sm-cell.is-few:hover { box-shadow: inset 0 0 0 1px var(--line-strong), var(--shadow-2); }
.sm-cell.is-empty { background: transparent; color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--line); }
.sm-cell.is-empty .sm-few { font-weight: 500; }
.sm-cell.is-unknown { color: var(--ink-3); outline: 1px dashed var(--ink-3); outline-offset: -1px; }
.seq-0 { background: var(--viz-seq-0); color: var(--seq-ink-0); }
.seq-1 { background: var(--viz-seq-1); color: var(--seq-ink-1); }
.seq-2 { background: var(--viz-seq-2); color: var(--seq-ink-2); }
.seq-3 { background: var(--viz-seq-3); color: var(--seq-ink-3); }
.seq-4 { background: var(--viz-seq-4); color: var(--seq-ink-4); }
.sm-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px var(--s-3); font-size: var(--t-xs); color: var(--ink-3); }
.sm-legend b { color: var(--ink-2); font-weight: 600; font-variant-numeric: tabular-nums; }
.sm-ramp { display: inline-flex; gap: 2px; }
.sm-ramp i { display: block; width: 22px; height: 10px; border-radius: 2px; }
.sm-legend .lg { margin-left: var(--s-2); }
.sm-pop { width: 300px; }
.pop-title { font-weight: 600; margin-bottom: var(--s-3); padding-right: var(--s-4); }
.sm-pop p:not(.pop-title) { font-size: var(--t-sm); color: var(--ink-2); }
.pop-dl { margin: 0; display: flex; flex-direction: column; gap: 6px; }
.pop-dl div { display: flex; justify-content: space-between; gap: var(--s-4); align-items: baseline; }
.pop-dl dt { font-size: var(--t-xs); color: var(--ink-3); }
.pop-dl dd { margin: 0; font-size: var(--t-sm); text-align: right; font-variant-numeric: tabular-nums; }
@container (max-width: 620px) { .sm-scroll { mask-image: linear-gradient(to right, #000 calc(100% - 24px), transparent); } }

/* ---------- ranking bars ---------- */
.rank-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rank-head, .rank-row { display: grid; grid-template-columns: 22px minmax(0, 1.1fr) minmax(70px, 1.3fr) minmax(76px, auto); align-items: center; gap: var(--s-3); }
.rank-head { padding: 0 var(--s-2) var(--s-2); font-size: var(--t-xs); color: var(--ink-3); border-bottom: 1px solid var(--line-strong); }
.rank-head span:last-child { text-align: right; }
.rank-row { position: relative; padding: 11px var(--s-2); border-bottom: 1px solid var(--line); transition: background var(--dur) var(--ease); }
.rank-row:hover { background: var(--surface-2); }
.rank-row.is-highlight { background: color-mix(in oklab, var(--viz-highlight) 7%, var(--surface)); box-shadow: inset 3px 0 0 var(--viz-highlight); }
.rank-i { font-size: var(--t-xs); color: var(--ink-3); font-variant-numeric: tabular-nums; text-align: right; }
.rank-name { display: flex; flex-direction: column; min-width: 0; }
.rank-name > a, .rank-name > span { color: var(--ink); font-weight: 600; font-size: var(--t-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-name > a:hover { color: var(--accent); }
.rank-name small { font-size: var(--t-xs); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rank-track { position: relative; height: 12px; border-radius: 0 4px 4px 0; background: color-mix(in oklab, var(--ink) 5%, transparent); }
.rank-bar { position: absolute; inset: 0 auto 0 0; border-radius: 0 4px 4px 0; background: var(--viz-1); }
.rank-row.is-highlight .rank-bar { background: var(--viz-highlight); }
.rank-bar.is-unknown { width: 100%; background-color: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); }
.rank-val { display: flex; flex-direction: column; align-items: flex-end; font-size: var(--t-sm); font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rank-val .muted { font-weight: 500; color: var(--ink-3); }
.rank-share { font-size: var(--t-xs); font-weight: 400; color: var(--ink-3); }
.rank-fold > summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: var(--s-2); padding: var(--s-3) var(--s-2); font-size: var(--t-sm); font-weight: 600; color: var(--accent); border-bottom: 1px solid var(--line); }
.rank-fold > summary::-webkit-details-marker { display: none; }
.rank-fold > summary::before { content: ""; width: 7px; height: 7px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(-45deg); transition: transform var(--dur) var(--ease); margin: 0 6px 0 7px; }
.rank-fold[open] > summary::before { transform: rotate(45deg); }
.rank-fold > summary:hover { background: var(--surface-2); }
@container (max-width: 480px) {
  .rank-head { display: none; }
  .rank-row { grid-template-columns: 18px minmax(0, 1fr) auto; row-gap: 6px; }
  .rank-track { grid-column: 2 / -1; grid-row: 2; height: 8px; }
}

/* ---------- renewal timeline ---------- */
.tl-axis, .tl-lane { display: grid; grid-template-columns: minmax(120px, 190px) minmax(0, 1fr); gap: var(--s-4); }
.tl-label { display: flex; flex-direction: column; justify-content: center; min-width: 0; font-size: var(--t-sm); font-weight: 600; line-height: 1.3; }
.tl-label a { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tl-label a:hover { color: var(--accent); }
.tl-label small { font-size: var(--t-xs); color: var(--ink-3); font-weight: 400; }
.tl-axis-head { justify-content: flex-end; font-size: var(--t-xs); color: var(--ink-3); font-weight: 500; padding-bottom: 4px; }
.tl-months { position: relative; height: 80px; border-left: 2px solid var(--ink-2); }
.tl-month { position: absolute; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: flex-end; }
.tl-bucket { height: 40px; display: flex; flex-direction: column-reverse; align-items: center; gap: 1px; padding: 0 2px; }
.tl-bucket i { display: block; width: 100%; max-width: 16px; border-radius: 3px 3px 0 0; background: color-mix(in oklab, var(--viz-1) 40%, var(--surface)); }
.tl-bucket b { font-size: 10px; font-weight: 600; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 1; }
.tl-mlabel { height: 20px; padding: 4px 0 0 4px; border-left: 1px solid var(--line); font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: visible; }
.tl-mlabel > span { position: relative; background: var(--surface); padding-right: 3px; }
.tl-month.is-year { z-index: 1; }
.tl-month.is-year .tl-mlabel { color: var(--ink); font-weight: 600; border-left-color: var(--ink-3); }
.tl-today-tag { position: absolute; top: 0; left: 0; transform: translateX(calc(-50% - 1px)); padding: 1px 7px; border-radius: 999px; background: var(--ink); color: var(--bg); font-size: 10px; font-weight: 600; line-height: 1.5; z-index: 2; }
.tl-lanes { display: flex; flex-direction: column; }
.tl-lane { border-top: 1px solid var(--line); }
.tl-lane:last-child { border-bottom: 1px solid var(--line); }
.tl-lane:hover { background: color-mix(in oklab, var(--ink) 3%, transparent); }
.tl-track { position: relative; height: 50px; border-left: 2px solid var(--ink-2); }
.tl-track::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--line); }
.tl-dot {
  position: absolute; top: 50%; width: var(--s); height: var(--s); margin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);
  border-radius: 50%; background: color-mix(in oklab, var(--viz-1) 82%, transparent); box-shadow: 0 0 0 2px var(--surface);
  transition: transform var(--dur) var(--ease), background var(--dur) var(--ease);
}
.tl-dot:hover, .tl-dot:focus-visible { z-index: 6; background: var(--viz-1); transform: scale(1.18); text-decoration: none; }
.tl-dot.is-unknown { background: var(--hatch), var(--surface); box-shadow: 0 0 0 2px var(--surface), inset 0 0 0 1.5px var(--ink-3); }
.tl-dot .tip { bottom: calc(100% + 8px); }
.tl-more, .tl-none { position: absolute; top: 50%; transform: translateY(-50%); font-size: 11px; color: var(--ink-3); background: var(--surface); white-space: nowrap; }
.tl-more { right: 0; padding: 1px 8px; border: 1px solid var(--line); border-radius: 999px; }
.tl-none { left: var(--s-3); padding: 0 6px; }
@container (max-width: 640px) {
  .tl-axis, .tl-lane { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .tl-axis-head { display: none; }
  .tl-lane { padding-top: var(--s-2); }
  .tl-label { flex-direction: row; align-items: baseline; justify-content: flex-start; gap: var(--s-2); }
  .tl-month.is-minor:not(.is-year) .tl-mlabel > span { display: none; }
  .tl-today-tag { transform: translateX(-2px); border-radius: 0 999px 999px 0; }
  .tl-months { margin-top: var(--s-3); }
}

/* ---------- tile map ---------- */
.tilemap { display: grid; grid-template-columns: minmax(0, 300px) minmax(160px, 1fr); gap: var(--s-5); align-items: start; }
.tm-grid { display: grid; grid-template-columns: repeat(var(--tm-cols), minmax(0, 1fr)); grid-template-rows: repeat(var(--tm-rows), minmax(0, 1fr)); gap: 2px; width: 100%; }
.tile { position: relative; display: block; border-radius: 3px; min-width: 0; }
.t-has { background: var(--viz-1); }
.t-none-done { background: var(--tile-none); }
.t-none-open { background: var(--hatch), var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-strong); }
.t-not-contacted { background: transparent; box-shadow: inset 0 0 0 1px var(--line-strong); }
.t-highlight { background: var(--viz-highlight); box-shadow: 0 0 0 2px var(--surface), 0 0 0 3.5px var(--viz-highlight); z-index: 2; }
.t-unknown { background: var(--hatch), transparent; outline: 1px dashed var(--ink-3); outline-offset: -1px; }
.tm-grid .tile:hover, .tm-grid .tile:focus-visible { z-index: 10; outline: 2px solid var(--ink); outline-offset: 1px; border-radius: 3px; }
.tm-grid .tile:hover::after, .tm-grid .tile:focus-visible::after {
  content: attr(data-tip); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
  padding: 6px 10px; border-radius: var(--r-1); background: var(--surface); color: var(--ink); border: 1px solid var(--line-strong);
  box-shadow: var(--shadow-2); font-size: var(--t-xs); font-weight: 500; white-space: nowrap; pointer-events: none;
}
.tm-grid .tile.tip-left:hover::after, .tm-grid .tile.tip-left:focus-visible::after { left: auto; right: -4px; transform: none; }
.tm-grid .tile.tip-right:hover::after, .tm-grid .tile.tip-right:focus-visible::after { left: -4px; transform: none; }
.tm-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s-3); }
.tm-legend li { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: var(--s-3); align-items: center; font-size: var(--t-sm); color: var(--ink-2); padding-bottom: var(--s-3); border-bottom: 1px solid var(--line); }
.tm-legend .tile { width: 16px; height: 16px; }
.tm-legend .t-highlight { box-shadow: 0 0 0 1.5px var(--surface), 0 0 0 3px var(--viz-highlight); }
.tm-legend b { font-family: var(--font-display); font-size: var(--t-lg); font-weight: 500; color: var(--ink); font-variant-numeric: lining-nums tabular-nums; }
@container (max-width: 520px) {
  .tilemap { grid-template-columns: minmax(0, 1fr); }
  .tm-grid { max-width: 320px; margin: 0 auto; }
}

/* ---------- segment strip ---------- */
.seg-strip { display: inline-flex; align-items: center; gap: 2px; vertical-align: middle; border-radius: 5px; }
.seg { display: inline-grid; place-items: center; min-width: 27px; height: 20px; padding: 0 4px; border-radius: 3px; font-size: 10px; font-weight: 600; letter-spacing: .01em; background: var(--surface-2); color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--line); font-variant-numeric: tabular-nums; }
.seg.is-on { background: var(--viz-1); color: var(--accent-ink); box-shadow: none; }
.seg-strip.is-unknown { padding: 2px 8px 2px 2px; }
.seg-strip.is-unknown .seg { background: transparent; }
.seg-note { margin-left: 6px; font-size: var(--t-xs); color: var(--ink-2); white-space: nowrap; }

/* ---------- filter bar ---------- */
.filter-bar { display: flex; flex-direction: column; gap: var(--s-3); padding: var(--s-4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-3); box-shadow: var(--shadow-1); }
.fb-fields { display: flex; flex-wrap: wrap; gap: var(--s-3); align-items: flex-end; }
.fb-field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 170px; max-width: 260px; font-size: var(--t-xs); color: var(--ink-3); font-weight: 500; }
.fb-field select {
  appearance: none; -webkit-appearance: none; height: 38px; padding: 0 34px 0 var(--s-3);
  font: inherit; font-size: var(--t-sm); font-weight: 500; color: var(--ink);
  background: var(--surface-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%237b808a' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E") no-repeat right 10px center / 14px;
  border: 1px solid var(--line); border-radius: var(--r-2); cursor: pointer;
}
.fb-field select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent); }
.fb-submit { height: 38px; padding: 0 var(--s-5); border: 0; border-radius: var(--r-2); background: var(--accent); color: var(--accent-ink); font: inherit; font-size: var(--t-sm); font-weight: 600; cursor: pointer; }
.fb-submit:hover { background: color-mix(in oklab, var(--accent) 88%, var(--ink)); }
.fb-status { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-2) var(--s-4); padding-top: var(--s-3); border-top: 1px solid var(--line); }
.fb-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.fb-chip { height: 28px; padding: 0 8px 0 12px; font-size: var(--t-xs); }
.fb-chip b { font-weight: 600; }
.fb-chip svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.fb-chip:hover { text-decoration: none; background: color-mix(in oklab, var(--accent) 18%, var(--surface)); }
.fb-clear { font-size: var(--t-xs); margin-left: var(--s-2); }
.fb-result { font-size: var(--t-sm); font-weight: 500; color: var(--ink-2); font-variant-numeric: tabular-nums; margin-left: auto; }
@media (max-width: 760px) {
  .fb-field { max-width: none; flex-basis: calc(50% - var(--s-3)); }
  .fb-submit { flex: 1 1 100%; }
  .fb-result { margin-left: 0; }
}

/* ---------- empty / uncertain panel ---------- */
.empty-panel { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--s-4); align-items: start; }
.ep-mark { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; }
.ep-mark i { display: block; height: 6px; border-radius: 3px; background: var(--line-strong); }
.ep-mark i:nth-child(1) { width: 30px; } .ep-mark i:nth-child(2) { width: 20px; opacity: .7; } .ep-mark i:nth-child(3) { width: 25px; opacity: .45; }
.ep-title { display: block; font-family: var(--font-display); font-size: var(--t-lg); font-weight: 600; letter-spacing: -.005em; color: var(--ink); margin-bottom: 4px; }
.ep-body p { font-size: var(--t-sm); line-height: 1.5; color: var(--ink-2); max-width: 62ch; }
.ep-body .ep-context { margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px dashed var(--line-strong); font-size: var(--t-xs); }
.ep-near { grid-column: 1 / -1; }

/* ---------- evidence drawer ---------- */
.evidence { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-3); box-shadow: var(--shadow-1); }
.evidence > summary { list-style: none; cursor: pointer; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--s-3); padding: var(--s-4) var(--s-5); border-radius: inherit; }
.evidence > summary::-webkit-details-marker { display: none; }
.evidence > summary::before { content: ""; align-self: center; width: 7px; height: 7px; border-right: 2px solid var(--ink-2); border-bottom: 2px solid var(--ink-2); transform: rotate(-45deg); transition: transform var(--dur) var(--ease); margin-right: 4px; }
.evidence[open] > summary::before { transform: rotate(45deg); }
.evidence > summary:hover { background: var(--surface-2); }
.evidence[open] > summary { border-bottom: 1px solid var(--line); border-radius: var(--r-3) var(--r-3) 0 0; }
.ev-sum { font-weight: 600; }
.ev-hint { font-size: var(--t-xs); color: var(--ink-3); }
.ev-body { padding: var(--s-3) var(--s-5) var(--s-5); overflow-x: auto; }
.ev-body > .meta { margin-bottom: var(--s-2); }
.ev-pdf { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px 3px 7px; border-radius: 999px; border: 1px solid var(--line); font-size: var(--t-xs); font-weight: 600; color: var(--ink-2); }
.ev-pdf:hover { text-decoration: none; color: var(--accent); border-color: color-mix(in oklab, var(--accent) 40%, transparent); }
.ev-pdf svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
.ev-pages { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; margin-top: var(--s-4); }
.ev-pages a, .ev-pages span { display: inline-grid; place-items: center; min-width: 34px; height: 34px; padding: 0 10px; border-radius: var(--r-1); font-size: var(--t-sm); font-variant-numeric: tabular-nums; }
.ev-pages a:hover { background: var(--surface-2); text-decoration: none; }
.ev-pages .is-cur { background: var(--ink); color: var(--bg); font-weight: 600; }
.ev-pages .is-off { color: var(--ink-3); opacity: .55; }
@media (max-width: 760px) {
  .evidence > summary { padding: var(--s-4); }
  .ev-body { padding: var(--s-3) var(--s-3) var(--s-4); }
  .ev-table tr { background: var(--surface-2) !important; }
}

/* ---------- gallery (/studio/_komponenter) ---------- */
.gallery-section .grid-12 > .card { min-width: 0; }
.gallery-stack { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
.gallery-state + .gallery-state { margin-top: var(--s-4); }
.gallery-tag { display: inline-block; margin-bottom: var(--s-3); padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--ink-2); background: var(--surface-2); border: 1px solid var(--line); }
.gallery-row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); padding: var(--s-2) 0; border-bottom: 1px solid var(--line); font-size: var(--t-sm); font-weight: 500; flex-wrap: wrap; }

@media (prefers-reduced-motion: no-preference) {
  .tip { transition: opacity 120ms var(--ease), visibility 120ms; }
}
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
  /* text on a sequential cell, picked per step by contrast (>= 4.2:1) */
  --seq-ink-0: #16181d; --seq-ink-1: #16181d; --seq-ink-2: #16181d; --seq-ink-3: #ffffff; --seq-ink-4: #ffffff;
  --tile-none: #cfc8ba;
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
${COMPONENT_CSS}`;
