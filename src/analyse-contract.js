// src/analyse-contract.js
// LLM analysis of contract PDFs. Mirrors src/analyse-message.js: cached client,
// Swedish system prompt with cache_control, structured output via
// output_config.format, null on any failure so callers never crash.
//
// PDFs go to Claude directly as base64 document blocks — no local text
// extraction. Claude's PDF support handles image-based pages too.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = `Du analyserar PDF:er som svenska kommuner lämnat ut efter en begäran om allmänna handlingar om digitala verktyg i utbildningsförvaltningen.

Din uppgift: avgör dokumentets typ, om det är ett avtal, och extrahera strukturerade fält.

Regler:
- document_type: "avtal" för avtal/kontrakt/ramavtal/underskrivna beställningar. "följebrev_sammanställning" för svarsbrev eller tabeller som RÄKNAR UPP avtal/leverantörer utan att själva innehålla avtalstexten (t.ex. "Svar på begäran om allmän handling" med en tabell över leverantörer och kostnader). "prislista", "sekretessbeslut" eller "övrigt" för annat.
- is_contract: true ENDAST när document_type = "avtal". false för följebrev_sammanställning, prislista, sekretessbeslut och övrigt. Ett brev som hänvisar till "bifogat avtal" är INTE självt ett avtal.
- vendor_name: leverantörens kanoniska företagsnamn utan bolagsform — "Skolon", inte "Skolon AB". null om oklart.
- products: namngivna produkter/tjänster som avtalet omfattar. Tom array om inga kan identifieras.
- avtalsvarde: avtalets värde eller årskostnad som text (t.ex. "120 000 kr/år"). null om det inte framgår.
- valuta: "SEK" etc. null om det inte framgår.
- period_start / period_end: avtalstidens start- och slutdatum som ISO-datum (YYYY-MM-DD). null om det inte framgår. Vid automatisk förlängning: använd INNEVARANDE periods slutdatum (period_end), inte det förlängda.
- auto_renews: true om avtalet förlängs automatiskt om det inte sägs upp (t.ex. "förlängs automatiskt i ettårsperioder om det inte sägs upp"). Annars false.
- renewal_term: förlängningsperioden som text (t.ex. "1 år", "2 år"). null om avtalet inte förlängs automatiskt eller om perioden inte framgår.
- last_cancellation_date: sista dagen avtalet kan sägas upp (uppsägningsdag) innan det förlängs automatiskt, som ISO-datum (YYYY-MM-DD). Räkna fram från uppsägningstiden relativt period_end om det behövs. null om det inte framgår eller inte är tillämpligt.
- extension_option_until: om avtalet innehåller en OPTION om förlängning (t.ex. "möjlighet till förlängning upp till 2027-06-14", eller "möjlighet till två års förlängning"), det slutdatum som optionen kan förlänga avtalet till, som ISO-datum. Räkna fram från period_end om endast en längd anges ("två års förlängning" → period_end + 2 år). null om ingen sådan option finns.
- annual_value_sek: avtalets kostnad normaliserad till SEK PER ÅR som tal. Månadskostnad × 12. Vid trappa/eskalerande pris ("585 649 SEK år 1, 615 767 SEK år 2"): använd INNEVARANDE avtalsårs belopp (räkna från period_start); framgår inte vilket år som gäller, använd år 1. Vid pris per enhet med angivet antal: enhetspris × antal. Vid totalsumma för flera år där årsbeloppet framgår (t.ex. "förvaltningsavgift 4 955 221 kr/år"): använd årsbeloppet. "Ingen årlig kostnad" / gratis: 0. null när årskostnaden INTE följer av dokumentet — GISSA ALDRIG, och skriv aldrig 0 för okänt. En klumpsumma utan period ("121 272 SEK") är INTE en årskostnad → null.
- one_time_value_sek: engångskostnader i SEK (uppstart, införandeprojekt, licens vid engångsköp). null om inga framgår.
- pricing_model: hur priset är konstruerat — "per_student" (per elev/barn), "per_user" (per användare/licens), "fixed" (fast års-/månadsbelopp), "tiered" (olika belopp per år eller volymtrappa), "usage" (rörligt efter förbrukning, t.ex. per dag/timme), "one_time" (endast engångsköp), "free" (uttryckligen kostnadsfritt), "unknown" när det inte framgår.
- unit_price_sek / unit / quantity: vid enhetspris — priset per enhet som tal, enheten på svenska i singular ("elev", "användare"), och antalet enheter som avtalet anger. Använd innevarande nivå vid trappa. null där de inte framgår.
- value_incl_moms: true om angivna belopp är inklusive moms, false om exklusive. null om det inte framgår.
- summary: 1-2 meningar på svenska om vad dokumentet gäller.
- mentioned_agreements: lista de avtal/leverantörer som dokumentet NÄMNER, med { vendor, product, doc_attached }. doc_attached = true endast om själva avtalshandlingen finns i DETTA dokument; false när dokumentet bara refererar till eller sammanställer avtalet utan att innehålla det. Tom array om inga nämns.
- confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker.
- Svara ENBART med JSON som matchar schemat.`;

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_contract', 'document_type', 'vendor_name', 'products', 'avtalsvarde', 'valuta', 'period_start', 'period_end', 'auto_renews', 'renewal_term', 'last_cancellation_date', 'extension_option_until', 'annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek', 'unit', 'quantity', 'value_incl_moms', 'summary', 'confidence', 'mentioned_agreements'],
  properties: {
    is_contract: { type: 'boolean' },
    document_type: { type: 'string', enum: ['avtal', 'följebrev_sammanställning', 'prislista', 'sekretessbeslut', 'övrigt'] },
    vendor_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    products: { type: 'array', items: { type: 'string' } },
    avtalsvarde: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    valuta: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_start: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    period_end: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    auto_renews: { type: 'boolean' },
    renewal_term: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    last_cancellation_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    extension_option_until: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    annual_value_sek: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    one_time_value_sek: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    pricing_model: { type: 'string', enum: ['per_student', 'per_user', 'fixed', 'tiered', 'usage', 'one_time', 'free', 'unknown'] },
    unit_price_sek: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    quantity: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    value_incl_moms: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
    summary: { type: 'string' },
    confidence: { type: 'number' },
    mentioned_agreements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['vendor', 'product', 'doc_attached'],
        properties: {
          vendor: { type: 'string' },
          product: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          doc_attached: { type: 'boolean' },
        },
      },
    },
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

// Duplicate-contract detection (review L6, partial): the same contract re-sent
// in a later batch becomes a second contracts row (attachment_id is the only
// key) and double-counts market stats. Durable content-hash dedup needs a hash
// column — a schema change, deferred — so this only WARNS when another stored
// contract for the same kommun has the identical vendor + period, letting the
// operator prune by hand.
function warnOnLikelyDuplicate(db, contractId, attachmentId, vendorId, analysis, log) {
  if (!vendorId || !analysis.is_contract) return;
  const dupes = db.raw.prepare(`
    SELECT c.id
    FROM contracts c
    JOIN attachments a ON a.id = c.attachment_id
    JOIN messages m ON m.id = a.message_id
    JOIN conversations conv ON conv.id = m.conversation_id
    WHERE c.vendor_id = ? AND c.is_contract = 1 AND c.id != ?
      AND COALESCE(c.period_start, '') = COALESCE(?, '')
      AND COALESCE(c.period_end, '') = COALESCE(?, '')
      AND conv.kommun_kod = (
        SELECT conv2.kommun_kod FROM attachments a2
        JOIN messages m2 ON m2.id = a2.message_id
        JOIN conversations conv2 ON conv2.id = m2.conversation_id
        WHERE a2.id = ?)
  `).all(vendorId, contractId, analysis.period_start ?? null, analysis.period_end ?? null, attachmentId);
  if (dupes.length > 0) {
    log?.(`WARNING possible duplicate contract: new contract ${contractId} (${analysis.vendor_name}) matches existing row(s) ${dupes.map((d) => d.id).join(', ')} on vendor+period for the same kommun — review and prune to avoid double-counting`);
  }
}

// Persist one analysis: vendor (case-insensitive upsert) + products + contract row.
// Re-running for the same attachment replaces (recordContract handles that).
export function storeContractAnalysis(db, attachmentId, analysis, { model, log = null } = {}) {
  let vendorId = null;
  if (analysis.is_contract && analysis.vendor_name) {
    vendorId = db.upsertVendor(analysis.vendor_name).id;
  }
  const contractId = db.recordContract({
    attachment_id: attachmentId,
    vendor_id: vendorId,
    avtalsvarde: analysis.avtalsvarde,
    valuta: analysis.valuta,
    period_start: analysis.period_start,
    period_end: analysis.period_end,
    auto_renews: analysis.auto_renews,
    renewal_term: analysis.renewal_term,
    last_cancellation_date: analysis.last_cancellation_date,
    extension_option_until: analysis.extension_option_until,
    annual_value_sek: analysis.annual_value_sek,
    one_time_value_sek: analysis.one_time_value_sek,
    pricing_model: analysis.pricing_model,
    unit_price_sek: analysis.unit_price_sek,
    unit: analysis.unit,
    quantity: analysis.quantity,
    value_incl_moms: analysis.value_incl_moms,
    is_contract: analysis.is_contract ? 1 : 0,
    summary: analysis.summary,
    confidence: analysis.confidence,
    analysis_json: analysis,
    model,
  });
  if (vendorId) {
    for (const name of analysis.products ?? []) {
      db.linkContractProduct(contractId, db.upsertProduct(vendorId, name));
    }
  }
  warnOnLikelyDuplicate(db, contractId, attachmentId, vendorId, analysis, log);
  return contractId;
}

// Analyse every PDF attachment that has no contracts row yet. Errors on one
// PDF never block the others, and never throw to the caller (tick safety).
// Returns the number of attachments successfully analysed+stored.
export async function analysePendingContracts({ db, env = process.env, client = null, log = null, force = false, onlyId = null, onlyMessageId = null } = {}) {
  if (!client && !(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim())) return 0;

  let pending = force
    ? db.raw.prepare(`
        SELECT a.*, conv.kommun_kod, conv.kommun_namn, conv.role
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        JOIN conversations conv ON conv.id = m.conversation_id
        WHERE (a.mime_type = 'application/pdf' OR lower(a.filename) LIKE '%.pdf')
        ORDER BY a.id
      `).all()
    : db.listPendingContractAttachments();
  if (onlyId != null) pending = pending.filter((a) => a.id === onlyId);
  if (onlyMessageId != null) pending = pending.filter((a) => a.message_id === onlyMessageId);

  const model = env.ANTHROPIC_CONTRACT_MODEL ?? DEFAULT_MODEL;
  let done = 0;
  for (const att of pending) {
    const fullPath = resolve(att.saved_path);
    if (!existsSync(fullPath)) {
      log?.(`contract-analysis: file missing on disk, skipping ${att.filename}`);
      continue;
    }
    const analysis = await analyseContractPdf(readFileSync(fullPath), {
      kommun_namn: att.kommun_namn, filename: att.filename,
    }, { env, client });
    if (!analysis) continue; // stays pending; next run retries
    storeContractAnalysis(db, att.id, analysis, { model, log });
    log?.(`CONTRACT analysed: ${att.filename} → ${analysis.is_contract ? (analysis.vendor_name ?? 'okänd leverantör') : 'ej avtal'}`);
    done += 1;
  }
  return done;
}
