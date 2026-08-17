import express from 'express';
import cron from 'node-cron';
import { runTick, runDailyFollowup, runRefreshScan, followupCatchUpDue, followupHourFromCron, localDateStr } from './tick.js';
import { openDb, TICK_STALE_THRESHOLD_MIN } from './storage.js';
import { buildOAuthClient, loadStoredToken, saveToken, makeGmail, makeReloadingClient, sendMessage as gmailSend, listInboundQuery, getMessage as gmailGet, fetchAttachment, archiveThread } from './gmail.js';
// gmailSend stays imported because runTick's gmailOps below uses it.
import { makeSlackClient, verifySlackSignature, parseInteractivityPayload, postEscalation, postAlert, openEditModal, updateEscalationResolved } from './slack.js';
import { loadOverrides, getEffectiveNow, resolveVacation } from './pilot-config.js';
import { sendApprovedReply } from './send-reply.js';

const TOKEN_PATH = process.env.GMAIL_TOKEN_PATH ?? `${process.env.HOME}/.config/mediagraf/pilot-gmail-token.json`;
const DB_PATH = process.env.PILOT_DB_PATH ?? 'data/pilot.db';
const CONTRACTS_DIR = process.env.PILOT_CONTRACTS_DIR ?? 'data/contracts';

// Serialize escalation-mutating work across DIFFERENT tasks (hardening
// finding 5): tick and followup both supersede/create escalations, so they
// must never interleave — a per-function latch alone lets a long tick and the
// daily followup mutate the same rows concurrently. makeMutex returns a
// runner that queues functions strictly one after another; a rejected run
// must not poison the chain.
export function makeMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

// Wrap an async fn so overlapping invocations OF THE SAME TASK are skipped,
// not queued. node-cron does NOT serialize async callbacks; a tick that runs
// longer than the cron interval (LLM analysis of a big delivery) would
// otherwise overlap the next one and double-dispatch due sends (autopilot
// review C3). Pass a shared `mutex` (makeMutex) to additionally serialize
// against OTHER tasks: a followup fired while a tick is in flight then waits
// for the tick instead of racing it (skipping it would drop the daily run).
export function makeExclusive(fn, { log = null, name = 'task', mutex = null } = {}) {
  let running = false;
  const exec = mutex ?? ((f) => f());
  return async (...args) => {
    if (running) {
      log?.(`${name} skipped: previous run still in progress`);
      return { skipped: true };
    }
    running = true;
    try {
      return await exec(() => fn(...args));
    } finally {
      running = false;
    }
  };
}

// How long ingest may be down before Slack hears about it. Four missed
// 15-minute ticks — long enough that a single transient Gmail hiccup stays
// quiet, short enough that a dead OAuth token (which happens roughly weekly)
// is known within the hour instead of whenever someone opens the dashboard.
// Same number the dashboard health pill and the follow-up gate use.
export const TICK_OUTAGE_ALERT_MIN = TICK_STALE_THRESHOLD_MIN;

// 'YYYY-MM-DDTHH:MM:...' → 'YYYY-MM-DD HH:MM' for operator-facing text.
// A null timestamp is named, never rendered as a blank gap: the recovery
// message otherwise read "Avbrottet varade  → 2026-08-16 09:00", which looks
// like a truncation bug rather than "we have never had a successful tick".
function stamp(iso, fallback = 'okänd start') {
  const s = String(iso ?? '').slice(0, 16).replace('T', ' ');
  return s || fallback;
}

