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
import { GRADE_LEVELS, MUNICIPAL_GRADE_LEVELS, mapUnitToGradeLevels } from './vendor-analytics.js';

const DEFAULT_MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = `Du analyserar PDF:er som svenska kommuner lämnat ut efter en begäran om allmänna handlingar om digitala verktyg i utbildningsförvaltningen.

Din uppgift: avgör dokumentets typ, om det är ett avtal, och extrahera strukturerade fält.

Regler:
- document_type — dokumentets typ. Avgörande skillnad: ett "avtal" är en KOMMERSIELL överenskommelse där kommunen BETALAR för en produkt/tjänst (pengar byts mot vara/tjänst). Använd:
  - "avtal": ett kommersiellt avtal/kontrakt/ramavtal eller en underskriven, prissatt beställning där kommunen betalar för en produkt/tjänst (huvudavtal). Diskriminatorn är att PENGAR BYTS MOT PRODUKTER/TJÄNSTER.
  - "bilaga": en bilaga/appendix till ett avtal som INTE själv är ett kommersiellt avtal — t.ex. servicenivåavtal/SLA, säkerhetsbilaga, kravspecifikation, funktionella krav, definitioner, IT-miljö, samverkan/ändringshantering, eller en prisbilaga som hör till ett huvudavtal. Även om texten är avtalsmässig är en fristående bilaga en "bilaga".
  - "personuppgiftsbiträdesavtal": ett dataskyddsavtal (PUB-avtal/DPA enligt GDPR). Det är juridiskt ett avtal men INGA pengar byts, så det är INTE ett avtal i vår mening.
  - "följebrev_sammanställning": svarsbrev eller tabeller som RÄKNAR UPP avtal/leverantörer utan att själva innehålla avtalstexten (t.ex. "Svar på begäran om allmän handling" med en tabell över leverantörer och kostnader).
  - "prislista", "sekretessbeslut" eller "övrigt" för annat.
- is_contract: true ENDAST när document_type = "avtal". false för bilaga, personuppgiftsbiträdesavtal, följebrev_sammanställning, prislista, sekretessbeslut och övrigt. En fristående bilaga (SLA, säkerhet, kravspec, definitioner) är INTE ett avtal även om den läser avtalsmässigt. Ett PUB-avtal är INTE ett avtal (inga pengar byts). Ett brev som hänvisar till "bifogat avtal" är INTE självt ett avtal.
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
- line_items: avtalets EGEN prisspecifikation — raderna där totalpriset bryts ner per produkt/tjänst (t.ex. under "Totalt pris … beräknas enligt nedan"). En rad per specificerad post: { product: produktnamnet som det står, description: radens beskrivning (t.ex. "65,40 kr/elev, 7 månader"), unit_price_sek, unit ("elev", "barn" …), quantity, period_months, amount_sek }. amount_sek är radens bidrag till avtalets totala pris. Ange det AVTALADE beloppet — referensbelopp som "ordinarie pris" ska ALDRIG tas med. Samma produkt kan ha flera rader (olika pris under olika delperioder). Tom array när avtalet bara anger en klumpsumma utan specifikation — hitta ALDRIG på en fördelning.
- coverage: vilka enheter/skolformer varje produkt omfattar enligt avtalet (t.ex. avsnitt "för följande enheter"). En post per produkt och enhetsbeskrivning: { product, unit_text: beskrivningen ordagrant (t.ex. "Alla kommunala grundskolor (3 810)"), grade_levels: de skolnivåer beskrivningen motsvarar, som lista ur exakt dessa värden: "Förskola", "Förskoleklass", "1-3", "4-6", "7-9", "Gymnasiet", "Komvux", "Introduktionsprogrammet", "Högskola" (grundskola → "1-3" + "4-6" + "7-9"; F-3 → "Förskoleklass" + "1-3"; vuxenutbildning/SFI → "Komvux"; anpassad skola/särskola räknas in i motsvarande åldersband), status: "full" när ALLA enheter i skolformen omfattas ("alla kommunala grundskolor"), "partial" när endast namngivna/utvalda enheter omfattas, student_count: antal elever/barn om det anges, annars null }. Tom array när avtalet inte beskriver täckning.
- whole_municipality: true ENDAST när avtalet uttryckligen gäller kommunens HELA verksamhet/alla skolformer kommunövergripande (då gäller full täckning på alla nivåer). Annars false.
- summary: 1-2 meningar på svenska om vad dokumentet gäller.
- mentioned_agreements: lista de avtal/leverantörer som dokumentet NÄMNER, med { vendor, product, doc_attached }. doc_attached = true endast om själva avtalshandlingen finns i DETTA dokument; false när dokumentet bara refererar till eller sammanställer avtalet utan att innehålla det. Tom array om inga nämns.
- confidence: 0.9+ = mycket säker, 0.7-0.9 = ganska säker, <0.7 = osäker.
- Svara ENBART med JSON som matchar schemat.`;

const CONTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_contract', 'document_type', 'vendor_name', 'products', 'avtalsvarde', 'valuta', 'period_start', 'period_end', 'auto_renews', 'renewal_term', 'last_cancellation_date', 'extension_option_until', 'annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek', 'unit', 'quantity', 'value_incl_moms', 'line_items', 'coverage', 'whole_municipality', 'summary', 'confidence', 'mentioned_agreements'],
  properties: {
    is_contract: { type: 'boolean' },
    document_type: { type: 'string', enum: ['avtal', 'bilaga', 'personuppgiftsbiträdesavtal', 'följebrev_sammanställning', 'prislista', 'sekretessbeslut', 'övrigt'] },
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
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'description', 'unit_price_sek', 'unit', 'quantity', 'period_months', 'amount_sek'],
        properties: {
          product: { type: 'string' },
          description: { type: 'string' },
          unit_price_sek: { type: 'number' },
          unit: { type: 'string' },
          quantity: { type: 'number' },
          period_months: { type: 'number' },
          amount_sek: { type: 'number' },
        },
      },
    },
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'unit_text', 'grade_levels', 'status', 'student_count'],
        properties: {
          product: { type: 'string' },
          unit_text: { type: 'string' },
          grade_levels: { type: 'array', items: { type: 'string', enum: [...GRADE_LEVELS] } },
          status: { type: 'string', enum: ['full', 'partial'] },
          student_count: { type: 'number' },
        },
      },
    },
    whole_municipality: { type: 'boolean' },
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
          product: { type: 'string' },
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

// ---- Product intelligence (2026-07-10 design): line items + coverage ----

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Analysis-shape line items ({ product, … }) → DB-row shape
// ({ product_name, … }). Entries without a usable product name are dropped.
function normalizeLineItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof (it.product ?? it.product_name) === 'string' && (it.product ?? it.product_name).trim())
    .map((it) => ({
      product_name: (it.product ?? it.product_name).trim(),
      description: it.description ?? null,
      unit_price_sek: numOrNull(it.unit_price_sek),
      unit: it.unit ?? null,
      quantity: numOrNull(it.quantity),
      period_months: numOrNull(it.period_months),
      amount_sek: numOrNull(it.amount_sek),
    }));
}

// Expand an analysis' coverage[] (+ whole_municipality flag) into DB rows:
// one row per (product, grade_level). Pure and exported for direct testing.
//   - grade_levels from the model are trusted but filtered to the canonical
//     enum; when the model gives none, mapUnitToGradeLevels(unit_text) fills.
//   - whole_municipality=true → every product of the contract gets 'full'
//     on all municipal levels (never Högskola).
//   - duplicates dedupe with 'full' beating 'partial'; student_count fills
//     when the kept row has none.
export function expandCoverageRows(analysis) {
  const entries = Array.isArray(analysis?.coverage) ? analysis.coverage : [];
  const rows = new Map(); // "product\0grade" → row
  const upsert = (product_name, grade_level, status, student_count) => {
    const key = `${product_name}\u0000${grade_level}`;
    const prev = rows.get(key);
    if (!prev) {
      rows.set(key, { product_name, grade_level, status, student_count });
      return;
    }
    if (status === 'full') prev.status = 'full';
    if (prev.student_count == null && student_count != null) prev.student_count = student_count;
  };

  for (const e of entries) {
    const name = typeof e?.product === 'string' && e.product.trim() ? e.product.trim() : null;
    if (!name) continue;
    let levels = (Array.isArray(e.grade_levels) ? e.grade_levels : []).filter((g) => GRADE_LEVELS.includes(g));
    if (levels.length === 0) levels = mapUnitToGradeLevels(e.unit_text);
    const status = e.status === 'full' ? 'full' : 'partial';
    for (const g of levels) upsert(name, g, status, numOrNull(e.student_count));
  }

  if (analysis?.whole_municipality === true) {
    for (const p of analysis.products ?? []) {
      if (typeof p !== 'string' || !p.trim()) continue;
      for (const g of MUNICIPAL_GRADE_LEVELS) upsert(p.trim(), g, 'full', null);
    }
  }

  return [...rows.values()].sort((a, b) =>
    a.product_name.localeCompare(b.product_name, 'sv')
    || GRADE_LEVELS.indexOf(a.grade_level) - GRADE_LEVELS.indexOf(b.grade_level));
}

