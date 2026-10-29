// The follow-up probe list (2026-10-29): every product company in the
// catalogue, minus everything this kommun has shown us. Hand-written fixtures
// only: the repo is public, so no real kommun data.
import { describe, it, expect } from 'vitest';
import { buildProbeList, renderProbeList, collectMentions, skolformerFromStats, PROBE_CAP, MIN_GYMNASIE_ELEVER } from '../src/probe-list.js';
import { classifyVendor } from '../src/catalogue.js';
import { loadKommunStats } from '../src/kommun-stats.js';

const K = '9001';
const avtal = (id, vendor, products = [], kommun = K) => ({ contract_id: id, kommun_kod: kommun, vendor_name: vendor, products });
const bought = (supplier, kommun = K, channel = 'skolon') => ({ kommun_kod: kommun, supplier, product: null, channel });
const cov = (contractId, ...levels) => levels.map((g) => ({ contract_id: contractId, grade_level: g, status: 'full' }));

const entries = (probe, category) => probe.categories.filter((c) => c.category === category);
const namesIn = (probe, category) => entries(probe, category).flatMap((c) => c.names);
const allNames = (probe) => probe.categories.flatMap((c) => c.names);
const struckNames = (probe) => probe.struck.map((s) => s.name);
const reasonFor = (probe, name) => probe.struck.find((s) => s.name === name)?.reason ?? null;

describe('buildProbeList: the Bollebygd-like shape', () => {
  // NE, Gleerups and SchoolSoft avtal; Natur & Kultur, Liber, Sanoma, Nomp,
  // Musikoteket and Bitopia bought via Skolon.
  const probe = buildProbeList({
    kommunKod: K,
    contracts: [
      avtal(1, 'NE', ['AI-Martin']),
      avtal(2, 'Gleerups', ['Gleerups Utkik SO- och NO-ämnen 4-6']),
      avtal(3, 'SchoolSoft', ['SchoolSoft EA', 'Elevadministration skola', 'Barnadministration förskola']),
    ],
    coverage: cov(3, '1-3', '4-6', '7-9', 'Gymnasiet'),
    purchaseRows: ['Natur & Kultur', 'Liber', 'Sanoma Utbildning', 'Selessia AB (Nomp)', 'Musikoteket AB', 'Bitopia AB'].map((s) => bought(s)),
  });

  it('lists the läromedel nobody has shown us, by the name a kommun knows', () => {
    const names = namesIn(probe, 'laromedel');
    for (const n of ['ILT (Inläsningstjänst)', 'Radish (Magma)', 'Binogi', 'Skolplus']) expect(names).toContain(n);
  });

  it('never asks about an avtal we hold or a company bought via Skolon', () => {
    const names = allNames(probe);
    for (const n of ['NE', 'Gleerups', 'SchoolSoft', 'Natur & Kultur', 'Liber', 'Sanoma Utbildning', 'Nomp', 'Musikoteket']) {
      expect(names).not.toContain(n);
    }
    expect(reasonFor(probe, 'NE')).toMatch(/avtal/);
    expect(reasonFor(probe, 'SchoolSoft')).toMatch(/avtal/);
    expect(reasonFor(probe, 'Natur & Kultur')).toMatch(/Skolon/);
  });

  it('SchoolSoft settles lärplattform and the skoladministration functions it covers', () => {
    expect(entries(probe, 'larplattform')).toEqual([]);
    const admin = namesIn(probe, 'skoladministration');
    for (const n of ['IST', 'Tietoevry (Edlevo)', 'Skola24', 'Tempus', 'Quiculum', 'Royal Schedule', 'Tyra']) expect(admin).not.toContain(n);
    expect(reasonFor(probe, 'Unikum')).toMatch(/lärplattform.*SchoolSoft/);
    expect(reasonFor(probe, 'IST')).toMatch(/elevregister.*SchoolSoft/);
  });

  it('still asks about prov, which nothing on file covers', () => {
    expect(namesIn(probe, 'prov')).toContain('DigiExam');
  });

  it('renders grouped lines in plain Swedish with no dash separators', () => {
    const text = renderProbeList(probe);
    expect(text).toMatch(/^- Läromedel: /m);
    expect(text).toMatch(/^- Prov och bedömning: /m);
    expect(text).not.toMatch(/Lärplattform/);
    expect(text).not.toMatch(/[—–]/);
  });
});

