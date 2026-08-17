// Extraction attempt tracking + stuck-analysis digest (2026-08-16).
//
// Before this, EVERY analysis failure returned null and the attachment stayed
// pending forever: a password-protected PDF burned an Opus call every 15
// minutes, invisibly, and a systemic schema failure took out all extraction
// while the tick stayed green. These tests pin the three guarantees:
//   1. transient failures retry, but only up to a cap
//   2. permanent failures park on the first attempt
//   3. parking is digested exactly once — restart-safe — and un-parkable

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, MAX_ANALYSIS_ATTEMPTS } from '../src/storage.js';
import { analysePendingContracts, classifyAnalysisFailure } from '../src/analyse-contract.js';
import { runTick } from '../src/tick.js';
import { attachmentAnalysisNote } from '../src/dashboard-views.js';
import * as analyseMod from '../src/analyse-message.js';

let tmp, dbPath, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'analysis-park-'));
  contractsDir = join(tmp, 'contracts');
  mkdirSync(contractsDir, { recursive: true });
  dbPath = join(tmp, 'pilot.db');
  db = openDb(dbPath);
  db.migrate();
});
afterEach(() => { try { db.close(); } catch { /* already closed */ } rmSync(tmp, { recursive: true, force: true }); });

const env = { ANTHROPIC_API_KEY: 'sk', GMAIL_USER_EMAIL: 'gustaf@mediagraf.se', SLACK_CHANNEL_ID: 'C1' };

const GOOD = {
  is_contract: true, vendor_name: 'Skolon', products: ['Skolon Plattform'],
  document_type: 'avtal', summary: 'Avtal.', confidence: 0.95, mentioned_agreements: [],
};

function seedAttachment(handle, { filename = 'Avtal.pdf', kommun = 'Västerås', kod = '1980', body = '%PDF-1.4 fake contract', writeFile = true } = {}) {
  const convId = handle.createConversation({
    kommun_kod: kod, kommun_namn: kommun, role: 'central',
    contact_email: `reg@${kod}.se`, scheduled_send_at: '2026-04-01T08:00:00Z',
  });
  const msgId = handle.recordMessage({
    conversation_id: convId, gmail_message_id: `gm-${kod}-${filename}`, direction: 'inbound',
    from_email: `reg@${kod}.se`, to_email: 'me@x.com', subject: 'Avtal', body_text: '',
    classification: null, classification_confidence: null,
    received_at: '2026-04-13T10:00:00Z', attachment_count: 1,
  });
  const savedPath = join(contractsDir, kod, filename);
  mkdirSync(join(contractsDir, kod), { recursive: true });
  if (writeFile) writeFileSync(savedPath, body);
  const attId = handle.recordAttachment({
    message_id: msgId, filename, saved_path: savedPath,
    mime_type: filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    size_bytes: body.length,
  });
  return { convId, msgId, attId, savedPath };
}

const throwingClient = (err) => ({ messages: { create: vi.fn(async () => { throw err; }) } });
const okClient = (obj = GOOD) => ({ messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] })) } });

