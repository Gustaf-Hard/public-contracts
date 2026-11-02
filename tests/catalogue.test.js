import { describe, it, expect } from 'vitest';
import {
  normName, classifyVendor, classifyLine, companies, companyBySlug, productBySlug, CATEGORIES, companiesNamedIn,
} from '../src/catalogue.js';
import { COMPANIES as KB_COMPANIES } from '../src/vendor-kb.js';

const slugOf = (companySlug, productName) =>
  companyBySlug(companySlug).products.find((p) => p.name === productName).slug;

describe('normName', () => {
  it('folds Swedish letters and punctuation', () => {
    expect(normName('  Inläsningstjänst / Öppna Skolan, É-ü ')).toBe('inlasningstjanst oppna skolan e u');
    expect(normName(null)).toBe('');
  });
});

describe('classifyVendor', () => {
  it('maps raw vendor names to catalogue companies', () => {
    expect(classifyVendor('ILT Inläsningstjänst').slug).toBe('ilt');
    expect(classifyVendor('ILT Inläsningstjänst AB').slug).toBe('ilt');
    expect(classifyVendor('Matteappen').slug).toBe('radish');
    expect(classifyVendor('Skola24').slug).toBe('nova-software');
    expect(classifyVendor('Okänd Firma AB')).toBeNull();
    expect(classifyVendor(null)).toBeNull();
  });

  it('returns the public shape with a studio category', () => {
    expect(classifyVendor('Atea')).toEqual({ slug: 'atea', canonical: 'Atea', role: 'channel', category: null });
    expect(classifyVendor('Tietoevry Sverige AB')).toEqual({
      slug: 'tietoevry', canonical: 'Tietoevry', role: 'service', category: 'skoladministration',
    });
  });
});

describe('classifyLine', () => {
  it('strips segment words off product names', () => {
    const polyglutt = slugOf('ilt', 'Polyglutt');
    expect(classifyLine('ilt', 'Polyglutt skola F-3')).toMatchObject({ kind: 'product', companySlug: 'ilt', productSlug: polyglutt });
    expect(classifyLine('ilt', 'Polyglutt förskola Huvudmannalicens')).toMatchObject({ kind: 'product', productSlug: polyglutt });
  });

  it('reads discounts, add-ons and segments', () => {
    expect(classifyLine('ilt', 'Rabatt 3-årsavtal').kind).toBe('discount');
    expect(classifyLine('ilt', 'Rabatt Polyglutt skola')).toMatchObject({ kind: 'discount', productSlug: slugOf('ilt', 'Polyglutt') });
    expect(classifyLine('tietoevry', 'Införande Edlevo elevregister förskola')).toMatchObject({
      kind: 'addon', companySlug: 'tietoevry', productSlug: slugOf('tietoevry', 'Edlevo'), addonType: 'Införande och uppstart',
    });
    expect(classifyLine('haldor', 'Kommunlicens')).toMatchObject({
      kind: 'segment', companySlug: 'haldor', productSlug: slugOf('haldor', 'Haldor Education'),
    });
  });

  it('attributes Binogi lines to the one Binogi product', () => {
    const binogi = slugOf('binogi', 'Binogi');
    expect(classifyLine('binogi', 'Binogi.se årskurs 7-9')).toMatchObject({ kind: 'product', companySlug: 'binogi', productSlug: binogi });
    expect(classifyLine('binogi', 'Språkprojektet')).toMatchObject({ kind: 'product', companySlug: 'binogi', productSlug: binogi });
  });

  it('attributes a brand bought through a channel to its owner', () => {
    expect(classifyLine('skolon', 'Polylino')).toMatchObject({
      kind: 'product', companySlug: 'ilt', productSlug: slugOf('ilt', 'Polylino'),
    });
  });

  it('treats product renames as aliases', () => {
    expect(classifyLine('tietoevry', 'Procapita')).toMatchObject({ kind: 'product', productSlug: slugOf('tietoevry', 'Edlevo') });
    expect(classifyLine('radish', 'Matteappen')).toMatchObject({ kind: 'product', productSlug: slugOf('radish', 'Magma') });
  });

  it('keeps local aliases inside the owner', () => {
    expect(classifyLine('teachiq', 'KM')).toMatchObject({ kind: 'product', productSlug: slugOf('teachiq', 'Kunskapsmatrisen') });
    expect(classifyLine('skolon', 'KM').productSlug).not.toBe(slugOf('teachiq', 'Kunskapsmatrisen'));
    expect(classifyLine('tietoevry', 'Elevregister').productSlug).toBe(slugOf('tietoevry', 'Edlevo'));
    expect(classifyLine('ist', 'Elevregister').productSlug).not.toBe(slugOf('tietoevry', 'Edlevo'));
  });

  it('reads a line naming two products as a bundle', () => {
    expect(classifyLine('everway', 'SkrivaText & LexiFlow (Kommunlicens Paketpris/Bundle)')).toMatchObject({
      kind: 'bundle', companySlug: 'everway', productSlug: slugOf('everway', 'SkrivaText'),
      products: [slugOf('everway', 'SkrivaText'), slugOf('everway', 'LexiFlow')],
    });
  });

  it('gives a product line with a licence word the product, not an add-on', () => {
    expect(classifyLine('vklass', 'Vklass-närvaro licens inkl support')).toMatchObject({
      kind: 'product', productSlug: slugOf('vklass', 'Vklass Närvaro'),
    });
  });

  it('marks hardware and generic lines as noise', () => {
    expect(classifyLine('atea', 'Chromebooks').kind).toBe('noise');
    expect(classifyLine(null, 'Lärplattform').kind).toBe('noise');
  });

  it('keeps unknown vendors uncatalogued, with a tidied name', () => {
    expect(classifyLine(null, 'Fantasiverktyget (12 mån)')).toMatchObject({
      kind: 'uncatalogued', companySlug: null, productSlug: null, name: 'Fantasiverktyget',
    });
  });
});

