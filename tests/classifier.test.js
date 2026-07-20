import { describe, it, expect } from 'vitest';
import { classify, splitQuotedText, stripQuotedText, extractReturnDate, isInternalForwardText } from '../src/classifier.js';

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

describe('classify — auto_reply (autosvar / OOO, 2026-07-19 §1)', () => {
  it('the Bjuv autosvar → auto_reply with the stated return date', () => {
    const r = classify(msg({
      subject: 'Autosvar: Begäran om allmänna handlingar',
      body: 'Autosvar:\n\nHej! Jag har semester och är åter 20 juli. Vid akuta ärenden kontakta min kollega.',
      today_iso: '2026-07-05',
    }));
    expect(r.class).toBe('auto_reply');
    expect(r.signals).toContain('ooo_autosvar');
    expect(r.extracted.return_date).toBe('2026-07-20');
  });

  it('a "frånvarande … är åter" body without an explicit tag still matches (absence + return cue)', () => {
    const r = classify(msg({
      body: 'Jag är frånvarande på grund av semester och är åter den 3 augusti 2026.',
      today_iso: '2026-07-05',
    }));
    expect(r.class).toBe('auto_reply');
    expect(r.extracted.return_date).toBe('2026-08-03');
  });

  it('a plain autoresponder with no date → auto_reply, no return_date', () => {
    const r = classify(msg({
      subject: 'Automatiskt svar',
      body: 'Automatiskt svar: Jag är för närvarande frånvarande och läser inte min e-post.',
    }));
    expect(r.class).toBe('auto_reply');
    expect(r.extracted.return_date).toBeUndefined();
  });

  it('an English out-of-office → auto_reply', () => {
    const r = classify(msg({ subject: 'Out of office', body: 'I am currently out of office.' }));
    expect(r.class).toBe('auto_reply');
  });

  // PRECISION OVER RECALL — real replies must never be tagged auto_reply.
  it('a genuine delivery (with attachment) is NEVER auto_reply, even if body mentions semester', () => {
    const r = classify(msg({
      body: 'Här kommer bifogat avtalet. Notera att handläggaren har semester men jag skickar det ändå.',
      attachment_count: 1,
    }));
    expect(r.class).toBe('delivery');
  });

  it('a genuine clarification is NOT auto_reply', () => {
    const r = classify(msg({ body: 'Kan du precisera vilken tidsperiod och vilka specifika system begäran avser?' }));
    expect(r.class).toBe('clarification');
  });

  it('a genuine handoff/dead_end (hänvisar till) is NOT auto_reply', () => {
    const r = classify(msg({ body: 'Vi hänvisar er till stadsledningskontoret för dessa avtal.' }));
    expect(r.class).toBe('dead_end');
  });

  it('a reply merely QUOTING "semester" in history is NOT OOO (quoted text stripped)', () => {
    const r = classify(msg({
      body: [
        'Här kommer avtalet du efterfrågade.',
        '',
        '12 juli 2026 kl. 09:00 skrev Gustaf <g@x.se>:',
        '> Har ni semester nu? Jag väntar tills ni är åter.',
      ].join('\n'),
      attachment_count: 1,
    }));
    expect(r.class).not.toBe('auto_reply');
  });

  it('"semester" alone (no absence marker) does not trip the detector', () => {
    const r = classify(msg({ body: 'Trevlig semester önskar jag er! Här är svaret på er fråga.' }));
    expect(r.class).not.toBe('auto_reply');
  });
});

describe('extractReturnDate (pure)', () => {
  it('parses ISO and Swedish prose return dates', () => {
    expect(extractReturnDate('är åter 2026-07-20')).toBe('2026-07-20');
    expect(extractReturnDate('åter 20 juli', { todayIso: '2026-07-05' })).toBe('2026-07-20');
    expect(extractReturnDate('tillbaka 3 augusti 2026')).toBe('2026-08-03');
  });
  it('returns null on no date or an impossible date', () => {
    expect(extractReturnDate('ingen dag alls')).toBeNull();
    expect(extractReturnDate('31 februari')).toBeNull();
  });
});

describe('classify — arendenummer extraction', () => {
  it('exposes the captured Ärendenummer for storage', () => {
    const r = classify(msg({ body: 'Ärendenummer: K202642713\n\nVi svarar inom 4 veckor.' }));
    expect(r.extracted?.arendenummer).toBe('K202642713');
  });
});

