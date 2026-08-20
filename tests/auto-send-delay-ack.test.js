// Auto-send of T_DELAY_ACK (2026-08-20 design): the second graduated class.
// Unit half: the pure eligibility predicate. Integration half (Task 4): the
// runDailyFollowup sweep.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutoSendableDelayAck, DELAY_ACK_AUTO_MIN_CONFIDENCE } from '../src/conversation.js';
import { openDb } from '../src/storage.js';
import { runDailyFollowup } from '../src/tick.js';

const NOW = new Date('2026-08-20T09:00:00Z');

function esc(overrides = {}) {
  return {
    id: 1, conversation_id: 10, message_id: 100, status: 'open',
    draft_template: 'T_DELAY_ACK', classifier_class: 'delay_promise',
    classifier_confidence: 0.9,
    created_at: '2026-08-20 07:00:00', // SQLite datetime('now') shape, UTC
    ...overrides,
  };
}
function inbound(overrides = {}) {
  return {
    id: 100, direction: 'inbound', classification: 'delay_promise',
    received_at: '2026-08-20T06:55:00Z',
    body_text: 'Hej,\nVi återkommer så snart underlaget är klart.\nMvh Frida',
    attachment_count: 0, stored_attachment_count: 0,
    ...overrides,
  };
}
function check({ e = esc(), messages = [inbound()], autoSentCount = 0, now = NOW } = {}) {
  return isAutoSendableDelayAck({ esc: e, messages, autoSentCount, now });
}

describe('isAutoSendableDelayAck', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });

  it('rejects wrong template, non-open status', () => {
    expect(check({ e: esc({ draft_template: 'free_form' }) }).ok).toBe(false);
    expect(check({ e: esc({ status: 'send_failed' }) }).ok).toBe(false);
  });

  it('rejects low/NULL confidence and non-delay class (fail closed)', () => {
    expect(check({ e: esc({ classifier_confidence: 0.65 }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_confidence: null }) }).reason).toBe('confidence');
    expect(check({ e: esc({ classifier_class: null }) }).reason).toBe('class');
    expect(check({ e: esc({ classifier_confidence: DELAY_ACK_AUTO_MIN_CONFIDENCE }) }).ok).toBe(true); // >= is inclusive
  });

  it('rejects an escalation older than 48h — the deploy-backlog guard', () => {
    expect(check({ e: esc({ created_at: '2026-08-17 07:00:00' }) }).reason).toBe('stale_draft');
  });

  it('rejects an unparseable created_at (fail closed)', () => {
    expect(check({ e: esc({ created_at: 'not-a-date' }) }).reason).toBe('stale_draft');
  });

  it('rejects when the trigger is missing or not the newest inbound', () => {
    expect(check({ messages: [] }).reason).toBe('trigger_missing');
    expect(check({ messages: [inbound(), inbound({ id: 101, received_at: '2026-08-20T08:00:00Z' })] }).reason).toBe('not_latest_inbound');
    // tie on received_at → manual
    expect(check({ messages: [inbound(), inbound({ id: 101 })] }).reason).toBe('not_latest_inbound');
  });

  it('outbound rows never count as "newer inbound"', () => {
    const out = { id: 101, direction: 'outbound', received_at: '2026-08-20T08:30:00Z', body_text: 'x', attachment_count: 0 };
    expect(check({ messages: [inbound(), out] }).ok).toBe(true);
  });

  it('rejects a trigger with stored attachments; missing counts fail closed', () => {
    expect(check({ messages: [inbound({ stored_attachment_count: 1 })] }).reason).toBe('attachments');
    expect(check({ messages: [inbound({ stored_attachment_count: undefined, attachment_count: 2 })] }).reason).toBe('attachments');
  });

  it('applies the body gate and surfaces its reason', () => {
    expect(check({ messages: [inbound({ body_text: 'Avtalet kostar 911 000,00 kr per år' })] }).reason).toBe('currency');
  });

  it('caps lifetime auto-sends per conversation at 2', () => {
    expect(check({ autoSentCount: 1 }).ok).toBe(true);
    expect(check({ autoSentCount: 2 }).reason).toBe('auto_send_cap');
  });
});

// ---------------------------------------------------------------------------
// Integration half (Task 4): the runDailyFollowup sweep.
//
// Harness copied from tests/auto-send-nudge.test.js — same temp-dir DB, same
// fakes, same load-bearing seedHealthyTick — with seedInbound extended to take
// a body override (the delay-ack body gate reads the trigger's prose).
// ---------------------------------------------------------------------------

