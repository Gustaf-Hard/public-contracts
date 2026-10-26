import { describe, it, expect } from 'vitest';
import { accumulateGrundskola } from '../scripts/16-fetch-kommun-stats.js';

// Hand-written SIRIS-shaped rows (r2 Q3); no network.
const school = (kod, huvudman, cells) => ({
  skola: {
    'Kommun-kod': kod,
    'Typ av huvudman': huvudman,
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`Elever, årskurs ${i + 1}`, cells[i] ?? '.'])),
  },
});

describe('accumulateGrundskola', () => {
  it('a band no school reports is null, not 0', () => {
    const acc = accumulateGrundskola([
      school('0114', 'Kommunal', ['20', '21', '22', '30', '31', '32']), // no 7-9 cells
    ], new Set(['0114']));
    expect(acc['0114']).toMatchObject({ '1-3': 63, '4-6': 93, '7-9': null, masked: 0 });
  });
  it('sums kommunal schools, skips other huvudmän, counts masked cells per band', () => {
    const acc = accumulateGrundskola([
      school('0114', 'Kommunal', ['10', '10', '10', '10', '10', '10', '10', '10', '..']),
      school('0114', 'Enskild', ['99', '99', '99', '99', '99', '99', '99', '99', '99']),
      school('0114', 'Kommunal', ['0', '0', '0', '5', '5', '5', '5', '5', '5']),
    ], new Set(['0114']));
    expect(acc['0114']).toMatchObject({ '1-3': 30, '4-6': 45, '7-9': 35, masked: 1, maskedByBand: { '1-3': 0, '4-6': 0, '7-9': 1 } });
  });
  it('a band reported as 0 pupils is 0, a kommun outside the code set is skipped', () => {
    const acc = accumulateGrundskola([school('0114', 'Kommunal', ['0', '0', '0']), school('9999', 'Kommunal', ['5'])], new Set(['0114']));
    expect(acc['0114']['1-3']).toBe(0);
    expect(acc['9999']).toBeUndefined();
  });
});
