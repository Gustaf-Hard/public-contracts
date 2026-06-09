// tests/analyse-contract.test.js
import { describe, it, expect, vi } from 'vitest';
import { analyseContractPdf } from '../src/analyse-contract.js';

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
