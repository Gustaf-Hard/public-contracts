import express from 'express';
import cron from 'node-cron';
import { runTick, runDailyFollowup } from './tick.js';
import { openDb } from './storage.js';
import { buildOAuthClient, loadStoredToken, saveToken, makeGmail, sendMessage as gmailSend, listInboundQuery, getMessage as gmailGet, fetchAttachment } from './gmail.js';
// gmailSend stays imported because runTick's gmailOps below uses it.
import { makeSlackClient, verifySlackSignature, parseInteractivityPayload, postEscalation, postAlert, openEditModal, updateEscalationResolved } from './slack.js';
import { loadOverrides, getEffectiveNow } from './pilot-config.js';
import { sendApprovedReply } from './send-reply.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

// Wrap an async fn so overlapping invocations are skipped, not queued.
// node-cron does NOT serialize async callbacks; a tick that runs longer than
// the cron interval (LLM analysis of a big delivery) would otherwise overlap
// the next one and double-dispatch due sends (autopilot review C3).
export function makeExclusive(fn, { log = null, name = 'task' } = {}) {
  let running = false;
  return async (...args) => {
    if (running) {
      log?.(`${name} skipped: previous run still in progress`);
      return { skipped: true };
    }
    running = true;
    try {
      return await fn(...args);
    } finally {
      running = false;
    }
  };
}

// Best-effort chat.update — a Slack failure must never break the DB flow.
async function stripButtons(slack, env, esc, kommunNamn, status, log) {
  if (!esc?.slack_ts || !env.SLACK_CHANNEL_ID) return;
  try {
    await updateEscalationResolved(slack, {
      channel: env.SLACK_CHANNEL_ID, ts: esc.slack_ts, kommun_namn: kommunNamn, status,
    });
  } catch (e) {
    log?.(`chat.update failed for escalation ${esc.id}: ${e.message}`);
  }
}

// Slack interactivity handler, extracted from startDaemon so the approve path
// is testable offline. Verifies the request signature, performs the action,
// and only THEN acks — so a daemon crash mid-approve makes Slack retry the
// interaction instead of silently losing the click (review L1). Retries are
// safe: sendApprovedReply's atomic claim makes a duplicate approve a no-op.
export function createInteractivityHandler({ db, slack, gmail, env, log = console.log, sendApprovedReplyImpl = sendApprovedReply, openEditModalImpl = openEditModal }) {
  return async (req, res) => {
    const body = req.body.toString('utf8');
    const ts = req.header('X-Slack-Request-Timestamp');
    const sig = req.header('X-Slack-Signature');
    if (!verifySlackSignature({ signingSecret: env.SLACK_SIGNING_SECRET, timestamp: ts, body, signature: sig })) {
      return res.status(401).send('bad signature');
    }

    try {
      const parsed = parseInteractivityPayload(body);
      if (parsed.type === 'block_actions') {
        const escId = parseInt(parsed.escalation_id, 10);
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        if (!esc) return res.status(200).send('');
        const conv = db.getConversation(esc.conversation_id);
        if (parsed.action_id === 'esc_approve') {
          try {
            await sendApprovedReplyImpl({
              db, gmail, env, conv, esc, finalBody: esc.draft_body,
              decision: 'approve_unmodified', slackClient: slack, log,
            });
          } catch (e) {
            if (e.code === 'ESCALATION_NOT_OPEN') {
              // Stale click / Slack retry after the send already happened.
              // Heal the stale buttons; do NOT re-send.
              const current = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
              await stripButtons(slack, env, current, conv.kommun_namn, current.status, log);
              log(`approve ignored: escalation ${escId} already ${current.status}`);
            } else {
              log(`approve failed for escalation ${escId}: ${e.message}`);
            }
          }
        } else if (parsed.action_id === 'esc_edit') {
          await openEditModalImpl(slack, { trigger_id: parsed.trigger_id, escalation_id: escId, draft_reply: esc.draft_body });
        } else if (parsed.action_id === 'esc_skip') {
          if (esc.status === 'open') {
            db.resolveEscalation(escId, { status: 'resolved_skip' });
            db.recordDecision({
              escalation_id: escId, conversation_id: conv.id,
              conversation_state: esc.previous_state ?? conv.state,
              classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
              draft_template: esc.draft_template, draft_body: esc.draft_body,
              decision: 'skip', final_body: null,
            });
          }
          await stripButtons(slack, env, esc, conv.kommun_namn, 'resolved_skip', log);
        }
      } else if (parsed.type === 'view_submission' && parsed.view?.callback_id === 'esc_edit_modal') {
        const escId = parseInt(parsed.view.private_metadata, 10);
        const text = parsed.view.state.values.reply_input.reply_text.value;
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        const conv = db.getConversation(esc.conversation_id);
        try {
          await sendApprovedReplyImpl({
            db, gmail, env, conv, esc, finalBody: text,
            decision: 'edit', slackClient: slack, log,
          });
        } catch (e) {
          log(`edit-send failed for escalation ${escId}: ${e.message}`);
        }
      }
    } catch (e) {
      log(`slack interactivity error: ${e.message}`);
    }
    res.status(200).send('');
  };
}

