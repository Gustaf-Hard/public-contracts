import { describe, it, expect } from 'vitest';
import { mergeContacts, contactSourceLabel } from '../src/dashboard-views.js';

describe('contactSourceLabel', () => {
  it('maps source to Swedish label', () => {
    expect(contactSourceLabel('kommun_handoff')).toBe('kommunen angav i mejl');
    expect(contactSourceLabel('website')).toBe('hittad på webbplats');
  });
});

describe('mergeContacts', () => {
  const dataset = [{ email: 'arboga.kommun@arboga.se', role: 'central', forvaltning_namn: null }];
  const handoff = [{ email: 'barn.utbildning@arboga.se', role: 'central', forvaltning: 'Barn- och utbildningsförvaltningen' }];

  it('tags sources and ranks handoff first', () => {
    const merged = mergeContacts(dataset, handoff);
    expect(merged.map((c) => c.email)).toEqual(['barn.utbildning@arboga.se', 'arboga.kommun@arboga.se']);
    expect(merged[0].source).toBe('kommun_handoff');
    expect(merged[0].forvaltning).toBe('Barn- och utbildningsförvaltningen');
    expect(merged[1].source).toBe('website');
  });

  it('handoff wins on duplicate email (highest trust)', () => {
    const merged = mergeContacts(
      [{ email: 'X@arboga.se', role: 'central' }],
      [{ email: 'x@arboga.se', role: 'central', forvaltning: 'BoU' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('kommun_handoff');
  });

  it('handles empty inputs', () => {
    expect(mergeContacts([], [])).toEqual([]);
    expect(mergeContacts(undefined, undefined)).toEqual([]);
  });
});

import { fmtNextReviewBadge } from '../src/dashboard-views.js';

describe('fmtNextReviewBadge (perpetual refresh — DONE cases)', () => {
  it('renders "Återkommer <date> — pga <vendor>" for an armed DONE case', () => {
    const html = fmtNextReviewBadge({ state: 'DONE', next_review_at: '2026-10-01', next_review_source: 'Skola24' });
    expect(html).toMatch(/Återkommer/);
    expect(html).toMatch(/2026-10-01/);
    expect(html).toMatch(/Skola24/);
  });

  it('omits the vendor clause when no source', () => {
    const html = fmtNextReviewBadge({ state: 'DONE', next_review_at: '2026-10-01', next_review_source: null });
    expect(html).toMatch(/2026-10-01/);
    expect(html).not.toMatch(/pga/);
  });

  it('returns null when not armed', () => {
    expect(fmtNextReviewBadge({ state: 'DONE', next_review_at: null })).toBeNull();
  });

  it('returns null for a non-DONE case (only closed cases show a review date)', () => {
    expect(fmtNextReviewBadge({ state: 'SENT', next_review_at: '2026-10-01' })).toBeNull();
  });
});
