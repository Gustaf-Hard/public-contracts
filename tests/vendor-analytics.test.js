// tests/vendor-analytics.test.js
// Pure analytics layer for the vendor data center
// (2026-07-09-vendor-data-center-design.md Part 2). All avtalsvarde strings
// below are real rows from the live DB (read-only inspection).
import { describe, it, expect } from 'vitest';
import {
  normalizeAnnualValue,
  buildContractFacts,
  buildVendorRollups,
  buildMarketSummary,
  completeness,
} from '../src/vendor-analytics.js';

const NOW = new Date('2026-07-09T12:00:00Z');

describe('normalizeAnnualValue — structured fields take precedence', () => {
  it('uses the analyser-provided annual_value_sek when present', () => {
    expect(normalizeAnnualValue({ annual_value_sek: 120000, avtalsvarde: 'nonsense' }, { now: NOW })).toBe(120000);
  });

  it('accepts an explicit analyser 0 (true zero, not fabricated)', () => {
    expect(normalizeAnnualValue({ annual_value_sek: 0 }, { now: NOW })).toBe(0);
  });

  it('pricing_model free → 0 even without a value', () => {
    expect(normalizeAnnualValue({ pricing_model: 'free' }, { now: NOW })).toBe(0);
  });

  it('derives unit_price × quantity for per-student pricing', () => {
    expect(normalizeAnnualValue({
      pricing_model: 'per_student', unit_price_sek: 40, quantity: 3744,
    }, { now: NOW })).toBe(149760);
  });

  it('derives unit_price × quantity for per-user pricing', () => {
    expect(normalizeAnnualValue({
      pricing_model: 'per_user', unit_price_sek: 50, quantity: 3400,
    }, { now: NOW })).toBe(170000);
  });

  it('ignores a negative or non-finite analyser value', () => {
    expect(normalizeAnnualValue({ annual_value_sek: -5 }, { now: NOW })).toBeNull();
    expect(normalizeAnnualValue({ annual_value_sek: NaN }, { now: NOW })).toBeNull();
  });
});