describe('classify — soft internal forward (handoff_internal, 2026-07-20 §1)', () => {
  it('Bjurholm-style internal forward with NO address → handoff_internal (wait, no escalate)', () => {
    const r = classify(msg({
      body: 'Tack för ditt mail. Jag skickar det vidare till vår skol- och IT-chef som får återkomma. Med anledning av semestertider kan återkopplingen ta något längre tid än vanligt.',
    }));
    expect(r.class).toBe('handoff_internal');
    expect(r.signals).toContain('internal_forward');
  });

  it('Avesta-style "vidare till Upphandlingsenheten" → handoff_internal', () => {
    const r = classify(msg({ body: 'Hej, jag har skickat vidare din begäran till Upphandlingsenheten.' }));
    expect(r.class).toBe('handoff_internal');
  });

  it('"vidarebefordrat till Bildning" (Eda) → handoff_internal', () => {
    const r = classify(msg({ body: 'Din förfrågan är vidarebefordrad till Bildningsförvaltningen internt.' }));
    expect(r.class).toBe('handoff_internal');
  });

  it('a signature with the sender\'s OWN address does not block it (real emails always sign off)', () => {
    // Regression: the first cut bailed on ANY email, so every real forward (which
    // signs off with the sender's address) fell through to escalate.
    const r = classify(msg({
      from: 'Joakim Jansson <joakim.jansson@bjurholm.se>',
      body: 'Tack för ditt mail. Jag skickar det vidare till skol- och IT-chef.\n\nJoakim Jansson\nBjurholms Kommun\njoakim.jansson@bjurholm.se',
    }));
    expect(r.class).toBe('handoff_internal');
  });

  it('PRECISION: an EXTERNAL redirect naming an address stays escalate (unknown), NOT downgraded', () => {
    const r = classify(msg({
      body: 'Dessa avtal hanteras av stadsledningskontoret. Vänligen skicka vidare din begäran till registrator@stadsledningen.kommun.se.',
    }));
    expect(r.class).not.toBe('handoff_internal');
    expect(r.class).toBe('unknown');
  });

  it('PRECISION: a plain address named without a forward phrase is not handoff_internal', () => {
    expect(classify(msg({ body: 'Kontakta oss på registrator@kommun.se om du har frågor.' })).class).not.toBe('handoff_internal');
  });

  it('a real delivery with attachments is never a handoff_internal, even if it mentions "vidare"', () => {
    const r = classify(msg({ body: 'Här bifogas avtalet. Jag skickar även vidare till dig senare.', attachment_count: 2 }));
    expect(r.class).toBe('delivery');
  });

  it('a clarification reply keeps its own class (not handoff_internal)', () => {
    const r = classify(msg({ body: 'För att precisera din begäran, önskar jag veta vilken tidsperiod som avses.' }));
    expect(r.class).toBe('clarification');
  });

  it('a forward phrase quoted only in the trailing history does not trip it', () => {
    const r = classify(msg({
      body: 'Hej, jag är osäker på vad ni menar.\n\nDen 5 juli 2026 skrev Gustaf <g@x.se>:\n> Jag skickar det vidare till er.',
    }));
    expect(r.class).not.toBe('handoff_internal');
  });
});

describe('isInternalForwardText (pure, both directions)', () => {
  it('true for a forward phrase with no address', () => {
    expect(isInternalForwardText('Jag skickar det vidare till skolchefen.')).toBe(true);
    expect(isInternalForwardText('Din begäran är vidarebefordrad internt.')).toBe(true);
  });
  it('false when a concrete address is named (external handoff)', () => {
    expect(isInternalForwardText('Jag skickar vidare till registrator@x.se.')).toBe(false);
  });
  it('ignores the sender\'s OWN signature address, bails on a DIFFERENT one', () => {
    const body = 'Jag skickar det vidare internt.\n\nAnna Ek\nanna.ek@bjurholm.se';
    expect(isInternalForwardText(body, { fromEmail: 'Anna Ek <anna.ek@bjurholm.se>' })).toBe(true);
    expect(isInternalForwardText(body, { fromEmail: 'other@nan.se' })).toBe(false);
  });
  it('false when there is no forward phrase', () => {
    expect(isInternalForwardText('Vi återkommer inom kort.')).toBe(false);
  });
});
