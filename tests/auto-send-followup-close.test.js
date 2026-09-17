// Auto-send of T_FOLLOWUP_CLOSE (2026-08-31 design): the third graduated
// template. Unit half: the pure eligibility predicate. Integration half
// (Task 3): the runDailyFollowup sweep.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAutoSendableFollowupClose } from '../src/conversation.js';
import { openDb, REQUEUED_REASON_PREFIX } from '../src/storage.js';
import { runDailyFollowup, CLOSE_AUTO_MAX_PER_RUN } from '../src/tick.js';

function esc(overrides = {}) {
  return { id: 1, conversation_id: 10, status: 'open', draft_template: 'T_FOLLOWUP_CLOSE', ...overrides };
}
function conv(overrides = {}) {
  return { id: 10, state: 'DELIVERING', kommun_namn: 'Grums', role: 'other', ...overrides };
}
function check(overrides = {}) {
  const { e = esc(), c = conv() } = overrides;
  // Deliberately not a destructured default: `unreadDocs = 0` in the
  // parameter list would collapse an explicitly-passed `undefined` back to
  // 0 before the guard ever sees it, making the "fails closed on
  // undefined" assertions below unreachable. `in` distinguishes "omitted"
  // (defaults to the safe 0) from "explicitly undefined" (must reach the
  // guard as undefined so Number.isFinite can reject it).
  const unreadDocs = 'unreadDocs' in overrides ? overrides.unreadDocs : 0;
  const autoSentCount = 'autoSentCount' in overrides ? overrides.autoSentCount : 0;
  return isAutoSendableFollowupClose({ esc: e, conv: c, unreadDocs, autoSentCount });
}

describe('isAutoSendableFollowupClose', () => {
  it('accepts the textbook case', () => {
    expect(check()).toEqual({ ok: true, reason: null });
  });
  it('rejects wrong template and non-open status', () => {
    expect(check({ e: esc({ draft_template: 'T_FOLLOWUP_NUDGE' }) }).reason).toBe('not_followup_close');
    expect(check({ e: esc({ status: 'send_failed' }) }).reason).toBe('not_open');
    expect(check({ e: null }).reason).toBe('not_followup_close');
  });
  it('rejects every non-DELIVERING state — CROSSCHECK close reminders stay manual', () => {
    expect(check({ c: conv({ state: 'CROSSCHECK' }) }).reason).toBe('wrong_state');
    expect(check({ c: conv({ state: 'ACK_RECEIVED' }) }).reason).toBe('wrong_state');
    expect(check({ c: null }).reason).toBe('wrong_state');
  });
  it('rejects unread analysable documents, failing closed on non-finite counts', () => {
    expect(check({ unreadDocs: 1 }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: NaN }).reason).toBe('unread_documents');
    expect(check({ unreadDocs: undefined }).reason).toBe('unread_documents');
  });
  it('rejects a conversation that already got a machine close, failing closed on non-finite counts', () => {
    expect(check({ autoSentCount: 1 }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: NaN }).reason).toBe('auto_send_cap');
    expect(check({ autoSentCount: undefined }).reason).toBe('auto_send_cap');
  });
});

// ---------------------------------------------------------------------------
// Integration half (Task 3): the runDailyFollowup sweep.
//
// Harness copied from tests/auto-send-delay-ack.test.js — same temp-dir DB,
// same fakes, same load-bearing seedHealthyTick — with a `log` sink added
// (the sweep's skip/cap reasons are part of the contract) and the escalation
// seeded as a follow-up close draft (message_id null, like every staleness
// draft escalateWithDraft mints).
// ---------------------------------------------------------------------------

let tmp, db, contractsDir, overridesPath;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pilot-close-'));
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

const NOW_RUN = new Date('2026-08-31T09:00:00Z');

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
// `failOnCall` (1-based) throws on exactly that call and lets the rest succeed
// — the cap-accounting tests need ONE claimed-but-thrown send among several
// good ones, which a blanket sendError cannot express.
function fakeGmail({ sendError = null, failOnCall = null } = {}) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    sendMessage: vi.fn(async (gmailClient, args) => {
      calls += 1;
      if (sendError || calls === failOnCall) throw new Error(sendError ?? 'quota');
      sent.push(args);
      return { id: `out-${sent.length}`, threadId: 'thr-a' };
    }),
    archiveThread: vi.fn(async () => {}),
    listInboundQuery: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
  };
}