describe('normalizeAnnualValue — avtalsvarde text fallback (real live shapes)', () => {
  const n = (avtalsvarde, extra = {}) => normalizeAnnualValue({ avtalsvarde, ...extra }, { now: NOW });

  it('monthly ×12: "80 417 SEK per månad"', () => {
    expect(n('80 417 SEK per månad')).toBe(965004);
  });

  it('monthly with trailing one-time noise: "69 008 kr/månad (support) samt 200 000 kr engångskostnad införande"', () => {
    expect(n('69 008 kr/månad (support) samt 200 000 kr engångskostnad införande; huvudavtal underhåll 69 008 kr/månad')).toBe(828096);
  });

  it('tkr shorthand: "129 tkr/år"', () => {
    expect(n('129 tkr/år')).toBe(129000);
  });

  it('annual with decimal + parenthetical: "612 500,00 kr/år (sitelicens)"', () => {
    expect(n('612 500,00 kr/år (sitelicens)')).toBe(612500);
  });

  it('annual "per år" wording: "30 000 SEK per år, inklusive moms"', () => {
    expect(n('30 000 SEK per år, inklusive moms')).toBe(30000);
  });

  it('total-with-annual-inside: picks the kr/år figure, not the multi-year total', () => {
    expect(n('94 435 000 kr totalt (förvaltningsavgift 4 955 221 kr/år, införandeprojekt 2 806 685 kr fast)')).toBe(4955221);
  });

  it('multi-kommun list with a stated total: prefers "totalt … kr/år"', () => {
    expect(n('Årsavgift/kommunlicens: Arboga 48 750 kr/år, Köping 94 500 kr/år, Kungsör 33 750 kr/år (totalt 177 000 kr/år)')).toBe(177000);
  });

  it('per-elev with student count: current (first-listed) tier × count', () => {
    expect(n('2025: 40 kr/elev (3744 elever); från 2026: 95 kr/elev grundskola (3744 elever) och 50 kr/elev gymnasium (120 elever), ex. moms')).toBe(149760);
  });

  it('escalating schedule: current contract year from period_start (year 2 mid-2026)', () => {
    expect(n('585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3', { period_start: '2025-01-31' })).toBe(615767);
  });

  it('escalating schedule without period_start defaults to year 1', () => {
    expect(n('585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3')).toBe(585649);
  });

  it('escalating schedule clamps past the last listed year', () => {
    expect(n('585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3', { period_start: '2020-01-01' })).toBe(624182);
  });

  it('plain kr/år beats an "år 1" parenthetical when both appear', () => {
    // StudyBee: steady-state 63 498 kr/år is the headline figure.
    expect(n('63 498 kr/år (år 1: 79 498 kr)')).toBe(63498);
  });

  it('explicitly free: "Ingen årlig abonnemangskostnad …" → 0', () => {
    expect(n('Ingen årlig abonnemangskostnad för Unikum Arkiv Start')).toBe(0);
  });

  // --- honesty: unknown is null, never a fabricated number ---

  it('bare amount without a period marker is unknown: "121 272 SEK"', () => {
    expect(n('121 272 SEK')).toBeNull();
  });

  it('per-day consulting rates are not annual: "9 800 kr per dag (konsulttjänster/utbildning)"', () => {
    expect(n('9 800 kr per dag (konsulttjänster/utbildning)')).toBeNull();
  });

  it('per-user price without a count is unknown: "43,90 kr/användare/år (…)"', () => {
    expect(n('43,90 kr/användare/år (summa underhållsavgift enligt bilaga A)')).toBeNull();
  });

  it('per-elev without a machine-readable count is unknown', () => {
    expect(n('80 kr per elev och läsår (ca 106 000 kr + moms första året)')).toBeNull();
  });

  it('a kr/år figure qualified "per <unit>" with unknown unit count is unknown', () => {
    // Unikum: 110 000 kr/år PER MODUL — number of modules not stated.
    expect(n('232 tkr exkl. moms (engångsavrop), 110 000 kr/år per modul')).toBeNull();
  });

  it('schedule parsing never mistakes a per-unit price for a year amount', () => {
    // DigiExam: year 1 fixed 11 000 kr; from year 2 it is 85 kr PER ELEV with
    // no count — the 85 must not be read as "year 2 costs 85 kr".
    expect(n('År 1: Fastpris 11 000 kr ex moms (Åk 9); från år 2: 85 kr per elevlicens/år ex moms', { period_start: '2019-05-08' })).toBe(11000);
  });

  it('null / empty / non-numeric text is unknown', () => {
    expect(n(null)).toBeNull();
    expect(n('')).toBeNull();
    expect(n('okänt')).toBeNull();
  });

  it('non-SEK valuta skips the text parse', () => {
    expect(n('30 000 kr/år', { valuta: 'EUR' })).toBeNull();
  });
});

// ---- fixture facts input: shaped like db.listContractFacts() rows ----

function row(over = {}) {
  return {
    contract_id: 1, vendor_id: 1, vendor_name: 'Skolon', vendor_slug: 'skolon',
    kommun_kod: '1980', kommun_namn: 'Västerås',
    avtalsvarde: '170 000 SEK/år', valuta: 'SEK',
    period_start: '2024-03-01', period_end: '2026-03-01',
    auto_renews: null, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
    annual_value_sek: 170000, one_time_value_sek: 7500, pricing_model: 'per_user',
    unit_price_sek: 50, unit: 'användare', quantity: 3400, value_incl_moms: 0,
    confidence: 0.95, summary: 'Avtal', attachment_id: 11, filename: 'Avtal.pdf',
    received_at: '2026-04-13T10:00:00Z', products: ['Skolon Plattform'],
    ...over,
  };
}

const LAN = new Map([['1980', 'Västmanlands län'], ['0180', 'Stockholms län'], ['1489', 'Västra Götalands län']]);

