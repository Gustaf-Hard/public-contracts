import { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING, T_UPDATE, T_DELAY_ACK, T_CROSSCHECK, computeReceivedMissing, chooseDeliveryReply } from './templates.js';
import { computeKommunReview } from './contract-lifecycle.js';
import { matchWatchlist } from './watchlist.js';
import { crosscheckLabels } from './vendor-kb.js';
import { buildCoverageFacts } from './coverage.js';
import { classify, isCloserText } from './classifier.js';
import { inferThreadStatus } from './threads.js';
import { nextActionForClassification, staleAction, nudgeJitterDays, isLazyConversation, isAutoSendableDelayAck } from './conversation.js';
import { loadAutoSendTemplates } from './pilot-config.js';
import { sendApprovedReply } from './send-reply.js';
import { parseInboundMessage, sameEmailDomain, archiveThread } from './gmail.js';
import { buildEscalationBlocks } from './slack.js';
import { saveAttachment, extractFilesFromZip, dedupeFilenames, isTrivialImage } from './attachments.js';
import { extractSignature } from './extract-signature.js';
import { analyseMessage, analysisToLegacyClassification, addDaysIso } from './analyse-message.js';
import { analysePendingContracts } from './analyse-contract.js';
import { isInVacation, vacationDaysBetween } from './vacation.js';
import { isBounce, failedRecipient } from './bounce.js';

const TEMPLATES = { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING, T_UPDATE, T_DELAY_ACK, T_CROSSCHECK };

function fromHeader(env) {
  return `${env.GMAIL_FROM_NAME} <${env.GMAIL_USER_EMAIL}>`;
}

function tplCtx(conv, env, extra = {}) {
  return {
    kommun_namn: conv.kommun_namn,
    role: conv.role,
    from_email: env.GMAIL_USER_EMAIL,
    from_name: env.GMAIL_FROM_NAME,
    thread_subject: extra.thread_subject ?? 'Begäran om allmänna handlingar – avtal för digitala verktyg',
    // Absolute date of our original request. Outbound prose must never state
    // elapsed days: the operator may send the draft long after it was written.
    sent_date: extra.sent_date ?? null,
    received: extra.received ?? [],
    missing: extra.missing ?? [],
    // Coverage facts (src/coverage.js) grounding T_REQUEST_MISSING.
    facts: extra.facts ?? null,
    // Perpetual-refresh (T_UPDATE) context, forwarded when present.
    arendenummer: extra.arendenummer ?? conv.arendenummer ?? null,
    review_contracts: extra.review_contracts ?? [],
    // Final-checklist (T_CROSSCHECK) vendor list.
    crosscheck_vendors: extra.crosscheck_vendors ?? [],
    // Delay/OOO acknowledgement (T_DELAY_ACK) context.
    delay_date: extra.delay_date ?? null,
  };
}

// Two-phase T-INITIAL dispatch (autopilot review C2/C3): atomically claim the
// row INITIAL → SENDING before the Gmail call, finalize to SENT after. A crash
// between Gmail accepting and the finalize leaves a SENDING row that is never
// auto-resent — recoverStuckSends escalates it to a human instead. A racing
// tick/process loses the claim and does nothing.
async function dispatchInitial(conv, deps) {
  const { db, gmailClient, gmailOps, env, now, log } = deps;
  if (!db.claimConversationForInitialSend(conv.id)) {
    log?.(`SKIP T-INITIAL → ${conv.kommun_namn}/${conv.role}: claimed elsewhere`);
    return;
  }
  const msg = T_INITIAL(tplCtx(conv, env));
  let sent;
  try {
    sent = await gmailOps.sendMessage(gmailClient.gmail, {
      from: fromHeader(env), to: conv.contact_email, subject: msg.subject, body: msg.body,
    });
  } catch (e) {
    // Ambiguous outcome (Gmail may have accepted). Park as NEEDS_HUMAN, never
    // auto-retry. previous_state 'SENT' so resolving the escalation lands the
    // case where staleness rules watch it, instead of re-queuing a canned send.
    db.updateConversationState(conv.id, 'NEEDS_HUMAN', {});
    await escalateWithDraft({
      conv: db.getConversation(conv.id), parsedInbound: null, classification: null,
      previousState: 'SENT', draftTemplate: 'free_form',
      reason: `T-INITIAL send failed: ${e.message} — verify in Gmail Sent before retrying`,
      deps,
    });
    log?.(`T-INITIAL send FAILED → ${conv.kommun_namn}/${conv.role}: ${e.message}`);
    return;
  }
  db.updateConversationState(conv.id, 'SENT', {
    gmail_thread_id: sent.threadId,
    last_outbound_at: now.toISOString(),
  });
  db.recordMessage({
    conversation_id: conv.id, gmail_message_id: sent.id, direction: 'outbound',
    from_email: env.GMAIL_USER_EMAIL, to_email: conv.contact_email,
    subject: msg.subject, body_text: msg.body,
    classification: null, classification_confidence: null,
    received_at: now.toISOString(), attachment_count: 0,
  });
  log?.(`SENT T-INITIAL → ${conv.kommun_namn}/${conv.role}`);
}

// SQLite datetime('now') → 'YYYY-MM-DD HH:MM:SS' (UTC, no zone). Normalize.
function parseDbTime(s) {
  if (!s) return null;
  const t = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(t.getTime()) ? null : t;
}

// In-flight rows older than this are considered orphaned by a crash. Long
// enough that a legitimately slow send from the *other* process (dashboard vs
// daemon share the DB) is never mistaken for a crash.
const STUCK_SEND_MIN = 15;

// Recover from crashes mid-send (autopilot review C2). Two shapes:
//  - conversations stuck in SENDING: the T-INITIAL claim happened but the
//    finalize never did → escalate to a human; never auto-resend.
//  - escalations stuck in 'sending': an approve claimed the row but the
//    finalize never did → park as 'send_unconfirmed' + Slack alert; never
//    auto-retry, never reopen.
async function recoverStuckSends(deps) {
  const { db, slackClient, slackOps, env, now, log } = deps;
  const cutoff = now.getTime() - STUCK_SEND_MIN * 60 * 1000;

  for (const conv of db.listConversationsByState('SENDING')) {
    const claimedAt = parseDbTime(conv.state_changed_at);
    if (claimedAt && claimedAt.getTime() > cutoff) continue; // possibly in flight elsewhere
    db.updateConversationState(conv.id, 'NEEDS_HUMAN', {});
    await escalateWithDraft({
      conv: db.getConversation(conv.id), parsedInbound: null, classification: null,
      previousState: 'SENT', draftTemplate: 'free_form',
      reason: 'T-INITIAL send unconfirmed (process died mid-send?) — check Gmail Sent before retrying',
      deps,
    });
    log?.(`RECOVERED stuck SENDING → NEEDS_HUMAN: ${conv.kommun_namn}/${conv.role}`);
  }

  for (const esc of db.listEscalationsByStatus('sending')) {
    const claimedAt = parseDbTime(esc.resolved_at); // claim stamp while status='sending'
    if (claimedAt && claimedAt.getTime() > cutoff) continue;
    db.resolveEscalation(esc.id, {
      status: 'send_unconfirmed',
      resolved_text: 'claimed for sending but never finalized (crash mid-send?)',
    });
    const conv = db.getConversation(esc.conversation_id);
    if (slackOps?.postAlert && env.SLACK_CHANNEL_ID) {
      try {
        await slackOps.postAlert(slackClient, {
          channel: env.SLACK_CHANNEL_ID,
          text: `⚠️ Eskalering ${esc.id} (${conv?.kommun_namn ?? '?'}) claimades för sändning men slutfördes aldrig. Kontrollera Skickat i Gmail innan du gör om något — svaret kan redan ha gått iväg.`,
        });
      } catch (e) {
        log?.(`postAlert failed for stuck escalation ${esc.id}: ${e.message}`);
      }
    }
    log?.(`RECOVERED stuck sending escalation ${esc.id} → send_unconfirmed`);
  }
}

