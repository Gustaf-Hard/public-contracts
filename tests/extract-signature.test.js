import { describe, it, expect } from 'vitest';
import { extractSignature } from '../src/extract-signature.js';

const MIKAELA = `Hej

Jag har skrivit och begärt att få ett ärendenummer, när du får handlingarna kommer det inta att vara via mig utan direkt från berörd förvaltning.

Med vänlig hälsning

Mikaela Radgren

Enhetschef för digitalisering och utveckling

Västerås Stad

Barn- och utbildningsförvaltningen

721 87 Västerås

E-post: mikaela.radgren@vasteras.se

Telefon: 021-392592

www.vasteras.se`;

describe('extractSignature', () => {
  it('extracts all fields from a standard Swedish signature (Mikaela)', () => {
    const r = extractSignature(MIKAELA);
    expect(r).not.toBeNull();
    expect(r.name).toBe('Mikaela Radgren');
    expect(r.title).toBe('Enhetschef för digitalisering och utveckling');
    expect(r.forvaltning).toBe('Barn- och utbildningsförvaltningen');
    expect(r.email).toBe('mikaela.radgren@vasteras.se');
    expect(r.phone).toBe('021-392592');
    expect(r.postal).toBe('721 87 Västerås');
    expect(r.website).toContain('vasteras.se');
    expect(r.signature_block).toContain('Mikaela Radgren');
  });

  it('returns null when no signature marker is found', () => {
    const r = extractSignature('Hej!\n\nBara ett kort meddelande utan signatur.');
    expect(r).toBeNull();
  });

  it('handles MVH (abbreviated) marker', () => {
    const r = extractSignature('Hej!\n\nKort svar.\n\nMVH\nAnna Karlsson\nRegistrator\n070-123 45 67');
    expect(r).not.toBeNull();
    expect(r.name).toBe('Anna Karlsson');
    expect(r.title).toMatch(/Registrator/);
    expect(r.phone).toMatch(/070-123/);
  });

  it('uses the LAST marker when body has multiple ("Med vänlig hälsning")', () => {
    const body = `Hej

Tack för din förra Med vänlig hälsning.

Här kommer materialet.

Med vänlig hälsning

Per Andersson
Skolchef
per.andersson@example.se`;
    const r = extractSignature(body);
    expect(r.name).toBe('Per Andersson');
    expect(r.email).toBe('per.andersson@example.se');
  });

  it('handles a name with "af" infix', () => {
    const body = `Bra!

Hör av dig om något.

Vänligen
Gustaf Hård af Segerstad
Grundare
gustaf@mediagraf.se`;
    const r = extractSignature(body);
    expect(r.name).toBe('Gustaf Hård af Segerstad');
    expect(r.title).toBe('Grundare');
  });

  it('ignores label prefixes when extracting (E-post: / Telefon:)', () => {
    const body = `Med vänliga hälsningar

Karin Lind
Förvaltningschef
E-post: karin.lind@kommun.se
Telefon: 0521-72 30 00
Webb: www.kommun.se`;
    const r = extractSignature(body);
    expect(r.email).toBe('karin.lind@kommun.se');
    expect(r.phone).toBe('0521-72 30 00');
    expect(r.website).toBe('www.kommun.se');
  });

  it('returns null fields when extraction fails partway', () => {
    const body = `Med vänlig hälsning

just-some-text-that-is-not-a-name-or-anything`;
    const r = extractSignature(body);
    expect(r).not.toBeNull();
    expect(r.name).toBeNull();
    expect(r.title).toBeNull();
    expect(r.email).toBeNull();
  });
});