let tmp, db, contractsDir, overridesPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-delayack-'));
  contractsDir = join(tmp, 'contracts');
  overridesPath = join(tmp, 'overrides.json');
  db = openDb(join(tmp, 'pilot.db'));
  db.migrate();
});
afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

const env = {
  GMAIL_USER_EMAIL: 'gustaf@mediagraf.se',
  GMAIL_FROM_NAME: 'Gustaf',
  SLACK_CHANNEL_ID: 'C1',
};

function writeSwitch(value) {
  writeFileSync(overridesPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function fakeSlackOps() {
  return {
    posts: [], updates: [],
    postEscalation: vi.fn(async function (slack, { blocks }) { this.posts.push(blocks); return { ts: `s-${this.posts.length}`, channel: 'C1' }; }),
    postAlert: vi.fn(async () => ({ ts: 'a', channel: 'C1' })),
    updateEscalationResolved: vi.fn(async function (slack, args) { this.updates.push(args); }),
  };
}

// sendMessage is passed DETACHED as gmailSendImpl, so capture via closure, not `this`.
function fakeGmail({ sendError = null } = {}) {
  const sent = [];
  return {
    sent,
    sendMessage: vi.fn(async (gmailClient, args) => {
      if (sendError) throw new Error(sendError);
      sent.push(args);
      return { id: `out-${sent.length}`, threadId: 'thr-a' };
    }),
    archiveThread: vi.fn(async () => {}),
    listInboundQuery: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
  };
}

// Seeds a heartbeat that reads healthy to BOTH clocks in play, which is the
// only way this helper earns its name:
//  - runDailyFollowup's gate calls getTickHealth({ now }) with the injected
//    fake clock (tick.js:1331);
//  - sendApprovedReply's STALE_INGEST guard calls getTickHealth() with NO
//    arguments (send-reply.js:196), so it defaults to the REAL clock
//    (storage.js:756).
// Stamping only against the fake clock (2026-08-20T09:00:00Z) goes permanently
// stale the moment real wall-clock passes 09:55Z that day, which would refuse
// every auto-send as STALE_INGEST. Stamping 5 minutes before whichever clock is
// LATER is healthy for both: the later clock sees a 5-minute age, the earlier
// one sees a negative age, and `stale` is `ageMin > thresholdMin`, so a
// negative age is never stale.
function seedHealthyTick(now = new Date()) {
  const latest = Math.max(Date.now(), now.getTime());
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(latest - 5 * 60000).toISOString());
}

// `slackClient` defaults to `{}`: sendApprovedReply strips the Slack buttons via
// the REAL updateEscalationResolved imported from slack.js (not via slackOps),
// and with no chat.update on the object stripSlackButtons swallows the
// TypeError. The Slack wording of an auto-send is already pinned in
// tests/auto-send-nudge.test.js, so nothing here needs a chat.update spy.
function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), slackClient = {}, now = new Date('2026-08-20T09:00:00Z') } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient, slackOps,
    env, contractsDir, now, overridesPath,
  };
}

function seedConv({ state = 'SENT', stateChangedAt = '2026-08-19T00:00:00Z', followupCount = 0, followUpAt = null, role = 'central', kommun = ['1440', 'Ale'], email = 'kansli@ale.se' } = {}) {
  const id = db.createConversation({
    kommun_kod: kommun[0], kommun_namn: kommun[1], role,
    contact_email: email, scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: 'thr-a', last_outbound_at: '2026-08-18T10:00:00Z',
    followup_count: followupCount, follow_up_at: followUpAt,
  });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  return id;
}

// attachmentCount is what the mail CARRIED; storedAttachments is what the
// ingest actually kept (isTrivialImage skips signature logos), i.e. rows in the
// attachments table.
let inboundSeq = 0;
function seedInbound(convId, { classification = null, receivedAt = '2026-08-20T06:00:00Z', attachmentCount = 0, storedAttachments = 0, fromEmail = 'kansli@ale.se', bodyText = null } = {}) {
  inboundSeq += 1;
  const messageId = db.recordMessage({
    conversation_id: convId,
    gmail_message_id: `in-${inboundSeq}`,
    direction: 'inbound',
    from_email: fromEmail,
    to_email: env.GMAIL_USER_EMAIL,
    subject: 'SV: Begäran om allmänna handlingar',
    body_text: bodyText ?? 'Vi har mottagit din begäran.',
    classification,
    classification_confidence: classification ? 0.9 : null,
    received_at: receivedAt,
    attachment_count: attachmentCount,
    gmail_thread_id: 'thr-a',
  });
  for (let i = 0; i < storedAttachments; i += 1) {
    db.recordAttachment({
      message_id: messageId,
      filename: `avtal-${inboundSeq}-${i + 1}.pdf`,
      saved_path: join(contractsDir, `avtal-${inboundSeq}-${i + 1}.pdf`),
      mime_type: 'application/pdf',
      size_bytes: 12345,
    });
  }
  return messageId;
}

