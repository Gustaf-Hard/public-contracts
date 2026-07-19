// Ingest correctness & recovery (autopilot review H2, H3, H4, H5, M2, M4, M11).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/storage.js';
import { runTick, matchInbound, deriveFetchWindowDays } from '../src/tick.js';
import * as analyseMod from '../src/analyse-message.js';
import { dedupeFilenames } from '../src/attachments.js';

let tmp, db, contractsDir;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-ingest-'));
  contractsDir = join(tmp, 'contracts');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

function b64(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mkMsg(id, threadId, from, body, { subject = 's', internalDate } = {}) {
  return {
    id, threadId,
    internalDate,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from }, { name: 'To', value: 'gustaf@mediagraf.se' },
        { name: 'Subject', value: subject },
      ],
      body: { data: b64(body) },
    },
  };
}

function fakeGmail(opts = {}) {
  return {
    sendMessage: vi.fn(async () => ({ id: 'out-x', threadId: 'thr-x' })),
    listInboundQuery: vi.fn(async () => opts.listResult ?? []),
    getMessage: vi.fn(async (gmail, id) => opts.getResult?.[id] ?? null),
    fetchAttachment: opts.fetchAttachment ?? vi.fn(async () => Buffer.from('%PDF-1.4')),
  };
}

function fakeSlackOps() {
  return {
    posts: [], alerts: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async function (slack, { text }) { this.alerts.push(text); return { ts: 'a', channel: 'C1' }; }),
  };
}

function deps({ gmail, slackOps = fakeSlackOps(), now = new Date('2026-06-24T12:00:00Z'), seenUnmatched, analyseContracts } = {}) {
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient: {}, slackOps,
    env, contractsDir, now, seenUnmatched, analyseContracts,
  };
}

function seedConv({ kod = '1440', namn = 'Ale', role = 'central', email = 'kansli@ale.se', thread = 'thr-a' } = {}) {
  const id = db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role, contact_email: email,
    scheduled_send_at: '2026-06-01T00:00:00Z',
  });
  db.updateConversationState(id, 'SENT', { gmail_thread_id: thread, last_outbound_at: '2026-06-10T10:00:00Z' });
  return id;
}

describe('matchInbound (pure, two-pass) — H2', () => {
  const convs = [
    { id: 1, contact_email: 'kansli@ale.se', thread_ids: ['thr-a', 'thr-a2'] },
    { id: 2, contact_email: 'utbildning@ale.se', thread_ids: ['thr-b'] },
    { id: 3, contact_email: 'k@boras.se', thread_ids: ['thr-c'] },
  ];

  it('a thread match on conv 2 beats a domain match on lower-id conv 1', () => {
    const r = matchInbound([{ id: 'm1', threadId: 'thr-b', from: 'x@ale.se' }], convs);
    expect(r.matched).toEqual([{ messageId: 'm1', convId: 2, via: 'thread' }]);
    expect(r.ambiguous).toEqual([]);
  });

  it('matches secondary known threads, not only conv.gmail_thread_id', () => {
    const r = matchInbound([{ id: 'm1', threadId: 'thr-a2', from: 'someone@else.se' }], convs);
    expect(r.matched).toEqual([{ messageId: 'm1', convId: 1, via: 'thread' }]);
  });

  it('a new-thread message whose domain matches two conversations is ambiguous, never first-conv-wins', () => {
    const r = matchInbound([{ id: 'm1', threadId: 'thr-new', from: 'registrator@ale.se' }], convs);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toEqual([{ messageId: 'm1', convIds: [1, 2] }]);
  });

  it('single-candidate domain match works; no candidate is unmatched', () => {
    const r = matchInbound([
      { id: 'm1', threadId: 'thr-new', from: 'annan@boras.se' },
      { id: 'm2', threadId: 'thr-new2', from: 'spam@willys.se' },
    ], convs);
    expect(r.matched).toEqual([{ messageId: 'm1', convId: 3, via: 'domain' }]);
    expect(r.unmatched).toEqual(['m2']);
  });
});

