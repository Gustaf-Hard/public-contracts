import { describe, it, expect } from 'vitest';
import { editDivergence, severity } from '../src/edit-review.js';

// Real edit from the pilot (Arjeplog): the operator replaced the bot's
// vendor-specific follow-up with a broader "do you really have no digital
// läromedel contracts?" question. A genuine major rewrite.
const ARJEPLOG_DRAFT =
  'Hej,\n\nTack för avtalen gällande Quiculum. Jag saknar dock ännu de faktiska avtalshandlingarna för LäroMedia Bokhandel Örebro och Teachiq — kan ni skicka dem?\n\nMed vänliga hälsningar,\nGustaf Hård af Segerstad\ngustaf.hard@gmail.com';
const ARJEPLOG_SENT =
  'Hej,\n\nTack för avtalen. Jag saknar dock ännu de faktiska avtalshandlingarna. Stämmer det att ni inte har avtal med några digitala läromedel på kommunal nivå? Inläsningstjänst, Binogi, Magma, NE eller liknande?\n\nMed vänliga hälsningar,\nGustaf Hård af Segerstad\ngustaf.hard@gmail.com';

describe('editDivergence', () => {
  it('returns 0 for identical strings', () => {
    expect(editDivergence('Hej,\nTack för svaret.', 'Hej,\nTack för svaret.')).toBe(0);
  });

  it('returns 0 when both strings are empty', () => {
    expect(editDivergence('', '')).toBe(0);
  });

  it('returns 1 when exactly one string is empty', () => {
    expect(editDivergence('Hej, tack för svaret.', '')).toBe(1);
    expect(editDivergence('', 'Hej, tack för svaret.')).toBe(1);
  });

  it('approaches 1 for a total rewrite', () => {
    const ratio = editDivergence('aaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbb');
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it('stays small for a minor one-word tweak', () => {
    const draft = 'Hej,\n\nTack för ert svar. Kan ni skicka avtalen som PDF?\n\nMed vänliga hälsningar,\nGustaf';
    const final = 'Hej,\n\nTack för ert snabba svar. Kan ni skicka avtalen som PDF?\n\nMed vänliga hälsningar,\nGustaf';
    const ratio = editDivergence(draft, final);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.15);
  });

  it('classifies the real Arjeplog rewrite as major', () => {
    const ratio = editDivergence(ARJEPLOG_DRAFT, ARJEPLOG_SENT);
    expect(ratio).toBeGreaterThanOrEqual(0.4);
    expect(severity(ratio)).toBe('major');
  });
});

describe('severity', () => {
  it('is trivial below 0.15', () => {
    expect(severity(0)).toBe('trivial');
    expect(severity(0.149)).toBe('trivial');
  });

  it('is moderate from 0.15 up to (not including) 0.4', () => {
    expect(severity(0.15)).toBe('moderate');
    expect(severity(0.399)).toBe('moderate');
  });

  it('is major at 0.4 and above', () => {
    expect(severity(0.4)).toBe('major');
    expect(severity(1)).toBe('major');
  });
});
