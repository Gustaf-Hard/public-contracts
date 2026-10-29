// Fix wave 2 (2026-10-29): the probe read from a real (temp-dir) pilot DB.
// Hand-written, synthetic fixtures only: the repo is public.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { storeContractAnalysis } from '../src/analyse-contract.js';
import { probeFromDb } from '../src/probe-list.js';

let tmp; let db;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'probe-w2-')); db = openDb(join(tmp, 'pilot.db')); db.migrate(); });
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const K = '9001';
let n = 0;
function conv(kod = K) {
  return db.createConversation({ kommun_kod: kod, kommun_namn: `Provkommun ${kod}`, role: 'central', contact_email: `reg${n += 1}@prov.se`, scheduled_send_at: '2026-04-01T08:00:00Z' });
}
function attach(convId, filename = 'dok.pdf') {
  const msgId = db.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${n += 1}`, direction: 'inbound', from_email: 'reg@prov.se', to_email: 'me@example.com',
    subject: 'Svar', body_text: 'Se bifogat', received_at: '2026-05-02T10:00:00Z', attachment_count: 1,
  });
  return db.recordAttachment({ message_id: msgId, filename, saved_path: `/nonexistent/${filename}`, mime_type: 'application/pdf', size_bytes: 10 });
}
const analysis = (over) => ({
  is_contract: false, document_type: 'övrigt', vendor_name: null, products: [], avtalsvarde: null, valuta: null,
  period_start: null, period_end: null, summary: 'Ett dokument.', confidence: 0.9, mentioned_agreements: [], ...over,
});
const allNames = (p) => p.categories.flatMap((c) => c.names);
const NO_STATS = null;

describe('probeFromDb: documents that are not avtal strike their company (P1)', () => {
  it('an invoice, a licensbevis and a PUB-avtal each strike the company they come from', () => {
    const c = conv();
    storeContractAnalysis(db, attach(c, 'faktura 1.pdf'), analysis({ document_type: 'övrigt', vendor_name: 'Sanoma Utbildning', products: ['Bingel'] }), { model: 't' });
    storeContractAnalysis(db, attach(c, 'licensbevis.pdf'), analysis({ vendor_name: 'Symbolbruket', products: ['InPrint 4'] }), { model: 't' });
    storeContractAnalysis(db, attach(c, 'pub.pdf'), analysis({ document_type: 'personuppgiftsbiträdesavtal', vendor_name: 'Binogi' }), { model: 't' });
    const p = probeFromDb(db, K, { stats: NO_STATS });
    for (const name of ['Sanoma Utbildning', 'Symbolbruket (Widgit)', 'Binogi']) expect(allNames(p)).not.toContain(name);
    expect(p.struck.find((s) => s.name === 'Binogi').reason).toBe('nämns i kommunens underlag');
  });

  it('a document of another kommun strikes nothing here', () => {
    storeContractAnalysis(db, attach(conv('9002')), analysis({ vendor_name: 'Binogi' }), { model: 't' });
    storeContractAnalysis(db, attach(conv(K)), analysis({ vendor_name: 'NE' }), { model: 't' });
    expect(allNames(probeFromDb(db, K, { stats: NO_STATS }))).toContain('Binogi');
  });

  it('an avtal under a channel strikes the company its filename names (P3)', () => {
    storeContractAnalysis(db, attach(conv(), 'Trelson Avtal EX-1 Digitala prov.pdf'), analysis({ is_contract: true, document_type: 'avtal', vendor_name: 'Online Partner', products: ['Digitala prov'] }), { model: 't' });
    const p = probeFromDb(db, K, { stats: NO_STATS });
    expect(allNames(p)).not.toContain('Trelson');
    expect(p.struck.find((s) => s.name === 'Trelson').reason).toBe('avtal finns');
  });
});
