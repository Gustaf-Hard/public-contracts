// LLM-based analysis of an inbound kommun reply.
//
// Replaces the regex classifier (src/classifier.js) as the v1 source of truth.
// Given a Swedish message body + conversation context, calls Claude Haiku 4.5
// to return:
//   - intent (auto_ack, clarification, delivery, delay_promise, handoff, dead_end, fee_demand, unknown)
//   - extracted structured fields (ärendenummer, promised response days/date, handoff target, questions, vendors)
//   - draft_reply (always populated — a Swedish reply ready for human review)
//   - follow_up_at (ISO date when the bot should check back if no further word)
//
// The regex classifier remains as a fallback for when ANTHROPIC_API_KEY is
// unset or the API call fails — that keeps the daemon working offline.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = `Du analyserar inkommande e-postsvar från svenska kommunregistratorer. En automatisk bot skickar förfrågningar om allmänna handlingar (offentlighetsprincipen, 2 kap. tryckfrihetsförordningen) avseende avtal för digitala verktyg och läromedel i skolan. Boten skickar sina förfrågningar via gustaf.hard@gmail.com å Mediagrafs vägnar.

Ditt jobb är att kategorisera registratorns svar och förbereda ett kort, artigt svar på svenska som den mänskliga operatören kan godkänna eller redigera.

# Intents (välj exakt en)

- "auto_ack": Automatiskt mottagningskvitto från diariesystem (innehåller ofta "Ärendenummer", "Tack för att du hörde av dig", "flexiteBPMS", "Vi har tagit emot"). Ingen mänsklig registrator har behandlat svaret än. Inget svar krävs.
- "clarification": Registratorn ber om förtydliganden (tidsperiod, specifika system, sammanställning vs fullständiga avtal etc.). Boten bör skicka en preciseringstext.
- "delivery": Avtal levererade som bifogade filer ELLER bekräftelse att alla avtal nu skickats. Skicka kort "tack"-bekräftelse.
- "delay_promise": Registratorn bekräftar att de hanterar ärendet och utlovar svar inom X dagar / före visst datum. Inget svar krävs, men sätt follow_up_at till deras utlovade datum + 3 dagars grace.
- "handoff": Registratorn hänvisar oss till en annan förvaltning, e-postadress eller registrator. Boten kan inte själv följa upp dit — eskalera till människa.
- "dead_end": Kommunen har inga sådana avtal, eller vägrar lämna ut handlingarna. Terminalt.
- "fee_demand": Kommunen kräver avgift för utlämnandet. Eskalera till människa för beslut.
- "unknown": Inget av ovanstående matchar tydligt. Eskalera till människa.

# Föreslagen åtgärd (suggested_action)

- "acknowledge" — bot skickar kort "Tack"-svar (delivery + slutleverans, eller delay_promise om vi vill bekräfta mottagning)
- "send_precision" — bot skickar preciseringen som svar på clarification
- "send_receipt" — bot skickar kvitto efter mottagna avtal (delivery, ej slutleverans)
- "wait" — inget svar krävs, vi väntar (auto_ack, delay_promise)
- "escalate" — vi vet inte vad vi ska göra, människan tar över (handoff, fee_demand, unknown)

# draft_reply

Skriv alltid ett konkret förslag på svar på svenska, även för "wait"-fall (om vi senare bestämmer oss för att svara). Var artig och kort. Använd "Hej," utan personnamn. Avsluta med "Med vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com". Boten är inte en advokat — undvik översjälvsäkra formuleringar.

# is_final_delivery

true ENDAST när registratorn i sitt EGET svar (inte i citerad text) bekräftar att samtliga avtal nu har lämnats ut / att inga fler handlingar är på väg ("detta var samtliga avtal", "vi har inga ytterligare avtal"). Ett svar som bara citerar vår egen fråga "Är detta samtliga avtal?" är INTE en bekräftelse. false i alla andra fall.

# follow_up_at

ISO-datum (YYYY-MM-DD) när boten ska kolla tillbaka om inget hörs av kommunen.

