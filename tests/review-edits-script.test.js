import { describe, it, expect } from 'vitest';
import { parseArgs, scoreEdits, summariseByTemplate, formatReport } from '../scripts/08-review-edits.js';

function row(overrides = {}) {
  return {
    decision_id: 1,
    decided_at: '2026-07-02 08:00:00',
    kommun_kod: '2506',
    kommun_namn: 'Arjeplog',
    role: 'central',
    classifier_class: 'partial_delivery',
    conversation_state: 'ACK_RECEIVED',
    draft_template: 'T_PRECISION',
    draft_body: 'aaaa aaaa aaaa aaaa',
    final_body: 'aaaa aaaa aaaa aaaa',
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('applies defaults', () => {
    expect(parseArgs([])).toEqual({
      min: 0.35,
      db: 'data/pilot.db',
      out: 'data/edit-review.md',
      dryRun: false,
    });
  });

  it('parses overrides', () => {
    expect(parseArgs(['--min=0.5', '--db=/tmp/x.db', '--out=/tmp/r.md', '--dry-run'])).toEqual({
      min: 0.5,
      db: '/tmp/x.db',
      out: '/tmp/r.md',
      dryRun: true,
    });
  });

  it('rejects a non-numeric or out-of-range --min', () => {
    expect(() => parseArgs(['--min=abc'])).toThrow(/--min/);
    expect(() => parseArgs(['--min=1.5'])).toThrow(/--min/);
  });
});

describe('scoreEdits', () => {
  it('attaches divergence and severity to each row', () => {
    const scored = scoreEdits([
      row({ decision_id: 1 }), // identical draft/final
      row({ decision_id: 2, final_body: 'bbbb bbbb bbbb bbbb' }), // total rewrite
    ]);
    expect(scored[0].divergence).toBe(0);
    expect(scored[0].severity).toBe('trivial');
    expect(scored[1].divergence).toBeGreaterThanOrEqual(0.4);
    expect(scored[1].severity).toBe('major');
  });
});

describe('summariseByTemplate', () => {
  it('aggregates count, major count and avg divergence per template, sorted by avg desc', () => {
    const scored = scoreEdits([
      row({ decision_id: 1, draft_template: 'T_FOLLOWUP' }), // 0 → trivial
      row({ decision_id: 2, draft_template: 'T_FOLLOWUP', final_body: 'aaaa aaaa aaaa aaab' }), // tiny
      row({ decision_id: 3, draft_template: 'T_PRECISION', final_body: 'bbbb bbbb bbbb bbbb' }), // total rewrite
      row({ decision_id: 4, draft_template: null, final_body: 'aaaa bbbb bbbb bbbb' }), // major, but less, no template
    ]);
    const summary = summariseByTemplate(scored);
    expect(summary.map((s) => s.template)).toEqual(['T_PRECISION', '(no template)', 'T_FOLLOWUP']);
    const precision = summary[0];
    expect(precision.edits).toBe(1);
    expect(precision.major).toBe(1);
    expect(precision.avgDivergence).toBeGreaterThanOrEqual(0.4);
    const followup = summary[2];
    expect(followup.edits).toBe(2);
    expect(followup.major).toBe(0);
    expect(followup.avgDivergence).toBeLessThan(0.1);
  });
});

describe('formatReport', () => {
  it('renders the summary table first, then big edits grouped by template with draft/final blockquotes', () => {
    const scored = scoreEdits([
      row({
        decision_id: 1,
        draft_template: 'T_PRECISION',
        kommun_namn: 'Arjeplog',
        draft_body: 'Hej,\nTack för avtalen gällande Quiculum.',
        final_body: 'Hej,\nStämmer det att ni inte har några avtal alls?',
      }),
      row({ decision_id: 2, draft_template: 'T_FOLLOWUP', kommun_namn: 'Göteborg' }), // divergence 0 → below min
    ]);
    const md = formatReport({ scored, min: 0.35, dbPath: 'data/pilot.db', generatedAt: '2026-07-11T08:00:00Z' });

    // Summary table appears before the detail sections
    const tableIdx = md.indexOf('| Template |');
    const detailIdx = md.indexOf('## T_PRECISION');
    expect(tableIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeGreaterThan(tableIdx);

    // Summary covers ALL edits (both templates), details only the big ones
    expect(md).toContain('T_FOLLOWUP');
    expect(md).not.toContain('## T_FOLLOWUP');
    expect(md).not.toContain('Göteborg');

    // Big edit rendering
    expect(md).toContain('Arjeplog / central');
    expect(md).toContain('partial_delivery');
    expect(md).toContain('ACK_RECEIVED');
    expect(md).toContain('major');
    expect(md).toContain('**BOT DRAFT**');
    expect(md).toContain('**DU SKICKADE**');
    expect(md).toContain('> Hej,\n> Tack för avtalen gällande Quiculum.');
    expect(md).toContain('> Hej,\n> Stämmer det att ni inte har några avtal alls?');
  });

  it('sorts big edits by divergence desc within a template group', () => {
    const scored = scoreEdits([
      row({ decision_id: 1, kommun_namn: 'Halvstor', final_body: 'aaaa bbbb bbbb aaaa' }), // partial rewrite
      row({ decision_id: 2, kommun_namn: 'Störst', final_body: 'bbbb bbbb bbbb bbbb' }), // total rewrite
    ]);
    const md = formatReport({ scored, min: 0.35, dbPath: 'data/pilot.db', generatedAt: '2026-07-11T08:00:00Z' });
    expect(md.indexOf('Störst')).toBeLessThan(md.indexOf('Halvstor'));
  });

  it('says so when no edit exceeds the threshold', () => {
    const md = formatReport({ scored: scoreEdits([row()]), min: 0.35, dbPath: 'data/pilot.db', generatedAt: '2026-07-11T08:00:00Z' });
    expect(md).toMatch(/inga|no edits/i);
  });
});