describe('buildProbeList: exclusive categories follow the skolform', () => {
  it('a lärplattform avtal with unknown skolformer counts as grundskolan only: gymnasiet is still asked', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Unikum', ['Unikum'])] });
    const lp = entries(probe, 'larplattform');
    expect(lp).toHaveLength(1);
    expect(lp[0].note).toBe('för gymnasiet');
    expect(lp[0].names).toContain('itslearning');
    expect(lp[0].names).not.toContain('Unikum');
    expect(renderProbeList(probe)).toMatch(/^- Lärplattform för gymnasiet: /m);
  });

  it('coverage for grundskola and gymnasiet settles the category', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Unikum', ['Unikum'])], coverage: cov(1, '7-9', 'Gymnasiet') });
    expect(entries(probe, 'larplattform')).toEqual([]);
    expect(reasonFor(probe, 'itslearning')).toMatch(/lärplattform/);
  });

  it('a gymnasium-only avtal leaves the question open for grundskolan', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'itslearning', ['itslearning'])], coverage: cov(1, 'Gymnasiet') });
    const lp = entries(probe, 'larplattform');
    expect(lp).toHaveLength(1);
    expect(lp[0].note).toBe('för grundskolan');
  });

  it('a förskola-only avtal settles neither school form', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Unikum', ['Unikum'])], coverage: cov(1, 'Förskola') });
    const lp = entries(probe, 'larplattform');
    expect(lp).toHaveLength(1);
    expect(lp[0].note).toBeUndefined();
  });

  it('prov and elevhälsojournal follow the same rule', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'DigiExam', ['DigiExam']), avtal(2, 'Prorenata', ['ProReNata Journal'])] });
    const prov = entries(probe, 'prov').find((e) => e.note === 'för gymnasiet');
    expect(prov.names).toContain('Dugga');
    const eh = entries(probe, 'elevhalsa').find((e) => e.note === 'för gymnasiet');
    expect(eh.names).toEqual(['CompuGroup Medical (PMO)']);
  });
});

describe('buildProbeList: skoladministration is struck per function', () => {
  it('IST elevregister and Skola24 schema strike those functions, but not förskoleplacering', () => {
    const probe = buildProbeList({
      kommunKod: K,
      contracts: [avtal(1, 'IST', ['IST Administration']), avtal(2, 'Nova Software', ['Skola24 Schema'])],
    });
    const admin = namesIn(probe, 'skoladministration');
    for (const n of ['IST', 'Skola24', 'Tietoevry (Edlevo)', 'Royal Schedule', 'Quiculum', 'SchoolSoft']) expect(admin).not.toContain(n);
    expect(admin).toContain('Tempus');
    expect(admin).toContain('Tyra');
    expect(reasonFor(probe, 'Royal Schedule')).toMatch(/schema.*Skola24/);
    expect(reasonFor(probe, 'Tietoevry (Edlevo)')).toMatch(/elevregister.*IST/);
  });

  it('a suite avtal naming no tagged product covers the company functions', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'IST', [])] });
    expect(namesIn(probe, 'skoladministration')).not.toContain('Tempus');
  });
});

describe('buildProbeList: never probed', () => {
  const probe = buildProbeList({ kommunKod: K });

  it('channels and free public services are never listed, even with nothing on file', () => {
    const names = allNames(probe);
    for (const n of ['Skolon', 'Atea', 'Adda', 'LäroMedia Bokhandel Örebro', 'Dustin', 'Sveriges Utbildningsradio', 'UR-program']) {
      expect(names).not.toContain(n);
    }
  });

  it('nor companies outside the request', () => {
    const names = allNames(probe);
    for (const n of ['Sirvoy', 'CoSafe', 'Sambruk', 'Skolfederation', 'Hermods', 'Upplands-Bro kommun']) expect(names).not.toContain(n);
  });

  it('an avtal with a channel strikes the companies it resells, not a category', () => {
    const p = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Atea', ['Polyglutt'])] });
    expect(allNames(p)).not.toContain('ILT (Inläsningstjänst)');
    expect(entries(p, 'larplattform')).toHaveLength(1);
  });
});

