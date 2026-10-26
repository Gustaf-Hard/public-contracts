import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { createDashboardApp } from '../src/dashboard.js';
import { loadKommunStats } from '../src/kommun-stats.js';
import {
  fmtKr, fmtKrCompact, fmtInt, fmtPct, basisLine, monthsUntil, basisSentence,
} from '../src/studio/format.js';
import { studioLayout, STUDIO_NAV } from '../src/studio/layout.js';
import { studioCss } from '../src/studio/css.js';

// Hand-written fixture data only (the repo is public).
const STATS = loadKommunStats({
  data: {
    kommuner: {
      '1440': { namn: 'Ale', lan: 'Västra Götalands län', folkmangd: 32000, elever: {} },
      '0560': { namn: 'Boxholm', lan: 'Östergötlands län', folkmangd: 5400, elever: {} },
    },
  },
});

let tmp, db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'studio-shell-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedContract({ kommun_kod = '1440', kommun_namn = 'Ale', vendor = 'Testförlaget AB', value = 120000 } = {}) {
  const convId = db.createConversation({
    kommun_kod, kommun_namn, role: 'central',
    contact_email: 'registrator@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`,
    direction: 'inbound', from_email: 'registrator@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Se bifogat', classification: null,
    classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const attId = db.recordAttachment({
    message_id: msgId, filename: 'avtal.pdf', saved_path: `data/contracts/${kommun_kod}/avtal.pdf`,
    mime_type: 'application/pdf', size_bytes: 1000,
  });
  const v = db.upsertVendor(vendor);
  return db.recordContract({
    attachment_id: attId, vendor_id: v.id, annual_value_sek: value,
    period_start: '2025-08-01', period_end: '2027-07-31', is_contract: 1,
    summary: 'Läromedel – licens', confidence: 0.9,
  });
}

function app(extra = {}) {
  return createDashboardApp({
    db,
    municipalitiesLoader: () => [],
    env: {},
    slackClient: null,
    gmailClient: {},
    studioDeps: {
      statsLoader: () => STATS,
      now: () => new Date('2026-10-26T09:00:00Z'),
      ...extra,
    },
  });
}

async function get(a, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const server = a.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' }).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text, headers: r.headers }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

describe('studio format helpers', () => {
  it('formats compact kronor in Swedish', () => {
    expect(fmtKrCompact(30_900_000)).toBe('30,9 mkr');
    expect(fmtKrCompact(412_000)).toBe('412 tkr');
    expect(fmtKrCompact(1_250_000_000)).toBe('1,3 mdkr');
    expect(fmtKrCompact(640)).toBe('640 kr');
    expect(fmtKrCompact(250_000_000)).toBe('250 mkr');
  });

  it('returns okänt for null, undefined and non-finite numbers', () => {
    for (const fn of [fmtKr, fmtKrCompact, fmtInt, fmtPct]) {
      expect(fn(null)).toBe('okänt');
      expect(fn(undefined)).toBe('okänt');
      expect(fn(NaN)).toBe('okänt');
      expect(fn(Infinity)).toBe('okänt');
    }
    expect(basisLine(null, 63, 'avtal')).toBe('okänt');
    expect(monthsUntil(null, '2026-10-26')).toBe('okänt');
  });

  it('never formats unknown as zero', () => {
    expect(fmtKr(0)).toBe('0 kr');
    expect(fmtKr(null)).not.toBe('0 kr');
  });

  it('groups thousands with a no-break space', () => {
    expect(fmtKr(1_234_567)).toBe('1 234 567 kr');
    expect(fmtInt(1676)).toBe('1 676');
  });

  it('formats percent and basis lines', () => {
    expect(fmtPct(0.423)).toBe('42 %');
    expect(fmtPct(0.042)).toBe('4,2 %');
    expect(basisLine(41, 63, 'avtal')).toBe('känd för 41 av 63 avtal');
  });

  it('formats months until a date relative to today', () => {
    expect(monthsUntil('2026-12-31', '2026-10-26')).toBe('om 2 mån');
    expect(monthsUntil('2026-11-10', '2026-10-26')).toBe('inom en månad');
    expect(monthsUntil('2027-10-26', '2026-10-26')).toBe('om 12 mån');
    expect(monthsUntil('2026-07-01', '2026-10-26')).toBe('för 3 mån sedan');
    expect(monthsUntil('inte-ett-datum', '2026-10-26')).toBe('okänt');
  });

  it('builds the footer basis sentence', () => {
    const s = basisSentence({ active: 1520, collected: 1676, kommuner_with_avtal: 185, updated: '2026-10-26' });
    expect(s).toBe('1 520 aktiva avtal (1 676 insamlade) från 185 kommuner · uppdaterad 2026-10-26');
  });
});

describe('studioLayout', () => {
  it('renders nav, search and footer on a full page', () => {
    const html = studioLayout({ title: 'Marknad', body: '<p>x</p>', currentPath: '/studio', basis: 'B-SENTENCE' });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<nav');
    for (const { label, href } of STUDIO_NAV) {
      expect(html).toContain(label);
      expect(html).toContain(`href="${href}"`);
    }
    expect(STUDIO_NAV.map((n) => n.label)).toEqual(['Marknad', 'Kategorier', 'Leverantörer', 'Kommuner', 'Förnyelser', 'Utforska']);
    expect(html).toMatch(/<form[^>]*action="\/studio\/sok"[^>]*method="get"/i);
    expect(html).toContain('<input name="q" list="studio-search"');
    expect(html).toContain('<datalist id="studio-search"');
    expect(html).toContain('B-SENTENCE');
    expect(html).toContain('href="/studio/om"');
    expect(html).toContain('aria-current="page"');
  });

  it('returns the body only for partials', () => {
    const html = studioLayout({ title: 'X', body: '<p>kropp</p>', currentPath: '/studio', partial: true, basis: 'B' });
    expect(html).not.toContain('<html');
    expect(html).not.toContain('<nav');
    expect(html).toContain('<p>kropp</p>');
    // the basis line is part of the swapped pane, never left stale outside it
    expect(html).toContain('data-basis');
    expect(html).toContain('data-page-title="X · Mediagraf Studio"');
  });

  it('escapes the title', () => {
    const html = studioLayout({ title: '<script>x</script>', body: '', currentPath: '/studio', basis: '' });
    expect(html).not.toContain('<script>x</script>');
  });

  it('css carries both dark scopes, reduced-motion gating and the phone tab bar', () => {
    expect(studioCss).toContain('prefers-color-scheme: dark');
    expect(studioCss).toContain(':root:not([data-theme="light"])');
    expect(studioCss).toContain(':root[data-theme="dark"]');
    expect(studioCss).toContain('prefers-reduced-motion: no-preference');
    expect(studioCss).toContain('max-width: 760px');
    expect(studioCss).toContain('.hatch');
    expect(studioCss).toContain('font-display: swap');
    expect(studioCss).toContain('container-type: inline-size');
    expect(studioCss).toContain('--bg: #f6f4ef');
    expect(studioCss).toContain('--accent: #0e6e6a');
  });
});

describe('studio routes', () => {
  it('GET /studio renders the studio shell without back-office chrome', async () => {
    seedContract();
    const r = await get(app(), '/studio');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<nav');
    for (const l of ['Marknad', 'Kategorier', 'Leverantörer', 'Kommuner', 'Förnyelser', 'Utforska']) {
      expect(r.text).toContain(l);
    }
    expect(r.text).not.toContain('Eskaleringar');
    expect(r.text).not.toContain('data-health-modal');
    expect(r.text).not.toContain('heartbeat');
    expect(r.text).toContain('prefers-color-scheme: dark');
    expect(r.text).toContain('data-studio');
    expect(r.text).toContain('uppdaterad 2026-10-26');
  });

  it('studio copy contains no em-dash or en-dash characters', async () => {
    seedContract();
    seedContract({ kommun_kod: '0560', kommun_namn: 'Boxholm', vendor: 'Annan – Leverantör', value: null });
    const full = await get(app(), '/studio');
    const part = await get(app(), '/studio?partial=1');
    for (const t of [full.text, part.text]) {
      expect(t).not.toMatch(/[–—]/);
    }
  });

  it('GET /studio?partial=1 and X-Partial return the body only', async () => {
    const a = await get(app(), '/studio?partial=1');
    expect(a.status).toBe(200);
    expect(a.text).not.toContain('<html');
    expect(a.text).not.toContain('<nav');
    const b = await get(app(), '/studio', { 'X-Partial': '1' });
    expect(b.text).not.toContain('<html');
  });

  it('studio pages never link into the back office', async () => {
    seedContract();
    const r = await get(app(), '/studio');
    const hrefs = [...r.text.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^(\/studio|\/fonts\/|#|data:image\/svg)/);
    expect(r.text).not.toContain('/app.js" defer></script><script'); // sanity: one app.js
  });

  it('back office links to the studio', async () => {
    const r = await get(app(), '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('href="/studio"');
  });

  it('memoises studio data per day and refreshes after the TTL', async () => {
    seedContract();
    let t = new Date('2026-10-26T09:00:00Z');
    const spy = vi.spyOn(db, 'listContractFacts');
    const a = app({ now: () => t });
    await get(a, '/studio');
    await get(a, '/studio?partial=1');
    expect(spy).toHaveBeenCalledTimes(1);
    t = new Date('2026-10-26T09:30:00Z');
    await get(a, '/studio');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('renders with an empty database (no avtal yet)', async () => {
    const r = await get(app(), '/studio');
    expect(r.status).toBe(200);
    expect(r.text).toContain('0 aktiva avtal');
  });

  it('ships self-hosted OFL fonts', () => {
    for (const f of ['public/fonts/fraunces/fraunces-var-latin.woff2', 'public/fonts/inter/inter-var-latin.woff2',
      'public/fonts/fraunces/OFL.txt', 'public/fonts/inter/OFL.txt']) {
      expect(existsSync(f), f).toBe(true);
    }
    const total = statSync('public/fonts/fraunces/fraunces-var-latin.woff2').size
      + statSync('public/fonts/inter/inter-var-latin.woff2').size;
    expect(total).toBeLessThan(400 * 1024);
    expect(studioCss).toContain('/fonts/fraunces/fraunces-var-latin.woff2');
    expect(studioCss).toContain('/fonts/inter/inter-var-latin.woff2');
  });
});
