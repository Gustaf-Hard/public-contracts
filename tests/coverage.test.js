import { describe, it, expect } from 'vitest';
import { buildCoverageFacts } from '../src/coverage.js';

// Rows are in the storage `listContractInfoForMessage` / `-ForConversation`
// projection: { is_contract, vendor_name, analysis_json }.
const row = (is_contract, vendor_name, analysis) => ({
  is_contract, vendor_name, analysis_json: JSON.stringify(analysis ?? {}),
});

describe('buildCoverageFacts', () => {
  it('replays Borlänge: Magma delivered means Radish received, channels are never missing', () => {
    // The bug this fixes: the old draft thanked for Matteappen, asked for the
    // "still missing" Radish contract (maker of the delivered Magma), re-asked
    // for Magma, and listed Adda/LäroMedia as missing contracts.
    const rows = [
      row(1, 'Magma', {
        products: ['Magma'],
        mentioned_agreements: [
          { vendor: 'Adda', product: '', doc_attached: false },
          { vendor: 'LäroMedia', product: '', doc_attached: false },
        ],
      }),
    ];
    const f = buildCoverageFacts(rows);
    expect(f.received.map((r) => r.slug)).toEqual(['radish']);
    expect(f.received[0]).toMatchObject({ canonical: 'Radish', role: 'service', products: ['Magma'] });
    expect(f.not_yet_seen.map((c) => c.slug)).not.toContain('radish');
    expect(f.undocumented).toEqual([]);
    expect(f.channels_seen.map((c) => c.slug)).toEqual(['adda', 'laromedia']);
    expect(f.has_missing).toBe(false);
  });

  it('never re-asks for a company already received under another of its names', () => {
    const rows = [
      row(1, 'Polyglutt', { products: ['Polyglutt'], mentioned_agreements: [] }),
      row(0, null, { mentioned_agreements: [{ vendor: 'ILT Education', product: '', doc_attached: false }] }),
    ];
    const f = buildCoverageFacts(rows);
    expect(f.received.map((r) => r.slug)).toEqual(['ilt']);
    expect(f.undocumented).toEqual([]);
    expect(f.not_yet_seen.map((c) => c.slug)).not.toContain('ilt');
  });

  it('lists a genuinely undocumented service as missing', () => {
    const rows = [
      row(1, 'Unikum', { products: [], mentioned_agreements: [] }),
      row(0, null, { mentioned_agreements: [{ vendor: 'Vklass', product: '', doc_attached: false }] }),
    ];
    const f = buildCoverageFacts(rows);
    expect(f.undocumented.map((u) => u.slug)).toEqual(['vklass']);
    expect(f.has_missing).toBe(true);
  });

  it('preserves KB-unknown names verbatim instead of inventing or dropping them', () => {
    const rows = [
      row(1, 'Helt Okänt AB', { products: [], mentioned_agreements: [
        { vendor: 'Annat Okänt AB', product: '', doc_attached: false },
      ] }),
    ];
    const f = buildCoverageFacts(rows);
    expect(f.received).toEqual([]);
    expect(f.received_unresolved).toEqual(['Helt Okänt AB']);
    expect(f.undocumented).toEqual([{ name: 'Annat Okänt AB' }]);
    expect(f.has_missing).toBe(true);
  });

  it('not_yet_seen lists watchlist companies with no trace at all, by probe label', () => {
    const f = buildCoverageFacts([row(1, 'Magma', { products: ['Magma'], mentioned_agreements: [] })]);
    // Radish is received; the other three watchlist companies are untouched.
    expect(f.not_yet_seen.map((c) => c.probeLabel).sort()).toEqual(['Binogi', 'Inläsningstjänst', 'NE']);
  });

  it('a merely mentioned watchlist company is not "not yet seen" (we know they use it)', () => {
    const rows = [row(0, null, { mentioned_agreements: [{ vendor: 'NE', product: '', doc_attached: false }] })];
    const f = buildCoverageFacts(rows);
    expect(f.undocumented.map((u) => u.slug)).toContain('ne');
    expect(f.not_yet_seen.map((c) => c.slug)).not.toContain('ne');
  });

  it('deduplicates and tolerates object analysis_json, empty input and junk', () => {
    const rows = [
      { is_contract: 1, vendor_name: 'NE', analysis_json: { products: ['NE Junior'], mentioned_agreements: [] } },
      { is_contract: 1, vendor_name: 'NE.se', analysis_json: 'not json at all' },
      { is_contract: 0, vendor_name: null, analysis_json: null },
    ];
    const f = buildCoverageFacts(rows);
    expect(f.received.map((r) => r.slug)).toEqual(['ne']);
    expect(f.received[0].products).toEqual(['NE Junior']);
    expect(buildCoverageFacts()).toMatchObject({ received: [], undocumented: [], has_missing: false });
  });

  it('credits the service, not the reseller, when a contract row names both', () => {
    // Realistic Atea/Skolon shape: the extracted vendor is the reseller, the
    // product is the real service. Crediting only Atea would leave us probing
    // ILT for a contract we already hold.
    const f = buildCoverageFacts([row(1, 'Atea', { products: ['Polyglutt'], mentioned_agreements: [] })]);
    expect(f.received.map((r) => r.slug)).toEqual(['ilt']);
    expect(f.channels_seen.map((c) => c.slug)).toEqual(['atea']);
    expect(f.not_yet_seen.map((c) => c.slug)).not.toContain('ilt');
  });

  it('a channel appearing as a real contract row is a channel, not a received service', () => {
    // An Adda ramavtal PDF is a genuine document, but Adda is not a service we
    // want an avtal from — it drives the avrop ask instead.
    const f = buildCoverageFacts([row(1, 'Adda', { products: [], mentioned_agreements: [] })]);
    expect(f.received).toEqual([]);
    expect(f.channels_seen.map((c) => c.slug)).toEqual(['adda']);
  });
});
