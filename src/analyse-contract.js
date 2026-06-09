// src/analyse-contract.js
// LLM analysis of contract PDFs. Mirrors src/analyse-message.js: cached client,
// Swedish system prompt with cache_control, structured output via
// output_config.format, null on any failure so callers never crash.
//
// PDFs go to Claude directly as base64 document blocks — no local text
// extraction. Claude's PDF support handles image-based pages too.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = `Du analyserar avtals-PDF:er som svenska kommuner lämnat ut efter en begäran om allmänna handlingar om digitala verktyg i utbildningsförvaltningen.

Din uppgift: avgör om dokumentet är ett avtal och extrahera strukturerade fält.

Regler:
- is_contract: true för avtal/kontrakt/ramavtal (även underskrivna beställningar). false för bilagor utan avtalsinnehåll (prislistor, sekretessbeslut, följebrev).
- vendor_name: leverantörens kanoniska företagsnamn utan bolagsform — "Skolon", inte "Skolon AB". null om oklart.
- products: namngivna produkter/tjänster som avtalet omfattar (t.ex. "Skolon Plattform", "Google Workspace for Education"). Tom array om inga kan identifieras.
- avtalsvarde: avtalets värde eller årskostnad som text som den står i avtalet (t.ex. "120 000 kr/år"). null om det inte framgår.
- valuta: "SEK" etc. null om det inte framgår.
- period_start / period_end: avtalstidens start- och slutdatum som ISO-datum (YYYY-MM-DD). null om det inte framgår. Om avtalet förlängs automatiskt: använd innevarande periods slutdatum.
- summary: 1-2 meningar på svenska om vad avtalet gäller.
- confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker.
- Svara ENBART med JSON som matchar schemat.`;

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_contract', 'vendor_name', 'products', 'avtalsvarde', 'valuta', 'period_start', 'period_end', 'summary', 'confidence'],
  properties: {
    is_contract: { type: 'boolean' },
    vendor_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    products: { type: 'array', items: { type: 'string' } },
    avtalsvarde: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    valuta: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    summary: { type: 'string' },
    confidence: { type: 'number' },
  },
};

let cachedClient = null;
function getClient(apiKey) {
  if (!apiKey) return null;
  if (!cachedClient || cachedClient._apiKey !== apiKey) {
    cachedClient = new Anthropic({ apiKey });
    cachedClient._apiKey = apiKey;
  }
  return cachedClient;
}

export async function analyseContractPdf(pdfBuffer, ctx, { env = process.env, client = null } = {}) {
  if (!pdfBuffer || pdfBuffer.length === 0) return null;
  const sdkClient = client ?? getClient(env.ANTHROPIC_API_KEY);
  if (!sdkClient) return null;

  const model = env.ANTHROPIC_CONTRACT_MODEL ?? DEFAULT_MODEL;
  try {
    const response = await sdkClient.messages.create({
      model,
      max_tokens: 2048,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') },
          },
          { type: 'text', text: `Kommun: ${ctx.kommun_namn}\nFilnamn: ${ctx.filename}` },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: CONTRACT_SCHEMA } },
    });
    const textBlock = (response.content ?? []).find((b) => b.type === 'text');
    if (!textBlock?.text) return null;
    try {
      return JSON.parse(textBlock.text);
    } catch {
      return null;
    }
  } catch (e) {
    console.warn(`[analyse-contract] LLM call failed for ${ctx.filename}: ${e.message}`);
    return null;
  }
}