// Healthy to BOTH clocks in play — see the long note in
// tests/auto-send-delay-ack.test.js: runDailyFollowup's gate uses the injected
// fake clock, sendApprovedReply's STALE_INGEST guard uses the real one.
// T_FOLLOWUP_CLOSE is in STALE_SENSITIVE_TEMPLATES, so a heartbeat stale to
// either clock would refuse every send in this file.
function seedHealthyTick(now = new Date()) {
  const latest = Math.max(Date.now(), now.getTime());
  db.recordHeartbeat({ kind: 'tick', error: null });
  db.raw.prepare('UPDATE daemon_heartbeat SET last_success_at = ? WHERE id = 1')
    .run(new Date(latest - 5 * 60000).toISOString());
}

function deps({ gmail = fakeGmail(), slackOps = fakeSlackOps(), slackClient = {}, now = NOW_RUN, logs = [] } = {}) {
  seedHealthyTick(now);
  return {
    db, gmailClient: { gmail: {} }, gmailOps: gmail, slackClient, slackOps,
    env, contractsDir, now, overridesPath, logs,
    log: (m) => logs.push(String(m)),
  };
}

let convSeq = 0;
function seedConv({ state = 'DELIVERING', stateChangedAt = '2026-08-20T00:00:00Z', kommun = null } = {}) {
  convSeq += 1;
  const [kod, namn] = kommun ?? [`14${40 + convSeq}`, `Kommun${convSeq}`];
  const id = db.createConversation({
    kommun_kod: kod, kommun_namn: namn, role: 'central',
    contact_email: `kansli${convSeq}@example.se`, scheduled_send_at: '2026-07-01T00:00:00Z',
  });
  db.updateConversationState(id, state, {
    gmail_thread_id: 'thr-a', last_outbound_at: '2026-08-25T10:00:00Z',
    followup_count: 1, follow_up_at: null,
  });
  db.raw.prepare('UPDATE conversations SET state_changed_at = ? WHERE id = ?').run(stateChangedAt, id);
  return id;
}