function attRow(handle, id) {
  return handle.raw.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------

describe('classifyAnalysisFailure', () => {
  it('treats 5xx and timeouts as transient', () => {
    expect(classifyAnalysisFailure(Object.assign(new Error('bad gateway'), { status: 502 })))
      .toMatchObject({ permanent: false, reason: 'transient:api_5xx' });
    expect(classifyAnalysisFailure(new Error('socket hang up')))
      .toMatchObject({ permanent: false, reason: 'transient:api_timeout' });
  });

  // A rate limit / overload is the PROVIDER refusing traffic, not this
  // document failing. It is retried, but it must never spend one of the five
  // attempts — otherwise an hour of 429s parks the whole corpus.
  it('classifies 429 and 529/overloaded as backoff, not transient', () => {
    expect(classifyAnalysisFailure(Object.assign(new Error('slow down'), { status: 429 })))
      .toMatchObject({ permanent: false, backoff: true, reason: 'backoff:api_rate_limit' });
    expect(classifyAnalysisFailure(Object.assign(new Error('overloaded'), { status: 529 })))
      .toMatchObject({ permanent: false, backoff: true, reason: 'backoff:api_overloaded' });
    expect(classifyAnalysisFailure(new Error('{"type":"overloaded_error"}')))
      .toMatchObject({ permanent: false, backoff: true, reason: 'backoff:api_overloaded' });
  });

  // Ordering bug: PERMANENT_DOCUMENT_PATTERNS used to be tested BEFORE the
  // status, so a 429 whose body happened to say "exceeds the maximum" parked a
  // perfectly readable contract on attempt one.
  it('lets an explicit status win over prose in the error message', () => {
    const e = Object.assign(new Error('rate limit exceeds the maximum for your tier'), { status: 429 });
    expect(classifyAnalysisFailure(e)).toMatchObject({ backoff: true, reason: 'backoff:api_rate_limit' });
    const e5 = Object.assign(new Error('upstream could not process the pdf document'), { status: 503 });
    expect(classifyAnalysisFailure(e5)).toMatchObject({ permanent: false, reason: 'transient:api_5xx' });
  });

  it('treats a json_schema rejection (400) as transient — it is our bug to fix, not the document\'s', () => {
    const e = Object.assign(new Error('output_config.format.schema: too many union-typed properties'), { status: 400 });
    expect(classifyAnalysisFailure(e)).toMatchObject({ permanent: false, reason: 'transient:api_invalid_request' });
  });

  it('treats oversized and unreadable documents as permanent', () => {
    expect(classifyAnalysisFailure(Object.assign(new Error('payload'), { status: 413 })))
      .toMatchObject({ permanent: true, reason: 'permanent:document_too_large' });
    expect(classifyAnalysisFailure(new Error('The document exceeds the maximum allowed size')))
      .toMatchObject({ permanent: true });
    expect(classifyAnalysisFailure(new Error('Could not process the pdf attachment')))
      .toMatchObject({ permanent: true, reason: 'permanent:document_rejected' });
    expect(classifyAnalysisFailure(new Error('The PDF is password-protected')))
      .toMatchObject({ permanent: true, reason: 'permanent:document_rejected' });
  });

  it('defaults an unrecognised error to transient (the cap bounds the cost)', () => {
    expect(classifyAnalysisFailure(new Error('boom'))).toMatchObject({ permanent: false, reason: 'transient:api_error' });
  });
});

describe('transient failures: increment and retry', () => {
  it('books one attempt per run and keeps the attachment eligible until the cap', async () => {
    const { attId } = seedAttachment(db);
    const client = throwingClient(Object.assign(new Error('bad gateway'), { status: 502 }));

    const r1 = await analysePendingContracts({ db, env, client, contractsDir });
    expect(r1).toMatchObject({ analysed: 0, attempted: 1, failed: 1, transient: 1, permanent: 0 });
    expect(r1.parked).toEqual([]);
    expect(attRow(db, attId).analysis_attempts).toBe(1);
    expect(attRow(db, attId).last_analysis_error).toBe('transient:api_5xx');
    expect(attRow(db, attId).last_analysis_at).toBeTruthy();
    // Still in the retry pool — a 502 is worth another go.
    expect(db.listPendingContractAttachments().map((a) => a.id)).toEqual([attId]);

    const r2 = await analysePendingContracts({ db, env, client, contractsDir });
    expect(r2.attempted).toBe(1);
    expect(attRow(db, attId).analysis_attempts).toBe(2);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('parks after exactly MAX_ANALYSIS_ATTEMPTS and then stops calling the API', async () => {
    const { attId } = seedAttachment(db);
    const client = throwingClient(Object.assign(new Error('bad gateway'), { status: 502 }));

    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i += 1) {
      await analysePendingContracts({ db, env, client, contractsDir });
    }
    expect(attRow(db, attId).analysis_attempts).toBe(MAX_ANALYSIS_ATTEMPTS);
    expect(db.listPendingContractAttachments()).toHaveLength(0);

    // The whole point: the 15-minute Opus burn stops.
    const after = await analysePendingContracts({ db, env, client, contractsDir });
    expect(after).toMatchObject({ analysed: 0, attempted: 0 });
    expect(client.messages.create).toHaveBeenCalledTimes(MAX_ANALYSIS_ATTEMPTS);
  });

  it('reports the run in which the cap is reached as newly parked', async () => {
    const { attId } = seedAttachment(db);
    const client = throwingClient(new Error('boom'));
    let last;
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i += 1) {
      last = await analysePendingContracts({ db, env, client, contractsDir });
    }
    expect(last.parked).toEqual([{ id: attId, filename: 'Avtal.pdf', reason: 'transient:api_error', attempts: MAX_ANALYSIS_ATTEMPTS }]);
  });

  it('a success clears the failure bookkeeping so a later re-park re-alerts', async () => {
    const { attId } = seedAttachment(db);
    await analysePendingContracts({ db, env, client: throwingClient(new Error('boom')), contractsDir });
    expect(attRow(db, attId).analysis_attempts).toBe(1);
    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir });
    expect(r.analysed).toBe(1);
    const row = attRow(db, attId);
    expect(row.analysis_attempts).toBe(0);
    expect(row.last_analysis_error).toBeNull();
    expect(row.analysis_parked_alerted_at).toBeNull();
  });
});

