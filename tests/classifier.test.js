import { describe, it, expect } from 'vitest';
import { classify, splitQuotedText, stripQuotedText } from '../src/classifier.js';

describe('splitQuotedText', () => {
  it('splits at the leading-date Gmail-sv attribution (no leading "Den")', () => {
    const body = [
      'Hej, här kommer avtalet.',
      '',
      '12 juni 2026 kl. 13:13 skrev Gustaf Hård af Segerstad <gustaf@x.se>:',
      '> Är detta samtliga avtal?',
    ].join('\n');
    const { visible, quoted } = splitQuotedText(body);
    expect(visible).toBe('Hej, här kommer avtalet.\n');
    expect(quoted).toContain('12 juni 2026 kl. 13:13 skrev');
    expect(quoted).toContain('samtliga avtal');
  });

  it('splits at the English "On … wrote:" attribution', () => {
    const body = [
      'Please find the contract attached.',
      '',
      'On Sat, Jun 6, 2026 at 10:09 AM Gustaf <gustaf@x.se> wrote:',
      '> Could you send it over?',
    ].join('\n');
    const { visible, quoted } = splitQuotedText(body);
    expect(visible).toBe('Please find the contract attached.\n');
    expect(quoted).toContain('wrote:');
    expect(quoted).toContain('Could you send it over?');
  });

  it('splits at an Outlook -----Ursprungligt/Original Message----- header', () => {
    for (const marker of ['-----Ursprungligt meddelande-----', '-----Original Message-----']) {
      const body = ['Nytt svar.', '', marker, 'Från: Gustaf', 'Skickat: ...'].join('\n');
      const { visible, quoted } = splitQuotedText(body);
      expect(visible).toBe('Nytt svar.\n');
      expect(quoted).toContain(marker);
    }
  });

  it('treats >-quoted lines as the start of the quoted tail', () => {
    const body = 'Kort svar.\n> gammal text\n> mer gammal text';
    const { visible, quoted } = splitQuotedText(body);
    expect(visible).toBe('Kort svar.');
    expect(quoted).toBe('> gammal text\n> mer gammal text');
  });

  it('a body with no quote returns the whole text and empty quoted', () => {
    const body = 'Bara en rad utan citat.';
    expect(splitQuotedText(body)).toEqual({ visible: body, quoted: '' });
  });

  it('keeps a signature in visible', () => {
    const body = 'Tack för svaret.\n\nMed vänlig hälsning\nAnna\nSkickat från min iPhone';
    const { visible, quoted } = splitQuotedText(body);
    expect(visible).toContain('Med vänlig hälsning');
    expect(visible).toContain('Skickat från min iPhone');
    expect(quoted).toBe('');
  });

  it('stripQuotedText(x) === splitQuotedText(x).visible', () => {
    const samples = [
      'Hej.\n12 juni 2026 kl. 13:13 skrev Gustaf <g@x.se>:\n> citat',
      'Hi.\nOn Sat, Jun 6, 2026 at 10:09 AM G <g@x.se> wrote:\n> quote',
      'Svar.\n-----Ursprungligt meddelande-----\nFrån: G',
      'Kort svar.\n> gammal text',
      'Bara en rad.',
    ];
    for (const s of samples) expect(stripQuotedText(s)).toBe(splitQuotedText(s).visible);
  });
});

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

  it('classifies PDF-only message (no body words) as delivery via attachment-only threshold', () => {
    const r = classify(msg({ body: 'Vänliga hälsningar', attachment_count: 1 }));
    expect(r.class).toBe('delivery');
  });

  it('classifies bare PDF (empty body) as delivery', () => {
    const r = classify(msg({ body: '', attachment_count: 1 }));
    expect(r.class).toBe('delivery');
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