async function escalateWithDraft({ conv, parsedInbound, messageId = null, classification, previousState, draftTemplate, llmDraft, reason, templateCtx = {}, watchlistVendors = [], draftSubject = null, draftBody = null, deps }) {
  const { db, slackClient, slackOps, env, log } = deps;

  // Never create a draft next to an unresolved send (hardening findings 2/3).
  // 'sending' means another surface is mid-Gmail-call for this conversation —
  // superseding or racing it invites a double message, so defer entirely; the
  // next tick re-evaluates (recoverStuckSends handles it if it was a crash).
  // 'send_failed'/'send_unconfirmed' mean Gmail MAY have accepted an earlier
  // reply — until a human verifies in Sent, a fresh approvable draft is the
  // exact double-message the parked status exists to prevent.
  const unresolved = db.listActiveEscalationsForConversation(conv.id)
    .filter((e) => e.status !== 'open');
  if (unresolved.length > 0) {
    log?.(`DEFER escalation for ${conv.kommun_namn}/${conv.role}: escalation ${unresolved[0].id} is ${unresolved[0].status}`);
    return null;
  }

  // "At most one open next-action per conversation. Always." (2026-06-23 spec,
  // review H1). A fresher draft supersedes any open escalation: its status
  // flips to 'superseded' (so a stale approve fails the atomic claim) and its
  // Slack buttons are stripped best-effort.
  for (const existing of db.listOpenEscalationsForConversation(conv.id)) {
    db.resolveEscalation(existing.id, {
      status: 'superseded',
      resolved_text: 'superseded by a newer escalation for this conversation',
    });
    if (existing.slack_ts && slackOps?.updateEscalationResolved && env.SLACK_CHANNEL_ID) {
      try {
        await slackOps.updateEscalationResolved(slackClient, {
          channel: env.SLACK_CHANNEL_ID, ts: existing.slack_ts,
          kommun_namn: conv.kommun_namn, status: 'superseded',
        });
      } catch (e) {
        log?.(`chat.update failed for superseded escalation ${existing.id}: ${e.message}`);
      }
    }
    log?.(`SUPERSEDED escalation ${existing.id} for ${conv.kommun_namn}/${conv.role}`);
  }

  let subject = '(no subject)';
  let body = '';
  if (draftSubject != null || draftBody != null) {
    // Explicit draft (e.g. a bounce resend carries the ORIGINAL T-INITIAL
    // subject/body verbatim so the operator sees exactly what will be resent).
    // No template/LLM path applies.
    subject = draftSubject ?? subject;
    body = draftBody ?? body;
  } else if (llmDraft) {
    const baseSubject = parsedInbound?.subject?.replace(/^Re: /, '') ?? 'Begäran om allmänna handlingar';
    subject = `Re: ${baseSubject}`;
    body = llmDraft.body;
  } else if (draftTemplate === 'free_form') {
    const baseSubject = parsedInbound?.subject?.replace(/^Re: /, '') ?? 'Begäran om allmänna handlingar';
    subject = `Re: ${baseSubject}`;
    body = '(ingen draft — skriv själv via Edit)';
  } else if (TEMPLATES[draftTemplate]) {
    const ctx = tplCtx(conv, env, {
      thread_subject: parsedInbound?.subject?.replace(/^Re: /, '') ?? undefined,
      sent_date: deps.sentDate ?? null,
      ...templateCtx,
    });
    const rendered = TEMPLATES[draftTemplate](ctx);
    subject = rendered.subject;
    body = rendered.body;
  }

  const escId = db.recordEscalation({
    conversation_id: conv.id,
    message_id: messageId,
    reason,
    draft_template: draftTemplate,
    draft_subject: subject,
    draft_body: body,
    classifier_class: classification?.class ?? null,
    classifier_confidence: classification?.confidence ?? null,
    previous_state: previousState ?? null,
    watchlist_vendors: watchlistVendors.length ? JSON.stringify(watchlistVendors) : null,
  });

  if (slackOps && env.SLACK_CHANNEL_ID) {
    const blocks = buildEscalationBlocks({
      escalation_id: escId,
      kommun_namn: conv.kommun_namn,
      from_email: parsedInbound?.from ?? '(no inbound — proactive draft)',
      reply_text: parsedInbound?.body ?? '(no inbound)',
      draft_reply: `Subject: ${subject}\n\n${body}`,
      gmail_thread_id: conv.gmail_thread_id ?? '(no thread)',
      watchlist_vendors: watchlistVendors,
    });
    // The ONLY unguarded Slack call used to live here — and it sits AFTER
    // recordEscalation, so a Slack outage threw with the row already written:
    // the escalation existed, open, with no slack_ts and no buttons, while the
    // caller's alert told the operator to "svara manuellt" — which
    // hasActiveEscalation then blocked. The draft is safe and approvable in the
    // dashboard, so a failed post is logged, not thrown; retryUnpostedEscalations
    // re-posts it on a later tick and the buttons come back by themselves.
    try {
      const posted = await slackOps.postEscalation(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        blocks,
        fallbackText: `Eskalering: ${conv.kommun_namn} (${draftTemplate})`,
      });
      if (posted?.ts) {
        db.raw.prepare('UPDATE escalations SET slack_ts = ? WHERE id = ?').run(posted.ts, escId);
      }
    } catch (e) {
      log?.(`postEscalation failed for escalation ${escId} (${conv.kommun_namn}): ${e.message}`
        + ' — draft is saved and approvable in the dashboard; Slack buttons will be retried next tick');
    }
  }
  log?.(`ESCALATED (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}: ${reason}`);
  return escId;
}

// Fetch window derived from the last successful tick (autopilot review H3, per
// the 2026-06-23 spec): the window must always cover the whole outage, with a
// one-day margin, and never shrink below the 30-day baseline. A hard-coded
// window silently and permanently loses inbound after an outage longer than it.
export function deriveFetchWindowDays(lastSuccessAt, now) {
  const BASELINE_DAYS = 30;
  const last = lastSuccessAt ? parseDbTime(lastSuccessAt) : null;
  if (!last) return BASELINE_DAYS;
  const gapDays = Math.ceil((now.getTime() - last.getTime()) / 86400000) + 1;
  return Math.max(BASELINE_DAYS, gapDays);
}

// Pure two-pass inbound matching (autopilot review H2). Thread matches win
// across ALL conversations first; only messages still unclaimed fall back to
// sender-domain matching. A domain match with two or more candidate
// conversations (central + utbildning on the same kommun share a domain) is
// AMBIGUOUS — reported for human association instead of first-conv-wins,
// which would permanently mis-file the message.
//
//   messages: [{ id, threadId, from }]
//   convs:    [{ id, contact_email, thread_ids: [gmail_thread_id, ...] }]
// Returns { matched: [{messageId, convId, via}], ambiguous: [{messageId, convIds}], unmatched: [messageId] }
export function matchInbound(messages, convs) {
  const matched = [];
  const claimed = new Set();

  for (const m of messages) {
    const hits = convs.filter((c) => c.thread_ids.includes(m.threadId));
    if (hits.length > 0) {
      // A Gmail thread belonging to two conversations is theoretically possible
      // but means an operator already associated it manually — lowest id wins,
      // deterministically.
      matched.push({ messageId: m.id, convId: hits[0].id, via: 'thread' });
      claimed.add(m.id);
    }
  }

  const ambiguous = [];
  const unmatched = [];
  for (const m of messages) {
    if (claimed.has(m.id)) continue;
    const hits = convs.filter((c) => sameEmailDomain(m.from, c.contact_email));
    if (hits.length === 1) {
      matched.push({ messageId: m.id, convId: hits[0].id, via: 'domain' });
    } else if (hits.length > 1) {
      ambiguous.push({ messageId: m.id, convIds: hits.map((c) => c.id) });
    } else {
      unmatched.push(m.id);
    }
  }
  return { matched, ambiguous, unmatched };
}

// Best-effort archive of an ingested message's Gmail thread (2026-07-20
// archive-on-ingest design). Called STRICTLY AFTER the per-message ingest
// transaction has committed — a crash mid-ingest must never archive an
// unrecorded message, the same ordering guarantee the send path uses
// (archiveThreadBestEffort in send-reply.js). Mirrors that best-effort shape:
// an archive failure is logged and swallowed, never blocks or fails ingest.
// Gated by deps.archiveOnIngest (default on) and only ever called for messages
// that matched a tracked conversation — unmatched/ambiguous mail is never
// archived (it stays in the inbox for the Slack-digest / human attention).
async function archiveIngestedThreadBestEffort({ threadId, deps }) {
  if (!threadId) return;
  if (deps.archiveOnIngest === false) return;
  const archiveThreadImpl = deps.archiveThreadImpl ?? archiveThread;
  try {
    await archiveThreadImpl(deps.gmailClient.gmail, threadId);
    deps.log?.(`ARCHIVED ingested thread ${threadId}`);
  } catch (e) {
    deps.log?.(`gmail archive failed for thread ${threadId}: ${e.message}`);
  }
}

