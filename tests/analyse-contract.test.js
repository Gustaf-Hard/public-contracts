// tests/analyse-contract.test.js
import { describe, it, expect, vi } from 'vitest';
import { analyseContractPdf } from '../src/analyse-contract.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { storeContractAnalysis, analysePendingContracts, expandCoverageRows } from '../src/analyse-contract.js';

const GOOD = {
  is_contract: true, vendor_name: 'Skolon',
  products: ['Skolon Plattform'], avtalsvarde: '120 000', valuta: 'SEK',
  period_start: '2025-08-01', period_end: '2027-07-31',
  summary: 'Avtal om lärplattform.', confidence: 0.95,
};

function fakeClientReturning(obj) {
  return { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })) } };
}

const ctx = { kommun_namn: 'Västerås', filename: 'Avtal Skolon.pdf' };
const pdf = Buffer.from('%PDF-1.4 fake');

describe('analyseContractPdf', () => {
  it('sends the PDF as a base64 document block and returns parsed analysis', async () => {
    const client = fakeClientReturning(GOOD);
    const result = await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(result).toEqual(GOOD);
    const call = client.messages.create.mock.calls[0][0];
    const doc = call.messages[0].content.find((b) => b.type === 'document');
    expect(doc.source).toMatchObject({ type: 'base64', media_type: 'application/pdf' });
    expect(doc.source.data).toBe(pdf.toString('base64'));
    expect(call.output_config.format.type).toBe('json_schema');
    expect(call.model).toBe('claude-opus-4-8');
  });

  it('honors ANTHROPIC_CONTRACT_MODEL', async () => {
    const client = fakeClientReturning(GOOD);
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk', ANTHROPIC_CONTRACT_MODEL: 'claude-haiku-4-5' }, client });
    expect(client.messages.create.mock.calls[0][0].model).toBe('claude-haiku-4-5');
  });

  it('returns null on API error', async () => {
    const client = { messages: { create: vi.fn(async () => { throw new Error('boom'); }) } };
    expect(await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client })).toBeNull();
  });

  it('returns null on unparseable response or missing key', async () => {
    const bad = { messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: 'not json' }] })) } };
    expect(await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client: bad })).toBeNull();
    expect(await analyseContractPdf(pdf, ctx, { env: {} })).toBeNull();
  });
});

