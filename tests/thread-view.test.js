import { describe, it, expect } from 'vitest';
import { threadPreview, threadMessage, renderThreadGroups } from '../src/dashboard-views.js';

const msg = (o = {}) => ({
  id: 1, direction: 'inbound', from_email: 'a@x.se', to_email: 'me@x.se',
  subject: 'SV: Begäran', body_text: 'Hej', analysis_json: null,
  received_at: '2026-06-23T10:00:00Z', attachment_count: 0, ...o,
});

describe('threadPreview', () => {
  it('uses the LLM summary of the latest message when present', () => {
    const pv = threadPreview([
      msg({ id: 1, received_at: '2026-06-20T10:00:00Z' }),
      msg({ id: 2, analysis_json: JSON.stringify({ summary: 'Kommunen bifogar tre avtal.' }), body_text: 'Rå text' }),
    ], 'Mikaela Radgren');
    expect(pv.summary).toBe('Kommunen bifogar tre avtal.');
    expect(pv.count).toBe(2);
  });

  it('falls back to a raw quote-stripped snippet for an outbound / no-analysis latest message', () => {
    const pv = threadPreview([
      msg({ id: 1, direction: 'outbound', from_email: 'me@x.se', to_email: 'a@x.se',
        body_text: 'Hej, här är vår begäran.\n12 juni 2026 kl. 13:13 skrev Gustaf <g@x.se>:\n> gammalt', analysis_json: null }),
    ], 'Mikaela');
    expect(pv.summary).toBe('Hej, här är vår begäran.');
    expect(pv.summary).not.toContain('skrev');
  });

  it('appends ", jag" only when the thread has an outbound message', () => {
    expect(threadPreview([msg({ direction: 'inbound' })], 'Anna').participants).toBe('Anna · 1');
    expect(threadPreview([
      msg({ id: 1, direction: 'inbound' }),
      msg({ id: 2, direction: 'outbound' }),
    ], 'Anna').participants).toBe('Anna, jag · 2');
  });

  it('reports the latest message date', () => {
    const pv = threadPreview([msg({ received_at: '2026-06-23T10:00:00Z' })], 'Anna');
    expect(pv.date).toContain('2026-06-23');
  });
});

describe('renderThreadGroups', () => {
  const attachmentsByMsg = {};
  const signatures = {};
  const run = (threads, messages, escByThread = new Map()) =>
    renderThreadGroups(threads, messages, attachmentsByMsg, signatures, escByThread, false);

  it('renders a one-line row without the email address or mute/primary controls in the header', () => {
    const html = run(
      [{ id: 10, status: 'neutral', counterparty_email: 'anna@x.se', counterparty_name: 'Anna Berg' }],
      [msg({ id: 1, thread_id: 10, subject: 'SV: Begäran', body_text: 'Kort svar' })],
    );
    const header = html.slice(html.indexOf('thread-head'), html.indexOf('thread-body'));
    expect(header).toContain('Anna Berg');
    expect(header).not.toContain('anna@x.se');       // email removed from the row
    expect(header).not.toContain('make primary');    // controls removed from the row
    expect(header).not.toContain('/threads/10/status');
    // Subject prefix stripped on the row.
    expect(header).toContain('Begäran');
    expect(header).not.toContain('SV: Begäran');
  });

  it('moves the status control into the expanded body toolbar', () => {
    const html = run(
      [{ id: 10, status: 'neutral', counterparty_email: 'anna@x.se', counterparty_name: 'Anna' }],
      [msg({ id: 1, thread_id: 10 })],
    );
    expect(html).toContain('thread-toolbar');
    expect(html).toContain('action="/threads/10/status"');
    // The toolbar sits inside the (hidden) body, after data-thread-body.
    expect(html.indexOf('data-thread-body')).toBeLessThan(html.indexOf('thread-toolbar'));
  });

  it('shows a ★ only for a primary thread', () => {
    const primary = run([{ id: 1, status: 'primary', counterparty_email: 'a@x.se', counterparty_name: 'A' }], [msg({ id: 1, thread_id: 1 })]);
    const neutral = run([{ id: 2, status: 'neutral', counterparty_email: 'b@x.se', counterparty_name: 'B' }], [msg({ id: 2, thread_id: 2 })]);
    expect(primary).toContain('thread-star');
    expect(neutral).not.toContain('thread-star');
  });

  it('bolds a thread with a pending escalation', () => {
    const esc = new Map([[1, [{ id: 5, recipient: 'a@x.se', draft_subject: 'Re', draft_body: 'x' }]]]);
    const html = run([{ id: 1, status: 'neutral', counterparty_email: 'a@x.se', counterparty_name: 'A' }], [msg({ id: 1, thread_id: 1 })], esc);
    expect(html).toContain('thread-unread');
    expect(html).toContain('thread-needs-action');
  });

  it('sorts thread groups latest-message-first', () => {
    const html = run(
      [
        { id: 1, status: 'neutral', counterparty_email: 'old@x.se', counterparty_name: 'Old Sender' },
        { id: 2, status: 'neutral', counterparty_email: 'new@x.se', counterparty_name: 'New Sender' },
      ],
      [
        msg({ id: 1, thread_id: 1, received_at: '2026-06-08T00:00:00Z' }),
        msg({ id: 2, thread_id: 2, received_at: '2026-06-23T00:00:00Z' }),
      ],
    );
    expect(html.indexOf('New Sender')).toBeLessThan(html.indexOf('Old Sender'));
  });

  it('keeps rendering an Ogrupperat orphan section', () => {
    const html = run(
      [{ id: 1, status: 'neutral', counterparty_email: 'a@x.se', counterparty_name: 'A' }],
      [
        msg({ id: 1, thread_id: 1 }),
        msg({ id: 2, thread_id: null, body_text: 'orphan-body' }),
      ],
    );
    expect(html).toContain('Ogrupperat');
    expect(html).toContain('orphan-body');
  });
});

describe('threadMessage', () => {
  it('renders the visible text and hides the quoted tail behind a ··· toggle', () => {
    const html = threadMessage(msg({
      body_text: 'Nytt svar här.\n12 juni 2026 kl. 13:13 skrev Gustaf <g@x.se>:\n> gammal historik',
    }), [], null, true);
    expect(html).toContain('Nytt svar här.');
    expect(html).toContain('data-quote-toggle');
    expect(html).toContain('Visa citerad historik');
    // The quoted block is present but hidden by default.
    expect(html).toMatch(/data-quote-body hidden/);
    expect(html).toContain('gammal historik');
  });

  it('renders no toggle when there is no quoted history', () => {
    const html = threadMessage(msg({ body_text: 'Bara nytt.' }), [], null, true);
    expect(html).not.toContain('data-quote-toggle');
    expect(html).toContain('Bara nytt.');
  });

  it('keeps a signature visible (not tucked into the quote)', () => {
    const html = threadMessage(msg({ body_text: 'Tack.\n\nMed vänlig hälsning\nAnna' }), [], null, true);
    expect(html).toContain('Med vänlig hälsning');
    expect(html).not.toContain('data-quote-toggle');
  });
});
