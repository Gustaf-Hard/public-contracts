import { describe, it, expect } from 'vitest';
import {
  resolveActiveKommuner,
  isClockSkewAllowed,
  getEffectiveNow,
  isRefreshAllowed,
} from '../src/pilot-config.js';

const overrides = {
  active_pilot_kommun_kods: ['9999'],
  rehearsal_kommuner: [
    {
      kommun_kod: '9999',
      kommun_namn: 'Testkommun',
      lan: 'Testlän',
      folkmangd: 0,
      contacts: [
        { role: 'central', email: 'gustaf.hard@gmail.com' },
        { role: 'utbildning', email: 'gustaf.hard@gmail.com' },
      ],
    },
  ],
  live_kommun_kods: ['2418', '1438', '0509', '2404', '0560'],
};

const liveMunicipalities = [
  {
    kommun_kod: '2418',
    kommun_namn: 'Malå',
    lan: 'Västerbottens län',
    folkmangd: 2902,
    contacts: [
      { role: 'central', email: 'kommun@mala.se', forvaltning_namn: null, source_url: '', found_via: 'pattern_match' },
      { role: 'utbildning', email: 'bun@mala.se', forvaltning_namn: 'BUN', source_url: '', found_via: 'pattern_match' },
    ],
  },
];

describe('resolveActiveKommuner', () => {
  it('returns the rehearsal kommun when 9999 is active', () => {
    const result = resolveActiveKommuner(overrides, liveMunicipalities);
    expect(result).toHaveLength(1);
    expect(result[0].kommun_kod).toBe('9999');
    expect(result[0].contacts).toHaveLength(2);
  });

  it('returns live komuner when their kods are active', () => {
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    const result = resolveActiveKommuner(flipped, liveMunicipalities);
    expect(result).toHaveLength(1);
    expect(result[0].kommun_namn).toBe('Malå');
    expect(result[0].contacts.find((c) => c.role === 'central').email).toBe('kommun@mala.se');
  });

  it('throws when an active kod cannot be resolved from either source', () => {
    const bad = { ...overrides, active_pilot_kommun_kods: ['7777'] };
    expect(() => resolveActiveKommuner(bad, liveMunicipalities)).toThrow(/7777/);
  });

  it('throws when both rehearsal and live kods are mixed', () => {
    const mixed = { ...overrides, active_pilot_kommun_kods: ['9999', '2418'] };
    expect(() => resolveActiveKommuner(mixed, liveMunicipalities)).toThrow(/mix/i);
  });
});

describe('isClockSkewAllowed', () => {
  it('allows skew when active is exactly ["9999"]', () => {
    expect(isClockSkewAllowed(overrides)).toBe(true);
  });

  it('rejects skew when any live kod is active', () => {
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    expect(isClockSkewAllowed(flipped)).toBe(false);
  });

  it('rejects skew when no kods are active', () => {
    const empty = { ...overrides, active_pilot_kommun_kods: [] };
    expect(isClockSkewAllowed(empty)).toBe(false);
  });
});

describe('getEffectiveNow', () => {
  it('returns a Date offset by PILOT_CLOCK_OFFSET_DAYS when skew is allowed', () => {
    const base = new Date('2026-05-19T10:00:00Z');
    const now = getEffectiveNow({ env: { PILOT_CLOCK_OFFSET_DAYS: '7' }, overrides, baseNow: base });
    const diffDays = (now.getTime() - base.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBe(7);
  });

  it('ignores PILOT_CLOCK_OFFSET_DAYS when skew is not allowed', () => {
    const base = new Date('2026-05-19T10:00:00Z');
    const flipped = { ...overrides, active_pilot_kommun_kods: ['2418'] };
    const now = getEffectiveNow({ env: { PILOT_CLOCK_OFFSET_DAYS: '7' }, overrides: flipped, baseNow: base });
    expect(now.getTime()).toBe(base.getTime());
  });
});

describe('isRefreshAllowed (perpetual-refresh pilot gating)', () => {
  it('allows kommuner in refresh_pilot_kommun_kods', () => {
    const o = { refresh_pilot_kommun_kods: ['1489', '1980'] };
    expect(isRefreshAllowed(o, '1489')).toBe(true);
    expect(isRefreshAllowed(o, '1980')).toBe(true);
  });
  it('rejects kommuner not on the allowlist', () => {
    const o = { refresh_pilot_kommun_kods: ['1489'] };
    expect(isRefreshAllowed(o, '1980')).toBe(false);
    expect(isRefreshAllowed(o, '0000')).toBe(false);
  });
  it('rejects everything when the allowlist is missing or empty', () => {
    expect(isRefreshAllowed({}, '1489')).toBe(false);
    expect(isRefreshAllowed({ refresh_pilot_kommun_kods: [] }, '1489')).toBe(false);
    expect(isRefreshAllowed(null, '1489')).toBe(false);
  });
});
