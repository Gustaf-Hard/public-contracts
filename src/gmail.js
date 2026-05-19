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

function encodeSubject(s) {
  // RFC 2047 base64-encode the subject so åäö survive
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

export function buildMimeMessage({ from, to, subject, body, inReplyTo, references }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push('', body);
  const raw = lines.join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerValue(headers, name) {
  const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function walkParts(payload, plainOut, attsOut) {
  if (!payload) return;
  if (payload.parts) {
    for (const p of payload.parts) walkParts(p, plainOut, attsOut);
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
}

export function parseInboundMessage(message) {
  const headers = message.payload?.headers ?? [];
  const plain = [];
  const attachments = [];
  walkParts(message.payload, plain, attachments);
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
    body: plain.join('\n'),
    attachments,
  };
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
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 100 });
  return res.data.messages ?? [];
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
