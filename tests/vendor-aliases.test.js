// tests/vendor-aliases.test.js
// Pure-function tests for canonicalVendorName (2026-07-19 vendor-name
// normalization). Curated clusters collapse to their canonical; the guarded
// mechanical strip folds ` AB`/genitive ONLY onto a known canonical; unknown
// names pass through unchanged; every §3 exclusion stays distinct.
import { describe, it, expect } from 'vitest';
import {
  canonicalVendorName,
  VENDOR_CLUSTERS,
  KNOWN_CANONICALS,
} from '../src/vendor-aliases.js';

describe('canonicalVendorName — §2 curated clusters', () => {
  it('Nationalencyklopedin cluster: NE / NE Nationalencyklopedin / Nationalencyklopedin', () => {
    expect(canonicalVendorName('NE')).toBe('Nationalencyklopedin');
    expect(canonicalVendorName('NE Nationalencyklopedin')).toBe('Nationalencyklopedin');
    expect(canonicalVendorName('Nationalencyklopedin')).toBe('Nationalencyklopedin');
  });

  it('Microsoft cluster: Microsoft / Microsoft 365', () => {
    expect(canonicalVendorName('Microsoft')).toBe('Microsoft');
    expect(canonicalVendorName('Microsoft 365')).toBe('Microsoft');
  });

  it('Google cluster: Google / Google Workspace / Google Workspace for Education', () => {
    expect(canonicalVendorName('Google')).toBe('Google');
    expect(canonicalVendorName('Google Workspace')).toBe('Google');
    expect(canonicalVendorName('Google Workspace for Education')).toBe('Google');
  });

  it('Skola24 cluster: Skola24 / Skola 24', () => {
    expect(canonicalVendorName('Skola24')).toBe('Skola24');
    expect(canonicalVendorName('Skola 24')).toBe('Skola24');
  });

  it('InfoMentor cluster: InfoMentor / Infomentor / Informentor', () => {
    expect(canonicalVendorName('InfoMentor')).toBe('InfoMentor');
    expect(canonicalVendorName('Infomentor')).toBe('InfoMentor');
    expect(canonicalVendorName('Informentor')).toBe('InfoMentor');
  });

  it('Everway cluster: Everway / Ewerway (typo)', () => {
    expect(canonicalVendorName('Everway')).toBe('Everway');
    expect(canonicalVendorName('Ewerway')).toBe('Everway');
  });

  it('Teachiq cluster: Teachiq / TeachIQ', () => {
    expect(canonicalVendorName('Teachiq')).toBe('Teachiq');
    expect(canonicalVendorName('TeachIQ')).toBe('Teachiq');
  });

  it('SchoolSoft cluster: SchoolSoft / Schoolsoft', () => {
    expect(canonicalVendorName('SchoolSoft')).toBe('SchoolSoft');
    expect(canonicalVendorName('Schoolsoft')).toBe('SchoolSoft');
  });

  it('Oribi cluster: Oribi / Oribi Texthelp', () => {
    expect(canonicalVendorName('Oribi')).toBe('Oribi');
    expect(canonicalVendorName('Oribi Texthelp')).toBe('Oribi');
  });

  it('Insight cluster: Insight / Insight Technology Solutions', () => {
    expect(canonicalVendorName('Insight')).toBe('Insight');
    expect(canonicalVendorName('Insight Technology Solutions')).toBe('Insight');
  });

  it('Aleido Learning cluster: Aleido Learning / Aleido Learning Sweden', () => {
    expect(canonicalVendorName('Aleido Learning')).toBe('Aleido Learning');
    expect(canonicalVendorName('Aleido Learning Sweden')).toBe('Aleido Learning');
  });

  it('Tempus cluster: Tempus / Tempus Information Systems / Tempus Information System', () => {
    expect(canonicalVendorName('Tempus')).toBe('Tempus');
    expect(canonicalVendorName('Tempus Information Systems')).toBe('Tempus');
    expect(canonicalVendorName('Tempus Information System')).toBe('Tempus');
  });

  it('Tietoevry cluster: Tietoevry / Tieto', () => {
    expect(canonicalVendorName('Tietoevry')).toBe('Tietoevry');
    expect(canonicalVendorName('Tieto')).toBe('Tietoevry');
  });

  it('Inläsningstjänst (ILT) cluster: ILT / Inläsningstjänst / ILT Inläsningstjänst / ILT Education', () => {
    expect(canonicalVendorName('ILT')).toBe('Inläsningstjänst (ILT)');
    expect(canonicalVendorName('Inläsningstjänst')).toBe('Inläsningstjänst (ILT)');
    expect(canonicalVendorName('ILT Inläsningstjänst')).toBe('Inläsningstjänst (ILT)');
    expect(canonicalVendorName('ILT Education')).toBe('Inläsningstjänst (ILT)');
  });

  it('LäroMedia Bokhandel Örebro cluster: casing variants collapse', () => {
    expect(canonicalVendorName('Läromedia Bokhandel Örebro')).toBe('LäroMedia Bokhandel Örebro');
    expect(canonicalVendorName('LäroMedia Bokhandel Örebro')).toBe('LäroMedia Bokhandel Örebro');
  });
});