describe('buildProbeList: mentions in sammanställningar', () => {
  it('a company the kommun named is known and not asked about, but settles no category', () => {
    const probe = buildProbeList({ kommunKod: K, mentions: [{ vendor: 'Haldor', product: 'Lärplattform', from_contract: false }] });
    expect(allNames(probe)).not.toContain('Haldor');
    expect(reasonFor(probe, 'Haldor')).toMatch(/nämns/);
    expect(namesIn(probe, 'larplattform')).toContain('itslearning');
  });

  it('a mention the evidence gate rejects (shut down, PUB-avtal) strikes nothing', () => {
    const probe = buildProbeList({ kommunKod: K, mentions: [
      { vendor: 'Haldor', product: 'Haldor (nedlagt)' },
      { vendor: 'Binogi', product: 'Personuppgiftsbiträdesavtal' },
    ] });
    expect(allNames(probe)).toContain('Haldor');
    expect(allNames(probe)).toContain('Binogi');
  });

  it('collectMentions reads mentioned_agreements out of analysis_json', () => {
    const m = collectMentions([
      { is_contract: 0, analysis_json: JSON.stringify({ mentioned_agreements: [{ vendor: 'Haldor', product: '', doc_attached: false }] }) },
      { is_contract: 1, analysis_json: '{bad json' },
    ]);
    expect(m).toEqual([{ vendor: 'Haldor', product: '', note: null, from_contract: false }]);
  });
});

describe('buildProbeList: readable length', () => {
  it(`caps a category at ${PROBE_CAP} names by footprint, then "eller liknande"`, () => {
    const elsewhere = ['1001', '1002', '1003'];
    const probe = buildProbeList({
      kommunKod: K,
      contracts: [
        ...elsewhere.map((k, i) => avtal(100 + i, 'Lingio', ['Lingio'], k)),
        ...elsewhere.slice(0, 2).map((k, i) => avtal(200 + i, 'Creaza', ['Creaza'], k)),
      ],
      purchaseRows: [bought('iMAL', '1001')],
    });
    const lm = entries(probe, 'laromedel')[0];
    expect(lm.names).toHaveLength(PROBE_CAP);
    expect(lm.more).toBeGreaterThan(0);
    expect(lm.names.slice(0, 3)).toEqual(['Lingio', 'Creaza', 'iMAL']);
    expect(renderProbeList(probe)).toMatch(/^- Läromedel: Lingio, Creaza, iMAL, .* eller liknande$/m);
  });

  it('an uncapped category ends without "eller liknande"', () => {
    const probe = buildProbeList({ kommunKod: K });
    const line = renderProbeList(probe).split('\n').find((l) => l.startsWith('- Elevhälsa'));
    expect(line).not.toMatch(/eller liknande/);
  });
});

describe('buildProbeList: Binogi is never singled out', () => {
  it('drops a category where Binogi would stand alone', () => {
    const others = ['ILT Education', 'Radish', 'NE', 'Skolplus', 'SLI', 'Natur & Kultur', 'Gleerups', 'Liber', 'Sanoma', 'Studentlitteratur',
      'Clio', 'Musikoteket', 'Nomp', 'Swedish Film', 'Kide Science', 'Creaza', 'iMAL', 'LäraMera', 'Slöjd.nu', 'NTA Skolutveckling', 'P & L Nordic', 'Lingio'];
    const probe = buildProbeList({ kommunKod: K, purchaseRows: others.map((s) => bought(s)) });
    expect(entries(probe, 'laromedel')).toEqual([]);
    expect(allNames(probe)).not.toContain('Binogi');
    expect(reasonFor(probe, 'Binogi')).toBeTruthy();
  });
});

