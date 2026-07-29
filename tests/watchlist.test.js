import { describe, it, expect } from 'vitest';
import { matchWatchlist } from '../src/watchlist.js';

describe('matchWatchlist', () => {
  it('matches canonical and alias forms of each watchlist vendor', () => {
    expect(matchWatchlist(['Nationalencyklopedin'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['NE'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['ILT Education'])).toEqual(['ILT Education']);
    expect(matchWatchlist(['ILT Inläsningstjänst'])).toEqual(['ILT Education']);
    expect(matchWatchlist(['Inläsningstjänst'])).toEqual(['ILT Education']);
    expect(matchWatchlist(['inlasningstjanst'])).toEqual(['ILT Education']); // OCR / ascii-folded
    expect(matchWatchlist(['Binogi AB'])).toEqual(['Binogi']);
    expect(matchWatchlist(['Magma'])).toEqual(['Radish']);
  });

  it('a delivered product resolves to its company watchlist entry', () => {
    // "Magma" is a product of Radish, which is watchlisted.
    expect(matchWatchlist(['Magma'])).toContain('Radish');
  });

  it('does not false-positive on short aliases inside unrelated names', () => {
    expect(matchWatchlist(['Skillster', 'Skolplus', 'Vinge', 'Dugga'])).toEqual([]);
    expect(matchWatchlist(['Quiculum', 'Teachiq', 'LäroMedia Bokhandel Örebro'])).toEqual([]);
  });

  it('is case-insensitive, deduped, and returns canonical names in WATCHLIST order', () => {
    expect(matchWatchlist(['binogi', 'BINOGI', 'ne', 'NatIonalEncyklopedin']))
      .toEqual(['Nationalencyklopedin', 'Binogi']);
  });

  it('returns empty for no/blank names', () => {
    expect(matchWatchlist([])).toEqual([]);
    expect(matchWatchlist(['', null, undefined])).toEqual([]);
  });
});
