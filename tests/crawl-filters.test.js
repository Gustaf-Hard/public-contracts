import { describe, it, expect } from 'vitest';
import { isPersonalEmail, isValidEmail } from '../src/crawl.js';

describe('isValidEmail', () => {
  it('accepts standard addresses', () => {
    expect(isValidEmail('registrator@kommun.se')).toBe(true);
    expect(isValidEmail('barn.utbildning@kommun.se')).toBe(true);
  });
  it('rejects garbled TLDs', () => {
    expect(isValidEmail('kontakt@kommun.setelefon')).toBe(false);
    expect(isValidEmail('info@kommun.se.Du')).toBe(false);
  });
  it('rejects leading-zero local parts', () => {
    expect(isValidEmail('00kommunen@kommun.se')).toBe(false);
  });
  it('rejects malformed strings', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
  });
});

describe('isPersonalEmail', () => {
  it('flags firstname.lastname patterns', () => {
    expect(isPersonalEmail('anna.svensson@kommun.se')).toBe(true);
    expect(isPersonalEmail('per-erik.larsson@kommun.se')).toBe(true);
  });
  it('does not flag functional addresses', () => {
    expect(isPersonalEmail('registrator@kommun.se')).toBe(false);
    expect(isPersonalEmail('registrator.bun@kommun.se')).toBe(false);
    expect(isPersonalEmail('it.support@kommun.se')).toBe(false);
    expect(isPersonalEmail('barn.utbildning@kommun.se')).toBe(false);
    expect(isPersonalEmail('kontaktcenter@kommun.se')).toBe(false);
  });
  it('does not flag single-component locals', () => {
    expect(isPersonalEmail('bun@kommun.se')).toBe(false);
  });
});