// Non-destructive merge for re-analysis (finding 6): a re-run must never
// silently REGRESS a previously-good contract row. LLM output is not
// deterministic — a second pass can return is_contract=false for a document it
// once read correctly, or null out a period it once extracted. Re-analysis is
// meant to FILL new/NULL lifecycle fields, not to destroy known-good ones.
//
// Rules, given a previously-stored `existing` row for this attachment:
//   - is_contract: never flip a good 1 → 0. If it was a contract, it stays one
//     unless the new pass ALSO says contract (upgrades 0 → 1 are fine).
//   - vendor / period_start / period_end / avtalsvarde / valuta / renewal_term /
//     last_cancellation_date / extension_option_until: keep the existing
//     non-null value when the new pass returns null (fill-only). A new non-null
//     value overwrites (the point of re-analysis is to improve, not stagnate).
//   - auto_renews: keep existing when the new pass would clear a known true.
// Returns { merged, changes: [field, from, to] } for a per-contract summary.
export function mergePreserving(existing, fresh) {
  if (!existing) return { merged: fresh, changes: null };
  const changes = [];
  const merged = { ...fresh };

  // is_contract: protect a good positive.
  const oldIsContract = existing.is_contract === 1 || existing.is_contract === true;
  const newIsContract = fresh.is_contract === true;
  if (oldIsContract && !newIsContract) {
    merged.is_contract = true;
    changes.push(['is_contract', 'preserved 1 (new pass said 0)', 1]);
  }

  // Fill-only string/date/number fields — a degraded re-run (new pass null)
  // never nulls a value we already have. Includes the pricing fields so a
  // regressed re-analysis can't wipe a known annual value / pricing model.
  const fillOnly = ['vendor_name', 'period_start', 'period_end', 'avtalsvarde', 'valuta',
    'renewal_term', 'last_cancellation_date', 'extension_option_until',
    'annual_value_sek', 'one_time_value_sek', 'pricing_model', 'unit_price_sek',
    'unit', 'quantity', 'value_incl_moms'];
  for (const f of fillOnly) {
    const oldV = existing[f] ?? null;
    const newV = fresh[f] ?? null;
    if (oldV != null && newV == null) {
      merged[f] = oldV;
      changes.push([f, `preserved ${JSON.stringify(oldV)} (new pass null)`, oldV]);
    } else if (oldV != null && newV != null && oldV !== newV) {
      changes.push([f, JSON.stringify(oldV), JSON.stringify(newV)]); // record the overwrite
    }
  }

  // auto_renews: don't clear a known true.
  const oldAuto = existing.auto_renews === 1 || existing.auto_renews === true;
  const newAuto = fresh.auto_renews === true;
  if (oldAuto && !newAuto) {
    merged.auto_renews = true;
    changes.push(['auto_renews', 'preserved true (new pass false)', true]);
  }

  // Product-intelligence arrays (2026-07-10 design): line_items / coverage are
  // fill-only at the ARRAY level. An empty array from a degraded re-run is
  // "no signal" — it must never wipe previously-extracted rows. A non-empty
  // fresh array replaces (idempotent re-analysis). Handled outside the scalar
  // fillOnly loop so we log a row count, never a giant JSON diff.
  for (const f of ['line_items', 'coverage']) {
    const oldArr = Array.isArray(existing[f]) ? existing[f] : [];
    const newArr = Array.isArray(fresh[f]) ? fresh[f] : [];
    if (oldArr.length > 0 && newArr.length === 0) {
      merged[f] = oldArr;
      changes.push([f, `preserved ${oldArr.length} rows (new pass empty)`, oldArr.length]);
    }
  }

  return { merged, changes };
}

