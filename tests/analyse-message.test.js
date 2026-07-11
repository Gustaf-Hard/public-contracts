import { describe, it, expect, vi } from 'vitest';
import {
  analyseMessage,
  analysisToLegacyClassification,
  isLlmAnalysisEnabled,
  buildSystemPrompt,
  addDaysIso,
  parseSwedishDateToIso,
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

describe('date helpers (pure)', () => {
  it('addDaysIso adds calendar days across month/year boundaries', () => {
    expect(addDaysIso('2026-07-20', 3)).toBe('2026-07-23');
    expect(addDaysIso('2026-05-24', 13)).toBe('2026-06-06');
    expect(addDaysIso('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDaysIso('2026-07-23', -3)).toBe('2026-07-20');
    expect(addDaysIso('not-a-date', 3)).toBeNull();
  });

  it('parseSwedishDateToIso handles ISO passthrough', () => {
    expect(parseSwedishDateToIso('2026-07-20')).toBe('2026-07-20');
    expect(parseSwedishDateToIso('senast 2026-07-20', {})).toBe('2026-07-20');
  });

  it('parseSwedishDateToIso parses Swedish month names, inferring the next occurrence', () => {
    expect(parseSwedishDateToIso('20 juli', { todayIso: '2026-07-05' })).toBe('2026-07-20');
    expect(parseSwedishDateToIso('måndag 20 juli', { todayIso: '2026-07-05' })).toBe('2026-07-20');
    expect(parseSwedishDateToIso('åter på kontoret måndag 20 juli.', { todayIso: '2026-07-05' })).toBe('2026-07-20');
    expect(parseSwedishDateToIso('3 augusti 2026', { todayIso: '2026-07-05' })).toBe('2026-08-03');
    // A month-day already past this year means next year
    expect(parseSwedishDateToIso('3 januari', { todayIso: '2026-12-20' })).toBe('2027-01-03');
  });

  it('parseSwedishDateToIso rejects garbage and impossible dates', () => {
    expect(parseSwedishDateToIso('hej hej', { todayIso: '2026-07-05' })).toBeNull();
    expect(parseSwedishDateToIso('31 februari', { todayIso: '2026-07-05' })).toBeNull();
    expect(parseSwedishDateToIso(null, { todayIso: '2026-07-05' })).toBeNull();
  });
});

describe('analyseMessage — delay_promise normalisation', () => {
  const oooBody = 'Hej! Jag har semester och är åter på kontoret måndag 20 juli. Vid akuta ärende kan ni kontakta min kollega Mirella Beck.';

  it('OOO with a non-ISO return date: coerces the date and fills follow_up_at = return date + 3', async () => {
    const client = fakeClientReturning({
      intent: 'delay_promise', confidence: 0.9,
      summary: 'Frånvaroautosvar: åter 20 juli.',
      extracted: { arendenummer: null, promised_response_days: null, promised_response_date: '20 juli', handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null },
      suggested_action: 'acknowledge',
      is_final_delivery: false,
      draft_reply: 'Hej, ...',
      follow_up_at: null,
    });
    const r = await analyseMessage(oooBody, { ...baseCtx, today_iso: '2026-07-05' }, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r.intent).toBe('delay_promise'); // a vacation is a wait, not a handoff
    expect(r.extracted.promised_response_date).toBe('2026-07-20');
    expect(r.follow_up_at).toBe('2026-07-23');
  });

  it('genuine "utlovar svar inom 10 dagar" with no date: follow_up_at = today + 10 + 3 grace', async () => {
    const client = fakeClientReturning({
      intent: 'delay_promise', confidence: 0.95,
      summary: 'Utlovar svar inom 10 dagar.',
      extracted: { arendenummer: null, promised_response_days: 10, promised_response_date: null, handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null },
      suggested_action: 'acknowledge',
      is_final_delivery: false,
      draft_reply: 'Hej, ...',
      follow_up_at: null,
    });
    const r = await analyseMessage('Vi utlovar svar inom 10 dagar.', { ...baseCtx, today_iso: '2026-05-24' }, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r.intent).toBe('delay_promise');
    expect(r.follow_up_at).toBe('2026-06-06'); // today + 13
  });

  it('never overwrites an LLM-provided follow_up_at', async () => {
    const client = fakeClientReturning({
      intent: 'delay_promise', confidence: 0.95,
      summary: 'Åter 2026-06-08.',
      extracted: { arendenummer: null, promised_response_days: 10, promised_response_date: '2026-06-08', handoff_to_email: null, handoff_to_forvaltning: null, questions: null, mentioned_vendors: null },
      suggested_action: 'acknowledge',
      is_final_delivery: false,
      draft_reply: 'Hej, ...',
      follow_up_at: '2026-06-11',
    });
    const r = await analyseMessage('Vi behöver 10 dagar.', baseCtx, { env: { ANTHROPIC_API_KEY: 'k' }, client });
    expect(r.follow_up_at).toBe('2026-06-11');
  });
});

describe('buildSystemPrompt — OOO guidance', () => {
  const prompt = buildSystemPrompt({ from_name: 'Gustaf', from_email: 'gustaf@mediagraf.se' });

  it('instructs that a vacation autoreply with a return date is delay_promise, not handoff — even with a stand-in colleague', () => {
    expect(prompt).toMatch(/semester/i);
    expect(prompt).toMatch(/åter/i);
    expect(prompt).toMatch(/INTE handoff/);
    expect(prompt).toMatch(/kollega/i);
  });

  it('keeps the genuine delay-promise rule (promised date + 3 dagars grace)', () => {
    expect(prompt).toMatch(/utlovade datum \+ 3 dagars grace/);
    expect(prompt).toMatch(/follow_up_at = idag \+ 13 dagar/);
  });

  it('contains an OOO few-shot example that extracts the return date', () => {
    expect(prompt).toMatch(/åter på kontoret måndag 20 juli/);
    expect(prompt).toMatch(/"promised_response_date":"2026-07-20"/);
    expect(prompt).toMatch(/"follow_up_at":"2026-07-23"/);
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
