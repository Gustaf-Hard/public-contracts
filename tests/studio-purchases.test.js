// Purchase rows as their own evidence level in the studio. Synthetic rows.
import { describe, it, expect } from 'vitest';
import {
  buildPurchaseFacts, purchaseEvidenceLabel, purchasesFor, purchaseKods, purchaseKommuner, upcomingLicenceEnds, purchaseDocuments,
} from '../src/studio-purchases.js';

const TODAY = '2026-10-27';
const r = (over = {}) => ({
  id: 1, attachment_id: 10, row_index: 0, kommun_kod: '9001', kommun_namn: 'Exempelby', supplier: 'Skolon AB',
  product: 'Huvudmanslicens 1 år Binogi', channel: 'skolon', quantity: null, unit: null, amount_sek: 1000,
  order_date: null, period_start: null, period_end: null, school_year: null, grades: [], order_ref: null, method: 'llm', stated_total_sek: null, ...over,
});

describe('buildPurchaseFacts', () => {
  it('classifies each row to the product owner and keeps the channel', () => {
    const [f] = buildPurchaseFacts({ rows: [r()], today: TODAY });
    expect(f).toMatchObject({ company_slug: 'binogi', product_slug: 'binogi', channel_slug: 'skolon', category: 'laromedel' });
  });

  it('licensperiod: own period end first, else the end of the läsår, else unknown', () => {
    const [a, b, c] = buildPurchaseFacts({ rows: [
      r({ id: 1, row_index: 0, period_end: '2027-01-31', school_year: '2025/26' }),
      r({ id: 2, row_index: 1, school_year: '2025/26' }),
      r({ id: 3, row_index: 2 }),
    ], today: TODAY });
    expect(a).toMatchObject({ licence_end: '2027-01-31', licence_basis: 'period', current: true });
    expect(b).toMatchObject({ licence_end: '2026-06-30', licence_basis: 'lasar', current: false });
    expect(c).toMatchObject({ licence_end: null, licence_basis: null, current: null });
  });

  it('the same order line in two lists of one kommun counts once', () => {
    const rows = [
      r({ id: 1, attachment_id: 10, order_ref: 'IN1/001' }),
      r({ id: 2, attachment_id: 11, order_ref: 'IN1/001' }),
      r({ id: 3, attachment_id: 11, order_ref: 'IN1/001', kommun_kod: '9002' }),
      r({ id: 4, attachment_id: 12, row_index: 0 }),
      r({ id: 5, attachment_id: 12, row_index: 1 }),
    ];
    const pf = buildPurchaseFacts({ rows, today: TODAY });
    expect(pf.map((p) => p.id)).toEqual([1, 3, 4, 5]);
  });
});

describe('scopes and summaries', () => {
  const pf = buildPurchaseFacts({ rows: [
    r({ id: 1, row_index: 0, period_end: '2027-06-30' }),
    r({ id: 2, row_index: 1, product: 'Singellicens 12 mån för Exempelverktyg', school_year: '2024/25' }),
    r({ id: 3, attachment_id: 20, kommun_kod: '9002', kommun_namn: 'Annanby', supplier: 'Gleerups Utbildning AB', product: null, channel: null, stated_total_sek: 5000 }),
  ], today: TODAY });

  it('labels: via a channel, else the kommun\'s inköpslista', () => {
    expect(purchaseEvidenceLabel('skolon')).toBe('Köpt via Skolon');
    expect(purchaseEvidenceLabel('laromedia')).toBe('Köpt via Läromedia');
    expect(purchaseEvidenceLabel(null)).toBe('Finns i kommunens inköpslista');
  });

  it('a company page sees its own rows; a channel page also what was bought through it', () => {
    expect(purchasesFor(pf, { companySlug: 'binogi' }).map((p) => p.id)).toEqual([1]);
    expect(purchasesFor(pf, { companySlug: 'skolon' }).map((p) => p.id)).toEqual([]);
    expect(purchasesFor(pf, { companySlug: 'skolon', viaChannel: true }).map((p) => p.id)).toEqual([1, 2]);
    expect(purchasesFor(pf, { productSlug: 'binogi' }).map((p) => p.id)).toEqual([1]);
    expect([...purchaseKods(purchasesFor(pf, { companySlug: 'gleerups' }))]).toEqual(['9002']);
  });

  it('per kommun: labels, the latest licensperiod, whether one runs on', () => {
    const k = purchaseKommuner(purchasesFor(pf, { companySlug: 'skolon', viaChannel: true }));
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ kommun_kod: '9001', labels: ['Köpt via Skolon'], n: 2, latest_end: '2027-06-30', current: true });
  });

  it('upcoming licence ends are soonest first and skip the past', () => {
    expect(upcomingLicenceEnds(pf, { today: TODAY }).map((p) => p.id)).toEqual([1]);
  });

  it('documents carry their own stated total, never a sum of rows', () => {
    const docs = purchaseDocuments(pf);
    expect(docs.find((d) => d.attachment_id === 10).stated_total_sek).toBeNull();
    expect(docs.find((d) => d.attachment_id === 20).stated_total_sek).toBe(5000);
  });
});
