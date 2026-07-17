import { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING, T_UPDATE, T_DELAY_ACK, computeReceivedMissing, chooseDeliveryReply } from './templates.js';
import { computeKommunReview } from './contract-lifecycle.js';
import { matchWatchlist } from './watchlist.js';
import { classify, isCloserText } from './classifier.js';
import { inferThreadStatus } from './threads.js';
import { nextActionForClassification, staleAction } from './conversation.js';
import { parseInboundMessage, sameEmailDomain } from './gmail.js';
import { buildEscalationBlocks } from './slack.js';
import { saveAttachment, extractPdfsFromZip, dedupeFilenames, isTrivialImage } from './attachments.js';
import { extractSignature } from './extract-signature.js';
import { analyseMessage, analysisToLegacyClassification, addDaysIso } from './analyse-message.js';
import { analysePendingContracts } from './analyse-contract.js';
import { isInVacation, vacationDaysBetween, defaultVacationConfig } from './vacation.js';

const TEMPLATES = { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE, T_REQUEST_MISSING, T_UPDATE, T_DELAY_ACK };

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
    days_since_send: extra.days_since_send ?? 0,
    received: extra.received ?? [],
    missing: extra.missing ?? [],
    // Perpetual-refresh (T_UPDATE) context, forwarded when present.
    arendenummer: extra.arendenummer ?? conv.arendenummer ?? null,
    review_contracts: extra.review_contracts ?? [],
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

