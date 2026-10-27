import { describe, it, expect } from 'vitest';
import { elevCoverage, COVERAGE_GRADES } from '../src/studio-data.js';
import { floorText, elevCoverageText, renewalTileProps } from '../src/studio/pages/common.js';
import { loadKommunStats } from '../src/kommun-stats.js';

// Hand-written fixtures only (the repo is public): made-up kommun codes and
// elev counts.
const E = (o = {}) => ({ 'Förskola': 100, '1-3': 300, '4-6': 300, '7-9': 400, Gymnasiet: 999, ...o });
const stats = loadKommunStats({
  data: {
    kommuner: {
      '9001': { namn: 'Ettby', elever: E() }, // 1 000 i grundskolan
      '9002': { namn: 'Tvåby', elever: E({ '1-3': 600, '4-6': 600, '7-9': 800 }) }, // 2 000
      '9003': { namn: 'Treby', elever: E() }, // 1 000
      '9004': { namn: 'Fyrby', elever: E({ '4-6': null }) }, // okänt
      '9005': { namn: 'Femby', elever: E({ '1-3': 2000, '4-6': 2000, '7-9': 2000 }) }, // 6 000
    },
  },
});

const fact = (kod, category = 'laromedel', o = {}) => ({ active: true, superseded: false, kommun_kod: kod, category, ...o });

describe('elevCoverage', () => {
  it('counts grundskola åk 1-9 only', () => {
    expect([...COVERAGE_GRADES]).toEqual(['1-3', '4-6', '7-9']);
  });

  it('is the elever of kommuner with an active avtal over all elever, never counting gymnasiet', () => {
    const c = elevCoverage([fact('9001'), fact('9002'), fact('9002')], stats);
    // 3 000 of 10 000 known (Fyrby unknown, out of both sides)
    expect(c.elever_covered).toBe(3000);
    expect(c.elever_total).toBe(10000);
    expect(c.share).toBeCloseTo(0.3);
    expect(c.kommuner).toBe(2);
    expect(c.kommuner_unknown).toBe(0);
    expect(c.total_unknown).toBe(1);
  });

  it('a covered kommun with unknown elever is unknown, not zero, and is reported', () => {
    const c = elevCoverage([fact('9001'), fact('9004')], stats);
    expect(c.elever_covered).toBe(1000);
    expect(c.elever_total).toBe(10000);
    expect(c.kommuner).toBe(2);
    expect(c.kommuner_unknown).toBe(1);
  });

  it('a kommun missing from the stats is unknown too', () => {
    const c = elevCoverage([fact('9001'), fact('9999')], stats);
    expect(c.kommuner_unknown).toBe(1);
    expect(c.elever_covered).toBe(1000);
  });

  it('ignores expired and superseded avtal', () => {
    const c = elevCoverage([fact('9001'), fact('9005', 'laromedel', { active: false }), fact('9002', 'laromedel', { superseded: true })], stats);
    expect(c.elever_covered).toBe(1000);
    expect(c.kommuner).toBe(1);
  });

  it('per category counts the kommuner with an active avtal in that category', () => {
    const facts = [fact('9001', 'laromedel'), fact('9005', 'larplattform'), fact('9002', null)];
    expect(elevCoverage(facts, stats, { category: 'larplattform' }).elever_covered).toBe(6000);
    expect(elevCoverage(facts, stats, { category: 'laromedel' }).share).toBeCloseTo(0.1);
    // unknown category is its own bucket
    expect(elevCoverage(facts, stats, { category: 'okand' }).elever_covered).toBe(2000);
  });

  it('is null without stats, and share null without known elever', () => {
    expect(elevCoverage([fact('9001')], null)).toBeNull();
    const empty = loadKommunStats({ data: { kommuner: { '9004': { elever: E({ '4-6': null }) } } } });
    expect(elevCoverage([fact('9004')], empty).share).toBeNull();
  });
});

describe('floor and coverage copy', () => {
  it('a sum is "minst X per år i underlaget", an unknown sum says so', () => {
    expect(floorText(119_400_000)).toBe('minst 119 mkr per år i underlaget');
    expect(floorText(null)).toBe('värde okänt');
  });

  it('coverage names the school form and the basis', () => {
    const c = elevCoverage([fact('9001'), fact('9002')], stats);
    expect(elevCoverageText(c)).toBe('Kommunerna med avtal i underlaget har 30 % av eleverna i grundskolan');
    expect(elevCoverageText(c, { who: 'Kommunerna med avtal i läromedel' })).toBe('Kommunerna med avtal i läromedel har 30 % av eleverna i grundskolan');
  });

  it('coverage says when a kommun with avtal has unknown elever', () => {
    const c = elevCoverage([fact('9001'), fact('9004')], stats);
    expect(elevCoverageText(c)).toBe('Kommunerna med avtal i underlaget har 10 % av eleverna i grundskolan, 1 kommun utan känt elevantal räknas inte');
  });

  it('unknown coverage is "okänd", never 0 %', () => {
    expect(elevCoverageText(null)).toBe('Elevtäckningen är okänd');
  });
});

describe('renewal KPI tile', () => {
  it('a partly known renewal sum is a floor', () => {
    const avtal = [{ next_renewal: '2027-01-31' }, { next_renewal: '2027-02-28' }];
    const buckets = [{ month: '2027-01', n: 1, n_known: 1, value_known_sek: 50000 }, { month: '2027-02', n: 1, n_known: 0, value_known_sek: 0 }];
    const t = renewalTileProps({ avtal, buckets, today: '2026-10-27' });
    expect(t.basis).toBe('2 av 2 med känt slutdatum, minst 50 tkr/år i underlaget, känt för 1 av 2');
  });
});
