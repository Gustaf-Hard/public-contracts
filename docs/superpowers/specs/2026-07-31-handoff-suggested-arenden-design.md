# Handoff → suggested ärenden

**Date:** 2026-07-31
**Status:** design, operator-approved (not yet implemented)

## Problem

When a kommun redirects us to another förvaltning, the pipeline stops at a
human. The LLM tags `intent: 'handoff'`, extracts the target address and
förvaltning, opens a `free_form` escalation — and then nothing carries the
redirect forward. The operator has to read the mail, notice the addresses,
go to Översikt, find the kommun, and start each new ärende by hand.

Live example, **Göteborg #63** (`upphandling`). Inköps- och
upphandlingsförvaltningen replied that they hold only the Stad-wide ramavtal
and that local school contracts sit with the förvaltningar. The analysis
already captured everything needed:

```json
"handoff_to_email": "info@educ.goteborg.se;grundskola@grundskola.goteborg.se",
"handoff_to_forvaltning": "Utbildningsförvaltningen och Grundskoleförvaltningen"
```

Both addresses appear **verbatim** in the 4210-character body, and the LLM
picked exactly those two out of the six addresses present. The information is
there; only the plumbing is missing.

The long-term goal is a fully automated loop. This step keeps the human on the
send button so the extraction can be watched in the wild before it is trusted
unattended.

## Goals

- Surface, on the ärende page, one **suggested ärende per extracted address**,
  with enough signal for the operator to judge it at a glance.
- One click starts a suggestion: create the conversation and send T-INITIAL
  through the existing `sendInitial` path.
- Change nothing about what the daemon may send unattended.

## Non-goals

- **No auto-send.** Considered and explicitly rejected by the operator: "I want
  to get these suggested and I trigger the actual send, so we can make sure it
  is correct." Revisit once the extraction has a track record.
- No schema change. Suggestions are derived at read time from
  `messages.analysis_json`; nothing new is stored.
- Not a general contact-discovery feature. If the kommun names a förvaltning
  but no address (5 of the 6 handoffs in the fleet today), nothing is
  suggested — the escalation behaves exactly as it does now.

## Two traps this design exists to avoid

