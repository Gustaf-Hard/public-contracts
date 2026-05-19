import { describe, it, expect } from 'vitest';
import { computeConfidence } from '../src/confidence.js';

describe('computeConfidence', () => {
  it('is "low" with no contacts', () => {
    expect(computeConfidence([])).toBe('low');
  });

  it('is "high" with central + utbildning', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'utbildning', email: 'b@k.se' },
      ])
    ).toBe('high');
  });

  it('treats gymnasie as part of utbildning family for "high"', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'gymnasie', email: 'g@k.se' },
      ])
    ).toBe('high');
  });

  it('treats vuxenutbildning as part of utbildning family for "high"', () => {
    expect(
      computeConfidence([
        { role: 'central', email: 'a@k.se' },
        { role: 'vuxenutbildning', email: 'v@k.se' },
      ])
    ).toBe('high');
  });

  it('is "medium" with only central', () => {
    expect(computeConfidence([{ role: 'central', email: 'a@k.se' }])).toBe('medium');
  });

  it('is "medium" with only utbildning-family', () => {
    expect(computeConfidence([{ role: 'utbildning', email: 'u@k.se' }])).toBe('medium');
  });

  it('is "low" with only "other"', () => {
    expect(computeConfidence([{ role: 'other', email: 'x@k.se' }])).toBe('low');
  });
});
