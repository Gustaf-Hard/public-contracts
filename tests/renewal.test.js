import { describe, it, expect } from 'vitest';
import { nextRenewalDrafts } from '../src/renewal.js';

const now = new Date('2026-07-05T12:00:00Z');
const c = (id, kod, vendor, end, extra = {}) => ({
  id, kommun_kod: kod, kommun_namn: `K${kod}`, vendor_name: vendor, period_end: end, is_contract: 1, ...extra,
});

describe('nextRenewalDrafts (pure §7 groundwork — not wired)', () => {
  it('batches all expiring contracts of one kommun into ONE draft', () => {
    const drafts = nextRenewalDrafts([
      c(1, '1440', 'Skolon', '2026-08-01'),
      c(2, '1440', 'Unikum', '2026-07-20'),
      c(3, '0180', 'Binogi', '2026-08-15'),
    ], { now });
    expect(drafts).toHaveLength(2);
    expect(drafts[0].kommun_kod).toBe('1440'); // soonest-expiring first
    expect(drafts[0].contracts.map((x) => x.vendor_name)).toEqual(['Unikum', 'Skolon']);
    expect(drafts[1].kommun_kod).toBe('0180');
  });

  it('excludes far-future expiries, decade-old expiries, non-contracts and null period_end', () => {
    const drafts = nextRenewalDrafts([
      c(1, '1440', 'Skolon', '2027-06-30'),               // > horizon
      c(2, '1440', 'Gammal', '2014-12-31'),               // historical
      c(3, '1440', 'Följebrev', '2026-07-20', { is_contract: 0 }),
      c(4, '1440', 'Okänd', null),
    ], { now });
    expect(drafts).toEqual([]);
  });

  it('includes recently-expired contracts within the grace window', () => {
    const drafts = nextRenewalDrafts([c(1, '1440', 'Skolon', '2026-06-01')], { now });
    expect(drafts).toHaveLength(1);
    const none = nextRenewalDrafts([c(1, '1440', 'Skolon', '2026-06-01')], { now, graceDays: 10 });
    expect(none).toEqual([]);
  });

  it('requires an explicit now — no wall-clock ambush in tests or replays', () => {
    expect(() => nextRenewalDrafts([])).toThrow(/now/);
  });
});
