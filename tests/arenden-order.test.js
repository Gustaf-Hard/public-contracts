// The Ärenden master list must be ordered within each bucket, not left in
// enrollment order (which reads as unsorted). Behöver dig: longest-waiting
// first (oldest `since` on top). Öppna: soonest follow-up due first.
import { describe, it, expect } from 'vitest';
import { renderArenden } from '../src/dashboard-views.js';

// Order kommun rows appear in the rendered list.
function orderOf(html, names) {
  return names
    .map((n) => ({ n, i: html.indexOf(`>${n} <span class="muted">`) }))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);
}

const mk = (over) => ({
  conv_id: over.conv_id, kommun_kod: String(over.conv_id).padStart(4, '0'),
  kommun_namn: over.kommun_namn, role: 'central', state: over.state ?? 'NEEDS_HUMAN',
  open_esc: over.open_esc ?? 1, follow_up_at: over.follow_up_at ?? null,
  follow_up_source: null, since: over.since ?? null, subject: 'x', snippet: '', last_direction: 'inbound',
});

describe('renderArenden — bucket ordering', () => {
  it('Behöver dig: longest-waiting (oldest since) first, enrollment order ignored', () => {
    // Enrollment order is Recent, Old, Middle — must render Old, Middle, Recent.
    const cases = [
      mk({ conv_id: 1, kommun_namn: 'Recent', since: '2026-07-18T08:00:00Z' }),
      mk({ conv_id: 2, kommun_namn: 'Old', since: '2026-07-05T08:00:00Z' }),
      mk({ conv_id: 3, kommun_namn: 'Middle', since: '2026-07-10T08:00:00Z' }),
    ];
    const html = renderArenden({ cases });
    expect(orderOf(html, ['Recent', 'Old', 'Middle'])).toEqual(['Old', 'Middle', 'Recent']);
  });

  it('Öppna: soonest follow-up due first', () => {
    const cases = [
      mk({ conv_id: 4, kommun_namn: 'Later', state: 'SENT', open_esc: 0, follow_up_at: '2026-08-01' }),
      mk({ conv_id: 5, kommun_namn: 'Sooner', state: 'SENT', open_esc: 0, follow_up_at: '2026-07-22' }),
    ];
    const html = renderArenden({ cases });
    expect(orderOf(html, ['Later', 'Sooner'])).toEqual(['Sooner', 'Later']);
  });
});
