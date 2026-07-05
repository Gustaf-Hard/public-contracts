import { describe, it, expect } from 'vitest';
import { matchWatchlist } from '../src/watchlist.js';

describe('matchWatchlist', () => {
  it('matches canonical and alias forms of each watchlist vendor', () => {
    expect(matchWatchlist(['Nationalencyklopedin'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['NE'])).toEqual(['Nationalencyklopedin']);
    expect(matchWatchlist(['ILT Education'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['ILT Inläsningstjänst'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['Inläsningstjänst'])).toEqual(['Inläsningstjänst (ILT)']);
    expect(matchWatchlist(['inlasningstjanst'])).toEqual(['Inläsningstjänst (ILT)']); // OCR / ascii-folded
    expect(matchWatchlist(['Binogi AB'])).toEqual(['Binogi']);
    expect(matchWatchlist(['Magma'])).toEqual(['Magma']);
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