// Ingest one matched inbound message. IO ordering is deliberate (review H4):
//   1. LLM analysis + classification (no DB writes yet)
//   2. attachment fetch + zip expansion + file writes (no DB writes yet)
//   3. ONE synchronous SQLite transaction for every DB write of this message
// A crash or error anywhere before (3) leaves the message unrecorded — it is
// simply retried next tick. A crash after (3) has everything (message,
// attachments, thread, FSM state) committed together. The heavy per-PDF
// contract analysis and the escalation dispatch happen AFTER ingest (M6).
async function ingestMessage({ conv, item, deps }) {
  const { db, gmailClient, gmailOps, env, now } = deps;
  const { full, parsed } = item;
  // Gmail's internalDate is the delivery time; processing time would corrupt
  // follow-up math and thread ordering for post-outage backlogs (review M2).
  const receivedAt = parsed.internal_date ?? now.toISOString();

  // Try LLM analysis first; fall back to the regex classifier on null.
  // Both produce a legacy-shaped classification object the FSM can consume.
  const lastOutboundMs = conv.last_outbound_at ? new Date(conv.last_outbound_at).getTime() : null;
  const daysSinceLastOutbound = lastOutboundMs != null
    ? Math.floor((now.getTime() - lastOutboundMs) / (1000 * 60 * 60 * 24))
    : null;
  const analysis = await analyseMessage(parsed.body, {
    kommun_namn: conv.kommun_namn,
    role: conv.role,
    conversation_state: conv.state,
    days_since_last_outbound: daysSinceLastOutbound,
    today_iso: now.toISOString().slice(0, 10),
  }, { env });
  const classification = analysis
    ? analysisToLegacyClassification(analysis)
    : classify({
        from: parsed.from, subject: parsed.subject, body: parsed.body,
        attachment_count: parsed.attachments.length,
      });

  // "This was everything" comes from the LLM's own judgment of the
  // registrator's text; the regex fallback runs only on the UNQUOTED body so
  // our own quoted receipt ("Är detta samtliga avtal…?") can never close a
  // case (review M9).
  const isCloser = analysis ? analysis.is_final_delivery === true : isCloserText(parsed.body);
  const transition = nextActionForClassification(conv.state, classification.class, {
    receipt_sent: !!conv.receipt_sent, is_closer: isCloser,
  });

  const sig = extractSignature(parsed.body);

  // Fetch and expand attachments BEFORE any DB write. EVERY attachment is
  // stored regardless of MIME type — Boden delivered a sammanställning as
  // .xlsx and the old PDF/zip-only filter silently discarded it. Only
  // contract ANALYSIS stays PDF-gated (listPendingContractAttachments).
  // A zip expands into EVERY file it holds, not just its PDFs: the bundles
  // kommuner send mix contracts with the sammanställning that lists them, and
  // keeping only the PDFs discarded the rest along with the archive, so those
  // files survived nowhere. An unreadable (or empty) archive is stored as-is
  // so its bytes are never lost. The single allowed skip is an image known to
  // be tiny (a signature logo — see isTrivialImage), and ONLY at the top level,
  // where the gap stays visible: attachment_count records what the mail carried,
  // so the dashboard can show "1 bilaga hoppades över". Inside a zip the same
  // skip is pure data loss — the expanded archive is not stored, the zip counts
  // as ONE attachment, and a skipped 8 kB scanned page would then exist nowhere
  // and be invisible. Signature logos rarely travel inside archives; storing a
  // few is harmless, destroying a scan is not. So: never skip an inner entry.
  const entries = [];
  for (const att of parsed.attachments) {
    const fn = att.filename?.toLowerCase() ?? '';
    const isZip = att.mime_type === 'application/zip'
      || att.mime_type === 'application/x-zip-compressed' || fn.endsWith('.zip');
    if (isTrivialImage(att)) continue;
    const buf = await gmailOps.fetchAttachment(gmailClient.gmail, item.id, att.attachment_id);
    if (isZip) {
      const inner = extractFilesFromZip(buf);
      if (inner.length > 0) {
        for (const e of inner) {
          entries.push({ filename: e.filename, data: e.data, mime_type: e.mime_type });
        }
      } else {
        entries.push({ filename: att.filename, data: buf, mime_type: att.mime_type });
      }
    } else {
      entries.push({ filename: att.filename, data: buf, mime_type: att.mime_type });
    }
  }
  // Same-named files within one message must not overwrite each other (M11).
  const savedEntries = [];
  for (const entry of dedupeFilenames(entries)) {
    const saved = await saveAttachment(entry.data, {
      kommun_kod: conv.kommun_kod, kommun_namn: conv.kommun_namn, role: conv.role,
      received_at: receivedAt, from_email: parsed.from, from_name: null,
      gmail_message_id: item.id, gmail_thread_id: parsed.gmail_thread_id,
      subject: parsed.subject, original_filename: entry.filename, mime_type: entry.mime_type,
    }, { baseDir: deps.contractsDir });
    savedEntries.push({ entry, saved });
  }

  const previousState = conv.state;
  // Every DB write for this message commits atomically.
  const { thread, messageId } = db.transaction(() => {
    const thread = db.upsertThread({
      conversation_id: conv.id,
      gmail_thread_id: full.threadId,
      counterparty_email: parsed.from,
      counterparty_name: parsed.from,
      last_inbound_at: receivedAt,
    });
    const messageId = db.recordMessage({
      conversation_id: conv.id, gmail_message_id: item.id, direction: 'inbound',
      from_email: parsed.from, to_email: parsed.to,
      subject: parsed.subject, body_text: parsed.body,
      classification: classification.class, classification_confidence: classification.confidence,
      received_at: receivedAt, attachment_count: parsed.attachments.length,
      signature_extracted: sig,
      analysis_json: analysis ?? null,
      gmail_thread_id: full.threadId,
      thread_id: thread.id,
    });

    // Recompute the thread's auto status from all its inbound messages.
    // Never clobber a manual override.
    const threadRow = db.getThreadById(thread.id);
    if (threadRow?.status_source === 'auto') {
      const inbound = db.listMessages(conv.id)
        .filter((mm) => mm.direction === 'inbound' && mm.thread_id === thread.id)
        .map((mm) => ({ classification: mm.classification, attachment_count: mm.attachment_count }));
      db.setThreadStatus(thread.id, inferThreadStatus(inbound), 'auto');
    }

    for (const { entry, saved } of savedEntries) {
      db.recordAttachment({
        message_id: messageId, filename: entry.filename,
        saved_path: saved.saved_path, mime_type: entry.mime_type, size_bytes: saved.size_bytes,
      });
    }

    // State transition is bookkeeping — happens automatically. Outbound is gated.
    const patch = {};
    if (classification.extracted?.arendenummer) patch.arendenummer = classification.extracted.arendenummer;
    // When the kommun says "we'll get back to you by date X", honor it.
    if (analysis?.follow_up_at) patch.follow_up_at = analysis.follow_up_at;
    // Offline path: an autoresponder (auto_reply) has no LLM follow_up_at, so
    // derive it from the classifier's extracted return date (+3 days grace),
    // or a 14-day default from receipt when no date was stated (design §2).
    // Never escalates and never replies — see nextActionForClassification.
    else if (classification.class === 'auto_reply') {
      const ret = classification.extracted?.return_date ?? null;
      patch.follow_up_at = (ret && addDaysIso(ret, 3))
        || addDaysIso(receivedAt.slice(0, 10), 14);
    }
    // A SOFT internal forward (2026-07-20 soft-handoff design §5): wait silently,
    // never escalate/reply. The follow-up is max(today + 21d floor, the stated
    // response date + 3 days grace). The 21-day floor is ENFORCED HERE in code,
    // never trusted to the LLM: an internal forward + semester note genuinely
    // takes weeks, so we must not nudge into an empty inbox before then.
    if (classification.class === 'handoff_internal') {
      const todayIso = now.toISOString().slice(0, 10);
      const floor = addDaysIso(todayIso, 21);
      // Prefer whatever date we already derived (LLM follow_up_at), else the
      // promised response date + grace; then clamp up to the 21-day floor.
      const stated = analysis?.follow_up_at
        ?? (analysis?.extracted?.promised_response_date
          ? addDaysIso(analysis.extracted.promised_response_date, 3)
          : null);
      patch.follow_up_at = (stated && stated > floor) ? stated : floor;
    }
    // A closed case has no live follow-up promise (review M10).
    if (transition.nextState === 'DONE' || transition.nextState === 'DEAD_END') {
      patch.follow_up_at = null;
    }
    db.updateConversationState(conv.id, transition.nextState, patch);

    return { thread, messageId };
  });

  return {
    convId: conv.id,
    updated: db.getConversation(conv.id),
    parsed, analysis, classification, transition, messageId, thread, previousState,
  };
}

// Ingest a delivery-failure notification (bounce / NDR) — NOT a kommun reply
// (2026-07-19 bounce-handling design §2). A bounce means the T-INITIAL reached
// nobody, so drafting a reply to mailer-daemon is meaningless; the real problem
// is a dead address that needs a corrected recipient + resend.
//
// Deliberately skips the LLM analysis and the reply-draft path entirely:
//  - The message is still STORED (no data loss) with classification 'bounce'
//    (a new string value in the existing TEXT column — no schema change).
//  - The conversation moves to NEEDS_HUMAN.
//  - ONE bounce escalation is opened via escalateWithDraft, so the
//    one-open-escalation invariant + supersede logic still hold. It carries the
//    ORIGINAL T-INITIAL subject/body as the draft (what the operator resends)
//    and classifier_class='bounce' / draft_template='T_RESEND_BAD_ADDRESS' so
//    the dashboard renders the address-entry resend form instead of a reply box.
async function ingestBounce({ conv, item, deps }) {
  const { db, env, now } = deps;
  const { full, parsed } = item;
  const receivedAt = parsed.internal_date ?? now.toISOString();

  const previousState = conv.state;
  // Store the bounce atomically (thread + message), no LLM, no attachments.
  db.transaction(() => {
    const thread = db.upsertThread({
      conversation_id: conv.id,
      gmail_thread_id: full.threadId,
      counterparty_email: parsed.from,
      counterparty_name: parsed.from,
      last_inbound_at: receivedAt,
    });
    db.recordMessage({
      conversation_id: conv.id, gmail_message_id: item.id, direction: 'inbound',
      from_email: parsed.from, to_email: parsed.to,
      subject: parsed.subject, body_text: parsed.body,
      classification: 'bounce', classification_confidence: null,
      received_at: receivedAt, attachment_count: parsed.attachments.length,
      gmail_thread_id: full.threadId,
      thread_id: thread.id,
    });
    db.updateConversationState(conv.id, 'NEEDS_HUMAN', {});
  });

  // The dead address: prefer the one named in the NDR body, else the address we
  // last sent to for this conversation.
  const deadAddress = failedRecipient(parsed.body) ?? conv.contact_email;
  // The exact T-INITIAL the operator will resend, so the escalation shows it.
  const initial = T_INITIAL(tplCtx(db.getConversation(conv.id), env));

  await escalateWithDraft({
    conv: db.getConversation(conv.id),
    parsedInbound: parsed,
    messageId: null,
    classification: { class: 'bounce', confidence: null },
    previousState,
    draftTemplate: 'T_RESEND_BAD_ADDRESS',
    draftSubject: initial.subject,
    draftBody: initial.body,
    reason: `Leveransfel: adressen \`${deadAddress}\` finns inte — ange ny adress och skicka om begäran.`,
    deps,
  });
}

