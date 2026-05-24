import { describe, it, expect, vi } from 'vitest';
import {
  analyseMessage,
  analysisToLegacyClassification,
  isLlmAnalysisEnabled,
} from '../src/analyse-message.js';

function fakeClientReturning(analysisObject) {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(analysisObject) }],
      })),
    },
  };
}

function fakeClientThatThrows(message = 'network down') {
  return {
    messages: {
      create: vi.fn(async () => { throw new Error(message); }),
    },
  };
}

const baseCtx = {
  kommun_namn: 'Testkommun',
  role: 'utbildning',
  conversation_state: 'SENT',
  days_since_last_outbound: 1,
  today_iso: '2026-05-24',
};

describe('isLlmAnalysisEnabled', () => {
  it('true when ANTHROPIC_API_KEY is set', () => {
    expect(isLlmAnalysisEnabled({ ANTHROPIC_API_KEY: 'sk-ant-...' })).toBe(true);
  });

  it('false when key is missing or empty', () => {
    expect(isLlmAnalysisEnabled({})).toBe(false);
    expect(isLlmAnalysisEnabled({ ANTHROPIC_API_KEY: '' })).toBe(false);
    expect(isLlmAnalysisEnabled({ ANTHROPIC_API_KEY: '   ' })).toBe(false);
  });
});

describe('analyseMessage', () => {
  it('returns null for empty body', async () => {
    const r = await analyseMessage('', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' } });
    expect(r).toBeNull();
  });

  it('returns null when no API key', async () => {
    const r = await analyseMessage('Ärendenummer: K9999001', baseCtx, { env: {} });
    expect(r).toBeNull();
  });

  it('parses a well-formed auto_ack response', async () => {
    const expected = {
      intent: 'auto_ack', confidence: 0.95,
      summary: 'Mottagningskvitto med ärendenummer.',
      extracted: { arendenummer: 'K9999001', promised_response_days: null, promised_response_date: null, handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null },
      suggested_action: 'wait',
      draft_reply: 'Hej, ...',
      follow_up_at: null,
    };
    const client = fakeClientReturning(expected);
    const r = await analyseMessage('Ärendenummer: K9999001', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r).toEqual(expected);
    expect(client.messages.create).toHaveBeenCalledOnce();
    const call = client.messages.create.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.output_config.format.type).toBe('json_schema');
    // System prompt is cached
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Kommun context flows into the user prompt
    expect(call.messages[0].content).toContain('Testkommun');
    expect(call.messages[0].content).toContain('Ärendenummer: K9999001');
  });

  it('returns null when API throws (caller falls back to regex)', async () => {
    const client = fakeClientThatThrows('timeout');
    const r = await analyseMessage('Test body', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r).toBeNull();
  });

  it('returns null when API returns malformed JSON', async () => {
    const client = {
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: 'not json at all' }] })),
      },
    };
    const r = await analyseMessage('Test body', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r).toBeNull();
  });
});

describe('analysisToLegacyClassification', () => {
  it('maps auto_ack and delay_promise both to auto_ack legacy class', () => {
    expect(analysisToLegacyClassification({ intent: 'auto_ack', confidence: 0.9 }).class).toBe('auto_ack');
    expect(analysisToLegacyClassification({ intent: 'delay_promise', confidence: 0.9 }).class).toBe('auto_ack');
  });

  it('maps handoff and fee_demand to unknown (escalate)', () => {
    expect(analysisToLegacyClassification({ intent: 'handoff', confidence: 0.9 }).class).toBe('unknown');
    expect(analysisToLegacyClassification({ intent: 'fee_demand', confidence: 0.9 }).class).toBe('unknown');
  });

  it('preserves arendenummer in extracted', () => {
    const r = analysisToLegacyClassification({
      intent: 'auto_ack', confidence: 0.9,
      extracted: { arendenummer: 'K9999001' },
    });
    expect(r.extracted.arendenummer).toBe('K9999001');
  });

  it('returns null when given null', () => {
    expect(analysisToLegacyClassification(null)).toBeNull();
  });

  it('signals the source of the classification', () => {
    expect(analysisToLegacyClassification({ intent: 'auto_ack', confidence: 0.9 }).signals).toEqual(['llm_analysis']);
  });
});