export async function startDaemon({ env = process.env, log = console.log } = {}) {
  const overrides = loadOverrides();
  const oauth = buildOAuthClient(env);
  const stored = loadStoredToken(TOKEN_PATH);
  if (!stored) throw new Error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  oauth.setCredentials(stored);
  // Persist refreshed tokens (review M12) — google-auth emits 'tokens' on every
  // refresh; without saving them a daemon restart falls back to the original
  // (possibly expired) token file. The refresh response may omit refresh_token,
  // so merge with what we already have.
  oauth.on('tokens', (tokens) => {
    try {
      saveToken(TOKEN_PATH, { ...loadStoredToken(TOKEN_PATH), ...tokens });
      log('Gmail tokens refreshed and persisted');
    } catch (e) {
      log(`failed to persist refreshed Gmail tokens: ${e.message}`);
    }
  });
  const gmail = makeGmail(oauth);
  const slack = makeSlackClient(env.SLACK_BOT_TOKEN);
  const db = openDb(DB_PATH);
  db.migrate();

  const gmailOps = {
    sendMessage: gmailSend,
    listInboundQuery,
    getMessage: gmailGet,
    fetchAttachment,
  };
  const slackOps = { postEscalation, postAlert, updateEscalationResolved };

  // Known-unmatched inbound (spam, newsletters, out-of-scope senders): alert
  // once and skip re-FETCHING within this process's lifetime (review H5/L5),
  // but keep the {threadId, from} match inputs so every tick re-attempts
  // matching (hardening finding 4) — a manually associated thread must be
  // ingested without a restart. In-memory only — a restart re-checks them
  // once (no schema for durable tracking; see review notes).
  const seenUnmatched = new Map();

  const tickOnce = makeExclusive(async () => {
    const now = getEffectiveNow({ env, overrides });
    let err = null;
    try {
      await runTick({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
        seenUnmatched,
      });
    } catch (e) {
      err = e.message;
      log(`tick error: ${e.message}`);
    }
    db.recordHeartbeat({ kind: 'tick', error: err });
  }, { log, name: 'tick' });

  const followupOnce = makeExclusive(async () => {
    const now = getEffectiveNow({ env, overrides });
    let err = null;
    try {
      await runDailyFollowup({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
      });
    } catch (e) {
      err = e.message;
      log(`followup error: ${e.message}`);
    }
    db.recordHeartbeat({ kind: 'followup', error: err });
  }, { log, name: 'followup' });

  cron.schedule(env.PILOT_TICK_CRON ?? '*/15 * * * *', tickOnce);
  cron.schedule(env.PILOT_FOLLOWUP_CRON ?? '0 9 * * *', followupOnce);
  log(`Cron scheduled: tick=${env.PILOT_TICK_CRON}, followup=${env.PILOT_FOLLOWUP_CRON}`);

  // Run one tick immediately on startup
  await tickOnce();

  // Slack interactivity webhook
  const app = express();
  app.post('/slack/interactivity', express.raw({ type: '*/*' }),
    createInteractivityHandler({ db, slack, gmail, env, log }));

  const port = parseInt(env.SLACK_INTERACTIVITY_PORT ?? '3000', 10);
  const server = app.listen(port, () => log(`Slack interactivity listener on :${port}`));
  // The Slack webhook is non-essential to the core tick loop. A bind failure
  // (EADDRINUSE etc.) must NOT take down cron ticking — without this handler
  // the unhandled 'error' event crashes the whole daemon, silently stopping
  // ingestion (this happened: :3000 was held by Docker). Log and carry on.
  server.on('error', (e) => {
    log(`Slack interactivity listener could not bind :${port} (${e.code}); continuing without it. Set SLACK_INTERACTIVITY_PORT to a free port to enable Slack approvals.`);
  });
}