- För "delay_promise": använd kommunens utlovade datum + 3 dagars grace (om de säger 10 dagar, sätt follow_up_at = idag + 13 dagar).
- För "auto_ack": null (vi väntar utan timer; om inget hörs på 7 dagar tar standard-staleness över).
- För "clarification" / "delivery" / "delay_promise": konversationen rör sig vidare, sätt rimlig grace (5-7 dagar).
- För terminalstaten "dead_end" / "fee_demand" / "handoff" / "unknown": null.

# Few-shot exempel

Inkommande:
> Tack för din begäran. Ärendenummer: K202642713. Vi återkommer.

Output:
{"intent":"auto_ack","confidence":0.95,"summary":"Automatiskt mottagningskvitto med ärendenummer K202642713.","extracted":{"arendenummer":"K202642713","promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":null},"suggested_action":"wait","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för bekräftelsen. Jag inväntar handlingarna.\\n\\nMed vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com","follow_up_at":null}

Inkommande:
> Hej, för att kunna hjälpa dig på bästa sätt önskar jag veta: avser begäran en viss tidsperiod, och gäller den specifika system eller leverantörer?

Output:
{"intent":"clarification","confidence":0.9,"summary":"Registratorn ber om precisering kring tidsperiod och specifika system.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":["Avser begäran en viss tidsperiod?","Gäller den specifika system eller leverantörer?"],"mentioned_vendors":null},"suggested_action":"send_precision","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för snabbt svar! Jag preciserar:\\n\\nJag efterfrågar aktiva avtal (ej utgångna) avseende digitala verktyg inom utbildningsförvaltningen, inklusive lärplattformar, digitala läromedel och administrativa system. Jag önskar de fullständiga avtalshandlingarna i PDF-format.\\n\\nMed vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com","follow_up_at":null}

Inkommande:
> Hej, vi behöver cirka 10 arbetsdagar för att ta fram materialet. Återkommer senast 2026-06-08.

Output:
{"intent":"delay_promise","confidence":0.95,"summary":"Kommunen utlovar svar inom 10 arbetsdagar, senast 2026-06-08.","extracted":{"arendenummer":null,"promised_response_days":10,"promised_response_date":"2026-06-08","handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":null},"suggested_action":"wait","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för uppdateringen. Jag inväntar handlingarna senast 8 juni.\\n\\nMed vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com","follow_up_at":"2026-06-11"}

Inkommande:
> Hej, dessa avtal hanteras av stadsledningskontoret. Vänligen kontakta dem på registrator@stadsledningen.kommun.se.

Output:
{"intent":"handoff","confidence":0.95,"summary":"Hänvisas till stadsledningskontoret på registrator@stadsledningen.kommun.se.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":"registrator@stadsledningen.kommun.se","handoff_to_forvaltning":"stadsledningskontoret","questions":null,"mentioned_vendors":null},"suggested_action":"escalate","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för hänvisningen. Jag tar kontakt med stadsledningskontoret separat.\\n\\nMed vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com","follow_up_at":null}

Inkommande:
> Här bifogas avtalet med Skolon och Google Workspace-avtalet. Hör av dig om något saknas.

Output:
{"intent":"delivery","confidence":0.9,"summary":"Levererar avtal med Skolon och Google Workspace.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":["Skolon","Google Workspace"]},"suggested_action":"send_receipt","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack så mycket för avtalen — jag har tagit emot dem. Är detta samtliga avtal eller är fler på väg?\\n\\nMed vänliga hälsningar,\\nGustaf Hård af Segerstad\\ngustaf.hard@gmail.com","follow_up_at":null}

# Viktigt

