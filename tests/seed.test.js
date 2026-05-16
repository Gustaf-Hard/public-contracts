import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKommunListPage, parseKommunInfobox } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseKommunListPage', () => {
  it('corrects Swedish genitive kommun names to nominative form', () => {
    const html = `
      <table class="wikitable">
        <tr><th>Kod</th><th>Kommun</th><th>Centralort</th><th>Län</th></tr>
        <tr>
          <td>0180</td>
          <td><a href="/wiki/Stockholms_kommun">Stockholms kommun</a></td>
          <td>Stockholm</td>
          <td>Stockholms län</td>
        </tr>
        <tr>
          <td>0980</td>
          <td><a href="/wiki/Gotlands_kommun">Gotlands kommun</a></td>
          <td>Visby</td>
          <td>Gotlands län</td>
        </tr>
        <tr>
          <td>1980</td>
          <td><a href="/wiki/V%C3%A4ster%C3%A5s_kommun">Västerås kommun</a></td>
          <td>Västerås</td>
          <td>Västmanlands län</td>
        </tr>
      </table>
    `;
    const list = parseKommunListPage(html);
    const byKod = Object.fromEntries(list.map((r) => [r.kommun_kod, r.kommun_namn]));
    expect(byKod['0180']).toBe('Stockholm');
    expect(byKod['0980']).toBe('Gotland');
    expect(byKod['1980']).toBe('Västerås'); // not stripped — already nominative
  });

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
