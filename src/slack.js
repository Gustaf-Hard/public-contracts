import { WebClient } from '@slack/web-api';
import crypto from 'node:crypto';

export function makeSlackClient(token) {
  return new WebClient(token);
}

export function buildEscalationBlocks({ escalation_id, kommun_namn, from_email, reply_text, draft_reply, gmail_thread_id, watchlist_vendors = [], respond_by = null }) {
  const idStr = String(escalation_id);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Eskalering: ${kommun_namn}` } },
  ];
  if (watchlist_vendors.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *BEVAKAD LEVERANTÖR:* ${watchlist_vendors.join(', ')} — kontrollera innan du svarar.` } });
  }
  if (respond_by) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⏰ *Kommunens svarsfrist:* ${respond_by}. Skickas inget innan dess kan kommunen stänga ärendet.` } });
  }
  blocks.push(
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Från:*\n${from_email}` },
        { type: 'mrkdwn', text: `*Tråd:*\n${gmail_thread_id}` },
      ],
    },
    { type: 'section', text: { type: 'mrkdwn', text: `*Inkommande:*\n>${reply_text.replace(/\n/g, '\n>').slice(0, 1500)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Förslag på svar:*\n>${(draft_reply ?? '(ingen draft)').replace(/\n/g, '\n>').slice(0, 1500)}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'esc_approve', value: idStr, text: { type: 'plain_text', text: 'Approve' }, style: 'primary' },
        { type: 'button', action_id: 'esc_edit', value: idStr, text: { type: 'plain_text', text: 'Edit' } },
        { type: 'button', action_id: 'esc_skip', value: idStr, text: { type: 'plain_text', text: 'Skip' }, style: 'danger' },
      ],
    },
  );
  return blocks;
}

export async function postEscalation(slack, { channel, blocks, fallbackText }) {
  const res = await slack.chat.postMessage({ channel, blocks, text: fallbackText ?? 'Eskalering' });
  return { ts: res.ts, channel: res.channel };
}

// Post a plain (button-less) alert to the escalation channel. Used for
// operational warnings: unmatched inbound digests, send-unconfirmed
// escalations, refused sends, etc. `thread_ts` posts it as a reply UNDER an
// existing escalation message, which is how a refusal stays attached to the
// buttons it refused without disturbing them.
//
// Round-9 N1 (critical): one `section` block's text is capped at 3000 characters
// and Slack rejects the WHOLE message when it is exceeded — and every caller
// here is inside a try/catch that only logs, so the operator simply never hears
// about the queue. The Köhälsa digest concatenates three 20-line sections with
// kommun/role labels into this one block and was reproduced at 3009 characters.
// So the split lives HERE, in the single place every digest and every alert goes
// through, rather than in each caller's string building: consecutive section
// blocks of at most SECTION_MAX_CHARS, in ONE postMessage (Slack allows up to
// MAX_SECTION_BLOCKS blocks). Return shape unchanged; the top-level `text` (the
// notification fallback, capped far higher) is untouched.
const SECTION_MAX_CHARS = 2900;
const MAX_SECTION_BLOCKS = 50;

// Split at LINE boundaries, so a kommun label, a markdown bullet or a `*header*`
// is never cut in half. A single line longer than the budget (no line boundary to
// use) is hard-split at the budget — losing the alert entirely is the worse
// outcome. Order is preserved and nothing is dropped: joining the chunks back
// reproduces the input, with the newlines the split consumed between them.
export function splitAlertText(text, max = SECTION_MAX_CHARS) {
  const source = String(text ?? '');
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur !== '') { chunks.push(cur); cur = ''; } };
  for (const line of source.split('\n')) {
    if (line.length > max) {
      flush();
      let rest = line;
      while (rest.length > max) {
        chunks.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      cur = rest;
      continue;
    }
    const candidate = cur === '' ? line : `${cur}\n${line}`;
    if (candidate.length > max) {
      flush();
      cur = line;
    } else {
      cur = candidate;
    }
  }
  flush();
  if (chunks.length === 0) return [source];
  if (chunks.length > MAX_SECTION_BLOCKS) {
    const dropped = chunks.length - (MAX_SECTION_BLOCKS - 1);
    // Say what was cut instead of silently dropping it (and instead of letting
    // Slack reject the message over the 50-block limit, which drops all of it).
    return [
      ...chunks.slice(0, MAX_SECTION_BLOCKS - 1),
      `_…avkortat: ${dropped} avsnitt till fick inte plats i detta meddelande._`,
    ];
  }
  return chunks;
}

export async function postAlert(slack, { channel, text, thread_ts = null }) {
  const res = await slack.chat.postMessage({
    channel,
    text,
    blocks: splitAlertText(text).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
    ...(thread_ts ? { thread_ts } : {}),
  });
  return { ts: res.ts, channel: res.channel };
}

// Replace an escalation's Slack message with a resolved (button-less) version.
// Called after any resolution (send, edit, skip, supersede, failure) so a stale
// Approve button can never be clicked again. The atomic DB claim is the real
// double-send guard; this is defense-in-depth + operator UX.
// `decision` is presentation-only (2026-08-17 auto-send design): an unattended
// T_FOLLOWUP_NUDGE is STORED as resolved_send like any approved send — the
// decisions ledger is what permanently distinguishes machine from operator, and
// adding a status string would need a migration for a label. But rendering it as
// "godkänt oförändrat" tells the channel a colleague approved a send no human
// ever saw, so the ONE operator-facing artifact gets an honest label instead.
// Absent/unknown decision keeps every existing caller's wording untouched.
export async function updateEscalationResolved(slack, { channel, ts, kommun_namn, status, detail, decision = null }) {
  const statusText = (decision === 'auto_send' && status === 'resolved_send')
    ? '🤖 Auto-skickat (ingen operatör)'
    : {
      resolved_send: '✅ Skickat (godkänt oförändrat)',
      resolved_edit: '✅ Skickat (redigerat)',
      resolved_skip: '⏭️ Skippad',
      resolved_closed: '🗄️ Ärendet stängt',
      superseded: '↪️ Ersatt av nyare eskalering',
      send_failed: '❌ Sändning misslyckades',
      send_unconfirmed: '⚠️ Sändning obekräftad — kontrollera Skickat i Gmail',
    }[status] ?? status;
  const lines = [`*Eskalering: ${kommun_namn}* — ${statusText}`];
  if (detail) lines.push(detail);
  await slack.chat.update({
    channel,
    ts,
    text: `Eskalering: ${kommun_namn} — ${statusText}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
  });
}