describe('permanent failures park on the first attempt', () => {
  it('parks an attachment whose file is gone from disk without calling the API', async () => {
    const { attId, savedPath } = seedAttachment(db);
    unlinkSync(savedPath);
    const client = okClient();

    const r = await analysePendingContracts({ db, env, client, contractsDir });
    expect(r).toMatchObject({ analysed: 0, attempted: 1, failed: 1, permanent: 1, transient: 0 });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(attRow(db, attId).analysis_attempts).toBe(MAX_ANALYSIS_ATTEMPTS);
    expect(attRow(db, attId).last_analysis_error).toBe('permanent:file_missing');
    expect(db.listPendingContractAttachments()).toHaveLength(0);
    expect(r.parked).toHaveLength(1);
  });

  it('parks an office document with no readable text (password-protected / corrupt)', async () => {
    const { attId } = seedAttachment(db, { filename: 'Avtalslista.xlsx', body: 'not a real zip' });
    const client = okClient();
    const r = await analysePendingContracts({ db, env, client, contractsDir });
    expect(r).toMatchObject({ analysed: 0, permanent: 1 });
    expect(client.messages.create).not.toHaveBeenCalled();
    expect(String(attRow(db, attId).last_analysis_error)).toMatch(/^permanent:/);
    expect(attRow(db, attId).analysis_attempts).toBe(MAX_ANALYSIS_ATTEMPTS);
  });

  it('parks an oversized PDF on the first API rejection', async () => {
    const { attId } = seedAttachment(db);
    const client = throwingClient(Object.assign(new Error('request too large'), { status: 413 }));
    await analysePendingContracts({ db, env, client, contractsDir });
    expect(attRow(db, attId).analysis_attempts).toBe(MAX_ANALYSIS_ATTEMPTS);
    expect(attRow(db, attId).last_analysis_error).toBe('permanent:document_too_large');
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('a missing API key is not an attempt — nothing is booked against the document', async () => {
    const { attId } = seedAttachment(db);
    const r = await analysePendingContracts({ db, env: {}, contractsDir });
    expect(r).toMatchObject({ analysed: 0, attempted: 0, failed: 0 });
    expect(attRow(db, attId).analysis_attempts).toBe(0);
  });
});

// A routine hour-long Anthropic incident used to park the ENTIRE pending queue
// — five ticks of 429 and every document left the retry pool permanently, while
// the systemic alert went quiet exactly then.
describe('provider backoff (429 / overloaded) never spends an attempt', () => {
  it('survives a long 429 storm with nothing parked, and keeps alerting each tick', async () => {
    const atts = [0, 1, 2, 3].map((i) => seedAttachment(db, { filename: `A${i}.pdf`, kod: `200${i}` }).attId);
    const client = throwingClient(Object.assign(new Error('rate limit'), { status: 429 }));

    // Far more ticks than the attempt budget.
    let last;
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS * 3; i += 1) {
      last = await analysePendingContracts({ db, env, client, contractsDir });
    }
    for (const id of atts) {
      expect(attRow(db, id).analysis_attempts).toBe(0);
      expect(attRow(db, id).last_analysis_error).toBeNull();
    }
    expect(db.listPendingContractAttachments()).toHaveLength(4);
    expect(last).toMatchObject({ attempted: 4, failed: 4, backoff: 4, transient: 0, permanent: 0 });
    expect(last.parked).toEqual([]);

    // The tick must still shout: extraction IS dead while this lasts.
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps, analyseContracts: async () => last }));
    await runTick(tickDeps(db, { slackOps, analyseContracts: async () => last }));
    expect(slackOps.alerts).toHaveLength(2);
    expect(slackOps.alerts[0]).toContain('står stilla');
    expect(slackOps.alerts[0]).toContain('inget dokument har parkerats');
  });

  it('a 529/overloaded is backoff too, and a real 5xx still counts', async () => {
    const { attId: a } = seedAttachment(db, { filename: 'A.pdf', kod: '3001' });
    await analysePendingContracts({
      db, env, contractsDir,
      client: throwingClient(Object.assign(new Error('overloaded'), { status: 529 })),
    });
    expect(attRow(db, a).analysis_attempts).toBe(0);

    await analysePendingContracts({
      db, env, contractsDir,
      client: throwingClient(Object.assign(new Error('bad gateway'), { status: 502 })),
    });
    expect(attRow(db, a).analysis_attempts).toBe(1);
  });
});

