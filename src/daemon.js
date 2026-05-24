import express from 'express';
import cron from 'node-cron';
import { runTick, runDailyFollowup } from './tick.js';
import { openDb } from './storage.js';
import { buildOAuthClient, loadStoredToken, makeGmail, sendMessage as gmailSend, listInboundQuery, getMessage as gmailGet, fetchAttachment } from './gmail.js';
// gmailSend stays imported because runTick's gmailOps below uses it.
import { makeSlackClient, verifySlackSignature, parseInteractivityPayload, postEscalation, openEditModal } from './slack.js';
import { loadOverrides, getEffectiveNow } from './pilot-config.js';
import { sendApprovedReply } from './send-reply.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

export async function startDaemon({ env = process.env, log = console.log } = {}) {
  const overrides = loadOverrides();
  const oauth = buildOAuthClient(env);
  const stored = loadStoredToken(TOKEN_PATH);
  if (!stored) throw new Error(`No Gmail token at ${TOKEN_PATH}. Run \`npm run pilot-auth\` first.`);
  oauth.setCredentials(stored);
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
  const slackOps = { postEscalation };

  async function tickOnce() {
    const now = getEffectiveNow({ env, overrides });
    try {
      await runTick({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
      });
    } catch (e) {
      log(`tick error: ${e.message}`);
    }
  }

  async function followupOnce() {
    const now = getEffectiveNow({ env, overrides });
    try {
      await runDailyFollowup({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
      });
    } catch (e) {
      log(`followup error: ${e.message}`);
    }
  }

  cron.schedule(env.PILOT_TICK_CRON ?? '*/15 * * * *', tickOnce);
  cron.schedule(env.PILOT_FOLLOWUP_CRON ?? '0 9 * * *', followupOnce);
  log(`Cron scheduled: tick=${env.PILOT_TICK_CRON}, followup=${env.PILOT_FOLLOWUP_CRON}`);

  // Run one tick immediately on startup
  await tickOnce();

  // Slack interactivity webhook
  const app = express();
  app.post('/slack/interactivity', express.raw({ type: '*/*' }), async (req, res) => {
    const body = req.body.toString('utf8');
    const ts = req.header('X-Slack-Request-Timestamp');
    const sig = req.header('X-Slack-Signature');
    if (!verifySlackSignature({ signingSecret: env.SLACK_SIGNING_SECRET, timestamp: ts, body, signature: sig })) {
      return res.status(401).send('bad signature');
    }
    res.status(200).send(''); // ack immediately

    try {
      const parsed = parseInteractivityPayload(body);
      if (parsed.type === 'block_actions') {
        const escId = parseInt(parsed.escalation_id, 10);
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        if (!esc) return;
        const conv = db.getConversation(esc.conversation_id);
        if (parsed.action_id === 'esc_approve') {
          await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: esc.draft_body, decision: 'approve_unmodified' });
        } else if (parsed.action_id === 'esc_edit') {
          await openEditModal(slack, { trigger_id: parsed.trigger_id, escalation_id: escId, draft_reply: esc.draft_body });
        } else if (parsed.action_id === 'esc_skip') {
          db.resolveEscalation(escId, { status: 'resolved_skip' });
          db.recordDecision({
            escalation_id: escId, conversation_id: conv.id, conversation_state: conv.state,
            classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
            draft_template: esc.draft_template, draft_body: esc.draft_body,
            decision: 'skip', final_body: null,
          });
        }
      } else if (parsed.type === 'view_submission' && parsed.view?.callback_id === 'esc_edit_modal') {
        const escId = parseInt(parsed.view.private_metadata, 10);
        const text = parsed.view.state.values.reply_input.reply_text.value;
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        const conv = db.getConversation(esc.conversation_id);
        await sendApprovedReply({ db, gmail, env, conv, esc, finalBody: text, decision: 'edit' });
      }
    } catch (e) {
      log(`slack interactivity error: ${e.message}`);
    }
  });

  const port = parseInt(env.SLACK_INTERACTIVITY_PORT ?? '3000', 10);
  app.listen(port, () => log(`Slack interactivity listener on :${port}`));
}
