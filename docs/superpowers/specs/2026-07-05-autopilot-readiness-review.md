# Autopilot-readiness review — 2026-07-05

Adversarial full-spectrum review of the pilot runtime against the north star: a
self-driving, perpetually self-refreshing market-intelligence engine over 290
kommuner, human-by-exception only. Reviewed: all `src/` runtime modules,
`scripts/pilot-*.js`, all specs/plans, the full offline test suite (309 tests,
all green), and the live `data/pilot.db` (read-only; 14 conversations, 59
messages, 9 escalations, 3 decisions, 53 stored contracts at review time).

All kommun email addresses and registrator names are redacted as `<email>` /
`<registrator>`. Kommun names and conversation/escalation row IDs are retained
as evidence pointers.

---

## Executive verdict

The pilot is a well-instrumented human-in-the-loop drafting machine, but it is
roughly **two safety layers and one lifecycle layer away from autopilot**. The
FSM, LLM analysis, contract extraction, and escalation UX are real and working
in production; what is missing is exactly the part autonomy depends on: the
hard invariants. The top three blockers: **(1) the send path is not idempotent
or race-safe** — the Slack approve handler has no "is this escalation still
open?" guard and the Slack message keeps its live buttons after resolution, the
send-then-record ordering means any crash between Gmail accept and the SQLite
write re-sends on the next tick, and overlapping cron ticks (unbounded tick
duration due to inline Opus PDF analysis) can double-dispatch T-INITIAL — so
the single most important invariant, *never double-message a kommun*, does not
hold today; **(2) the "at most one open escalation per conversation" invariant
from the 2026-06-23 spec is enforced nowhere** and is already violated in the
live DB (conversation 4 had three escalations open simultaneously), while the
daily follow-up loop will mint a duplicate draft every single day it goes
unapproved; and **(3) graduation has produced zero signal and collection is
terminal** — the decisions log holds 3 rows, all `edit`, none
`approve_unmodified` (spec requires ≥5 consecutive unmodified per
(class, state) pair), four of nine escalations were bulk-`resolved_closed`
without any decision row at all, and although `contracts.period_end` is
populated (25 of 53 stored contracts are *already expired*), nothing in the
system reads it — a conversation reaching DONE is the end of the story, the
opposite of a living dataset.

---

## Ranked findings