// Tell the operator in Slack when inbound mail stops being processed, and when
// it starts again. Called after every tick's heartbeat is recorded, with the
// health read BEFORE that heartbeat (so `last_success_at` still points at the
// last good tick, i.e. the start of the outage).
//
// Alert exactly ONCE per outage: the "already alerted" flag lives in the
// heartbeat row, so 15-minute ticks don't spam the channel and a daemon
// restarted mid-outage doesn't re-alert. Entirely best-effort — Slack being
// down must never break the tick loop, so everything is wrapped.
export async function reportTickHealth({ db, slackClient, slackOps, env, now = new Date(), error = null, healthBefore = null, log = null }) {
  const h = healthBefore ?? db.getTickHealth({ now, thresholdMin: TICK_OUTAGE_ALERT_MIN });
  if (!slackOps?.postAlert || !env?.SLACK_CHANNEL_ID) return null;
  try {
    if (error == null) {
      if (!h.outage_alerted_at) return null;
      // Clear the flag BEFORE posting, unconditionally: a flag left set by a
      // failed Slack call would silence the NEXT outage, which is far worse
      // than losing one recovery message.
      db.clearOutageAlert();
      await slackOps.postAlert(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        text: `✅ *Inkommande mejl bearbetas igen.* Avbrottet varade ${stamp(h.last_success_at)} → ${stamp(now.toISOString())}. Svar som kom in under tiden hämtas ikapp nu.`,
      });
      log?.(`INGEST RECOVERED after outage ${h.last_success_at} → ${now.toISOString()}`);
      return 'recovered';
    }
    if (!h.stale || h.outage_alerted_at) return null;
    const since = h.ever
      ? `sedan ${stamp(h.last_success_at)} (${h.stale_minutes} min)`
      : 'aldrig — ingen lyckad bearbetning sedan starten';
    await slackOps.postAlert(slackClient, {
      channel: env.SLACK_CHANNEL_ID,
      text: `🔴 *Inkommande mejl bearbetas inte* ${since}.\nSenaste fel: \`${error}\`\nSvar och avtal ligger ohämtade i inkorgen och statusarna i dashboarden är inaktuella. Vanligaste orsaken är att Gmail-behörigheten gått ut — logga ut och in igen i dashboarden.`,
    });
    // Mark only after a successful post, so a Slack failure retries next tick.
    db.markOutageAlerted();
    log?.(`INGEST OUTAGE alerted (${since})`);
    return 'alerted';
  } catch (e) {
    log?.(`tick health alert failed: ${e.message}`);
    return null;
  }
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

// A refused send must be VISIBLE in Slack. sendApprovedReply refuses some
// clicks BEFORE the atomic claim — STALE_INGEST (ingest is blind, so "vi har
// inte hört av er" may be false), STALE_ESCALATION (newer inbound), a bounce
// resend with no corrected address. The escalation stays open and its buttons
// stay live, which is correct — but the operator saw nothing at all: Approve
// looked like a dead button, and the edit modal simply closed as if the reply
// had gone out. The refusal is posted as a threaded reply under the escalation
// so the buttons keep working once the cause is fixed.
//
// Trigger is a state check, not a code list: after the failure the escalation
// row is re-read, and only a row still 'open' means nothing happened. A Gmail
// failure parks the row (send_failed) and sendApprovedReply already rewrote its
// Slack message, so it is not re-announced here.
async function reportRefusedSend({ db, slack, env, escId, kommunNamn, error, postAlertImpl, log }) {
  let current = null;
  try {
    current = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
  } catch { /* current stays null */ }
  // Fail closed: only a row VERIFIED still 'open' may be announced as "Inget
  // skickades". If the re-read failed, the send may in fact have gone out
  // (row 'sending'/'send_failed') — a missed notice is recoverable from the
  // dashboard queue; a false "nothing was sent" is a lie to the operator.
  if (!current || current.status !== 'open') return false;
  if (!postAlertImpl || !env?.SLACK_CHANNEL_ID) return false;
  try {
    await postAlertImpl(slack, {
      channel: env.SLACK_CHANNEL_ID,
      thread_ts: current?.slack_ts ?? null,
      text: `⛔️ *Inget skickades till ${kommunNamn ?? 'okänd kommun'}* (eskalering ${escId}).\n`
        + `${error.message}\n_Eskaleringen är kvar och knapparna fungerar — klicka igen när orsaken är åtgärdad._`,
    });
    return true;
  } catch (e) {
    log?.(`refusal notice failed for escalation ${escId}: ${e.message}`);
    return false;
  }
}

