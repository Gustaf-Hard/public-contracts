# Auto-send delay acks + answered-clarification nudges (second graduation)

**Date:** 2026-08-20
**Status:** Approved by operator (2026-08-19/20 conversation)
**Predecessors:** `2026-08-17-auto-send-followup-nudge-design.md` (first
graduation, kill switch, `auto_send` decision, Auto-skickade feed),
`2026-07-05-autopilot-readiness-review.md` (safety invariants).

## Goal

Two independent widenings of the unattended-send surface, both riding the
2026-08-17 rails unchanged (same kill switch, same `sendApprovedReply` path,
same `auto_send` decision value, same fail-closed posture):

1. **`T_DELAY_ACK` auto-send.** The fixed 28-word "Tack för ditt svar! Då
   avvaktar vi så länge…" acknowledgement of a kommun's delay promise may go
   out unattended — but only behind a guard stack derived from reading every
   live trigger mail (2026-08-19 evaluation of the 51 open escalations).
2. **Answered-clarification nudges.** `isLazyConversation` widens so a
   conversation whose only substantive inbound is a `clarification` **we
   already answered** still qualifies for the auto-nudge (live cases:
   Jönköping conv 23, Burlöv conv 36 — both fully lazy since our precision
   reply, both currently bounced to manual).

## Evidence

The 2026-08-19 evaluation of the open queue (fresh box-DB snapshot):

- **T_DELAY_ACK** is a deterministic template (no LLM prose, no dates, no
  claims). The ledger shows the last 3 operator sends went out byte-identical;
  earlier edits were all against the OLD dated wording that `9e06a5f` removed.
- Of 14 open delay-ack triggers, 11 were textbook "vi återkommer" prose. The
  3 exceptions define the guards:
  - **Borås (conv 26):** a full contract table pasted in the mail body
    (`911 000,00 kr` …) misclassified `delay_promise` @ 0.85 → **body-shape
    gate** (currency/tabular content) and stored-attachment gate.
  - **Eslöv (conv 46):** "lägga dom i receptionen … för dig att hämta" —
    needs a real answer, not an ack → **pickup-language gate**.
  - **Örebro (conv 21):** a Servicecenter autoresponder classified
    `delay_promise` @ 0.95. The ack itself is harmless, but an autoresponder
    answering our ack could loop → **lifetime cap** (max 2 auto delay-acks
    per conversation) bounds the worst case at 2 pointless mails.
- **Jönköping/Burlöv:** every inbound after our last outbound is in the LAZY
  set with zero stored attachments; the only non-lazy inbound is a
  `clarification` that our own later outbound answered. The generic nudge
  text ("Jag vill bara följa upp om min begäran … Behöver ni ytterligare
  information från min sida?") stays truthful in that history.

## Part 1 — T_DELAY_ACK auto-send

### Where it happens

Drafting is **unchanged**: `dispatchEscalationForIngest` (tick.js) creates the
T_DELAY_ACK escalation at ingest, exactly as today, visible in
Slack/dashboard the moment it exists.

Sending happens in **`runDailyFollowup`**, as a new sweep phase that runs
AFTER the staleness-drafting loop (so a conversation swept this run was
already skipped by `hasActiveEscalation` in the loop — no same-run
interleaving to reason about). Rationale for daily rather than at-ingest:

- The ack goes out mid-morning like a person clearing their inbox, not 15
  minutes after every kommun mail like an autoresponder.
- All unattended sends stay in ONE place with ONE precompute-then-verify
  surface (the pattern proven on 2026-08-19: 7/7 predicted = sent).
- The `STALE_ESCALATION` guard gets real work: a newer inbound overnight
  blocks the send (substantive replies additionally auto-void the draft at
  ingest, superseding it out of the sweep entirely).
- `runDailyFollowup`'s existing gates come for free: tick-health (never send
  from a blind DB) and the vacation window (the sweep is skipped while
  `isInVacation`, like the drafting loop — drafts stay open for the operator).

