import { describe, it, expect } from 'vitest';
import { parseHandoffTargets, homeDomainFromWebbplats } from '../src/handoff.js';

// The real Göteborg #63 extraction (message 255), abbreviated body.
const GBG = {
  intent: 'handoff',
  extracted: {
    handoff_to_email: 'info@educ.goteborg.se;grundskola@grundskola.goteborg.se',
    handoff_to_forvaltning: 'Utbildningsförvaltningen och Grundskoleförvaltningen',
  },
};
const GBG_BODY = `Hej Gustaf, Vi på inköps- och upphandlingsförvaltningen har hand om gemensamma ramavtal.
Kontakta Utbildningsförvaltningen: info@educ.goteborg.se
och Grundskoleförvaltningen: grundskola@grundskola.goteborg.se`;

describe('homeDomainFromWebbplats', () => {
  it('strips scheme and www, and tolerates junk', () => {
    expect(homeDomainFromWebbplats('http://www.goteborg.se')).toBe('goteborg.se');
    expect(homeDomainFromWebbplats('https://mala.se/')).toBe('mala.se');
    expect(homeDomainFromWebbplats(null)).toBeNull();
    expect(homeDomainFromWebbplats('not a url')).toBeNull();
  });
});

describe('parseHandoffTargets', () => {
  const gbg = (over = {}) => parseHandoffTargets({
    analysis: GBG, bodyText: GBG_BODY, homeDomain: 'goteborg.se', ...over,
  });

  it('splits the Göteborg handoff into two paired targets', () => {
    const t = gbg();
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      email: 'info@educ.goteborg.se', forvaltning: 'Utbildningsförvaltningen',
      verbatim: true, sameDomain: true, roleSlug: 'utbildning',
    });
    expect(t[1]).toMatchObject({
      email: 'grundskola@grundskola.goteborg.se', forvaltning: 'Grundskoleförvaltningen',
      verbatim: true, sameDomain: true, roleSlug: 'grundskola',
    });
  });

  it('returns nothing for a non-handoff intent', () => {
    for (const intent of ['delivery', 'handoff_internal', 'auto_ack', 'clarification']) {
      expect(parseHandoffTargets({ analysis: { ...GBG, intent }, bodyText: GBG_BODY, homeDomain: 'goteborg.se' })).toEqual([]);
    }
    expect(parseHandoffTargets({ analysis: null, bodyText: '', homeDomain: 'x.se' })).toEqual([]);
  });

  it('flags an address the kommun never wrote', () => {
    // The hallucination signal: extraction says it, the body does not.
    const t = parseHandoffTargets({ analysis: GBG, bodyText: 'Hej, kontakta någon annan.', homeDomain: 'goteborg.se' });
    expect(t.map((x) => x.verbatim)).toEqual([false, false]);
  });

  it('rejects a look-alike domain but accepts a real subdomain', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@xgoteborg.se;b@educ.goteborg.se', handoff_to_forvaltning: 'X och Y' } },
      bodyText: 'a@xgoteborg.se b@educ.goteborg.se', homeDomain: 'goteborg.se',
    });
    expect(t.map((x) => x.sameDomain)).toEqual([false, true]);
  });

  it('keeps the full förvaltning text when the counts disagree', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se, b@k.se, c@k.se', handoff_to_forvaltning: 'Skolan och IT' } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t).toHaveLength(3);
    for (const x of t) expect(x.forvaltning).toBe('Skolan och IT');
  });

  it('dedupes addresses and ignores non-addresses', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'A@k.se; a@k.se; inte-en-adress', handoff_to_forvaltning: null } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t.map((x) => x.email)).toEqual(['a@k.se']);
    expect(t[0].forvaltning).toBe('');
  });

  it('de-duplicates a role that the kommun already uses', () => {
    // sendInitial throws on a duplicate kommun+role, so the slug must dodge it.
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se', handoff_to_forvaltning: 'Utbildningsförvaltningen' } },
      bodyText: '', homeDomain: 'k.se', usedRoles: ['central', 'utbildning'],
    });
    expect(t[0].roleSlug).toBe('utbildning-2');
  });

  it('stems real förvaltning names without corrupting them', () => {
    const slug = (forvaltning) => parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se', handoff_to_forvaltning: forvaltning } },
      bodyText: '', homeDomain: 'k.se',
    })[0].roleSlug;
    expect(slug('Socialförvaltningen')).toBe('social');
    expect(slug('Stadsbyggnadskontoret')).toBe('stadsbyggnad');
    // No generic /e$/ rule: this must not become 'servica'.
    expect(slug('Serviceförvaltningen')).toBe('service');
    expect(slug('Förskoleförvaltningen')).toBe('forskola');
  });

  it('falls back to a generic role when no förvaltning is named', () => {
    const t = parseHandoffTargets({
      analysis: { intent: 'handoff', extracted: { handoff_to_email: 'a@k.se', handoff_to_forvaltning: null } },
      bodyText: '', homeDomain: 'k.se',
    });
    expect(t[0].roleSlug).toBe('handoff');
  });

  it('survives a missing home domain without crashing', () => {
    const t = parseHandoffTargets({ analysis: GBG, bodyText: GBG_BODY, homeDomain: null });
    expect(t.map((x) => x.sameDomain)).toEqual([false, false]);
  });
});
