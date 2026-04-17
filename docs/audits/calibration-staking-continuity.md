# Calibration-to-Staking Continuity Audit (WI-0906)

## Scope

- `packages/models/src/decision-pipeline-v2.js`
- `packages/models/src/edge-calculator.js`
- `apps/worker/src/jobs/execution-gate.js`
- `apps/worker/src/jobs/run_nba_model.js`
- `apps/worker/src/jobs/run_nhl_model.js`
- `apps/worker/src/jobs/run_mlb_model.js`
- `apps/worker/src/jobs/potd/signal-engine.js`
- `apps/worker/src/jobs/potd/run_potd_engine.js`

## Edge -> Confidence -> Size Lineage Table

| path | edge_source | confidence_source | sizing_input | size_output | guards | reason_codes / outcome |
| --- | --- | --- | --- | --- | --- | --- |
| NBA model cards | `decision-pipeline-v2.js` computes `edge_pct` and `fair_prob` | `decision-pipeline-v2.js` emits `confidence` and status (`PLAY/LEAN/PASS`) | `run_nba_model.js` passes `p_fair` and `price` to `kellyStake` only for `PLAY/LEAN` | `pd.kelly_fraction`, `pd.kelly_units` (otherwise null) | `evaluateExecution` in `execution-gate.js` blocks on model status, net edge, confidence `< 0.55`, stale/mixed-book | blocked paths are demoted and non-actionable; PASS execution-gate reason family (`PASS_EXECUTION_GATE_*`) |
| NHL model cards | `decision-pipeline-v2.js` edge outputs and market-aware delta | model confidence + status from pipeline and runner checks | `run_nhl_model.js` computes Kelly only for `PLAY/LEAN` | advisory Kelly fields on payload | `evaluateExecution` + runner demotion (`actionable=false`) | execution-gate metadata in payload; blocked cards not surfaced as executable |
| MLB model cards | model/pipeline edge and projected-vs-line drivers | model confidence + directional funnel confidence checks | `run_mlb_model.js` computes Kelly only for `PLAY/LEAN` | advisory Kelly fields on payload | centralized MLB gate (`evaluateMlbExecution`) and execution gate | blocked paths set non-actionable and carry pass reason metadata |
| POTD candidates | `signal-engine.js` computes `edgePct = modelFairProbability - impliedProb` | `totalScore` and `confidenceLabel` from scoring (`HIGH/ELITE/LOW`) | `run_potd_engine.js` passes edge/implied/bankroll to `kellySize` after candidate pick | dollar `wager_amount` (rounded) + bankroll tracking rows | viability filters (`minEdgePct`, `minConfidence`) plus runner-level LOW confidence block | no-play reasons (`zero_wager`, `stake_below_minimum`, `confidence_below_high_gate`) |

## Continuity Break Taxonomy

| break_class | location | observed risk | status |
| --- | --- | --- | --- |
| `NON_ACTIONABLE_NONZERO_SIZE` | NBA/NHL/MLB runner write paths | Non-actionable cards could carry stale size fields | Not observed in current paths: Kelly assignment is gated to `PLAY/LEAN`; non-actionable paths write null Kelly |
| `FRAGILE_CONFIDENCE_NONZERO_SIZE` | POTD `run_potd_engine.js` | LOW-confidence candidate can still produce non-zero stake if selector threshold drifts or is bypassed | Fixed in WI-0906 via runner-level confidence guard before `kellySize` |
| `STALE_OR_UNVERIFIED_CONFIDENCE_NONZERO_SIZE` | `execution-gate.js` + runners | stale/expired confidence could pass sizing path | Mitigated by freshness tiers and blocked-by metadata; EXPIRED blocks execution |
| `POTD_NON_POTD_PARITY_MISMATCH` | POTD engine vs worker execution gate | POTD used score threshold while worker uses explicit confidence gate | Reduced by new POTD HIGH-confidence gate to align continuity intent |

## POTD vs Non-POTD Parity Matrix

| state | non_potd_behavior | potd_behavior | parity_status |
| --- | --- | --- | --- |
| Model status non-OK | Execution gate blocks executable status; non-actionable payload | Candidate path not model-status based; quality relies on candidate scoring | Acceptable difference (domain-specific), documented |
| Confidence below floor | Execution gate blocks (`CONFIDENCE_BELOW_THRESHOLD`) | WI-0906 guard blocks LOW/sub-HIGH score candidate pre-sizing | Aligned intent |
| Positive edge but thin stake | Kelly may produce null/low advisory size | `stake_below_minimum` no-play gate suppresses dust wagers | Aligned intent |
| Stale snapshot | freshness gate blocks EXPIRED and annotates metadata | POTD fetch freshness implied by daily run; no direct snapshot-age gate | Partial parity; accepted with rationale |

## Remediation Guard List

| guard_id | break_class | trigger | expected_behavior | test_reference | status |
| --- | --- | --- | --- | --- | --- |
| `CG-001` | `FRAGILE_CONFIDENCE_NONZERO_SIZE` | POTD best candidate has `confidenceLabel=LOW` or `totalScore < HIGH` threshold | Return no-play with `reason=confidence_below_high_gate`; do not call Kelly sizing | `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js` (`blocks LOW-confidence candidate...`) | Implemented |
| `CG-002` | `NON_ACTIONABLE_NONZERO_SIZE` | execution gate blocks model card | card is non-actionable; Kelly fields remain null on payload | `apps/worker/src/jobs/__tests__/execution-gate.test.js` | Existing |
| `CG-003` | `STALE_OR_UNVERIFIED_CONFIDENCE_NONZERO_SIZE` | freshness tier `EXPIRED` | execution gate must block bet and emit stale blocker | `apps/worker/src/jobs/__tests__/execution-gate.test.js` freshness suite | Existing |

## Verification Commands

- `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/execution-gate.test.js src/jobs/potd/__tests__/run-potd-engine.test.js`
- `npm --prefix apps/worker run stats:potd`

## Manual Validation Checklist

- Replay one downgraded or otherwise fragile-confidence candidate and confirm `reason=confidence_below_high_gate` or `wager_amount=0` behavior.
- Inspect one non-actionable model card payload and confirm Kelly fields are null while execution gate metadata explains the block.
