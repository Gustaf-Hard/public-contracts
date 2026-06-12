import { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE } from './templates.js';
import { classify } from './classifier.js';
import { nextActionForClassification, staleAction } from './conversation.js';
import { parseInboundMessage, sameEmailDomain } from './gmail.js';
import { buildEscalationBlocks } from './slack.js';
import { saveAttachment } from './attachments.js';
import { extractSignature } from './extract-signature.js';
import { analyseMessage, analysisToLegacyClassification } from './analyse-message.js';
import { analysePendingContracts } from './analyse-contract.js';

const TEMPLATES = { T_INITIAL, T_PRECISION, T_RECEIPT, T_FOLLOWUP_NUDGE, T_FOLLOWUP_CLOSE };

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
  };
}

async function dispatchInitial(conv, deps) {
  const { db, gmailClient, gmailOps, env, now, log } = deps;
  const msg = T_INITIAL(tplCtx(conv, env));
  const sent = await gmailOps.sendMessage(gmailClient.gmail, {
    from: fromHeader(env), to: conv.contact_email, subject: msg.subject, body: msg.body,
  });
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

async function escalateWithDraft({ conv, parsedInbound, classification, previousState, draftTemplate, llmDraft, reason, deps }) {
  const { db, slackClient, slackOps, env, log } = deps;
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
    });
    const rendered = TEMPLATES[draftTemplate](ctx);
    subject = rendered.subject;
    body = rendered.body;
  }

  const escId = db.recordEscalation({
    conversation_id: conv.id,
    message_id: null,
    reason,
    draft_template: draftTemplate,
    draft_subject: subject,
    draft_body: body,
    classifier_class: classification?.class ?? null,
    classifier_confidence: classification?.confidence ?? null,
    previous_state: previousState ?? null,
  });

  if (slackOps && env.SLACK_CHANNEL_ID) {
    const blocks = buildEscalationBlocks({
      escalation_id: escId,
      kommun_namn: conv.kommun_namn,
      from_email: parsedInbound?.from ?? '(no inbound — proactive draft)',
      reply_text: parsedInbound?.body ?? '(no inbound)',
      draft_reply: `Subject: ${subject}\n\n${body}`,
      gmail_thread_id: conv.gmail_thread_id ?? '(no thread)',
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

export async function runTick(deps) {
  const { db, gmailClient, gmailOps, env, now } = deps;

  // 1. Initial dispatch — anything scheduled for now or earlier
  const dueInitial = db.listConversationsDueForInitialSend(now.toISOString());
  for (const conv of dueInitial) {
    await dispatchInitial(conv, deps);
  }

  // 2. Inbound processing — fetch new messages on tracked threads
  const active = db.listAllConversations().filter((c) => c.gmail_thread_id);
  for (const conv of active) {
    const list = await gmailOps.listInboundQuery(
      gmailClient.gmail,
      `to:${env.GMAIL_USER_EMAIL} -from:${env.GMAIL_USER_EMAIL} newer_than:7d`
    );
    for (const m of list) {
      if (db.hasGmailMessageId(m.id)) continue;
      const full = await gmailOps.getMessage(gmailClient.gmail, m.id);
      if (!full) continue;
      const parsed = parseInboundMessage(full);
      // Associate the message with this conversation by Gmail thread OR by
      // sender domain == the kommun's contact domain. Kommuner often forward or
      // reply with a changed subject, which Gmail threads separately; matching
      // on thread alone silently dropped those (incl. delivered contracts).
      const threadMatch = full.threadId === conv.gmail_thread_id;
      const domainMatch = sameEmailDomain(parsed.from, conv.contact_email);
      if (!threadMatch && !domainMatch) continue;

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

      const isCloser = /samtliga avtal/i.test(parsed.body);
      const transition = nextActionForClassification(conv.state, classification.class, {
        receipt_sent: !!conv.receipt_sent, is_closer: isCloser,
      });

      const sig = extractSignature(parsed.body);
      const messageId = db.recordMessage({
        conversation_id: conv.id, gmail_message_id: m.id, direction: 'inbound',
        from_email: parsed.from, to_email: parsed.to,
        subject: parsed.subject, body_text: parsed.body,
        classification: classification.class, classification_confidence: classification.confidence,
        received_at: now.toISOString(), attachment_count: parsed.attachments.length,
        signature_extracted: sig,
        analysis_json: analysis ?? null,
      });

      // Save attachments
      for (const att of parsed.attachments) {
        if (att.mime_type !== 'application/pdf' && !att.filename?.toLowerCase().endsWith('.pdf')) continue;
        const buf = await gmailOps.fetchAttachment(gmailClient.gmail, m.id, att.attachment_id);
        const saved = await saveAttachment(buf, {
          kommun_kod: conv.kommun_kod, kommun_namn: conv.kommun_namn, role: conv.role,
          received_at: now.toISOString(), from_email: parsed.from, from_name: null,
          gmail_message_id: m.id, gmail_thread_id: parsed.gmail_thread_id,
          subject: parsed.subject, original_filename: att.filename, mime_type: att.mime_type,
        }, { baseDir: deps.contractsDir });
        db.recordAttachment({
          message_id: messageId, filename: att.filename,
          saved_path: saved.saved_path, mime_type: att.mime_type, size_bytes: saved.size_bytes,
        });
      }

      // State transition is bookkeeping — happens automatically. Outbound is gated.
      const previousState = conv.state;
      const patch = {};
      if (classification.extracted?.arendenummer) patch.arendenummer = classification.extracted.arendenummer;
      // When the kommun says "we'll get back to you by date X", honor it.
      if (analysis?.follow_up_at) patch.follow_up_at = analysis.follow_up_at;
      db.updateConversationState(conv.id, transition.nextState, patch);
      const updated = db.getConversation(conv.id);

      // Outbound: never auto-sent in v1. Draft a template and escalate to Slack.
      // If the LLM produced a draft_reply, prefer it over the canned template.
      let draftTemplate = null;
      let llmDraft = null;
      if (transition.action === 'send_precision') draftTemplate = 'T_PRECISION';
      else if (transition.action === 'send_receipt' && !updated.receipt_sent) draftTemplate = 'T_RECEIPT';
      else if (transition.action === 'escalate') draftTemplate = 'free_form';

      if (draftTemplate && analysis?.draft_reply) {
        llmDraft = { body: analysis.draft_reply };
      }

      if (draftTemplate) {
        const reason = analysis
          ? `llm intent=${analysis.intent} action=${analysis.suggested_action} confidence=${(analysis.confidence ?? 0).toFixed(2)}`
          : `classifier=${classification.class} confidence=${classification.confidence.toFixed(2)}`;
        await escalateWithDraft({
          conv: updated, parsedInbound: parsed, classification,
          previousState,
          draftTemplate,
          llmDraft,
          reason,
          deps,
        });
      }
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
}

export async function runDailyFollowup(deps) {
  const { db, now, log } = deps;
  const todayIso = now.toISOString().slice(0, 10);
  const all = db.listAllConversations();
  for (const conv of all) {
    const days = daysBetween(new Date(conv.state_changed_at), now);
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
        classification: null,
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
