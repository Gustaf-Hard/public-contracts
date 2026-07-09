# Implementation plan — perpetual contract refresh

TDD throughout. Commit per component (Conventional Commits). Keep suite ≥386.

## 1. `src/contract-lifecycle.js` — `computeNextReviewDate` (pure)
- Test first (`tests/contract-lifecycle.test.js`): archetypes with real
  Tieto/Skola24/Teachiq shapes, null/invalid dates, precedence.
- Implement. Commit `feat(contracts): computeNextReviewDate lifecycle module`.

## 2. Schema migration + storage
- Test first (extend `tests/storage.test.js` or `contracts-storage.test.js`):
  migrate twice → columns present once; recordContract round-trips new fields;
  updateConversationState sets next_review_at/source/refresh_round.
- Add columns to SCHEMA + guarded ALTERs; extend recordContract +
  updateConversationState allow-lists; add listContractsForKommun query if
  needed for arming/scan.
- Commit `feat(storage): lifecycle + refresh columns, guarded migration`.

## 3. Analyser prompt + schema (Part A)
- Test first (`tests/analyse-contract.test.js`): injected client returns the
  new fields → storeContractAnalysis persists them.
- Extend SYSTEM_PROMPT + CONTRACT_SCHEMA + storeContractAnalysis.
- Commit `feat(contracts): extract auto_renews/renewal lifecycle fields`.

## 4. `T_UPDATE` template
- Test first (`tests/templates.test.js`): names expiring contracts,
  open-ended net-new, references prior ärende.
- Implement in templates.js.
- Commit `feat(templates): T_UPDATE re-contact request`.

## 5. Gating — pilot-config
- Test first (`tests/pilot-config.test.js`): isRefreshAllowed honors allowlist.
- Add `isRefreshAllowed`; add refresh_pilot_kommun_kods to pilot-overrides.json.
- Commit `feat(refresh): pilot allowlist gating`.

## 6. Arming + scan (Part B)
- Test first (`tests/tick-refresh.test.js`): arm on DONE; scan due→one esc,
  not-due→none, allowlist respected, dedup newest-wins, supersede.
- Add `armRefresh(conv, deps)` (called from ingest when a conv reaches DONE
  within allowlist) + `runRefreshScan(deps)` in tick.js; wire into daemon under
  the escalation mutex.
- Commit `feat(refresh): arm next_review_at + daily refresh scan`.

## 7. Dashboard
- Test first (`tests/dashboard-views` or dashboard.test.js): DONE case shows
  Återkommer + vendor.
- Render next_review_at/source on DONE detail pane.
- Commit `feat(dashboard): show next review date on closed cases`.

## 8. Backfill script + runbook
- `scripts/07-reanalyse-lifecycle.js` (pure arg parse tested); runbook doc.
- Commit `feat(contracts): backfill re-analysis script + activation runbook`.

## Final
- `npm test` ≥386 green. Report.