// Decide and dispatch the escalation for one ingested message. Runs after ALL
// inbound is committed (review M6) so the unbounded part — per-PDF Opus
// analysis — can never leave a half-ingested message behind.
async function dispatchEscalationForIngest(pending, deps) {
  const { db, env } = deps;
  const { updated, previousState, parsed, analysis, classification, transition, messageId, thread } = pending;

  // Every inline analysis records which attachments it ATTEMPTED into the
  // per-tick set, so step 3 does not spend a second attempt on the same
  // document in the same tick (the 5-attempt budget was being burned at double
  // speed, so a provider wobble parked documents in ~45 minutes).
  const attemptedIds = deps.attemptedAttachmentIds ?? null;
  const runInlineAnalysis = async (opts) => {
    const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
    const r = await analyseContracts({ db, env, log: deps.log, contractsDir: deps.contractsDir, ...opts });
    if (attemptedIds && Array.isArray(r?.attempted_ids)) {
      for (const id of r.attempted_ids) attemptedIds.add(id);
    }
    return r;
  };

  // Evidence gate for the missing-contracts claim: documents this conversation
  // has stored but not extracted (queued or parked). Read AFTER the inline
  // analysis, so a document read in this very tick no longer counts. Called
  // unconditionally — a db that cannot answer throws into the caller's catch,
  // which falls back to the neutral receipt (under-claim) and logs. It must
  // never silently answer "0 unread" and let the claim through.
  const unreadDocuments = () => db.countUnreadAnalysableAttachments(updated.id);

  // Outbound: never auto-sent in v1. Draft a template and escalate to Slack.
  // If the LLM produced a draft_reply, prefer it over the canned template.
  let draftTemplate = null;
  let llmDraft = null;
  let templateCtx = {};
  let watchlistVendors = [];
  let reasonPrefix = null;
  // The same out-of-office firing again (often triggered by our own ack) is not
  // new information from the kommun, so it must not void a pending draft.
  let isRepeatAutoresponder = false;
  if (transition.action === 'send_precision') draftTemplate = 'T_PRECISION';
  else if (transition.action === 'send_receipt' && !updated.receipt_sent) draftTemplate = 'T_RECEIPT';
  else if (transition.action === 'escalate') draftTemplate = 'free_form';
  else if (transition.action === 'send_crosscheck') draftTemplate = 'T_CROSSCHECK';
  else if (transition.action === 'send_delay_ack') {
    // Graceful "we'll wait" for a delay promise / OOO autoreply. The named
    // date is the kommun's return/promised date — follow_up_at already holds
    // date + 3 days grace (patched during ingest), so derive back if needed.
    const delayDate = analysis?.extracted?.promised_response_date
      ?? (analysis?.follow_up_at ? addDaysIso(analysis.follow_up_at, -3) : null);
    if (!delayDate) {
      // No date to name — nothing to ack; the follow-up timer (if any) and
      // staleness rules carry the case.
      deps.log?.(`SKIP delay ack for ${updated.kommun_namn}/${updated.role}: no return date extracted`);
    } else if (db.hasDelayAckForDate(updated.id, delayDate)) {
      // Autoreply-loop guard: the same OOO re-firing (possibly triggered by
      // our own ack) must not mint another identical draft — nor void the ack
      // that is already pending, which is still exactly right.
      isRepeatAutoresponder = true;
      deps.log?.(`SKIP delay ack for ${updated.kommun_namn}/${updated.role}: ack for ${delayDate} already exists (autoreply loop guard)`);
    } else {
      draftTemplate = 'T_DELAY_ACK';
      templateCtx = { delay_date: delayDate };
      // `until=<date>` in the reason is what hasDelayAckForDate dedupes on.
      reasonPrefix = `delay ack until=${delayDate}`;
    }
  }

  // T_DELAY_ACK is deterministic on purpose: the LLM's own delay wording drifts
  // and tends to promise a date, which outbound must never do (see the template).
  // So the LLM draft never substitutes for it.
  if (draftTemplate && draftTemplate !== 'T_DELAY_ACK' && analysis?.draft_reply) {
    llmDraft = { body: analysis.draft_reply };
  }

  // Contract-aware delivery: a "delivery" reply must reflect what the
  // attachments actually contain.
  if (draftTemplate === 'T_RECEIPT') {
    try {
      await runInlineAnalysis({ onlyMessageId: messageId });
      const { all } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
      watchlistVendors = matchWatchlist(all);
      // Coverage spans the CONVERSATION, not just this message: scoped to one
      // message the draft would re-ask for what an earlier batch delivered.
      const facts = buildCoverageFacts(db.listContractInfoForConversation(updated.id));
      // A watchlist vendor in what ARRIVED is information for the operator, not
      // a reason to withhold the acknowledgement. This used to blank the draft
      // ("so the operator consciously authors the reply"), but it triggered on
      // the wrong thing: the receipt names no vendor and reveals nothing about
      // who is asking, so there was nothing to author carefully. It just left
      // blank pages the operator filled in by hand. Every one of these is
      // escalated for human approval regardless, and the ⚠️ BEVAKAD LEVERANTÖR
      // flag stays on the reason, so the signal survives without the blank.
      const unread = unreadDocuments();
      const choice = chooseDeliveryReply({ facts, unread_documents: unread });
      if (choice.suppressed && facts.has_missing) {
        deps.log?.(`SUPPRESSED T_REQUEST_MISSING for ${updated.kommun_namn}/${updated.role}: `
          + `${unread} levererat dokument är ännu inte läst — vi kan inte påstå att avtal saknas`);
        // The suppression must reach the OPERATOR, not just the log: a parked
        // document freezes this conversation's missing-claim until un-parked,
        // and the escalation reason is the one surface they see in Slack.
        const suppressedNote = `⏳ ${unread} dokument olästa — saknas-påstående undertryckt`;
        reasonPrefix = reasonPrefix ? `${reasonPrefix} | ${suppressedNote}` : suppressedNote;
      }
      if (choice.template === 'T_REQUEST_MISSING') {
        draftTemplate = 'T_REQUEST_MISSING';
        llmDraft = null; // the PDF-blind LLM draft must not win here
        templateCtx = { facts };
      }
    } catch (e) {
      deps.log?.(`inline contract analysis error: ${e.message}`);
      // fall back to T_RECEIPT with the existing llmDraft — never crash the tick
    }
  } else if (draftTemplate === 'T_CROSSCHECK') {
    // Analyse this message's attachments FIRST: the closing delivery usually
    // carries the last contracts, and asking about something they just sent is
    // the one thing this mail must not do.
    try {
      await runInlineAnalysis({ onlyMessageId: messageId });
    } catch (e) {
      deps.log?.(`crosscheck contract analysis error: ${e.message}`);
    }
    const info = db.listContractInfoForConversation(updated.id);
    const { all } = computeReceivedMissing(info);
    const vendors = info.some((r) => r.is_contract) ? crosscheckLabels({ received: all }) : [];
    if (vendors.length > 0) {
      templateCtx = { crosscheck_vendors: vendors };
      llmDraft = null;   // the deterministic checklist wins over the LLM's "tack"
    } else {
      // Nothing extracted, or nothing left to ask: reading the whole category
      // back would be the original request again, not a closing check. The
      // conversation still reaches CROSSCHECK; the operator closes it.
      deps.log?.(`SKIP crosscheck for ${updated.kommun_namn}/${updated.role}: no vendors to ask about`);
      draftTemplate = null;
    }
  } else if (!draftTemplate && classification.class === 'delivery' && parsed.attachments.length > 0) {
    // Watchlist on later deliveries (review M5): once receipt_sent=1 a delivery
    // draws no receipt draft, but a watchlisted vendor arriving in a second
    // batch must still surface to a human rather than be analysed silently.
    try {
      await runInlineAnalysis({ onlyMessageId: messageId });
      const { all } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
      watchlistVendors = matchWatchlist(all);
      if (watchlistVendors.length > 0) {
        // Escalate, but with whatever reply the analysis produced. Blank only
        // when there is genuinely nothing to propose.
        const facts = buildCoverageFacts(db.listContractInfoForConversation(updated.id));
        if (chooseDeliveryReply({ facts, unread_documents: unreadDocuments() }).template === 'T_REQUEST_MISSING') {
          draftTemplate = 'T_REQUEST_MISSING';
          llmDraft = null;
          templateCtx = { facts };
        } else {
          draftTemplate = llmDraft ? 'llm' : 'free_form';
        }
      }
    } catch (e) {
      deps.log?.(`watchlist contract analysis error: ${e.message}`);
      // never crash the tick; step 3 will analyse the PDFs anyway
    }
  }

  // A reply from the kommun VOIDS any pending draft for this conversation.
  //
  // The daemon writes a draft but a human sends it, sometimes days later. If
  // the kommun answers in between, the draft answers a message that has been
  // overtaken — a reminder that asks "have you had a chance to look at this?"
  // after they already delivered. sendApprovedReply refuses such a send
  // (STALE_ESCALATION), but only on the unmodified path and only once the
  // operator has clicked, so a dead draft could sit in the queue looking fine.
  // Voiding it here means it never looks sendable in the first place.
  //
  // Machine traffic is not an answer: an out-of-office bounce or a diarium
  // receipt means nobody has read our request, so the pending draft is still
  // exactly right and churning it would re-draft on every autoresponder.
  //
  // escalateWithDraft supersedes open escalations too, so this only changes the
  // case where the reply itself warrants no new draft. Only 'open' is touched —
  // a 'sending' claim is mid-Gmail-call and a parked 'send_failed' is a human's
  // decision to make.
  const isMachineTraffic = classification.class === 'auto_ack' || classification.class === 'auto_reply'
    || isRepeatAutoresponder;
  if (!isMachineTraffic && !draftTemplate) {
    for (const stale of db.listOpenEscalationsForConversation(updated.id)) {
      db.resolveEscalation(stale.id, {
        status: 'superseded',
        resolved_text: 'voided: the kommun replied after this draft was written',
      });
      deps.log?.(`VOIDED escalation ${stale.id} for ${updated.kommun_namn}/${updated.role} — kommun replied after the draft`);
    }
  }

  const threadStatus = db.getThreadById(thread.id)?.status ?? 'neutral';
  if (draftTemplate && threadStatus !== 'muted') {
    let reason = analysis
      ? `llm intent=${analysis.intent} action=${analysis.suggested_action} confidence=${(analysis.confidence ?? 0).toFixed(2)}`
      : `classifier=${classification.class} confidence=${classification.confidence.toFixed(2)}`;
    if (reasonPrefix) {
      reason = `${reasonPrefix} | ${reason}`;
    }
    if (watchlistVendors.length > 0) {
      reason = `⚠️ BEVAKAD LEVERANTÖR: ${watchlistVendors.join(', ')} | ${reason}`;
    }
    await escalateWithDraft({
      conv: db.getConversation(updated.id), parsedInbound: parsed, messageId, classification,
      previousState,
      draftTemplate,
      llmDraft,
      reason,
      templateCtx,
      watchlistVendors,
      deps,
    });
  }
}

// Self-heal escalations that were never announced in Slack (D6). An open
// escalation with slack_ts NULL is a draft a human can approve in the dashboard
// but will never see a button for — the state a Slack outage leaves behind, and
// the state every escalation created while Slack was misconfigured is in.
// Re-posting is idempotent-by-construction: the row is only ever posted while
// slack_ts is NULL, and the ts is written the moment the post succeeds.
//
// Bounded per tick so a backlog (or a first run after Slack is configured)
// drains gradually instead of flooding the channel, and abandoned on the first
// failure — if Slack is still down, the remaining rows wait for a later tick.
const UNPOSTED_ESCALATION_RETRIES_PER_TICK = 5;
// Only rows young enough to plausibly be Slack-outage orphans are re-posted.
// The live DB carries OTHER producers of open/slack_ts-NULL rows — a
// dashboard-composed reply refused before the claim, escalations minted before
// SLACK_CHANNEL_ID existed — and resurrecting a months-old draft with live
// Approve buttons is exactly the stale-send surface this repo works to close.
// Older rows stay dashboard-only.
const UNPOSTED_ESCALATION_MAX_AGE_DAYS = 7;

async function retryUnpostedEscalations(deps) {
  const { db, slackClient, slackOps, env, log } = deps;
  if (!slackOps?.postEscalation || !env.SLACK_CHANNEL_ID) return 0;
  const nowMs = (deps.now ?? new Date()).getTime();
  let attempts = 0;
  let healed = 0;
  for (const esc of db.listEscalationsByStatus('open')) {
    if (esc.slack_ts) continue;
    // The cap bounds Slack API CALLS per tick, not successes — a post that
    // resolves without a ts must not turn the drain into an unbounded flood.
    if (attempts >= UNPOSTED_ESCALATION_RETRIES_PER_TICK) break;
    // created_at is SQLite datetime('now') ("YYYY-MM-DD HH:MM:SS", UTC);
    // normalise to ISO before parsing. An unparseable value is retried (the
    // fail direction that restores buttons rather than hiding a draft).
    const createdRaw = String(esc.created_at ?? '');
    const createdMs = Date.parse(createdRaw.includes('T') ? createdRaw : `${createdRaw.replace(' ', 'T')}Z`);
    if (Number.isFinite(createdMs)
      && nowMs - createdMs > UNPOSTED_ESCALATION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000) continue;
    const conv = db.getConversation(esc.conversation_id);
    if (!conv) continue;
    const trigger = esc.message_id ? db.getMessageById(esc.message_id) : null;
    let watchlistVendors = [];
    try {
      const parsedVendors = esc.watchlist_vendors ? JSON.parse(esc.watchlist_vendors) : [];
      if (Array.isArray(parsedVendors)) watchlistVendors = parsedVendors;
    } catch { /* a malformed column must not block the re-post */ }
    const blocks = buildEscalationBlocks({
      escalation_id: esc.id,
      kommun_namn: conv.kommun_namn,
      from_email: trigger?.from_email ?? '(no inbound — proactive draft)',
      reply_text: trigger?.body_text ?? '(no inbound)',
      draft_reply: `Subject: ${esc.draft_subject ?? ''}\n\n${esc.draft_body ?? ''}`,
      gmail_thread_id: conv.gmail_thread_id ?? '(no thread)',
      watchlist_vendors: watchlistVendors,
    });
    try {
      attempts += 1;
      const posted = await slackOps.postEscalation(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        blocks,
        fallbackText: `Eskalering: ${conv.kommun_namn} (${esc.draft_template})`,
      });
      if (!posted?.ts) continue;
      db.raw.prepare('UPDATE escalations SET slack_ts = ? WHERE id = ?').run(posted.ts, esc.id);
      healed += 1;
      log?.(`RE-POSTED escalation ${esc.id} (${conv.kommun_namn}/${conv.role}) — Slack buttons restored`);
    } catch (e) {
      log?.(`postEscalation retry failed for escalation ${esc.id}: ${e.message} — will retry next tick`);
      break;
    }
  }
  return healed;
}