function seedDelayAckEscalation(convId, msgId, { confidence = 0.9, createdAt = null } = {}) {
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: msgId, reason: 'delay ack until=2026-08-25',
    draft_template: 'T_DELAY_ACK', draft_subject: 'Re: Begäran om allmänna handlingar',
    draft_body: 'Hej,\n\nTack för ditt svar! Då avvaktar vi så länge och hör av oss igen om vi inte fått något.\n\nMvh Gustaf',
    classifier_class: 'delay_promise', classifier_confidence: confidence, previous_state: 'ACK_RECEIVED',
  });
  if (createdAt) db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run(createdAt, escId);
  return escId;
}

describe('runDailyFollowup delay-ack sweep', () => {
  it('sends an eligible fresh draft: resolved_send + auto_send decision, exactly one mail', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, {
      classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z',
      bodyText: 'Hej,\nVi återkommer så snart underlaget är klart.\nMvh',
    });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(1);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
    const d = db.listDecisions().find((x) => x.decision === 'auto_send');
    expect(d.draft_template).toBe('T_DELAY_ACK');
  });

  it('switch off / nudge-only switch → draft stays open, nothing sent', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('the deploy-day backlog never auto-sends (created_at 3 days ago)', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-10T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-17T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId, { createdAt: '2026-08-17 06:05:00' });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('lifetime cap: third auto delay-ack stays open; operator sends do not count', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    // two prior machine sends
    for (let i = 0; i < 2; i += 1) {
      const m = seedInbound(id, { classification: 'delay_promise', receivedAt: `2026-08-1${i}T06:00:00Z`, bodyText: 'Vi återkommer.' });
      const e = seedDelayAckEscalation(id, m);
      db.resolveEscalation(e, { status: 'resolved_send' });
      db.recordDecision({ escalation_id: e, conversation_id: id, conversation_state: 'ACK_RECEIVED', draft_template: 'T_DELAY_ACK', draft_body: 'x', decision: 'auto_send' });
    }
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('Gmail failure parks send_failed, records no decision, and the next run does not retry', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const failing = fakeGmail({ sendError: 'quota' });
    await runDailyFollowup(deps({ gmail: failing, now: new Date('2026-08-20T09:00:00Z') }));
    expect(db.listEscalationsByStatus('send_failed')).toHaveLength(1);
    expect(db.listDecisions().filter((d) => d.decision === 'auto_send')).toHaveLength(0);
    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-08-21T09:00:00Z') }));
    expect(gmail2.sent).toHaveLength(0);
  });

  it('a swept conversation does not also get a nudge draft in the same run', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK', 'T_FOLLOWUP_NUDGE'] });
    // 30 days stale — past any jittered nudge threshold — but holding an open delay ack.
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-07-21T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail, now: new Date('2026-08-20T09:00:00Z') }));
    expect(gmail.sent).toHaveLength(1); // the ack, nothing else
    expect(db.listEscalationsByStatus('open')).toHaveLength(0);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
  });

  it('vacation window skips the sweep, draft stays open', async () => {
    writeSwitch({ auto_send_templates: ['T_DELAY_ACK'] });
    const id = seedConv({ state: 'ACK_RECEIVED', stateChangedAt: '2026-08-19T00:00:00Z' });
    const msgId = seedInbound(id, { classification: 'delay_promise', receivedAt: '2026-08-20T06:00:00Z', bodyText: 'Vi återkommer.' });
    seedDelayAckEscalation(id, msgId);
    const gmail = fakeGmail();
    const d = deps({ gmail, now: new Date('2026-08-20T09:00:00Z') });
    // isInVacation compares MM-DD (year-agnostic window), see src/vacation.js.
    d.vacationConfig = { enabled: true, start: '08-01', end: '08-31' };
    await runDailyFollowup(d);
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });
});
