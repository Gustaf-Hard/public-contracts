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
  deferred_esc: over.deferred_esc ?? 0,
  has_pending_handoff: over.has_pending_handoff ?? false,
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

  // Pausade (2026-10-02): its own bucket, claimed BEFORE behover_dig — a parked
  // case is still NEEDS_HUMAN-ish in every other respect (awaiting_us, a
  // lingering state), and the whole point of the park is that it leaves the
  // red queue. Longest-parked first, the same "revisit the oldest" ordering
  // Behöver dig uses.
  it('Pausade: a deferred case leaves Behöver dig, longest-parked first', () => {
    const cases = [
      mk({ conv_id: 6, kommun_namn: 'Nypausad', deferred_esc: 1, open_esc: 0, since: '2026-09-25T08:00:00Z' }),
      mk({ conv_id: 7, kommun_namn: 'Behover', open_esc: 1, since: '2026-09-20T08:00:00Z' }),
      mk({ conv_id: 8, kommun_namn: 'Langepausad', deferred_esc: 1, open_esc: 0, since: '2026-09-01T08:00:00Z' }),
    ];
    const html = renderArenden({ cases });
    expect(html).toContain('Pausade');
    expect(orderOf(html, ['Nypausad', 'Langepausad'])).toEqual(['Langepausad', 'Nypausad']);
    // The buckets are rendered as separate groups; the parked pair is not in
    // the Behöver dig group.
    const behoverGroup = html.split('Pausade')[0];
    expect(behoverGroup).toContain('Behover');
    expect(behoverGroup).not.toContain('Langepausad');
  });

  // Round-14: Pausade sits directly under Behöver dig, the same order the
  // overview uses — the two surfaces must read the same way.
  it('Pausade renders directly under Behöver dig, above Öppna and Stängda', () => {
    const cases = [
      mk({ conv_id: 10, kommun_namn: 'Oppen', state: 'SENT', open_esc: 0, follow_up_at: '2026-08-01' }),
      mk({ conv_id: 11, kommun_namn: 'Stangd', state: 'DONE', open_esc: 0 }),
      mk({ conv_id: 12, kommun_namn: 'Pausad', deferred_esc: 1, open_esc: 0 }),
      mk({ conv_id: 13, kommun_namn: 'Rod', open_esc: 1 }),
    ];
    const html = renderArenden({ cases });
    const headings = ['Behöver dig', 'Pausade', 'Öppna', 'Stängda'].map((h) => html.indexOf(`${h} <span class="count"`));
    expect(headings.every((i) => i > -1)).toBe(true);
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);
  });

  // A parked draft NEXT TO pending work stays in Behöver dig: buildActionQueue
  // and buildDeferred both key on the escalation, so the case is red there —
  // claiming it for Pausade here would make the two surfaces disagree.
  it.each([
    ['an active escalation', { open_esc: 1 }],
    ['a pending hänvisning', { open_esc: 0, has_pending_handoff: true }],
  ])('a deferred case with %s stays in Behöver dig', (_label, extra) => {
    const cases = [mk({ conv_id: 14, kommun_namn: 'Bada', deferred_esc: 1, state: 'SENT', ...extra })];
    const html = renderArenden({ cases });
    expect(html).toContain('Behöver dig');
    expect(html).not.toContain('Pausade');
  });

  // A parked row on a closed case must not resurrect it — terminal stays first,
  // the round-13 R1 ordering rule.
  it('a terminal case with a deferred row stays in Stängda', () => {
    const cases = [mk({ conv_id: 9, kommun_namn: 'Stangd', state: 'DONE', deferred_esc: 1, open_esc: 0 })];
    const html = renderArenden({ cases });
    expect(html).toContain('Stängda');
    expect(html).not.toContain('Pausade');
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
