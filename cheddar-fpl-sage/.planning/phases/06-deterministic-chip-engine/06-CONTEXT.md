# Phase 06 Context — Deterministic Chip Engine

## Objective
Replace the current window/heuristic chip recommendation path with a deterministic, stateless chip engine that evaluates Wildcard, Free Hit, Bench Boost, and Triple Captain from the same `GameweekState` contract every GW.

## Locked Inputs From Spec

### Engine order
1. Compute season horizon
2. Score upcoming GWs
3. Evaluate Wildcard
4. Evaluate Free Hit
5. Evaluate Bench Boost
6. Evaluate Triple Captain
7. Apply force escalation
8. Return first `FIRE`, otherwise no chip this GW

### Three logic layers per chip
1. Scoring formula (`0-100` composite)
2. Hard veto rules (never bypassed)
3. Force escalation (soft + hard + GW37 emergency)

### Horizon suppressor
- If a materially better window is visible in `GW+1` or `GW+2`
- And `gwsRemaining > 6`
- Cap otherwise-fireable decisions to `WATCH`
- Force logic may override the cap

### Output requirements
Every chip decision must include:
- `chip`
- `status` (`FIRE` | `WATCH` | `PASS`)
- `score`
- `reasonCode`
- `reasonCodes`
- `forcedBy` when escalation triggered
- `watchUntil` for every `WATCH`
- `narrative`

### Non-negotiable invariants
1. One chip per GW
2. Stateless evaluation
3. `WATCH` always has `watchUntil`
4. Force logic never bypasses hard veto rules
5. Every decision has populated reason codes
6. `forcedBy` always documents escalation origin
7. Wildcard halves are independent
8. Evaluation order defines tie-break priority
9. Emergency late-season logic prevents unused chips expiring silently

## Repo-specific implementation constraints
- Implement the core engine in Python under `src/cheddar_fpl_sage/analysis/decision_framework/`
- Do not create a standalone JS-only engine; frontend should consume backend-transformed chip output
- Reuse existing fixture horizon data where possible instead of inventing a second calendar source
- Keep chip formulas in one deterministic engine path; avoid duplicating formulas across `chip_analyzer.py`, backend transformers, and frontend view-model code
- Maintain backward-compatible frontend rendering during migration, then expose richer fields (`status`, `score`, `reasonCodes`, `forcedBy`, `watchUntil`)

## Existing code that matters
- `cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py` — current chip logic entry point
- `cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/fixture_horizon.py` — existing DGW/BGW and horizon signals
- `cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/models.py` — current output contracts
- `cheddar-fpl-sage/backend/services/result_transformer.py` — backend → frontend chip projection
- `cheddar-fpl-sage/frontend/src/lib/api.ts` — TS response contract
- `cheddar-fpl-sage/frontend/src/lib/decisionViewModel.ts` and `frontend/src/components/ChipDecision.tsx` — chip UX mapping

## Implementation bias
Prefer a new `chip_engine/` module split by concern:
- shared contracts/helpers
- wildcard + free hit evaluators
- bench boost + triple captain evaluators
- adapter glue in `chip_analyzer.py`

This keeps per-chip logic isolated enough for parallel execution and prevents one monolithic replacement file.
