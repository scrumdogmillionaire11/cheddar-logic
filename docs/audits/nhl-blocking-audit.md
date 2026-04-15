# NHL Market Surface Audit (WI-0940)

Date: 2026-04-14

## Scope

- apps/worker/src/jobs/run_nhl_model.js
- packages/models/src/decision-pipeline-v2.js
- apps/worker/src/utils/decision-publisher.js
- apps/worker/src/jobs/check_pipeline_health.js
- apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js
- apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js
- apps/worker/src/__tests__/check-pipeline-health.nhl.test.js
- web/src/lib/games/route-handler.ts
- web/src/__tests__/integration/games-pipeline-contract.test.ts

## Deterministic Checks

- Initial canonical `decision_v2` stamp added at spread-call and moneyline-call `payloadData` construction,
  before any publish/mutation pass touches the object. All three NHL market-call card types now have
  deterministic initial state that downstream mutation passes refine rather than invent.
- No-odds-mode override block for NHL market-call loop stamped with explicit `NO_ODDS_MODE_LEAN`
  reason code and `decision_v2.primary_reason_code`; stale "last write wins" comment removed.
- NHL reject-reason diagnostics (`summarizeNhlRejectReasonFamilies`, `checkNhlMarketCallDiagnostics`)
  added to `check_pipeline_health.js`, wired into health checks and Discord phase lookup.
- Web contract assertion confirms `route-handler.ts` reads `play.decision_v2?.official_status` as
  the canonical first-check path before any legacy fallback.

## Absence Proofs

To verify removed artifacts are gone:

```bash
# Must return 0 matches — "last write wins" removed from no-odds override block
rg -n "last write wins" apps/worker/src/jobs/run_nhl_model.js

# Must return 0 matches — no legacy reconstruction bypass added for NHL market calls
rg -n "nhl_market_call_fallback|repair_applied" apps/worker/src/jobs/run_nhl_model.js web/src/lib/games/route-handler.ts
```

## Debt Ledger

| Debt ID | Type | Artifact removed or changed | Proof | Decision | Rationale | Follow-up WI |
| --- | --- | --- | --- | --- | --- | --- |
| TD-01 | code | Initial canonical `decision_v2` + `action` + `classification` stamp block added at `nhl-spread-call` and `nhl-moneyline-call` `payloadData` construction in `run_nhl_model.js` | TD-01 describe block in `run_nhl_model.market-calls.test.js` — 3 assertions covering FIRE/WATCH for spread-call and moneyline-call | removed | Eliminates undefined initial state that allowed 5 sequential mutation passes to be effective first-writers for spread/moneyline cards | n/a |
| TD-02 | code | Stale `// Override to LEAN AFTER applyUiActionFields so the last write wins.` comment removed from no-odds-mode override block; `NO_ODDS_MODE_LEAN` reason code and `decision_v2.primary_reason_code` stamp added | TD-02 describe block in `run_nhl_model.market-calls.test.js` — 1 assertion; `rg -n "last write wins" run_nhl_model.js` → 0 matches | removed | Comment actively encouraged anti-pattern; blocked no-odds-mode cards were undiagnosable without reason code | n/a |
| TD-02 | code | `choosePrimaryDisplayMarket` observability call at line 2764 | retained — feeds `[DUAL_RUN]` log (WI-0503) | retained-intentional | Observability-only; does not affect served card output or blocking path | WI-0503 |
| TD-02 | code | `buildDualRunRecord` / `[DUAL_RUN]` log infrastructure | retained — WI-0503 dual-run observation pattern | retained-intentional | Observability-only; not a blocking path; required for market-selector comparison tooling | WI-0503 |
| TD-03 | contract | Web contract assertion added in `games-pipeline-contract.test.ts` proving `resolveLiveOfficialStatus` in `route-handler.ts` checks `play.decision_v2?.official_status` first before any legacy status/action fallback | TD-03 assert block in `games-pipeline-contract.test.ts` | removed | Guarantees NHL market-call cards consume canonical persisted status rather than reconstructing verdict from fallback fields | n/a |
| TD-04 | diagnostic | `summarizeNhlRejectReasonFamilies` and `checkNhlMarketCallDiagnostics` added to `check_pipeline_health.js`; wired into `checks` object, Discord `checkPhaseLookup`, and `module.exports` | `check-pipeline-health.nhl.test.js` — 11 assertions covering all 6 reason families, malformed JSON, and `checkNhlMarketCallDiagnostics` ok/warning states | removed | Blocked NHL market-call candidates had no per-market reason-family summary comparable to MLB WI-0939 output | n/a |
| TD-05 | documentation | `// Override to LEAN AFTER applyUiActionFields so the last write wins.` stale comment removed and replaced with accurate description of no-odds-mode LEAN semantics | `rg -n "last write wins" run_nhl_model.js` → 0 matches | removed | Comment described an anti-pattern that TD-01 and TD-02 fixed; retained comments (WI-0503, IME-01-04, WI-0383) are accurate and intentional | n/a |
| TD-05 | documentation | `WI-0503: Dual-run observation log` comment block at line 2766 | retained — accurate description of observability pattern | retained-intentional | Comment is correct; infrastructure is intentionally retained per WI-0503 | WI-0503 |
| TD-05 | documentation | `IME-01-04: Independent market evaluation` comment at line 2761 | retained — accurate IME milestone marker | retained-intentional | Correctly labels the independent market evaluation entry point | n/a |
