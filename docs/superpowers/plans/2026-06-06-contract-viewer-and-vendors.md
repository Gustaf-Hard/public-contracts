# Avtalsvisning + leverantörssidor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clickable contract PDFs in the pilot dashboard (`/attachments/:id`) plus a vendor registry (`/leverantorer`, `/leverantor/:slug`) built from LLM analysis of each contract PDF.

**Architecture:** Three new sqlite tables (`vendors`, `products`, `contracts` + join table) populated by a new `src/analyse-contract.js` module that sends each PDF to Claude as a base64 `document` block with structured output (mirrors `src/analyse-message.js`). A runner script and a tick hook both call the same idempotent `analysePendingContracts`. The dashboard gains one file-serving route and two vendor pages.

**Tech Stack:** Node 20 ESM, better-sqlite3, express, @anthropic-ai/sdk (`claude-opus-4-8`), vitest (offline, fake clients).

**Spec:** `docs/superpowers/specs/2026-06-06-contract-viewer-and-vendors-design.md`

## File structure

| File | Responsibility |
|---|---|
| `src/storage.js` (modify) | New tables in SCHEMA + vendor/product/contract helpers |
| `src/analyse-contract.js` (create) | LLM call per PDF, store analysis, `analysePendingContracts` orchestrator |
| `scripts/06-analyse-contracts.js` (create) | CLI runner: `--force`, `--only=<id>` |
| `src/tick.js` (modify) | Hook: analyse pending contracts at end of `runTick` |
| `src/dashboard.js` (modify) | `GET /attachments/:id`, `GET /leverantorer`, `GET /leverantor/:slug`, `contractsDir` dep |
| `src/dashboard-views.js` (modify) | Clickable filenames (table + timeline), nav link, `renderVendors`, `renderVendorDetail`, vendor-tag links |
| `tests/contracts-storage.test.js` (create) | Schema + helper tests |
| `tests/analyse-contract.test.js` (create) | LLM module tests (fake client) |
| `tests/dashboard.test.js` (modify) | Route + view tests |
| `tests/tick.test.js` (modify) | Tick-hook test |

---

### Task 1: Storage — tables + helpers

**Files:**
- Modify: `src/storage.js` (SCHEMA const at top; helpers + exports inside `openDb`)
- Test: `tests/contracts-storage.test.js` (create)

- [ ] **Step 1: Write failing tests**

```js
// tests/contracts-storage.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';

let tmp, db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'contracts-'));
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// Helper: a contract row needs an attachment, which needs a message + conversation.
function seedAttachment({ kommun_kod = '1980', kommun_namn = 'Västerås', filename = 'Avtal X.pdf' } = {}) {
  const convId = db.createConversation({
    kommun_kod, kommun_namn, role: 'central',
    contact_email: 'reg@example.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`,
    direction: 'inbound', from_email: 'reg@example.se', to_email: 'me@example.com',
    subject: 'Avtal', body_text: 'Se bifogat', classification: null,
    classification_confidence: null, received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const attId = db.recordAttachment({
    message_id: msgId, filename,
    saved_path: `data/contracts/${kommun_kod}/${filename}`,
    mime_type: 'application/pdf', size_bytes: 1000,
  });
  return { convId, msgId, attId };
}

describe('vendors', () => {
  it('upsertVendor creates with kebab-case slug (å/ä/ö folded)', () => {
    const v = db.upsertVendor('Lärömedia Önline');
    expect(v.slug).toBe('laromedia-online');
    expect(v.name).toBe('Lärömedia Önline');
  });

  it('upsertVendor is case-insensitive on name', () => {
    const a = db.upsertVendor('Skolon');
    const b = db.upsertVendor('SKOLON');
    expect(b.id).toBe(a.id);
  });
});

