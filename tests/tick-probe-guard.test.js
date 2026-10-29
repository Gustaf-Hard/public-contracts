// Fix wave 2 (2026-10-29), P2 and P6: the probe list in T_REQUEST_MISSING and
// T_CROSSCHECK is left out while ANY analysable file of the kommun sits
// unread, and a probe that fails never changes the template nor crashes
// ingest. Temp-dir DB, synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick } from '../src/tick.js';
import * as analyseMod from '../src/analyse-message.js';
import { storeContractAnalysis } from '../src/analyse-contract.js';

let tmp; let db;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'probe-guard-')); db = openDb(join(tmp, 'pilot.db')); db.migrate(); });
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = { GMAIL_USER_EMAIL: 'me@example.se', GMAIL_FROM_NAME: 'Exempel Person', GMAIL_LABEL_PREFIX: 'mediagraf/pilot', SLACK_CHANNEL_ID: 'C1' };
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeGmail = (getResult) => ({
  sendMessage: vi.fn(async () => ({ id: 'out', threadId: 'thr' })),
  listInboundQuery: vi.fn(async () => Object.keys(getResult).map((id) => ({ id }))),
  getMessage: vi.fn(async (g, id) => getResult[id] ?? null),
  fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
});
const fakeSlack = () => ({ postEscalation: vi.fn(async () => ({ ts: 's1', channel: 'C1' })) });
const deps = (gmail, analyseContracts) => ({
  db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps: fakeSlack(),
  env, contractsDir: join(tmp, 'contracts'), now: new Date('2026-06-24T00:00:00Z'), analyseContracts,
});
const withPdfs = (id, thread, from, body, files) => ({
  id, threadId: thread,
  payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'To', value: 'me@x.se' }, { name: 'Subject', value: 'Svar' }],
    parts: [{ mimeType: 'text/plain', body: { data: b64(body) } },
      ...files.map((f, i) => ({ mimeType: 'application/pdf', filename: f, body: { attachmentId: `a-${id}-${i}`, size: 100 } }))] },
});
const base = { products: [], avtalsvarde: null, valuta: null, period_start: null, period_end: null, confidence: 0.9 };
// One avtal (NE) and one följebrev that names a company whose avtal is not attached.
const analyseDelivery = async ({ db: d, onlyMessageId }) => {
  const atts = d.raw.prepare('SELECT id, filename FROM attachments WHERE message_id = ? ORDER BY id').all(onlyMessageId);
  for (const a of atts) {
    storeContractAnalysis(d, a.id, /avtal/i.test(a.filename)
      ? { ...base, is_contract: true, document_type: 'avtal', vendor_name: 'NE', products: ['NE Skola'], summary: 'avtal', mentioned_agreements: [] }
      : { ...base, is_contract: false, document_type: 'följebrev_sammanställning', vendor_name: null, summary: 'följebrev',
        mentioned_agreements: [{ vendor: 'Quiculum', product: null, doc_attached: false }] }, { model: 'test' });
  }
  return { attempted_ids: atts.map((a) => a.id) };
};

const K = '9001';
function seedConv({ state = 'SENT', thread = 'thr-a', email = 'reg@prov.se', receipt = 0 } = {}) {
  const id = db.createConversation({ kommun_kod: K, kommun_namn: 'Provkommun', role: 'central', contact_email: email, scheduled_send_at: '2026-05-01T00:00:00Z' });
  db.updateConversationState(id, state, { gmail_thread_id: thread, last_outbound_at: '2026-05-01T00:00:00Z', receipt_sent: receipt });
  return id;
}
// A second conversation of the SAME kommun holding a pdf nobody has read.
function seedUnreadElsewhere() {
  const other = db.createConversation({ kommun_kod: K, kommun_namn: 'Provkommun', role: 'utbildning', contact_email: 'bun@prov.se', scheduled_send_at: '2026-05-01T00:00:00Z' });
  const msgId = db.recordMessage({ conversation_id: other, gmail_message_id: 'old-1', direction: 'inbound', from_email: 'bun@prov.se', to_email: 'me@x.se',
    subject: 'Svar', body_text: 'bifogat', received_at: '2026-05-10T00:00:00Z', attachment_count: 1 });
  db.recordAttachment({ message_id: msgId, filename: 'Avtal Exempel.pdf', saved_path: '/nonexistent/x.pdf', mime_type: 'application/pdf', size_bytes: 10 });
}
const delivery = () => vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
  intent: 'delivery', confidence: 0.9, summary: 'Svar bifogat.', suggested_action: 'send_receipt',
  draft_reply: 'Tack!', follow_up_at: null, extracted: {},
});
const closer = () => vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue({
  intent: 'delivery', confidence: 0.95, summary: 'Detta var samtliga avtal.', suggested_action: 'acknowledge',
  is_final_delivery: true, draft_reply: 'Tack!', follow_up_at: null, extracted: {},
});
const PROBE = /Stämmer det att kommunen inte har avtal|stämmer det att kommunen inte har avtal/;
const escFor = (id) => db.raw.prepare('SELECT * FROM escalations WHERE conversation_id = ? ORDER BY id DESC').get(id);