// One tick used to charge a freshly-delivered document TWO of its five
// attempts: the inline per-message analysis (the T_RECEIPT path) and step 3
// each ran it. The retry budget then survived ~45 minutes of provider
// degradation instead of ~75.
describe('one tick attempts an attachment at most once', () => {
  function b64(s) {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  it('books exactly one attempt for a document delivered and failing on the same tick', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const convId = db.createConversation({
      kommun_kod: '2582', kommun_namn: 'Boden', role: 'central',
      contact_email: 'kommun@boden.se', scheduled_send_at: '2026-06-10T09:00:00Z',
    });
    db.updateConversationState(convId, 'SENT', { gmail_thread_id: 'thr-att', last_outbound_at: '2026-06-10T10:00:00Z' });

    const msg = {
      id: 'att-msg-1', threadId: 'thr-att',
      payload: {
        headers: [
          { name: 'From', value: 'Upphandling <upphandling@boden.se>' },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Svar på begäran' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Bifogar avtalet.') } },
          { mimeType: 'application/pdf', filename: 'Avtal.pdf', body: { attachmentId: 'a-pdf', size: 42 } },
        ],
      },
    };

    const client = throwingClient(Object.assign(new Error('bad gateway'), { status: 502 }));
    const deps = tickDeps(db, { slackOps: fakeSlackOps() });
    deps.gmailOps.listInboundQuery = vi.fn(async () => [{ id: msg.id }]);
    deps.gmailOps.getMessage = vi.fn(async () => msg);
    deps.gmailOps.fetchAttachment = vi.fn(async () => Buffer.from('%PDF-1.4 real bytes'));
    // The REAL analyser, with a fake Anthropic client — so attempt booking and
    // the per-tick skip set are exercised, not stubbed out.
    deps.analyseContracts = (opts) => analysePendingContracts({ ...opts, client });

    await runTick(deps);
    spy.mockRestore();

    const att = db.raw.prepare('SELECT * FROM attachments ORDER BY id').all();
    expect(att).toHaveLength(1);
    expect(att[0].analysis_attempts).toBe(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});

