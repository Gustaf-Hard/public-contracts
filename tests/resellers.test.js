// tests/resellers.test.js
// Framework-agreement / reseller channels. A kommun that procures via one of
// these can HAVE a product without us ever seeing a direct contract for it —
// the contract sits with the channel (Adda ramavtal, Atea licenspartner,
// Skolon marketplace, Läromedia bokhandel). Matching mirrors the watchlist:
// whole-word on an ascii-folded, punctuation-stripped form of the name.
import { describe, it, expect } from 'vitest';
import { RESELLERS, matchResellers, resellerBySlug } from '../src/resellers.js';

describe('RESELLERS seed set', () => {
  it('covers the four known channels', () => {
    expect(RESELLERS.map((r) => r.canonical)).toEqual(['Adda', 'Skolon', 'Atea', 'Läromedia']);
  });

  it('every entry has at least one alias', () => {
    for (const r of RESELLERS) expect(r.aliases.length).toBeGreaterThan(0);
  });
});

describe('matchResellers — whole-word, ascii-folded, alias-driven', () => {
  it('matches Atea inside a fuller legal name', () => {
    expect(matchResellers(['Atea Sverige AB'])).toEqual(['Atea']);
  });

  it('matches Skolon', () => {
    expect(matchResellers(['Skolon AB'])).toEqual(['Skolon']);
  });

  it('matches Adda under its own name and its old SKL Kommentus names', () => {
    expect(matchResellers(['Adda Inköpscentral AB'])).toEqual(['Adda']);
    expect(matchResellers(['SKL Kommentus Inköpscentral'])).toEqual(['Adda']);
    expect(matchResellers(['Kommentus'])).toEqual(['Adda']);
    expect(matchResellers(['SKLKommentus'])).toEqual(['Adda']);
  });

  it('matches Läromedia ascii-folded in either direction', () => {
    expect(matchResellers(['Läromedia Bokhandel Örebro AB'])).toEqual(['Läromedia']);
    expect(matchResellers(['LaroMedia AB'])).toEqual(['Läromedia']);
  });

  it('is whole-word: look-alike substrings never fire', () => {
    expect(matchResellers(['Kateater AB'])).toEqual([]);       // contains "atea"
    expect(matchResellers(['Skolonline i Sverige'])).toEqual([]); // contains "skolon"
    expect(matchResellers(['Addax Energi'])).toEqual([]);      // contains "adda"
  });

  it('a non-reseller vendor is not matched', () => {
    expect(matchResellers(['ILT Education', 'Nationalencyklopedin'])).toEqual([]);
  });

  it('dedupes and keeps RESELLERS order over several names', () => {
    expect(matchResellers(['Skolon AB', 'Atea Sverige AB', 'Skolon Marketplace']))
      .toEqual(['Skolon', 'Atea']);
  });

  it('empty / absent input → no matches', () => {
    expect(matchResellers([])).toEqual([]);
    expect(matchResellers()).toEqual([]);
    expect(matchResellers([null, ''])).toEqual([]);
  });
});

describe('reseller slugs + resellerBySlug', () => {
  it('every entry has a slug and slugs are unique', () => {
    const slugs = RESELLERS.map((r) => r.slug);
    for (const s of slugs) expect(typeof s).toBe('string');
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('slugs are the slugified canonicals', () => {
    expect(RESELLERS.map((r) => r.slug)).toEqual(['adda', 'skolon', 'atea', 'laromedia']);
  });

  it('resellerBySlug resolves a known slug to its entry', () => {
    expect(resellerBySlug('adda').canonical).toBe('Adda');
    expect(resellerBySlug('laromedia').canonical).toBe('Läromedia');
  });

  it('resellerBySlug returns null for unknown / blank slugs', () => {
    expect(resellerBySlug('nope')).toBeNull();
    expect(resellerBySlug('')).toBeNull();
    expect(resellerBySlug(null)).toBeNull();
    expect(resellerBySlug()).toBeNull();
  });
});