// Surface unmatched and domain-ambiguous inbound (review H5/H2) as a Slack
// digest instead of silently re-fetching it forever. `seenUnmatched` is a
// per-process Map (gmail_message_id → cached {threadId, from} match inputs)
// injected by the daemon so each message alerts once per daemon lifetime AND
// is still re-attempted against matchInbound every tick without a re-fetch
// (hardening finding 4): once the operator associates the thread — or a
// sibling conversation resolves the ambiguity — the message is ingested on
// the next tick, not lost until a restart. Durable tracking would need a
// schema change, so a restart re-checks (and re-alerts) once.
//
// Ordering is post-BEFORE-cache, and only the messages that actually FIT in the
// posted message are cached (see DIGEST_MAX_LINES). Marking everything while
// truncating the text silences the overflow forever; caching before the post
// means one Slack hiccup silences the whole batch for the process lifetime.
// An uncached message is simply re-fetched and re-digested next tick.
async function digestUnmatched({ unmatched, ambiguous, fetchedById, convById, seenUnmatched, deps }) {
  const { slackClient, slackOps, env, log } = deps;
  const items = [];
  for (const id of unmatched) {
    if (seenUnmatched.has(id)) continue; // already digested on an earlier tick
    const f = fetchedById.get(id);
    const atts = f.parsed.attachments.length ? ` (${f.parsed.attachments.length} bilagor)` : '';
    items.push({
      id, threadId: f.full.threadId, from: f.parsed.from,
      line: `• *${f.parsed.from}* — ${f.parsed.subject || '(ämne saknas)'}${atts}`,
    });
  }
  for (const a of ambiguous) {
    if (seenUnmatched.has(a.messageId)) continue;
    const f = fetchedById.get(a.messageId);
    const kommuner = a.convIds
      .map((cid) => { const c = convById.get(cid); return c ? `${c.kommun_namn}/${c.role}` : `conv ${cid}`; })
      .join(', ');
    items.push({
      id: a.messageId, threadId: f.full.threadId, from: f.parsed.from,
      line: `• *${f.parsed.from}* — ${f.parsed.subject || '(ämne saknas)'} — TVETYDIG: matchar ${kommuner}, associera manuellt`,
    });
  }
  if (items.length === 0) return;
  log?.(`UNMATCHED inbound: ${items.length} new message(s) matched no (or several) conversations`);
  if (!slackOps?.postAlert || !env.SLACK_CHANNEL_ID) return; // nothing posted → nothing digested
  const included = items.slice(0, DIGEST_MAX_LINES);
  const rest = items.length - included.length;
  try {
    await slackOps.postAlert(slackClient, {
      channel: env.SLACK_CHANNEL_ID,
      text: `📥 *Omatchade inkommande* (${items.length}) — ej registrerade, kräver manuell hantering:\n`
        + included.map((i) => i.line).join('\n')
        + (rest > 0 ? `\n_…och ${rest} till, som listas nästa tick._` : ''),
    });
  } catch (e) {
    log?.(`postAlert failed for unmatched digest: ${e.message} — will retry next tick`);
    return; // not cached → re-digested next tick
  }
  for (const i of included) seenUnmatched.set(i.id, { threadId: i.threadId, from: i.from });
}

// Parked-extraction digest (2026-08-16). An attachment that has burned through
// MAX_ANALYSIS_ATTEMPTS leaves the retry pool — which silently loses a
// delivered document unless someone is told. Unlike the unmatched-inbound
// digest above, "already alerted" is persisted on the attachment row
// (analysis_parked_alerted_at), so a daemon restart cannot re-digest the same
// file, and clearing the column re-arms the alert for a re-park.
//
// The Slack post happens BEFORE the mark, and ONLY the attachments actually
// named in the posted message are marked: the mark is durable (it survives
// restarts by design), so marking a row the operator was never shown loses the
// alert permanently. That happened two ways — a missing Slack config skipped
// the post but marked everything anyway, and the 20-line truncation marked the
// overflow it never printed. The digest is now self-draining: 20 per tick until
// the backlog is gone.
const DIGEST_MAX_LINES = 20;

async function digestParkedAnalyses(deps) {
  const { db, slackClient, slackOps, env, log } = deps;
  const parked = db.listParkedAnalysesToAlert?.() ?? [];
  if (parked.length === 0) return;
  log?.(`PARKED extraction: ${parked.length} attachment(s) left the analysis queue and need manual handling`);
  if (!slackOps?.postAlert || !env.SLACK_CHANNEL_ID) return; // nothing posted → nothing alerted
  const included = parked.slice(0, DIGEST_MAX_LINES);
  const rest = parked.length - included.length;
  const lines = included.map((a) => {
    const reason = (a.last_analysis_error ?? 'okänt fel').replace(/^permanent:|^transient:/, '');
    const permanent = String(a.last_analysis_error ?? '').startsWith('permanent:');
    return `• *${a.kommun_namn}* — ${a.filename} (${a.mime_type ?? 'okänd typ'}) — `
      + `${reason}${permanent ? '' : ` efter ${a.analysis_attempts} försök`}`;
  });
  try {
    await slackOps.postAlert(slackClient, {
      channel: env.SLACK_CHANNEL_ID,
      text: `📄 *Avtalsanalys parkerad* (${parked.length}) — dessa dokument analyseras inte längre automatiskt:\n`
        + `${lines.join('\n')}`
        + (rest > 0 ? `\n_…och ${rest} till, som listas nästa tick._` : '')
        + `\n_Rensa \`analysis_attempts\` på raden (eller kör \`npm run analyse -- --force\`) för att köa om._`,
    });
  } catch (e) {
    log?.(`postAlert failed for parked-analysis digest: ${e.message} — will retry next tick`);
    return; // not marked → re-digested next tick
  }
  db.markParkedAnalysesAlerted?.(included.map((a) => a.id));
}

// Systemic-failure guard: when EVERY attempt in a tick fails transiently (and
// there were at least a few), the problem is ours, not the documents' — a bad
// json_schema, a wrong model id, an expired key. That failure mode is invisible
// today because each attachment just "stays pending" and the tick stays green.
// Deliberately re-alerts every tick while the condition holds.
const SYSTEMIC_FAILURE_MIN_ATTEMPTS = 3;

async function alertSystemicAnalysisFailure(result, deps) {
  const { slackClient, slackOps, env, log } = deps;
  if (!result || typeof result !== 'object') return false; // legacy/fake numeric result
  const { attempted = 0, analysed = 0, failed = 0, transient = 0, backoff = 0 } = result;
  if (attempted < SYSTEMIC_FAILURE_MIN_ATTEMPTS) return false;
  // Backoff failures (429/529) count as failures here even though they book no
  // attempt: a provider storm is precisely when extraction is dead and the
  // channel must hear about it. Silencing the alert during a storm was the
  // failure mode — the queue stopped moving and the tick stayed green.
  if (analysed > 0 || failed !== attempted || transient + backoff !== attempted) return false;
  const throttled = backoff === attempted;
  log?.(`SYSTEMIC extraction failure: all ${attempted} analysis attempts failed this tick`
    + `${throttled ? ' (provider throttling — no attempts booked, nothing parked)' : ' transiently'}`);
  if (slackOps?.postAlert && env.SLACK_CHANNEL_ID) {
    try {
      await slackOps.postAlert(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        text: throttled
          ? `🚨 *Avtalsextraktion står stilla* — samtliga ${attempted} försök i denna tick avvisades av`
            + ` Anthropic (429/överbelastning). Inga försök har bokförts och inget dokument har parkerats;`
            + ` kön fortsätter automatiskt när API:et svarar igen.`
          : `🚨 *Avtalsextraktion misslyckas genomgående* — samtliga ${attempted} försök i denna tick`
            + ` föll på övergående fel och inget dokument kunde läsas. Kontrollera API-nyckel, modell-id och schema.`,
      });
    } catch (e) {
      log?.(`postAlert failed for systemic analysis failure: ${e.message}`);
    }
  }
  return true;
}