// The contracts volume is unmounted (or PILOT_CONTRACTS_DIR is wrong): every
// pending attachment is missing at once. Parking them all in a single tick
// would permanently retire an intact corpus.
describe('all files missing on disk is an environment fault, not a corpus of dead documents', () => {
  it('books nothing, parks nothing and flags the run when ALL (≥3) are missing', async () => {
    const seeded = [0, 1, 2].map((i) => seedAttachment(db, { filename: `M${i}.pdf`, kod: `400${i}` }));
    for (const s of seeded) unlinkSync(s.savedPath);

    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir });
    expect(r.env_fault).toBe('contracts_dir_unavailable');
    expect(r).toMatchObject({ failed: 0, permanent: 0, parked: [] });
    for (const s of seeded) {
      expect(attRow(db, s.attId).analysis_attempts).toBe(0);
      expect(attRow(db, s.attId).last_analysis_error).toBeNull();
    }
    expect(db.listPendingContractAttachments()).toHaveLength(3);

    // And a human is told, loudly.
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps, analyseContracts: async () => r }));
    expect(slackOps.alerts.some((t) => t.includes('går inte att läsa'))).toBe(true);
  });

  it('a lone missing file among readable ones still parks permanently', async () => {
    const gone = seedAttachment(db, { filename: 'Borta.pdf', kod: '4010' });
    seedAttachment(db, { filename: 'Finns.pdf', kod: '4011' });
    seedAttachment(db, { filename: 'Finns2.pdf', kod: '4012' });
    unlinkSync(gone.savedPath);

    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir });
    expect(r.env_fault).toBeNull();
    expect(attRow(db, gone.attId).last_analysis_error).toBe('permanent:file_missing');
    expect(attRow(db, gone.attId).analysis_attempts).toBe(MAX_ANALYSIS_ATTEMPTS);
    expect(r.analysed).toBe(2);
  });

  it('a single missing file in a one-document run still parks (too small to blame the volume)', async () => {
    const gone = seedAttachment(db, { filename: 'Ensam.pdf', kod: '4020' });
    unlinkSync(gone.savedPath);
    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir });
    expect(r.env_fault).toBeNull();
    expect(attRow(db, gone.attId).last_analysis_error).toBe('permanent:file_missing');
  });
});