describe('buildProbeList: skolformer the kommun does not run', () => {
  const stats = loadKommunStats({ data: {
    sources: { siris_6_grundskola: { status: 'ok' }, siris_57_gymnasieskola: { status: 'ok' } },
    kommuner: {
      9001: { namn: 'Utan gymnasium', elever: { '1-3': 200, '4-6': 210, '7-9': 190, Gymnasiet: null } },
      9002: { namn: 'Med gymnasium', elever: { '1-3': 200, '4-6': 210, '7-9': 190, Gymnasiet: 300 } },
      9003: { namn: 'Noll i gymnasiet', elever: { '1-3': 200, '4-6': 210, '7-9': 190, Gymnasiet: 0 } },
    },
  } });

  it('reads the stats: absent from a source that loaded means no school, a failed source means unknown', () => {
    expect(skolformerFromStats(stats, '9001')).toEqual({ grundskola: true, gymnasiet: false });
    expect(skolformerFromStats(stats, '9002')).toEqual({ grundskola: true, gymnasiet: true });
    expect(skolformerFromStats(stats, '9003')).toEqual({ grundskola: true, gymnasiet: false });
    expect(skolformerFromStats(stats, '8888')).toEqual({ grundskola: null, gymnasiet: null });
    const failed = loadKommunStats({ data: { sources: { siris_57_gymnasieskola: { status: 'failed' } },
      kommuner: { 9001: { elever: { '1-3': 5, Gymnasiet: null } } } } });
    expect(skolformerFromStats(failed, '9001').gymnasiet).toBeNull();
  });

  it('never asks "för gymnasiet" in a kommun without a kommunal gymnasieskola', () => {
    const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Unikum', ['Unikum'])], skolformer: { grundskola: true, gymnasiet: false } });
    expect(entries(probe, 'larplattform')).toEqual([]);
    expect(renderProbeList(probe)).not.toMatch(/för gymnasiet/);
    expect(reasonFor(probe, 'itslearning')).toMatch(/lärplattform finns redan via Unikum; ingen kommunal gymnasieskola/);
  });

  it('with no avtal at all the category is asked plainly, without a skolform note', () => {
    const probe = buildProbeList({ kommunKod: K, skolformer: { grundskola: true, gymnasiet: false } });
    const lp = entries(probe, 'larplattform');
    expect(lp).toHaveLength(1);
    expect(lp[0].note).toBeUndefined();
  });

  it('keeps the current behaviour when the stats are unknown or show a gymnasieskola', () => {
    for (const skolformer of [undefined, { grundskola: null, gymnasiet: null }, { grundskola: true, gymnasiet: true }]) {
      const probe = buildProbeList({ kommunKod: K, contracts: [avtal(1, 'Unikum', ['Unikum'])], skolformer });
      expect(entries(probe, 'larplattform')[0].note).toBe('för gymnasiet');
    }
  });
});

describe('buildProbeList: operator decisions 2026-10-29', () => {
  const statsWith = (gy) => loadKommunStats({ data: {
    sources: { siris_6_grundskola: { status: 'ok' }, siris_57_gymnasieskola: { status: 'ok' } },
    kommuner: { 9001: { elever: { '1-3': 200, '4-6': 210, '7-9': 190, Gymnasiet: gy } } },
  } });

  it(`fewer than ${MIN_GYMNASIE_ELEVER} gymnasieskola elever counts as no kommunal gymnasieskola`, () => {
    expect(MIN_GYMNASIE_ELEVER).toBe(50);
    expect(skolformerFromStats(statsWith(49), '9001').gymnasiet).toBe(false);
    expect(skolformerFromStats(statsWith(50), '9001').gymnasiet).toBe(true);
  });

  it('never probes Microsoft, Google Workspace or Adobe, but the catalogue still knows them', () => {
    const names = allNames(buildProbeList({ kommunKod: K }));
    for (const n of ['Microsoft', 'Google Workspace', 'Google', 'Adobe']) expect(names).not.toContain(n);
    for (const v of ['Microsoft', 'Google', 'Adobe']) expect(classifyVendor(v)).toMatchObject({ role: 'service' });
  });
});
