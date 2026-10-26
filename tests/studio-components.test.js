import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import { distribution } from '../src/studio-data.js';
import {
  entityHeader, kpiTile, segmentStrip, filterBar, emptyPanel, evidenceDrawer,
} from '../src/studio/components.js';
import {
  stripPlot, segmentMatrix, rankingBars, renewalTimeline, tileMap, sparkline,
} from '../src/studio/charts.js';

// Hand-written fixture data only (the repo is public).
const EVIL = '<script>alert("x")</script>"\'';
const count = (html, needle) => html.split(needle).length - 1;

function dist(values, kods) {
  const d = distribution(values);
  return {
    ...d,
    values: d.suppressed ? [] : values
      .map((v, i) => ({ kommun_kod: kods ? kods[i] : String(1000 + i), kr_per_elev: v }))
      .sort((a, b) => a.kr_per_elev - b.kr_per_elev),
  };
}

function noRawEvil(html) {
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('alert("x")');
}

describe('stripPlot', () => {
  it('hides dots and median below MIN_N and says why', () => {
    const html = stripPlot({ dist: dist([100, 200, 300, 400]), unit: 'kr/elev', label: 'Pris per elev' });
    expect(html).toContain('för få kommuner (n = 4)');
    expect(html).not.toContain('<circle');
    expect(html).toContain('hatch');
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('draws one dot per value and a median tick at n = 5', () => {
    const html = stripPlot({ dist: dist([100, 200, 300, 400, 500]), unit: 'kr/elev', label: 'Pris per elev' });
    expect(count(html, '<circle')).toBe(5);
    expect(html).toContain('strip-median');
    expect(html).toContain('300 kr/elev');
    expect(html).not.toContain('för få avtal');
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('highlights the viewed kommun', () => {
    const html = stripPlot({
      dist: dist([100, 200, 300, 400, 500], ['1', '2', '3', '4', '5']),
      highlightKod: '4', highlightLabel: 'Ale', unit: 'kr/elev', label: 'Pris',
    });
    expect(count(html, 'is-highlight')).toBeGreaterThanOrEqual(1);
    expect(html).toContain('Ale');
  });

  it('escapes the label and kommun names, also inside SVG titles', () => {
    const html = stripPlot({
      dist: dist([100, 200, 300, 400, 500]), unit: 'kr/elev', label: EVIL,
      nameOf: () => EVIL, highlightKod: '1000', highlightLabel: EVIL,
    });
    noRawEvil(html);
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the label in the suppressed state', () => {
    noRawEvil(stripPlot({ dist: dist([1]), unit: 'kr/elev', label: EVIL }));
  });

  it('says one dot per kommun by default and uses the caller dotNoun', () => {
    expect(stripPlot({ dist: dist([100, 200, 300, 400, 500]), label: 'x' })).toContain('en punkt per kommun');
    expect(stripPlot({ dist: dist([100, 200, 300, 400, 500]), label: 'x', dotNoun: 'avtal' })).toContain('en punkt per avtal');
  });

  it('counts the finite values it can show when the dist claims more', () => {
    const d = { ...dist([100, 200, 300, 400, 500, 600]), n: 6 };
    d.values = d.values.slice(0, 4).concat([{ kommun_kod: 'x', kr_per_elev: null }]);
    const html = stripPlot({ dist: d, label: 'x' });
    expect(html).toContain('för få kommuner (n = 4)');
    expect(html).not.toContain('<circle');
  });

  it('handles a constant distribution without NaN', () => {
    const html = stripPlot({ dist: dist([250, 250, 250, 250, 250]), unit: 'kr/elev', label: 'x' });
    expect(count(html, '<circle')).toBe(5);
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});

describe('rankingBars', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    label: i === 0 ? EVIL : `Förlag ${i}`, href: `/studio/leverantor/f${i}`,
    value: 1000 - i * 90, valueLabel: `${10 - i} mkr`, share: (10 - i) / 55, sub: i === 0 ? EVIL : `${i} kommuner`,
  }));

  it('escapes labels and subs', () => {
    const html = rankingBars({ items });
    noRawEvil(html);
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows max 7 rows and folds the rest into Övriga N', () => {
    const html = rankingBars({ items, max: 7, noun: 'leverantörer' });
    expect(html).toContain('Övriga 3 leverantörer');
    expect(count(html, 'class="rank-row')).toBe(10);
    expect(html.indexOf('<details')).toBeGreaterThan(html.indexOf('Förlag 6'));
  });

  it('marks the highlighted row and renders unknown values as hatched, not zero', () => {
    const html = rankingBars({
      items: [{ label: 'A', value: 10, valueLabel: '10 kr', share: 0.5 }, { label: 'B', value: null, valueLabel: null, share: null }],
      highlight: 'B',
    });
    expect(html).toContain('is-highlight');
    expect(html).toContain('okänt');
    expect(html).toContain('hatch');
  });
});

describe('tileMap', () => {
  const tiles = { cols: 18, rows: 17, tiles: {} };
  for (let i = 0; i < 290; i++) tiles.tiles[String(1000 + i)] = { x: i % 18, y: Math.floor(i / 18) };

  it('renders all 290 tiles', () => {
    const html = tileMap({ tiles, classOf: () => 'has', titleOf: (k) => `Kommun ${k}`, legend: [] });
    expect(count(html, 'class="tile ')).toBe(290);
  });

  it('escapes tile titles', () => {
    const html = tileMap({ tiles, classOf: () => 'none-open', titleOf: () => EVIL, legend: [{ cls: 'none-open', label: EVIL }] });
    noRawEvil(html);
  });

  it('throws on an invalid class or a throwing classOf/titleOf instead of claiming not-contacted', () => {
    expect(() => tileMap({ tiles, classOf: (k) => (k === '1001' ? 'bogus' : 'has'), titleOf: (k) => k, legend: [] })).toThrow(/invalid class/);
    expect(() => tileMap({ tiles, classOf: () => { throw new Error('boom'); }, titleOf: (k) => k })).toThrow(/boom/);
    expect(() => tileMap({ tiles, classOf: () => 'has', titleOf: () => { throw new Error('title boom'); } })).toThrow(/title boom/);
    expect(() => tileMap({ tiles, classOf: () => 'has', legend: [{ cls: 'nope', label: 'x' }] })).toThrow(/invalid class/);
  });

  it('defaults to a neutral unknown class with its own legend entry, never not-contacted', () => {
    const html = tileMap({ tiles, legend: [{ cls: 'has', label: 'Har avtal' }] });
    expect(html).not.toContain('t-not-contacted');
    expect((html.match(/class="tile t-unknown[^"]*" tabindex="0"/g) || []).length).toBe(290);
    expect(html).toContain('Status okänd');
    expect(html).toContain('290');
  });

  it('counts legend entries, marks the highlight, and makes tiles focusable', () => {
    const html = tileMap({
      tiles,
      classOf: (k) => (k === '1000' ? 'highlight' : 'has'),
      titleOf: (k) => `Kommun ${k}`,
      legend: [{ cls: 'has', label: 'Har avtal' }, { cls: 'highlight', label: 'Vald' }],
    });
    expect(html).toContain('t-highlight');
    expect(html).toContain('289');
    expect(count(html, 'tabindex="0"')).toBe(290);
    expect(html).not.toContain('Status okänd');
  });
});

describe('kpiTile', () => {
  it('unknown state is hatched with the reason, never 0', () => {
    const html = kpiTile({ label: 'Pris per elev', value: null, basis: 'inga avtal med känt elevantal', state: 'unknown', reason: 'Inget avtal anger antal elever' });
    expect(html).toContain('hatch');
    expect(html).toContain('Inget avtal anger antal elever');
    expect(html).toContain('okänt');
    expect(html).not.toMatch(/>0</);
  });

  it('partial state carries the basis and escapes text', () => {
    const html = kpiTile({ label: EVIL, value: '30,9', unit: 'mkr/år', basis: 'känd för 12 av 40 avtal', state: 'partial', spark: [1, 2, 3, 2, 4] });
    noRawEvil(html);
    expect(html).toContain('is-partial');
    expect(html).toContain('känd för 12 av 40 avtal');
    expect(html).toContain('<svg');
  });
});

describe('other components', () => {
  it('segmentMatrix hatches suppressed cells, escapes and opens popovers', () => {
    const rows = [{ key: 'a', label: EVIL }, { key: 'b', label: 'Större städer' }];
    const cols = [{ key: '1-3', label: '1-3' }, { key: '4-6', label: '4-6' }];
    const html = segmentMatrix({
      rows, cols, id: 'm1',
      cell: (r, c) => (r.key === 'a' && c.key === '1-3' ? dist([1, 2]) : dist([100, 120, 140, 160, 180 + (c.key === '4-6' ? 50 : 0)])),
    });
    noRawEvil(html);
    expect(html).not.toContain('lg-unknown'); // no unknown cells, no unknown legend row
    expect(html).toContain('för få');
    expect(html).toContain('n = 2');
    expect(html).toContain('popovertarget="m1-');
    expect(html).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('segmentMatrix lets cell errors propagate and marks unknown cells distinct from n = 0', () => {
    const rows = [{ key: 'a', label: 'A' }];
    const cols = [{ key: '1', label: '1' }, { key: '2', label: '2' }, { key: '3', label: '3' }];
    expect(() => segmentMatrix({ rows, cols, cell: () => { throw new Error('cell boom'); } })).toThrow(/cell boom/);
    const html = segmentMatrix({
      rows, cols, id: 'u',
      cell: (r, c) => (c.key === '1' ? null : c.key === '2' ? { n: 7, suppressed: false, median: null } : distribution([])),
    });
    expect(count(html, 'is-unknown')).toBe(2);
    expect(html).toContain('okänt');
    expect(html).toContain('lg-unknown'); // the legend names the unknown swatch
    expect(html).not.toContain('n = 7');
    expect(count(html, 'inga avtal')).toBe(1);
  });

  it('renewalTimeline throws on an invalid today', () => {
    expect(() => renewalTimeline({ today: 'igår', lanes: [] })).toThrow(/today/);
    expect(() => renewalTimeline({ lanes: [] })).toThrow(/today/);
  });

  it('evidenceDrawer total defaults to the rows given', () => {
    const ev = evidenceDrawer({ rows: [{ kommun: 'A' }, { kommun: 'B' }] });
    expect(ev).toContain('Visa underlag (2 avtal)');
    expect(ev).toContain('Visar 1 till 2 av 2');
  });

  it('renewalTimeline places items inside the window and escapes titles', () => {
    const html = renewalTimeline({
      today: '2026-10-26', months: 24,
      lanes: [{ label: EVIL, items: [{ date: '2027-01-31', value: 400000, title: EVIL }, { date: '2027-06-30', value: null, title: 'Okänt värde' }, { date: '2030-01-01', value: 1, title: 'Senare' }] }],
    });
    noRawEvil(html);
    expect(html).toContain('idag');
    expect(count(html, 'class="tl-dot')).toBe(2);
    expect(html).toContain('is-unknown');
    expect(html).toContain('1 senare');
  });

  it('segmentStrip fills covered segments and hatches unknown', () => {
    const html = segmentStrip(['1-3', '4-6']);
    expect(count(html, 'is-on')).toBe(2);
    expect(segmentStrip([])).toContain('hatch');
  });

  it('filterBar is a GET form with removable chips', () => {
    const html = filterBar({
      action: '/studio/fornyelser',
      fields: [{ name: 'kategori', label: 'Kategori', options: [{ value: 'laromedel', label: 'Läromedel' }, { value: EVIL, label: EVIL }], value: 'laromedel' }],
      resultLine: '412 avtal',
    });
    expect(html).toContain('method="get"');
    expect(html).toContain('selected');
    expect(html).toContain('Läromedel');
    noRawEvil(html);
  });

  it('filterBar folds secondary fields and opens the fold when one is set', () => {
    const f = (value) => [
      { name: 'kategori', label: 'Kategori', options: [{ value: 'a', label: 'A' }], value: '' },
      { name: 'lan', label: 'Län', secondary: true, options: [{ value: 'x', label: 'X' }], value },
    ];
    const closed = filterBar({ action: '/studio/utforska', fields: f('') });
    expect(closed).toContain('<details class="fb-more">');
    expect(closed.indexOf('fb-lan')).toBeGreaterThan(closed.indexOf('fb-more'));
    expect(closed).not.toContain('valda');
    const open = filterBar({ action: '/studio/utforska', fields: f('x') });
    expect(open).toContain('<details class="fb-more" open>');
    expect(open).toContain('(1 valda)');
    expect(filterBar({ action: '/x', fields: f('').slice(0, 1) })).not.toContain('fb-more');
  });

  it('emptyPanel, entityHeader, evidenceDrawer escape text', () => {
    noRawEvil(emptyPanel({ title: EVIL, text: EVIL, context: EVIL }));
    noRawEvil(entityHeader({ kicker: EVIL, title: EVIL, answer: EVIL, facts: [{ label: EVIL, value: EVIL, sub: EVIL }] }));
    const ev = evidenceDrawer({
      rows: [{ kommun: EVIL, period: '2025-08-01 till 2027-07-31', value: '120 tkr', model: EVIL, pdfHref: '/studio/avtal/1.pdf' }],
      total: 120, page: 2, pageHref: (p) => `/studio/x?sida=${p}`,
    });
    noRawEvil(ev);
    expect(ev).toContain('Visa underlag (120 avtal)');
    expect(ev).toContain('sida=3');
    expect(ev).toContain('sida=1');
    expect(ev).toContain(' open');
  });

  it('sparkline has no NaN for flat or short series', () => {
    expect(sparkline([3, 3, 3])).not.toMatch(/NaN/);
    expect(sparkline([5])).not.toMatch(/NaN/);
    expect(sparkline([])).toBe('');
  });

  it('no component emits em or en dashes', () => {
    const all = [
      stripPlot({ dist: dist([100, 200, 300, 400, 500]), unit: 'kr/elev', label: 'x' }),
      stripPlot({ dist: dist([1]), unit: 'kr/elev', label: 'x' }),
      kpiTile({ label: 'x', value: null, basis: 'b', state: 'unknown', reason: 'r' }),
      segmentStrip([]),
      emptyPanel({ title: 't', text: 'x' }),
    ].join('');
    expect(all).not.toMatch(/[–—]/);
  });
});

describe('gallery route', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'studio-comp-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });
  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('GET /studio/_komponenter returns 200 with every component', async () => {
    const STATS = loadKommunStats({ data: { kommuner: { '1440': { namn: 'Ale', lan: 'Västra Götalands län', folkmangd: 32000, elever: {} } } } });
    const app = createDashboardApp({
      db, municipalitiesLoader: () => [], env: {}, slackClient: null, gmailClient: {},
      studioDeps: { statsLoader: () => STATS, now: () => new Date('2026-10-26T09:00:00Z') },
    });
    const { status, text } = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => {
        fetch(`http://127.0.0.1:${server.address().port}/studio/_komponenter`).then(async (r) => {
          const t = await r.text();
          server.close(() => resolve({ status: r.status, text: t }));
        }).catch((e) => server.close(() => reject(e)));
      });
    });
    expect(status).toBe(200);
    for (const cls of ['entity-header', 'kpi', 'strip', 'sm-grid', 'rank', 'tl-', 'tilemap', 'seg-strip', 'filter-bar', 'panel-unknown', 'evidence']) {
      expect(text).toContain(cls);
    }
    expect(text).toContain('för få kommuner (n = 4)');
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    expect(text).not.toMatch(/[–—]/);
  });
});