| # | Sev | Dimension | Finding | Evidence |
|---|-----|-----------|---------|----------|
| C1 | Critical | Safety | Slack approve path: no `status='open'` guard, no message update after resolve → double-click / stale click / Slack retry double-sends; also races the dashboard approve | `daemon.js:87-109` vs guard at `dashboard.js:803`; no `chat.update` anywhere in `src/` |
| C2 | Critical | Safety | Send-then-record crash window: Gmail send succeeds, process dies before `updateConversationState` → conversation still due → next tick re-sends. Failed dashboard `sendInitial` is worse: the INITIAL row is left due, so the tick later auto-sends the *canned* template without human intent | `tick.js:35-41`; `send-reply.js:100-116` |
| C3 | Critical | Safety | Overlapping ticks: `node-cron` fires `tickOnce` every 15 min with no overlap mutex; tick duration is unbounded (inline Opus analysis of up to 17 PDFs per message + Haiku per inbound) → two concurrent `runTick`s both read `listConversationsDueForInitialSend` → double T-INITIAL | `daemon.js:66-71`; `tick.js:113-116, 258-260`; msg id 38 has `attachment_count=17` |
| H1 | High | Safety/Correctness | "At most one open next-action per conversation. Always" (spec) enforced nowhere; `runDailyFollowup` drafts a new escalation *every day* while stale, `escalateWithDraft` never checks for an existing open one | Spec `2026-06-23-trustworthy-next-action-design.md:19`; `tick.js:52-107, 312-346`; DB: conv 4 escalations 4, 5, 7 concurrently open 2026-06-23→06-29; co-arriving msgs 32+33 → escalations 4+5 six seconds apart |
| H2 | High | Safety/Correctness | Inbound mis-routing: first-conversation-wins domain matching. With two conversations on one kommun (central + utbildning share a domain — the planned rollout shape), a reply on conv B's Gmail thread domain-matches lower-id conv A first and is permanently recorded there (`hasGmailMessageId` then blocks the correct match) | `tick.js:137-147`; deferral admitted in `2026-07-03-conversation-threads-and-recipients-design.md` |
| H3 | High | Recovery | Fetch window is a hard-coded `newer_than:30d`, not derived from `last_success_at` as the 2026-06-23 spec explicitly requires. Outage >30 days = silent permanent inbound loss; the 7d variant already lost a delivery once (Alingsås, 11 Jun) | `tick.js:123-125` (comment even cites the spec); `2026-06-23…design.md:53`; `gmail.js:186-190` |
| H4 | High | Data integrity | No transaction around per-message ingest: crash after `recordMessage` but before attachment save / escalation → PDFs and the human action are lost forever (`hasGmailMessageId` skips the message on every future tick) | `tick.js:182-229` ordering; no `db.transaction` in `storage.js` |
| H5 | High | Safety | Unmatched inbound is invisible: a message matching no conversation (kommun replies from a different domain in a new thread — shared registratur / kommunalförbund setups exist in the data) is never recorded, never escalated, re-fetched every tick. Violates "never lose an inbound" | `tick.js:130-147`; vendor row 19 "Göteborgsregionens kommunalförbund" shows multi-org handling in the wild |
| H6 | High | Security | Dashboard has zero authentication and binds all interfaces: anyone on the LAN can send email as the operator (`POST /escalations/:id`, `POST /kommun/:kod/init`) and read the full correspondence + PII | `dashboard.js:798-914, 923-931` |
| H7 | High | Safety | Dashboard approve race: `esc.status !== 'open'` is a read-then-act check; the `await sendApprovedReply` yields the event loop, so two concurrent POSTs both pass the check → double send. Needs an atomic claim (`UPDATE escalations SET status='sending' WHERE id=? AND status='open'`, assert `changes()==1`) | `dashboard.js:801-838` |
| M1 | Medium | Tests | `runDailyFollowup` has **zero** tests (imported, never invoked) — the entire staleness/nudge path incl. its duplicate-escalation behavior is untested; the daemon's Slack interactivity handler (the unguarded approve) also has no test | `tests/tick.test.js:7` (import only); no test file for `daemon.js` |
| M2 | Medium | Correctness | `received_at` stores *processing* time, not the email's Date/internalDate. The post-outage backlog was stamped 2026-06-23 though delivered ~11 Jun → corrupts follow-up math (`days_since_last_outbound`), activity feed, thread ordering, reply-time stats | `tick.js:187`; DB: 5 inbound all stamped 06-23 13:45–20:06 |
| M3 | Medium | Graduation | Decision-signal leaks: `resolved_closed` writes no decision row (4 of 9 escalations ended that way, all on 2026-07-04 08:22); `decisions.conversation_state` is captured at *approval* time, not draft time, though the FSM auto-advances in between; follow-up escalations carry `classifier_class=NULL` so they can never form a graduating pair | `dashboard.js:867-870`; `send-reply.js:64-74`; DB decisions: 3 rows, states/classes as shown in §6 |
| M4 | Medium | Correctness | HTML-only inbound parses to an empty body (`walkParts` collects only `text/plain`) → LLM analysis skipped (`analyseMessage` returns null on empty), regex classifier sees "" → `unknown` → needless NEEDS_HUMAN; delivery bodies lose their text | `gmail.js:93-111`; `analyse-message.js:160` |
| M5 | Medium | Correctness | Watchlist blind spot: once `receipt_sent=1`, a later delivery yields `action:'none'` → no escalation → a watchlisted vendor (Binogi/NE/ILT/Magma) arriving in a second batch is never flagged; it is only analysed silently in step 3 | `conversation.js:27-30`; `tick.js:244-247, 257` (watchlist check only in the `T_RECEIPT` branch) |
| M6 | Medium | Architecture | Inline contract analysis (Opus, per-PDF, serial) inside the inbound loop makes tick latency unbounded — minutes per delivery — directly amplifying C3; step-3 analysis also reruns serially every 15 min | `tick.js:257-277, 302-309`; `analyse-contract.js:142-175` |
| M7 | Medium | Correctness | `scripts/pilot-resolve.js` is a third, drifted copy of the approve path: it sends to `conv.contact_email` on `conv.gmail_thread_id`, bypassing `resolveReplyRecipient` — exactly the mis-routing the 2026-07-03 spec fixed elsewhere | `scripts/pilot-resolve.js:51-57` vs `send-reply.js:20-26` |
| M8 | Medium | Ops/PII | LLM system prompt hardcodes the operator's personal Gmail address and full name as the draft signature — bypasses `GMAIL_FROM_NAME`/`GMAIL_USER_EMAIL`; drafts sign the wrong identity if the sender changes; personal PII baked into source | `analyse-message.js:18, 43` |
| M9 | Medium | Correctness | `isCloser = /samtliga avtal/i` on the whole body: a kommun reply *quoting our own receipt question* ("Är detta samtliga avtal…?") combined with a dead_end classification in DELIVERING closes the case DONE | `tick.js:169`; `conversation.js:6-10`; our own T_RECEIPT contains the phrase (`templates.js:70`) |
| M10 | Medium | Correctness | `follow_up_at` is never cleared and `effectiveFollowUp` checks it *before* terminal states → DONE cases still show a live kommun-promise date | `conversation.js:54-58`; DB: convs 2,3,4,5 are DONE with `follow_up_at` 2026-06-19…07-07 |
| M11 | Medium | Data integrity | Attachment filename collision inside one message: two same-named PDFs (e.g. zip subfolders `a/avtal.pdf`, `b/avtal.pdf` both flatten to `avtal.pdf`) overwrite the same path; two DB rows point at one file | `attachments.js:20-22, 44-51` (filename = date + message id + safe name only) |
| M12 | Medium | Ops | OAuth tokens are loaded once and refreshed tokens never persisted (no `tokens` event listener); no automated recovery or alert path for `invalid_grant` — the known ~15-day outage was only visible as a dashboard pill | `daemon.js:17-21`; `dashboard-views.js:583-585` |
| M13 | Medium | Architecture | Top-level docs are stale/wrong: `CLAUDE.md`/`README.md` describe only the Phase-1 collection pipeline ("no database", "65 tests" — actual: SQLite runtime, 309 tests); `dashboard-views.js` is a 1,575-line HTML-in-JS monolith; `store.js` vs `storage.js` naming trap; one-off scripts (`backfill-vasteras.js`, `05-backfill-threads.js`) accumulate unlabelled | `CLAUDE.md`; `wc -l src/dashboard-views.js` = 1575 |
| L1 | Low | Ops | Slack handler acks 200 before doing the work — an approve click is silently lost if the daemon dies mid-processing (and Slack won't retry after the ack) | `daemon.js:82` |
| L2 | Low | Correctness | `sameEmailDomain` is exact-match only — a reply from `utbildning.<kommun>.se` when the contact is `@<kommun>.se` does not domain-match (thread match is then the only association) | `gmail.js:148-152` |
| L3 | Low | Security | OAuth flow has no `state`/PKCE; localhost-only redirect mitigates but a CSRF'd code injection into the waiting listener is possible | `gmail-auth.js:29-76` |
| L4 | Low | Correctness | `clarification` while DELIVERING is silently swallowed (`action:'none'`) — a real question from the registrator mid-delivery gets no draft and no escalation | `conversation.js:21-24` |
| L5 | Low | Perf | Unmatched inbound (spam, newsletters, out-of-scope senders) is full-fetched from Gmail on *every* tick forever, since only recorded messages are skipped | `tick.js:129-135` |
| L6 | Low | Data quality | No content-hash dedup of received PDFs: the same contract re-sent in a later batch becomes a second `contracts` row and double-counts market stats (suspect pairs already present: rows 13/14 Unikum and 20/21 Nova Software with identical vendor+period) | `storage.js:425-443`; DB contracts 13/14, 20/21, 52-55 |

**Counts: 3 Critical, 7 High, 13 Medium, 6 Low — 29 findings.**

---

## 1. Autopilot-safety invariants

The 2026-05-18 design states the core invariant as "all Gmail message IDs are
written to SQLite atomically before the bot considers itself done" — that
covers *re-reading*, but nothing covers *re-sending*:

- **Double-message via crash (C2).** `dispatchInitial` sends first
  (`tick.js:35`), records after (`tick.js:38-48`). Gmail accepting + process
  death before the UPDATE leaves `state='INITIAL'`, `scheduled_send_at` in the
  past → the next tick (15 min later, or after restart) sends again. Same
  window in `sendInitial` (`send-reply.js:107-116`), with the extra failure
  mode that a *failed* send leaves a due INITIAL row that the tick will later
  dispatch with the un-edited canned template — an automated send the human
  never approved. Fix: two-phase send — mark the intent
  (`state='SENDING'`, or a `sends` outbox row) in the same transaction that
  claims the row, then send, then finalize; on restart, `SENDING` rows escalate
  to a human instead of re-sending.
- **Double-message via Slack (C1).** `daemon.js:91-92` calls
  `sendApprovedReply` without checking `esc.status`. The Slack message's
  Approve button stays live forever (no `chat.update` after resolution), so a
  second click days later — or Slack's automatic retry of a timed-out
  interaction — re-sends. The dashboard path *does* guard
  (`dashboard.js:803`) but non-atomically (H7): both surfaces need an atomic
  claim: `UPDATE escalations SET status='sending' WHERE id=? AND
  status='open'` and abort unless `changes()===1`, plus `chat.update` to strip
  the buttons on resolution.
- **Double-message via overlapping ticks (C3).** `cron.schedule` does not
  serialize async callbacks. A tick that ingests a delivery now does per-PDF
  Opus calls inline (`tick.js:258-260`) — message 38 carried 17 attachments —
  so a >15-minute tick is realistic. Two concurrent `runTick`s both see the
  same due-initial rows and the same unrecorded inbound. Fix: an in-process
  `isTicking` latch at minimum; a DB-level tick lease if a second process is
  ever possible (the dashboard already opens the same DB read-write).
- **Send on stale state.** `sendApprovedReply` never re-validates that the
  world hasn't moved since the draft was created: no check that a newer
  inbound arrived, no check that `conv.state` still matches
  `esc.previous_state`. An operator approving a 5-day-old T_FOLLOWUP_NUDGE
  after the kommun already delivered sends a nudge into a DELIVERING
  conversation. Fix: staleness check at send time (compare
  `esc.created_at` against the conversation's latest inbound `received_at`;
  block or re-confirm).
- **Mis-routing (H2)** and **lost inbound (H5)** are detailed in §2/§3.

Live-DB invariant check: `SELECT conversation_id, count(*) FROM escalations
WHERE status='open' GROUP BY 1 HAVING count(*)>1` → empty *today* (one open
escalation total), but the history shows the invariant broke in June:
escalations 4 (`free_form`, created 06-12), 5 (`T_RECEIPT`, 06-12) and 7
(`T_RECEIPT`, 06-23) for conversation 4 (Ale) were simultaneously open until
06-29/07-04. The spec's "at most one open next action per conversation.
Always" is aspirational text, not code.

## 2. Correctness bugs

- **First-conv-wins routing (H2).** `tick.js:137-147` iterates conversations
  in id order and takes `threadMatch || domainMatch`. All conversations for a
  kommun share a domain, so once a kommun has both `central` and `utbildning`
  cases, *every* reply — including one squarely on conv B's Gmail thread —
  matches conv A first, gets recorded there, and `hasGmailMessageId` prevents
  the correct association forever. The 07-03 spec defers this, but the pilot
  ramp makes it imminent. Fix: two passes — thread matches first across all
  conversations, then domain matches only for messages still unclaimed; on
  domain-match ambiguity (2+ candidate conversations), escalate instead of
  guessing.
- **Empty bodies from HTML-only mail (M4).** `walkParts` collects only
  `text/plain` parts; many kommun mail systems send HTML-only. Result: LLM
  analysis skipped entirely (`analyseMessage` bails on empty), regex
  classifier sees an empty string → `unknown` → NEEDS_HUMAN noise, and the
  operator sees a blank "Inkommande" in Slack. Fix: fall back to
  `text/html` stripped to text.
- **The closer regex (M9).** `/samtliga avtal/i` (`tick.js:169`) is matched
  against the whole inbound body — which usually *quotes our own receipt*
  ("Är detta samtliga avtal eller är fler på väg?", `templates.js:70`). Any
  reply the LLM calls `dead_end` while DELIVERING then closes DONE off our own
  quoted text. The stricter classifier pattern
  (`/(detta var |var )samtliga avtal/`, `classifier.js:31`) shows the right
  shape; `is_closer` should come from the LLM analysis, not a substring.
- **staleAction close-loop.** `STALE_RULES.DELIVERING` fires
  `send_followup_close` every day past day 14 with no MAX cap (the
  `MAX_NUDGES` guard applies only to `send_followup_nudge`,
  `conversation.js:84`) — combined with H1 this mints a duplicate close-draft
  daily.
- **`delivery` from terminal states.** `nextActionForClassification` returns
  `DELIVERING` for a delivery in *any* state including DONE/DEAD_END/
  NEEDS_HUMAN (`conversation.js:27-30`). Reopening on late delivery is
  arguably right, but it is undocumented and untested, and it resurrects cases
  the operator explicitly closed.
- **`clarification` in DELIVERING silently dropped (L4).**
- **Recipient routing** in the shared path (`threads.js:8-22`,
  `send-reply.js:20-26`) is correct and tested — but `pilot-resolve.js`
  (M7) bypasses it entirely, and `runDailyFollowup` escalations carry
  `message_id=NULL`, so until a thread is marked `primary` they route to
  `conv.contact_email` even when the whole conversation has moved to a
  handler's direct address.
- **Watchlist matching** (`watchlist.js`) is solid (word-boundary on
  normalized text), but only reachable in the first-receipt branch (M5).

## 3. Data integrity & recovery

- **No transactions.** Per-message ingest is ~6 separate writes
  (`upsertThread`, `recordMessage`, thread status, N×`recordAttachment`,
  state update, escalation) with Gmail/LLM awaits interleaved
  (`tick.js:174-297`). A crash mid-sequence permanently orphans the message
  (H4): recorded → skipped forever → its attachments never fetched, its
  escalation never posted. better-sqlite3 is synchronous; the pure-DB parts
  should be one `db.transaction`, and attachment fetch should happen *before*
  `recordMessage` or be tracked as pending.
- **Outage window (H3).** The spec is explicit: derive the window from
  `getTickHealth().last_success_at`. The code hard-codes `newer_than:30d`
  (`tick.js:125`) with a comment citing the spec it doesn't implement. The
  June `invalid_grant` outage is visible in the live DB as a total inbound
  gap 06-13→06-22 followed by a burst of 5 backlog messages stamped 06-23 —
  recovery worked *this time* because the outage was <30d; a token that dies
  in August while the operator is on vacation loses mail permanently and
  silently.
- **`received_at` is a lie under recovery (M2).** Backlog messages carry the
  processing timestamp, not delivery time. Every downstream computation
  (days-since, ordering, tooltips, thread `last_inbound_at`) is skewed for
  exactly the messages where accuracy matters most. Gmail's `internalDate`
  is available on the fetched message and should be used.
- **WAL / multi-process**: WAL mode is on (`storage.js:150`) and the
  daemon + dashboard concurrently write — WAL makes this safe at the SQLite
  level, but there is no busy_timeout pragma set; a long write from one
  process can surface as `SQLITE_BUSY` throws in the other (currently
  unhandled anywhere).
- **Heartbeat** (`recordHeartbeat`/`getTickHealth`) is good design and the
  dashboard consumes it honestly (stale pill, `invalid_grant` cause text).
- **The `.bak` file** `data/pilot.db.bak-20260704-232517` sits untracked in
  `data/` — fine, but note `data/contracts/` and the DB are correctly
  git-ignored while `data/*.json` (the collection dataset) is committed.

## 4. Architecture & boundaries

- Pure-vs-IO separation is genuinely good in the small modules
  (`conversation.js`, `threads.js`, `watchlist.js`, `templates.js`,
  `classifier.js` are pure and fully tested).
- `tick.js`'s inbound loop is a 160-line function doing matching, LLM calls,
  persistence, attachment IO, contract analysis, and escalation — the exact
  place every Critical/High finding lives. It needs decomposition into
  `matchInbound` (pure), `ingestMessage` (transactional), `decideAction`
  (pure), `dispatchEscalation` (IO).
- **Three copies of the approve/send side-effect logic**: `send-reply.js`
  (canonical), `daemon.js` Slack path (delegates but unguarded),
  `scripts/pilot-resolve.js` (drifted, wrong routing — M7). One of these has
  already diverged; delete or delegate the script.
- `dashboard-views.js` (1,575 lines of template strings) and `dashboard.js`
  (931) dwarf the domain logic; views are untestable except by string-grep.
- **Stale docs (M13)**: `CLAUDE.md` says "No framework, no database … 65
  tests"; reality is Express + better-sqlite3 + a daemon and 309 tests. A
  new contributor (or agent) following CLAUDE.md would not discover the live
  runtime exists except via the specs directory. This review file's very
  location is the only current index of the pilot's design history.
- Dead/one-off code: `scripts/backfill-vasteras.js`,
  `scripts/05-backfill-threads.js` (superseded by `src/backfill-threads.js`
  runner), `ensureLabel`/`addLabel` in `gmail.js` (no callers found).

## 5. Test coverage vs. the invariants

309 tests pass offline; the pure modules and the happy tick paths are well
covered (including zip expansion, watchlist hold, muted-thread suppression,
fetch-once efficiency). The gaps are precisely the safety-critical paths:

- **`runDailyFollowup`: zero tests** (`tests/tick.test.js:7` imports it,
  nothing calls it). Its duplicate-escalation-per-day behavior (H1) would
  have been caught by the first test written against it.
- **`daemon.js`: zero tests.** The unguarded Slack approve (C1), the raw-body
  signature verification wiring, and the ack-then-work pattern are all
  untested. `slack.test.js` tests the pure helpers only.
- **No test for concurrent approves** (H7), crash-ordering (C2/H4), or
  re-entrancy (C3) — these need either injectable clocks/latches or a
  refactor to transactional units first.
- **No test that an unmatched inbound is surfaced** (H5) — currently it
  can't be, since the behavior doesn't exist.
- On the fixture discipline: I found no case of a test being loosened to
  paper over a live change — fixtures are hand-built per behavior and the
  tick tests inject fakes at the right seams. The discipline problem is
  absence, not permissiveness.

## 6. Graduation readiness

Spec bar (`2026-05-18-pilot-automation-design.md:36`): a
`(classifier_class, conversation_state)` pair graduates after **≥5 consecutive
`approve_unmodified` and zero edits**. Live `decisions` table, in full:

| classifier_class | conversation_state | decision | n |
|---|---|---|---|
| (null) | SENT | edit | 1 |
| delivery | DELIVERING | edit | 2 |

- **Zero `approve_unmodified` ever.** Nothing is on the graduation board at
  all; the nearest pair, `(delivery, DELIVERING)` (the T_RECEIPT draft), has
  been *edited* both times it was decided — meaning the canned receipt text
  isn't what the operator actually wants to send yet.
- **Signal is leaking (M3):** 4 of 9 escalations ended `resolved_closed`
  (bulk case-close on 07-04) with no decision row — those human judgments are
  invisible to graduation. `decision.conversation_state` is captured at
  approval time, after the FSM already auto-advanced, so the pair key itself
  is unreliable (decision 1 is keyed `SENT` for a follow-up nudge drafted
  *because* of SENT — coincidence, not guarantee). Follow-up drafts have
  `classifier_class=NULL` and can never graduate as a pair.
- **Missing instrumentation to ever trust a flip:** (a) edit-distance between
  `draft_body` and `final_body` (a comma fix and a rewrite are both "edit");
  (b) the draft's *source* (LLM draft vs template) — the thing that would
  actually graduate; (c) recipient corrections (a `finalTo` override is a
  routing failure that today leaves no decision trace); (d) a
  consecutive-streak view — the spec's own SQL (`GROUP BY 1,2,3`) can't
  express "consecutive".
- Realistic first graduate: **`(auto_ack, SENT) → no reply needed`** is
  already effectively auto-handled (no escalation is created), which shows
  the machinery works when the action is "do nothing". The first *send*
  graduate should be T_RECEIPT on first delivery — but only after M5/M9 are
  fixed and the streak instrumentation exists.

## 7. Contract lifecycle / perpetual refresh — confirmed gap

**Collection is terminal.** `DONE` and `DEAD_END` are absorbing states
(`conversation.js:43`, `TERMINAL_STATES`); nothing ever re-opens a case except
the manual dashboard "reopen" button, and no code path ever creates a new
request from stored data.

The raw material exists and is already flowing: `contracts.period_end` is in
the schema (`storage.js:131`), the Opus analyser extracts it with explicit
auto-renewal rules (`analyse-contract.js:26`), and it's populated in practice.
But its only consumer is a dashboard badge (`dashboard-views.js:1549`). The
live numbers make the cost concrete: **25 of 53 stored contracts (47%) have
`period_end < 2026-07-05`** — including rows expiring back in 2014–2018 (the
kommuner delivered historical contracts). The "dataset" is already half
archive, and the system has no concept of asking for the successor.

What self-refreshing requires:

1. **Schema:** a `requests` (or `cases`) concept separating the *ask* from the
   kommun relationship — today `conversations` is UNIQUE(kommun_kod, role), so
   a second request to the same kommun/role is structurally impossible
   (`storage.js:20`). Either drop that uniqueness in favor of
   `UNIQUE(kommun_kod, role, request_generation)` or add a `requests` table
   that conversations belong to. Add `contracts.supersedes_contract_id` so the
   successor links to the expiring row.
2. **Trigger:** a daily job (same shape as `runDailyFollowup`) —
   `SELECT c.* FROM contracts c WHERE c.is_contract=1 AND c.period_end IS NOT
   NULL AND c.period_end <= date('now','+60 days') AND no open successor
   request` → draft a *scoped* T_RENEWAL template ("ert avtal med <vendor>
   löper ut <date>; jag önskar ta del av det efterträdande avtalet"),
   escalated for approval like everything else, referencing the prior
   `arendenummer`.
3. **Dedup & rate control:** one renewal request per kommun batch (not one
   per expiring contract), and the same double-send invariants from §1 —
   which is why the safety layer must come first: the refresh loop multiplies
   send volume permanently.
4. **Freshness metric:** per-vendor / per-kommun "coverage currency"
   (% of known contracts unexpired) on the vendor dashboard, so the loop has
   an observable objective.

## 8. Operational / security

- **Secrets:** `.env` is git-ignored and not committed; tokens live under
  `~/.config/mediagraf/` (also ignored). Good. `ANTHROPIC_API_KEY`,
  Slack bot token and signing secret all flow via env. No secrets found in
  the repo or specs.
- **OAuth lifecycle (M12):** tokens loaded once at daemon start; refreshed
  access tokens are never persisted (no `oauth.on('tokens')`), and there is
  no alerting on `invalid_grant` beyond the dashboard pill — the June outage
  ran ~10-15 days. If the Google Cloud consent screen is still in "Testing"
  mode, refresh tokens expire every 7 days by policy and this will recur on
  schedule. The in-dashboard re-auth flow (`gmail-auth.js`) is a good
  mitigation but requires noticing.
- **Slack interactivity:** signature verification is correct (raw body,
  timing-safe, 5-min skew — `slack.js:65-77`). Exposure concerns are the
  missing idempotency (C1), ack-before-work (L1), and no check that the
  Slack user is an authorized approver (`user_id` is parsed and discarded,
  `slack.js:90`) — any member of the channel can approve sends.
- **Dashboard (H6):** unauthenticated, binds `0.0.0.0`, can send email and
  exfiltrate the full PII corpus. Bind `127.0.0.1` at minimum.
- **PII:** the DB stores registrator names, direct emails, phone numbers
  (extracted signatures) and full correspondence — appropriate for purpose,
  but it means DB backups (`data/pilot.db.bak-*`) are PII stores too; keep
  them out of git (currently untracked — add a `.gitignore` pattern for
  `data/pilot.db.bak-*` so one never lands by accident).
- **Prompt PII (M8):** the operator's personal Gmail and full name are
  hardcoded into the LLM system prompt in source, which *is* committed.

---

## Path to autopilot

Ordered, minimal changes for the **first unattended send** — the target
graduate being `(delivery, DELIVERING) → T_RECEIPT` (first receipt only):

1. **Make send idempotent (C1, C2, H7).** Atomic escalation claim
   (`UPDATE … WHERE status='open'`, assert one row), Slack `chat.update` on
   resolution, and two-phase outbound (claim → send → finalize; `SENDING`
   rows escalate on restart, never auto-retry). This single change is the
   difference between "bug" and "the bot spammed a myndighet".
2. **Serialize ticks (C3)** with an in-process latch, and move contract
   analysis out of the inbound loop into a queue drained after ingest
   (fixes M6 as a side effect).
3. **Make ingest transactional and honest (H4, M2, H3).** One transaction per
   message; attachments fetched before commit; `received_at` from Gmail
   `internalDate`; fetch window = `last_success_at` − 1 day margin, floor
   30d.
4. **Enforce one open escalation per conversation (H1)** in
   `escalateWithDraft` (supersede-or-skip) and gate `runDailyFollowup` on
   "no open escalation for this conversation" — then add the missing tests
   for both (M1).
5. **Surface unmatched inbound (H5)** as a daily "unmatched" digest
   escalation, and fix first-conv-wins matching (H2) before any kommun gets
   a second conversation.
6. **Repair the graduation ledger (M3):** decision rows for every terminal
   escalation status, pair key from `esc.previous_state`/draft-time state,
   edit-distance and `finalTo`-override columns, and a
   consecutive-unmodified-streak view. Then run the pilot until
   `(delivery, DELIVERING)` shows ≥5 consecutive clean approvals — with M5
   (watchlist after receipt) and M9 (closer regex) fixed so the class is
   actually safe to trust.
7. **Flip one pair** behind a config flag (`auto_handle: ["delivery:DELIVERING"]`),
   still posting to Slack as FYI-after-send, with a kill switch.

**The refresh loop** (§7) then reuses all of the above: add the
request-generation schema, the 60-day expiry scan feeding the same escalation
pipeline (human-approved at first, graduating like any other class), and the
coverage-currency metric. A contract expiring becomes just another classified
trigger in the same loop — which is the north star's actual definition.
