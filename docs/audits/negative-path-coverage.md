# Negative-Path Coverage Matrix (WI-0903)

This audit tracks deterministic negative-path fixtures and expected behavior outcomes.

| fixture_id | scenario_class | expected_status | expected_visibility_default | expected_reason_code | owning_test |
| --- | --- | --- | --- | --- | --- |
| odds-present-no-play | odds present but no playable edge | PASS | hidden | PASS_NO_EDGE | web/src/__tests__/negative-path-cards-games-fixtures.test.js |
| selected-then-downgraded | play selected then downgraded by execution gate | PASS | hidden | PASS_EXECUTION_GATE_BLOCKED | web/src/__tests__/negative-path-cards-games-fixtures.test.js |
| projection-only-hidden-default | projection-only recommendation in main game mode | PASS | hidden | PASS_NO_EDGE or projection-only reason | web/src/__tests__/negative-path-pass-visibility-defaults.test.js |
| missing-starter-block | starter data missing in MLB F5 path | blocked (no emitted card) | n/a | NO_BET gate path | apps/worker/src/jobs/__tests__/negative-path-gates.test.js |
| unknown-goalie-block | NHL total remains executable with unknown goalie | blocked (invariant breach) | n/a | invariant guard | apps/worker/src/jobs/__tests__/negative-path-gates.test.js |
| stale-line-block | odds snapshot exceeds freshness threshold | blocked | n/a | STALE_SNAPSHOT_GATE | apps/worker/src/jobs/__tests__/negative-path-gates.test.js |
| settlement-live-truth-no-rewrite | settlement auto-close attempts against row no longer pending | not rewritten | n/a | NON_ACTIONABLE_FINAL_PASS + pending guard | apps/worker/src/jobs/__tests__/negative-path-settlement-live-truth.test.js |

## Interpretation Rules

- Hidden means excluded from default FIRE/WATCH main-view filters.
- Status assertions use behavior fields only (`action`, `classification`, `decision_v2.official_status`, emitted/omitted card rows).
- Gate/settlement failures are asserted via explicit reason/status outputs, not source-string matching.
- For settlement no-rewrite, success requires write guard behavior (`changes = 0` for no-longer-pending row) and preserved closed id set.
