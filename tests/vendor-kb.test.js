import { describe, it, expect } from 'vitest';
import { resolveCompany, normalizeVendorName, companyBySlug, probeName, COMPANIES } from '../src/vendor-kb.js';

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
  it('resolves the known fragmentation clusters to a single company', () => {
    for (const n of ['NE', 'NE Nationalencyklopedin', 'NE.se']) expect(resolveCompany(n)?.slug).toBe('ne');
    for (const n of ['ILT', 'ILT Education', 'Inläsningstjänst', 'Polyglutt']) expect(resolveCompany(n)?.slug).toBe('ilt');
    for (const n of ['Magma', 'Matteappen', 'Radish']) expect(resolveCompany(n)?.slug).toBe('radish');
  });
  it('channels are role=channel with no products to request', () => {
    for (const s of ['adda','skolon','atea','laromedia']) {
      const c = COMPANIES.find((x) => x.slug === s); expect(c?.role).toBe('channel');
    }
  });
});

describe('probeName', () => {
  // A kommun recognizes the brand it buys, not the company that owns it: asking
  // "har ni avtal med Radish?" reads as a stranger's question, "Magma" does not.
  it('gives watchlist companies their kommun-facing brand', () => {
    expect(probeName(companyBySlug('radish'))).toBe('Magma');
    expect(probeName(companyBySlug('ilt'))).toBe('Inläsningstjänst');
    expect(probeName(companyBySlug('ne'))).toBe('NE');
    expect(probeName(companyBySlug('binogi'))).toBe('Binogi');
  });
  it('every watchlisted company has a probe name', () => {
    for (const c of COMPANIES.filter((x) => x.watchlist)) expect(probeName(c)).toBeTruthy();
  });
  it('falls back to the canonical name and tolerates a missing company', () => {
    expect(probeName(companyBySlug('unikum'))).toBe('Unikum');
    expect(probeName(undefined)).toBe('');
  });
});
