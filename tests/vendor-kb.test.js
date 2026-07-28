import { describe, it, expect } from 'vitest';
import { resolveCompany, normalizeVendorName, companyBySlug, COMPANIES } from '../src/vendor-kb.js';

describe('normalizeVendorName', () => {
  it('folds Swedish letters, lowercases, collapses punctuation/space', () => {
    expect(normalizeVendorName('  Inläsningstjänst (ILT) ')).toBe('inlasningstjanst ilt');
    expect(normalizeVendorName('Skola 24')).toBe('skola 24');
  });
});

describe('resolveCompany', () => {
  it('resolves a product to its parent company', () => {
    expect(resolveCompany('Magma')).toMatchObject({ canonical: 'Radish', role: 'service', matchedAs: 'product', product: 'Magma' });
    expect(resolveCompany('Matteappen')).toMatchObject({ canonical: 'Radish', matchedAs: 'product' });
  });
  it('resolves a company alias to the company', () => {
    expect(resolveCompany('NE')).toMatchObject({ canonical: 'Nationalencyklopedin', matchedAs: 'company' });
    expect(resolveCompany('ILT Education')).toMatchObject({ canonical: 'ILT Education', matchedAs: 'company' });
  });
  it('tags procurement channels with role=channel', () => {
    expect(resolveCompany('Adda')).toMatchObject({ canonical: 'Adda', role: 'channel' });
    expect(resolveCompany('SKL Kommentus')).toMatchObject({ canonical: 'Adda', role: 'channel' });
  });
  it('matches aliases only as whole words (short aliases never fire inside tokens)', () => {
    expect(resolveCompany('nexus panel')).toBeNull();   // "ne" must not match inside "nexus"
    expect(resolveCompany('kilty')).toBeNull();          // "ilt" must not match inside "kilty"
  });
  it('returns null for an unknown name', () => {
    expect(resolveCompany('Totally Unknown AB')).toBeNull();
    expect(resolveCompany('')).toBeNull();
    expect(resolveCompany(null)).toBeNull();
  });
  it('companyBySlug looks up by slug', () => {
    expect(companyBySlug('radish')).toMatchObject({ canonical: 'Radish' });
    expect(companyBySlug('nope')).toBeUndefined();
  });
  it('every company has a unique slug and non-empty canonical', () => {
    const slugs = COMPANIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const c of COMPANIES) { expect(c.canonical).toBeTruthy(); expect(['service','channel']).toContain(c.role); }
  });
});
