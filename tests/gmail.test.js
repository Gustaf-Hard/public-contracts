import { describe, it, expect, vi } from 'vitest';
import {
  buildMimeMessage,
  parseInboundMessage,
  parseBase64Url,
} from '../src/gmail.js';

describe('buildMimeMessage', () => {
  it('produces a base64url-encoded RFC 822 message with required headers', () => {
    const raw = buildMimeMessage({
      from: 'Gustaf <gustaf@mediagraf.se>',
      to: 'registrator@kommun.se',
      subject: 'Begäran',
      body: 'Hej!\n\nText\n',
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^From: Gustaf <gustaf@mediagraf.se>/m);
    expect(decoded).toMatch(/^To: registrator@kommun.se/m);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?B\?/m); // base64 subject for åäö-safety
    expect(decoded).toMatch(/^Content-Type: text\/plain; charset="UTF-8"/m);
  });

  it('adds threading headers when provided', () => {
    const raw = buildMimeMessage({
      from: 'a@b.se', to: 'c@d.se', subject: 'Re: X', body: 'Y',
      inReplyTo: '<msg1@gmail.com>',
      references: '<msg0@gmail.com> <msg1@gmail.com>',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^In-Reply-To: <msg1@gmail.com>/m);
    expect(decoded).toMatch(/^References: <msg0@gmail.com> <msg1@gmail.com>/m);
  });
});

describe('parseInboundMessage', () => {
  it('extracts plain text body from a Gmail message payload', () => {
    const payload = {
      id: 'm1',
      threadId: 't1',
      payload: {
        headers: [
          { name: 'From', value: 'Mikaela <m@vasteras.se>' },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Re: Begäran' },
          { name: 'Date', value: 'Mon, 19 May 2026 10:00:00 +0200' },
        ],
        mimeType: 'text/plain',
        body: { data: parseBase64Url.encode('Hej Gustaf,\n\nPrecisera tack.\n') },
      },
    };
    const parsed = parseInboundMessage(payload);
    expect(parsed.from).toBe('Mikaela <m@vasteras.se>');
    expect(parsed.subject).toBe('Re: Begäran');
    expect(parsed.body).toContain('Precisera tack');
    expect(parsed.attachments).toEqual([]);
  });

  it('extracts attachments from a multipart message', () => {
    const payload = {
      id: 'm2',
      threadId: 't2',
      payload: {
        headers: [
          { name: 'From', value: 'm@vasteras.se' },
          { name: 'To', value: 'gustaf@mediagraf.se' },
          { name: 'Subject', value: 'Re: Begäran' },
          { name: 'Date', value: 'Mon, 19 May 2026 10:00:00 +0200' },
        ],
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { data: parseBase64Url.encode('Här kommer avtalet bifogat.') } },
          { mimeType: 'application/pdf', filename: 'avtal.pdf', body: { attachmentId: 'att-1', size: 1024 } },
        ],
      },
    };
    const parsed = parseInboundMessage(payload);
    expect(parsed.body).toContain('Här kommer avtalet');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: 'avtal.pdf', mime_type: 'application/pdf', attachment_id: 'att-1', size_bytes: 1024 });
  });
});
