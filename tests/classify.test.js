import { describe, it, expect } from 'vitest';
import { classifyRole } from '../src/classify.js';

const ctx = (overrides = {}) => ({
  url: '',
  pageTitle: '',
  headings: [],
  email: '',
  ...overrides,
});

describe('classifyRole', () => {
  it('classifies utbildning from URL slug', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/forvaltningar/utbildningsforvaltningen' }))).toBe('utbildning');
  });

  it('classifies utbildning from heading "Barn- och utbildningsförvaltningen"', () => {
    expect(classifyRole(ctx({ headings: ['Barn- och utbildningsförvaltningen'] }))).toBe('utbildning');
  });

  it('classifies utbildning from "skolförvaltning"', () => {
    expect(classifyRole(ctx({ pageTitle: 'Skolförvaltningen i kommunen' }))).toBe('utbildning');
  });

  it('classifies gymnasie separately from generic utbildning', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/gymnasieforvaltningen' }))).toBe('gymnasie');
  });

  it('classifies vuxenutbildning', () => {
    expect(classifyRole(ctx({ headings: ['Vuxenutbildning'] }))).toBe('vuxenutbildning');
  });

  it('classifies it_digitalisering', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/it-forvaltningen' }))).toBe('it_digitalisering');
    expect(classifyRole(ctx({ headings: ['Digitaliseringsförvaltningen'] }))).toBe('it_digitalisering');
  });

  it('classifies upphandling', () => {
    expect(classifyRole(ctx({ headings: ['Upphandlingsförvaltningen'] }))).toBe('upphandling');
  });

  it('classifies central when email matches registrator pattern on a top-level page', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/kontakt', email: 'registrator@k.se' }))).toBe('central');
    expect(classifyRole(ctx({ url: 'https://k.se/', email: 'kommun@k.se' }))).toBe('central');
  });

  it('returns "other" when nothing matches', () => {
    expect(classifyRole(ctx({ url: 'https://k.se/kultur', email: 'kultur@k.se' }))).toBe('other');
  });

  it('prefers förvaltning context over central email pattern', () => {
    expect(
      classifyRole(
        ctx({
          url: 'https://k.se/utbildningsforvaltningen/kontakt',
          email: 'registrator@k.se',
        })
      )
    ).toBe('utbildning');
  });
});