**1. `handoff` is not stored as `handoff`.** `analysisToLegacyClassification`
maps `handoff → 'unknown'` on purpose ("external redirect — escalate to human;
preserved on analysis.intent"). A rule keyed on the `classification` column
would silently never fire. **Read `analysis_json.intent`.**

**2. An `INITIAL` conversation with a due `scheduled_send_at` is auto-sent by
the tick** (`listConversationsDueForInitialSend` → `dispatchInitial`; T-INITIAL
is the one outbound that needs no approval). So "create the ärenden now, send
them later" would hand the send straight back to the daemon. Hence: **no
conversation row exists until the operator clicks.** The suggestion is computed
from the message, not persisted.

## `src/handoff.js` (new, pure — no IO, no DB)

```js
parseHandoffTargets({ analysis, bodyText, homeDomain })
  → [{ email, forvaltning, verbatim, sameDomain, roleSlug }]
```

- Returns `[]` unless `analysis.intent === 'handoff'`.
- **Addresses:** split `extracted.handoff_to_email` on `;`, `,` or whitespace;
  lowercase; drop anything without an `@`; dedupe, preserving order.
- **Förvaltningar:** split `extracted.handoff_to_forvaltning` on `\boch\b` or
  `,`; trim.
- **Pairing:** by index. When the counts disagree, every address carries the
  **full** förvaltning string rather than a guessed label — the address is what
  matters; the label is decoration.
- **`verbatim`:** the address occurs character-for-character (case-insensitive)
  in `bodyText`. This is the hallucination signal: `false` means the LLM
  produced an address the kommun never wrote.
- **`sameDomain`:** dot-anchored match against the kommun's home domain —
  `d === home || d.endsWith('.' + home)`. The bare `endsWith` form is wrong and
  is already called out in CLAUDE.md (it accepts `xvasteras.se`).
  `educ.goteborg.se` and `grundskola.goteborg.se` pass against `goteborg.se`.
- **`roleSlug`:** ASCII-folded first meaningful token of the förvaltning
  (`Utbildningsförvaltningen → utbildning`,
  `Grundskoleförvaltningen → grundskola`), falling back to `handoff`.
  `sendInitial` throws on a duplicate kommun+role, so the caller
  **de-duplicates against roles already used for that kommun**, suffixing
  `-2`, `-3` as needed.

Home domain comes from the kommun record's `webbplats`
(`new URL(webbplats).hostname.replace(/^www\./, '')`) — the same derivation
`crawl.js` uses. No `webbplats` → `sameDomain: false`, never a crash.

## View

`/arenden/:id` gains a **"Föreslagna ärenden"** panel, rendered from the **most
recent inbound message whose `analysis_json.intent === 'handoff'`** (newest
wins; an older handoff that has been superseded by a later redirect is not
re-suggested). One row per target:

| | |
|---|---|
| address | `info@educ.goteborg.se` |
| förvaltning | Utbildningsförvaltningen |
| badges | `✓ står i mejlet` / `⚠ hittades inte i mejlet`; `✓ kommunens domän` / `⚠ annan domän` |
| action | **Skicka** button |

The badges are **shown, not enforced**. The operator is the gate, so their job
is to make a wrong extraction obvious at a glance rather than to block it. A
row whose kommun+role is already taken renders its resolved role so the
operator can see which ärende they are about to create.

Uses the existing `data-row-form` pattern (2026-07-31 Skicka fix), so a started
suggestion updates its own row without reloading the page.

## Route

`POST /arenden/:id/handoff-start`, body `email` only.

- Re-derives the targets server-side from the stored message and **rejects any
  email not in that set** (`400`) — the form is a convenience, not the
  authority. A hand-crafted POST cannot mail an arbitrary address.
- `forvaltning` and `role` are taken from the **re-derived** target, never from
  the request body, so a tampered form cannot pick the role either.
- Delegates to `sendInitial({ db, gmail, env, kommun_kod, kommun_namn, role,
  contact_email, subject, body })` with the standard `renderInitialDraft`
  T-INITIAL. That keeps the two-phase `INITIAL → SENDING → SENT` claim, the
  `NEEDS_HUMAN` parking on failure, and the message/thread recording exactly as
  the one-click Skicka path has them.
- Sits behind the existing `requireAuth` + `requireOriginToken` middleware like
  every other POST.
- Answers `204` to an `X-Partial` fetch, `302 /arenden/:id` otherwise (the same
  content negotiation as `quick-init`).
- `INITIAL_CLAIM_LOST` / "already exists" are benign no-ops → same response as
  success, no double-send.

## Data honesty & safety

- **Nothing is created until the operator clicks.** No parked rows, so the
  daemon cannot auto-send a suggestion.
- **The send path is unchanged.** `sendInitial` is reused verbatim; no new
  outbound path, no bypass of the atomic claim.
- **The address must come from the kommun.** The route validates against
  re-derived targets; the `verbatim` badge shows whether the kommun actually
  wrote it.
- **Absent evidence is shown as absent.** No address extracted → no panel, no
  invented suggestion. The escalation behaves as today.

## Testing

- `tests/handoff.test.js` (pure): the Göteborg fixture splits into two targets
  with the right förvaltning each; non-handoff intents yield `[]`; a single
  address with prose förvaltning; mismatched counts keep the full label;
  `verbatim` false when the address is absent from the body; `sameDomain`
  rejects `xgoteborg.se` and accepts `educ.goteborg.se`; role slugs derive and
  de-duplicate.
- `tests/dashboard.test.js`: the panel renders for a handoff ärende and not
  otherwise; the badges reflect the flags; `POST …/handoff-start` with an email
  outside the derived set is **rejected** without sending; a valid POST calls
  `sendInitial` once (Gmail faked via `vi.spyOn(gmailMod, 'sendMessage')`).
- All offline: temp-dir SQLite, fixture analysis JSON, no live DB.

## Rollout

Deploy, then use **Göteborg #63** as the live check: the panel should offer
`info@educ.goteborg.se` (Utbildningsförvaltningen) and
`grundskola@grundskola.goteborg.se` (Grundskoleförvaltningen), both `✓✓`.
Starting them creates roles `utbildning` and `grundskola` alongside the
existing `upphandling`.

## Known follow-ups (out of scope here)

- After the reply is sent, #63 restores to `ACK_RECEIVED` and will nudge
  Göteborg upphandling in 14 days, though they have said they hold nothing.
  A handoff that has been acted on arguably belongs in `DONE`.
- 5 of 6 fleet handoffs name a förvaltning with **no** address. Matching those
  against the kommun's own `contacts` list would extend coverage, but it is
  contact-discovery, not this feature.
- Auto-send, once the `verbatim` + `sameDomain` signals have a track record.
