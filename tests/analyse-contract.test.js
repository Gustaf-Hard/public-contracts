// tests/analyse-contract.test.js
import { describe, it, expect, vi } from 'vitest';
import { analyseContractPdf } from '../src/analyse-contract.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { storeContractAnalysis, analysePendingContracts } from '../src/analyse-contract.js';

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