describe('contracts', () => {
  it('recordContract + listContractsForVendor round-trips with kommun info', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Skolon');
    const contractId = db.recordContract({
      attachment_id: attId, vendor_id: v.id,
      avtalsvarde: '120 000', valuta: 'SEK',
      period_start: '2025-08-01', period_end: '2027-07-31',
      is_contract: 1, summary: 'Lärplattform', confidence: 0.95,
      analysis_json: { vendor_name: 'Skolon' }, model: 'claude-opus-4-8',
    });
    db.linkContractProduct(contractId, db.upsertProduct(v.id, 'Skolon Plattform'));

    const rows = db.listContractsForVendor(v.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kommun_namn).toBe('Västerås');
    expect(rows[0].filename).toBe('Avtal X.pdf');
    expect(rows[0].products).toEqual(['Skolon Plattform']);
  });

  it('recordContract replaces on same attachment_id (re-analysis)', () => {
    const { attId } = seedAttachment();
    const v1 = db.upsertVendor('Fel AB');
    db.recordContract({ attachment_id: attId, vendor_id: v1.id, is_contract: 1 });
    const v2 = db.upsertVendor('Rätt AB');
    db.recordContract({ attachment_id: attId, vendor_id: v2.id, is_contract: 1 });
    expect(db.listContractsForVendor(v1.id)).toHaveLength(0);
    expect(db.listContractsForVendor(v2.id)).toHaveLength(1);
  });

  it('listPendingContractAttachments returns PDFs without contracts row only', () => {
    const a = seedAttachment({ filename: 'A.pdf' });
    const b = seedAttachment({ filename: 'B.pdf' });
    db.recordContract({ attachment_id: a.attId, vendor_id: null, is_contract: 0 });
    const pending = db.listPendingContractAttachments();
    expect(pending.map((p) => p.id)).toEqual([b.attId]);
    expect(pending[0].kommun_namn).toBe('Västerås');
  });
});

describe('listVendorsOverview', () => {
  it('aggregates contract count, kommun count, products', () => {
    const { attId } = seedAttachment();
    const v = db.upsertVendor('Skolon');
    const cId = db.recordContract({ attachment_id: attId, vendor_id: v.id, is_contract: 1 });
    db.linkContractProduct(cId, db.upsertProduct(v.id, 'Plattform'));
    const rows = db.listVendorsOverview();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Skolon', slug: 'skolon', contract_count: 1, kommun_count: 1 });
    expect(rows[0].products).toEqual(['Plattform']);
  });

  it('getVendorBySlug finds vendor, returns undefined otherwise', () => {
    db.upsertVendor('Skolon');
    expect(db.getVendorBySlug('skolon').name).toBe('Skolon');
    expect(db.getVendorBySlug('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/contracts-storage.test.js`
Expected: FAIL — `db.upsertVendor is not a function`

- [ ] **Step 3: Implement**

Append to the `SCHEMA` template string in `src/storage.js` (after the
`daemon_heartbeat` table):

```sql
CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendors_name_nocase ON vendors(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  name TEXT NOT NULL,
  UNIQUE(vendor_id, name)
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  attachment_id INTEGER NOT NULL UNIQUE REFERENCES attachments(id),
  vendor_id INTEGER REFERENCES vendors(id),
  avtalsvarde TEXT,
  valuta TEXT,
  period_start TEXT,
  period_end TEXT,
  is_contract INTEGER NOT NULL DEFAULT 1,
  summary TEXT,
  confidence REAL,
  analysis_json TEXT,
  model TEXT,
  analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_vendor ON contracts(vendor_id);

CREATE TABLE IF NOT EXISTS contract_products (
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (contract_id, product_id)
);
```

Add helpers inside `openDb` (before the return) and add them to the returned
object:

```js
function slugify(name) {
  return name.toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function upsertVendor(name) {
  const existing = db.prepare('SELECT * FROM vendors WHERE name = ? COLLATE NOCASE').get(name);
  if (existing) return existing;
  let slug = slugify(name) || 'leverantor';
  // Diacritics can fold two distinct names onto one slug — suffix until free.
  let candidate = slug, n = 2;
  while (db.prepare('SELECT 1 FROM vendors WHERE slug = ?').get(candidate)) {
    candidate = `${slug}-${n++}`;
  }
  const r = db.prepare('INSERT INTO vendors (name, slug) VALUES (?, ?)').run(name, candidate);
  return db.prepare('SELECT * FROM vendors WHERE id = ?').get(Number(r.lastInsertRowid));
}

function upsertProduct(vendorId, name) {
  db.prepare('INSERT OR IGNORE INTO products (vendor_id, name) VALUES (?, ?)').run(vendorId, name);
  return db.prepare('SELECT id FROM products WHERE vendor_id = ? AND name = ?').get(vendorId, name).id;
}

function recordContract(c) {
  // Re-analysis replaces: clear old row + product links for this attachment.
  const old = db.prepare('SELECT id FROM contracts WHERE attachment_id = ?').get(c.attachment_id);
  if (old) {
    db.prepare('DELETE FROM contract_products WHERE contract_id = ?').run(old.id);
    db.prepare('DELETE FROM contracts WHERE id = ?').run(old.id);
  }
  const r = db.prepare(`
    INSERT INTO contracts (attachment_id, vendor_id, avtalsvarde, valuta, period_start, period_end,
                           is_contract, summary, confidence, analysis_json, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    c.attachment_id, c.vendor_id ?? null, c.avtalsvarde ?? null, c.valuta ?? null,
    c.period_start ?? null, c.period_end ?? null, c.is_contract ?? 1,
    c.summary ?? null, c.confidence ?? null,
    c.analysis_json != null ? JSON.stringify(c.analysis_json) : null, c.model ?? null,
  );
  return Number(r.lastInsertRowid);
}

function linkContractProduct(contractId, productId) {
  db.prepare('INSERT OR IGNORE INTO contract_products (contract_id, product_id) VALUES (?, ?)').run(contractId, productId);
}

function listPendingContractAttachments() {
  return db.prepare(`
    SELECT a.*, conv.kommun_kod, conv.kommun_namn, conv.role
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    JOIN conversations conv ON conv.id = m.conversation_id
    LEFT JOIN contracts c ON c.attachment_id = a.id
    WHERE c.id IS NULL
      AND (a.mime_type = 'application/pdf' OR lower(a.filename) LIKE '%.pdf')
    ORDER BY a.id
  `).all();
}

function productsForContractIds(ids) {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(`
    SELECT cp.contract_id, p.name FROM contract_products cp
    JOIN products p ON p.id = cp.product_id
    WHERE cp.contract_id IN (${ids.map(() => '?').join(',')})
    ORDER BY p.name
  `).all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.contract_id)) map.set(r.contract_id, []);
    map.get(r.contract_id).push(r.name);
  }
  return map;
}

function listContractsForVendor(vendorId) {
  const rows = db.prepare(`
    SELECT c.*, a.filename, a.size_bytes, a.id AS attachment_id,
           m.received_at, conv.kommun_namn, conv.kommun_kod
    FROM contracts c
    JOIN attachments a ON a.id = c.attachment_id
    JOIN messages m ON m.id = a.message_id
    JOIN conversations conv ON conv.id = m.conversation_id
    WHERE c.vendor_id = ? AND c.is_contract = 1
    ORDER BY m.received_at DESC
  `).all(vendorId);
  const prodMap = productsForContractIds(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, products: prodMap.get(r.id) ?? [] }));
}