describe('T_REQUEST_MISSING probe guard', () => {
  const run = async () => {
    const id = seedConv();
    delivery();
    await runTick(deps(fakeGmail({ 'in-1': withPdfs('in-1', 'thr-a', 'Reg <reg@prov.se>', 'Bifogat.', ['Avtal NE.pdf', 'Följebrev.pdf']) }), analyseDelivery));
    return id;
  };

  it('control: with nothing unread and a working probe, the list is asked', async () => {
    const id = await run();
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_REQUEST_MISSING');
    expect(esc.draft_body).toMatch(PROBE);
  });

  it('P2: an unread file in ANOTHER conversation of the kommun leaves the probe out, and the reason says so', async () => {
    seedUnreadElsewhere();
    const id = await run();
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_REQUEST_MISSING');
    expect(esc.draft_body).not.toMatch(PROBE);
    expect(esc.reason).toMatch(/probe utelämnad: 1 oläst/);
  });

  it('P6: a probe that throws keeps T_REQUEST_MISSING with its facts, without the probe', async () => {
    db.listPurchaseRows = () => { throw new Error('boom'); };
    const id = await run();
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_REQUEST_MISSING');
    expect(esc.draft_body).not.toMatch(PROBE);
    // The facts survived: an avtal arrived, so this is not the "nothing attached" text.
    expect(esc.draft_body).not.toMatch(/inte de faktiska avtalshandlingarna bifogade/);
    expect(esc.draft_body).toMatch(/Tack för avtalen/);
    expect(esc.reason).toMatch(/probe utelämnad: kunde inte beräknas/);
  });

  it('P6: any other throw on the receipt path falls back to a plain T_RECEIPT', async () => {
    db.listContractInfoForConversation = () => { throw new Error('boom'); };
    const id = await run();
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_RECEIPT');
    expect(esc.draft_body).not.toMatch(/bifogade/);
  });
});

describe('T_CROSSCHECK probe guard', () => {
  const run = async () => {
    const id = seedConv({ state: 'DELIVERING', thread: 'thr-s', receipt: 1 });
    closer();
    await runTick(deps(fakeGmail({ 'in-s': withPdfs('in-s', 'thr-s', 'Reg <reg@prov.se>', 'Det var samtliga avtal.', ['Avtal NE.pdf']) }), analyseDelivery));
    return id;
  };

  it('control: the checklist is drafted with the probe', async () => {
    const id = await run();
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_CROSSCHECK');
    expect(esc.draft_body).toMatch(PROBE);
  });

  it('P2: an unread file anywhere in the kommun drafts the closing mail without the probe', async () => {
    seedUnreadElsewhere();
    const id = await run();
    expect(db.getConversation(id).state).toBe('CROSSCHECK');
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_CROSSCHECK');
    expect(esc.draft_body).not.toMatch(PROBE);
    expect(esc.draft_body).not.toMatch(/Finns något av dem/);
    expect(esc.draft_body).not.toMatch(/betraktar jag min begäran som besvarad/);
    expect(esc.reason).toMatch(/probe utelämnad: 1 oläst/);
  });

  it('P6: a probe that throws never crashes ingest; the mail is recorded and drafted without the probe', async () => {
    db.listPurchaseRows = () => { throw new Error('boom'); };
    const id = await run();
    expect(db.raw.prepare("SELECT COUNT(*) n FROM messages WHERE gmail_message_id = 'in-s'").get().n).toBe(1);
    expect(db.getConversation(id).state).toBe('CROSSCHECK');
    const esc = escFor(id);
    expect(esc.draft_template).toBe('T_CROSSCHECK');
    expect(esc.draft_body).not.toMatch(PROBE);
    expect(esc.reason).toMatch(/probe utelämnad: kunde inte beräknas/);
  });
});