// Slack interactivity handler, extracted from startDaemon so the approve path
// is testable offline. Verifies the request signature, ACKS within Slack's
// 3-second interactivity deadline, and only then performs the work (hardening
// finding 9): a Gmail send can exceed 3s, and a late ack shows the operator a
// red Slack error / failed modal submit for a mail that actually went out.
// Acking early is crash-safe: the atomic escalation claim (open → sending)
// means a click lost to a crash that Slack retries — or any re-entered
// handler — fails the claim and no-ops, which is exactly what the
// ack-after-work ordering (review L1) used to protect against before the
// claim existed. The buttons are healed afterwards via chat.update.
export function createInteractivityHandler({ db, slack, gmail, env, log = console.log, sendApprovedReplyImpl = sendApprovedReply, openEditModalImpl = openEditModal, postAlertImpl = postAlert }) {
  return async (req, res) => {
    const body = req.body.toString('utf8');
    const ts = req.header('X-Slack-Request-Timestamp');
    const sig = req.header('X-Slack-Signature');
    if (!verifySlackSignature({ signingSecret: env.SLACK_SIGNING_SECRET, timestamp: ts, body, signature: sig })) {
      return res.status(401).send('bad signature');
    }

    // Ack FIRST — everything after this line may legitimately take >3s.
    res.status(200).send('');

    try {
      const parsed = parseInteractivityPayload(body);
      if (parsed.type === 'block_actions') {
        const escId = parseInt(parsed.escalation_id, 10);
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        if (!esc) return;
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
              await reportRefusedSend({
                db, slack, env, escId, kommunNamn: conv?.kommun_namn, error: e, postAlertImpl, log,
              });
            }
          }
        } else if (parsed.action_id === 'esc_edit') {
          await openEditModalImpl(slack, { trigger_id: parsed.trigger_id, escalation_id: escId, draft_reply: esc.draft_body });
        } else if (parsed.action_id === 'esc_skip') {
          // Atomic + conditional (hardening finding 7): `esc` was read above
          // and may be stale — a racing approve can have resolved the row in
          // between. Only resolve WHERE status='open'; on a lost race, no-op
          // and heal the buttons to the CURRENT status (never write a false
          // skip decision over resolved_send).
          if (db.resolveEscalationIfOpen(escId, { status: 'resolved_skip' })) {
            db.recordDecision({
              escalation_id: escId, conversation_id: conv.id,
              conversation_state: esc.previous_state ?? conv.state,
              classifier_class: esc.classifier_class ?? null, classifier_confidence: esc.classifier_confidence ?? null,
              draft_template: esc.draft_template, draft_body: esc.draft_body,
              decision: 'skip', final_body: null,
            });
            await stripButtons(slack, env, esc, conv.kommun_namn, 'resolved_skip', log);
          } else {
            const current = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
            await stripButtons(slack, env, current ?? esc, conv.kommun_namn, current?.status ?? esc.status, log);
            log(`skip ignored: escalation ${escId} already ${current?.status ?? 'missing'}`);
          }
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
          // The modal has already closed by the time this runs (Slack closes it
          // on a 200 ack), so without this the operator's edited reply simply
          // vanished — looking exactly like a successful send.
          await reportRefusedSend({
            db, slack, env, escId, kommunNamn: conv?.kommun_namn, error: e, postAlertImpl, log,
          });
        }
      }
    } catch (e) {
      log(`slack interactivity error: ${e.message}`);
    }
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
  // Pick up a token rewritten by a dashboard sign-in without a restart: the
  // credentials are swapped on the SAME oauth client, so the 'tokens' listener
  // above stays attached and `gmail` keeps working.
  const currentToken = makeReloadingClient({
    tokenPath: TOKEN_PATH,
    build: () => loadStoredToken(TOKEN_PATH),
  });
  // Priming records the token already on the client, so an unchanged file
  // returns the identical cached object and no credentials are re-applied.
  let applied = currentToken();
  const reloadTokenIfChanged = () => {
    const fresh = currentToken();
    if (!fresh || fresh === applied) return;
    applied = fresh;
    oauth.setCredentials(fresh);
    log('Gmail token file changed — reloaded credentials');
  };

  const gmail = makeGmail(oauth);
  const slack = makeSlackClient(env.SLACK_BOT_TOKEN);
  const db = openDb(DB_PATH);
  db.migrate();

  const gmailOps = {
    sendMessage: gmailSend,
    listInboundQuery,
    getMessage: gmailGet,
    fetchAttachment,
    // Injected explicitly (rather than relying on sendApprovedReply's default
    // import) so the auto-send call site in tick.js passes a real function.
    archiveThread,
  };
  const slackOps = { postEscalation, postAlert, updateEscalationResolved };

  // Archive-on-ingest (2026-07-20 design §2): default ON. When explicitly set
  // to 'off'/'false'/'0'/'no', ingest never archives and we revert to
  // send-only archiving. Read once here and threaded into runTick deps.
  const archiveOnIngest = !['off', 'false', '0', 'no'].includes(
    String(env.PILOT_ARCHIVE_ON_INGEST ?? '').trim().toLowerCase()
  );

  // Known-unmatched inbound (spam, newsletters, out-of-scope senders): alert
  // once and skip re-FETCHING within this process's lifetime (review H5/L5),
  // but keep the {threadId, from} match inputs so every tick re-attempts
  // matching (hardening finding 4) — a manually associated thread must be
  // ingested without a restart. In-memory only — a restart re-checks them
  // once (no schema for durable tracking; see review notes).
  const seenUnmatched = new Map();

  // One mutex for ALL escalation-mutating loops (finding 5): tick and
  // followup must never run concurrently or they can both supersede/create
  // escalations for the same conversation.
  const escalationMutex = makeMutex();

  const tickOnce = makeExclusive(async () => {
    reloadTokenIfChanged();
    const now = getEffectiveNow({ env, overrides });
    let err = null;
    try {
      await runTick({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
        seenUnmatched,
        refreshAllowlist: overrides.refresh_pilot_kommun_kods ?? [],
        archiveOnIngest,
      });
    } catch (e) {
      err = e.message;
      log(`tick error: ${e.message}`);
    }
    // Read health BEFORE stamping this tick — on the recovery path the pre-tick
    // last_success_at is where the outage started.
    const healthBefore = db.getTickHealth({ now, thresholdMin: TICK_OUTAGE_ALERT_MIN });
    db.recordHeartbeat({ kind: 'tick', error: err });
    await reportTickHealth({
      db, slackClient: slack, slackOps, env, now, error: err, healthBefore, log,
    });
    return { ok: err == null };
  }, { log, name: 'tick', mutex: escalationMutex });

  const followupOnce = makeExclusive(async () => {
    const now = getEffectiveNow({ env, overrides });
    let err = null;
    try {
      await runDailyFollowup({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
        vacationConfig: resolveVacation(overrides),
        overridesPath: env.PILOT_OVERRIDES_PATH ?? 'data/pilot-overrides.json',
      });
      // Perpetual contract refresh (2026-07-09 design §3.3) — same daily
      // cadence, same escalation mutex, so refresh and follow-up drafts can
      // never race to supersede each other for the same conversation.
      await runRefreshScan({
        db, gmailClient: { gmail }, gmailOps,
        slackClient: slack, slackOps,
        env, contractsDir: CONTRACTS_DIR, now, log,
        refreshAllowlist: overrides.refresh_pilot_kommun_kods ?? [],
      });
    } catch (e) {
      err = e.message;
      log(`followup error: ${e.message}`);
    }
    db.recordHeartbeat({ kind: 'followup', error: err });
  }, { log, name: 'followup', mutex: escalationMutex });

  const followupCron = env.PILOT_FOLLOWUP_CRON ?? '0 9 * * *';
  const followupHour = followupHourFromCron(followupCron);

  // The daily follow-up fires ONCE, at 09:00. If ingest was blind at that
  // minute the run bails out (correctly — it must not assert silence it has not
  // verified) and the whole day's nudges/closes/nudge-cap escalations are lost.
  // So after every SUCCESSFUL tick past the cron hour, re-invoke it if today's
  // run never completed. Deliberately OUTSIDE the mutex-wrapped tick body:
  // followupOnce takes the same mutex, and calling it from inside would
  // deadlock. The gates inside runDailyFollowup remain authoritative — a still
  // blind daemon just skips again.
  const tickThenFollowupCatchUp = async () => {
    const res = await tickOnce();
    if (!res?.ok) return res;
    const now = getEffectiveNow({ env, overrides });
    if (!followupCatchUpDue({
      now, completedDate: db.getFollowupCompletedDate() ?? null, hour: followupHour,
    })) return res;
    log(`FOLLOWUP catch-up: no completed daily run for ${localDateStr(now)} — running it now after a healthy tick`);
    await followupOnce();
    return res;
  };

  cron.schedule(env.PILOT_TICK_CRON ?? '*/15 * * * *', tickThenFollowupCatchUp);
  cron.schedule(followupCron, followupOnce);
  log(`Cron scheduled: tick=${env.PILOT_TICK_CRON}, followup=${followupCron}`);

  // Run one tick immediately on startup
  await tickThenFollowupCatchUp();

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