describe('catalogue entries', () => {
  it('has the seven studio categories', () => {
    expect(CATEGORIES.map((c) => c.slug)).toEqual([
      'laromedel', 'larplattform', 'skoladministration', 'prov', 'stodverktyg', 'elevhalsa', 'ovrigt',
    ]);
    const known = new Set([...CATEGORIES.map((c) => c.slug), null]);
    for (const c of companies()) {
      expect(known.has(c.category), c.slug).toBe(true);
      for (const p of c.products) expect(known.has(p.category), p.slug).toBe(true);
    }
  });

  it('keeps product lists short', () => {
    expect(companyBySlug('ilt').products.length).toBeLessThanOrEqual(10);
    expect(companyBySlug('tietoevry').products.length).toBeLessThanOrEqual(3);
  });

  // Real brand names that trip the pattern without carrying a segment:
  // "Film och Skola" and "IST Home Skola" contain "skola"; "E-språk" matches
  // \båk\b because JS \b treats å as a non-word character.
  const SEGMENT_WORD_EXCEPTIONS = new Set(['Film och Skola', 'IST Home Skola', 'E-språk']);
  it('never puts a segment word in a product name', () => {
    for (const c of companies()) {
      for (const p of c.products) {
        if (SEGMENT_WORD_EXCEPTIONS.has(p.name)) continue;
        expect(/förskola|skola\b|f-\d|huvudmannalicens|kommunlicens|årskurs|\båk\b/i.test(p.name), p.name).toBe(false);
      }
    }
  });

  it('finds products by slug and hides item-24 companies', () => {
    const { product, company } = productBySlug(slugOf('ilt', 'Polylino'));
    expect(product.name).toBe('Polylino');
    expect(product.whatItIs).toMatch(/bilderboksbibliotek/);
    expect(company.slug).toBe('ilt');
    expect(productBySlug('finns-inte')).toBeUndefined();
    expect(companyBySlug('hermods').hiddenInStudio).toBe(true);
    expect(companyBySlug('upplands-bro').hiddenInStudio).toBe(true);
    expect(companyBySlug('ilt').hiddenInStudio).toBeUndefined();
    expect(companyBySlug('binogi').singleProduct).toBe('Binogi');
  });

  it('has unique company and product slugs', () => {
    const cs = companies().map((c) => c.slug);
    expect(new Set(cs).size).toBe(cs.length);
    const ps = companies().flatMap((c) => c.products.map((p) => p.slug));
    expect(new Set(ps).size).toBe(ps.length);
  });

  // Doubt 2 merges this KB company into another catalogue company. Doubt 1
  // (Chas -> Unikum) was reversed: Chas is a channel of its own (r2 P3).
  const KB_MERGED = { oribi: 'everway' };
  it('resolves every back-office KB company, with the same slug where both exist', () => {
    for (const kb of KB_COMPANIES) {
      const hit = classifyVendor(kb.canonical);
      expect(hit, kb.canonical).not.toBeNull();
      expect(hit.slug, kb.canonical).toBe(KB_MERGED[kb.slug] ?? kb.slug);
    }
  });
});

// Fix wave 4 R3: the Swedish genitive of a brand that ends a word.
describe('companiesNamedIn: the genitive s (R3)', () => {
  it('matches "<brand>s" for brands whose pattern ends in \\b', () => {
    expect(companiesNamedIn('Avtalet gäller Libers digitala läromedel')).toContain('liber');
    expect(companiesNamedIn('Fakturan avser ISTs elevregister')).toContain('ist');
    expect(companiesNamedIn('NEs tjänster')).toContain('ne');
    expect(companiesNamedIn('Tyras app för förskolan')).toContain('tyra');
    expect(companiesNamedIn('Clios läromedel')).toContain('clio');
    expect(companiesNamedIn('SLIs filmer')).toContain('sli');
    expect(companiesNamedIn('Nomps övningar')).toContain('nomp');
    expect(companiesNamedIn('BTJs katalog')).toContain('btj');
    expect(companiesNamedIn('NTAs lådor')).toContain('nta');
    expect(companiesNamedIn('Polyglutt från ILTs katalog')).toContain('ilt');
  });

  it('is not loosened otherwise', () => {
    expect(companiesNamedIn('Nestlé')).not.toContain('ne');
    expect(companiesNamedIn('Resa till Istanbul')).not.toContain('ist');
    expect(companiesNamedIn('Liberalt')).not.toContain('liber');
    expect(companiesNamedIn('Tyrann')).not.toContain('tyra');
    expect(companiesNamedIn('samverkan')).toEqual([]);
  });
});
