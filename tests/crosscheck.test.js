// The final checklist: the step that makes DONE mean "we asked and they
// confirmed" rather than "a human gave up". Before this, is_final_delivery was
// computed on every reply and never acted on, so nothing reached DONE by itself.
import { describe, it, expect } from 'vitest';
import { T_CROSSCHECK } from '../src/templates.js';
import { nextActionForClassification, STALE_RULES } from '../src/conversation.js';
import { buildPipeline, stageForState, STAGES } from '../src/pipeline.js';

const ctx = {
  thread_subject: 'Begäran om allmänna handlingar',
  from_name: 'Gustaf Hård af Segerstad', from_email: 'gustaf.hard@gmail.com',
};

describe('T_CROSSCHECK wording', () => {
  const m = T_CROSSCHECK({ ...ctx, probe: { categories: [
    { category: 'laromedel', label: 'Läromedel', names: ['Radish (Magma)', 'Binogi'], more: 4 },
    { category: 'prov', label: 'Prov och bedömning', names: ['DigiExam', 'Teachiq (Exam.net)', 'Trelson'] },
    { category: 'larplattform', label: 'Lärplattform', note: 'för gymnasiet', names: ['itslearning'] },
  ], struck: [] } });

  it('asks in the verifying form, one line per category with names inline', () => {
    expect(m.body).toMatch(/stämmer det att kommunen inte har avtal för något av följande\?/i);
    expect(m.body).toContain('- Läromedel: Radish (Magma), Binogi eller liknande');
    expect(m.body).toContain('- Prov och bedömning: DigiExam, Teachiq (Exam.net), Trelson');
    expect(m.body).toContain('- Lärplattform för gymnasiet: itslearning');
  });

  it('lets silence close the case rather than stranding it', () => {
    expect(m.body).toMatch(/betraktar jag min begäran som besvarad/);
  });

  it('states no date, no elapsed time and no em-dash', () => {
    expect(m.body).not.toMatch(/[—–]/);
    expect(m.body).not.toMatch(/\d{4}|dagar sedan/);
  });
});

describe('FSM: the checklist is the only automatic road to DONE', () => {
  it('a confirmed-complete delivery earns the checklist, not an instant close', () => {
    expect(nextActionForClassification('DELIVERING', 'delivery', { is_closer: true, receipt_sent: 1 }))
      .toEqual({ nextState: 'CROSSCHECK', action: 'send_crosscheck' });
  });

  it('confirming the checklist closes the case', () => {
    expect(nextActionForClassification('CROSSCHECK', 'delivery', { is_closer: true }))
      .toEqual({ nextState: 'DONE', action: 'none' });
    // "We have none of those" completes it too, and must not read as DEAD_END:
    // we already hold their contracts.
    expect(nextActionForClassification('CROSSCHECK', 'dead_end', {}))
      .toEqual({ nextState: 'DONE', action: 'none' });
  });

  it('more contracts in answer to the checklist reopens delivery', () => {
    expect(nextActionForClassification('CROSSCHECK', 'delivery', { is_closer: false, receipt_sent: 0 }))
      .toEqual({ nextState: 'DELIVERING', action: 'send_receipt' });
  });

  it('an unanswered checklist cannot strand', () => {
    expect(STALE_RULES.CROSSCHECK).toBeTruthy();
  });
});

describe('pipeline board', () => {
  const munis = [
    { kommun_kod: '1', kommun_namn: 'Alfa' },
    { kommun_kod: '2', kommun_namn: 'Beta' },
    { kommun_kod: '3', kommun_namn: 'Gamma' },
  ];

  it('places every kommun in exactly one column', () => {
    const p = buildPipeline({ municipalities: munis, conversations: [{ id: 9, kommun_kod: '2', state: 'CROSSCHECK' }] });
    expect(Object.values(p.counts).reduce((a, b) => a + b, 0)).toBe(3);
    expect(p.counts.ej_kontaktad).toBe(2);
    expect(p.counts.slutkoll).toBe(1);
  });

  it('shows a kommun at its furthest förvaltning, and one dead end does not stop it', () => {
    const p = buildPipeline({
      municipalities: munis,
      conversations: [
        { id: 1, kommun_kod: '1', state: 'DEAD_END' },
        { id: 2, kommun_kod: '1', state: 'DELIVERING' },
      ],
    });
    expect(p.columns.avtal_kommer.map((k) => k.kommun_namn)).toEqual(['Alfa']);
    expect(p.counts.stoppat).toBe(0);
  });

  it('keeps off-track work as its own column rather than hiding it in the funnel', () => {
    const p = buildPipeline({ municipalities: munis, conversations: [{ id: 1, kommun_kod: '1', state: 'NEEDS_HUMAN' }] });
    expect(p.counts.stoppat).toBe(1);
    expect(STAGES.map((s) => s.key)).toContain('stoppat');
  });

  it('maps every FSM state to a stage', () => {
    for (const st of ['INITIAL', 'SENT', 'ACK_RECEIVED', 'AWAITING_PRECISION', 'DELIVERING',
      'CROSSCHECK', 'REFRESH_DUE', 'DONE', 'DEAD_END', 'NEEDS_HUMAN']) {
      expect(STAGES.map((s) => s.key)).toContain(stageForState(st));
    }
  });
});

describe('kommunStage (overview funnel collapse, 2026-08-31)', () => {
  it('collapses to the furthest stage; stoppat never wins over progress', async () => {
    const { kommunStage } = await import('../src/pipeline.js');
    expect(kommunStage([])).toBe('ej_kontaktad');
    expect(kommunStage(['SENT'])).toBe('kontaktad');
    expect(kommunStage(['SENT', 'DELIVERING'])).toBe('avtal_kommer');
    expect(kommunStage(['ACK_RECEIVED', 'AWAITING_PRECISION'])).toBe('dialog');
    expect(kommunStage(['DEAD_END', 'DELIVERING'])).toBe('avtal_kommer');
    expect(kommunStage(['NEEDS_HUMAN'])).toBe('stoppat');
    expect(kommunStage(['DONE', 'CROSSCHECK'])).toBe('klart');
    expect(kommunStage(['REFRESH_DUE'])).toBe('slutkoll');
  });
});