The sweep enumerates `db.listEscalationsByStatus('open')` filtered to
`draft_template === 'T_DELAY_ACK'` and applies the eligibility predicate to
each; qualifying ones go to `sendApprovedReply` with `decision: 'auto_send'`
and the draft exactly as escalated. Per-escalation try/catch identical to the
nudge auto-send (truthful catch log reading the status back; no retry, no
status mutation; remaining escalations still processed).

### Eligibility — `isAutoSendableDelayAck` (pure, conversation.js)

An open T_DELAY_ACK escalation auto-sends only when **all** hold. Every rule
carries the live mail that motivated it; every unknown fails closed.

1. **Kill switch:** `"T_DELAY_ACK"` ∈ `auto_send_templates` (checked in the
   sweep, from the same fresh `loadAutoSendTemplates` read the run already
   does; the predicate itself does not read disk).
2. **Template + status:** `draft_template === 'T_DELAY_ACK'`, `status ===
   'open'`. Never `free_form`, never a parked row.
3. **Classifier:** `classifier_class === 'delay_promise'` AND
   `classifier_confidence >= 0.85` (`DELAY_ACK_AUTO_MIN_CONFIDENCE`). NULL
   class or NULL confidence → manual (fail closed). Hudiksvall's 0.65-grade
   uncertainty stays human.
4. **Freshness:** escalation `created_at` is within **48 hours** of `now`
   (`DELAY_ACK_AUTO_MAX_AGE_HOURS = 48`). This is the rollout guard: the 14
   delay-ack drafts already open on deploy day — including Borås and Eslöv —
   NEVER auto-send; only drafts minted after the feature ships qualify. It
   also permanently bounds "a draft sat unseen for a week, then left by
   itself". `created_at` is SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS",
   UTC) — normalise exactly like `retryUnpostedEscalations` does; an
   unparseable timestamp fails closed (manual).
5. **Trigger identity:** the escalation's `message_id` resolves to an inbound
   message in the conversation, and that message is the **newest inbound**
   (`received_at` strictly greatest; ties → manual). Complementary to
   `STALE_ESCALATION` (which compares against escalation creation time), not
   redundant with it: this one also catches a draft minted after a
   same-timestamp or out-of-order ingest.
6. **Trigger attachments:** the trigger message has zero stored attachments —
   `(stored_attachment_count ?? attachment_count ?? 0) === 0`, the same
   fail-closed chain as `isLazyConversation`. A delay promise carrying a
   document is a delivery in disguise (Borås pattern).
7. **Body shape:** `delayAckBodyGate(trigger.body_text)` (classifier.js)
   passes — see below.
8. **Loop bound:** the conversation has **fewer than 2** prior
   `decision='auto_send'` decisions with `draft_template='T_DELAY_ACK'`
   (`db.countAutoSendDecisions(conversation_id, 'T_DELAY_ACK')`,
   `DELAY_ACK_AUTO_MAX_PER_CONV = 2`). Guards the Örebro autoresponder loop:
   our ack triggers their autoresponder, which classifies `delay_promise`
   again with a fresh promised date (so `hasDelayAckForDate` does not dedupe
   it) — without this cap the pair could exchange one mail per day forever.
   Operator-approved delay acks do not count against the cap; the third and
   later drafts simply escalate as today.

All facts are read fresh at send time from the DB (`db.listMessages(conv.id)`
provides the trigger row with `stored_attachment_count` and the
newest-inbound comparison).

### Body-shape gate — `delayAckBodyGate` (pure, classifier.js)

Operates on `stripQuotedText(body)` — the kommun's new prose only, never our
own words quoted back. Returns `{ ok: boolean, reason: string|null }` so the
sweep can log WHY a draft stayed manual. Blocks when the visible text:

- **contains a currency amount** — `/\d[\d\s.,]*\s?(?:kr|sek)\b|:-\s*(?:$|\s)/i`
  shaped to catch "911 000,00 kr" (Borås) without firing on phone numbers
  ("0472-15067" has no currency token). Reason `currency`.
