// tests/product-intelligence-analytics.test.js
// Pure analytics for the product-intelligence feature
// (2026-07-10-product-intelligence-design.md): the Swedish-unit → canonical
// grade-band mapper and the per-product rollups (line-item pricing + coverage
// matrix aggregation). Everything here is table-driven and offline.
import { describe, it, expect } from 'vitest';
import {
  GRADE_LEVELS,
  MUNICIPAL_GRADE_LEVELS,
  mapUnitToGradeLevels,
} from '../src/vendor-analytics.js';

describe('grade schema constants', () => {
  it('exposes the canonical 9-level schema in fixed order', () => {
    expect(GRADE_LEVELS).toEqual([
      'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9',
      'Gymnasiet', 'Komvux', 'Introduktionsprogrammet', 'Högskola',
    ]);
  });

  it('municipal levels are the 9 minus Högskola (kommuner rarely operate one)', () => {
    expect(MUNICIPAL_GRADE_LEVELS).toEqual(GRADE_LEVELS.slice(0, 8));
  });
});

describe('mapUnitToGradeLevels — table tests over real unit phrases', () => {
  const m = mapUnitToGradeLevels;

  it('grundskola → the three compulsory-school bands', () => {
    expect(m('Alla kommunala grundskolor')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('Alla kommunala grundskolor (3 810)')).toEqual(['1-3', '4-6', '7-9']);
  });

  it('förskola → Förskola (the Polyglutt case)', () => {
    expect(m('Alla kommunala förskolor (1 683)')).toEqual(['Förskola']);
    expect(m('förskolan')).toEqual(['Förskola']);
  });

  it('förskoleklass → Förskoleklass, never Förskola', () => {
    expect(m('förskoleklass')).toEqual(['Förskoleklass']);
    expect(m('elever i förskoleklassen')).toEqual(['Förskoleklass']);
  });

  it('gymnasieskola / gymnasiet / gymnasium → Gymnasiet', () => {
    expect(m('gymnasieskolor (120)')).toEqual(['Gymnasiet']);
    expect(m('gymnasiet')).toEqual(['Gymnasiet']);
    expect(m('kommunalt gymnasium')).toEqual(['Gymnasiet']);
  });

  it('vuxenutbildning / Komvux / SFI → Komvux', () => {
    expect(m('vuxenutbildningar (270)')).toEqual(['Komvux']);
    expect(m('Komvux')).toEqual(['Komvux']);
    expect(m('SFI (svenska för invandrare)')).toEqual(['Komvux']);
  });

  it('introduktionsprogram / IM-program → Introduktionsprogrammet', () => {
    expect(m('introduktionsprogrammen')).toEqual(['Introduktionsprogrammet']);
    expect(m('IM-program')).toEqual(['Introduktionsprogrammet']);
  });

  it('högskola → Högskola', () => {
    expect(m('högskolan')).toEqual(['Högskola']);
  });

  // Anpassad skola / särskola folds into the matching age bands (spec §2).
  it('bare anpassad skola / särskola folds into all four age bands', () => {
    expect(m('anpassad skola (44)')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
    expect(m('särskolan')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
  });

  it('qualified anpassad skola folds into only its own age bands', () => {
    expect(m('anpassad grundskola')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('grundsärskolan')).toEqual(['1-3', '4-6', '7-9']);
    expect(m('gymnasiesärskolan')).toEqual(['Gymnasiet']);
    expect(m('anpassad gymnasieskola')).toEqual(['Gymnasiet']);
  });

  it('the full Ale enhets-list maps with anpassad skola folded (no new band)', () => {
    expect(m('Alla kommunala grundskolor (3 810), gymnasieskolor (120), vuxenutbildningar (270), anpassad skola (44)'))
      .toEqual(['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux']);
  });

  // F-3 style ranges.
  it('F-3 → Förskoleklass + 1-3', () => {
    expect(m('F-3')).toEqual(['Förskoleklass', '1-3']);
  });

  it('åk 4-6 → only the 4-6 band', () => {
    expect(m('åk 4-6')).toEqual(['4-6']);
  });

  it('a range spanning band boundaries touches every intersected band: åk 2-5', () => {
    expect(m('åk 2-5')).toEqual(['1-3', '4-6']);
  });

  it('F-9 → Förskoleklass + all compulsory bands', () => {
    expect(m('F-9')).toEqual(['Förskoleklass', '1-3', '4-6', '7-9']);
  });

  it('F-Gy (the Skola24 shape) → Förskoleklass through Gymnasiet', () => {
    expect(m('alla kommunala skolor åk F-Gy')).toEqual(['Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet']);
  });

  // Whole municipality.
  it('whole-municipality phrases expand to all municipal levels (not Högskola)', () => {
    expect(m('hela kommunen')).toEqual([...MUNICIPAL_GRADE_LEVELS]);
    expect(m('samtliga skolformer')).toEqual([...MUNICIPAL_GRADE_LEVELS]);
  });

  it('unknown text, empty and null map to nothing (honest, not a guess)', () => {
    expect(m('IT-avdelningen')).toEqual([]);
    expect(m('')).toEqual([]);
    expect(m(null)).toEqual([]);
    expect(m(undefined)).toEqual([]);
  });

  it('result is deduped and in canonical order regardless of phrase order', () => {
    expect(m('gymnasieskolor och grundskolor')).toEqual(['1-3', '4-6', '7-9', 'Gymnasiet']);
    expect(m('vuxenutbildning samt förskola')).toEqual(['Förskola', 'Komvux']);
  });
});
