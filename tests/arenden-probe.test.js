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
      struck: [{ name: 'Natur & Kultur', reason: 'köpt via Skolon' }, { name: 'Unikum', reason: 'lärplattform finns redan via SchoolSoft' }],
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

// Fix wave 2 P7: the fold is computed now, the open draft was written then.
// A name the draft still asks about that the probe has since struck is
// flagged, so the operator edits before approving.
describe('ärende page probe fold: names struck since the draft', () => {
  const probe = {
    categories: [{ category: 'laromedel', label: 'Läromedel', names: ['Skolplus'] }],
    struck: [{ name: 'Binogi', reason: 'nämns i kommunens underlag' }, { name: 'NE', reason: 'avtal finns' }],
  };
  const body = 'Hej,\n\nStämmer det att kommunen inte har avtal för något av följande?\n\n- Läromedel: Binogi, Skolplus eller liknande\n- Prov och bedömning: DigiExam\n\nNE har vi redan.\n';

  it('warns with the count, the names and their reasons', () => {
    const html = renderArenden({ cases: [], selected: { ...selected(probe), escalations: [{ id: 1, draft_body: body, draft_template: 'T_CROSSCHECK' }] }, selectedId: 7 });
    expect(html).toContain('1 namn i utkastet är nu strukna: Binogi (nämns i kommunens underlag)');
    // NE is only in the prose, not on a probe line: not flagged.
    expect(html).not.toMatch(/NE \(avtal finns\)/);
  });

  it('labels the fold as computed now, and says nothing when the draft is still current', () => {
    const html = renderArenden({ cases: [], selected: { ...selected(probe), escalations: [{ id: 1, draft_body: '- Läromedel: Skolplus' }] }, selectedId: 7 });
    expect(html).toMatch(/Probe-listan \(beräknad nu\)/);
    expect(html).not.toMatch(/är nu strukna/);
  });
});