- **contains pickup/paper-delivery language** —
  `/\bhämta[sr]?\b|\breception(en)?\b|\bavhämt/i` (Eslöv: "lägga dom i
  receptionen … för dig att hämta"). Reason `pickup`.
- **talks about attachments** — `/\bbifoga[rtd]?\b|\bbifogat\b|\bbilag(a|an|or|orna)\b/i`
  — a mail that says "se bifogade avtal" is a delivery whatever the
  classifier thought, and if ingest stored nothing for it, that mismatch is
  precisely a case for a human. Reason `attachment_language`.
- **is too long** — more than **200 words** of visible text
  (`DELAY_ACK_AUTO_MAX_WORDS = 200`). Backstop for pasted lists/tables that
  dodge the currency pattern. Generous on purpose: Swedish kommun signatures
  and GDPR boilerplate live in the visible text (Haninge, Håbo) and must not
  push a genuine two-line promise over the edge. Reason `too_long`.
- **is empty** — no visible text at all is unclassifiable, not lazy. Reason
  `empty`.

The gate is deliberately a blocklist, not an allowlist of "promise phrases":
T_DELAY_ACK's body makes no claim about what the kommun said, so a
false-negative (guard too strict) costs one manual approval, while a
false-positive costs an inappropriate outbound. Tune only with ledger
evidence.

### What the send inherits (unchanged, for the record)

- `sendApprovedReply` decision `'auto_send'`: atomic `open → sending` claim,
  `STALE_ESCALATION` (fires for `auto_send` since the 2026-08-17 widening),
  `STALE_INGEST` (T_DELAY_ACK is not in `STALE_SENSITIVE_TEMPLATES`, and the
  run is already tick-health-gated — belt and suspenders), thread routing,
  decision recording, inbox archiving.
- Refusal before the claim → escalation stays `open`, operator's queue.
- Gmail failure → parked `send_failed`, never retried.
- A substantive kommun reply between draft and sweep → auto-void at ingest
  supersedes the draft; machine traffic leaves it open and
  `STALE_ESCALATION` refuses (the ack would be answering the wrong mail).

### Kill switch

Same file, same key, new value:

```json
{ "auto_send_templates": ["T_FOLLOWUP_NUDGE", "T_DELAY_ACK"] }
```

Read fresh at the start of every `runDailyFollowup` (existing behaviour).
Ships OFF (the committed file lists neither); the operator adds the value in
`/var/lib/mediagraf/pilot-overrides.json` on the box. Removing
`"T_DELAY_ACK"` stops the next run without a restart and without touching the
nudge graduation.

## Part 2 — answered-clarification nudges

`isLazyConversation(messages)` (conversation.js) widens from "every inbound
is LAZY" to:

1. Every inbound is classified in `AUTO_SEND_LAZY_CLASSIFICATIONS` **or** is
   `'clarification'`. Everything else (delivery, dead_end, bounce, unknown,
   NULL) still fails the whole conversation — unchanged.
2. Every `clarification` is **answered**: at least one outbound message has
   `received_at` strictly after it. An unanswered question must never draw a
   generic "har ni haft möjlighet att titta på detta?" — that is the operator
   drafting a real reply, exactly as today. A conversation with a
   clarification and no outbound at all fails.
3. Every inbound still has zero stored attachments — the conversation-wide
   condition is **unchanged and deliberately NOT relaxed** to
   since-last-outbound: a stored attachment anywhere means the kommun
   delivered something, and "jag vill följa upp" would misdescribe the state
   whatever came after. Same for a body-text delivery (`delivery`
   classification with zero attachments, the Bjuv shape): `delivery` is not
   in the widened set, so it still fails conversation-wide.

The signature and call site (`runDailyFollowup` nudge auto-send) are
unchanged — `db.listMessages(conv.id)` already contains outbound rows with
`received_at`. The fail-closed `stored ?? raw ?? 0` chain is unchanged.

Effect on live data (verified against the 2026-08-19 snapshot): Jönköping
(conv 23) and Burlöv (conv 36) become auto-eligible once their currently-open
manual drafts are cleared; no other open conversation changes bucket.
`AWAITING_PRECISION` conversations can now qualify too (their `clarification`
is answered by the precision reply that put them in that state) — their nudge
threshold stays fixed 10 days, no jitter, per the 2026-08-17 spec.

## Visibility — Auto-skickade feed carries the trigger

The 2026-08-19 evaluation's one real cost of automating delay acks: the
operator stops reading the triggers. The mitigation is that the feed shows
what was answered:

- `listAutoSendDecisions` (storage.js) additionally joins
  `escalations → messages` (via `d.escalation_id`, `e.message_id`) and
  returns `trigger_from` (`m.from_email`) and `trigger_snippet`
  (`substr(m.body_text, 1, 160)`), both NULL for proactive drafts (nudges
  have `message_id` NULL).
- The `/arenden` Auto-skickade table shows the snippet (escaped, truncated by
  the view) under the kommun row, and the "Påminnelse" column renders `—`
  for non-nudge templates instead of a misleading "N av 2".

## Out of scope (explicit)

- Auto-sending T_RECEIPT (next candidate; revisit with the neutral-variant
  ledger), T_CROSSCHECK (zero sends observed, and it closes the case),
  T_PRECISION, T_REQUEST_MISSING, free_form, bounce resends, T_UPDATE.
- Widening `AUTO_SEND_LAZY_CLASSIFICATIONS` itself (`unknown` stays manual).
- Any change to drafting, `hasDelayAckForDate`, `MAX_NUDGES`, or thresholds.
- Persisting `Auto-Submitted`/`Precedence` headers (would sharpen the Örebro
  guard; the loop cap covers the risk at 2 mails — revisit only if the cap
  is ever hit in the ledger).
- Slack notifications (still no Slack on the box).

## Testing (offline, existing fakes — extend `tests/auto-send-nudge.test.js`
patterns into a new `tests/auto-send-delay-ack.test.js`)