function listVendorsOverview() {
  const rows = db.prepare(`
    SELECT v.id, v.name, v.slug,
           COUNT(DISTINCT c.id) AS contract_count,
           COUNT(DISTINCT conv.kommun_kod) AS kommun_count,
           MAX(m.received_at) AS last_contract_at
    FROM vendors v
    LEFT JOIN contracts c ON c.vendor_id = v.id AND c.is_contract = 1
    LEFT JOIN attachments a ON a.id = c.attachment_id
    LEFT JOIN messages m ON m.id = a.message_id
    LEFT JOIN conversations conv ON conv.id = m.conversation_id
    GROUP BY v.id
    ORDER BY contract_count DESC, v.name COLLATE NOCASE
  `).all();
  const prods = db.prepare(`
    SELECT vendor_id, name FROM products ORDER BY name
  `).all();
  const byVendor = new Map();
  for (const p of prods) {
    if (!byVendor.has(p.vendor_id)) byVendor.set(p.vendor_id, []);
    byVendor.get(p.vendor_id).push(p.name);
  }
  return rows.map((r) => ({ ...r, products: byVendor.get(r.id) ?? [] }));
}

function getVendorBySlug(slug) {
  return db.prepare('SELECT * FROM vendors WHERE slug = ?').get(slug);
}
```

Export them all from the returned object (alongside `migrate`, `recordAttachment`, …):
`upsertVendor, upsertProduct, recordContract, linkContractProduct, listPendingContractAttachments, listContractsForVendor, listVendorsOverview, getVendorBySlug`.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/contracts-storage.test.js` → PASS
Run: `npx vitest run tests/storage.test.js` → PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/storage.js tests/contracts-storage.test.js
git commit -m "feat(storage): vendors/products/contracts tables + helpers"
```

---

### Task 2: `analyseContractPdf` — the LLM call

**Files:**
- Create: `src/analyse-contract.js`
- Test: `tests/analyse-contract.test.js` (create)

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/analyse-contract.test.js`
Expected: FAIL — cannot find module `../src/analyse-contract.js`

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/analyse-contract.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyse-contract.js tests/analyse-contract.test.js
git commit -m "feat(contracts): analyseContractPdf — PDF as document block, structured output"
```

---

### Task 3: `storeContractAnalysis` + `analysePendingContracts`

**Files:**
- Modify: `src/analyse-contract.js` (append two exports)
- Test: `tests/analyse-contract.test.js` (append a describe block)

- [ ] **Step 1: Write failing tests**

Append to `tests/analyse-contract.test.js`:

```js
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb } from '../src/storage.js';
import { storeContractAnalysis, analysePendingContracts } from '../src/analyse-contract.js';

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
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/analyse-contract.test.js`
Expected: FAIL — `storeContractAnalysis` not exported

- [ ] **Step 3: Implement**

Append to `src/analyse-contract.js`:

```js
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Persist one analysis: vendor (case-insensitive upsert) + products + contract row.
// Re-running for the same attachment replaces (recordContract handles that).
export function storeContractAnalysis(db, attachmentId, analysis, { model } = {}) {
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
  return contractId;
}