describe('runTick — two-pass matching in the pipeline (H2)', () => {
  it('routes a reply on conv B\'s thread to conv B even when conv A shares the domain', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const a = seedConv({ role: 'central', email: 'kansli@ale.se', thread: 'thr-central' });
    const b = seedConv({ role: 'utbildning', email: 'utbildning@ale.se', thread: 'thr-utb' });

    const gmail = fakeGmail({
      listResult: [{ id: 'm1' }],
      getResult: { 'm1': mkMsg('m1', 'thr-utb', 'Registrator <registrator@ale.se>', 'Ärendenummer: K1440002') },
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();

    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='m1'").get();
    expect(msg.conversation_id).toBe(b); // NOT first-conv-wins
    expect(db.getConversation(b).state).toBe('ACK_RECEIVED');
    expect(db.getConversation(a).state).toBe('SENT');
  });

  it('escalates (digest) instead of guessing when a new-thread reply domain-matches two conversations', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv({ role: 'central', email: 'kansli@ale.se', thread: 'thr-central' });
    seedConv({ role: 'utbildning', email: 'utbildning@ale.se', thread: 'thr-utb' });

    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'amb-1' }],
      getResult: { 'amb-1': mkMsg('amb-1', 'thr-new', 'Registrator <registrator@ale.se>', 'Här kommer avtalen') },
    });
    await runTick(deps({ gmail, slackOps }));
    spy.mockRestore();

    expect(db.hasGmailMessageId('amb-1')).toBe(false); // never mis-filed
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toMatch(/TVETYDIG/);
    expect(slackOps.alerts[0]).toMatch(/Ale\/central.*Ale\/utbildning/);
  });
});

