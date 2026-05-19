import { describe, it, expect } from 'vitest';
import { classify } from '../src/classifier.js';

function msg(overrides = {}) {
  return {
    from: 'registrator@kommun.se',
    subject: 'Re: Begäran om allmänna handlingar',
    body: '',
    attachment_count: 0,
    ...overrides,
  };
}

describe('classify — auto_ack', () => {
  it('catches flexiteBPMS-style auto-ack with Ärendenummer', () => {
    const r = classify(msg({ body: 'Tack för att du hörde av dig\n\nVi har tagit emot ditt ärende.\n\nÄrendenummer: K202642713' }));
    expect(r.class).toBe('auto_ack');
    expect(r.confidence).toBeGreaterThanOrEqual(0.7);
    expect(r.signals).toContain('arendenummer');
  });

  it('catches "Tack för att du hörde av dig"', () => {
    const r = classify(msg({ body: 'Tack för att du hörde av dig. Vi svarar så fort vi kan.' }));
    expect(r.class).toBe('auto_ack');
  });
});

describe('classify — clarification', () => {
  it('catches Mikaela-style precision request', () => {
    const r = classify(msg({
      body: [
        'Hej',
        '',
        'För att kunna hjälpa dig på bästa sätt, önskar jag veta:',
        '– Om begäran avser en viss tidsperiod',
        '– Om den gäller specifika typer av system eller leverantörer',
        '– Om du är ute efter en sammanställning eller specifika avtal',
        '',
        'Vänligen återkom med förtydligande, så återkommer jag med beräknad handläggningstid.',
      ].join('\n'),
    }));
    expect(r.class).toBe('clarification');
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it('catches "precisera"', () => {
    const r = classify(msg({ body: 'Kan du precisera din begäran?' }));
    expect(r.class).toBe('clarification');
  });
});

describe('classify — delivery', () => {
  it('catches PDF attachment with "bifogat" body', () => {
    const r = classify(msg({
      body: 'Här kommer bifogat det avtal du efterfrågat.',
      attachment_count: 1,
    }));
    expect(r.class).toBe('delivery');
  });

  it('requires at least one attachment', () => {
    const r = classify(msg({
      body: 'Här kommer bifogat det avtal du efterfrågat.',
      attachment_count: 0,
    }));
    expect(r.class).not.toBe('delivery');
  });
});

describe('classify — dead_end', () => {
  it('catches "finns inte"', () => {
    const r = classify(msg({ body: 'Vi har tyvärr inga avtal av detta slag i vår verksamhet, det finns inte hos oss.' }));
    expect(r.class).toBe('dead_end');
  });

  it('catches "hänvisar till"', () => {
    const r = classify(msg({ body: 'Vi hänvisar er till stadsledningskontoret för dessa avtal.' }));
    expect(r.class).toBe('dead_end');
  });

  it('catches the "samtliga avtal" closer as dead_end', () => {
    const r = classify(msg({ body: 'Detta var samtliga avtal vi har att lämna ut.' }));
    expect(r.class).toBe('dead_end');
  });
});

describe('classify — unknown', () => {
  it('returns unknown when no patterns match', () => {
    const r = classify(msg({ body: 'Hej, kan du ringa mig på 070-1234567 så pratar vi om detta?' }));
    expect(r.class).toBe('unknown');
  });

  it('returns unknown when body is empty', () => {
    const r = classify(msg({ body: '' }));
    expect(r.class).toBe('unknown');
  });
});

describe('classify — arendenummer extraction', () => {
  it('exposes the captured Ärendenummer for storage', () => {
    const r = classify(msg({ body: 'Ärendenummer: K202642713\n\nVi svarar inom 4 veckor.' }));
    expect(r.extracted?.arendenummer).toBe('K202642713');
  });
});
