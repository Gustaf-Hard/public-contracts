// The final checklist: the step that makes DONE mean "we asked and they
// confirmed" rather than "a human gave up". Before this, is_final_delivery was
// computed on every reply and never acted on, so nothing reached DONE by itself.
import { describe, it, expect } from 'vitest';
import { crosscheckProbeGroups, CATEGORY_RULES, companyBySlug } from '../src/vendor-kb.js';
import { popularProbeCompanies } from '../src/vendor-analytics.js';
import { T_CROSSCHECK } from '../src/templates.js';
import { nextActionForClassification, STALE_RULES } from '../src/conversation.js';
import { buildPipeline, stageForState, STAGES } from '../src/pipeline.js';

const ctx = {
  thread_subject: 'Begäran om allmänna handlingar',
  from_name: 'Gustaf Hård af Segerstad', from_email: 'gustaf.hard@gmail.com',
};

// The probe pool is DATA-DRIVEN (2026-09-05 design): a company is asked about
// only when >5 kommuner already hold an extracted contract with it. Curation
// (checklist flags) no longer drives the final question — popularity does.
const POP = {
  'läromedel': ['radish', 'ne', 'ilt', 'binogi', 'skolplus'].map(companyBySlug),
  'lärplattform': ['unikum', 'schoolsoft'].map(companyBySlug),
  'prov': ['digiexam', 'teachiq'].map(companyBySlug),
  'stödverktyg': ['symbolbruket', 'oribi'].map(companyBySlug),
};

describe('crosscheckProbeGroups', () => {
  it('groups popular companies by category under probe labels', () => {
    const groups = crosscheckProbeGroups({ received: [], popular: POP });
    const laromedel = groups.find((g) => g.category === 'läromedel');
    expect(laromedel.label).toBe('Läromedel');
    expect(laromedel.names).toEqual(['Magma', 'NE', 'Inläsningstjänst', 'Binogi', 'Skolplus']);
  });

  it('drops an EXCLUSIVE category entirely once the kommun has any company in it', () => {
    // They have SchoolSoft (lärplattform, exclusive) and DigiExam (prov,
    // exclusive): neither category is asked at all — you have one of those.
    const groups = crosscheckProbeGroups({ received: ['SchoolSoft', 'DigiExam'], popular: POP });
    expect(groups.map((g) => g.category)).toEqual(['läromedel', 'stödverktyg']);
  });

  it('within an additive category only the received companies are struck, matching products too', () => {
    // Polyglutt is an ILT product; läromedel stays additive.
    const groups = crosscheckProbeGroups({ received: ['Polyglutt', 'Binogi'], popular: POP });
    const laromedel = groups.find((g) => g.category === 'läromedel');
    expect(laromedel.names).toEqual(['Magma', 'NE', 'Skolplus']);
  });

  it('drops empty categories and returns [] when nothing is left to ask', () => {
    const groups = crosscheckProbeGroups({
      received: ['Magma', 'NE', 'Inläsningstjänst', 'Binogi', 'Skolplus', 'Unikum', 'DigiExam', 'InPrint 3', 'Stava Rex'],
      popular: POP,
    });
    expect(groups).toEqual([]);
  });

  it('prov is one-per-kommun like lärplattform and skoladministration; läromedel stays additive', () => {
    expect(CATEGORY_RULES['prov'].exclusive).toBe(true);
    expect(CATEGORY_RULES['lärplattform'].exclusive).toBe(true);
    expect(CATEGORY_RULES['skoladministration'].exclusive).toBe(true);
    expect(CATEGORY_RULES['läromedel'].exclusive).toBe(false);
  });
});

describe('popularProbeCompanies', () => {
  const row = (vendor, kommun) => ({ vendor_name: vendor, kommun_kod: kommun });
  const kods = (n) => Array.from({ length: n }, (_, i) => String(1000 + i));

  it('admits a company only above the kommun threshold, counting DISTINCT kommuner', () => {
    const rows = [
      ...kods(6).map((k) => row('Binogi', k)),          // 6 kommuner → in
      ...kods(5).map((k) => row('Gleerups', k)),        // 5 kommuner → out
      ...kods(3).map((k) => row('NE', k)),              // 3 kommuner...
      ...kods(3).map((k) => row('NE.se', k)),           // ...same 3 via product alias → still 3, out
      row('Binogi', '1000'), row('Binogi', '1000'),     // duplicates do not inflate
    ];
    const pop = popularProbeCompanies(rows, { minKommuner: 6 });
    expect(pop['läromedel'].map((c) => c.slug)).toEqual(['binogi']);
  });

  it('ignores channels, unknown vendors and categories outside the probe set', () => {
    const rows = [
      ...kods(9).map((k) => row('Atea', k)),            // channel → never probed
      ...kods(9).map((k) => row('Helt Okänd AB', k)),   // not in KB → never probed
      ...kods(9).map((k) => row('Axiell', k)),          // KB category övrigt → outside probe set
    ];
    expect(popularProbeCompanies(rows, { minKommuner: 6 })).toEqual({});
  });

  it('orders companies within a category by kommun count, biggest first', () => {
    const rows = [
      ...kods(10).map((k) => row('ILT Education', k)),
      ...kods(7).map((k) => row('Binogi', k)),
    ];
    const pop = popularProbeCompanies(rows, { minKommuner: 6 });
    expect(pop['läromedel'].map((c) => c.slug)).toEqual(['ilt', 'binogi']);
  });
});

describe('T_CROSSCHECK wording', () => {
  const m = T_CROSSCHECK({ ...ctx, crosscheck_groups: [
    { category: 'läromedel', label: 'Läromedel', names: ['Magma', 'Binogi'] },
    { category: 'prov', label: 'Prov', names: ['DigiExam', 'Teachiq', 'Trelson'] },
  ] });

  it('asks in the verifying form, one line per category with names inline', () => {
    expect(m.body).toMatch(/stämmer det att kommunen inte har något avtal/i);
    expect(m.body).toContain('- Läromedel: Magma, Binogi');
    expect(m.body).toContain('- Prov: DigiExam, Teachiq, Trelson');
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
