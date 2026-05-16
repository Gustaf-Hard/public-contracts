import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKommunListPage, parseKommunInfobox } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseKommunListPage', () => {
  it('extracts kommunkod, namn, län, and article URL for each row', () => {
    const list = parseKommunListPage(fixture('wikipedia-kommuner.html'));
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      kommun_kod: '0114',
      kommun_namn: 'Upplands Väsby',
      lan: 'Stockholms län',
      wikipedia_url: 'https://sv.wikipedia.org/wiki/Upplands_V%C3%A4sby_kommun',
    });
    expect(list[1].kommun_kod).toBe('1980');
    expect(list[1].kommun_namn).toBe('Västerås');
  });
});

describe('parseKommunInfobox', () => {
  it('extracts official website and org.nr from infobox', () => {
    const info = parseKommunInfobox(fixture('wikipedia-kommun-page.html'));
    expect(info.webbplats).toBe('https://www.vasteras.se');
    expect(info.org_nr).toBe('212000-2080');
  });

  it('returns nulls when fields are missing', () => {
    const info = parseKommunInfobox('<html><body></body></html>');
    expect(info.webbplats).toBeNull();
    expect(info.org_nr).toBeNull();
  });
});
