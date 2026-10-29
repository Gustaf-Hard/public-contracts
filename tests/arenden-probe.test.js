// The ärende page shows the probe list and why each name was struck, as a
// small foldable list (2026-10-29), so the operator can check the reasoning
// behind a T_REQUEST_MISSING or T_CROSSCHECK draft.
import { describe, it, expect } from 'vitest';
import { renderArenden } from '../src/dashboard-views.js';

const selected = (probe) => ({
  conv: { id: 7, kommun_kod: '9001', kommun_namn: 'Provkommun', role: 'central', state: 'DELIVERING', contact_email: 'k@prov.se' },
  messages: [], attachmentsByMsg: {}, signatures: {}, escalations: [],
  ...(probe ? { probe } : {}),
});

describe('ärende page probe fold', () => {
  it('folds the struck names with their reasons under a summary line', () => {
    const html = renderArenden({ cases: [], selected: selected({
      categories: [{ category: 'laromedel', label: 'Läromedel', names: ['Binogi', 'Skolplus'], more: 3 }],
      struck: [{ name: 'Natur & Kultur', reason: 'köpt via Skolon' }, { name: 'Unikum', reason: 'lärplattform finns redan (SchoolSoft)' }],
    }), selectedId: 7 });
    expect(html).toMatch(/<details class="probe-fold">/);
    expect(html).toMatch(/5 frågas, 2 strukna/);
    expect(html).toContain('Natur &amp; Kultur');
    expect(html).toContain('köpt via Skolon');
    expect(html).toContain('- Läromedel: Binogi, Skolplus eller liknande');
  });

  it('renders nothing when the probe could not be computed', () => {
    const html = renderArenden({ cases: [], selected: selected(null), selectedId: 7 });
    expect(html).not.toMatch(/<details class="probe-fold">/);
  });
});
