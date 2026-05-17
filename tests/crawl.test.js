import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { findCandidateLinks, crawlKommun } from '../src/crawl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('findCandidateLinks', () => {
  it('keeps links matching kontakt / förvaltning / nämnd / diarium / registrator', () => {
    const links = findCandidateLinks(fx('kommun-home.html'), 'https://vasteras.se');
    const paths = links.map((u) => new URL(u).pathname);
    expect(paths).toContain('/kontakt');
    expect(paths).toContain('/forvaltningar/utbildningsforvaltningen');
    expect(paths).toContain('/forvaltningar/it-forvaltningen');
    expect(paths).not.toContain('/nyheter/sommar');
  });

  it('returns absolute URLs', () => {
    const links = findCandidateLinks(fx('kommun-home.html'), 'https://vasteras.se');
    for (const u of links) expect(u).toMatch(/^https?:\/\//);
  });
});

describe('crawlKommun', () => {
  it('collects contacts with roles from multiple pages', async () => {
    const pages = {
      'https://vasteras.se/': fx('kommun-home.html'),
      'https://vasteras.se/kontakt': fx('kommun-kontakt.html'),
      'https://vasteras.se/forvaltningar/utbildningsforvaltningen': fx('kommun-bun.html'),
      'https://vasteras.se/forvaltningar/it-forvaltningen':
        '<html><body><h1>IT-förvaltningen</h1><a href="mailto:it@vasteras.se">it</a></body></html>',
    };
    const fakeFetch = async (url) => {
      const html = pages[url];
      if (!html) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => html };
    };

    const seed = {
      kommun_kod: '1980',
      kommun_namn: 'Västerås',
      lan: 'Västmanlands län',
      org_nr: '212000-2080',
      webbplats: 'https://vasteras.se',
    };

    const record = await crawlKommun(seed, { fetch: fakeFetch, today: '2026-05-16' });

    expect(record.kommun_kod).toBe('1980');
    expect(record.contacts.map((c) => c.email).sort()).toEqual(
      ['bun@vasteras.se', 'it@vasteras.se', 'registrator@vasteras.se']
    );
    const byEmail = Object.fromEntries(record.contacts.map((c) => [c.email, c]));
    expect(byEmail['registrator@vasteras.se'].role).toBe('central');
    expect(byEmail['bun@vasteras.se'].role).toBe('utbildning');
    expect(byEmail['it@vasteras.se'].role).toBe('it_digitalisering');
    expect(record.confidence).toBe('high');
    expect(record.verified_at).toBe('2026-05-16');
  });

  it('returns "low" confidence and empty contacts when website is missing', async () => {
    const seed = {
      kommun_kod: '9999',
      kommun_namn: 'Ingenstans',
      lan: 'Län',
      org_nr: null,
      webbplats: null,
    };
    const record = await crawlKommun(seed, { fetch: async () => ({ ok: false, status: 404, text: async () => '' }), today: '2026-05-16' });
    expect(record.contacts).toEqual([]);
    expect(record.confidence).toBe('low');
  });
});
