# Contract-validator checklist test (2026-08-17)

Research note. Tests the "contract validator for kommuner" product idea against
real contracts we already hold: does an LLM checklist over signed municipal
IT/SaaS contracts surface *recurring, actionable* gaps, or just noise?

Short answer: the recurring gaps are real, the output is sellable in shape,
and the test exposed three design requirements (framework-terms awareness,
"referenced elsewhere" as a first-class finding, severity calibration).

## Setup

- **Data:** live `pilot.db` backup `backups/2026/08/17/pilot-20260817T084959Z.db`
  (333 `is_contract=1` rows). Sample = one PDF per vendor, 30 kB–4 MB, smallest
  file per vendor → **45 contracts, 45 vendors, 34 kommuner**. PDFs pulled from
  `s3://mediagraf-…/contracts/<kommun_kod>/…` (box paths are
  `/var/lib/mediagraf/contracts/…`, strip everything before `/contracts/`).
- **Runner:** `scripts/research/contract-checklist.mjs` — `claude-opus-5`,
  effort `medium`, base64 PDF + JSON-schema structured output, 17 checks
  (price index, price cap, term, auto-renew, notice, exit/data, SLA uptime,
  SLA remedy, support, security, PUB/GDPR, subprocessors, liability, IP,
  accessibility, change control, governing terms). Each check → status
  (`present_ok | present_weak | absent | referenced_elsewhere | n/a`), finding,
  verbatim quote, risk; plus `red_flags[]`, `ask_for[]`, `doc_kind`,
  `overall_risk`.
- **Cost/latency:** $9.09 total, **$0.20 and ~66 s per contract**.
- Raw per-contract results (with contract excerpts) are NOT committed — they
  live with the PII-bearing corpus. Re-run the script to regenerate.

## Results (n = 45)

Document kinds: 23 full agreements, 14 framework call-offs (Adda/GR/Läromedia),
5 order-form-only, 1 price offer, 2 other. Overall risk: 33 high, 12 medium.

Contracts with a medium/high gap per check (deduped per contract):

| Check | ok | weak | absent | ref'd elsewhere | med/high gap |
|---|---|---|---|---|---|
| price_cap | 1 | 4 | 39 | 1 | 43 (96 %) |
| price_index | 4 | 25 | 11 | 5 | 40 (89 %) |
| sla_uptime | 0 | 12 | 19 | 13 | 44 (98 %) |
| sla_remedy | 2 | 10 | 27 | 5 | 41 (91 %) |
| exit_data | 3 | 8 | 32 | 2 | 42 (93 %) |
| gdpr_pub | 1 | 6 | 19 | 19 | 44 (98 %) |
| subprocessors | 3 | 14 | 25 | 3 | 41 (91 %) |
| liability | 1 | 15 | 15 | 14 | 44 (98 %) |
| security | 1 | 12 | 28 | 3 | 43 (96 %) |
| notice_period | 7 | 29 | 6 | 3 | 37 (82 %) |
| auto_renew | 10 | 26 | 6 | 3 | 32 (71 %) |
| term_length | 15 | 28 | 2 | 0 | 29 (64 %) |
| change_control | 6 | 28 | 10 | 1 | 36 (80 %) |
| governing_terms | 10 | 28 | 6 | 1 | 35 (78 %) |
| support | 4 | 19 | 13 | 9 | 39 (87 %) |
| ip_content | 5 | 11 | 29 | 0 | 38 (84 %) |
| accessibility | 0 | 2 | 42 | 0 | 44 (98 %) |

Restricted to the 23 complete standalone agreements: 20 have no price cap,
15 say nothing about exit/data, 10 have no PUB-avtal and 9 only reference one.
So the gaps are not an artefact of "we only saw the order form".

`ask_for` themes (share of contracts where the theme is in the top-5 asks):
price cap tied to KPI 98 %, PUB-avtal per art. 28 with EU/EES storage 96 %,
written SLA with prisavdrag 93 %, subprocessor list 89 %, exit clause with
machine-readable export 87 %, "attach the referenced bilaga/villkor" 64 %,
WCAG 62 %, uppsägning/förlängning 62 %. The asks cluster tightly → template.

Illustrative findings (verified against the PDFs):

- Gnesta / Everway (LexiFlow, 23 875 kr/år): 25 000 kr liability cap requiring
  gross negligence, no PUB-avtal, confidentiality clause conflicting with
  offentlighetsprincipen.
- Karlshamn / Atea (Skola24 call-off): signed document explicitly *excludes*
  Adda's Allmänna kontraktsvillkor, so SLA/liability/exit are unreviewable in
  what was signed.
- Hudiksvall / Gotit via Atea (482 tkr/år × 6 yr): liability capped at two
  basbelopp (~1/5 of a year's fee), PUB-avtal "vid behov", no SLA.
- Bengtsfors / Mediapoolen (2015): PUB-avtal cites the repealed 1998
  personuppgiftslag; 12-month notice + auto 2-year renewals, no max term.

## What this changes in the product design

1. **The validator must know framework terms.** 14/45 were Adda/GR/Läromedia
   call-offs whose SLA/liability live in the framework's allmänna villkor that a
   kommun never uploads. Without SKR/Adda/Kammarkollegiet/IT&Telekom standard
   terms pre-loaded, the tool over-flags and loses trust. Right output:
   "your call-off inherits Adda §X SLA; PUB-avtal not attached".
2. **`referenced_elsewhere` is a first-class finding.** 19 reference a
   PUB-avtal, 13 an SLA bilaga, not present in the signed document. The
   actionable message is "attach and diarieför before signing" — cheapest and
   arguably most useful check.
3. **Severity calibration needs a human pass.** Strict-lawyer mode calls 73 %
   high risk. A product needs to separate structural problems (no price cap on
   a 6-year 480 tkr/år deal) from nice-to-haves (WCAG missing on a 4 tkr
   licence). The checklist gives the inputs; scoring is the judgment layer.

Known limitation of this run: the model occasionally emitted a duplicate
check id per contract; aggregation above takes the first per id.

## Re-running

```
# 1. build sample.json from a DB backup (see the SQL in this session's notes:
#    one contract per vendor, is_contract=1, mime=pdf, 30kB–4MB)
# 2. aws s3 cp the PDFs to <workdir>/pdfs/<contract_id>.pdf
# 3.
ANTHROPIC_API_KEY=... node scripts/research/contract-checklist.mjs <workdir>/sample.json
```

Full corpus (~290 remaining contracts) ≈ $60 at the observed rate.
