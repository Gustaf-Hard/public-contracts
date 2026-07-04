# Contract-Aware Follow-Up Replies — Design

**Date:** 2026-07-04
**Status:** Approved (brainstorming) — ready for implementation plan
**Related:** [2026-07-03-conversation-threads-and-recipients-design.md](2026-07-03-conversation-threads-and-recipients-design.md); the indirect-procurement template clause (Atea/Läromedia/Adda).

## Problem

The tool's goal is to collect the actual avtal (contract) documents. Today the
suggested reply to an inbound is drafted by the message-level LLM
(`analyseMessage`), which sees only the **email body** — never the attachment
contents. So when a kommun replies "Bifogat finner du svar…" with a PDF, the LLM
classifies it `delivery` and drafts "Tack så mycket för avtalen — är detta
samtliga?" regardless of what the PDF actually contains.

Grounded failure (Arjeplog, conversation #11): the attached
`Svar på begäran om allmän handling.pdf` is a **cover letter / summary table**,
not contracts. It lists:

- **Quiculum** (lärplattform) — value/term given as *"Enligt bifogat avtal"* — a
  reference to an avtal that was **not** attached (only the letter came).
- **LäroMedia** (Digilär, Bingel, Skolplus) — avrop via ADDA:s ramavtal, costs
  listed, no avtal document.
- **Teachiq** (Exam.net, Kunskapsmatrisen) — 38 551 kr, *"kommunen har inte
  kunnat återfinna någon separat avtalshandling."*

So **no actual contract documents arrived**, yet:

1. The PDF analyzer marked it `is_contract=1` (0.92) — it read the letter's
   description of the Quiculum avtal and mistook the letter for the avtal. The
   analyzer's own spec already says a *följebrev* should be `is_contract=false`;
   the model over-read the summary table.
2. The drafted reply thanked the kommun "för avtalen" as if contracts were
   received, instead of requesting the actual documents.

## Goal

Make the delivery follow-up **contract-aware**: driven by what the attachments
actually contain, not by the email body alone. When a delivery lacks the real
contract documents (or names agreements whose documents are missing), draft a
targeted follow-up that requests the specific missing avtal — acknowledging any
real contracts that did arrive.

## Non-goals

- No auto-sending. The follow-up remains a human-approved escalation draft, as
  today. This changes *what is drafted*, not the human gate.
- No change to the conversation FSM. State still moves to `DELIVERING`; only the
  drafted reply template differs.
- No new table. Extraction is stored in the existing `contracts.analysis_json`.
- No re-architecture of `analyseMessage`; it is not fed PDF contents.

## Approach

**Analyze-then-draft within one tick** (chosen over a two-pass/next-tick design
and over feeding PDF text into the message LLM). Today reply drafting happens in
tick step 2 (inbound processing) while PDFs are analyzed in step 3 — so the
reply is blind to attachments. For a `delivery`, we analyze *this message's*
attachments inline, right after saving them, then compute received-vs-missing
and pick the reply template. One tick, one escalation, contract-aware reply.
Step 3's `analysePendingContracts` then finds them already analyzed
(`recordContract` is idempotent — it replaces by attachment_id).

## Components

### 1. Analyzer changes (`src/analyse-contract.js`)

Extend the structured-output schema and prompt:

- **`document_type`** — enum: `avtal` · `följebrev_sammanställning` · `prislista`
  · `sekretessbeslut` · `övrigt`. The prompt instructs: a "Svar på begäran…"
  summary/table that lists agreements without the avtal text itself is
  `följebrev_sammanställning` → `is_contract: false`. This both improves
  `is_contract` accuracy and gives a queryable signal.
- **`mentioned_agreements`** — array of `{ vendor: string, product: string|null,
  doc_attached: boolean }`. For *any* document, the agreements it references and
  whether the actual avtal document appears present/attached. For a summary
  letter, the listed vendors get `doc_attached: false`. Empty array when none.

Both fields are added to `CONTRACT_SCHEMA.required` and persisted inside the
existing `contracts.analysis_json`. A följebrev already produces a `contracts`
row (with `is_contract=0`), so the data is queryable via `json_extract` with no
schema migration.

### 2. Reply-selection helper (`src/templates.js`)

Lives in `src/templates.js` alongside the templates it selects among.
`chooseDeliveryReply({ received, missing })` → `{ template, ctxExtra }` where
`received` and `missing` are de-duplicated vendor-name lists (case-insensitive):

- `missing` empty → `T_RECEIPT` (today's "tack, är detta samtliga?").
- `missing` non-empty → `T_REQUEST_MISSING`.

Pure and unit-testable; no IO.

### 3. New template `T_REQUEST_MISSING(ctx)` (`src/templates.js`)

Takes `received[]` and `missing[]`. Renders:

- `received≥1, missing≥1`: "Tack för avtalen gällande *[received]*. Jag saknar
  ännu de faktiska avtalshandlingarna för *[missing]* — kan ni skicka dem?"
- `received=0, missing≥1`: "Tack för ert svar. Själva avtalshandlingarna verkar
  inte bifogade — kan ni skicka de fullständiga avtalen för *[missing]*?"
- `received=0, missing=0`: generic "…jag ser inte de faktiska avtalen bifogade —
  kan ni skicka dem?" (attachment present, not a contract, nothing named.)

Standard `Hej,` / signature framing consistent with the other templates.

### 4. Tick wiring (`src/tick.js`, delivery branch only)

After the inbound is recorded and its attachments saved, when the classification
is `delivery`:

1. **Analyze this message's attachments inline** — reuse the contract analyzer
   over the just-saved attachments for this message (a scoped call, not the full
   pending sweep).
2. **Compute sets:**
   - `received` = distinct vendors from this delivery's attachments with
     `is_contract=1`.
   - `missing` = vendors from `mentioned_agreements` with `doc_attached=false`,
     minus anything already in `received` (case-insensitive dedup).
3. **Choose the draft** via `chooseDeliveryReply`:
   - `missing` empty → `T_RECEIPT` (unchanged behaviour).
   - `missing` non-empty → `T_REQUEST_MISSING`, and **override any LLM
     `draft_reply`** — the message LLM is blind to the PDF, so its "tack för
     avtalen" draft must not win in this branch.

The escalation is created and human-approved exactly as today; only the template
and body differ.

## Data flow

```
inbound delivery → save attachments → analyze attachments (inline)
   → received = is_contract=1 vendors
   → missing  = mentioned_agreements[doc_attached=false] − received
   → chooseDeliveryReply → T_RECEIPT | T_REQUEST_MISSING
   → escalateWithDraft (human-approved)
```

## Error handling

- Analyzer failure on an attachment must not break the tick: on error, treat
  that attachment as "unknown" (not a contract, no mentioned agreements) and fall
  back to today's behaviour (`T_RECEIPT` if the classification was delivery). The
  existing step-3 sweep will retry analysis later.
- If inline analysis yields no attachments analyzable (e.g. zip/mime edge), fall
  back to `T_RECEIPT` — never crash the escalation path.

## Testing (all offline)

**Analyzer** (stubbed LLM client returning canned JSON):
- följebrev → `is_contract=0`, `document_type='följebrev_sammanställning'`,
  `mentioned_agreements` populated with `doc_attached:false`.
- real avtal → `is_contract=1`, `document_type='avtal'`.

**`chooseDeliveryReply` (pure):**
- `missing=[]` → `T_RECEIPT`.
- `received=[Skolon], missing=[Quiculum,Teachiq]` → `T_REQUEST_MISSING`.
- `received=[], missing=[Quiculum]` → `T_REQUEST_MISSING`.
- dedup: a vendor in both `received` and mentioned is not asked for.

**`T_REQUEST_MISSING`:** renders received/missing lists; safe with empty
received; includes Hej,/signature.

**Tick integration** (fake gmail + stubbed analyzer): a delivery whose attachment
analyzes as a följebrev naming Quiculum → the drafted escalation uses
`T_REQUEST_MISSING` naming Quiculum, NOT `T_RECEIPT`, and the LLM `draft_reply`
is overridden.

## Success criteria

- A delivery containing only a cover-letter/summary is `is_contract=false` and
  does not count as a collected contract.
- The follow-up for such a delivery requests the specific missing avtal by name
  (Quiculum, LäroMedia/ADDA, Teachiq for the Arjeplog case), rather than thanking
  for contracts.
- A partial delivery (some real contracts + named-missing) acknowledges what
  arrived and requests the missing ones by name.
- A complete delivery (all named agreements documented) keeps today's
  "tack, är detta samtliga?" reply.
- The follow-up stays a human-approved draft; no auto-send introduced.
