---
phase: pass-reason-integrity
plan: "04"
subsystem: adversarial-follow-up
tags: [mlb, market-eval, payload-provenance, adr, adversarial-verification]

requires:
  - phase: pass-reason-integrity
    plan: "01"
  - phase: pass-reason-integrity
    plan: "02"
  - phase: pass-reason-integrity
    plan: "03"

provides:
  - Stored MLB game-line payload truth surface: inputs_status, evaluation_status, raw_edge_value, threshold_required, threshold_passed, blocked_by, block_reasons
  - market-eval production PASS shape handling for status=PASS plus ev_threshold_passed=false
  - assertLegalPassNoEdge enforcement for pass_reason_code as well as reason_codes
  - SKIP_GAME_MIXED_FAILURES when rejected markets include non-edge blockers
  - ADR-0016 pass-reason integrity contract

completed: 2026-04-18
---

# Phase pass-reason-integrity Plan 04: Adversarial Follow-up Summary

An adversarial read-only agent found the prior verification overclaimed stored
payload provenance and missed production-shaped `status: PASS` cards with
`ev_threshold_passed: false`. This follow-up closes those gaps.

## What Changed

- `packages/models/src/market-eval.js`
  - Preserves `pass_reason_code` on `MarketEvalResult`
  - Classifies `PASS_CONFIDENCE_GATE` production shapes as blocked edge with
    `block_reasons`, not generic no-edge
  - `assertLegalPassNoEdge` checks both `reason_codes` and `pass_reason_code`
  - `SKIP_MARKET_NO_EDGE` upgrades to `SKIP_GAME_MIXED_FAILURES` when rejected
    results have `NO_EVALUATION` or non-empty `block_reasons`

- `apps/worker/src/models/mlb-model.js`
  - Adds a reusable stored truth surface to F5 total, full-game total, and
    full-game ML model cards
  - Prevents `PASS_SYNTHETIC_FALLBACK` from coexisting with `PASS_NO_EDGE`
  - Replaces defensive `?? 'PASS_NO_EDGE'` fallback with `PASS_UNKNOWN`

- `apps/worker/src/jobs/run_mlb_model.js`
  - Copies truth-surface fields into final stored `payloadData`
  - Preserves `threshold_passed: null` for no-evaluation projection-floor paths

- `packages/data/src/validators/card-payload.js`
  - Adds explicit optional schema fields for the truth surface

- Docs
  - Adds `docs/decisions/ADR-0016-pass-reason-integrity-contract.md`
  - Updates `docs/market_evaluation_contract.md`

## Tests Added or Tightened

- `packages/models/src/__tests__/market-eval.test.js`
  - Production `PASS + ev_threshold_passed=false + PASS_CONFIDENCE_GATE`
  - `assertLegalPassNoEdge` catches `pass_reason_code=PASS_NO_EDGE`
  - Mixed failures include blocked-edge candidates, not only no-evaluation

- `apps/worker/src/models/__tests__/mlb-model.test.js`
  - Truth-surface fields on true no-edge F5/full-game total cards
  - `PASS_SYNTHETIC_FALLBACK` never carries `PASS_NO_EDGE`
  - Full-game ML driver cards propagate all truth fields

- `apps/worker/src/__tests__/run-mlb-model.dual-run.test.js`
  - Stored F5 PASS payload carries truth fields
  - Stored projection-floor payload excludes `PASS_NO_EDGE`
  - Stored full-game ML payload preserves truth fields after execution-gate demotion

## Verification

Command run:

```bash
npx jest --testPathPattern="market-eval.test|mlb-model.test|run-mlb-model.dual-run.test|run_mlb_model.test|post_discord_cards" --no-coverage
```

Result: 6 test suites passed, 321 tests passed.

