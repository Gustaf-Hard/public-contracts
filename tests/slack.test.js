import { describe, it, expect } from 'vitest';
import {
  buildEscalationBlocks,
  verifySlackSignature,
  parseInteractivityPayload,
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
