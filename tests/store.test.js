import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMunicipalities,
  saveMunicipalities,
  writeSummaryCsv,
  writeContactsCsv,
} from '../src/store.js';

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'store-'));
  return () => rmSync(tmp, { recursive: true, force: true });
});

const sample = [
  {
    kommun_kod: '1980',
    kommun_namn: 'Västerås',
    lan: 'Västmanlands län',
    org_nr: '212000-2080',
    webbplats: 'https://www.vasteras.se',
    diarium_url: null,
    contacts: [
      {
        email: 'registrator@vasteras.se',
        role: 'central',
        forvaltning_namn: null,
        source_url: 'https://www.vasteras.se/kontakt',
        found_via: 'pattern_match',
      },
      {
        email: 'bun@vasteras.se',
        role: 'utbildning',
        forvaltning_namn: 'Barn- och utbildningsförvaltningen',
        source_url: 'https://www.vasteras.se/bun',
        found_via: 'contact_page',
      },
    ],
    confidence: 'high',
    notes: null,
    verified_at: '2026-05-16',
  },
];

describe('store', () => {
  it('roundtrips JSON', () => {
    const path = join(tmp, 'm.json');
    saveMunicipalities(path, sample);
    expect(loadMunicipalities(path)).toEqual(sample);
  });

  it('returns [] when JSON file missing', () => {
    expect(loadMunicipalities(join(tmp, 'missing.json'))).toEqual([]);
  });

  it('writes summary CSV with one row per kommun', async () => {
    const path = join(tmp, 'summary.csv');
    await writeSummaryCsv(path, sample);
    const csv = readFileSync(path, 'utf8');
    expect(csv).toMatch(/kommun_kod,kommun_namn/);
    expect(csv).toMatch(/1980,Västerås/);
    expect(csv).toMatch(/,high,/);
    expect(csv).toMatch(/,2,/); // contact_count
  });

  it('writes long-format contacts CSV with one row per contact', async () => {
    const path = join(tmp, 'contacts.csv');
    await writeContactsCsv(path, sample);
    const csv = readFileSync(path, 'utf8');
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(3); // header + 2 contacts
    expect(csv).toMatch(/registrator@vasteras\.se/);
    expect(csv).toMatch(/bun@vasteras\.se/);
  });
});