describe('runTick — unmatched inbound is surfaced once (H5, L5)', () => {
  it('digests a no-match message to Slack and does not re-fetch or re-alert it while the process lives', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv();
    const slackOps = fakeSlackOps();
    const seenUnmatched = new Map(); // daemon-lifetime cache of match inputs
    const gmail = fakeGmail({
      listResult: [{ id: 'um-1' }],
      getResult: { 'um-1': mkMsg('um-1', 'thr-x', 'Okänd <reg@kommunalforbund.se>', 'Svar på er begäran') },
    });

    await runTick(deps({ gmail, slackOps, seenUnmatched }));
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toMatch(/Omatchade inkommande/);
    expect(slackOps.alerts[0]).toMatch(/kommunalforbund/);
    expect(db.hasGmailMessageId('um-1')).toBe(false);

    // Second tick, same list: not fetched again, not alerted again.
    await runTick(deps({ gmail, slackOps, seenUnmatched }));
    expect(gmail.getMessage).toHaveBeenCalledTimes(1);
    expect(slackOps.alerts).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('runTick — previously-unmatched inbound is re-matched every tick (finding 4)', () => {
  it('an ambiguous message is ingested on the next tick once its thread is associated — no restart needed', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv({ role: 'central', email: 'kansli@ale.se', thread: 'thr-central' });
    const b = seedConv({ role: 'utbildning', email: 'utbildning@ale.se', thread: 'thr-utb' });
    const slackOps = fakeSlackOps();
    const seenUnmatched = new Map();
    const gmail = fakeGmail({
      listResult: [{ id: 'amb-2' }],
      getResult: { 'amb-2': mkMsg('amb-2', 'thr-new', 'Registrator <registrator@ale.se>', 'Ärendenummer: K1440009') },
    });

    // Tick N: two conversations share the domain → ambiguous, digested, not ingested.
    await runTick(deps({ gmail, slackOps, seenUnmatched }));
    expect(db.hasGmailMessageId('amb-2')).toBe(false);
    expect(slackOps.alerts).toHaveLength(1);
    expect(slackOps.alerts[0]).toMatch(/TVETYDIG/);

    // The operator associates the Gmail thread with conversation B.
    db.upsertThread({ conversation_id: b, gmail_thread_id: 'thr-new', counterparty_email: 'registrator@ale.se' });

    // Tick N+1, same daemon process: the message must now be ingested.
    await runTick(deps({ gmail, slackOps, seenUnmatched }));
    expect(db.hasGmailMessageId('amb-2')).toBe(true);
    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='amb-2'").get();
    expect(msg.conversation_id).toBe(b);
    expect(db.getConversation(b).arendenummer).toBe('K1440009');
    expect(slackOps.alerts).toHaveLength(1); // no re-alert, and it never re-digests
    expect(seenUnmatched.has('amb-2')).toBe(false); // cache entry cleared
    spy.mockRestore();
  });

  it('an unmatched message is ingested once a conversation for its kommun gains a matching identity', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    seedConv({ role: 'central', email: 'kansli@ale.se', thread: 'thr-central' });
    const slackOps = fakeSlackOps();
    const seenUnmatched = new Map();
    const gmail = fakeGmail({
      listResult: [{ id: 'um-2' }],
      getResult: { 'um-2': mkMsg('um-2', 'thr-forb', 'Reg <reg@kommunalforbund.se>', 'Här är svaret') },
    });

    await runTick(deps({ gmail, slackOps, seenUnmatched })); // no match → digested
    expect(db.hasGmailMessageId('um-2')).toBe(false);

    // A new conversation is created whose thread the message belongs to.
    const c = seedConv({ kod: '1441', namn: 'Alingsås', role: 'central', email: 'reg@kommunalforbund.se', thread: 'thr-forb' });

    await runTick(deps({ gmail, slackOps, seenUnmatched }));
    expect(db.hasGmailMessageId('um-2')).toBe(true);
    expect(db.raw.prepare("SELECT conversation_id FROM messages WHERE gmail_message_id='um-2'").get().conversation_id).toBe(c);
    spy.mockRestore();
  });
});

describe('runTick — transactional ingest (H4)', () => {
  it('an attachment fetch failure leaves the message unrecorded (retried next tick), not half-ingested', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    const msg = {
      id: 'del-1', threadId: 'thr-a',
      payload: {
        headers: [
          { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
          { name: 'Subject', value: 'Avtal' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Bifogat avtalet') } },
          { mimeType: 'application/pdf', filename: 'Avtal.pdf', body: { attachmentId: 'att-1', size: 9 } },
        ],
      },
    };
    const failing = fakeGmail({
      listResult: [{ id: 'del-1' }],
      getResult: { 'del-1': msg },
      fetchAttachment: vi.fn(async () => { throw new Error('502 from Gmail'); }),
    });
    await expect(runTick(deps({ gmail: failing }))).resolves.not.toThrow();

    // Nothing committed: no message, no attachments, FSM untouched.
    expect(db.hasGmailMessageId('del-1')).toBe(false);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM attachments').get().n).toBe(0);
    expect(db.getConversation(id).state).toBe('SENT');

    // Next tick with a healthy fetch ingests it fully.
    const healthy = fakeGmail({ listResult: [{ id: 'del-1' }], getResult: { 'del-1': msg } });
    await runTick(deps({ gmail: healthy }));
    expect(db.hasGmailMessageId('del-1')).toBe(true);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM attachments').get().n).toBe(1);
    expect(db.getConversation(id).state).toBe('DELIVERING');
    spy.mockRestore();
  });
});

describe('runTick — received_at comes from Gmail internalDate (M2)', () => {
  it('stamps the message and thread with delivery time, not processing time', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    const deliveredMs = Date.parse('2026-06-11T08:30:00Z');
    const gmail = fakeGmail({
      listResult: [{ id: 'old-1' }],
      getResult: { 'old-1': mkMsg('old-1', 'thr-a', 'K <kansli@ale.se>', 'Ärendenummer: K1440001', { internalDate: String(deliveredMs) }) },
    });
    // Processed 13 days later (post-outage backlog).
    await runTick(deps({ gmail, now: new Date('2026-06-24T12:00:00Z') }));
    spy.mockRestore();

    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='old-1'").get();
    expect(msg.received_at).toBe('2026-06-11T08:30:00.000Z');
    const thread = db.getThread(id, 'thr-a');
    expect(thread.last_inbound_at).toBe('2026-06-11T08:30:00.000Z');
  });
});

describe('runTick — HTML-only inbound gets a text body (M4)', () => {
  it('parses an HTML-only reply so the classifier sees real text', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    const html = '<html><body><p>Tack f&ouml;r att du h&ouml;rde av dig.</p><p>&Auml;rendenummer: K1440077</p></body></html>';
    const gmail = fakeGmail({
      listResult: [{ id: 'html-1' }],
      getResult: {
        'html-1': {
          id: 'html-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'SV: Begäran' },
            ],
            mimeType: 'multipart/alternative',
            parts: [{ mimeType: 'text/html', body: { data: b64(html) } }],
          },
        },
      },
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();

    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='html-1'").get();
    expect(msg.body_text).toContain('Ärendenummer: K1440077');
    // Regex classifier saw the text → auto_ack, not an unknown/NEEDS_HUMAN.
    expect(msg.classification).toBe('auto_ack');
    expect(db.getConversation(id).state).toBe('ACK_RECEIVED');
    expect(db.getConversation(id).arendenummer).toBe('K1440077');
  });
});

