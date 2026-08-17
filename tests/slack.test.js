import { describe, it, expect } from 'vitest';
import {
  buildEscalationBlocks,
  verifySlackSignature,
  parseInteractivityPayload,
  updateEscalationResolved,
} from '../src/slack.js';
import crypto from 'node:crypto';

describe('buildEscalationBlocks', () => {
  it('produces Block Kit JSON with Approve/Edit/Skip buttons', () => {
    const blocks = buildEscalationBlocks({
      escalation_id: 42,
      kommun_namn: 'Testkommun',
      from_email: 'gustaf.hard@gmail.com',
      reply_text: 'Hej, kan du ringa mig?',
      draft_reply: 'Hej, jag föredrar e-post.',
      gmail_thread_id: 'thr-1',
    });
    expect(Array.isArray(blocks)).toBe(true);
    const buttonBlock = blocks.find((b) => b.type === 'actions');
    expect(buttonBlock.elements).toHaveLength(3);
    expect(buttonBlock.elements.map((e) => e.action_id)).toEqual(['esc_approve', 'esc_edit', 'esc_skip']);
    for (const e of buttonBlock.elements) {
      expect(e.value).toBe('42');
    }
  });
});

describe('verifySlackSignature', () => {
  it('accepts a correctly signed request', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000));
    const body = 'payload=%7B%22foo%22%3A1%7D';
    const sigBase = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature: sig })).toBe(true);
  });

  it('rejects a bad signature', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body: 'x', signature: 'v0=bad' })).toBe(false);
  });

  it('rejects stale timestamps (>5 min)', () => {
    const secret = 'shh';
    const ts = String(Math.floor(Date.now() / 1000) - 600);
    const body = 'x';
    const sigBase = `v0:${ts}:${body}`;
    const sig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBase).digest('hex');
    expect(verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature: sig })).toBe(false);
  });
});

describe('buildEscalationBlocks watchlist banner', () => {
  const base = { escalation_id: 1, kommun_namn: 'Arjeplog', from_email: 'a@x.se', reply_text: 'hej', draft_reply: 'svar', gmail_thread_id: 't1' };
  it('adds a BEVAKAD LEVERANTÖR banner when watchlist_vendors present', () => {
    const blocks = buildEscalationBlocks({ ...base, watchlist_vendors: ['Binogi', 'Nationalencyklopedin'] });
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).toMatch(/BEVAKAD LEVERANTÖR:.*Binogi.*Nationalencyklopedin/);
  });
  it('omits the banner when no watchlist vendors', () => {
    const blocks = buildEscalationBlocks(base);
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).not.toMatch(/BEVAKAD/);
  });
});

describe('parseInteractivityPayload', () => {
  it('extracts action_id, value, and trigger_id from form-encoded payload', () => {
    const payload = {
      actions: [{ action_id: 'esc_approve', value: '42' }],
      trigger_id: 'trig-1',
      user: { id: 'U1', name: 'gustaf' },
      message: { ts: '1234.5678' },
    };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const parsed = parseInteractivityPayload(body);
    expect(parsed.action_id).toBe('esc_approve');
    expect(parsed.escalation_id).toBe('42');
    expect(parsed.trigger_id).toBe('trig-1');
    expect(parsed.message_ts).toBe('1234.5678');
  });
});

// An unattended send and an operator-approved send share the STORED status
// (resolved_send). The Slack message is the only artifact an operator scrolling
// the channel sees, so it must not attribute a machine send to a colleague.
describe('updateEscalationResolved labels agency honestly', () => {
  function fakeSlack() {
    const calls = [];
    return { calls, chat: { update: async (args) => { calls.push(args); } } };
  }

  it("decision 'auto_send' renders an unattended label, not 'godkänt oförändrat'", async () => {
    const slack = fakeSlack();
    await updateEscalationResolved(slack, {
      channel: 'C1', ts: 's-1', kommun_namn: 'Ale',
      status: 'resolved_send', decision: 'auto_send',
    });
    const text = slack.calls[0].text;
    expect(text).toContain('Auto-skickat');
    expect(text).not.toContain('godkänt');
    expect(slack.calls[0].blocks[0].text.text).toContain('Auto-skickat');
  });

  it('operator decisions keep their existing labels', async () => {
    const cases = [
      ['resolved_send', 'approve_unmodified', '✅ Skickat (godkänt oförändrat)'],
      ['resolved_edit', 'edit', '✅ Skickat (redigerat)'],
      ['resolved_skip', 'skip', '⏭️ Skippad'],
    ];
    for (const [status, decision, expected] of cases) {
      const slack = fakeSlack();
      await updateEscalationResolved(slack, { channel: 'C1', ts: 's-1', kommun_namn: 'Ale', status, decision });
      expect(slack.calls[0].text).toBe(`Eskalering: Ale — ${expected}`);
    }
  });

  it('an omitted decision is unchanged for every status (existing callers)', async () => {
    const cases = [
      ['resolved_send', '✅ Skickat (godkänt oförändrat)'],
      ['superseded', '↪️ Ersatt av nyare eskalering'],
      ['send_failed', '❌ Sändning misslyckades'],
      ['send_unconfirmed', '⚠️ Sändning obekräftad — kontrollera Skickat i Gmail'],
      ['resolved_closed', '🗄️ Ärendet stängt'],
    ];
    for (const [status, expected] of cases) {
      const slack = fakeSlack();
      await updateEscalationResolved(slack, { channel: 'C1', ts: 's-1', kommun_namn: 'Ale', status });
      expect(slack.calls[0].text).toBe(`Eskalering: Ale — ${expected}`);
    }
  });

  it("auto_send does not hijack a non-send status (a parked auto-send still reads as failed)", async () => {
    const slack = fakeSlack();
    await updateEscalationResolved(slack, {
      channel: 'C1', ts: 's-1', kommun_namn: 'Ale',
      status: 'send_failed', decision: 'auto_send', detail: 'socket hang up',
    });
    expect(slack.calls[0].text).toContain('Sändning misslyckades');
  });
});
