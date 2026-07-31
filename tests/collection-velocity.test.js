import { describe, it, expect } from 'vitest';
import { buildVelocityFacts, isoWeek, median } from '../src/collection-velocity.js';

const NOW = '2026-07-31T00:00:00Z';

describe('isoWeek', () => {
  it('buckets to ISO weeks starting Monday', () => {
    expect(isoWeek('2026-07-31T09:00:00Z')).toMatchObject({ iso_week: '2026-W31', week_start: '2026-07-27' });
    // Sunday belongs to the week that started the previous Monday.
    expect(isoWeek('2026-07-26T23:00:00Z')).toMatchObject({ week_start: '2026-07-20' });
  });
});

describe('median', () => {
  it('is the middle value, averages the middle pair, and is null when empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();   // never 0 — that would read as "instant"
  });
});

describe('buildVelocityFacts', () => {
  const events = [
    { conversation_id: 1, kommun_namn: 'A', received_at: '2026-07-06T10:00:00Z' }, // W28
    { conversation_id: 1, kommun_namn: 'A', received_at: '2026-07-06T11:00:00Z' }, // W28
    { conversation_id: 2, kommun_namn: 'B', received_at: '2026-07-27T10:00:00Z' }, // W31
  ];
  const timings = [
    { conversation_id: 1, kommun_namn: 'A', first_outbound_at: '2026-07-01T00:00:00Z',
      first_human_inbound_at: '2026-07-03T00:00:00Z', first_contract_at: '2026-07-06T10:00:00Z' },
    { conversation_id: 2, kommun_namn: 'B', first_outbound_at: '2026-07-01T00:00:00Z',
      first_human_inbound_at: '2026-07-11T00:00:00Z', first_contract_at: '2026-07-27T10:00:00Z' },
    { conversation_id: 3, kommun_namn: 'C', first_outbound_at: '2026-07-21T00:00:00Z',
      first_human_inbound_at: null, first_contract_at: null },
  ];
  const files = { total: 10, by_type: [{ document_type: 'avtal', n: 3 }, { document_type: 'bilaga', n: 7 }] };
  const facts = () => buildVelocityFacts({ contractEvents: events, caseTimings: timings, files, now: NOW });

  it('buckets avtal by week and fills the empty weeks between', () => {
    const w = facts().weeks;
    // W28 and W31 have data; W29 and W30 are empty but MUST be present, so a
    // gap in collection reads as a gap rather than disappearing.
    expect(w.map((x) => x.iso_week)).toEqual(['2026-W28', '2026-W29', '2026-W30', '2026-W31']);
    expect(w.map((x) => x.contracts)).toEqual([2, 0, 0, 1]);
    expect(w.map((x) => x.cumulative)).toEqual([2, 2, 2, 3]);
    expect(w.map((x) => x.kommuner)).toEqual([1, 0, 0, 1]);
  });

  it('reports medians with range and sample size, over conversations', () => {
    const t = facts().timings;
    expect(t.first_human_reply).toMatchObject({ median: 6, min: 2, max: 10, n: 2, of: 3 });
    // Contracts land at 10:00, so the spans are 5.4 d and 26.4 d — the fractions
    // are kept rather than floored, otherwise a same-day delivery reads as 0.
    expect(t.first_contract).toMatchObject({ median: 15.9, min: 5.4, max: 26.4, n: 2, of: 3 });
  });

  it('counts the funnel from real events', () => {
    expect(facts().funnel).toEqual({ contacted: 3, human_replied: 2, delivered: 2 });
  });

  it('lists still-silent kommuner, longest wait first', () => {
    expect(facts().silent).toEqual([{ conversation_id: 3, kommun_namn: 'C', days_waiting: 10 }]);
  });

  it('passes the file split through, with avtal derived from by_type', () => {
    expect(facts().files).toMatchObject({ total: 10, avtal: 3 });
  });

  it('drops negative durations rather than counting them as zero', () => {
    // An inbound stamped before our first outbound (clock skew / late match).
    const odd = [{ conversation_id: 9, kommun_namn: 'Z', first_outbound_at: '2026-07-10T00:00:00Z',
      first_human_inbound_at: '2026-07-01T00:00:00Z', first_contract_at: null }];
    const f = buildVelocityFacts({ contractEvents: [], caseTimings: odd, files, now: NOW });
    expect(f.timings.first_human_reply).toMatchObject({ median: null, n: 0, of: 1 });
  });

  it('is safe on an empty pilot', () => {
    const f = buildVelocityFacts({ contractEvents: [], caseTimings: [], files: { total: 0, by_type: [] }, now: NOW });
    expect(f.weeks).toEqual([]);
    expect(f.timings.first_contract).toMatchObject({ median: null, n: 0, of: 0 });
    expect(f.funnel).toEqual({ contacted: 0, human_replied: 0, delivered: 0 });
  });
});
