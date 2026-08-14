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

describe('undocumented ignores what we never asked for', () => {
  // T_INITIAL explicitly disclaims bilagor and PUB-avtal, so counting them as
  // "missing" contradicts our own request. And a mention flagged as shut down
  // is not a contract anyone can send. Essunga's draft claimed contracts were
  // missing on the strength of one line inside a Unikum contract:
  //   { vendor: 'Pluttra', product: 'Dokumentationsverktyg (nedlagt)' }
  const rowWith = (mentions) => ([{
    is_contract: 1, vendor_name: 'Unikum',
    analysis_json: JSON.stringify({ mentioned_agreements: mentions }),
  }]);

  it('does not treat a discontinued tool as a missing contract', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Pluttra', product: 'Dokumentationsverktyg (nedlagt)', doc_attached: false },
    ]));
    expect(f.undocumented).toEqual([]);
    expect(f.has_missing).toBe(false);
  });

  it('ignores the annexes and PUB-avtal our own request disclaims', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Skola24', product: 'Personuppgiftsbiträdesavtal', doc_attached: false },
      { vendor: 'Teachiq', product: 'PUB-avtal', doc_attached: false },
      { vendor: 'Atea', product: 'Servicenivåavtal (SLA)', doc_attached: false },
      { vendor: 'IST', product: 'Kravspecifikation bilaga 3', doc_attached: false },
    ]));
    expect(f.undocumented).toEqual([]);
  });

  it('still reports a genuinely missing contract', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Gleerups', product: 'Digitala läromedel', doc_attached: false },
    ]));
    expect(f.undocumented.map((u) => u.name ?? u.canonical)).toEqual(['Gleerups']);
    expect(f.has_missing).toBe(true);
  });
});

describe('undocumented stays inside the scope we asked about', () => {
  // Aneby answered with a municipality-wide avtalskatalog and supplier ledger.
  // Read literally they say Aneby "owes" us contracts for kitchen software,
  // printers and debt collection. Our request was digital tools for SKOLA —
  // an out-of-scope line is not a missing contract.
  const rowWith = (mentions) => ([{
    is_contract: 0, vendor_name: null,
    analysis_json: JSON.stringify({ mentioned_agreements: mentions }),
  }]);

  it('drops catering, furniture, transport, print and finance lines', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Matilda FoodTech', product: 'Kostplattform för skolmåltider', doc_attached: false },
      { vendor: 'Lekolar', product: 'Skolmöbler/Förskolemöbler/Lekmaterial', doc_attached: false },
      { vendor: 'Buss i Väst', product: 'Skolskjuts', doc_attached: false },
      { vendor: 'Konica Minolta', product: 'Skrivare/MFP', doc_attached: false },
      { vendor: 'Visma Amili', product: 'Ekonomisystem/inkasso', doc_attached: false },
      { vendor: 'Phoniro Systems', product: 'Vård-/omsorgssystem', doc_attached: false },
    ]));
    expect(f.undocumented).toEqual([]);
  });

  it('keeps the school digital tools in the same list', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'SchoolSoft', product: 'Lärplattform', doc_attached: false },
      { vendor: 'Infomentor', product: 'lärplattform för förskola och grundskola', doc_attached: false },
      { vendor: 'Lekolar', product: 'Skolmöbler', doc_attached: false },
      // Skolon is a role:'channel' in the KB, so it is filed as a channel (we
      // ask for the kommun's avrop behind it) rather than a missing contract.
      { vendor: 'Skolon', product: 'Digitala Läromedel 2022', doc_attached: false },
    ]));
    expect(f.undocumented.map((u) => u.name ?? u.canonical).sort())
      .toEqual(['Infomentor', 'SchoolSoft']);
    expect(f.channels_seen.map((c) => c.canonical)).toContain('Skolon');
  });
});

describe('a bare vendor name from a ledger is not a claim', () => {
  // An invoice ledger yields {vendor:"Visma Amili", product:""} — a name we
  // were paid-by-invoice evidence for, with nothing saying it is a school
  // agreement. Unknown company + no description = we do not know what it is,
  // so we must not tell a kommun they owe us its contract.
  const rowWith = (mentions) => ([{
    is_contract: 0, vendor_name: null,
    analysis_json: JSON.stringify({ mentioned_agreements: mentions }),
  }]);

  it('drops an unknown vendor with no description when it came from a ledger', () => {
    // Contrast with the mention-inside-a-real-avtal case above, which IS kept
    // verbatim: there the kommun's own contract names the other agreement.
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Visma Amili', product: '', doc_attached: false },
      { vendor: 'Secure Appbox', product: null, doc_attached: false },
      { vendor: 'Höglandsförbundet', doc_attached: false },
    ]));
    expect(f.undocumented).toEqual([]);
  });

  it('keeps a KNOWN school supplier even with no description', () => {
    // The KB already tells us SchoolSoft is a lärplattform, so the missing
    // description costs us nothing.
    const f = buildCoverageFacts(rowWith([
      { vendor: 'SchoolSoft', product: '', doc_attached: false },
      { vendor: 'Advania', product: '', doc_attached: false },
    ]));
    expect(f.undocumented.map((u) => u.name ?? u.canonical)).toEqual(['SchoolSoft']);
  });

  it('recognises the real out-of-scope wording from the fleet', () => {
    const f = buildCoverageFacts(rowWith([
      { vendor: 'Matilda FoodTech', product: 'Kostdatasystem', doc_attached: false },
      { vendor: 'CGI', product: 'Ekonomi- och inköpssystem', doc_attached: false },
      { vendor: 'Mediacenter', product: 'AV-produkter, hemelektronik och tjänster', doc_attached: false },
      { vendor: 'Macsupport', product: 'Plattor och Chromebooks med tillbehör 2022', doc_attached: false },
      { vendor: 'Konica Minolta', product: 'Skrivare och multifunktionsskrivare', doc_attached: false },
    ]));
    expect(f.undocumented).toEqual([]);
  });
});
