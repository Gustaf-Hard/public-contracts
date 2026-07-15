import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const parseBase64Url = {
  decode(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  },
  encode(s) {
    return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};

function encodeRfc2047(s) {
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// Encode a header value that may contain a `"Display Name" <email@host>` form.
// Display name gets RFC 2047 encoded if it has any non-ASCII char; email is left bare.
function encodeAddress(addr) {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) {
    // Plain "user@host" — no display name to encode
    return addr;
  }
  const [, displayName, email] = m;
  const trimmedName = displayName.trim();
  if (!trimmedName) return `<${email}>`;
  // ASCII-only fast path
  if (/^[\x20-\x7e]+$/.test(trimmedName)) return `"${trimmedName}" <${email}>`;
  return `${encodeRfc2047(trimmedName)} <${email}>`;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Convert a plain-text body into a minimal HTML body suitable for the
// HTML alternative of a multipart/alternative message. Paragraphs split on
// blank lines; single newlines within a paragraph become <br>.
function plainTextToHtml(text) {
  const paragraphs = text.split(/\n\s*\n/);
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export function buildMimeMessage({ from, to, subject, body, inReplyTo, references }) {
  // Always send multipart/alternative (plain + HTML). Gmail's spam filter
  // treats brand-new-domain text/plain-only API sends much more harshly
  // than multipart messages — confirmed empirically against gmail.com.
  const boundary = `b_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const html = plainTextToHtml(body);

  const headers = [
    `From: ${encodeAddress(from)}`,
    `To: ${encodeAddress(to)}`,
    `Subject: ${encodeRfc2047(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
  ];

  const raw = [...headers, '', ...parts].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function walkParts(payload, plainOut, attsOut, htmlOut) {
  if (!payload) return;
  if (payload.parts) {
    for (const p of payload.parts) walkParts(p, plainOut, attsOut, htmlOut);
    return;
  }
  if (payload.filename && payload.body?.attachmentId) {
    attsOut.push({
      filename: payload.filename,
      mime_type: payload.mimeType,
      attachment_id: payload.body.attachmentId,
      size_bytes: payload.body.size ?? 0,
    });
    return;
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    plainOut.push(parseBase64Url.decode(payload.body.data));
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    htmlOut.push(parseBase64Url.decode(payload.body.data));
  }
}

// Minimal HTML → plain text for HTML-only inbound (many kommun mail systems
// send no text/plain alternative). Not a full renderer: strips style/script,
// turns structural tags into newlines, drops the rest of the tags, decodes
// the entities that actually occur in Swedish mail.
export function htmlToText(html) {
  let s = String(html ?? '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
  const entities = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö',
    eacute: 'é', Eacute: 'É', uuml: 'ü', Uuml: 'Ü',
  };
  s = s.replace(/&([a-zA-Z]+);/g, (m, name) => entities[name] ?? m);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function parseInboundMessage(message) {
  const headers = message.payload?.headers ?? [];
  const plain = [];
  const html = [];
  const attachments = [];
  walkParts(message.payload, plain, attachments, html);
  // Prefer text/plain; fall back to stripped text/html so an HTML-only reply
  // still reaches the LLM/classifier instead of parsing to an empty body.
  const body = plain.length > 0 ? plain.join('\n') : htmlToText(html.join('\n'));
  // Gmail's internalDate is the authoritative delivery time (ms epoch as a
  // string). Processing time must never be stored as received_at — a post-
  // outage backlog would corrupt every days-since computation downstream.
  const internalMs = message.internalDate != null ? parseInt(message.internalDate, 10) : NaN;
  return {
    gmail_message_id: message.id,
    gmail_thread_id: message.threadId,
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    message_id_header: headerValue(headers, 'Message-Id'),
    in_reply_to: headerValue(headers, 'In-Reply-To'),
    references: headerValue(headers, 'References'),
    body,
    attachments,
    internal_date: Number.isFinite(internalMs) ? new Date(internalMs).toISOString() : null,
  };
}

// Extract the lowercase domain from an email address or a "Name <a@b.se>"
// header value. Returns null when no domain is present.
export function extractEmailDomain(addr) {
  if (!addr) return null;
  const angle = String(addr).match(/<([^>]+)>/);
  const email = (angle ? angle[1] : addr).trim();
  const at = email.lastIndexOf('@');
  if (at === -1) return null;
  const domain = email.slice(at + 1).toLowerCase().replace(/[>\s]+$/, '');
  return domain || null;
}

// True when two email addresses share the same domain, or one's domain is a
// subdomain of the other's (case-insensitive). Used to associate a kommun's
// reply with its conversation even when the kommun forwarded/replied in a new
// Gmail thread — including from a förvaltning subdomain
// (utbildning.<kommun>.se vs @<kommun>.se, review L2). The dot-anchored
// endsWith keeps look-alike domains out (xvasteras.se ≠ vasteras.se).
export function sameEmailDomain(a, b) {
  const da = extractEmailDomain(a);
  const dbb = extractEmailDomain(b);
  if (!da || !dbb) return false;
  return da === dbb || da.endsWith('.' + dbb) || dbb.endsWith('.' + da);
}

export function buildOAuthClient(env) {
  const oauth2Client = new google.auth.OAuth2(
    env.GMAIL_OAUTH_CLIENT_ID,
    env.GMAIL_OAUTH_CLIENT_SECRET,
    env.GMAIL_OAUTH_REDIRECT_URI
  );
  return oauth2Client;
}

export function loadStoredToken(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveToken(path, tokens) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(tokens, null, 2));
}

export function makeGmail(authClient) {
  return google.gmail({ version: 'v1', auth: authClient });
}

export async function sendMessage(gmail, opts) {
  const raw = buildMimeMessage(opts);
  const params = { userId: 'me', requestBody: { raw } };
  if (opts.threadId) params.requestBody.threadId = opts.threadId;
  const res = await gmail.users.messages.send(params);
  return { id: res.data.id, threadId: res.data.threadId };
}

export async function listInboundQuery(gmail, query) {
  // Gmail caps a page at 100 messages and orders them newest-first. Our inbound
  // window can exceed one page (a 30-day window hit 201), so a single-page fetch
  // silently dropped older-but-in-window replies — including delivered contracts
  // (Alingsås, 11 Jun). Page through nextPageToken until exhausted. The 5000-cap
  // is a runaway guard; a real inbound window never approaches it.
  const all = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({
      userId: 'me', q: query, maxResults: 100, pageToken,
    });
    for (const m of res.data.messages ?? []) all.push(m);
    pageToken = res.data.nextPageToken;
  } while (pageToken && all.length < 5000);
  return all;
}

export async function getMessage(gmail, id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  return res.data;
}

export async function fetchAttachment(gmail, messageId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId });
  const data = res.data.data;
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export async function ensureLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const existing = list.data.labels?.find((l) => l.name === name);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({ userId: 'me', requestBody: { name } });
  return created.data.id;
}

export async function addLabel(gmail, messageId, labelId) {
  await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [labelId] } });
}

// Archive a whole thread — drop the INBOX label from every message in it,
// exactly like the Gmail "Archive" button. The thread stays fully intact (in
// All Mail, searchable, and re-surfaces in the inbox if the kommun replies
// again); it just leaves the operator's inbox.
export async function archiveThread(gmail, threadId) {
  await gmail.users.threads.modify({
    userId: 'me', id: threadId, requestBody: { removeLabelIds: ['INBOX'] },
  });
}