// The contracts volume is gone (or PILOT_CONTRACTS_DIR is wrong): every pending
// attachment vanished from disk at once. analysePendingContracts deliberately
// books NO failures in that case — nothing is parked — so this alert is the
// only thing that makes it visible.
async function alertContractsDirUnavailable(result, deps) {
  const { slackClient, slackOps, env, log, contractsDir } = deps;
  if (!result || typeof result !== 'object' || result.env_fault !== 'contracts_dir_unavailable') return false;
  const n = result.missing_all ?? result.attempted ?? 0;
  log?.(`CONTRACTS DIR unavailable: ${n} pending attachment(s) missing on disk — no attempts booked`);
  if (slackOps?.postAlert && env.SLACK_CHANNEL_ID) {
    try {
      await slackOps.postAlert(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        text: `🚨 *Avtalsfilerna går inte att läsa* — samtliga ${n} dokument i analyskön saknas på disk`
          + `${contractsDir ? ` (\`${contractsDir}\`)` : ''}. Troligen är volymen inte monterad eller`
          + ` PILOT_CONTRACTS_DIR fel. Inga försök har bokförts och inget har parkerats — kön återupptas`
          + ` när filerna finns på plats.`,
      });
    } catch (e) {
      log?.(`postAlert failed for contracts-dir fault: ${e.message}`);
    }
  }
  return true;
}

export async function runTick(deps) {
  const { db, gmailClient, gmailOps, env, now } = deps;

  // Attachment ids the inline per-message analysis has already ATTEMPTED in
  // this tick. Step 3 skips them so no document is charged two of its five
  // attempts by a single tick.
  const attemptedAttachmentIds = new Set();

  // 0. Crash recovery — surface any send that was claimed but never finalized
  // before dispatching anything new.
  await recoverStuckSends(deps);

  // 1. Initial dispatch — anything scheduled for now or earlier
  const dueInitial = db.listConversationsDueForInitialSend(now.toISOString());
  for (const conv of dueInitial) {
    await dispatchInitial(conv, deps);
  }

  // 2. Inbound processing — fetch new messages once per tick, match them to
  // conversations (thread first, then domain), ingest atomically, then draft.
  const active = db.listAllConversations().filter((c) => c.gmail_thread_id);
  if (active.length) {
    const seenUnmatched = deps.seenUnmatched ?? new Map();
    const windowDays = deriveFetchWindowDays(db.getTickHealth?.({ now })?.last_success_at ?? null, now);
    // `to:` alone matches the To header ONLY. The common shape after a
    // registrator forwards internally is the handler replying To: registrator
    // with us in Cc — that reply was never listed, so it was neither ingested
    // nor surfaced in the unmatched digest. `deliveredto:` covers mail that
    // reached us via an alias, where neither To nor Cc carries our address.
    // The OR group must be parenthesized so `-from:` and `newer_than:` still
    // apply to the whole query rather than binding to the last OR term.
    const me = env.GMAIL_USER_EMAIL;
    const list = await gmailOps.listInboundQuery(
      gmailClient.gmail,
      `(to:${me} OR cc:${me} OR deliveredto:${me}) -from:${me} newer_than:${windowDays}d`
    );
    // Pre-fetch each not-yet-recorded message exactly once, then match against
    // every conversation using the already-parsed content.
    const fetched = [];
    for (const m of list) {
      if (db.hasGmailMessageId(m.id)) { seenUnmatched.delete(m.id); continue; }
      if (seenUnmatched.has(m.id)) continue; // match inputs cached below — re-matched without a re-fetch
      const full = await gmailOps.getMessage(gmailClient.gmail, m.id);
      if (!full) continue;
      fetched.push({ id: m.id, full, parsed: parseInboundMessage(full) });
    }
    // Oldest first, so multi-message exchanges ingest in delivery order.
    fetched.sort((a, b) => (a.parsed.internal_date ?? '').localeCompare(b.parsed.internal_date ?? ''));

    const convInputs = active.map((c) => ({
      id: c.id,
      contact_email: c.contact_email,
      thread_ids: [
        c.gmail_thread_id,
        ...db.listThreadsForConversation(c.id).map((t) => t.gmail_thread_id),
      ].filter(Boolean),
    }));
    // Previously-unmatched/ambiguous ids re-enter matching every tick from the
    // cache (hardening finding 4): a manual thread association or a resolved
    // ambiguity must lead to ingestion in THIS process, not after a restart.
    const cachedCandidates = [...seenUnmatched.entries()]
      .filter(([id]) => !db.hasGmailMessageId(id))
      .map(([id, v]) => ({ id, threadId: v.threadId, from: v.from }));
    const { matched, ambiguous, unmatched } = matchInbound(
      [
        ...fetched.map((f) => ({ id: f.id, threadId: f.full.threadId, from: f.parsed.from })),
        ...cachedCandidates,
      ],
      convInputs,
    );
    const fetchedById = new Map(fetched.map((f) => [f.id, f]));
    const convById = new Map(active.map((c) => [c.id, c]));

    const pendingEscalations = [];
    for (const match of matched) {
      let item = fetchedById.get(match.messageId);
      if (!item) {
        // A formerly-unmatched message that has just become matchable — its
        // full content was never kept, so fetch it on demand now.
        const full = await gmailOps.getMessage(gmailClient.gmail, match.messageId);
        if (!full) continue; // stays cached; retried next tick
        item = { id: match.messageId, full, parsed: parseInboundMessage(full) };
      }
      seenUnmatched.delete(match.messageId);
      const conv = db.getConversation(match.convId); // fresh — state may have moved this tick
      try {
        // Bounce short-circuit (2026-07-19 §2): a delivery-failure notification
        // is not a reply. Store it, skip the LLM/reply-draft path, and open the
        // resend escalation directly — BEFORE any analysis is even attempted.
        if (isBounce({ from_email: item.parsed.from, subject: item.parsed.subject, body_text: item.parsed.body })) {
          await ingestBounce({ conv, item, deps });
          // Bounce recorded + committed → archive its thread (best-effort,
          // after commit). NDRs live in the operator's inbox too; the resend
          // escalation surfaces via Slack/dashboard, not the inbox.
          await archiveIngestedThreadBestEffort({ threadId: item.full.threadId, deps });
          continue;
        }
        pendingEscalations.push(await ingestMessage({ conv, item, deps }));
        // Row + attachments are committed (ingestMessage returned) → archive
        // the matched thread. STRICTLY after commit, best-effort: a failure
        // here never affects ingest correctness.
        await archiveIngestedThreadBestEffort({ threadId: item.full.threadId, deps });
      } catch (e) {
        // Nothing was committed for this message — it is retried next tick.
        deps.log?.(`ingest failed for message ${item.id} (${conv.kommun_namn}): ${e.message} — will retry next tick`);
      }
    }

    await digestUnmatched({ unmatched, ambiguous, fetchedById, convById, seenUnmatched, deps });

    // 2b. Drafting/escalation — after every inbound row is safely committed,
    // so the unbounded per-PDF analysis can't leave half-ingested messages.
    //
    // Every item is isolated. Because the rows are ALREADY committed, "retry
    // next tick" does not apply here: the message will never be re-fetched, so
    // an unhandled throw would permanently lose this draft AND every later one
    // in the batch, plus tick steps 3 and 4. The failure is therefore contained
    // and handed to a human — the alert must name the kommun and the Gmail
    // message id, because nothing else will ever surface it.
    for (const pending of pendingEscalations) {
      try {
        await dispatchEscalationForIngest(pending, { ...deps, attemptedAttachmentIds });
      } catch (e) {
        const who = `${pending.updated?.kommun_namn ?? '?'}/${pending.updated?.role ?? '?'}`;
        const gmailId = pending.parsed?.gmail_message_id ?? '?';
        // Say what actually happened, not what we assume. The dispatch can
        // throw AFTER the escalation row is written, and telling the operator
        // to "svara manuellt" is then wrong twice over: the draft is not lost,
        // and the manual reply they were sent to write is blocked by
        // hasActiveEscalation. So check the DB before claiming anything.
        let openEsc = null;
        try {
          openEsc = db.listOpenEscalationsForConversation(pending.updated?.id)[0] ?? null;
        } catch { /* fall back to the conservative wording below */ }
        deps.log?.(`escalation dispatch FAILED for message ${gmailId} (${who}): ${e.message}`
          + ` — message is stored, ${openEsc ? 'draft saved (approvable in the dashboard)' : 'draft lost'}, needs a human`);
        if (deps.slackOps?.postAlert && env.SLACK_CHANNEL_ID) {
          try {
            await deps.slackOps.postAlert(deps.slackClient, {
              channel: env.SLACK_CHANNEL_ID,
              text: openEsc
                ? `⚠️ Fel när eskaleringen för ${who} skulle slutföras (meddelande \`${gmailId}\`): ${e.message}.`
                  + ` Svaret ÄR sparat och utkastet (eskalering ${openEsc.id}) går att godkänna i dashboarden.`
                  + `${openEsc.slack_ts ? '' : ' Slack-knapparna postas om automatiskt nästa tick.'}`
                : `⚠️ Kunde inte skapa utkast/eskalering för ${who} (meddelande \`${gmailId}\`): ${e.message}.`
                  + ` Svaret ÄR sparat men inget utkast finns — öppna ärendet och svara manuellt.`,
            });
          } catch (alertErr) {
            deps.log?.(`postAlert failed for dispatch failure ${gmailId}: ${alertErr.message}`);
          }
        }
      }
    }
  }

  // 2c. Restore Slack buttons for any open escalation that was never posted
  // (Slack outage during escalateWithDraft). Runs regardless of inbound, and
  // never breaks the tick.
  try {
    await retryUnpostedEscalations(deps);
  } catch (e) {
    deps.log?.(`unposted-escalation retry error: ${e.message}`);
  }

  // 3. Contract analysis — any saved PDFs that haven't been analysed yet.
  // Injectable for tests; failures must never break the tick.
  const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
  try {
    const analysisResult = await analyseContracts({
      db, env, log: deps.log, contractsDir: deps.contractsDir,
      skipAttachmentIds: attemptedAttachmentIds,
    });
    // 3b. Extraction visibility — a document that stopped being retried, a tick
    // where nothing at all could be read, and a contracts volume that has gone
    // away must all be loud. Best-effort: none may break the tick.
    await alertSystemicAnalysisFailure(analysisResult, deps);
    await alertContractsDirUnavailable(analysisResult, deps);
  } catch (e) {
    deps.log?.(`contract analysis error: ${e.message}`);
  }
  try {
    await digestParkedAnalyses(deps);
  } catch (e) {
    deps.log?.(`parked-analysis digest error: ${e.message}`);
  }

  // 4. Refresh arming (2026-07-09 design §3.2/§3.6) — after contracts are
  // analysed, (re)compute next_review_at for every DONE conversation in the
  // pilot allowlist. Idempotent; re-arms perpetually as the contract set
  // changes. Guarded so a missing allowlist simply arms nothing.
  const refreshAllowlist = deps.refreshAllowlist ?? [];
  if (refreshAllowlist.length) {
    // Group DONE conversations by kommun so a kommun with both a central and an
    // utbildning conversation arms ONE review on ONE canonical conversation and
    // disarms the sibling (finding 5) — never two T_UPDATEs for one kommun.
    const byKommun = new Map();
    for (const conv of db.listConversationsByState('DONE')) {
      if (!byKommun.has(conv.kommun_kod)) byKommun.set(conv.kommun_kod, []);
      byKommun.get(conv.kommun_kod).push(conv);
    }
    for (const convs of byKommun.values()) {
      try {
        armRefreshForKommun(convs, { db, now, refreshAllowlist });
      } catch (e) {
        deps.log?.(`refresh arming error for ${convs[0]?.kommun_namn}: ${e.message}`);
      }
    }
  }
}