describe('buildContractFacts', () => {
  it('normalizes value, resolves län, contract length and next review date', () => {
    const facts = buildContractFacts([row()], { lanByKommunKod: LAN, now: NOW });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      vendor_name: 'Skolon', kommun_namn: 'Västerås', lan: 'Västmanlands län',
      annual_value_sek: 170000, pricing_model: 'per_user',
      contract_length_months: 24,
      period_end: '2026-03-01',
      next_review_date: '2026-03-01', // plain fixed term → period_end
      attachment_id: 11, filename: 'Avtal.pdf',
    });
    expect(facts[0].products).toEqual(['Skolon Plattform']);
  });

  it('auto-renew contract gets next_review_date from the cancellation window (reuses computeNextReviewDate)', () => {
    const facts = buildContractFacts([row({
      auto_renews: 1, last_cancellation_date: '2026-09-30', period_end: '2026-12-31',
    })], { lanByKommunKod: LAN, now: NOW });
    expect(facts[0].next_review_date).toBe('2026-10-01');
    expect(facts[0].auto_renews).toBe(true);
  });

  it('falls back to text parsing for rows analysed before the pricing backfill', () => {
    const facts = buildContractFacts([row({ annual_value_sek: null, pricing_model: null, unit_price_sek: null, quantity: null, avtalsvarde: '129 tkr/år' })], { lanByKommunKod: LAN, now: NOW });
    expect(facts[0].annual_value_sek).toBe(129000);
  });

  it('keeps unknowns null: no value, no period → null value/length/review, unknown län → null', () => {
    const facts = buildContractFacts([row({
      annual_value_sek: null, pricing_model: null, unit_price_sek: null, quantity: null,
      avtalsvarde: '121 272 SEK', period_start: null, period_end: null, kommun_kod: '9999',
    })], { lanByKommunKod: LAN, now: NOW });
    expect(facts[0].annual_value_sek).toBeNull();
    expect(facts[0].contract_length_months).toBeNull();
    expect(facts[0].next_review_date).toBeNull();
    expect(facts[0].lan).toBeNull();
  });
});