describe('runTick — same-named attachments do not overwrite (M11)', () => {
  it('two zip subfolders with the same inner filename yield two files and two distinct rows', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv();
    const zipBytes = Buffer.from(zipSync({
      'a/avtal.pdf': strToU8('%PDF-1.4 first'),
      'b/avtal.pdf': strToU8('%PDF-1.4 second'),
    }));
    const gmail = fakeGmail({
      listResult: [{ id: 'zip-1' }],
      getResult: {
        'zip-1': {
          id: 'zip-1', threadId: 'thr-a',
          payload: {
            headers: [
              { name: 'From', value: 'K <kansli@ale.se>' }, { name: 'To', value: 'me@x.se' },
              { name: 'Subject', value: 'Handlingar' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              { mimeType: 'text/plain', body: { data: b64('Se bifogat') } },
              { mimeType: 'application/zip', filename: 'Handlingar.zip', body: { attachmentId: 'z-1', size: zipBytes.length } },
            ],
          },
        },
      },
      fetchAttachment: vi.fn(async () => zipBytes),
    });
    await runTick(deps({ gmail }));
    spy.mockRestore();

    const atts = db.raw.prepare(
      'SELECT a.filename, a.saved_path FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.conversation_id=?'
    ).all(id);
    expect(atts).toHaveLength(2);
    expect(new Set(atts.map((a) => a.filename)).size).toBe(2);
    expect(new Set(atts.map((a) => a.saved_path)).size).toBe(2);
    expect(atts.map((a) => a.filename)).toContain('avtal.pdf');
    expect(atts.map((a) => a.filename)).toContain('avtal (2).pdf');
  });

  it('dedupeFilenames is pure and numbers before the extension', () => {
    const out = dedupeFilenames([
      { filename: 'Avtal.pdf' }, { filename: 'avtal.pdf' }, { filename: 'Avtal.pdf' }, { filename: 'other.pdf' },
    ]);
    expect(out.map((e) => e.filename)).toEqual(['Avtal.pdf', 'avtal (2).pdf', 'Avtal (3).pdf', 'other.pdf']);
  });
});