// One-time backfill (2026-07-20 archive-on-ingest design §3): clear the tracked
// threads already sitting in the operator's inbox from before archive-on-ingest
// existed. Iterates EVERY conversation's Gmail thread(s) — the primary
// gmail_thread_id plus any threads recorded in the threads table — and archives
// each once. Every tracked thread is fair game: the tool has already recorded
// its content, so it belongs in All Mail, not the inbox. Archive = remove the
// INBOX label only (never trash/delete); idempotent, so re-archiving an
// already-archived thread is a Gmail no-op. `dryRun` lists the thread ids that
// WOULD be archived without calling modify. Returns the count.
//
// Offline-testable via an injected `archiveThreadImpl`; the OPERATOR runs it
// once, supervised — it mutates the live inbox, so confirm the count with a
// dry-run first. No DB writes.
export async function archiveTrackedThreads(db, { archiveThreadImpl = archiveThread, gmail = null, log = null, dryRun = false } = {}) {
  // Collect a de-duplicated set of every tracked thread id across all
  // conversations (a conversation may own several threads).
  const threadIds = new Set();
  for (const conv of db.listAllConversations()) {
    if (conv.gmail_thread_id) threadIds.add(conv.gmail_thread_id);
    for (const t of db.listThreadsForConversation(conv.id)) {
      if (t.gmail_thread_id) threadIds.add(t.gmail_thread_id);
    }
  }

  let count = 0;
  for (const threadId of threadIds) {
    if (dryRun) {
      log?.(`DRY-RUN would archive tracked thread ${threadId}`);
      count += 1;
      continue;
    }
    try {
      await archiveThreadImpl(gmail, threadId);
      count += 1;
    } catch (e) {
      // Best-effort per thread — one failure must not abort the backfill.
      log?.(`backfill archive failed for thread ${threadId}: ${e.message}`);
    }
  }
  log?.(`${dryRun ? 'DRY-RUN: ' : ''}archived ${count} tracked thread(s)`);
  return count;
}

// Local calendar date of a Date. The follow-up cron boundary is LOCAL time
// ('0 9 * * *'), so "has today's run happened" must be asked in local time —
// a UTC date flips on the wrong side of midnight for half the year.
export function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Hour-of-day the daily follow-up cron fires ('0 9 * * *' → 9). Anything we
// cannot read confidently falls back to 9, the documented default.
export function followupHourFromCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  const hour = fields.length >= 5 ? parseInt(fields[1], 10) : NaN;
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9;
}

// Should a healthy tick run the daily follow-up itself?
//
// The 09:00 cron fires once. If ingest happened to be blind at that minute —
// a 61-minute gap straddling 09:00 is enough — runDailyFollowup returns early
// (correctly: it must not claim silence it has not verified) and a whole day of
// nudges, closes and nudge-cap escalations is silently skipped. So every
// successful tick past the cron hour asks whether today's run ever COMPLETED,
// and re-invokes it if not. The gates inside runDailyFollowup stay
// authoritative: a still-blind daemon skips again and simply asks again later.
export function followupCatchUpDue({ now, completedDate, hour = 9 }) {
  if (completedDate === localDateStr(now)) return false;
  return now.getHours() >= hour;
}

export async function runDailyFollowup(deps) {
  const { db, now, log } = deps;
  // Vacation window (2026-07-17): during the Swedish summer the proactive
  // staleness loop pauses and the summer days do NOT count toward staleness.
  // runTick (real inbound) and runRefreshScan (T_UPDATE) are untouched. Absent
  // cfg defaults to a disabled no-op (mirrors effectiveFollowUp) so callers
  // that don't inject it are unaffected; the daemon always injects the resolved
  // window via resolveVacation(overrides).
  const cfg = deps.vacationConfig ?? { enabled: false };

  // Ingest gate: everything below is staleness drafting — "we have heard
  // nothing for N days" — computed purely from the DB. When ingest is blind
  // (dead Gmail token, daemon down) the DB is NOT the world: replies can be
  // sitting unfetched in the inbox, and a nudge saying we are still waiting
  // would be false. `stale` is getTickHealth's own notion, shared with the
  // dashboard pill and the send-side STALE_INGEST guard. runTick (real
  // inbound) and runRefreshScan (T_UPDATE) are untouched — neither claims to
  // know that nothing arrived.
  const health = db.getTickHealth?.({ now }) ?? null;
  if (health?.stale) {
    const since = health.ever
      ? `senaste lyckade bearbetning ${health.last_success_at} (${health.stale_minutes} min sedan)`
      : 'ingen lyckad bearbetning ännu';
    log?.(`FOLLOWUP paused — inbound is not being processed: ${since}; the DB may not reflect replies already in the inbox`);
    return; // deliberately NOT marked complete — a later healthy tick retries it
  }

  // Kill switch (2026-08-17 design) — read fresh from disk EVERY run so the
  // operator pulling the switch takes effect on the next daily run without a
  // daemon restart. The daemon's startup-loaded overrides object is
  // deliberately not consulted for this key.
  const autoSendTemplates = loadAutoSendTemplates(deps.overridesPath);

  const todayIso = now.toISOString().slice(0, 10);
  let vacationPauseLogged = false;
  const all = db.listAllConversations();
  for (const conv of all) {
    // Gate the whole proactive loop while inside the vacation window: don't
    // mint any nudge/close/escalation. Logged once per tick (not per conv) to
    // avoid log spam.
    if (isInVacation(todayIso, cfg)) {
      if (!vacationPauseLogged) {
        log?.('FOLLOWUP paused — vacation mode active');
        vacationPauseLogged = true;
      }
      continue;
    }

    // At most one ACTIVE next-action per conversation (review H1 + hardening
    // finding 2/3): while an escalation sits unapproved (open), is mid-send
    // (sending), or is parked after an ambiguous Gmail outcome (send_failed /
    // send_unconfirmed), the daily loop must not mint a new draft — approving
    // it could double-message a kommun whose previous reply may already have
    // gone out. Non-open active statuses are surfaced to the operator via
    // Slack; the conversation needs a human, not another nudge.
    if (db.hasActiveEscalation(conv.id)) continue;

    // Discount the clock: subtract whole vacation days elapsed since the state
    // change so a conversation quiet across the summer doesn't accrue stale
    // days it can't help. staleAction stays pure/unchanged — it just sees a
    // smaller `days`.
    const raw = daysBetween(new Date(conv.state_changed_at), now);
    const vac = conv.state_changed_at
      ? vacationDaysBetween(conv.state_changed_at.slice(0, 10), todayIso, cfg)
      : 0;
    const days = Math.max(0, raw - vac);
    const action = staleAction(conv.state, days, conv.followup_count, {
      today: todayIso,
      follow_up_at: conv.follow_up_at ?? null,
      nudgeJitterDays: nudgeJitterDays(conv.id),
    });
    if (action === 'none') continue;

    let draftTemplate = null;
    let reason = `stale ${conv.state} for ${days} days`;
    if (action === 'send_followup_nudge') draftTemplate = 'T_FOLLOWUP_NUDGE';
    else if (action === 'send_followup_close') draftTemplate = 'T_FOLLOWUP_CLOSE';
    else if (action === 'escalate') {
      reason = `stale ${conv.state} for ${days} days, ${conv.followup_count} nudges already sent`;
      draftTemplate = 'free_form';
    }

    if (draftTemplate) {
      const escId = await escalateWithDraft({
        conv,
        parsedInbound: null,
        // Follow-up drafts get a synthetic classifier class so their decisions
        // can form a graduating (class, state) pair — NULL never graduates
        // (review M3).
        classification: { class: 'followup_stale', confidence: null },
        previousState: conv.state,
        draftTemplate,
        reason,
        deps: { ...deps, sentDate: db.getFirstOutboundDate?.(conv.id) ?? null },
      });
      log?.(`FOLLOWUP drafted (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}`);

      // Auto-send (2026-08-17 design): T_FOLLOWUP_NUDGE — and ONLY it — may go
      // out unattended, and only to a kommun that has never substantively
      // responded (every inbound in the LAZY set; NULL classification fails
      // closed). escalateWithDraft ran FIRST so a crash between drafting and
      // sending leaves an open escalation a human can act on — never a lost
      // intention, never an untracked send. The send itself rides the proven
      // approved-send rails (atomic claim, STALE_* guards, send_failed
      // parking); decision 'auto_send' is how the ledger permanently tells
      // machine sends from operator sends.
      //
      // An unanswered clarification must never draw an unattended nudge
      // (2026-08-20). The GUARANTEE is the ledger check inside
      // isLazyConversation: `listOperatorDecisionTimes` returns every send a
      // PERSON made (decision IN ('approve_unmodified', 'edit') — an unsent
      // 'skip'/'closed' answers nothing), so a clarification counts as
      // answered only when a human replied after it. Outbound message rows
      // would NOT do — a delay_promise arriving in AWAITING_PRECISION flips the
      // conversation to ACK_RECEIVED and supersedes the operator's open
      // precision draft, the delay-ack sweep auto-sends, and that machine
      // outbound would pose as our answer. Leaving AWAITING_PRECISION therefore
      // does not imply we replied. The state check below is kept only as a
      // cheap backstop for the direct case (a conversation still sitting on the
      // unanswered question); it is not what makes this safe.
      if (
        escId != null
        && draftTemplate === 'T_FOLLOWUP_NUDGE'
        && autoSendTemplates.includes('T_FOLLOWUP_NUDGE')
        && conv.state !== 'AWAITING_PRECISION'
        && isLazyConversation(db.listMessages(conv.id), {
          operatorSendTimes: db.listOperatorDecisionTimes(conv.id),
        })
      ) {
        const esc = db.raw.prepare('SELECT * FROM escalations WHERE id = ?').get(escId);
        try {
          await sendApprovedReply({
            db,
            gmail: deps.gmailClient?.gmail,
            env: deps.env,
            conv,
            esc,
            finalBody: esc.draft_body,
            finalSubject: esc.draft_subject,
            decision: 'auto_send',
            gmailSendImpl: deps.gmailOps.sendMessage,
            archiveThreadImpl: deps.gmailOps.archiveThread,
            slackClient: deps.slackClient ?? null,
            log,
          });
          log?.(`AUTO-SENT T_FOLLOWUP_NUDGE → ${conv.kommun_namn}/${conv.role} (escalation ${escId})`);
        } catch (e) {
          // A refusal before the claim (STALE_*) left the escalation OPEN in
          // the operator's normal queue; a Gmail failure parked it
          // send_failed. But sendApprovedReply can also throw AFTER Gmail
          // accepted the mail (post-send bookkeeping), leaving the escalation
          // claimed as `sending` — so read the status back and say only what
          // it actually proves, rather than asserting "did not go out" over a
          // mail that already left. Log-only: no retry, no status mutation —
          // the next daily run skips this conversation entirely
          // (hasActiveEscalation), recoverStuckSends owns the `sending` case,
          // and the rest of today's conversations still run.
          const after = db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(escId)?.status ?? null;
          const outcome = after === 'open'
            ? 'refused before the send claim, did not go out'
            : after === 'send_failed'
              ? 'Gmail rejected it, did not go out'
              : `outcome UNCERTAIN (escalation status ${after ?? 'unknown'}) — the mail may have been sent; recoverStuckSends will escalate it to a human`;
          log?.(`AUTO-SEND ${outcome} for ${conv.kommun_namn}/${conv.role} (${e.code ?? 'SEND_ERROR'}): ${e.message}`);
        }
      }
    }
  }

  // ---- T_DELAY_ACK auto-send sweep (2026-08-20 design) ----
  // Drafting happened at ingest (dispatchEscalationForIngest); this sweep sends
  // the eligible fresh ones on the morning cadence. It runs AFTER the staleness
  // loop so every swept conversation was already skipped there via
  // hasActiveEscalation — no same-run interleaving. Skipped entirely inside the
  // vacation window (drafts stay open for the operator) and, like the whole
  // run, never reached while ingest is blind (the gate at the top returned).
  if (autoSendTemplates.includes('T_DELAY_ACK') && !isInVacation(todayIso, cfg)) {
    const openDelayAcks = db.listEscalationsByStatus('open')
      .filter((e) => e.draft_template === 'T_DELAY_ACK');
    for (const esc of openDelayAcks) {
      const conv = db.getConversation(esc.conversation_id);
      if (!conv) continue;
      const verdict = isAutoSendableDelayAck({
        esc,
        messages: db.listMessages(conv.id),
        autoSentCount: db.countAutoSendDecisions(conv.id, 'T_DELAY_ACK'),
        now,
      });
      if (!verdict.ok) {
        log?.(`DELAY-ACK stays manual for ${conv.kommun_namn}/${conv.role} (escalation ${esc.id}): ${verdict.reason}`);
        continue;
      }
      try {
        await sendApprovedReply({
          db,
          gmail: deps.gmailClient?.gmail,
          env: deps.env,
          conv,
          esc,
          finalBody: esc.draft_body,
          finalSubject: esc.draft_subject,
          decision: 'auto_send',
          gmailSendImpl: deps.gmailOps.sendMessage,
          archiveThreadImpl: deps.gmailOps.archiveThread,
          slackClient: deps.slackClient ?? null,
          log,
        });
        log?.(`AUTO-SENT T_DELAY_ACK → ${conv.kommun_namn}/${conv.role} (escalation ${esc.id})`);
      } catch (e) {
        // Same truthful outcome log as the nudge auto-send: read the status
        // back and claim only what it proves. No retry, no status mutation.
        const after = db.raw.prepare('SELECT status FROM escalations WHERE id = ?').get(esc.id)?.status ?? null;
        const outcome = after === 'open'
          ? 'refused before the send claim, did not go out'
          : after === 'send_failed'
            ? 'Gmail rejected it, did not go out'
            : `outcome UNCERTAIN (escalation status ${after ?? 'unknown'}) — the mail may have been sent; recoverStuckSends will escalate it to a human`;
        log?.(`AUTO-SEND ${outcome} for ${conv.kommun_namn}/${conv.role} (${e.code ?? 'SEND_ERROR'}): ${e.message}`);
      }
    }
  }

  // Reached the end: today's staleness pass really happened (a vacation pause
  // counts — the decision was made and it was "nudge nobody"). Only a run that
  // returned early at the ingest gate leaves the date unstamped, which is what
  // the catch-up in the daemon looks for.
  db.markFollowupCompleted(localDateStr(now));
}

