# Verification Contract

This document defines verification as a blocker-resolution system for VEGAS audit flows.

Status note:
Watchdog enforcement is downstream implementation work in WI-1034-b and WI-1034-c. This WI-1034-a document set defines the contract only.

## Types

### VerificationState

- `NOT_REQUIRED`
- `PENDING`
- `CLEARED`
- `FAILED`
- `EXPIRED`

### VerificationBlockerCode

New codes (to be registered downstream in WI-1034-b):

- `STARTER_UNCONFIRMED`
- `STARTER_MISMATCH`
- `PRICE_STALE`
- `BEST_LINE_UNCONFIRMED`
- `WEATHER_STATUS_PENDING`
- `MARKET_SOURCE_UNCONFIRMED`

Existing canonical codes (already registered, map directly):

- `INJURY_UNCERTAIN` (WATCHDOG_REASONS)
- `LINE_MOVE_ADVERSE` (PRICE_REASONS)
- `EDGE_RECHECK_PENDING` (PRICE_REASONS)

### VerificationActionType

- `FETCH_MARKET_SNAPSHOT`
- `FETCH_BEST_LINE`
- `FETCH_STARTER_STATUS`
- `FETCH_LINEUP_STATUS`
- `FETCH_WEATHER_STATUS`
- `REPRICE_MODEL`
- `RECHECK_MOVEMENT_WINDOW`
- `MARK_EXPIRED`

### Severity Taxonomy

- `HARD`: prevents `PLAY` eligibility.
- `SOFT`: allows analysis but caps candidate at `LEAN` until resolved.

## Requirement Shape

Each pending candidate carries one or more `VerificationRequirement` records with:

- `blocker_code`
- `severity` (`HARD` or `SOFT`)
- `status` (`PENDING`, `CLEARED`, `FAILED`)
- `unblock_condition`
- `action_type`
- `source_needed`
- `retry_policy` (`ONCE`, `UNTIL_START`, or `WINDOWED`)
- optional `resolved_value`, `resolved_at`, and `failure_reason`

Each candidate carries `CandidateVerification` with:

- `verification_state`
- `requirements`
- `can_promote_to_play`
- `next_action_summary`

## GATE_CHECK Contract

`GATE_CHECK` is the pre-flight gate. Run these three checks in this exact order:

1. Price freshness
2. Starter confirmed (MLB/NHL)
3. Adverse line movement

Named checks and fail codes:

- Price freshness -> `PRICE_STALE`
- Starter confirmed -> `STARTER_UNCONFIRMED` or `STARTER_MISMATCH`
- Adverse movement -> `LINE_MOVE_ADVERSE`

Threshold policy:

- Default drift/movement examples are 5 cents.
- Runtime thresholds are configurable by sport and market.

## Blocker Matrix

### HARD Blockers

| Blocker | Action Type(s) | Unblock Condition |
| --- | --- | --- |
| `PRICE_STALE` | `FETCH_MARKET_SNAPSHOT`, `FETCH_BEST_LINE` | Best price within configured drift threshold, or repriced edge survives |
| `STARTER_UNCONFIRMED` | `FETCH_STARTER_STATUS` | Official starter/goalie posted and matches priced assumption |
| `STARTER_MISMATCH` | `REPRICE_MODEL` | Repriced edge still clears threshold at actual starter |
| `LINE_MOVE_ADVERSE` | `RECHECK_MOVEMENT_WINDOW`, `REPRICE_MODEL` | Move stabilizes and repriced edge survives |
| `EDGE_RECHECK_PENDING` | `REPRICE_MODEL` | Repriced edge clears threshold |
| `INJURY_UNCERTAIN` | `FETCH_LINEUP_STATUS` | Injury clears or repriced edge survives confirmed absence |

### SOFT Blockers

| Blocker | Action Type(s) | Unblock Condition |
| --- | --- | --- |
| `BEST_LINE_UNCONFIRMED` | `FETCH_BEST_LINE` | Best line captured and edge survives there |
| `WEATHER_STATUS_PENDING` | `FETCH_WEATHER_STATUS` | Weather no longer materially alters projection |
| `MARKET_SOURCE_UNCONFIRMED` | `FETCH_MARKET_SNAPSHOT` | Source confirmed and price validated |

## Promotion Rules

- `PENDING -> CLEARED`: all `HARD` blockers are resolved.
- `CLEARED` never implies `PLAY`.
- `CLEARED -> PLAY` only after re-running threshold logic and confirming edge/policy thresholds pass.
- `PENDING -> FAILED`: any hard blocker resolves against the thesis.
- `PENDING -> EXPIRED`: retry window or start-time boundary closes without resolution.

## Expiry Rules

- Expiry may be triggered by start time, retry policy end window, or explicit `MARK_EXPIRED` action.
- Expired candidates are non-actionable and must not remain in pending action queues.

## Resolver Terminal Output Semantics

Resolver terminal states and emits:

- `CLEARED`: emit resolver-clear event to the audit layer and mark as eligible for re-evaluation under `STANDARD_AUDIT`. This is not an automatic `PLAY`.
- `FAILED`: emit `PASS - [blocker_code]: [failure_reason].` to user-facing output and stop further analysis.
- `EXPIRED`: emit `PASS - EXPIRED: Verification window closed without resolution.` to user-facing output and archive candidate state.

## Slight Edge Semantics

Slight Edge is a real low-confidence positive opinion only after gate eligibility is satisfied.

- `LEAN + verification_state=PENDING` = verification-blocked candidate.
- `LEAN + verification_state=CLEARED|NOT_REQUIRED` = true Slight Edge lean.

Guardrail:

- `verification_state` is required companion truth for every `LEAN` verdict.
- Reporting must segment `LEAN` outcomes by `verification_state`.