describe('un-parking', () => {
  it('clearing analysis_attempts makes the attachment eligible again', async () => {
    const { attId } = seedAttachment(db);
    const bad = throwingClient(new Error('boom'));
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i += 1) await analysePendingContracts({ db, env, client: bad, contractsDir });
    expect(db.listPendingContractAttachments()).toHaveLength(0);

    // The documented operator action.
    db.raw.prepare('UPDATE attachments SET analysis_attempts = 0, last_analysis_error = NULL, analysis_parked_alerted_at = NULL WHERE id = ?').run(attId);
    expect(db.listPendingContractAttachments().map((a) => a.id)).toEqual([attId]);

    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir });
    expect(r.analysed).toBe(1);
  });

  it('force ignores the cap, so an operator re-run needs no SQL', async () => {
    seedAttachment(db);
    const bad = throwingClient(new Error('boom'));
    for (let i = 0; i < MAX_ANALYSIS_ATTEMPTS; i += 1) await analysePendingContracts({ db, env, client: bad, contractsDir });
    const r = await analysePendingContracts({ db, env, client: okClient(), contractsDir, force: true });
    expect(r.analysed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The digest, driven through runTick so the real wiring is exercised.

function fakeSlackOps() {
  return {
    alerts: [],
    postEscalation: vi.fn(async () => ({ ts: 's-1', channel: 'C1' })),
    postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a', channel: 'C1' }; }),
  };
}

let outboundSeq = 0;
function tickDeps(handle, { slackOps, analyseContracts } = {}) {
  return {
    db: handle,
    gmailClient: { gmail: {} },
    gmailOps: {
      // Unique ids: several seeded conversations dispatch their T-INITIAL in
      // the same tick, and gmail_message_id is UNIQUE.
      sendMessage: vi.fn(async () => ({ id: `out-${++outboundSeq}`, threadId: `thr-${outboundSeq}` })),
      listInboundQuery: vi.fn(async () => []),
      getMessage: vi.fn(async () => null),
      fetchAttachment: vi.fn(async () => Buffer.from('%PDF-1.4')),
    },
    slackClient: {}, slackOps, env, contractsDir,
    now: new Date('2026-06-24T12:00:00Z'),
    analyseContracts: analyseContracts ?? (async () => ({ analysed: 0, attempted: 0, failed: 0, transient: 0, permanent: 0, parked: [] })),
  };
}

describe('parked-analysis digest', () => {
  it('digests a newly parked attachment exactly once, and again after a restart only if re-parked', async () => {
    const { attId } = seedAttachment(db, { filename: 'Krypterat.pdf', kommun: 'Ale', kod: '1440' });
    db.recordAnalysisFailure(attId, { reason: 'permanent:document_rejected', permanent: true, now: '2026-06-24T11:00:00Z' });

    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps }));
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toContain('Avtalsanalys parkerad');
    expect(slackOps.alerts[0]).toContain('Ale');
    expect(slackOps.alerts[0]).toContain('Krypterat.pdf');
    expect(slackOps.alerts[0]).toContain('document_rejected');

    // Same process, next tick — silent.
    await runTick(tickDeps(db, { slackOps }));
    expect(slackOps.alerts).toHaveLength(1);

    // Simulated daemon restart: brand-new storage handle over the same file.
    // An in-memory "already alerted" set would re-digest here; the DB column
    // does not.
    db.close();
    const reopened = openDb(dbPath);
    reopened.migrate();
    const slackOps2 = fakeSlackOps();
    await runTick(tickDeps(reopened, { slackOps: slackOps2 }));
    expect(slackOps2.alerts).toHaveLength(0);

    // Un-park + re-park → a fresh digest, because the alert stamp was cleared.
    reopened.clearAnalysisFailure(attId);
    reopened.recordAnalysisFailure(attId, { reason: 'permanent:file_missing', permanent: true });
    await runTick(tickDeps(reopened, { slackOps: slackOps2 }));
    expect(slackOps2.alerts).toHaveLength(1);
    expect(slackOps2.alerts[0]).toContain('file_missing');
    reopened.close();
    db = openDb(dbPath); // so afterEach has a live handle to close
  });

  it('does not mark as alerted when the Slack post fails — the digest is retried', async () => {
    const { attId } = seedAttachment(db, { filename: 'Trasig.pdf' });
    db.recordAnalysisFailure(attId, { reason: 'permanent:file_missing', permanent: true });

    const failing = fakeSlackOps();
    failing.postAlert = vi.fn(async () => { throw new Error('slack down'); });
    await runTick(tickDeps(db, { slackOps: failing }));
    expect(attRow(db, attId).analysis_parked_alerted_at).toBeNull();

    const ok = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps: ok }));
    expect(ok.alerts).toHaveLength(1);
    expect(attRow(db, attId).analysis_parked_alerted_at).toBeTruthy();
  });

  it('says nothing when no attachment is parked', async () => {
    seedAttachment(db);
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps }));
    expect(slackOps.alerts).toHaveLength(0);
  });

  // The mark is DURABLE. Marking a row nobody was shown loses the alert
  // forever — and that happened two ways: no Slack config skipped the post but
  // marked anyway, and the 20-line truncation marked the overflow it never
  // printed.
  it('marks nothing when Slack is not configured — the digest is not silently consumed', async () => {
    const { attId } = seedAttachment(db, { filename: 'Trasig.pdf' });
    db.recordAnalysisFailure(attId, { reason: 'permanent:file_missing', permanent: true });

    // No postAlert at all (Slack ops absent).
    await runTick(tickDeps(db, { slackOps: { postEscalation: vi.fn() } }));
    expect(attRow(db, attId).analysis_parked_alerted_at).toBeNull();

    // No channel configured.
    const ops = fakeSlackOps();
    await runTick({ ...tickDeps(db, { slackOps: ops }), env: { ...env, SLACK_CHANNEL_ID: undefined } });
    expect(ops.alerts).toHaveLength(0);
    expect(attRow(db, attId).analysis_parked_alerted_at).toBeNull();

    // Slack back: now it is digested and marked.
    const ok = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps: ok }));
    expect(ok.alerts).toHaveLength(1);
    expect(attRow(db, attId).analysis_parked_alerted_at).toBeTruthy();
  });

  it('marks only the attachments the posted digest actually named, and drains the rest next tick', async () => {
    const ids = [];
    for (let i = 0; i < 23; i += 1) {
      const { attId } = seedAttachment(db, { filename: `Doc${i}.pdf`, kod: String(1000 + i) });
      db.recordAnalysisFailure(attId, { reason: 'permanent:file_missing', permanent: true });
      ids.push(attId);
    }
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps }));
    expect(slackOps.alerts).toHaveLength(1);
    const marked = ids.filter((id) => attRow(db, id).analysis_parked_alerted_at);
    expect(marked).toHaveLength(20);
    // Only listed files are marked; the message says the rest follow.
    expect(slackOps.alerts[0]).toContain('Doc0.pdf');
    expect(slackOps.alerts[0]).not.toContain('Doc22.pdf');
    expect(slackOps.alerts[0]).toContain('och 3 till');

    await runTick(tickDeps(db, { slackOps }));
    expect(slackOps.alerts).toHaveLength(2);
    expect(slackOps.alerts[1]).toContain('Doc22.pdf');
    expect(ids.every((id) => attRow(db, id).analysis_parked_alerted_at)).toBe(true);
  });
});

