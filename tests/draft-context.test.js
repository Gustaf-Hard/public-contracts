import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { buildDraftContext } from '../src/draft-context.js';

let dir, db, convId;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draft-ctx-'));
  db = openDb(join(dir, 'test.db'));
  db.migrate();
  convId = db.createConversation({
    kommun_kod: '1280', kommun_namn: 'Malmö', role: 'central',
    contact_email: 'malmostad@malmo.se', scheduled_send_at: '2026-08-01T08:00:00Z',
  });
});
afterEach(() => { db.close?.(); rmSync(dir, { recursive: true, force: true }); });

function seedMsg({ dir = 'inbound', gmailId, body, at, analysis = null, cls = null }) {
  return db.recordMessage({
    conversation_id: convId, gmail_message_id: gmailId, direction: dir,
    from_email: dir === 'inbound' ? 'k@malmo.se' : 'gustaf.hard@gmail.com',
    to_email: 'x', subject: 's', body_text: body, received_at: at,
    attachment_count: 0, classification: cls,
    analysis_json: analysis ? JSON.stringify(analysis) : null,
  });
}

const conv = () => db.getConversation(convId);
const noAtts = { attachments: [] };

describe('buildDraftContext', () => {
  it('leads with the first outbound verbatim under Ursprunglig begäran', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Hej,\n\nJag begär avtal enligt offentlighetsprincipen.', at: '2026-08-17T14:45:24Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('# Ursprunglig begäran');
    expect(out).toContain('Jag begär avtal enligt offentlighetsprincipen.');
  });

  it('prior outbounds appear in full; prior inbounds as stored summary + classification', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    seedMsg({ dir: 'outbound', gmailId: 'o2', body: 'Om avgift krävs kan jag faktureras på Mediagraf i Stockholm AB.', at: '2026-08-20T10:00:00Z' });
    seedMsg({ gmailId: 'i1', body: 'Långt originalmejl med citerad svans...', at: '2026-08-21T09:00:00Z', cls: 'delay_promise', analysis: { summary: 'Kommunen återkommer nästa vecka.' } });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('Om avgift krävs kan jag faktureras på Mediagraf i Stockholm AB.');
    expect(out).toContain('Kommunen återkommer nästa vecka.');
    expect(out).toContain('delay_promise');
    expect(out).not.toContain('citerad svans'); // inbound bodies come from summaries, not raw text
  });

  it('inbound without stored analysis falls back to a 300-char body prefix', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    seedMsg({ gmailId: 'i1', body: 'X'.repeat(500), at: '2026-08-21T09:00:00Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('X'.repeat(300));
    expect(out).not.toContain('X'.repeat(301));
  });

  it('lists stored attachment filenames on prior messages and the trigger mail', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const m = seedMsg({ gmailId: 'i1', body: 'Här kommer avtalen.', at: '2026-08-19T14:15:00Z', analysis: { summary: 'Levererar avtal.' } });
    db.recordAttachment({ message_id: m, filename: 'NE Avtal.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    const out = buildDraftContext(db, conv(), { attachments: [{ filename: 'Skolplus_avtal.pdf', mime_type: 'application/pdf', size_bytes: 12_345 }] });
    expect(out).toContain('NE Avtal.pdf');
    expect(out).toContain('# Bilagor i det inkommande mejlet');
    expect(out).toContain('Skolplus_avtal.pdf');
  });

  it('renders a substantive trigger attachment with filename, mime type and size', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const out = buildDraftContext(db, conv(), {
      attachments: [{ filename: 'avtal.pdf', mime_type: 'application/pdf', size_bytes: 45_000 }],
    });
    expect(out).toContain('- avtal.pdf (application/pdf, 45000 B)');
  });

  it('a lone trivial signature-logo image renders the skipped-note, not a bare filename list', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const out = buildDraftContext(db, conv(), {
      attachments: [{ filename: 'image001.png', mime_type: 'image/png', size_bytes: 4_096 }],
    });
    expect(out).not.toContain('- image001.png');
    expect(out).toContain('(inga dokumentbilagor; 1 trivial bild(er) hoppades över)');
  });

  it('renders (inga) when the trigger mail carried no attachments at all', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('# Bilagor i det inkommande mejlet\n(inga)');
  });

  it('appends an [avkortat] marker only when the stored outbound body actually exceeded the cap', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Kort begäran.', at: '2026-08-17T14:45:24Z' });
    seedMsg({ dir: 'outbound', gmailId: 'o2', body: 'X'.repeat(2000), at: '2026-08-18T14:45:24Z' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('… [avkortat]');
    expect(out).not.toContain('Kort begäran. … [avkortat]');
  });

  it('summarises extracted contracts with document_type', () => {
    seedMsg({ dir: 'outbound', gmailId: 'o1', body: 'Begäran.', at: '2026-08-17T14:45:24Z' });
    const m = seedMsg({ gmailId: 'i1', body: 'Bifogat.', at: '2026-08-19T14:15:00Z' });
    const att = db.recordAttachment({ message_id: m, filename: 'oversikt.pdf', saved_path: '/x/1.pdf', mime_type: 'application/pdf', size_bytes: 10 });
    // seed a contract row exactly as tests/contracts-storage.test.js does:
    // upsertVendor first, then recordContract with vendor_id (recordContract
    // has no vendor_name param — vendor_name is a joined projection column).
    const vendor = db.upsertVendor('NE');
    db.recordContract({ attachment_id: att, vendor_id: vendor.id, is_contract: 1, document_type: 'avtal', summary: 'Avtal med NE.' });
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('# Avtal vi redan extraherat');
    expect(out).toContain('NE');
    expect(out).toContain('avtal');
  });

  it('caps the log at 20 messages and says so', () => {
    for (let i = 0; i < 25; i++) {
      seedMsg({ dir: i % 2 ? 'inbound' : 'outbound', gmailId: `m${i}`, body: `msg${i}`, at: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z` });
    }
    const out = buildDraftContext(db, conv(), noAtts);
    expect(out).toContain('äldre meddelanden utelämnade');
    expect(out).not.toContain('msg3\n'); // an elided middle message (last 20 shown are msg5..msg24)
    expect(out).toContain('msg24');      // newest survives
  });
});