export async function openEditModal(slack, { trigger_id, escalation_id, draft_reply }) {
  await slack.views.open({
    trigger_id,
    view: {
      type: 'modal',
      callback_id: 'esc_edit_modal',
      private_metadata: String(escalation_id),
      title: { type: 'plain_text', text: 'Redigera svar' },
      submit: { type: 'plain_text', text: 'Skicka' },
      close: { type: 'plain_text', text: 'Avbryt' },
      blocks: [
        {
          type: 'input',
          block_id: 'reply_input',
          label: { type: 'plain_text', text: 'Svarstext' },
          element: { type: 'plain_text_input', action_id: 'reply_text', multiline: true, initial_value: draft_reply ?? '' },
        },
      ],
    },
  });
}

export function verifySlackSignature({ signingSecret, timestamp, body, signature, maxSkewSeconds = 300 }) {
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxSkewSeconds) return false;
  const sigBase = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(sigBase).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function parseInteractivityPayload(rawBody) {
  const params = new URLSearchParams(rawBody);
  const payloadStr = params.get('payload');
  if (!payloadStr) throw new Error('No payload in interactivity body');
  const payload = JSON.parse(payloadStr);
  const action = payload.actions?.[0];
  return {
    type: payload.type,
    action_id: action?.action_id,
    escalation_id: action?.value,
    trigger_id: payload.trigger_id,
    user_id: payload.user?.id,
    user_name: payload.user?.name,
    message_ts: payload.message?.ts,
    view: payload.view,
  };
}
