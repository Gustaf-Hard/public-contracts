import { describe, it, expect } from 'vitest';
import { loadKommunStats, sizeBand } from '../src/kommun-stats.js';

const E = (o = {}) => ({
  'Förskola': 100, 'Förskoleklass': 10, '1-3': 30, '4-6': 40, '7-9': 50,
  'Gymnasiet': 200, 'Komvux': 20, ...o,
});
const fixture = () => ({
  fetched_at: '2026-10-26', sources: {}, laar: '2025/26',
  kommuner: {
    '0001': { namn: 'Alfa', folkmangd: 9999, lan: 'X län', kommungrupp: 'G1', peers: ['0002'], elever: E() },
    '0002': { namn: 'Beta', folkmangd: 12000, lan: 'X län', kommungrupp: 'G1', peers: ['0001'], elever: E({ '4-6': null }) },
    '0003': { namn: 'Gamma', folkmangd: 15000, lan: 'Y län', kommungrupp: null, peers: [], elever: E() },
    '0004': { namn: 'Delta', folkmangd: 20000, lan: 'Y län', kommungrupp: null, peers: [], elever: E() },
    '0005': { namn: 'Eps', folkmangd: 200000, lan: 'Y län', kommungrupp: null, peers: [], elever: E() },
  },
});

describe('sizeBand', () => {
  it('has exact boundaries', () => {
    expect(sizeBand(9999)).toBe('<10k');
    expect(sizeBand(10000)).toBe('10-25k');
    expect(sizeBand(24999)).toBe('10-25k');
    expect(sizeBand(25000)).toBe('25-50k');
    expect(sizeBand(50000)).toBe('50-100k');
    expect(sizeBand(99999)).toBe('50-100k');
    expect(sizeBand(100000)).toBe('>100k');
    expect(sizeBand(null)).toBe(null);
  });
});

describe('KommunStats', () => {
  const ks = () => loadKommunStats({ data: fixture() });
  it('get returns the record with sizeBand', () => {
    expect(ks().get('0001')).toMatchObject({ kod: '0001', namn: 'Alfa', sizeBand: '<10k', kommungrupp: 'G1' });
    expect(ks().get('9999')).toBe(null);
  });
  it('peersOf uses kommungrupp members when present', () => {
    expect(ks().peersOf('0001')).toEqual(['0002']);
  });
  it('peersOf falls back to same size band, excluding self', () => {
    expect(ks().peersOf('0003')).toEqual(['0002', '0004']);
    expect(ks().peersOf('0005')).toEqual([]);
  });
  it('eleverIn sums and returns null when a grade is null', () => {
    expect(ks().eleverIn('0001', ['4-6', '7-9'])).toBe(90);
    expect(ks().eleverIn('0002', ['4-6', '7-9'])).toBe(null);
    expect(ks().eleverIn('0002', ['7-9'])).toBe(50);
  });
  it('Introduktionsprogrammet is part of Gymnasiet and counted once', () => {
    expect(ks().eleverIn('0001', ['Introduktionsprogrammet'])).toBe(200);
    expect(ks().eleverIn('0001', ['Gymnasiet', 'Introduktionsprogrammet'])).toBe(200);
  });
  it('Högskola is 0 elever and does not null the sum', () => {
    expect(ks().eleverIn('0001', ['Högskola'])).toBe(0);
    expect(ks().eleverIn('0001', ['7-9', 'Högskola'])).toBe(50);
  });
  it('all() lists every kommun', () => {
    expect(ks().all().map((k) => k.kod)).toEqual(['0001', '0002', '0003', '0004', '0005']);
  });
  it('unknown kommun gives null', () => {
    expect(ks().eleverIn('9999', ['7-9'])).toBe(null);
    expect(ks().peersOf('9999')).toEqual([]);
  });
  // Skolverket masks grundskola cells under 5 pupils; a band with a masked
  // cell is a lower bound, never an exact denominator.
  it('a band with masked cells gives null for that band, the others stay', () => {
    const data = fixture();
    data.kommuner['0001'].grundskola_masked_cells = 1;
    data.kommuner['0001'].grundskola_masked_by_band = { '1-3': 0, '4-6': 1, '7-9': 0 };
    const s = loadKommunStats({ data });
    expect(s.eleverIn('0001', ['4-6'])).toBe(null);
    expect(s.eleverIn('0001', ['1-3', '4-6', '7-9'])).toBe(null);
    expect(s.eleverIn('0001', ['1-3', '7-9'])).toBe(80);
    expect(s.get('0001').maskedBands.has('4-6')).toBe(true);
  });
  it('without per-band data any masked cell nulls every grundskola band, not förskola or gymnasiet', () => {
    const data = fixture();
    data.kommuner['0001'].grundskola_masked_cells = 2;
    const s = loadKommunStats({ data });
    for (const b of ['1-3', '4-6', '7-9']) expect(s.eleverIn('0001', [b])).toBe(null);
    expect(s.eleverIn('0001', ['Förskola', 'Gymnasiet'])).toBe(300);
    data.kommuner['0001'].grundskola_masked_cells = 0;
    expect(loadKommunStats({ data }).eleverIn('0001', ['4-6'])).toBe(40);
  });
});