function daysBetween(then, now) {
  return Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
}

// ---- Perpetual contract refresh (2026-07-09 design Part B) ----

// THE canonical per-kommun review resolver now lives in contract-lifecycle.js
// (finding 8 — one function, horizon/grace applied, no parallel fork).
// Re-exported here for the existing import surface.
export { computeKommunReview };

// Pick the ONE canonical conversation of a kommun to carry the refresh
// (finding 5): prefer the conversation holding the most-recent contract
// delivery (its thread is where the kommun last actually sent avtal), tie-break
// to role 'central', then lowest id for determinism.
export function pickCanonicalConv(convs, db) {
  if (convs.length <= 1) return convs[0] ?? null;
  const lastContractAt = new Map();
  for (const c of convs) {
    const row = db.raw.prepare(`
      SELECT MAX(m.received_at) AS last_at
      FROM contracts ct
      JOIN attachments a ON a.id = ct.attachment_id
      JOIN messages m ON m.id = a.message_id
      WHERE m.conversation_id = ? AND ct.is_contract = 1
    `).get(c.id);
    lastContractAt.set(c.id, row?.last_at ?? null);
  }
  return [...convs].sort((a, b) => {
    const la = lastContractAt.get(a.id) ?? '';
    const lb = lastContractAt.get(b.id) ?? '';
    if (la !== lb) return lb.localeCompare(la);              // most-recent contract first
    if (a.role !== b.role) return a.role === 'central' ? -1 : (b.role === 'central' ? 1 : 0);
    return a.id - b.id;
  })[0];
}

// Arm a DONE conversation for its next refresh round: compute the kommun's
// soonest review date and store next_review_at / next_review_source. Gated by
// the pilot allowlist. Idempotent — recomputes from the current contract set,
// so a completed refresh round re-arms perpetually (design §3.6). No-op (and
// leaves next_review_at null) for non-allowlisted kommuner or when no contract
// yields a usable date — never blocks the pipeline.
//
// Writes via setNextReview, which touches ONLY next_review_at/next_review_source
// and never state or state_changed_at (finding 3): re-arming is pure
// bookkeeping and must not disturb the stale-clock the follow-up rules read.
// Idempotent to the byte — an unchanged re-arm performs no write at all.
export function armRefresh(conv, { db, now, refreshAllowlist = [] }) {
  if (!conv) return;
  if (!refreshAllowlist.includes(conv.kommun_kod)) return;
  const rows = db.listContractsForKommun(conv.kommun_kod);
  const { date, source } = computeKommunReview(rows, now);
  db.setNextReview(conv.id, { next_review_at: date, next_review_source: source });
}

// Arm exactly ONE conversation per kommun (finding 5): a kommun with both a
// central and an utbildning DONE conversation must yield ONE review and ONE
// T_UPDATE, never two. The canonical conversation is armed with the kommun's
// soonest review; every sibling is explicitly DISARMED (next_review_at → null)
// so the scan can never fire it. Called once per kommun by runTick.
export function armRefreshForKommun(convs, { db, now, refreshAllowlist = [] }) {
  if (!convs?.length) return;
  const kod = convs[0].kommun_kod;
  if (!refreshAllowlist.includes(kod)) return;
  const canonical = pickCanonicalConv(convs, db);
  const rows = db.listContractsForKommun(kod);
  const { date, source } = computeKommunReview(rows, now);
  for (const c of convs) {
    if (c.id === canonical.id) {
      db.setNextReview(c.id, { next_review_at: date, next_review_source: source });
    } else {
      db.setNextReview(c.id, { next_review_at: null, next_review_source: null });
    }
  }
}

// Daily refresh scan — sibling of runDailyFollowup, reusing all its safety
// machinery (one-open-action guard, escalateWithDraft supersede-or-defer,
// atomic claim inherited from the shared escalation path). Runs under the same
// tick/followup escalation mutex in the daemon.
//
// Finds DONE conversations whose next_review_at is due, that are allowlisted,
// and that have no active escalation → moves them to REFRESH_DUE and creates
// exactly ONE T_UPDATE escalation naming the expiring contract(s).
export async function runRefreshScan(deps) {
  const { db, now, refreshAllowlist = [], log } = deps;
  const todayIso = now.toISOString().slice(0, 10);

  // Heal stranded refreshes (finding 2): a REFRESH_DUE conversation with NO
  // active escalation means its T_UPDATE was skipped/superseded/parked without
  // a send — the operator chose not to re-contact this round. It must NOT sit
  // in REFRESH_DUE forever; revert it to DONE so armRefresh re-arms it later.
  // (A REFRESH_DUE conversation with an open T_UPDATE is still awaiting the
  // operator and is left alone.) This is surface-agnostic: however the skip
  // happened (Slack, dashboard, CLI), the next scan reconciles it.
  for (const conv of db.listConversationsByState('REFRESH_DUE')) {
    if (db.hasActiveEscalation(conv.id)) continue;
    // Clear next_review_at as part of the revert so the SAME scan cannot
    // immediately re-mint the skipped T_UPDATE. The next runTick armRefresh
    // recomputes from the current contract set and re-arms it later.
    db.updateConversationState(conv.id, 'DONE', { next_review_at: null, next_review_source: null });
    log?.(`REFRESH reverted → DONE (update skipped, no active escalation): ${conv.kommun_namn}/${conv.role}`);
  }

  for (const conv of db.listConversationsDueForRefresh(todayIso)) {
    if (!refreshAllowlist.includes(conv.kommun_kod)) continue;
    // At most one active next-action per conversation (review H1) — never mint
    // a refresh draft next to unresolved outbound.
    if (db.hasActiveEscalation(conv.id)) continue;

    // Recompute the review deterministically at scan time from the CURRENT
    // contract set (finding 7) — never trust a possibly-stale next_review_at
    // for naming. The same canonical computeKommunReview that armed it decides
    // the soonest vendor(s) now, so a contract set that changed since arming
    // still names the real current expiring vendor(s).
    const rows = db.listContractsForKommun(conv.kommun_kod);
    const { date: reviewDate, source: reviewSource, contracts: reviewContracts } =
      computeKommunReview(rows, now);
    // The set may have shifted so nothing is due any more (e.g. the expiring
    // contract was superseded by an extension between arm and scan). Re-arm
    // to the fresh date and skip — do NOT fire a T_UPDATE that names nothing.
    if (!reviewDate || reviewDate > todayIso) {
      db.setNextReview(conv.id, { next_review_at: reviewDate, next_review_source: reviewSource });
      continue;
    }

    // Enter the refresh round. refresh_round increments so rounds are
    // distinguishable; a new Gmail thread separates them naturally on send.
    db.updateConversationState(conv.id, 'REFRESH_DUE', {
      refresh_round: (conv.refresh_round ?? 0) + 1,
    });

    await escalateWithDraft({
      conv: db.getConversation(conv.id),
      parsedInbound: null,
      classification: { class: 'refresh_due', confidence: null },
      previousState: 'DONE',
      draftTemplate: 'T_UPDATE',
      reason: `contract refresh due ${reviewDate}${reviewSource ? ` (${reviewSource})` : ''}`,
      templateCtx: { arendenummer: conv.arendenummer ?? null, review_contracts: reviewContracts },
      deps,
    });
    log?.(`REFRESH escalated (T_UPDATE) → ${conv.kommun_namn}/${conv.role} due ${reviewDate}`);
  }
}
