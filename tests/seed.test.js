import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseKommunListPage, parseKommunInfobox } from '../src/seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseKommunListPage', () => {
  it('strips genitive "s" from kommun names while keeping legitimate -ås/-näs/-fors names', () => {
    const html = `
    <table class="wikitable">
      <tr><th>Kod</th><th>Kommun</th><th>Centralort</th><th>Län</th></tr>
      <tr><td>0180</td><td><a href="/wiki/x">Stockholms kommun</a></td><td>Stockholm</td><td>Stockholms län</td></tr>
      <tr><td>0980</td><td><a href="/wiki/x">Gotlands kommun</a></td><td>Visby</td><td>Gotlands län</td></tr>
      <tr><td>1980</td><td><a href="/wiki/x">Västerås kommun</a></td><td>Västerås</td><td>Västmanlands län</td></tr>
      <tr><td>2580</td><td><a href="/wiki/x">Bollnäs kommun</a></td><td>Bollnäs</td><td>Gävleborgs län</td></tr>
      <tr><td>1782</td><td><a href="/wiki/x">Munkfors kommun</a></td><td>Munkfors</td><td>Värmlands län</td></tr>
      <tr><td>1764</td><td><a href="/wiki/x">Grums kommun</a></td><td>Grums</td><td>Värmlands län</td></tr>
      <tr><td>1881</td><td><a href="/wiki/x">Rättviks kommun</a></td><td>Rättvik</td><td>Dalarnas län</td></tr>
      <tr><td>1761</td><td><a href="/wiki/x">Hammarö kommun</a></td><td>Hammarö</td><td>Värmlands län</td></tr>
    </table>
  `;
    const list = parseKommunListPage(html);
    const byKod = Object.fromEntries(list.map((r) => [r.kommun_kod, r.kommun_namn]));
    // Genitive forms → corrected
    expect(byKod['0180']).toBe('Stockholm');
    expect(byKod['0980']).toBe('Gotland');
    expect(byKod['1881']).toBe('Rättvik');
    // Legitimate -ås/-näs/-fors → unchanged
    expect(byKod['1980']).toBe('Västerås');
    expect(byKod['2580']).toBe('Bollnäs');
    expect(byKod['1782']).toBe('Munkfors');
    expect(byKod['1764']).toBe('Grums');
    // Name not ending in 's' → unchanged
    expect(byKod['1761']).toBe('Hammarö');
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
