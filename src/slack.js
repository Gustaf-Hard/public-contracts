import { WebClient } from '@slack/web-api';
import crypto from 'node:crypto';

export function makeSlackClient(token) {
  return new WebClient(token);
}

export function buildEscalationBlocks({ escalation_id, kommun_namn, from_email, reply_text, draft_reply, gmail_thread_id, watchlist_vendors = [] }) {
  const idStr = String(escalation_id);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `Eskalering: ${kommun_namn}` } },
  ];
  if (watchlist_vendors.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *BEVAKAD LEVERANTÖR:* ${watchlist_vendors.join(', ')} — kontrollera innan du svarar.` } });
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
// escalations, etc.
export async function postAlert(slack, { channel, text }) {
  const res = await slack.chat.postMessage({
    channel,
    text,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  });
  return { ts: res.ts, channel: res.channel };
}

// Replace an escalation's Slack message with a resolved (button-less) version.
// Called after any resolution (send, edit, skip, supersede, failure) so a stale
// Approve button can never be clicked again. The atomic DB claim is the real
// double-send guard; this is defense-in-depth + operator UX.
export async function updateEscalationResolved(slack, { channel, ts, kommun_namn, status, detail }) {
  const statusText = {
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
