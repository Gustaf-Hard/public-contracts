import { describe, it, expect } from 'vitest';
import { computeNextReviewDate } from '../src/contract-lifecycle.js';

const now = new Date('2026-07-09T12:00:00Z');

describe('computeNextReviewDate — archetypes from real live strings', () => {
  it('plain fixed-term → period_end', () => {
    // Teachiq-style row without an extension option: just an end date.
    const c = { period_end: '2026-06-30', auto_renews: false };
    expect(computeNextReviewDate(c, now)).toBe('2026-06-30');
  });

  it('auto-renewing (Tieto: "förlängs automatiskt i ettårsperioder om det inte sägs upp") → day after last_cancellation_date', () => {
    const c = {
      period_end: '2026-12-31',
      auto_renews: true,
      renewal_term: '1 år',
      last_cancellation_date: '2026-09-30',
    };
    // review just AFTER uppsägningsdagen
    expect(computeNextReviewDate(c, now)).toBe('2026-10-01');
  });

  it('auto-renewing at end of month rolls into next month correctly', () => {
    const c = { period_end: '2027-01-31', auto_renews: true, last_cancellation_date: '2026-12-31' };
    expect(computeNextReviewDate(c, now)).toBe('2027-01-01');
  });

  it('auto-renewing WITHOUT a cancellation date → falls back to period_end', () => {
    const c = { period_end: '2026-12-31', auto_renews: true, last_cancellation_date: null };
    expect(computeNextReviewDate(c, now)).toBe('2026-12-31');
  });

  it('fixed + extension option (Teachiq: "möjlighet till förlängning upp till 2027-06-14") → extension_option_until', () => {
    const c = { period_end: '2025-06-14', auto_renews: false, extension_option_until: '2027-06-14' };
    expect(computeNextReviewDate(c, now)).toBe('2027-06-14');
  });

  it('Skola24 "möjlighet till två års förlängning" resolved to a concrete extension_option_until', () => {
    // The analyser resolves "två års förlängning" from a 2026-06-30 end to 2028-06-30.
    const c = { period_end: '2026-06-30', auto_renews: false, extension_option_until: '2028-06-30' };
    expect(computeNextReviewDate(c, now)).toBe('2028-06-30');
  });

  it('auto_renews takes precedence over an extension_option_until', () => {
    const c = {
      period_end: '2026-12-31', auto_renews: true, last_cancellation_date: '2026-09-30',
      extension_option_until: '2028-01-01',
    };
    expect(computeNextReviewDate(c, now)).toBe('2026-10-01');
  });
});

describe('computeNextReviewDate — null/edge/error handling', () => {
  it('no usable date at all → null (not armed)', () => {
    expect(computeNextReviewDate({ period_end: null, auto_renews: false }, now)).toBeNull();
    expect(computeNextReviewDate({}, now)).toBeNull();
    expect(computeNextReviewDate(null, now)).toBeNull();
  });

  it('invalid/garbage dates degrade to period_end', () => {
    const c = { period_end: '2026-06-30', auto_renews: true, last_cancellation_date: 'okänt' };
    expect(computeNextReviewDate(c, now)).toBe('2026-06-30');
  });

  it('garbage extension_option_until degrades to period_end', () => {
    const c = { period_end: '2026-06-30', auto_renews: false, extension_option_until: 'vid behov' };
    expect(computeNextReviewDate(c, now)).toBe('2026-06-30');
  });

  it('garbage last_cancellation_date AND no period_end → null', () => {
    const c = { period_end: null, auto_renews: true, last_cancellation_date: 'nope' };
    expect(computeNextReviewDate(c, now)).toBeNull();
  });

  it('requires an explicit now', () => {
    expect(() => computeNextReviewDate({ period_end: '2026-06-30' })).toThrow(/now/);
  });
});
