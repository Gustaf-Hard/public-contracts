// Hardening findings (autopilot review M3-partial, M8, L2, L3, L6-partial)
// plus the M4 htmlToText unit contract.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { sameEmailDomain, htmlToText, parseInboundMessage } from '../src/gmail.js';
import { buildSystemPrompt } from '../src/analyse-message.js';
import { beginReauth } from '../src/gmail-auth.js';
import { sendApprovedReply } from '../src/send-reply.js';
import { storeContractAnalysis } from '../src/analyse-contract.js';

describe('sameEmailDomain — subdomains match, look-alikes do not (L2)', () => {
  it('matches a förvaltning subdomain against the kommun contact domain', () => {
    expect(sameEmailDomain('a@utbildning.ale.se', 'kansli@ale.se')).toBe(true);
    expect(sameEmailDomain('kansli@ale.se', 'a@utbildning.ale.se')).toBe(true);
    expect(sameEmailDomain('a@ale.se', 'b@ale.se')).toBe(true);
  });
  it('still rejects look-alike domains without a dot boundary', () => {
    expect(sameEmailDomain('a@xvasteras.se', 'b@vasteras.se')).toBe(false);
    expect(sameEmailDomain('a@vasteras.se.evil.com', 'b@vasteras.se')).toBe(false);
  });
});

describe('LLM prompt identity from env (M8)', () => {
  it('signs with GMAIL_FROM_NAME/GMAIL_USER_EMAIL and contains no hardcoded personal identity', () => {
    const p = buildSystemPrompt({ from_name: 'Anna Ny', from_email: 'anna@mediagraf.se' });
    expect(p).toContain('Anna Ny');
    expect(p).toContain('anna@mediagraf.se');
    expect(p).not.toMatch(/gustaf\.hard@gmail\.com/);
    expect(p).not.toMatch(/Gustaf Hård/);
  });
});

describe('htmlToText (M4)', () => {
  it('strips tags/style, converts breaks, decodes Swedish entities', () => {
    const html = '<html><style>p{color:red}</style><body><p>Hej,</p><p>Tack f&ouml;r din beg&auml;ran.<br>&Aring;terkommer.</p></body></html>';
    const text = htmlToText(html);
    expect(text).toBe('Hej,\nTack för din begäran.\nÅterkommer.');
  });
  it('parseInboundMessage prefers text/plain when both parts exist', () => {
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const msg = {
      id: 'm', threadId: 't',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'From', value: 'a@b.se' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64('plain wins') } },
          { mimeType: 'text/html', body: { data: b64('<p>html loses</p>') } },
        ],
      },
    };
    expect(parseInboundMessage(msg).body).toBe('plain wins');
  });
});

describe('OAuth state + PKCE (L3)', () => {
  const port = 49000 + Math.floor(Math.random() * 1000);
  const env = {
    GMAIL_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GMAIL_OAUTH_CLIENT_SECRET: 'secret',
    GMAIL_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth2callback`,
  };

  it('the consent URL carries state and an S256 code challenge, and a state-mismatch callback aborts the flow', async () => {
    const { consentUrl, done } = beginReauth({ env, tokenPath: join(tmpdir(), 'never-written.json'), timeoutMs: 5000 });
    const url = new URL(consentUrl);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    // CSRF'd code injection: right path, wrong state → 400 + rejected flow.
    const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?code=evil&state=wrong`);
    expect(res.status).toBe(400);
    await expect(done).rejects.toThrow(/state mismatch/);
  });
});

describe('graduation ledger repairs (M3, schema-free parts)', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pilot-m3-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  it('sendApprovedReply keys the decision on the draft-time state (previous_state), not the auto-advanced one', async () => {
    const convId = db.createConversation({
      kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
      contact_email: 'r@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
    });
    // FSM auto-advanced to DELIVERING after the draft was created for SENT.
    db.updateConversationState(convId, 'DELIVERING', { gmail_thread_id: 'thr-1' });
    const escId = db.recordEscalation({
      conversation_id: convId, message_id: null, reason: 'r',
      draft_template: 'T_FOLLOWUP_NUDGE', draft_subject: 's', draft_body: 'b',
      previous_state: 'SENT',
    });
    const esc = db.raw.prepare('SELECT * FROM escalations WHERE id=?').get(escId);
    const conv = db.getConversation(convId);
    await sendApprovedReply({
      db, gmail: {}, env: { GMAIL_USER_EMAIL: 'me@x.se', GMAIL_FROM_NAME: 'Me' },
      conv, esc, finalBody: 'b', decision: 'edit',
      gmailSendImpl: vi.fn(async () => ({ id: 'out-1', threadId: 'thr-1' })),
    });
    expect(db.listDecisions()[0].conversation_state).toBe('SENT');
  });
});

describe('duplicate contract warning (L6, schema-free part)', () => {
  let tmp, db;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pilot-l6-'));
    db = openDb(join(tmp, 'pilot.db'));
    db.migrate();
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  function seedAttachment(gmailId) {
    let convId = db.raw.prepare("SELECT id FROM conversations WHERE kommun_kod='1'").get()?.id;
    if (!convId) {
      convId = db.createConversation({
        kommun_kod: '1', kommun_namn: 'Arboga', role: 'central',
        contact_email: 'r@arboga.se', scheduled_send_at: '2026-05-01T00:00:00Z',
      });
    }
    const mid = db.recordMessage({
      conversation_id: convId, gmail_message_id: gmailId, direction: 'inbound',
      from_email: 'r@arboga.se', to_email: 'me@x.se', subject: 's', body_text: 'b',
      classification: 'delivery', classification_confidence: 0.9,
      received_at: '2026-06-01T00:00:00Z', attachment_count: 1,
    });
    return db.recordAttachment({
      message_id: mid, filename: `${gmailId}.pdf`, saved_path: `/x/${gmailId}.pdf`,
      mime_type: 'application/pdf', size_bytes: 10,
    });
  }

  it('warns when the same vendor+period lands twice for one kommun', () => {
    const analysis = {
      is_contract: true, document_type: 'avtal', vendor_name: 'Unikum',
      products: [], avtalsvarde: null, valuta: null,
      period_start: '2024-01-01', period_end: '2026-12-31',
      summary: 's', confidence: 0.9, mentioned_agreements: [],
    };
    const log = vi.fn();
    storeContractAnalysis(db, seedAttachment('g1'), analysis, { model: 't', log });
    expect(log).not.toHaveBeenCalled();
    storeContractAnalysis(db, seedAttachment('g2'), analysis, { model: 't', log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatch(/possible duplicate contract/);
    expect(log.mock.calls[0][0]).toMatch(/Unikum/);
  });
});
