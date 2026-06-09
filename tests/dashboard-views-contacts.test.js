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
