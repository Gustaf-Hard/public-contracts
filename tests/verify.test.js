import { describe, it, expect, vi } from 'vitest';
import { isValidEmailSyntax, buildReviewReport, verifyAll } from '../src/verify.js';

describe('isValidEmailSyntax', () => {
  it('accepts standard addresses', () => {
    expect(isValidEmailSyntax('registrator@kommun.se')).toBe(true);
  });
  it('rejects malformed strings', () => {
    expect(isValidEmailSyntax('not-an-email')).toBe(false);
    expect(isValidEmailSyntax('a@b')).toBe(false);
    expect(isValidEmailSyntax('@kommun.se')).toBe(false);
  });
});

describe('buildReviewReport', () => {
  it('lists low and medium rows but not high', () => {
    const records = [
      { kommun_kod: '1', kommun_namn: 'A', confidence: 'high', contacts: [] },
      { kommun_kod: '2', kommun_namn: 'B', confidence: 'medium', contacts: [{ email: 'x@b.se', source_url: 'https://b.se/x', role: 'central' }] },
      { kommun_kod: '3', kommun_namn: 'C', confidence: 'low', contacts: [] },
    ];
    const report = buildReviewReport(records);
    expect(report).toContain('B (medium)');
    expect(report).toContain('C (low)');
    expect(report).not.toContain('A (high)');
    expect(report).toContain('https://b.se/x');
  });
});

describe('verifyAll', () => {
  it('flags contacts whose email syntax is invalid', async () => {
    const records = [
      {
        kommun_kod: '1', kommun_namn: 'A', confidence: 'high',
        contacts: [
          { email: 'good@a.se', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' },
          { email: 'bad-email', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' },
        ],
      },
    ];
    const result = await verifyAll(records, { checkMx: async () => true });
    expect(result.invalidSyntax).toHaveLength(1);
    expect(result.invalidSyntax[0].email).toBe('bad-email');
  });

  it('flags domains with no MX record', async () => {
    const records = [
      {
        kommun_kod: '1', kommun_namn: 'A', confidence: 'high',
        contacts: [{ email: 'r@no-mx.example', role: 'central', source_url: '', forvaltning_namn: null, found_via: 'pattern_match' }],
      },
    ];
    const result = await verifyAll(records, { checkMx: async () => false });
    expect(result.missingMx).toHaveLength(1);
    expect(result.missingMx[0].domain).toBe('no-mx.example');
  });
});