// Analyse every PDF attachment that has no contracts row yet. Errors on one
// PDF never block the others, and never throw to the caller (tick safety).
// Returns the number of attachments successfully analysed+stored.
export async function analysePendingContracts({ db, env = process.env, client = null, log = null, force = false, onlyId = null } = {}) {
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
    storeContractAnalysis(db, att.id, analysis, { model });
    log?.(`CONTRACT analysed: ${att.filename} → ${analysis.is_contract ? (analysis.vendor_name ?? 'okänd leverantör') : 'ej avtal'}`);
    done += 1;
  }
  return done;
}
```

Note: imports go at the top of the file with the existing `import Anthropic` line.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/analyse-contract.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/analyse-contract.js tests/analyse-contract.test.js
git commit -m "feat(contracts): storeContractAnalysis + idempotent analysePendingContracts"
```

---

### Task 4: Runner script `scripts/06-analyse-contracts.js`

**Files:**
- Create: `scripts/06-analyse-contracts.js`
- Modify: `package.json` (add npm script)

This is a thin CLI wrapper over Task 3 (the logic is already tested); the
repo's other runner scripts are likewise untested.

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// Analyse contract PDFs in pilot.db with Claude and populate
// vendors/products/contracts. Idempotent: only attachments without a
// contracts row are analysed. --force re-analyses everything (use after
// prompt/schema changes); --only=<attachment_id> targets one attachment.
import 'dotenv/config';
import { openDb } from '../src/storage.js';
import { analysePendingContracts } from '../src/analyse-contract.js';

function flag(name) { return process.argv.includes(`--${name}`); }
function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

const db = openDb(process.env.PILOT_DB_PATH ?? 'data/pilot.db');
db.migrate();

const onlyArg = arg('only');
const n = await analysePendingContracts({
  db,
  force: flag('force'),
  onlyId: onlyArg != null ? parseInt(onlyArg, 10) : null,
  log: (msg) => console.log(msg),
});
console.log(`Done. ${n} attachment(s) analysed.`);
db.close();
```

Add to `package.json` scripts:

```json
"analyse-contracts": "node scripts/06-analyse-contracts.js"
```

- [ ] **Step 2: Verify it runs (no key path)**

Run: `ANTHROPIC_API_KEY= node scripts/06-analyse-contracts.js`
Expected: `Done. 0 attachment(s) analysed.` and exit 0 (dotenv may still load the real key — if it analyses for real, that's fine too, but for a pure smoke test unset via `env -u`).

- [ ] **Step 3: Commit**

```bash
git add scripts/06-analyse-contracts.js package.json
git commit -m "feat(contracts): runner script 06-analyse-contracts (--force, --only)"
```

---

### Task 5: Tick hook

**Files:**
- Modify: `src/tick.js` (end of `runTick`)
- Test: `tests/tick.test.js` (append one test)

The hook is injectable (`deps.analyseContracts`) so tick tests don't need an
Anthropic fake, and so the daemon wires the real function.

- [ ] **Step 1: Write failing test**

Append to `tests/tick.test.js` (reuse the existing test harness/fakes in that
file — follow the established pattern for constructing `deps`; the key
assertions are):

```js
it('runTick calls the injected analyseContracts hook with the db', async () => {
  const analyseContracts = vi.fn(async () => 0);
  // build deps exactly like the existing minimal runTick tests in this file,
  // then add the hook:
  await runTick({ ...minimalDeps(), analyseContracts });
  expect(analyseContracts).toHaveBeenCalledTimes(1);
  expect(analyseContracts.mock.calls[0][0]).toHaveProperty('db');
});

it('runTick survives an analyseContracts hook that throws', async () => {
  const analyseContracts = vi.fn(async () => { throw new Error('llm down'); });
  await expect(runTick({ ...minimalDeps(), analyseContracts })).resolves.not.toThrow();
});
```

(If `tests/tick.test.js` has no reusable `minimalDeps` helper, inline the same
deps object its smallest existing test uses.)

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/tick.test.js -t "analyseContracts"`
Expected: FAIL — hook never called

- [ ] **Step 3: Implement**

At the end of `runTick` in `src/tick.js` (after the inbound-processing loop,
before the function returns):

