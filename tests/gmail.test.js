import { describe, it, expect, vi } from 'vitest';
import {
  buildMimeMessage,
  parseInboundMessage,
  parseBase64Url,
  extractEmailDomain,
  sameEmailDomain,
  listInboundQuery,
} from '../src/gmail.js';

describe('listInboundQuery', () => {
  it('paginates through every page so replies past the first 100 are not dropped', async () => {
    // Gmail caps a page at 100 and returns newest-first. A 30-day window can
    // exceed one page (it did: 201 messages), so an unpaginated fetch silently
    // dropped older-but-in-window replies — including delivered contracts.
    const page1 = { data: { messages: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })), nextPageToken: 'PAGE2' } };
    const page2 = { data: { messages: [{ id: 'older-contract' }], nextPageToken: undefined } };
    const list = vi.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const gmail = { users: { messages: { list } } };

    const result = await listInboundQuery(gmail, 'to:me -from:me newer_than:30d');

    expect(result).toHaveLength(101);
    expect(result.map((m) => m.id)).toContain('older-contract');
    // Second call must forward the pageToken from the first response.
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0]).toMatchObject({ pageToken: 'PAGE2' });
  });

  it('returns an empty array when the mailbox has no matches', async () => {
    const list = vi.fn().mockResolvedValue({ data: {} });
    const gmail = { users: { messages: { list } } };
    expect(await listInboundQuery(gmail, 'q')).toEqual([]);
  });
});

describe('extractEmailDomain / sameEmailDomain', () => {
  it('extracts domain from bare and angle-bracket addresses', () => {
    expect(extractEmailDomain('jerker.rellmark@ale.se')).toBe('ale.se');
    expect(extractEmailDomain('Jerker Rellmark <jerker.rellmark@ALE.se>')).toBe('ale.se');
    expect(extractEmailDomain('')).toBeNull();
    expect(extractEmailDomain('no-at-sign')).toBeNull();
  });

  it('matches same-domain pairs case-insensitively, rejects different domains', () => {
    expect(sameEmailDomain('Jerker <jerker.rellmark@ale.se>', 'kansli@ale.se')).toBe(true);
    expect(sameEmailDomain('a@vasteras.se', 'b@ale.se')).toBe(false);
    expect(sameEmailDomain('a@ale.se', null)).toBe(false);
  });
});

describe('buildMimeMessage', () => {
  it('produces a base64url-encoded multipart/alternative RFC 822 message with both text and HTML parts', () => {
    const raw = buildMimeMessage({
      from: 'Gustaf <gustaf@mediagraf.se>',
      to: 'registrator@kommun.se',
      subject: 'Begäran',
      body: 'Hej!\n\nText\n',
    });
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^From: "Gustaf" <gustaf@mediagraf.se>/m);
    expect(decoded).toMatch(/^To: registrator@kommun.se/m);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?B\?/m); // base64 subject for åäö-safety
    expect(decoded).toMatch(/^Content-Type: multipart\/alternative; boundary="b_/m);
    // Plain part — body's internal \n separators are preserved verbatim
    expect(decoded).toMatch(/Content-Type: text\/plain; charset="UTF-8"/);
    expect(decoded).toContain('Hej!\n\nText\n');
    // HTML part — paragraphs split on blank lines
    expect(decoded).toMatch(/Content-Type: text\/html; charset="UTF-8"/);
    expect(decoded).toContain('<p>Hej!</p>');
    expect(decoded).toContain('<p>Text');
  });

  it('escapes HTML special chars in the HTML part', () => {
    const raw = buildMimeMessage({
      from: 'a@b.se', to: 'c@d.se', subject: 'X', body: 'Less < than & ampersand',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain('Less &lt; than &amp; ampersand');
  });

  it('RFC-2047 encodes non-ASCII display names in From/To headers', () => {
    const raw = buildMimeMessage({
      from: 'Gustaf Hård af Segerstad <gustaf@mediagraf.se>',
      to: 'Test Användare <test@example.se>',
      subject: 'Subj',
      body: 'b',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // From display-name contains å -> must be RFC-2047 encoded
    expect(decoded).toMatch(/^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <gustaf@mediagraf\.se>/m);
    // To display-name contains å -> same
    expect(decoded).toMatch(/^To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <test@example\.se>/m);
    // The raw bytes for å must NOT appear in the From header line — only in the body
    const fromLine = decoded.split(/\r?\n/).find((l) => l.startsWith('From:'));
    expect(fromLine).not.toMatch(/å/);
  });

  it('passes bare email addresses through unchanged', () => {
    const raw = buildMimeMessage({
      from: 'noreply@example.com',
      to: 'someone@example.com',
      subject: 'X',
      body: 'Y',
    });
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toMatch(/^From: noreply@example\.com$/m);
    expect(decoded).toMatch(/^To: someone@example\.com$/m);
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
