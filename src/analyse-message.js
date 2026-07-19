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

// The outbound identity (signature + sender address) comes from env, never
// hardcoded (review M8): drafts must sign whatever GMAIL_FROM_NAME /
// GMAIL_USER_EMAIL the daemon actually sends as. Exported for tests.
export function buildSystemPrompt({ from_name, from_email }) {
  return `Du analyserar inkommande e-postsvar från svenska kommunregistratorer. En automatisk bot skickar förfrågningar om allmänna handlingar (offentlighetsprincipen, 2 kap. tryckfrihetsförordningen) avseende avtal för digitala verktyg och läromedel i skolan. Boten skickar sina förfrågningar via ${from_email} å Mediagrafs vägnar.

Ditt jobb är att kategorisera registratorns svar och förbereda ett kort, artigt svar på svenska som den mänskliga operatören kan godkänna eller redigera.

# Intents (välj exakt en)

- "auto_ack": Automatiskt mottagningskvitto från diariesystem (innehåller ofta "Ärendenummer", "Tack för att du hörde av dig", "flexiteBPMS", "Vi har tagit emot"). Ingen mänsklig registrator har behandlat svaret än. Inget svar krävs.
- "clarification": Registratorn ber om förtydliganden (tidsperiod, specifika system, sammanställning vs fullständiga avtal etc.). Boten bör skicka en preciseringstext.
- "delivery": Avtal levererade som bifogade filer ELLER bekräftelse att alla avtal nu skickats. Skicka kort "tack"-bekräftelse.
- "delay_promise": Registratorn bekräftar att de hanterar ärendet och utlovar svar inom X dagar / före visst datum. Hit hör OCKSÅ frånvaro-/semesterautosvar som anger ett återkomstdatum ("Jag har semester och är åter 20 juli", "tillbaka 3 augusti", "åter på kontoret måndag 20 juli") — ÄVEN om en kollega/vikarie nämns för akuta ärenden. En semester är en tillfällig väntan, inte en permanent hänvisning: välj delay_promise, INTE handoff. Extrahera återkomst-/utlovsdatumet som promised_response_date (ISO) och sätt follow_up_at = datumet + 3 dagars grace. Boten föreslår en kort bekräftelse ("då avvaktar vi till <datum>").
- "handoff": Registratorn hänvisar oss PERMANENT till en annan förvaltning, e-postadress eller registrator. Boten kan inte själv följa upp dit — eskalera till människa. Ett semesterautosvar med återkomstdatum är INTE handoff (se delay_promise), även om en kollega anges för akuta ärenden.
- "dead_end": Kommunen har inga sådana avtal, eller vägrar lämna ut handlingarna. Terminalt.
- "fee_demand": Kommunen kräver avgift för utlämnandet. Eskalera till människa för beslut.
- "unknown": Inget av ovanstående matchar tydligt. Eskalera till människa.

# Föreslagen åtgärd (suggested_action)

- "acknowledge" — bot skickar kort "Tack"-svar (delivery + slutleverans, eller delay_promise: "då avvaktar vi till <datum>")
- "send_precision" — bot skickar preciseringen som svar på clarification
- "send_receipt" — bot skickar kvitto efter mottagna avtal (delivery, ej slutleverans)
- "wait" — inget svar krävs, vi väntar (auto_ack)
- "escalate" — vi vet inte vad vi ska göra, människan tar över (handoff, fee_demand, unknown)

# draft_reply

Skriv alltid ett konkret förslag på svar på svenska, även för "wait"-fall (om vi senare bestämmer oss för att svara). Var artig och kort. Använd "Hej," utan personnamn. Avsluta med "Med vänliga hälsningar,\\n${from_name}\\n${from_email}". Boten är inte en advokat — undvik översjälvsäkra formuleringar.

# is_final_delivery

true ENDAST när registratorn i sitt EGET svar (inte i citerad text) bekräftar att samtliga avtal nu har lämnats ut / att inga fler handlingar är på väg ("detta var samtliga avtal", "vi har inga ytterligare avtal"). Ett svar som bara citerar vår egen fråga "Är detta samtliga avtal?" är INTE en bekräftelse. false i alla andra fall.

# follow_up_at

ISO-datum (YYYY-MM-DD) när boten ska kolla tillbaka om inget hörs av kommunen.

- För "delay_promise": använd kommunens utlovade datum + 3 dagars grace (om de säger 10 dagar, sätt follow_up_at = idag + 13 dagar). För semesterautosvar: återkomstdatumet + 3 dagar.
- För "auto_ack": null (vi väntar utan timer; om inget hörs på 7 dagar tar standard-staleness över).
- För "clarification" / "delivery" / "delay_promise": konversationen rör sig vidare, sätt rimlig grace (5-7 dagar).
- För terminalstaten "dead_end" / "fee_demand" / "handoff" / "unknown": null.

# mentioned_vendors och reseller_relations

- "mentioned_vendors": alla leverantörs-/produktnamn som nämns i svaret (som förut). Oförändrat fält.
- "reseller_relations": fyll ENDAST när kommunen uttryckligen anger att en leverantör nås via / är underleverantör i ett namngivet ramavtal eller hos en återförsäljare (t.ex. Adda, Skolon, Läromedia, Atea). Varje post är {"vendor": "<leverantör>", "ramavtal": "<ramavtal/återförsäljare>"}. Gissa ALDRIG kopplingen — sätt null (eller utelämna posten) om kommunen inte själv säger vilket ramavtal en viss leverantör nås genom. En kommun kan köpa via flera ramavtal utan att vi vet vilket som levererar en viss produkt.

# Few-shot exempel

Inkommande:
> Tack för din begäran. Ärendenummer: K202642713. Vi återkommer.

Output:
{"intent":"auto_ack","confidence":0.95,"summary":"Automatiskt mottagningskvitto med ärendenummer K202642713.","extracted":{"arendenummer":"K202642713","promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"wait","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för bekräftelsen. Jag inväntar handlingarna.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":null}

Inkommande:
> Hej, för att kunna hjälpa dig på bästa sätt önskar jag veta: avser begäran en viss tidsperiod, och gäller den specifika system eller leverantörer?

Output:
{"intent":"clarification","confidence":0.9,"summary":"Registratorn ber om precisering kring tidsperiod och specifika system.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":["Avser begäran en viss tidsperiod?","Gäller den specifika system eller leverantörer?"],"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"send_precision","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för snabbt svar! Jag preciserar:\\n\\nJag efterfrågar aktiva avtal (ej utgångna) avseende digitala verktyg inom utbildningsförvaltningen, inklusive lärplattformar, digitala läromedel och administrativa system. Jag önskar de fullständiga avtalshandlingarna i PDF-format.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":null}

Inkommande:
> Hej, vi behöver cirka 10 arbetsdagar för att ta fram materialet. Återkommer senast 2026-06-08.

Output:
{"intent":"delay_promise","confidence":0.95,"summary":"Kommunen utlovar svar inom 10 arbetsdagar, senast 2026-06-08.","extracted":{"arendenummer":null,"promised_response_days":10,"promised_response_date":"2026-06-08","handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"acknowledge","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för uppdateringen. Jag inväntar handlingarna senast 8 juni.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":"2026-06-11"}

Inkommande:
> Hej! Jag har semester och är åter på kontoret måndag 20 juli. Vid akuta ärenden kan ni kontakta min kollega Mirella Beck, mirella.beck@kommunen.se.

Output:
{"intent":"delay_promise","confidence":0.9,"summary":"Frånvaroautosvar: registratorn är åter 20 juli; kollega anges endast för akuta ärenden.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":"2026-07-20","handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"acknowledge","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för ditt svar! Då avvaktar vi till 20 juli och hör av oss igen om vi inte fått något då.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":"2026-07-23"}

Inkommande:
> Hej, dessa avtal hanteras av stadsledningskontoret. Vänligen kontakta dem på registrator@stadsledningen.kommun.se.

Output:
{"intent":"handoff","confidence":0.95,"summary":"Hänvisas till stadsledningskontoret på registrator@stadsledningen.kommun.se.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":"registrator@stadsledningen.kommun.se","handoff_to_forvaltning":"stadsledningskontoret","questions":null,"mentioned_vendors":null,"reseller_relations":null},"suggested_action":"escalate","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för hänvisningen. Jag tar kontakt med stadsledningskontoret separat.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":null}

Inkommande:
> Här bifogas avtalet med Skolon och Google Workspace-avtalet. Hör av dig om något saknas.

Output:
{"intent":"delivery","confidence":0.9,"summary":"Levererar avtal med Skolon och Google Workspace.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":["Skolon","Google Workspace"],"reseller_relations":null},"suggested_action":"send_receipt","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack så mycket för avtalen — jag har tagit emot dem. Är detta samtliga avtal eller är fler på väg?\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":null}

Inkommande:
> Hej, NE och Magma finns som underleverantörer i vårt avtal med Läromedia. Vi har inget eget direktavtal med dem.

Output:
{"intent":"delivery","confidence":0.85,"summary":"NE och Magma nås via kommunens ramavtal med Läromedia — inget direktavtal.","extracted":{"arendenummer":null,"promised_response_days":null,"promised_response_date":null,"handoff_to_email":null,"handoff_to_forvaltning":null,"questions":null,"mentioned_vendors":["NE","Magma","Läromedia"],"reseller_relations":[{"vendor":"NE","ramavtal":"Läromedia"},{"vendor":"Magma","ramavtal":"Läromedia"}]},"suggested_action":"send_receipt","is_final_delivery":false,"draft_reply":"Hej,\\n\\nTack för förtydligandet — jag noterar att NE och Magma nås via ert avtal med Läromedia.\\n\\nMed vänliga hälsningar,\\n${from_name}\\n${from_email}","follow_up_at":null}

# Viktigt

- Svara ENBART med JSON som matchar schemat. Inga inledande/avslutande kommentarer.
- Om något fält inte kan extraheras från svaret: använd null (eller [] för arrays där det är meningsfullt — eller null om listan vore tom).
- För confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker (intent bör vara "unknown").`;
}

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
      required: ['arendenummer', 'promised_response_days', 'promised_response_date', 'handoff_to_email', 'handoff_to_forvaltning', 'questions', 'mentioned_vendors', 'reseller_relations'],
      properties: {
        arendenummer: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        promised_response_days: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
        promised_response_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        handoff_to_email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        handoff_to_forvaltning: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        questions: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        mentioned_vendors: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
        // Vendor↔ramavtal relationships the kommun explicitly stated (e.g. "NE
        // finns som underleverantör i vårt avtal med Läromedia"). Array of
        // {vendor, ramavtal} — both required plain strings; the array itself is
        // nullable/empty when the reply names no such relation. Kept minimal on
        // purpose: the item object has NO nested unions, so the whole extracted
        // object stays well under the json_schema 16-union-param limit.
        reseller_relations: {
          anyOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['vendor', 'ramavtal'],
                properties: {
                  vendor: { type: 'string' },
                  ramavtal: { type: 'string' },
                },
              },
            },
            { type: 'null' },
          ],
        },
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