```js
  // 3. Contract analysis — any saved PDFs that haven't been analysed yet.
  // Injectable for tests; failures must never break the tick.
  const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
  try {
    await analyseContracts({ db, env, log: deps.log });
  } catch (e) {
    deps.log?.(`contract analysis error: ${e.message}`);
  }
```

Add the import at the top of `src/tick.js`:

```js
import { analysePendingContracts } from './analyse-contract.js';
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/tick.test.js` → PASS (all, including pre-existing)

- [ ] **Step 5: Commit**

```bash
git add src/tick.js tests/tick.test.js
git commit -m "feat(tick): analyse newly saved contract PDFs after inbound processing"
```

---

### Task 6: Dashboard route `GET /attachments/:id`

**Files:**
- Modify: `src/dashboard.js` (new route + `contractsDir` dep on `createDashboardApp`, currently `src/dashboard.js:310`)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/dashboard.test.js`. The file's `get()` helper returns text —
add a header-aware variant and a seeding helper:

```js
async function getRaw(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => {
        const text = await r.text();
        server.close(() => resolve({ status: r.status, text, headers: r.headers }));
      }).catch((e) => server.close(() => reject(e)));
    });
  });
}

function seedPdfAttachment({ filename = 'Avtal X.pdf', savedPath = null } = {}) {
  const convId = db.createConversation({
    kommun_kod: '2418', kommun_namn: 'Malå', role: 'central',
    contact_email: 'kommun@mala.se', scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
    from_email: 'kommun@mala.se', to_email: 'me@x.com', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null,
    received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const contractsDir = join(tmp, 'contracts');
  const realPath = savedPath ?? join(contractsDir, '2418', filename);
  require('node:fs').mkdirSync(require('node:path').dirname(realPath), { recursive: true });
  require('node:fs').writeFileSync(realPath, '%PDF-1.4 test');
  const attId = db.recordAttachment({
    message_id: msgId, filename, saved_path: realPath,
    mime_type: 'application/pdf', size_bytes: 13,
  });
  return { convId, attId, contractsDir };
}

describe('GET /attachments/:id', () => {
  it('serves the PDF inline with correct headers', async () => {
    const { attId, contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir });
    const res = await getRaw(app, `/attachments/${attId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('inline');
    expect(res.text).toContain('%PDF-1.4');
  });

  it('404 on unknown id', async () => {
    const { contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir });
    expect((await getRaw(app, '/attachments/99999')).status).toBe(404);
  });

  it('404 when saved_path escapes contractsDir', async () => {
    const outside = join(tmp, 'secret.pdf');
    const { attId } = seedPdfAttachment({ savedPath: outside });
    const app = createDashboardApp({ db, municipalitiesLoader: () => [], contractsDir: join(tmp, 'contracts') });
    expect((await getRaw(app, `/attachments/${attId}`)).status).toBe(404);
  });
});
```

(Adjust imports at the top of the test file: `join` is already imported; add
`mkdirSync`, `writeFileSync` to the `node:fs` import instead of `require` if
the file uses ESM imports — match the file's existing style.)

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "attachments"`
Expected: FAIL — 404 for all (route missing) → first test fails

- [ ] **Step 3: Implement**

In `src/dashboard.js`: add `import path from 'node:path';` and
`import fs from 'node:fs';` (if not present). Extend the signature:

```js
export function createDashboardApp({
  db = openDbOrNull(),
  municipalitiesLoader = loadMunicipalities,
  gmailClient = loadGmail(process.env),
  env = process.env,
  contractsDir = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts',
} = {}) {
```

Add the route (next to the other GETs):

```js
  // Serve a stored contract PDF inline. Lookup is by DB id only — the file
  // path never appears in the URL. All failure modes are 404.
  app.get('/attachments/:id', (req, res) => {
    if (!db) return res.status(404).send('Not found');
    const att = db.raw.prepare('SELECT * FROM attachments WHERE id = ?')
      .get(parseInt(req.params.id, 10));
    if (!att) return res.status(404).send('Not found');
    const base = path.resolve(contractsDir);
    const full = path.resolve(att.saved_path);
    if (!full.startsWith(base + path.sep)) return res.status(404).send('Not found');
    if (!fs.existsSync(full)) return res.status(404).send('Not found');
    res.set('Content-Type', att.mime_type || 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${att.filename.replace(/["\\\r\n]/g, '')}"`);
    res.sendFile(full);
  });
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/dashboard.test.js` → PASS (all)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js tests/dashboard.test.js
git commit -m "feat(dashboard): serve contract PDFs inline via /attachments/:id"
```

---

### Task 7: Clickable filenames — table + timeline

**Files:**
- Modify: `src/dashboard-views.js` (`aggregateContracts` ~line 811, contracts table cell ~line 937, `buildTimeline` 📎 event ~line 168, `renderTimeline` ~line 191)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing test**

```js
describe('clickable contract links on kommun page', () => {
  it('Mottagna avtal table and timeline link to /attachments/:id', async () => {
    const { attId, contractsDir } = seedPdfAttachment();
    const app = createDashboardApp({
      db, contractsDir,
      municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }],
    });
    const res = await get(app, '/kommun/2418');
    const matches = res.text.match(new RegExp(`href="/attachments/${attId}"`, 'g'));
    expect(matches?.length).toBeGreaterThanOrEqual(2); // table + timeline
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "clickable"` → FAIL (0 matches)

- [ ] **Step 3: Implement** (`src/dashboard-views.js`)

1. `aggregateContracts` — add `id` to the pushed object:

```js
        out.push({
          id: att.id,
          filename: att.filename,
          size_bytes: att.size_bytes,
          received_at: m.received_at,
          role: conv.role,
          conv_id: conv.id,
        });
```

2. Contracts-table cell — replace
`<td>📎 ${escapeHtml(c.filename)}</td>` with:

```js
              <td><a href="/attachments/${c.id}" target="_blank" rel="noopener">📎 ${escapeHtml(c.filename)}</a></td>
```

3. `buildTimeline` 📎 event — add `link`:

```js
      for (const att of attachmentsByMsg[m.id] ?? []) {
        events.push({
          ts,
          icon: '📎',
          title: 'Avtal mottaget',
          sub: att.filename,
          link: `/attachments/${att.id}`,
        });
      }
```

4. `renderTimeline` — wrap `e.sub` in a link when `e.link` is set. Replace
`${e.sub ? `<div class="ev-sub">${escapeHtml(e.sub)}</div>` : ''}` with:

```js
        ${e.sub ? `<div class="ev-sub">${e.link ? `<a href="${escapeHtml(e.link)}" target="_blank" rel="noopener">${escapeHtml(e.sub)}</a>` : escapeHtml(e.sub)}</div>` : ''}
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/dashboard.test.js` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): clickable contract PDFs in avtal table and timeline"
```

---

### Task 8: Vendor pages — `/leverantorer` + `/leverantor/:slug` + nav

**Files:**
- Modify: `src/dashboard.js` (two routes), `src/dashboard-views.js` (nav at ~line 514, two render functions)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing tests**

```js
function seedVendorWithContract() {
  const { attId } = seedPdfAttachment();
  const v = db.upsertVendor('Skolon');
  const cId = db.recordContract({
    attachment_id: attId, vendor_id: v.id,
    avtalsvarde: '120 000 kr/år', valuta: 'SEK',
    period_start: '2025-08-01', period_end: '2027-07-31',
    is_contract: 1, summary: 'Lärplattform', confidence: 0.95,
  });
  db.linkContractProduct(cId, db.upsertProduct(v.id, 'Skolon Plattform'));
  return { v, attId };
}

describe('vendor pages', () => {
  it('/leverantorer lists vendors with counts and links', async () => {
    seedVendorWithContract();
    const app = appWithFakes();
    const res = await get(app, '/leverantorer');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Skolon');
    expect(res.text).toContain('href="/leverantor/skolon"');
    expect(res.text).toContain('Skolon Plattform');
  });

  it('/leverantor/:slug shows contracts with PDF links and kommun', async () => {
    const { attId } = seedVendorWithContract();
    const app = appWithFakes();
    const res = await get(app, '/leverantor/skolon');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Malå');
    expect(res.text).toContain(`href="/attachments/${attId}"`);
    expect(res.text).toContain('2027-07-31');
  });

  it('unknown slug → 404', async () => {
    const app = appWithFakes();
    expect((await get(app, '/leverantor/nope')).status).toBe(404);
  });

  it('nav contains Leverantörer link', async () => {
    const app = appWithFakes();
    const res = await get(app, '/');
    expect(res.text).toContain('href="/leverantorer"');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "vendor"` → FAIL (404s)

- [ ] **Step 3: Implement routes** (`src/dashboard.js`)

```js
  app.get('/leverantorer', (req, res) => {
    const vendors = db ? db.listVendorsOverview() : [];
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderVendors({ vendors, heartbeat: hb() }));
  });

  app.get('/leverantor/:slug', (req, res) => {
    const vendor = db ? db.getVendorBySlug(req.params.slug) : null;
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!vendor) return res.status(404).send(renderVendorDetail({ vendor: null, heartbeat: hb() }));
    const contracts = db.listContractsForVendor(vendor.id);
    res.send(renderVendorDetail({ vendor, contracts, heartbeat: hb() }));
  });
```

Import `renderVendors, renderVendorDetail` from `./dashboard-views.js`.

- [ ] **Step 4: Implement views** (`src/dashboard-views.js`)

Nav — add after the Aktivitet link in `layout`:

```js
      <a href="/leverantorer"${currentPath === '/leverantorer' ? ' style="color:var(--fg)"' : ''}>Leverantörer</a>
```

New exported render functions (place near `renderActivity`; reuse `layout`,
`escapeHtml`, `fmtBytes`, and the existing `.tag` / table CSS):

```js
function activeBadge(periodEnd) {
  if (!periodEnd) return '<span class="muted">okänd avtalstid</span>';
  const active = periodEnd >= new Date().toISOString().slice(0, 10);
  return active
    ? `<span class="pill pill-replied">aktivt t.o.m. ${escapeHtml(periodEnd)}</span>`
    : `<span class="pill pill-overdue">utgånget ${escapeHtml(periodEnd)}</span>`;
}

export function renderVendors({ vendors = [], heartbeat = null } = {}) {
  const rows = vendors.map((v) => `
    <tr>
      <td><a href="/leverantor/${escapeHtml(v.slug)}">${escapeHtml(v.name)}</a></td>
      <td><div class="tag-list">${v.products.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div></td>
      <td>${v.contract_count}</td>
      <td>${v.kommun_count}</td>
      <td>${escapeHtml(v.last_contract_at?.slice(0, 10) ?? '—')}</td>
    </tr>`).join('');
  const body = `
    <div class="card">
      <h3>Leverantörer (${vendors.length})</h3>
      ${vendors.length === 0
        ? '<p class="muted">Inga leverantörer ännu — kör <code>npm run analyse-contracts</code>.</p>'
        : `<table class="contracts-table">
            <thead><tr><th>Leverantör</th><th>Produkter</th><th>Avtal</th><th>Kommuner</th><th>Senaste avtal</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;
  return layout({ title: 'Leverantörer', body, currentPath: '/leverantorer', heartbeat });
}

export function renderVendorDetail({ vendor, contracts = [], heartbeat = null } = {}) {
  if (!vendor) {
    return layout({
      title: 'Okänd leverantör',
      body: '<div class="card"><h3>Okänd leverantör</h3><p><a href="/leverantorer">← Leverantörer</a></p></div>',
      currentPath: '/leverantorer', heartbeat,
    });
  }
  const allProducts = [...new Set(contracts.flatMap((c) => c.products))];
  const kommuner = [...new Map(contracts.map((c) => [c.kommun_kod, c.kommun_namn])).entries()];
  const rows = contracts.map((c) => `
    <tr>
      <td><a href="/kommun/${escapeHtml(c.kommun_kod)}">${escapeHtml(c.kommun_namn)}</a></td>
      <td>${escapeHtml(c.received_at?.slice(0, 10) ?? '')}</td>
      <td><a href="/attachments/${c.attachment_id}" target="_blank" rel="noopener">📎 ${escapeHtml(c.filename)}</a></td>
      <td><div class="tag-list">${c.products.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div></td>
      <td>${escapeHtml(c.avtalsvarde ?? '—')}</td>
      <td>${activeBadge(c.period_end)}</td>
    </tr>`).join('');
  const body = `
    <p><a href="/leverantorer">← Leverantörer</a></p>
    <div class="card">
      <h3>${escapeHtml(vendor.name)}</h3>
      ${allProducts.length ? `<div class="tag-list" style="margin:6px 0">${allProducts.map((p) => `<span class="tag">${escapeHtml(p)}</span>`).join('')}</div>` : ''}
      <p class="muted">${contracts.length} avtal · ${kommuner.length} kommun(er): ${kommuner.map(([kod, namn]) => `<a href="/kommun/${escapeHtml(kod)}">${escapeHtml(namn)}</a>`).join(', ')}</p>
    </div>
    <div class="card">
      <h3>Avtal (${contracts.length})</h3>
      <table class="contracts-table">
        <thead><tr><th>Kommun</th><th>Datum</th><th>Fil</th><th>Produkter</th><th>Värde</th><th>Avtalstid</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  return layout({ title: vendor.name, body, currentPath: '/leverantorer', heartbeat });
}
```

(Check the actual pill CSS class names in the file — use existing ones like
`pill-replied`/`pill-overdue` if defined, otherwise plain `tag` spans.)

- [ ] **Step 5: Run, verify pass**

Run: `npx vitest run tests/dashboard.test.js` → PASS

- [ ] **Step 6: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): leverantörsindex + leverantörssida med avtal"
```

---

### Task 9: Kommun page — vendor tags become links

**Files:**
- Modify: `src/dashboard.js` (kommun route, ~line 394 — pass vendor slug map), `src/dashboard-views.js` (`vendorsSection` ~line 943, `renderKommunDetail` signature ~line 836)
- Test: `tests/dashboard.test.js`

- [ ] **Step 1: Write failing test**

```js
it('kommun page vendor tags link to vendor page when name matches', async () => {
  seedVendorWithContract();
  // Give the conversation a message whose analysis mentions Skolon
  const conv = db.raw.prepare("SELECT * FROM conversations WHERE kommun_kod = '2418'").get();
  db.recordMessage({
    conversation_id: conv.id, gmail_message_id: `gm-${Math.random()}`, direction: 'inbound',
    from_email: 'a@b.se', to_email: 'me@x.com', subject: 'Re', body_text: 'Avtal med Skolon bifogas',
    classification: 'delivery', classification_confidence: 0.9,
    received_at: '2026-04-14T10:00:00Z', attachment_count: 0,
    analysis_json: { intent: 'delivery', extracted: { mentioned_vendors: ['Skolon'] } },
  });
  const app = createDashboardApp({
    db,
    municipalitiesLoader: () => [{ kommun_kod: '2418', kommun_namn: 'Malå', lan: 'X', folkmangd: 1, contacts: [] }],
  });
  const res = await get(app, '/kommun/2418');
  expect(res.text).toContain('href="/leverantor/skolon"');
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run tests/dashboard.test.js -t "vendor tags"` → FAIL

- [ ] **Step 3: Implement**

`src/dashboard.js` — in the `/kommun/:kod` handler, build the lookup and pass
it to the renderer:

```js
    const vendorSlugsByName = new Map(
      (db ? db.listVendorsOverview() : []).map((v) => [v.name.toLowerCase(), v.slug])
    );
```

and add `vendorSlugsByName,` to the `renderKommunDetail({ ... })` call.

`src/dashboard-views.js` — add `vendorSlugsByName = new Map()` to the
`renderKommunDetail` destructured params, then update `vendorsSection`:

```js
        <div class="tag-list">${vendors.map((v) => {
          const slug = vendorSlugsByName.get(v.toLowerCase());
          return slug
            ? `<a class="tag" href="/leverantor/${escapeHtml(slug)}">${escapeHtml(v)}</a>`
            : `<span class="tag">${escapeHtml(v)}</span>`;
        }).join('')}</div>
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run tests/dashboard.test.js` → PASS
Run: `npm test` → ALL PASS (full offline suite)

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.js src/dashboard-views.js tests/dashboard.test.js
git commit -m "feat(dashboard): kommun-sidans leverantörstaggar länkar till leverantörssidan"
```

---

### Task 10: Live verification

**Files:** none (operational)

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all tests pass (was 65 before this work; now more).

- [ ] **Step 2: Analyse the real PDFs**

Run: `npm run analyse-contracts`
Expected: ~11 `CONTRACT analysed: …` lines (real Anthropic calls against
`claude-opus-4-8`; requires `ANTHROPIC_API_KEY` in `.env`).
Check: `sqlite3 data/pilot.db "SELECT v.name, count(*) FROM contracts c JOIN vendors v ON v.id=c.vendor_id GROUP BY v.id"`

- [ ] **Step 3: Restart dashboard + daemon, eyeball**

Restart both processes (they cache code at startup). Then:
- http://localhost:3100/kommun/1980 — click a PDF in "Mottagna avtal" → opens inline.
- http://localhost:3100/leverantorer — vendors listed with counts.
- Click a vendor → contracts table with working PDF links and aktiv/utgången badges.

- [ ] **Step 4: Commit anything outstanding, report**

`data/pilot.db` is not in git (check `.gitignore`) — nothing to commit from the
live run. Report results to the user with screenshots/URLs.

---

## Self-review notes

- Spec coverage: Part 1 (route Task 6, views Task 7), Part 2 (schema Task 1,
  LLM Task 2-3, runner Task 4, tick hook Task 5, UI Task 8-9), testing spread
  across all tasks, live verification Task 10. ✓
- Type consistency: `db.upsertVendor → {id, name, slug}`, `recordContract`
  takes `attachment_id`/`vendor_id`, `listContractsForVendor` returns rows with
  `products: string[]`, `attachment_id`, `kommun_*` — used consistently in
  Tasks 1, 3, 8. ✓
- Task 5's test reuses tick.test.js's existing fakes — the executor must adapt
  to the file's actual helper names; assertions are fully specified. ✓