async function escalateWithDraft({ conv, parsedInbound, messageId = null, classification, previousState, draftTemplate, llmDraft, reason, templateCtx = {}, watchlistVendors = [], deps }) {
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
  if (llmDraft) {
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
      days_since_send: deps.daysSinceSend ?? 0,
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
    const posted = await slackOps.postEscalation(slackClient, {
      channel: env.SLACK_CHANNEL_ID,
      blocks,
      fallbackText: `Eskalering: ${conv.kommun_namn} (${draftTemplate})`,
    });
    db.raw.prepare('UPDATE escalations SET slack_ts = ? WHERE id = ?').run(posted.ts, escId);
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
  // Zips still expand into their inner PDFs; a zip with no inner PDFs is
  // stored as-is so its contents are never lost. The single allowed skip is
  // an image known to be tiny (signature logos — see isTrivialImage); the
  // gap stays visible because attachment_count records what the mail carried.
  const entries = [];
  for (const att of parsed.attachments) {
    const fn = att.filename?.toLowerCase() ?? '';
    const isZip = att.mime_type === 'application/zip'
      || att.mime_type === 'application/x-zip-compressed' || fn.endsWith('.zip');
    if (isTrivialImage(att)) continue;
    const buf = await gmailOps.fetchAttachment(gmailClient.gmail, item.id, att.attachment_id);
    if (isZip) {
      const inner = extractPdfsFromZip(buf);
      if (inner.length > 0) {
        for (const e of inner) {
          entries.push({ filename: e.filename, data: e.data, mime_type: 'application/pdf' });
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

// Decide and dispatch the escalation for one ingested message. Runs after ALL
// inbound is committed (review M6) so the unbounded part — per-PDF Opus
// analysis — can never leave a half-ingested message behind.
async function dispatchEscalationForIngest(pending, deps) {
  const { db, env } = deps;
  const { updated, previousState, parsed, analysis, classification, transition, messageId, thread } = pending;

  // Outbound: never auto-sent in v1. Draft a template and escalate to Slack.
  // If the LLM produced a draft_reply, prefer it over the canned template.
  let draftTemplate = null;
  let llmDraft = null;
  let templateCtx = {};
  let watchlistVendors = [];
  let reasonPrefix = null;
  if (transition.action === 'send_precision') draftTemplate = 'T_PRECISION';
  else if (transition.action === 'send_receipt' && !updated.receipt_sent) draftTemplate = 'T_RECEIPT';
  else if (transition.action === 'escalate') draftTemplate = 'free_form';
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
      // our own ack) must not mint another identical draft.
      deps.log?.(`SKIP delay ack for ${updated.kommun_namn}/${updated.role}: ack for ${delayDate} already exists (autoreply loop guard)`);
    } else {
      draftTemplate = 'T_DELAY_ACK';
      templateCtx = { delay_date: delayDate };
      // `until=<date>` in the reason is what hasDelayAckForDate dedupes on.
      reasonPrefix = `delay ack until=${delayDate}`;
    }
  }

  // T_DELAY_ACK is deterministic on purpose: it must name the exact date the
  // loop guard deduped on, so the LLM draft never substitutes for it.
  if (draftTemplate && draftTemplate !== 'T_DELAY_ACK' && analysis?.draft_reply) {
    llmDraft = { body: analysis.draft_reply };
  }

  // Contract-aware delivery: a "delivery" reply must reflect what the
  // attachments actually contain. A watchlisted vendor supersedes the
  // contract-aware draft and holds the reply for conscious authoring.
  if (draftTemplate === 'T_RECEIPT') {
    const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
    try {
      await analyseContracts({ db, env, log: deps.log, onlyMessageId: messageId });
      const { received, missing, all } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
      watchlistVendors = matchWatchlist(all);
      if (watchlistVendors.length > 0) {
        // Hold: no sendable draft, so the operator consciously authors the reply.
        draftTemplate = 'free_form';
        llmDraft = null;
        templateCtx = {};
      } else if (chooseDeliveryReply({ received, missing }).template === 'T_REQUEST_MISSING') {
        draftTemplate = 'T_REQUEST_MISSING';
        llmDraft = null; // the PDF-blind LLM draft must not win here
        templateCtx = { received, missing };
      }
    } catch (e) {
      deps.log?.(`inline contract analysis error: ${e.message}`);
      // fall back to T_RECEIPT with the existing llmDraft — never crash the tick
    }
  } else if (!draftTemplate && classification.class === 'delivery' && parsed.attachments.length > 0) {
    // Watchlist on later deliveries (review M5): once receipt_sent=1 a delivery
    // draws no receipt draft, but a watchlisted vendor arriving in a second
    // batch must still be held for conscious authoring — not analysed silently.
    const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
    try {
      await analyseContracts({ db, env, log: deps.log, onlyMessageId: messageId });
      const { all } = computeReceivedMissing(db.listContractInfoForMessage(messageId));
      watchlistVendors = matchWatchlist(all);
      if (watchlistVendors.length > 0) {
        draftTemplate = 'free_form';
        llmDraft = null;
      }
    } catch (e) {
      deps.log?.(`watchlist contract analysis error: ${e.message}`);
      // never crash the tick; step 3 will analyse the PDFs anyway
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

// Surface unmatched and domain-ambiguous inbound (review H5/H2) as a Slack
// digest instead of silently re-fetching it forever. `seenUnmatched` is a
// per-process Map (gmail_message_id → cached {threadId, from} match inputs)
// injected by the daemon so each message alerts once per daemon lifetime AND
// is still re-attempted against matchInbound every tick without a re-fetch
// (hardening finding 4): once the operator associates the thread — or a
// sibling conversation resolves the ambiguity — the message is ingested on
// the next tick, not lost until a restart. Durable tracking would need a
// schema change, so a restart re-checks (and re-alerts) once.
async function digestUnmatched({ unmatched, ambiguous, fetchedById, convById, seenUnmatched, deps }) {
  const { slackClient, slackOps, env, log } = deps;
  const lines = [];
  for (const id of unmatched) {
    if (seenUnmatched.has(id)) continue; // already digested on an earlier tick
    const f = fetchedById.get(id);
    seenUnmatched.set(id, { threadId: f.full.threadId, from: f.parsed.from });
    const atts = f.parsed.attachments.length ? ` (${f.parsed.attachments.length} bilagor)` : '';
    lines.push(`• *${f.parsed.from}* — ${f.parsed.subject || '(ämne saknas)'}${atts}`);
  }
  for (const a of ambiguous) {
    if (seenUnmatched.has(a.messageId)) continue;
    const f = fetchedById.get(a.messageId);
    seenUnmatched.set(a.messageId, { threadId: f.full.threadId, from: f.parsed.from });
    const kommuner = a.convIds
      .map((cid) => { const c = convById.get(cid); return c ? `${c.kommun_namn}/${c.role}` : `conv ${cid}`; })
      .join(', ');
    lines.push(`• *${f.parsed.from}* — ${f.parsed.subject || '(ämne saknas)'} — TVETYDIG: matchar ${kommuner}, associera manuellt`);
  }
  if (lines.length === 0) return;
  log?.(`UNMATCHED inbound: ${lines.length} new message(s) matched no (or several) conversations`);
  if (slackOps?.postAlert && env.SLACK_CHANNEL_ID) {
    try {
      await slackOps.postAlert(slackClient, {
        channel: env.SLACK_CHANNEL_ID,
        text: `📥 *Omatchade inkommande* (${lines.length}) — ej registrerade, kräver manuell hantering:\n${lines.slice(0, 20).join('\n')}`,
      });
    } catch (e) {
      log?.(`postAlert failed for unmatched digest: ${e.message}`);
    }
  }
}

export async function runTick(deps) {
  const { db, gmailClient, gmailOps, env, now } = deps;

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
    const list = await gmailOps.listInboundQuery(
      gmailClient.gmail,
      `to:${env.GMAIL_USER_EMAIL} -from:${env.GMAIL_USER_EMAIL} newer_than:${windowDays}d`
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
        pendingEscalations.push(await ingestMessage({ conv, item, deps }));
      } catch (e) {
        // Nothing was committed for this message — it is retried next tick.
        deps.log?.(`ingest failed for message ${item.id} (${conv.kommun_namn}): ${e.message} — will retry next tick`);
      }
    }

    await digestUnmatched({ unmatched, ambiguous, fetchedById, convById, seenUnmatched, deps });

    // 2b. Drafting/escalation — after every inbound row is safely committed,
    // so the unbounded per-PDF analysis can't leave half-ingested messages.
    for (const pending of pendingEscalations) {
      await dispatchEscalationForIngest(pending, deps);
    }
  }

  // 3. Contract analysis — any saved PDFs that haven't been analysed yet.
  // Injectable for tests; failures must never break the tick.
  const analyseContracts = deps.analyseContracts ?? analysePendingContracts;
  try {
    await analyseContracts({ db, env, log: deps.log });
  } catch (e) {
    deps.log?.(`contract analysis error: ${e.message}`);
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

export async function runDailyFollowup(deps) {
  const { db, now, log } = deps;
  // Vacation window (2026-07-17): during the Swedish summer the proactive
  // staleness loop pauses and the summer days do NOT count toward staleness.
  // runTick (real inbound) and runRefreshScan (T_UPDATE) are untouched.
  const cfg = deps.vacationConfig ?? defaultVacationConfig();
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
      await escalateWithDraft({
        conv,
        parsedInbound: null,
        // Follow-up drafts get a synthetic classifier class so their decisions
        // can form a graduating (class, state) pair — NULL never graduates
        // (review M3).
        classification: { class: 'followup_stale', confidence: null },
        previousState: conv.state,
        draftTemplate,
        reason,
        deps: { ...deps, daysSinceSend: days },
      });
      log?.(`FOLLOWUP drafted (${draftTemplate}) → ${conv.kommun_namn}/${conv.role}`);
    }
  }
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