// Persist one analysis: vendor (case-insensitive upsert) + products + contract row.
// Re-running for the same attachment replaces (recordContract handles that), but
// the replacement is MERGED against the existing row so a degraded re-analysis
// can never regress a good one (finding 6).
export function storeContractAnalysis(db, attachmentId, analysis, { model, log = null } = {}) {
  // Read the existing row (with vendor name) so the merge can preserve it.
  const existing = db.raw.prepare(`
    SELECT c.id AS contract_id,
           c.is_contract, c.period_start, c.period_end, c.avtalsvarde, c.valuta,
           c.auto_renews, c.renewal_term, c.last_cancellation_date, c.extension_option_until,
           c.annual_value_sek, c.one_time_value_sek, c.pricing_model, c.unit_price_sek,
           c.unit, c.quantity, c.value_incl_moms,
           v.name AS vendor_name
    FROM contracts c
    LEFT JOIN vendors v ON v.id = c.vendor_id
    WHERE c.attachment_id = ?
  `).get(attachmentId) ?? null;

  // Normalize the fresh product-intelligence arrays to DB-row shape BEFORE the
  // merge (whole_municipality expands into coverage here, so its signal
  // participates in the empty-means-no-signal rule), and read the previously
  // stored rows so a degraded re-run can preserve them (fill-only).
  if (existing) {
    existing.line_items = db.listLineItemsForContract(existing.contract_id);
    existing.coverage = db.listCoverageForContract(existing.contract_id);
  }
  const normalized = {
    ...analysis,
    line_items: normalizeLineItems(analysis.line_items),
    coverage: expandCoverageRows(analysis),
  };

  const { merged, changes } = mergePreserving(existing, normalized);
  if (existing && changes && changes.length) {
    log?.(`REANALYSE ${merged.vendor_name ?? 'okänd'} (att ${attachmentId}): ` +
      changes.map(([f, from, to]) => `${f}: ${from} → ${JSON.stringify(to)}`).join('; '));
  }

  let vendorId = null;
  if (merged.is_contract && merged.vendor_name) {
    vendorId = db.upsertVendor(merged.vendor_name).id;
  }
  const contractId = db.recordContract({
    attachment_id: attachmentId,
    vendor_id: vendorId,
    avtalsvarde: merged.avtalsvarde,
    valuta: merged.valuta,
    period_start: merged.period_start,
    period_end: merged.period_end,
    auto_renews: merged.auto_renews,
    renewal_term: merged.renewal_term,
    last_cancellation_date: merged.last_cancellation_date,
    extension_option_until: merged.extension_option_until,
    annual_value_sek: merged.annual_value_sek,
    one_time_value_sek: merged.one_time_value_sek,
    pricing_model: merged.pricing_model,
    unit_price_sek: merged.unit_price_sek,
    unit: merged.unit,
    quantity: merged.quantity,
    value_incl_moms: merged.value_incl_moms,
    is_contract: merged.is_contract ? 1 : 0,
    summary: merged.summary,
    confidence: merged.confidence,
    analysis_json: merged,
    model,
  });
  if (vendorId) {
    for (const name of merged.products ?? []) {
      db.linkContractProduct(contractId, db.upsertProduct(vendorId, name));
    }
  }

  // Line items + coverage (2026-07-10 design). recordContract cleared the old
  // contract's rows; merged.* carries either the fresh extraction or the
  // preserved previous rows. product_id is matched by name against the
  // vendor's products when possible — never invented.
  const withProductId = (rows) => rows.map((r) => ({
    ...r,
    product_id: r.product_id ?? (vendorId
      ? db.raw.prepare('SELECT id FROM products WHERE vendor_id = ? AND name = ? COLLATE NOCASE')
          .get(vendorId, r.product_name)?.id ?? null
      : null),
  }));
  db.replaceContractLineItems(contractId, withProductId(merged.line_items ?? []));
  db.replaceContractCoverage(contractId, withProductId(merged.coverage ?? []));

  warnOnLikelyDuplicate(db, contractId, attachmentId, vendorId, merged, log);
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