// ---------------------------------------------------------------------------
// Pure date helpers — used to normalise delay_promise analyses so a stated
// return date ALWAYS re-arms the follow-up timer, even when the model forgot
// to compute follow_up_at or emitted the date in Swedish prose.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// '2026-07-20' + 3 → '2026-07-23'. Returns null on non-ISO input.
export function addDaysIso(iso, days) {
  if (typeof iso !== 'string' || !ISO_DATE_RE.test(iso)) return null;
  const t = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return null;
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

const SV_MONTHS = {
  januari: 1, februari: 2, mars: 3, april: 4, maj: 5, juni: 6,
  juli: 7, augusti: 8, september: 9, oktober: 10, november: 11, december: 12,
};

// Extract a date from Swedish prose ('måndag 20 juli', '3 augusti 2026') or
// ISO ('2026-07-20', possibly embedded). Yearless dates resolve to the NEXT
// occurrence relative to todayIso (a return date is always in the future).
// Returns YYYY-MM-DD or null.
export function parseSwedishDateToIso(text, { todayIso } = {}) {
  if (!text || typeof text !== 'string') return null;
  const s = text.trim().toLowerCase();

  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const candidate = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return isRealDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? candidate : null;
  }

  const m = s.match(/(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)(?:\s+(\d{4}))?/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = SV_MONTHS[m[2]];
  let year = m[3] ? Number(m[3]) : null;
  if (year == null) {
    const todayYear = todayIso && ISO_DATE_RE.test(todayIso) ? Number(todayIso.slice(0, 4)) : new Date().getUTCFullYear();
    year = todayYear;
    const candidate = `${year}-${pad2(month)}-${pad2(day)}`;
    if (todayIso && candidate < todayIso) year += 1; // already passed → next year
  }
  if (!isRealDate(year, month, day)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function isRealDate(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Deterministic safety net over the model output (pure, exported for tests):
// for delay_promise, coerce a prose promised_response_date to ISO and, when
// follow_up_at is missing, derive it — return/promised date + 3 days grace,
// or today + promised_response_days + 3. Without this, an OOO reply the model
// classified correctly could still leave nothing re-armed (case 19, Bjuv).
export function normaliseDelayAnalysis(analysis, todayIso) {
  if (!analysis || analysis.intent !== 'delay_promise') return analysis;
  const ex = analysis.extracted ?? {};
  if (ex.promised_response_date && !ISO_DATE_RE.test(ex.promised_response_date)) {
    const coerced = parseSwedishDateToIso(ex.promised_response_date, { todayIso });
    if (coerced) ex.promised_response_date = coerced;
  }
  if (!analysis.follow_up_at) {
    if (ex.promised_response_date && ISO_DATE_RE.test(ex.promised_response_date)) {
      analysis.follow_up_at = addDaysIso(ex.promised_response_date, 3);
    } else if (Number.isInteger(ex.promised_response_days) && todayIso && ISO_DATE_RE.test(todayIso)) {
      analysis.follow_up_at = addDaysIso(todayIso, ex.promised_response_days + 3);
    }
  }
  return analysis;
}

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
  // Identity from env (review M8) — stable per process, so prompt caching
  // still applies across calls.
  const systemPrompt = buildSystemPrompt({
    from_name: (env.GMAIL_FROM_NAME ?? '').trim() || 'Mediagraf',
    from_email: (env.GMAIL_USER_EMAIL ?? '').trim(),
  });

  try {
    const response = await sdkClient.messages.create({
      model,
      max_tokens: 1024,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
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
      return normaliseDelayAnalysis(parsed, ctx.today_iso);
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
    delay_promise: 'delay_promise', // FSM drafts a T_DELAY_ACK naming the promised date
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