describe('systemic-failure alert', () => {
  const result = (o) => ({ analysed: 0, attempted: 0, failed: 0, transient: 0, permanent: 0, parked: [], ...o });

  it('fires when every one of ≥3 attempts failed transiently', async () => {
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, {
      slackOps,
      analyseContracts: async () => result({ attempted: 4, failed: 4, transient: 4 }),
    }));
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toContain('misslyckas genomgående');
    expect(slackOps.alerts[0]).toContain('4');
  });

  it('repeats every tick while the systemic failure persists', async () => {
    const slackOps = fakeSlackOps();
    const deps = tickDeps(db, { slackOps, analyseContracts: async () => result({ attempted: 3, failed: 3, transient: 3 }) });
    await runTick(deps);
    await runTick(deps);
    expect(slackOps.alerts).toHaveLength(2);
  });

  it('stays quiet when one document did analyse', async () => {
    const slackOps = fakeSlackOps();
    await runTick(tickDeps(db, {
      slackOps,
      analyseContracts: async () => result({ analysed: 1, attempted: 4, failed: 3, transient: 3 }),
    }));
    expect(slackOps.alerts).toHaveLength(0);
  });

  it('stays quiet below the ≥3 threshold, and when the failures are the documents\' fault', async () => {
    const few = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps: few, analyseContracts: async () => result({ attempted: 2, failed: 2, transient: 2 }) }));
    expect(few.alerts).toHaveLength(0);

    const permanent = fakeSlackOps();
    await runTick(tickDeps(db, { slackOps: permanent, analyseContracts: async () => result({ attempted: 3, failed: 3, permanent: 3 }) }));
    // Permanent failures are per-document, not systemic — they park and get
    // the parked digest instead.
    expect(permanent.alerts.filter((t) => t.includes('misslyckas genomgående'))).toHaveLength(0);
  });

  it('tolerates a legacy numeric result from an injected hook', async () => {
    const slackOps = fakeSlackOps();
    await expect(runTick(tickDeps(db, { slackOps, analyseContracts: async () => 0 }))).resolves.not.toThrow();
    expect(slackOps.alerts).toHaveLength(0);
  });
});

