# MLB Market Surface Audit (WI-0939)

Date: 2026-04-14

## Scope

- apps/worker/src/jobs/run_mlb_model.js
- apps/worker/src/models/mlb-model.js
- apps/worker/src/jobs/check_pipeline_health.js
- apps/worker/src/jobs/__tests__/run_mlb_model.test.js
- apps/worker/src/__tests__/run-mlb-model.dual-run.test.js
- apps/worker/src/__tests__/check-pipeline-health.mlb.test.js

## Deterministic Checks

- Canonical full-game total line contract uses `mlb.full_game_line` from hydration to model consumption.
- Persisted terminal status parity is enforced for game-market payloads after execution gate demotion.
- MLB reject diagnostics now return deterministic reason-family buckets per market with explicit uncategorized count.

## Debt Ledger

| Debt ID | Type | Artifact removed or changed | Proof | Decision | Rationale | Follow-up WI |
| --- | --- | --- | --- | --- | --- | --- |
| TD-01 | contract | Canonical line hydration moved to `mlb.full_game_line`; legacy `mlb.total_line` alias removed during hydration | `hydrateCanonicalMlbMarketLines` unit tests in `run_mlb_model.test.js` | removed | Prevents full-game total suppression caused by key drift | n/a |
| TD-02 | code | Legacy alias path `mlb.total_line` no longer propagated in enriched snapshot contract | `rg -n "total_line" apps/worker/src/jobs/run_mlb_model.js apps/worker/src/models/mlb-model.js` | removed | Keeps one deterministic key path for full-game totals | n/a |
| TD-03 | contract | Added parity regression for demoted `full_game_ml` persisted payload terminal fields | `run-mlb-model.dual-run.test.js` test `execution-gate-demoted full_game_ml payload keeps terminal status fields in parity` | removed | Avoids contradictory status/action/classification on stored cards | n/a |
| TD-04 | diagnostic | Added deterministic reject reason-family summarizer with per-market counters and uncategorized bucket | `check-pipeline-health.mlb.test.js` reason-family bucket test | removed | Makes blocked-candidate telemetry auditable and complete | n/a |
| TD-05 | documentation | Updated audit artifact to reflect canonical contract and diagnostics behavior | this file | removed | Aligns docs with current behavior and closeout evidence | n/a |
