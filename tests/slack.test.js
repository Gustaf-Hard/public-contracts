import { describe, it, expect } from 'vitest';
import {
  buildEscalationBlocks,
  verifySlackSignature,
  parseInteractivityPayload,
  updateEscalationResolved,
  postAlert,
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

describe('buildEscalationBlocks respond_by deadline line (2026-09-12 design)', () => {
  it('renders a deadline line when respond_by is set', () => {
    const blocks = buildEscalationBlocks({ escalation_id: 1, kommun_namn: 'Linköping', from_email: 'k@l.se', reply_text: 't', draft_reply: 'd', gmail_thread_id: 'g', respond_by: '2026-09-02' });
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).toContain('⏰');
    expect(texts).toContain('2026-09-02');
  });

  it('omits the deadline line when respond_by is not set', () => {
    const blocks = buildEscalationBlocks({ escalation_id: 1, kommun_namn: 'Linköping', from_email: 'k@l.se', reply_text: 't', draft_reply: 'd', gmail_thread_id: 'g' });
    const texts = blocks.map((b) => b.text?.text ?? '').join('\n');
    expect(texts).not.toContain('⏰');
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

// Round-9 N1 (critical): a Slack `section` block's text is capped at 3000
// characters, and the Köhälsa digest concatenates three sections of up to 20
// kommun/role labels each into ONE block. Codex reproduced 3009 characters at
// the worst case; over the cap Slack rejects the WHOLE message, and the digest's
// catch only logs it, so the operator is told nothing. One fix in one place: the
// single place every digest and every operational alert goes through.
describe('postAlert block budget', () => {
  // Round-10 O1 (critical): a Slack `text` field (the notification fallback)
  // has its own hard limit (40000 chars) and a `section` block's own cap is
  // 3000 chars. Slack itself would reject an over-limit postMessage call; the
  // fake here does the same, so a regression that reintroduces the full
  // original string in `text` fails LOUD instead of passing silently the way
  // the pre-fix suite did.
  // Round-11 P1: the fake also enforces Slack's 50-block ceiling and hands back a
  // DISTINCT ts per call, so a paginated alert's threading is observable and an
  // over-50-block page fails loud. `failOnCall` injects a mid-pagination failure.
  function fakeSlack({ failOnCall = null } = {}) {
    const calls = [];
    return {
      calls,
      chat: {
        postMessage: async (args) => {
          if (args.text.length > 40000) throw new Error(`Slack text field exceeds 40000 chars (${args.text.length})`);
          if (args.blocks.length > 50) throw new Error(`Slack blocks exceed 50 per message (${args.blocks.length})`);
          for (const b of args.blocks) {
            if (b.text.text.length > 3000) throw new Error(`Slack section block exceeds 3000 chars (${b.text.text.length})`);
          }
          calls.push(args);
          if (failOnCall === calls.length) throw new Error(`simulated Slack failure on page ${failOnCall}`);
          return { ts: `t-${calls.length}`, channel: args.channel };
        },
      },
    };
  }
  const LIMIT = 2900;
  const blockTexts = (slack) => slack.calls[0].blocks.map((b) => b.text.text);

  it('keeps a short alert in one block and posts it unchanged', async () => {
    const slack = fakeSlack();
    const res = await postAlert(slack, { channel: 'C1', text: '🧹 *Köhälsa:*\nallt lugnt' });
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0].blocks).toHaveLength(1);
    expect(slack.calls[0].blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '🧹 *Köhälsa:*\nallt lugnt' } });
    expect(slack.calls[0].text).toBe('🧹 *Köhälsa:*\nallt lugnt'); // short input: fallback text is unchanged
    expect(res).toEqual({ ts: 't-1', channel: 'C1' });
  });

  it('splits a 7000-character multi-line alert into consecutive blocks, never inside a line', async () => {
    const lines = Array.from({ length: 70 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(97)}`);
    const text = lines.join('\n');
    expect(text.length).toBeGreaterThan(6900);
    const slack = fakeSlack();
    await postAlert(slack, { channel: 'C1', text });

    expect(slack.calls).toHaveLength(1); // still ONE message
    const texts = blockTexts(slack);
    expect(texts).toHaveLength(3);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(LIMIT);
    for (const b of slack.calls[0].blocks) expect(b).toMatchObject({ type: 'section', text: { type: 'mrkdwn' } });
    // Nothing lost, nothing reordered, and every line survives whole.
    expect(texts.join('\n')).toBe(text);
    for (const t of texts) for (const line of t.split('\n')) expect(lines).toContain(line);
    // O1: the notification fallback is the first block's text, not the full
    // (7000+ char) original string.
    expect(slack.calls[0].text.length).toBeLessThanOrEqual(LIMIT);
    expect(slack.calls[0].text).toBe(texts[0]);
  });

  it('hard-splits a single line that is longer than the budget', async () => {
    const text = 'y'.repeat(7000);
    const slack = fakeSlack();
    await postAlert(slack, { channel: 'C1', text });
    const texts = blockTexts(slack);
    expect(texts).toHaveLength(3);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(LIMIT);
    expect(texts.join('')).toBe(text);
    expect(slack.calls[0].text.length).toBeLessThanOrEqual(LIMIT);
    expect(slack.calls[0].text).toBe(texts[0]);
  });

  // Round-11 P1 (critical): the old behaviour truncated at 50 blocks with an
  // "avkortat" marker. Every caller that books items as alerted AFTER a
  // successful post (digestUnmatched's seenUnmatched cache, the parked-analysis
  // digest's analysis_parked_alerted_at) books EVERY item it handed in,
  // including the ones the marker cut, so those items were suppressed until a
  // restart / for ever. Nothing may be dropped: paginate instead.
  it('paginates past 50 blocks into several messages instead of truncating', async () => {
    // 120 lines of exactly the 2900-char budget: one chunk each, so 120 blocks.
    const lines = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(3, '0')} ${'z'.repeat(2896)}`);
    for (const l of lines) expect(l.length).toBe(LIMIT);
    const text = lines.join('\n');
    const slack = fakeSlack();
    const res = await postAlert(slack, { channel: 'C1', text });

    expect(slack.calls).toHaveLength(3); // 50 + 50 + 20
    expect(slack.calls.map((c) => c.blocks.length)).toEqual([50, 50, 20]);
    for (const c of slack.calls) {
      expect(c.blocks.length).toBeLessThanOrEqual(50);
      for (const b of c.blocks) {
        expect(b).toMatchObject({ type: 'section', text: { type: 'mrkdwn' } });
        expect(b.text.text.length).toBeLessThanOrEqual(LIMIT);
      }
      // O1 per page: the fallback text is THAT page's first block, capped.
      expect(c.text).toBe(c.blocks[0].text.text);
      expect(c.text.length).toBeLessThanOrEqual(LIMIT);
    }
    // No marker, nothing dropped: every input line appears in exactly one block.
    const allBlockTexts = slack.calls.flatMap((c) => c.blocks.map((b) => b.text.text));
    expect(allBlockTexts).toHaveLength(120);
    expect(allBlockTexts.join('\n')).toBe(text);
    for (const l of lines) expect(allBlockTexts.filter((t) => t.includes(l))).toHaveLength(1);
    for (const t of allBlockTexts) expect(t).not.toMatch(/avkortat/);

    // Pages 2..n hang under page 1, so the channel sees one thread, not three
    // unrelated walls of text.
    expect(slack.calls[0].thread_ts).toBeUndefined();
    expect(slack.calls[1].thread_ts).toBe('t-1');
    expect(slack.calls[2].thread_ts).toBe('t-1');
    // Return shape unchanged: the FIRST page's ts/channel.
    expect(res).toEqual({ ts: 't-1', channel: 'C1' });
  });

  it('posts every page under a caller-supplied thread_ts', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(3, '0')} ${'z'.repeat(2896)}`);
    const slack = fakeSlack();
    const res = await postAlert(slack, { channel: 'C1', text: lines.join('\n'), thread_ts: 's-9' });
    expect(slack.calls).toHaveLength(2);
    expect(slack.calls.map((c) => c.thread_ts)).toEqual(['s-9', 's-9']);
    expect(res).toEqual({ ts: 't-1', channel: 'C1' });
  });

  it('throws when a later page fails, so the caller books nothing as alerted', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(3, '0')} ${'z'.repeat(2896)}`);
    const slack = fakeSlack({ failOnCall: 2 });
    await expect(postAlert(slack, { channel: 'C1', text: lines.join('\n') }))
      .rejects.toThrow(/simulated Slack failure on page 2/);
  });

  it('still threads a split alert under an existing escalation message', async () => {
    const slack = fakeSlack();
    await postAlert(slack, { channel: 'C1', text: 'a'.repeat(4000), thread_ts: 's-9' });
    expect(slack.calls[0].thread_ts).toBe('s-9');
    expect(slack.calls[0].blocks.length).toBeGreaterThan(1);
  });
});