function seedDbWithPdf(tmp, { filename = 'Avtal Skolon.pdf' } = {}) {
  const db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
  const convId = db.createConversation({
    kommun_kod: '1980', kommun_namn: 'Västerås', role: 'central',
    contact_email: 'reg@vasteras.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
    from_email: 'reg@vasteras.se', to_email: 'me@x.com', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null,
    received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const savedPath = join(tmp, 'contracts', '1980', filename);
  mkdirSync(dirname(savedPath), { recursive: true });
  writeFileSync(savedPath, '%PDF-1.4 fake contract');
  const attId = db.recordAttachment({
    message_id: msgId, filename, saved_path: savedPath,
    mime_type: 'application/pdf', size_bytes: 22,
  });
  return { db, attId };
}

describe('storeContractAnalysis', () => {
  it('creates vendor, products, contract from an analysis', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, GOOD, { model: 'claude-opus-4-8' });
    const v = db.getVendorBySlug('skolon');
    expect(v).toBeDefined();
    const contracts = db.listContractsForVendor(v.id);
    expect(contracts).toHaveLength(1);
    expect(contracts[0].products).toEqual(['Skolon Plattform']);
    expect(contracts[0].period_end).toBe('2027-07-31');
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('is_contract=false stores row without vendor', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, { ...GOOD, is_contract: false, vendor_name: null, products: [] }, { model: 'm' });
    expect(db.listVendorsOverview()).toHaveLength(0);
    expect(db.listPendingContractAttachments()).toHaveLength(0); // analysed, not pending
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

describe('analyseContractPdf — document_type + mentioned_agreements', () => {
  it('returns document_type and mentioned_agreements when the model provides them', async () => {
    const letter = {
      is_contract: false, document_type: 'följebrev_sammanställning',
      vendor_name: null, products: [], avtalsvarde: null, valuta: null,
      period_start: null, period_end: null, summary: 'Följebrev som listar avtal.',
      confidence: 0.9,
      mentioned_agreements: [
        { vendor: 'Quiculum', product: 'Quiculum', doc_attached: false },
        { vendor: 'Teachiq', product: 'Exam.net', doc_attached: false },
      ],
    };
    const client = fakeClientReturning(letter);
    const result = await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(result.document_type).toBe('följebrev_sammanställning');
    expect(result.is_contract).toBe(false);
    expect(result.mentioned_agreements.map((m) => m.vendor)).toEqual(['Quiculum', 'Teachiq']);
    expect(result.mentioned_agreements.every((m) => m.doc_attached === false)).toBe(true);
    // The request schema advertises the new fields as required.
    const schema = client.messages.create.mock.calls[0][0].output_config.format.schema;
    expect(schema.required).toContain('document_type');
    expect(schema.required).toContain('mentioned_agreements');
  });
});

describe('lifecycle extraction (2026-07-09 perpetual-refresh design Part A)', () => {
  it('advertises the new lifecycle fields as required in the request schema', async () => {
    const client = fakeClientReturning({ ...GOOD, document_type: 'avtal', mentioned_agreements: [], auto_renews: false, renewal_term: null, last_cancellation_date: null, extension_option_until: null });
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    const schema = client.messages.create.mock.calls[0][0].output_config.format.schema;
    for (const f of ['auto_renews', 'renewal_term', 'last_cancellation_date', 'extension_option_until']) {
      expect(schema.required).toContain(f);
      expect(schema.properties).toHaveProperty(f);
    }
  });

  it('storeContractAnalysis persists the lifecycle fields (Tieto auto-renew)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, {
      ...GOOD, vendor_name: 'Tieto', period_end: '2026-12-31',
      auto_renews: true, renewal_term: '1 år',
      last_cancellation_date: '2026-09-30', extension_option_until: null,
    }, { model: 'claude-opus-4-8' });
    const row = db.listContractsForKommun('1980').find((r) => r.vendor_name === 'Tieto');
    expect(row.auto_renews).toBe(1);
    expect(row.renewal_term).toBe('1 år');
    expect(row.last_cancellation_date).toBe('2026-09-30');
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

describe('pricing extraction (2026-07-09 vendor-data-center design §1)', () => {
  const PRICING_FIELDS = ['annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek', 'unit', 'quantity', 'value_incl_moms'];

  it('advertises the pricing fields as required in the request schema', async () => {
    const client = fakeClientReturning(GOOD);
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    const schema = client.messages.create.mock.calls[0][0].output_config.format.schema;
    for (const f of PRICING_FIELDS) {
      expect(schema.required).toContain(f);
      expect(schema.properties).toHaveProperty(f);
    }
    expect(schema.properties.pricing_model.enum ?? schema.properties.pricing_model.anyOf?.[0]?.enum)
      .toEqual(['per_student', 'per_user', 'fixed', 'tiered', 'usage', 'one_time', 'free', 'unknown']);
  });

  it('the system prompt instructs normalization to SEK/year', async () => {
    const client = fakeClientReturning(GOOD);
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    const sys = client.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toContain('annual_value_sek');
    expect(sys).toContain('pricing_model');
    expect(sys).toContain('unit_price_sek');
  });

  it('storeContractAnalysis persists the pricing fields (Radish per-elev)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, {
      ...GOOD, vendor_name: 'Radish',
      avtalsvarde: '2025: 40 kr/elev (3744 elever); från 2026: 95 kr/elev',
      annual_value_sek: 149760, one_time_value_sek: null,
      pricing_model: 'per_student', unit_price_sek: 40, unit: 'elev', quantity: 3744,
      value_incl_moms: false,
    }, { model: 'claude-opus-4-8' });
    const row = db.raw.prepare('SELECT * FROM contracts WHERE attachment_id = ?').get(attId);
    expect(row.annual_value_sek).toBe(149760);
    expect(row.pricing_model).toBe('per_student');
    expect(row.unit_price_sek).toBe(40);
    expect(row.unit).toBe('elev');
    expect(row.quantity).toBe(3744);
    expect(row.value_incl_moms).toBe(0);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('storeContractAnalysis with pricing fields absent stores NULLs (old-shape analysis)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, GOOD, { model: 'claude-opus-4-8' });
    const row = db.raw.prepare('SELECT * FROM contracts WHERE attachment_id = ?').get(attId);
    for (const f of PRICING_FIELDS) expect(row[f]).toBeNull();
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

// ---- Product intelligence (2026-07-10 design): line items + coverage ----

// The real Ale / ILT Education contract shape (live DB row 101 + the spec's
// motivating example): total 585 649 SEK itemized per product, and per-product
// enhets-lists ("för följande enheter").
const ILT_ALE = {
  is_contract: true, document_type: 'avtal', vendor_name: 'ILT Education',
  products: ['Inlästa läromedel', 'Begreppa', 'Polyglutt'],
  avtalsvarde: '585 649 SEK år 1, 615 767 SEK år 2, 624 182 SEK år 3', valuta: 'SEK',
  period_start: '2025-01-31', period_end: '2028-01-30',
  auto_renews: false, renewal_term: null, last_cancellation_date: null, extension_option_until: null,
  annual_value_sek: 585649, one_time_value_sek: null, pricing_model: 'tiered',
  unit_price_sek: null, unit: null, quantity: null, value_incl_moms: null,
  summary: 'Treårigt avtal med ILT Education.', confidence: 0.95, mentioned_agreements: [],
  line_items: [
    { product: 'Inlästa läromedel', description: '65,40 kr/elev, 7 månader', unit_price_sek: 65.4, unit: 'elev', quantity: null, period_months: 7, amount_sek: 161909 },
    { product: 'Inlästa läromedel', description: '55 kr/elev, 5 månader', unit_price_sek: 55, unit: 'elev', quantity: null, period_months: 5, amount_sek: 88855 },
    { product: 'Begreppa', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 116244 },
    { product: 'Begreppa', description: '3,5 mån tidigare pris', unit_price_sek: null, unit: null, quantity: null, period_months: 3.5, amount_sek: 50341 },
    { product: 'Polyglutt', description: '100 kr/barn', unit_price_sek: 100, unit: 'barn', quantity: 1683, period_months: null, amount_sek: 168300 },
  ],
  coverage: [
    { product: 'Inlästa läromedel', unit_text: 'Alla kommunala grundskolor (3 810), gymnasieskolor (120), vuxenutbildningar (270), anpassad skola (44)', grade_levels: ['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'], status: 'full', student_count: 4244 },
    { product: 'Begreppa', unit_text: 'Alla kommunala grundskolor (3 810), gymnasieskolor (120), vuxenutbildningar (270), anpassad skola (44)', grade_levels: ['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux'], status: 'full', student_count: 4244 },
    { product: 'Polyglutt', unit_text: 'Alla kommunala förskolor (1 683)', grade_levels: ['Förskola'], status: 'full', student_count: 1683 },
  ],
  whole_municipality: false,
};

describe('product-intelligence extraction (2026-07-10 design)', () => {
  it('advertises line_items, coverage and whole_municipality as required in the request schema', async () => {
    const client = fakeClientReturning(ILT_ALE);
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    const schema = client.messages.create.mock.calls[0][0].output_config.format.schema;
    for (const f of ['line_items', 'coverage', 'whole_municipality']) {
      expect(schema.required).toContain(f);
      expect(schema.properties).toHaveProperty(f);
    }
    const li = schema.properties.line_items.items;
    for (const f of ['product', 'description', 'unit_price_sek', 'unit', 'quantity', 'period_months', 'amount_sek']) {
      expect(li.required).toContain(f);
    }
    const cov = schema.properties.coverage.items;
    for (const f of ['product', 'unit_text', 'grade_levels', 'status', 'student_count']) {
      expect(cov.required).toContain(f);
    }
    expect(cov.properties.grade_levels.items.enum).toEqual([
      'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9',
      'Gymnasiet', 'Komvux', 'Introduktionsprogrammet', 'Högskola',
    ]);
    expect(cov.properties.status.enum).toEqual(['full', 'partial']);
  });

  it('the system prompt instructs the itemized breakdown (contracted, not ordinarie pris) and coverage', async () => {
    const client = fakeClientReturning(ILT_ALE);
    await analyseContractPdf(pdf, ctx, { env: { ANTHROPIC_API_KEY: 'sk' }, client });
    const sys = client.messages.create.mock.calls[0][0].system[0].text;
    expect(sys).toContain('line_items');
    expect(sys).toContain('beräknas enligt nedan');
    expect(sys).toContain('ordinarie pris');
    expect(sys).toContain('coverage');
    expect(sys).toContain('whole_municipality');
    expect(sys).toContain('grade_levels');
  });

  it('storeContractAnalysis persists line items; per-product price = Σ amount_sek (Ale figures)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, ILT_ALE, { model: 'claude-opus-4-8' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    const items = db.listLineItemsForContract(cId);
    expect(items).toHaveLength(5);
    const sum = (name) => items.filter((i) => i.product_name === name).reduce((s, i) => s + i.amount_sek, 0);
    expect(sum('Inlästa läromedel')).toBe(250764);
    expect(sum('Begreppa')).toBe(166585);
    expect(sum('Polyglutt')).toBe(168300);
    // product_id matched by name against the vendor's products.
    const v = db.getVendorBySlug('ilt-education');
    const begreppaId = db.raw.prepare('SELECT id FROM products WHERE vendor_id = ? AND name = ?').get(v.id, 'Begreppa').id;
    expect(items.filter((i) => i.product_name === 'Begreppa').every((i) => i.product_id === begreppaId)).toBe(true);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('storeContractAnalysis persists coverage as one row per (product, grade)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, ILT_ALE, { model: 'claude-opus-4-8' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    const cov = db.listCoverageForContract(cId);
    expect(cov.filter((r) => r.product_name === 'Begreppa').map((r) => r.grade_level))
      .toEqual(['1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux']);
    expect(cov.filter((r) => r.product_name === 'Polyglutt'))
      .toMatchObject([{ grade_level: 'Förskola', status: 'full', student_count: 1683 }]);
    expect(cov.every((r) => r.status === 'full')).toBe(true);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to mapUnitToGradeLevels when the model omits grade_levels', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, {
      ...ILT_ALE,
      coverage: [{ product: 'Polyglutt', unit_text: 'Alla kommunala förskolor (1 683)', grade_levels: [], status: 'full', student_count: 1683 }],
    }, { model: 'm' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    expect(db.listCoverageForContract(cId)).toMatchObject([
      { product_name: 'Polyglutt', grade_level: 'Förskola', status: 'full' },
    ]);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('whole_municipality=true expands every product to full on all municipal levels', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, {
      ...ILT_ALE, products: ['Begreppa'], line_items: [], coverage: [], whole_municipality: true,
    }, { model: 'm' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    const cov = db.listCoverageForContract(cId);
    expect(cov.map((r) => r.grade_level)).toEqual([
      'Förskola', 'Förskoleklass', '1-3', '4-6', '7-9', 'Gymnasiet', 'Komvux', 'Introduktionsprogrammet',
    ]);
    expect(cov.every((r) => r.status === 'full' && r.product_name === 'Begreppa')).toBe(true);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('a degraded re-run with empty line_items/coverage NEVER wipes previously-extracted rows', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, ILT_ALE, { model: 'm1' });
    // Degraded second pass: still a contract, but no line items / coverage.
    storeContractAnalysis(db, attId, {
      ...ILT_ALE, line_items: [], coverage: [], whole_municipality: false,
    }, { model: 'm2' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    const items = db.listLineItemsForContract(cId);
    expect(items).toHaveLength(5);
    expect(items.filter((i) => i.product_name === 'Begreppa').reduce((s, i) => s + i.amount_sek, 0)).toBe(166585);
    expect(db.listCoverageForContract(cId)).toHaveLength(11); // 5 + 5 + 1 rows preserved
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('a re-run WITH line items replaces the old ones (idempotent, not additive)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, ILT_ALE, { model: 'm1' });
    storeContractAnalysis(db, attId, {
      ...ILT_ALE,
      line_items: [{ product: 'Polyglutt', description: null, unit_price_sek: null, unit: null, quantity: null, period_months: null, amount_sek: 168300 }],
      coverage: [{ product: 'Polyglutt', unit_text: 'Alla kommunala förskolor', grade_levels: ['Förskola'], status: 'partial', student_count: null }],
    }, { model: 'm2' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    expect(db.listLineItemsForContract(cId)).toHaveLength(1);
    expect(db.listCoverageForContract(cId)).toMatchObject([
      { product_name: 'Polyglutt', grade_level: 'Förskola', status: 'partial' },
    ]);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('an old-shape analysis (no line_items/coverage keys) stores nothing and does not crash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db, attId } = seedDbWithPdf(tmp);
    storeContractAnalysis(db, attId, GOOD, { model: 'm' });
    const cId = db.raw.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(attId).id;
    expect(db.listLineItemsForContract(cId)).toHaveLength(0);
    expect(db.listCoverageForContract(cId)).toHaveLength(0);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

describe('expandCoverageRows (pure)', () => {
  it('full beats partial when the same (product, grade) appears twice', () => {
    const rows = expandCoverageRows({
      products: [],
      coverage: [
        { product: 'Begreppa', unit_text: 'utvalda grundskolor', grade_levels: ['1-3'], status: 'partial', student_count: null },
        { product: 'Begreppa', unit_text: 'alla grundskolor åk 1-3', grade_levels: ['1-3'], status: 'full', student_count: 500 },
      ],
      whole_municipality: false,
    });
    expect(rows).toMatchObject([{ product_name: 'Begreppa', grade_level: '1-3', status: 'full', student_count: 500 }]);
  });

  it('drops grade levels outside the canonical enum and entries without a product', () => {
    const rows = expandCoverageRows({
      products: [],
      coverage: [
        { product: 'X', unit_text: '', grade_levels: ['Mellanstadiet', '4-6'], status: 'full', student_count: null },
        { product: '', unit_text: 'grundskolor', grade_levels: ['1-3'], status: 'full', student_count: null },
      ],
    });
    expect(rows).toMatchObject([{ product_name: 'X', grade_level: '4-6' }]);
  });

  it('returns [] for missing/empty coverage', () => {
    expect(expandCoverageRows({})).toEqual([]);
    expect(expandCoverageRows({ coverage: [], whole_municipality: false })).toEqual([]);
    expect(expandCoverageRows(null)).toEqual([]);
  });
});

describe('analysePendingContracts', () => {
  it('analyses each pending PDF and stores results; second run is a no-op', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db } = seedDbWithPdf(tmp);
    const client = fakeClientReturning(GOOD);
    const n1 = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(n1).toBe(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const n2 = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(n2).toBe(0);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('leaves attachment pending when LLM returns null', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db } = seedDbWithPdf(tmp);
    const client = { messages: { create: vi.fn(async () => { throw new Error('boom'); }) } };
    const n = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client });
    expect(n).toBe(0);
    expect(db.listPendingContractAttachments()).toHaveLength(1);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });

  it('does nothing without an API key', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    const { db } = seedDbWithPdf(tmp);
    const n = await analysePendingContracts({ db, env: {} });
    expect(n).toBe(0);
    db.close(); rmSync(tmp, { recursive: true, force: true });
  });
});

describe('analysePendingContracts onlyMessageId', () => {
  it('analyses only the attachments of the given message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ac-'));
    try {
      const db = openDb(join(tmp, 'pilot.db'));
      db.migrate();
      const convId = db.createConversation({ kommun_kod: '1', kommun_namn: 'X', role: 'central', contact_email: 'k@x.se', scheduled_send_at: '2026-01-01T00:00:00Z' });
      const seedMsgWithPdf = (name) => {
        const msgId = db.recordMessage({ conversation_id: convId, gmail_message_id: `gm-${name}`, direction: 'inbound', from_email: 'a@x.se', to_email: 'me@x.se', subject: 's', body_text: '', classification: null, classification_confidence: null, received_at: '2026-06-01T00:00:00Z', attachment_count: 1 });
        const p = join(tmp, `${name}.pdf`);
        writeFileSync(p, '%PDF-1.4 fake');
        db.recordAttachment({ message_id: msgId, filename: `${name}.pdf`, saved_path: p, mime_type: 'application/pdf', size_bytes: 12 });
        return msgId;
      };
      const mA = seedMsgWithPdf('a');
      seedMsgWithPdf('b');

      const client = fakeClientReturning({ ...GOOD, document_type: 'avtal', mentioned_agreements: [] });
      const done = await analysePendingContracts({ db, env: { ANTHROPIC_API_KEY: 'sk' }, client, onlyMessageId: mA });
      expect(done).toBe(1);
      expect(client.messages.create).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
