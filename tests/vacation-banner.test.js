import { describe, it, expect } from 'vitest';
import { renderOverview } from '../src/dashboard-views.js';

const baseArgs = {
  summary: { in_pilot: 0, delivering: 0, done: 0, dead_end: 0, contracts: 0, avg_reply_days: null },
  rows: [],
  filter: 'active',
  sort: null, order: null, totalKommuner: 0,
  actionQueue: [], waiting: [],
};

describe('renderOverview vacation banner', () => {
  it('shows the Sommarläge banner when vacationActive is true', () => {
    const html = renderOverview({ ...baseArgs, vacationActive: true });
    expect(html).toContain('Sommarläge');
    expect(html).toContain('automatisk bevakning pausad t.o.m. 30 juli');
  });

  it('omits the banner when vacationActive is false (default)', () => {
    const html = renderOverview({ ...baseArgs });
    expect(html).not.toContain('Sommarläge');
    // The CSS class is always defined in the stylesheet; the banner element is not.
    expect(html).not.toContain('class="vacation-banner"');
  });
});