let inboundSeq = 0;
function seedInbound(convId, { receivedAt = '2026-08-29T06:00:00Z', storedAttachments = 0 } = {}) {
  inboundSeq += 1;
  const messageId = db.recordMessage({
    conversation_id: convId,
    gmail_message_id: `in-close-${inboundSeq}`,
    direction: 'inbound',
    from_email: 'kansli@example.se',
    to_email: env.GMAIL_USER_EMAIL,
    subject: 'SV: Begäran om allmänna handlingar',
    body_text: 'Här kommer en del av handlingarna.',
    classification: 'partial_delivery',
    classification_confidence: 0.9,
    received_at: receivedAt,
    attachment_count: storedAttachments,
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

// Staleness drafts carry message_id null (escalateWithDraft passes
// parsedInbound: null) — so the STALE_ESCALATION guard weighs EVERY inbound.
function seedCloseEscalation(convId, { createdAt = '2026-08-30 07:00:00', template = 'T_FOLLOWUP_CLOSE' } = {}) {
  const escId = db.recordEscalation({
    conversation_id: convId, message_id: null, reason: 'stale DELIVERING for 12 days',
    draft_template: template, draft_subject: 'Re: Begäran om allmänna handlingar',
    draft_body: 'Hej,\n\nJag följer upp min begäran. Är det allt ni har, eller väntar något mer?\n\nMvh Gustaf',
    classifier_class: 'followup_stale', classifier_confidence: null, previous_state: 'DELIVERING',
  });
  db.raw.prepare('UPDATE escalations SET created_at = ? WHERE id = ?').run(createdAt, escId);
  return escId;
}

describe('runDailyFollowup T_FOLLOWUP_CLOSE sweep', () => {
  it('sends an eligible draft: exactly one mail, auto_send decision, escalation resolved', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));
    expect(gmail.sent).toHaveLength(1);
    expect(db.listEscalationsByStatus('open')).toHaveLength(0);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
    const d = db.listDecisions().find((x) => x.decision === 'auto_send');
    expect(d.draft_template).toBe('T_FOLLOWUP_CLOSE');
  });

  // A draft the operator requeued from a parked send (2026-09-17) was promised
  // to them as "godkänner du som vanligt" — the sweep must leave it alone even
  // though the template is otherwise auto-sendable.
  it('never auto-sends a draft requeued from a parked send', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id);
    db.raw.prepare("UPDATE escalations SET reason = ? WHERE conversation_id = ?")
      .run(`${REQUEUED_REASON_PREFIX}232 (send_failed: send error: invalid_grant)`, id);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('switch that does not list the template → nothing sent, draft stays open', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_NUDGE', 'T_DELAY_ACK'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id);
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('caps the run at CLOSE_AUTO_MAX_PER_RUN, oldest escalation first, and says so', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const escIds = [];
    for (let i = 0; i < 7; i += 1) {
      const id = seedConv();
      seedInbound(id);
      escIds.push(seedCloseEscalation(id));
    }
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(CLOSE_AUTO_MAX_PER_RUN).toBe(5);
    expect(gmail.sent).toHaveLength(CLOSE_AUTO_MAX_PER_RUN);
    const sortedEscIds = [...escIds].sort((a, b) => a - b);
    expect(db.listEscalationsByStatus('resolved_send').map((e) => e.id))
      .toEqual(sortedEscIds.slice(0, CLOSE_AUTO_MAX_PER_RUN));
    expect(db.listEscalationsByStatus('open').map((e) => e.id))
      .toEqual(sortedEscIds.slice(CLOSE_AUTO_MAX_PER_RUN));
    expect(logs.some((l) => l.includes('CLOSE auto-send cap reached (5/run)'))).toBe(true);
  });

  it('skips a non-DELIVERING conversation with reason wrong_state', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv({ state: 'CROSSCHECK' });
    seedInbound(id);
    seedCloseEscalation(id);
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
    expect(logs.some((l) => l.includes('CLOSE stays manual') && l.includes('wrong_state'))).toBe(true);
  });

  it('skips while an unread analysable attachment sits on our own disk', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id, { storedAttachments: 1 });
    seedCloseEscalation(id);
    expect(db.countUnreadAnalysableAttachments(id)).toBe(1);
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
    expect(logs.some((l) => l.includes('CLOSE stays manual') && l.includes('unread_documents'))).toBe(true);
  });

  it('skips a conversation that already got a machine close (once ever)', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    const prior = seedCloseEscalation(id, { createdAt: '2026-08-24 07:00:00' });
    db.resolveEscalation(prior, { status: 'resolved_send' });
    db.recordDecision({
      escalation_id: prior, conversation_id: id, conversation_state: 'DELIVERING',
      draft_template: 'T_FOLLOWUP_CLOSE', draft_body: 'x', decision: 'auto_send',
    });
    seedCloseEscalation(id);
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
    expect(logs.some((l) => l.includes('CLOSE stays manual') && l.includes('auto_send_cap'))).toBe(true);
  });

  it('a newer inbound after the draft refuses the send before the claim, leaving it open', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id, { createdAt: '2026-08-30 07:00:00' });
    seedInbound(id, { receivedAt: '2026-08-30T18:00:00Z' }); // the world moved
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
    // The phrase alone is shared with a STALE_INGEST refusal (a regressed
    // seedHealthyTick would produce the identical string and pass this test for
    // the wrong reason), so pin the code the log line carries.
    expect(logs.some((l) => l.includes('refused before the send claim') && l.includes('STALE_ESCALATION'))).toBe(true);
    // and no retry within the run
    expect(db.listDecisions()).toHaveLength(0);
  });

  it('a Gmail failure parks send_failed and is never retried', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id);
    const failing = fakeGmail({ sendError: 'quota' });
    await runDailyFollowup(deps({ gmail: failing }));
    expect(db.listEscalationsByStatus('send_failed')).toHaveLength(1);
    expect(db.listEscalationsByStatus('open')).toHaveLength(0);
    expect(db.listDecisions().filter((d) => d.decision === 'auto_send')).toHaveLength(0);
    const gmail2 = fakeGmail();
    await runDailyFollowup(deps({ gmail: gmail2, now: new Date('2026-09-01T09:00:00Z') }));
    expect(gmail2.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('send_failed')).toHaveLength(1);
  });

  it('the vacation window skips the sweep entirely', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id);
    seedCloseEscalation(id);
    const gmail = fakeGmail();
    const d = deps({ gmail });
    // isInVacation compares MM-DD (year-agnostic window), see src/vacation.js.
    d.vacationConfig = { enabled: true, start: '08-01', end: '08-31' };
    await runDailyFollowup(d);
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  // --- the steady-state path: this run drafts it AND this run sends it -------
  // Every case above pre-seeds the escalation, which is the release-day
  // backlog, not the shape of ordinary days. STALE_RULES.DELIVERING is
  // `send_followup_close` at 14 days, so the staleness loop earlier in
  // runDailyFollowup mints the draft that this sweep then sends.

  it('drafts and auto-sends in the SAME run for a stale DELIVERING conversation', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv({ stateChangedAt: '2026-08-11T00:00:00Z' }); // 20 days
    seedInbound(id, { receivedAt: '2026-08-11T06:00:00Z' });
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(logs.some((l) => l.includes('FOLLOWUP drafted (T_FOLLOWUP_CLOSE)'))).toBe(true);
    expect(gmail.sent).toHaveLength(1);
    expect(db.listEscalationsByStatus('open')).toHaveLength(0);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
    const d = db.listDecisions().find((x) => x.decision === 'auto_send');
    expect(d.draft_template).toBe('T_FOLLOWUP_CLOSE');
  });

  it('drafts but does NOT send in the same run when the state is CROSSCHECK', async () => {
    // STALE_RULES.CROSSCHECK is also send_followup_close, so a change there
    // must not turn into unattended mail: the guard is state-based, not
    // template-based.
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv({ state: 'CROSSCHECK', stateChangedAt: '2026-08-11T00:00:00Z' });
    seedInbound(id, { receivedAt: '2026-08-11T06:00:00Z' });
    const gmail = fakeGmail();
    const logs = [];
    await runDailyFollowup(deps({ gmail, logs }));
    expect(logs.some((l) => l.includes('FOLLOWUP drafted (T_FOLLOWUP_CLOSE)'))).toBe(true);
    expect(gmail.sent).toHaveLength(0);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
    expect(logs.some((l) => l.includes('CLOSE stays manual') && l.includes('wrong_state'))).toBe(true);
  });

  // --- cap accounting, pinned at the boundary ------------------------------
  // Both rules are one line in the catch (`if (after !== 'open') sentThisRun++`)
  // and both are invisible below the cap, so they are exercised here with
  // CLOSE_AUTO_MAX_PER_RUN + 1 candidates: deleting the line fails the first
  // test, making it unconditional fails the second.

  it('a claimed-but-thrown send consumes cap budget — the mail may already have left', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    for (let i = 0; i < CLOSE_AUTO_MAX_PER_RUN + 1; i += 1) {
      const id = seedConv();
      seedInbound(id);
      seedCloseEscalation(id);
    }
    // The oldest escalation's send throws AFTER sendApprovedReply claimed it.
    const gmail = fakeGmail({ failOnCall: 1 });
    await runDailyFollowup(deps({ gmail }));
    expect(db.listEscalationsByStatus('send_failed')).toHaveLength(1);
    // 1 thrown + 4 delivered = 5 counted, so the 6th is never attempted.
    expect(gmail.sent).toHaveLength(CLOSE_AUTO_MAX_PER_RUN - 1);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(CLOSE_AUTO_MAX_PER_RUN - 1);
    expect(db.listEscalationsByStatus('open')).toHaveLength(1);
  });

  it('a refusal before the claim does NOT consume cap budget — no mail left', async () => {
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    // Oldest escalation is stale (a newer inbound landed after the draft), so
    // sendApprovedReply refuses it before touching Gmail and it stays open.
    const staleConv = seedConv();
    seedInbound(staleConv);
    const staleEsc = seedCloseEscalation(staleConv, { createdAt: '2026-08-30 07:00:00' });
    seedInbound(staleConv, { receivedAt: '2026-08-30T18:00:00Z' });
    for (let i = 0; i < CLOSE_AUTO_MAX_PER_RUN; i += 1) {
      const id = seedConv();
      seedInbound(id);
      seedCloseEscalation(id);
    }
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));
    expect(gmail.sent).toHaveLength(CLOSE_AUTO_MAX_PER_RUN);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(CLOSE_AUTO_MAX_PER_RUN);
    expect(db.listEscalationsByStatus('open').map((e) => e.id)).toEqual([staleEsc]);
  });

  it('a 10-day-old draft still goes out — there is deliberately NO draft-age rule', async () => {
    // Pins the divergence from the delay-ack guard's 48h stale_draft rule. The
    // close prose is timeless and the deploy-day backlog is exactly what this
    // sweep is for; a refactor that copies the age rule across must fail here.
    writeSwitch({ auto_send_templates: ['T_FOLLOWUP_CLOSE'] });
    const id = seedConv();
    seedInbound(id, { receivedAt: '2026-08-20T06:00:00Z' });
    seedCloseEscalation(id, { createdAt: '2026-08-21 07:00:00' });
    const gmail = fakeGmail();
    await runDailyFollowup(deps({ gmail }));
    expect(gmail.sent).toHaveLength(1);
    expect(db.listEscalationsByStatus('resolved_send')).toHaveLength(1);
  });
});