describe('buildVendorRollups', () => {
  const facts = buildContractFacts([
    row(), // Skolon, Västerås, 170 000, 24 mån, per_user, review 2026-03-01 (past)
    row({ contract_id: 2, kommun_kod: '0180', kommun_namn: 'Stockholm', attachment_id: 12,
          annual_value_sek: 200000, period_start: '2025-01-01', period_end: '2028-01-01',
          pricing_model: 'fixed', unit_price_sek: null, unit: null, quantity: null }),
    row({ contract_id: 3, kommun_kod: '1489', kommun_namn: 'Alingsås', attachment_id: 13,
          annual_value_sek: null, avtalsvarde: '121 272 SEK', pricing_model: null,
          unit_price_sek: null, unit: null, quantity: null,
          period_start: null, period_end: null, products: [] }),
    row({ contract_id: 4, vendor_id: 2, vendor_name: 'Radish', vendor_slug: 'radish',
          kommun_kod: '0180', kommun_namn: 'Stockholm', attachment_id: 14,
          annual_value_sek: 149760, pricing_model: 'per_student',
          unit_price_sek: 40, unit: 'elev', quantity: 3744,
          period_start: '2025-01-01', period_end: '2028-12-31', products: ['Läsappen'] }),
    row({ contract_id: 5, vendor_id: null, vendor_name: null, vendor_slug: null,
          kommun_kod: '1980', attachment_id: 15, annual_value_sek: null, avtalsvarde: null,
          pricing_model: null, unit_price_sek: null, unit: null, quantity: null }),
  ], { lanByKommunKod: LAN, now: NOW });

  const rollups = buildVendorRollups(facts, { now: NOW });

  it('one rollup per named vendor; vendor-less contracts are not a vendor row', () => {
    expect(rollups.map((r) => r.vendor_name).sort()).toEqual(['Radish', 'Skolon']);
  });

  it('counts kommuner and contracts, sums only known values, tracks completeness', () => {
    const skolon = rollups.find((r) => r.vendor_name === 'Skolon');
    expect(skolon.contract_count).toBe(3);
    expect(skolon.kommun_count).toBe(3);
    expect(skolon.total_annual_sek).toBe(370000); // 170 000 + 200 000, third unknown
    expect(skolon.value_known_count).toBe(2);
  });

  it('dominant pricing model + full mix', () => {
    const skolon = rollups.find((r) => r.vendor_name === 'Skolon');
    expect(skolon.pricing_model_mix).toEqual({ per_user: 1, fixed: 1 });
    expect(['per_user', 'fixed']).toContain(skolon.dominant_pricing_model); // tie → deterministic
    expect(rollups.find((r) => r.vendor_name === 'Radish').dominant_pricing_model).toBe('per_student');
  });

  it('median + average contract length over known lengths only', () => {
    const skolon = rollups.find((r) => r.vendor_name === 'Skolon');
    expect(skolon.length_known_count).toBe(2); // 24 + 36 months
    expect(skolon.median_length_months).toBe(30);
    expect(skolon.avg_length_months).toBe(30);
  });

  it('price-per-student range from unit prices with unit elev', () => {
    const radish = rollups.find((r) => r.vendor_name === 'Radish');
    expect(radish.price_per_student_min).toBe(40);
    expect(radish.price_per_student_max).toBe(40);
    const skolon = rollups.find((r) => r.vendor_name === 'Skolon');
    expect(skolon.price_per_student_min).toBeNull();
  });

  it('next_renewal_date is the earliest FUTURE review date', () => {
    const skolon = rollups.find((r) => r.vendor_name === 'Skolon');
    // 2026-03-01 is in the past at NOW; 2028-01-01 is the next future one.
    expect(skolon.next_renewal_date).toBe('2028-01-01');
  });

  it('total_annual_sek is null (not 0) when no contract value is known', () => {
    const only = buildVendorRollups(buildContractFacts([
      row({ annual_value_sek: null, avtalsvarde: null, pricing_model: null, unit_price_sek: null, quantity: null }),
    ], { lanByKommunKod: LAN, now: NOW }), { now: NOW });
    expect(only[0].total_annual_sek).toBeNull();
    expect(only[0].value_known_count).toBe(0);
  });

  it('sorted by total_annual_sek desc, unknown-value vendors last', () => {
    expect(rollups[0].vendor_name).toBe('Skolon');
  });
});

describe('buildMarketSummary + completeness', () => {
  const facts = buildContractFacts([
    row(),
    row({ contract_id: 2, vendor_id: 2, vendor_name: 'Radish', vendor_slug: 'radish',
          kommun_kod: '0180', attachment_id: 12, annual_value_sek: 149760,
          period_end: '2026-12-31' }),
    row({ contract_id: 3, vendor_id: null, vendor_name: null, vendor_slug: null,
          attachment_id: 13, annual_value_sek: null, avtalsvarde: null,
          pricing_model: null, unit_price_sek: null, quantity: null,
          period_start: null, period_end: null }),
  ], { lanByKommunKod: LAN, now: NOW });

  it('market totals with honest completeness counts', () => {
    const s = buildMarketSummary(facts, { now: NOW });
    expect(s.vendor_count).toBe(2);
    expect(s.kommun_count).toBe(2);
    expect(s.contract_count).toBe(3);
    expect(s.total_annual_sek).toBe(319760);
    expect(s.value_completeness).toEqual({ known: 2, total: 3 });
    expect(s.renewals_within_12mo).toBe(1); // 2026-12-31; 2026-03-01 past, null excluded
  });

  it('completeness counts non-null values for any key', () => {
    expect(completeness(facts, 'annual_value_sek')).toEqual({ known: 2, total: 3 });
    expect(completeness(facts, 'contract_length_months')).toEqual({ known: 2, total: 3 });
    expect(completeness([], 'annual_value_sek')).toEqual({ known: 0, total: 0 });
  });
});