describe('runTick — bounce short-circuit (§2)', () => {
  const lundBody = "** Address not found **\n\nYour message wasn't delivered to kansli@ale.se because the address couldn't be found, or is unable to receive mail.";

  it('stores a bounce, skips the LLM + reply-draft, moves conv to NEEDS_HUMAN, opens ONE bounce escalation', async () => {
    // The LLM must NOT be called on a bounce.
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv({ email: 'kansli@ale.se', thread: 'thr-a' });
    const slackOps = fakeSlackOps();
    const gmail = fakeGmail({
      listResult: [{ id: 'bnc-1' }],
      getResult: {
        'bnc-1': mkMsg('bnc-1', 'thr-a', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', lundBody, { subject: 'Delivery Status Notification (Failure)' }),
      },
    });
    await runTick(deps({ gmail, slackOps }));
    // The LLM was never consulted for the bounce — assert BEFORE mockRestore,
    // which clears the mock's call history.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    // Stored (no data loss) with classification 'bounce'.
    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='bnc-1'").get();
    expect(msg).toBeTruthy();
    expect(msg.classification).toBe('bounce');

    // Conversation needs a human.
    expect(db.getConversation(id).state).toBe('NEEDS_HUMAN');

    // Exactly ONE open bounce escalation, carrying the T-INITIAL as the resend
    // draft and naming the dead address.
    const open = db.raw.prepare("SELECT * FROM escalations WHERE conversation_id=? AND status='open'").all(id);
    expect(open).toHaveLength(1);
    expect(open[0].classifier_class).toBe('bounce');
    expect(open[0].draft_template).toBe('T_RESEND_BAD_ADDRESS');
    expect(open[0].reason).toMatch(/kansli@ale\.se/);
    expect(open[0].draft_subject).toMatch(/Begäran om allmänna handlingar/);
    expect(open[0].draft_body).toMatch(/offentlighetsprincipen/);
  });

  it('a normal (non-bounce) reply is unaffected — LLM path still runs and no bounce escalation is made', async () => {
    const spy = vi.spyOn(analyseMod, 'analyseMessage').mockResolvedValue(null);
    const id = seedConv({ email: 'kansli@ale.se', thread: 'thr-a' });
    const gmail = fakeGmail({
      listResult: [{ id: 'ok-1' }],
      getResult: { 'ok-1': mkMsg('ok-1', 'thr-a', 'K <kansli@ale.se>', 'Ärendenummer: K1440001') },
    });
    await runTick(deps({ gmail }));
    // Assert BEFORE mockRestore (which clears call history): the LLM path WAS
    // attempted for a normal reply (unlike a bounce, which short-circuits it).
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const msg = db.raw.prepare("SELECT * FROM messages WHERE gmail_message_id='ok-1'").get();
    expect(msg.classification).not.toBe('bounce');
    const bounceEsc = db.raw.prepare("SELECT COUNT(*) n FROM escalations WHERE classifier_class='bounce'").get().n;
    expect(bounceEsc).toBe(0);
    expect(db.getConversation(id).state).toBe('ACK_RECEIVED');
  });
});

describe('fetch window derived from last_success_at (H3)', () => {
  const now = new Date('2026-08-20T12:00:00Z');
  it('floors at 30 days for recent success and with no history', () => {
    expect(deriveFetchWindowDays('2026-08-20T06:00:00Z', now)).toBe(30);
    expect(deriveFetchWindowDays(null, now)).toBe(30);
  });
  it('covers an outage longer than 30 days with a margin', () => {
    // 45 days of silence → at least 46-day window
    expect(deriveFetchWindowDays('2026-07-06T12:00:00Z', now)).toBe(46);
  });
  it('the tick uses the derived window in its Gmail query', async () => {
    seedConv();
    // Heartbeat says the last clean tick was long ago.
    db.recordHeartbeat({ kind: 'tick', error: null });
    db.raw.prepare("UPDATE daemon_heartbeat SET last_success_at='2026-05-01T00:00:00.000Z' WHERE id=1").run();
    const gmail = fakeGmail({ listResult: [] });
    await runTick(deps({ gmail, now: new Date('2026-06-24T12:00:00Z') }));
    const query = gmail.listInboundQuery.mock.calls[0][1];
    expect(query).toMatch(/newer_than:56d/); // 54.5 days → ceil 55 + 1 margin
  });
});