describe('canonicalVendorName — normalization for lookup', () => {
  it('case-insensitive variant match', () => {
    expect(canonicalVendorName('microsoft 365')).toBe('Microsoft');
    expect(canonicalVendorName('SKOLA 24')).toBe('Skola24');
  });

  it('trims and collapses internal whitespace before lookup', () => {
    expect(canonicalVendorName('  Microsoft   365  ')).toBe('Microsoft');
    expect(canonicalVendorName('Skola  24')).toBe('Skola24');
  });
});

describe('canonicalVendorName — §1 guarded mechanical strip', () => {
  it('strips a trailing legal suffix ONLY when the stripped form is a known canonical', () => {
    expect(canonicalVendorName('Nova Software AB')).toBe('Nova Software');
    expect(canonicalVendorName('Haldor AB')).toBe('Haldor');
    expect(canonicalVendorName('IST AB')).toBe('IST');
    expect(canonicalVendorName('StudyBee AB')).toBe('StudyBee');
  });

  it('folds " Aktiebolag" / " Sverige AB" / " Sverige" onto a known canonical', () => {
    expect(canonicalVendorName('Nova Software Aktiebolag')).toBe('Nova Software');
    expect(canonicalVendorName('Nova Software Sverige AB')).toBe('Nova Software');
    expect(canonicalVendorName('Nova Software Sverige')).toBe('Nova Software');
  });

  it('folds a stripped-suffix variant onto a cluster canonical too', () => {
    // "SchoolSoft AB" (spec Problem) → SchoolSoft (a cluster canonical).
    expect(canonicalVendorName('SchoolSoft AB')).toBe('SchoolSoft');
    expect(canonicalVendorName('Nova Software AB')).toBe('Nova Software');
  });

  it('folds a trailing genitive -s onto a known canonical', () => {
    expect(canonicalVendorName('Haldors')).toBe('Haldor');
  });

  it('a name whose strip does NOT match a known canonical passes through unchanged', () => {
    expect(canonicalVendorName('Random Startup AB')).toBe('Random Startup AB');
    expect(canonicalVendorName('Some Unknown Vendor')).toBe('Some Unknown Vendor');
  });

  it('null / empty pass through unchanged', () => {
    expect(canonicalVendorName(null)).toBe(null);
    expect(canonicalVendorName('')).toBe('');
    expect(canonicalVendorName('   ')).toBe('   ');
  });
});

describe('canonicalVendorName — §3 exclusions (must NEVER merge)', () => {
  it('Magma Radish AB stays distinct (does NOT merge into Magma or Radish)', () => {
    expect(canonicalVendorName('Magma Radish AB')).toBe('Magma Radish AB');
  });

  it('Teams stays distinct (does NOT merge into Microsoft)', () => {
    expect(canonicalVendorName('Teams')).toBe('Teams');
  });

  it('Chrome OS / Chrome Education stay distinct (do NOT merge into Google)', () => {
    expect(canonicalVendorName('Chrome OS')).toBe('Chrome OS');
    expect(canonicalVendorName('Chrome Education')).toBe('Chrome Education');
  });

  it('Unikt lärande AB / Unikum - Unikt Lärande AB stay distinct (do NOT merge into Unikum)', () => {
    expect(canonicalVendorName('Unikt lärande AB')).toBe('Unikt lärande AB');
    expect(canonicalVendorName('Unikum - Unikt Lärande AB')).toBe('Unikum - Unikt Lärande AB');
  });

  it('Inlästa läromedel stays distinct (does NOT merge into Inläsningstjänst)', () => {
    expect(canonicalVendorName('Inlästa läromedel')).toBe('Inlästa läromedel');
  });

  it('reseller names are NOT canonicalized here (matchResellers owns them)', () => {
    // Neither cluster nor known-canonical strip touches Adda/Skolon/Atea.
    expect(canonicalVendorName('Skolon AB')).toBe('Skolon AB');
    expect(canonicalVendorName('Atea Sverige AB')).toBe('Atea Sverige AB');
    expect(canonicalVendorName('Adda')).toBe('Adda');
  });
});

describe('exports', () => {
  it('VENDOR_CLUSTERS exposes exactly the §2 canonicals', () => {
    expect(VENDOR_CLUSTERS.map((c) => c.canonical)).toEqual([
      'Nationalencyklopedin', 'Microsoft', 'Google', 'Skola24', 'InfoMentor',
      'Everway', 'Teachiq', 'SchoolSoft', 'Oribi', 'Insight', 'Aleido Learning',
      'Tempus', 'Tietoevry', 'Inläsningstjänst (ILT)', 'LäroMedia Bokhandel Örebro',
    ]);
  });

  it('KNOWN_CANONICALS contains cluster canonicals and the seeded vendors-table names', () => {
    expect(KNOWN_CANONICALS.has('Microsoft')).toBe(true);
    expect(KNOWN_CANONICALS.has('Nationalencyklopedin')).toBe(true);
    expect(KNOWN_CANONICALS.has('Nova Software')).toBe(true);
    expect(KNOWN_CANONICALS.has('Haldor')).toBe(true);
    expect(KNOWN_CANONICALS.has('IST')).toBe(true);
    expect(KNOWN_CANONICALS.has('StudyBee')).toBe(true);
  });
});