describe('dashboard attachment note', () => {
  it('distinguishes read, queued, parked and never-analysable formats', () => {
    // Already extracted → the badge carries the information, no note.
    expect(attachmentAnalysisNote({ filename: 'Avtal.pdf', mime_type: 'application/pdf', analysis_attempts: 1, analysed: 1 })).toBe('');
    // Analysable but not extracted yet → say so honestly.
    expect(attachmentAnalysisNote({ filename: 'Avtal.pdf', mime_type: 'application/pdf', analysis_attempts: 1, analysed: 0 }))
      .toContain('väntar på avtalsanalys');
    // xlsx/docx ARE analysed (src/office-text.js) — they must never be
    // labelled as a format we skip.
    expect(attachmentAnalysisNote({ filename: 'Avtalslista.xlsx', analysed: 0 }))
      .toContain('väntar på avtalsanalys');
    expect(attachmentAnalysisNote({ filename: 'Avtalslista.xlsx', analysed: 1 })).toBe('');
    // Genuinely outside the analyser.
    expect(attachmentAnalysisNote({ filename: 'Skanning.jpg', mime_type: 'image/jpeg', analysis_attempts: 0 }))
      .toContain('formatet avtalsanalyseras inte');
    // No `analysed` column in the caller's query → claim nothing.
    expect(attachmentAnalysisNote({ filename: 'Avtal.pdf', mime_type: 'application/pdf' })).toBe('');
    const parked = attachmentAnalysisNote({
      filename: 'Krypterat.pdf', mime_type: 'application/pdf',
      analysis_attempts: MAX_ANALYSIS_ATTEMPTS, last_analysis_error: 'permanent:document_rejected',
    });
    expect(parked).toContain('analys misslyckades permanent');
    expect(parked).toContain('document_rejected');
    expect(parked).toContain('kräver manuell hantering');
  });

  it('reports the attempt count for a transiently-parked file', () => {
    const note = attachmentAnalysisNote({
      filename: 'A.pdf', mime_type: 'application/pdf',
      analysis_attempts: MAX_ANALYSIS_ATTEMPTS, last_analysis_error: 'transient:api_5xx',
    });
    expect(note).toContain(`efter ${MAX_ANALYSIS_ATTEMPTS} försök`);
  });
});

describe('migration', () => {
  it('leaves pre-existing attachments at attempt-count 0, i.e. still eligible', () => {
    // Simulate a legacy DB: drop the columns by creating the table without them.
    const legacyPath = join(tmp, 'legacy.db');
    const legacy = openDb(legacyPath);
    legacy.raw.exec(`
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, filename TEXT NOT NULL,
        saved_path TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER
      );
      INSERT INTO attachments (id, message_id, filename, saved_path, mime_type, size_bytes)
      VALUES (1, 1, 'Gammalt.pdf', '/tmp/x.pdf', 'application/pdf', 10);
    `);
    legacy.migrate();
    const row = legacy.raw.prepare('SELECT * FROM attachments WHERE id = 1').get();
    expect(row.analysis_attempts).toBe(0);
    expect(row.last_analysis_error).toBeNull();
    expect(row.analysis_parked_alerted_at).toBeNull();
    legacy.close();
  });
});