- Svara ENBART med JSON som matchar schemat. Inga inledande/avslutande kommentarer.
- Om något fält inte kan extraheras från svaret: använd null (eller [] för arrays där det är meningsfullt — eller null om listan vore tom).
- För confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker (intent bör vara "unknown").`;

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'confidence', 'summary', 'extracted', 'suggested_action', 'is_final_delivery', 'draft_reply', 'follow_up_at'],
  properties: {
    intent: {
      type: 'string',
      enum: ['auto_ack', 'clarification', 'delivery', 'delay_promise', 'dead_end', 'handoff', 'fee_demand', 'unknown'],
    },
    confidence: { type: 'number' },
    summary: { type: 'string' },
    extracted: {
      type: 'object',
      additionalProperties: false,
      required: ['arendenummer', 'promised_response_days', 'promised_response_date', 'handoff_to_email', 'handoff_to_forvaltning', 'questions', 'mentioned_vendors'],
      properties: {
        arendenummer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        promised_response_days: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        promised_response_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        handoff_to_email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        handoff_to_forvaltning: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        questions: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        mentioned_vendors: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
      },
    },
    suggested_action: {
      type: 'string',
      enum: ['acknowledge', 'send_precision', 'send_receipt', 'wait', 'escalate'],
    },
    // "This was everything / no more agreements coming" — asserted by the
    // registrator's own text, never by our quoted receipt question (review M9).
    is_final_delivery: { type: 'boolean' },
    draft_reply: { type: 'string' },
    follow_up_at: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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

export function isLlmAnalysisEnabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim());
}

function userPromptFor(ctx, body) {
  const lines = [];
  lines.push(`Kommun: ${ctx.kommun_namn} kommun`);
  lines.push(`Mottagarroll i kommunen: ${ctx.role}`);
  lines.push(`Aktuellt konversationstillstånd: ${ctx.conversation_state}`);
  if (ctx.days_since_last_outbound != null) {
    lines.push(`Dagar sedan vårt senaste utgående: ${ctx.days_since_last_outbound}`);
  }
  if (ctx.today_iso) {
    lines.push(`Dagens datum: ${ctx.today_iso}`);
  }
  lines.push('');
  lines.push('Inkommande svar från registratorn:');
  lines.push('---');
  lines.push(body.trim());
  lines.push('---');
  return lines.join('\n');
}

export async function analyseMessage(body, ctx, { env = process.env, client = null } = {}) {
  if (!body || typeof body !== 'string' || body.trim().length === 0) return null;
  const apiKey = env.ANTHROPIC_API_KEY;
  const sdkClient = client ?? getClient(apiKey);
  if (!sdkClient) return null;

  const model = env.ANTHROPIC_ANALYSIS_MODEL ?? DEFAULT_MODEL;

  try {
    const response = await sdkClient.messages.create({
      model,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: userPromptFor(ctx, body) },
      ],
      output_config: {
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
    });

    const textBlock = (response.content ?? []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) return null;
    try {
      const parsed = JSON.parse(textBlock.text);
      return parsed;
    } catch (e) {
      return null;
    }
  } catch (e) {
    // Network or API error — let the caller fall back to the regex classifier.
    // We log here so the daemon's stdout shows what happened on a real run.
    console.warn(`[analyse-message] LLM call failed, falling back: ${e.message}`);
    return null;
  }
}

// Map an LLM analysis output to the legacy classifier shape (class / confidence /
// signals / extracted) so the existing FSM and tick-orchestrator logic keep
// working without a deeper refactor. Intents that the regex classifier doesn't
// know about collapse onto the closest existing class.
export function analysisToLegacyClassification(analysis) {
  if (!analysis) return null;
  const intentToLegacy = {
    auto_ack: 'auto_ack',
    clarification: 'clarification',
    delivery: 'delivery',
    delay_promise: 'auto_ack',  // legacy FSM treats both as "registrator acknowledged, no outbound"
    handoff: 'unknown',          // escalate to human; preserved on analysis.intent
    dead_end: 'dead_end',
    fee_demand: 'unknown',       // escalate to human
    unknown: 'unknown',
  };
  return {
    class: intentToLegacy[analysis.intent] ?? 'unknown',
    confidence: analysis.confidence ?? 0,
    signals: ['llm_analysis'],
    extracted: {
      arendenummer: analysis.extracted?.arendenummer ?? undefined,
    },
  };
}
