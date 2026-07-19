#!/usr/bin/env node
// Backfill the vendor↔ramavtal `reseller_relations` field (2026-07-19 design)
// over already-stored INBOUND messages. Existing analyses predate the field, so
// the map behind the kommun page's framed ramavtal tags is empty until this
// runs.
//
// ADDITIVE, FILL-ONLY, NON-DESTRUCTIVE: for each inbound message it runs a
// TARGETED LLM extraction (just the vendor↔ramavtal relations, over body_text)
// and merges the result into analysis_json.extracted.reseller_relations WITHOUT
// recomputing or touching ANY other analysis field. A message whose
// reseller_relations is already populated is skipped (idempotent). A message
// with no analysis_json (never analysed) is skipped — there is no extracted
// object to fill into. Non-inbound rows are never touched.
//
// --dry-run       : report what would change; no API calls, no writes.
// --db=<path>     : target a specific SQLite file (default PILOT_DB_PATH / data/pilot.db).
// --only=<msgId>  : single-message mode — extract + merge one message, for
//                   validating the extraction against the live API first.
//
// HARD CONSTRAINT: not run automatically. The owner runs it under supervision,
// AFTER backing up data/pilot.db — same discipline as the 2026-07-17 contract
// backfill. The injectable `client` seam keeps it fully testable offline.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { openDb } from '../src/storage.js';

const DEFAULT_MODEL = 'claude-haiku-4-5';

// Minimal targeted schema — ONLY the relations. Two required plain string
// fields per item; the array itself nullable. Well under the json_schema
// 16-union-param limit.
export const RELATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reseller_relations'],
  properties: {
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
};

export function buildRelationPrompt() {
  return `Du extraherar leverantör↔ramavtal-relationer ur ett svenskt e-postsvar från en kommunregistrator. Returnera ENDAST JSON enligt schemat.

Fyll "reseller_relations" ENDAST när kommunen uttryckligen anger att en leverantör nås via / är underleverantör i ett namngivet ramavtal eller hos en återförsäljare (t.ex. Adda, Skolon, Läromedia, Atea). Varje post är {"vendor":"<leverantör>","ramavtal":"<ramavtal/återförsäljare>"}. Gissa ALDRIG kopplingen — sätt null om kommunen inte själv säger vilket ramavtal en viss leverantör nås genom.

Exempel:
Inkommande: "NE och Magma finns som underleverantörer i vårt avtal med Läromedia."
Output: {"reseller_relations":[{"vendor":"NE","ramavtal":"Läromedia"},{"vendor":"Magma","ramavtal":"Läromedia"}]}

Inkommande: "Vi köper våra läromedel direkt från flera leverantörer."
Output: {"reseller_relations":null}`;
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

// Targeted extraction over one message body. Injectable `client` (tests pass a
// fake). Returns an array of {vendor, ramavtal} (possibly empty); null-ish
// results normalise to []. Returns [] on empty body / no client / API error so
// the backfill never crashes mid-run.
export async function extractRelationsForBody(body, { env = process.env, client = null } = {}) {
  if (!body || typeof body !== 'string' || body.trim().length === 0) return [];
  const apiKey = env.ANTHROPIC_API_KEY;
  const sdkClient = client ?? getClient(apiKey);
  if (!sdkClient) return [];
  const model = env.ANTHROPIC_ANALYSIS_MODEL ?? DEFAULT_MODEL;
  try {
    const response = await sdkClient.messages.create({
      model,
      max_tokens: 512,
      system: [{ type: 'text', text: buildRelationPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: `Inkommande svar:\n---\n${body.trim()}\n---` }],
      output_config: { format: { type: 'json_schema', schema: RELATION_SCHEMA } },
    });
    const textBlock = (response.content ?? []).find((b) => b.type === 'text');
    if (!textBlock || !textBlock.text) return [];
    const parsed = JSON.parse(textBlock.text);
    const rel = parsed?.reseller_relations;
    return Array.isArray(rel) ? rel : [];
  } catch (e) {
    console.warn(`[10-extract-reseller-relations] extraction failed: ${e.message}`);
    return [];
  }
}

// Pure merge: return a new analysis_json STRING with extracted.reseller_relations
// filled, and EVERY other field byte-preserved — or null when nothing should
// change (malformed JSON, missing extracted, already-populated, or nothing to
// add). Fill-only: never overwrites an existing non-empty reseller_relations.
export function mergeResellerRelations(analysisJson, relations) {
  if (!analysisJson || typeof analysisJson !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(analysisJson); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || !parsed.extracted || typeof parsed.extracted !== 'object') return null;
  const existing = parsed.extracted.reseller_relations;
  if (Array.isArray(existing) && existing.length > 0) return null; // fill-only
  const clean = (Array.isArray(relations) ? relations : [])
    .filter((r) => r && typeof r.vendor === 'string' && typeof r.ramavtal === 'string')
    .map((r) => ({ vendor: r.vendor, ramavtal: r.ramavtal }));
  parsed.extracted.reseller_relations = clean.length > 0 ? clean : null;
  return JSON.stringify(parsed);
}

// Pure argument parsing — keeps the IO shell trivial + unit-testable.
export function parseArgs(argv) {
  const dbPath = (argv.find((x) => x.startsWith('--db=')) ?? '').slice('--db='.length) || null;
  const onlyRaw = (argv.find((x) => x.startsWith('--only=')) ?? '').slice('--only='.length);
  const only = onlyRaw ? parseInt(onlyRaw, 10) : null;
  return {
    dryRun: argv.includes('--dry-run'),
    dbPath,
    onlyId: Number.isFinite(only) ? only : null,
  };
}

// Core backfill over an open db. Injectable `client` (fake in tests). Walks
// inbound messages (optionally one, via onlyId), extracts + fill-merges
// reseller_relations, and (unless dryRun) writes the merged analysis_json back.
// Never touches non-inbound rows. Returns a small summary for logging + tests.
export async function runBackfill({ db, env = process.env, client = null, onlyId = null, dryRun = false, log = () => {} }) {
  const rows = onlyId != null
    ? db.raw.prepare("SELECT id, body_text, analysis_json FROM messages WHERE direction = 'inbound' AND id = ?").all(onlyId)
    : db.raw.prepare("SELECT id, body_text, analysis_json FROM messages WHERE direction = 'inbound' ORDER BY id").all();
  let scanned = 0;
  let filled = 0;
  let skipped = 0;
  const update = db.raw.prepare('UPDATE messages SET analysis_json = ? WHERE id = ?');
  for (const row of rows) {
    scanned += 1;
    if (!row.analysis_json) { skipped += 1; continue; }
    const relations = await extractRelationsForBody(row.body_text, { env, client });
    const merged = mergeResellerRelations(row.analysis_json, relations);
    if (!merged) { skipped += 1; continue; }
    if (!dryRun) update.run(merged, row.id);
    filled += 1;
    log(`${dryRun ? '[dry-run] ' : ''}message #${row.id}: reseller_relations ${JSON.stringify(relations)}`);
  }
  return { scanned, filled, skipped };
}

// Only run IO when invoked as a script (never when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dryRun, dbPath, onlyId } = parseArgs(process.argv.slice(2));
  const path = dbPath ?? process.env.PILOT_DB_PATH ?? 'data/pilot.db';
  const db = openDb(path);
  db.migrate();
  const summary = await runBackfill({
    db, onlyId, dryRun,
    log: (msg) => console.log(msg),
  });
  console.log(`${dryRun ? '[dry-run] ' : ''}Done. scanned ${summary.scanned}, filled ${summary.filled}, skipped ${summary.skipped}.`);
  db.close();
}