1. Eligible: open T_DELAY_ACK, `delay_promise` @ 0.9, fresh (created now),
   trigger = newest inbound, zero stored attachments, short clean body,
   switch on → exactly one Gmail send, escalation `resolved_send`, decision
   `auto_send` with `draft_template = 'T_DELAY_ACK'`.
2. Each guard in isolation blocks (escalation stays `open`, zero sends):
   confidence 0.65; class NULL; created 3 days ago (the deploy-backlog case);
   a newer inbound than the trigger; trigger stored attachment; currency
   body; pickup body; attachment-language body; >200-word body; empty body;
   switch lists only `T_FOLLOWUP_NUDGE`; malformed overrides file.
3. Loop bound: two prior auto_send T_DELAY_ACK decisions → third stays open;
   two prior OPERATOR sends (decision `edit`) → does NOT count, still sends.
4. Gmail failure → `send_failed`, no decision row, next run does not retry.
5. Sweep ordering: a conversation whose delay ack is swept does not also
   receive a nudge draft in the same run.
6. Vacation window → sweep skipped, draft stays open. Stale tick health →
   whole run (including sweep) deferred (existing gate).
7. `isLazyConversation`: answered clarification (clarification → outbound →
   auto_ack) → true; unanswered clarification (clarification is last) →
   false; clarification + zero outbound → false; answered clarification but
   a stored attachment on any inbound → false; `delivery` anywhere → false.
   End-to-end: the Jönköping shape auto-sends a nudge; the same shape with
   the clarification last stays manual.
8. `delayAckBodyGate` unit: Borås-style table body → `currency`;
   Eslöv-style → `pickup`; "se bifogade avtal" → `attachment_language`;
   200+ words → `too_long`; a two-line promise with signature + GDPR
   boilerplate → ok; our own quoted text containing "kr" below a `Från:`
   marker → ok (quote-stripped).
9. Feed: `listAutoSendDecisions` returns `trigger_from`/`trigger_snippet` for
   a delay-ack decision and NULLs for a nudge decision; `renderArenden` shows
   `—` in the Påminnelse column for T_DELAY_ACK rows and renders the snippet
   escaped.
