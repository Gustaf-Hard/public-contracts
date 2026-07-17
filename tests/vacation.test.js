import { describe, it, expect } from 'vitest';
import {
  isInVacation,
  vacationDaysBetween,
  defaultVacationConfig,
  resolveVacationConfig,
} from '../src/vacation.js';

const cfg = defaultVacationConfig();

describe('isInVacation window boundaries', () => {
  it('is false the day before the window opens (14 Jun)', () => {
    expect(isInVacation('2026-06-14', cfg)).toBe(false);
  });
  it('is true on the first day of the window (15 Jun)', () => {
    expect(isInVacation('2026-06-15', cfg)).toBe(true);
  });
  it('is true mid-window (1 Jul)', () => {
    expect(isInVacation('2026-07-01', cfg)).toBe(true);
  });
  it('is true on the last day of the window (30 Jul)', () => {
    expect(isInVacation('2026-07-30', cfg)).toBe(true);
  });
  it('is false the day after the window closes (31 Jul)', () => {
    expect(isInVacation('2026-07-31', cfg)).toBe(false);
  });
  it('is false well outside the window (winter)', () => {
    expect(isInVacation('2026-01-10', cfg)).toBe(false);
  });
  it('applies year-agnostically to a different year', () => {
    expect(isInVacation('2030-07-01', cfg)).toBe(true);
    expect(isInVacation('2030-08-01', cfg)).toBe(false);
  });
  it('returns false for a non-iso / short string', () => {
    expect(isInVacation('', cfg)).toBe(false);
    expect(isInVacation('2026-06', cfg)).toBe(false);
  });
});

describe('vacationDaysBetween', () => {
  it('counts vacation days within one summer (half-open)', () => {
    // 15 Jun .. 30 Jul inclusive = 46 days. Span [15 Jun, 31 Jul) includes
    // exactly those 46 vacation days.
    expect(vacationDaysBetween('2026-06-15', '2026-07-31', cfg)).toBe(46);
  });
  it('is half-open: excludes the now endpoint', () => {
    // [15 Jun, 16 Jun) -> only 15 Jun counts = 1
    expect(vacationDaysBetween('2026-06-15', '2026-06-16', cfg)).toBe(1);
    // [30 Jul, 31 Jul) -> only 30 Jul counts = 1
    expect(vacationDaysBetween('2026-07-30', '2026-07-31', cfg)).toBe(1);
    // [30 Jul, 30 Jul) -> empty span = 0
    expect(vacationDaysBetween('2026-07-30', '2026-07-30', cfg)).toBe(0);
  });
  it('counts only the overlap when the span partially covers the window', () => {
    // May .. 20 Jun: vacation days are 15..19 Jun = 5 (20 Jun excluded, half-open)
    expect(vacationDaysBetween('2026-05-01', '2026-06-20', cfg)).toBe(5);
  });
  it('counts both summers across a multi-year span', () => {
    // May 2026 .. Aug 2027 covers two full 46-day windows.
    expect(vacationDaysBetween('2026-05-01', '2027-08-15', cfg)).toBe(92);
  });
  it('is zero when the span misses the window entirely', () => {
    expect(vacationDaysBetween('2026-08-01', '2026-12-01', cfg)).toBe(0);
  });
  it('is zero for an empty or reversed span', () => {
    expect(vacationDaysBetween('2026-07-01', '2026-07-01', cfg)).toBe(0);
    expect(vacationDaysBetween('2026-07-10', '2026-07-01', cfg)).toBe(0);
  });
});

describe('resolveVacationConfig', () => {
  it('returns the default window when overrides are absent', () => {
    expect(resolveVacationConfig(undefined)).toEqual({ enabled: true, start: '06-15', end: '07-30' });
    expect(resolveVacationConfig({})).toEqual({ enabled: true, start: '06-15', end: '07-30' });
  });
  it('merges a partial override with the default', () => {
    expect(resolveVacationConfig({ vacation: { end: '08-05' } })).toEqual({
      enabled: true, start: '06-15', end: '08-05',
    });
  });
  it('honors a full custom window', () => {
    expect(resolveVacationConfig({ vacation: { enabled: true, start: '06-20', end: '08-10' } })).toEqual({
      enabled: true, start: '06-20', end: '08-10',
    });
  });
});

describe('enabled: false disables the feature', () => {
  const off = { enabled: false, start: '06-15', end: '07-30' };
  it('isInVacation is always false', () => {
    expect(isInVacation('2026-07-01', off)).toBe(false);
    expect(isInVacation('2026-06-15', off)).toBe(false);
  });
  it('vacationDaysBetween is always 0', () => {
    expect(vacationDaysBetween('2026-06-15', '2026-07-31', off)).toBe(0);
  });
});
